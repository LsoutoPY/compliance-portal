/**
 * Edge Function: snapshot-credito-mensal
 *
 * Agrega KPIs de crédito para um mês a partir do estoque_fidc e persiste em
 * credito_snapshot_mensal_fundo via RPC upsert_credito_snapshot_mensal.
 *
 * Pode ser chamada:
 *   a) Diretamente (via invoke do frontend ou cron)
 *   b) Internamente por calcular-credito ao final do cálculo
 *
 * Request JSON:
 *   { data_referencia: "YYYY-MM-DD" }  // data do estoque; mês é inferido
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface EstoqueAgregado {
  doc_fundo: string | null;
  nome_fundo: string | null;
  vp_total: number;
  vp_inadimplente: number;
  vp_over90: number;
  vp_over180: number;
  vp_writeoff: number;
  pdd_total: number;
  tx_ponderada_num: number;   // numerador: SUM(tx * VP)
  tx_ponderada_den: number;   // denominador: SUM(VP com tx)
  qtd_titulos: number;
}

/** Detecta write-off pelo campo situacao_recebivel */
function isWriteoff(situacao: string | null): boolean {
  if (!situacao) return false;
  const s = situacao.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return /baixad|perda|prejuizo|write.?off/.test(s);
}

/** Primeiro dia do mês a partir de YYYY-MM-DD */
function primeiroDoMes(dataReferencia: string): string {
  return dataReferencia.substring(0, 7) + '-01';
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const dataReferencia: string | undefined = body.data_referencia;

    if (!dataReferencia || !/^\d{4}-\d{2}-\d{2}$/.test(dataReferencia)) {
      return new Response(
        JSON.stringify({ success: false, error: 'data_referencia é obrigatório (YYYY-MM-DD)' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const mesReferencia = primeiroDoMes(dataReferencia);
    console.log(`[snapshot-credito-mensal] Iniciando para data=${dataReferencia}, mes=${mesReferencia}`);

    // ── 1. Buscar imports válidos (último por fundo/data) ────────────
    const { data: imports, error: impErr } = await supabase
      .from('importacoes_estoque_fidc')
      .select('id, fund_document, reference_date')
      .eq('reference_date', dataReferencia)
      .in('status', ['success', 'partial_success'])
      .order('created_at', { ascending: false });

    if (impErr) throw impErr;

    // Deduplica: mantém o import mais recente por fundo/data
    const latestByFundo = new Map<string, string>();
    for (const imp of (imports ?? [])) {
      const key = `${imp.fund_document}||${imp.reference_date}`;
      if (!latestByFundo.has(key)) {
        latestByFundo.set(key, imp.id);
      }
    }
    const validImportIds = [...latestByFundo.values()];

    if (validImportIds.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: `Nenhum import válido para ${dataReferencia}` }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 2. Buscar recebíveis do estoque (em batches de 1000) ─────────
    const BATCH = 1000;
    let page = 0;
    const fundos = new Map<string, EstoqueAgregado>();

    while (true) {
      const { data: rows, error: rowErr } = await supabase
        .from('estoque_fidc')
        .select(`
          doc_fundo, nome_fundo, data_vencimento_ajustada, data_vencimento_original,
          valor_presente, valor_nominal, valor_pdd_geral, valor_pdd,
          situacao_recebivel, tx_recebivel, taxa_cessao
        `)
        .in('import_id', validImportIds)
        .range(page * BATCH, (page + 1) * BATCH - 1);

      if (rowErr) throw rowErr;
      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        const key = `${row.doc_fundo ?? ''}||${row.nome_fundo ?? ''}`;
        let agg = fundos.get(key);
        if (!agg) {
          agg = {
            doc_fundo: row.doc_fundo,
            nome_fundo: row.nome_fundo,
            vp_total: 0, vp_inadimplente: 0, vp_over90: 0, vp_over180: 0, vp_writeoff: 0,
            pdd_total: 0, tx_ponderada_num: 0, tx_ponderada_den: 0, qtd_titulos: 0,
          };
          fundos.set(key, agg);
        }

        const vp = row.valor_presente ?? row.valor_nominal ?? 0;
        const pdd = row.valor_pdd_geral ?? row.valor_pdd ?? 0;
        const dvenc = row.data_vencimento_ajustada ?? row.data_vencimento_original;
        const writeoff = isWriteoff(row.situacao_recebivel);

        // dias de atraso
        let diasAtraso = 0;
        if (dvenc) {
          const ref = new Date(dataReferencia).getTime();
          const due = new Date(dvenc).getTime();
          diasAtraso = Math.floor((ref - due) / 86400000);
        }

        agg.vp_total += vp;
        agg.pdd_total += pdd;
        agg.qtd_titulos++;

        if (writeoff) {
          agg.vp_writeoff += vp;
        } else if (diasAtraso > 0) {
          agg.vp_inadimplente += vp;
          if (diasAtraso > 90) agg.vp_over90 += vp;
          if (diasAtraso > 180) agg.vp_over180 += vp;
        }

        const tx = row.tx_recebivel ?? row.taxa_cessao;
        if (tx != null && tx > 0 && vp > 0) {
          agg.tx_ponderada_num += tx * vp;
          agg.tx_ponderada_den += vp;
        }
      }

      if (rows.length < BATCH) break;
      page++;
    }

    if (fundos.size === 0) {
      return new Response(
        JSON.stringify({ success: false, error: `Nenhum recebível encontrado para ${dataReferencia}` }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 3. Montar payload de upsert ──────────────────────────────────
    const snapshotRows = [...fundos.values()].map((agg) => ({
      doc_fundo: agg.doc_fundo ?? '',
      nome_fundo: agg.nome_fundo,
      provisao_total: agg.pdd_total,
      inadimplencia_pct: agg.vp_total > 0 ? agg.vp_inadimplente / agg.vp_total : 0,
      over90_pct: agg.vp_total > 0 ? agg.vp_over90 / agg.vp_total : 0,
      over180_pct: agg.vp_total > 0 ? agg.vp_over180 / agg.vp_total : 0,
      writeoff_total: agg.vp_writeoff,
      retorno_medio_credito: agg.tx_ponderada_den > 0 ? agg.tx_ponderada_num / agg.tx_ponderada_den : null,
      vp_total: agg.vp_total,
      qtd_titulos: agg.qtd_titulos,
      calc_version: 'credito_v1',
    }));

    // ── 4. Chamar RPC de upsert ──────────────────────────────────────
    const { data: upsertCount, error: upsertErr } = await supabase.rpc(
      'upsert_credito_snapshot_mensal',
      { p_mes: mesReferencia, p_rows: snapshotRows },
    );

    if (upsertErr) throw upsertErr;

    console.log(`[snapshot-credito-mensal] OK: ${upsertCount} fundos persistidos para ${mesReferencia}`);

    return new Response(
      JSON.stringify({
        success: true,
        mes_referencia: mesReferencia,
        fundos_persistidos: upsertCount,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('[snapshot-credito-mensal] erro:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
