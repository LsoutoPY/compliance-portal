/**
 * Edge Function: buscar-descasamento-operacional
 *
 * Compara saídas confirmadas de cotistas (resgates_movimentacoes) com entradas
 * confirmadas de portfólio (caixa_fluxo_financeiro), agregando por vértice ANBIMA.
 *
 * O vértice de cada evento é recalculado dinamicamente a partir da data_analise
 * usando a mesma lógica de prazoParaVertice() do calculo-risco-liquidez.
 *
 * Request body (JSON):
 *   { fundo_cnpj: string, data_analise: string (YYYYMMDD) }
 *
 * Response:
 *   {
 *     porVertice:  { vertice, saidaCotistas, entradaPortfolio, saldoLiquido }[],
 *     totais:      { saidaCotistas, entradaPortfolio, saldoLiquido },
 *     linhasFluxo: { data_liquidacao, subtipo, financeiro, vertice }[]
 *   }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ---------------------------------------------------------------------------
// Funções de data e vértice — cópia fiel do calculo-risco-liquidez/index.ts
// para garantir consistência de cálculo entre os dois módulos.
// ---------------------------------------------------------------------------

/** Converte string YYYY-MM-DD em Date local (sem deslocamento de fuso) */
function parseIsoDate(s: string): Date {
  if (!s || s.length < 10) return new Date(NaN);
  const y = parseInt(s.slice(0, 4), 10);
  const m = parseInt(s.slice(5, 7), 10) - 1;
  const d = parseInt(s.slice(8, 10), 10);
  return new Date(y, m, d);
}

/** Converte string YYYYMMDD em Date local */
function parseYyyymmdd(s: string): Date {
  if (!s || s.length !== 8) return new Date(NaN);
  const y = parseInt(s.slice(0, 4), 10);
  const m = parseInt(s.slice(4, 6), 10) - 1;
  const d = parseInt(s.slice(6, 8), 10);
  return new Date(y, m, d);
}

/** Dias úteis entre duas datas (exclui fins de semana) */
function diasUteisEntreDatas(d1: Date, d2: Date): number {
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return 0;
  const start = d1 < d2 ? d1 : d2;
  const end   = d1 < d2 ? d2 : d1;
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/**
 * Mapeia prazo em dias úteis para o vértice ANBIMA.
 * Lógica idêntica à de calculo-risco-liquidez/index.ts (linhas 209-227).
 */
function prazoParaVertice(prazos_em_dias: number | null): number | null {
  if (prazos_em_dias == null) return null;
  const p = prazos_em_dias === 0 ? 1 : prazos_em_dias;
  if (p > 720)  return 1260;
  if (p >= 505) return 720;
  if (p >= 365) return 504;
  if (p >= 181) return 365;
  if (p === 123) return 180;
  if (p >= 63)  return 126;
  if (p >= 42)  return 63;
  if (p >= 23)  return 42;
  if (p >= 10)  return 21;
  if (p >= 5)   return 10;
  if (p >= 4)   return 5;
  if (p >= 3)   return 4;
  if (p >= 2)   return 3;
  if (p > 1)    return 2;
  return 1;
}

/** Label do vértice para exibição */
function verticeLabel(v: number): string {
  return v === 1260 ? 'D+720+' : `D+${v}`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { fundo_cnpj, data_analise } = body as { fundo_cnpj?: string; data_analise?: string };

    if (!fundo_cnpj || !data_analise) {
      return new Response(
        JSON.stringify({ success: false, error: 'fundo_cnpj e data_analise são obrigatórios' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const dtAnalise = parseYyyymmdd(data_analise);
    if (isNaN(dtAnalise.getTime())) {
      return new Response(
        JSON.stringify({ success: false, error: 'data_analise inválida — use formato YYYYMMDD' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const dataAnaliseIso = `${data_analise.slice(0, 4)}-${data_analise.slice(4, 6)}-${data_analise.slice(6, 8)}`;

    // Variantes de CNPJ para cobrir diferentes formatos de armazenamento
    const cleanCnpj = fundo_cnpj.replace(/\D/g, '');
    const cleanCnpj14 = cleanCnpj.padStart(14, '0');
    const formattedCnpj = cleanCnpj14.length === 14
      ? cleanCnpj14.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
      : fundo_cnpj;
    const cnpjVariants = [...new Set([fundo_cnpj, cleanCnpj, cleanCnpj14, formattedCnpj].filter(Boolean))];

    // Queries paralelas
    const [resgatesResult, fluxoResult] = await Promise.all([
      supabase
        .from('resgates_movimentacoes')
        .select('valor, data_impacto, vertice')
        .in('fundo_cnpj', cnpjVariants)
        .gte('data_impacto', dataAnaliseIso),

      supabase
        .from('caixa_fluxo_financeiro')
        .select('financeiro, data_liquidacao, subtipo')
        .in('fundo_cnpj', cnpjVariants)
        .gte('data_liquidacao', dataAnaliseIso),
    ]);

    if (resgatesResult.error) throw resgatesResult.error;
    if (fluxoResult.error) throw fluxoResult.error;

    const resgates = resgatesResult.data ?? [];
    const fluxos   = fluxoResult.data ?? [];

    // Agregar saídas de cotistas por vértice (recalcula vértice dinamicamente)
    const saidasPorVertice = new Map<number, number>();
    for (const r of resgates) {
      const valor = Number(r.valor) || 0;
      if (valor <= 0) continue;

      let vertice: number | null = null;
      if (r.data_impacto) {
        const dtImpacto = parseIsoDate(String(r.data_impacto));
        if (!isNaN(dtImpacto.getTime())) {
          const dias = diasUteisEntreDatas(dtAnalise, dtImpacto);
          vertice = prazoParaVertice(dias >= 0 ? dias : null);
        }
      }
      // Fallback: usa vértice armazenado se não conseguiu calcular
      if (vertice == null && r.vertice != null) vertice = Number(r.vertice);
      if (vertice == null) continue;

      saidasPorVertice.set(vertice, (saidasPorVertice.get(vertice) ?? 0) + valor);
    }

    // Agregar entradas de portfólio por vértice (recalcula vértice dinamicamente)
    const entradasPorVertice = new Map<number, number>();
    const linhasFluxo: { data_liquidacao: string; subtipo: string; financeiro: number; vertice: number }[] = [];

    for (const f of fluxos) {
      const financeiro = Number(f.financeiro) || 0;

      const dtLiquidacao = parseIsoDate(String(f.data_liquidacao));
      let vertice: number | null = null;
      if (!isNaN(dtLiquidacao.getTime())) {
        const dias = diasUteisEntreDatas(dtAnalise, dtLiquidacao);
        vertice = prazoParaVertice(dias >= 0 ? dias : null);
      }
      if (vertice == null) continue;

      // Entradas de portfólio somam positivo no caixa
      entradasPorVertice.set(vertice, (entradasPorVertice.get(vertice) ?? 0) + Math.abs(financeiro));

      linhasFluxo.push({
        data_liquidacao: String(f.data_liquidacao),
        subtipo: String(f.subtipo ?? ''),
        financeiro,
        vertice,
      });
    }

    // Unir todos os vértices presentes em qualquer das duas fontes
    const todosVertices = [...new Set([
      ...saidasPorVertice.keys(),
      ...entradasPorVertice.keys(),
    ])].sort((a, b) => a - b);

    const porVertice = todosVertices.map((v) => {
      const saidaCotistas   = saidasPorVertice.get(v)   ?? 0;
      const entradaPortfolio = entradasPorVertice.get(v) ?? 0;
      const saldoLiquido    = entradaPortfolio - saidaCotistas;
      return {
        vertice: v,
        verticeLabel: verticeLabel(v),
        saidaCotistas,
        entradaPortfolio,
        saldoLiquido,
      };
    });

    const totais = porVertice.reduce(
      (acc, r) => ({
        saidaCotistas:    acc.saidaCotistas    + r.saidaCotistas,
        entradaPortfolio: acc.entradaPortfolio + r.entradaPortfolio,
        saldoLiquido:     acc.saldoLiquido     + r.saldoLiquido,
      }),
      { saidaCotistas: 0, entradaPortfolio: 0, saldoLiquido: 0 }
    );

    // Ordenar linhas de detalhe por data de liquidação
    linhasFluxo.sort((a, b) => a.data_liquidacao.localeCompare(b.data_liquidacao));

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          porVertice,
          totais,
          linhasFluxo,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[buscar-descasamento-operacional] Erro:', err);
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
