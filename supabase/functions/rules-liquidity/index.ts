import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

type RuleStatus = 'ok' | 'alerta' | 'violacao';

interface RuleResult {
  regra_codigo: string;
  regra_descricao: string;
  status: RuleStatus;
  valor_atual: number | null;
  valor_limite: number | null;
  detalhes?: Record<string, unknown>;
}

interface RuleCheckRequest {
  fundo_cnpj: string;
  fundo_isin?: string;  // ISIN discriminator for multi-class funds (optional)
  fundo_dtposicao: string;
}

interface RuleCheckResponse {
  success: boolean;
  results: RuleResult[];
  error?: string;
}

interface CalculoRiscoResponse {
  success: boolean;
  data?: {
    totalPL: number;
    isFundoFechado: boolean;
    fundoFechadoAnalise: { prazoResgate: number; disponibilidade: number; dispPL: number; pl: number; status: string } | null;
    ativosComPrazo: { id: string; nome: string; valor: number; prazos_em_dias: number | null; vertice: number; section: string }[];
    mainFundChar: { prazo_pagamento_resgate_dias: number | null } | null;
  };
}

async function saveResults(
  fundo_cnpj: string,
  fundo_isin: string,
  fundo_dtposicao: string,
  categoria: string,
  results: RuleResult[]
) {
  const { error: deleteError } = await supabase
    .from('enquadramento_resultado')
    .delete()
    .eq('fundo_cnpj', fundo_cnpj)
    .eq('fundo_isin', fundo_isin)
    .eq('fundo_dtposicao', fundo_dtposicao)
    .eq('regra_categoria', categoria);

  if (deleteError) throw deleteError;

  if (results.length === 0) return;

  const records = results.map((r) => ({
    fundo_cnpj,
    fundo_isin,
    fundo_dtposicao,
    regra_categoria: categoria,
    regra_codigo: r.regra_codigo,
    regra_descricao: r.regra_descricao,
    status: r.status,
    valor_atual: r.valor_atual,
    valor_limite: r.valor_limite,
    detalhes: r.detalhes || null,
  }));

  const { error } = await supabase
    .from('enquadramento_resultado')
    .upsert(records, { onConflict: 'fundo_cnpj,fundo_isin,fundo_dtposicao,regra_codigo' });

  if (error) throw error;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { fundo_cnpj, fundo_isin: fundo_isin_req, fundo_dtposicao }: RuleCheckRequest = await req.json();
    const fundo_isin = fundo_isin_req ?? '';

    if (!fundo_cnpj || !fundo_dtposicao) {
      return new Response(
        JSON.stringify({ success: false, error: 'fundo_cnpj and fundo_dtposicao are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('[rules-liquidity] Checking fund', fundo_cnpj, 'isin', fundo_isin || '(none)', 'for date', fundo_dtposicao);

    const cleanCnpj = fundo_cnpj.replace(/\D/g, '');
    const { data: fundChar } = await supabase
      .from('fundos_caracteristicas' as any)
      .select('nivel1_categoria, caracteristica_investidor, isin')
      .or(`cnpj_classe.eq.${cleanCnpj},cnpj_fundo.eq.${cleanCnpj}`)
      .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo')
      .limit(1)
      .maybeSingle();

    const classe = (fundChar as any)?.nivel1_categoria || 'Multimercados';
    const segmento = (fundChar as any)?.caracteristica_investidor || 'PRIVATE';
    // Prefer ISIN from request (discriminator passed by orchestrator); fall back to fundos_caracteristicas
    const fundoIsin = fundo_isin || (fundChar as any)?.isin || null;
    console.log(`[rules-liquidity] Fund characteristics: classe=${classe}, segmento=${segmento}, isin=${fundoIsin}`);

    const functionUrl = `${supabaseUrl}/functions/v1/calculo-risco-liquidez`;
    const calcResponse = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'apikey': supabaseServiceKey,
      },
      body: JSON.stringify({
        fundo_cnpj,
        fundo_isin: fundoIsin,
        fundo_dtposicao,
        classe,
        segmento_investidor: segmento,
        metrica: 'media_simples',
      }),
    });

    if (!calcResponse.ok) {
      const errText = await calcResponse.text();
      console.error('[rules-liquidity] calculo-risco-liquidez error:', calcResponse.status, errText);
      return new Response(
        JSON.stringify({ success: false, error: `Erro ao calcular liquidez: ${errText}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const calcData: CalculoRiscoResponse = await calcResponse.json();
    if (!calcData.success || !calcData.data) {
      return new Response(
        JSON.stringify({ success: false, error: 'Resposta inválida de calculo-risco-liquidez' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { totalPL, isFundoFechado, fundoFechadoAnalise, ativosComPrazo, mainFundChar } = calcData.data;

    const results: RuleResult[] = [];

    // Regras de liquidez desativadas conforme solicitação
    // As regras LIQ_FUNDO_FECHADO, LIQ_CAIXA_MIN e LIQ_ILIQUIDO_MAX foram removidas do monitoramento de enquadramento.
    /*
    if (isFundoFechado && fundoFechadoAnalise) {
      results.push({
        regra_codigo: 'LIQ_FUNDO_FECHADO',
        regra_descricao: 'Fundo fechado: disponibilidade no prazo de resgate >= 10% do PL',
        status: fundoFechadoAnalise.status === 'violacao' ? 'violacao' : 'ok',
        valor_atual: fundoFechadoAnalise.dispPL ?? null,
        valor_limite: 0.10,
        detalhes: { patliq: totalPL, ...fundoFechadoAnalise },
      });
    } else {
      const totalCaixa = ativosComPrazo
        .filter((a) => a.section === 'caixa')
        .reduce((s, a) => s + a.valor, 0);
      const totalIliquido = ativosComPrazo
        .filter((a) => a.prazos_em_dias == null || a.prazos_em_dias > 180)
        .reduce((s, a) => s + a.valor, 0);

      const percCaixa = totalPL > 0 ? totalCaixa / totalPL : 0;
      const percIliquido = totalPL > 0 ? totalIliquido / totalPL : 0;

      let statusCaixa: RuleStatus = percCaixa >= 0.07 ? 'ok' : percCaixa >= 0.05 ? 'alerta' : 'violacao';
      results.push({
        regra_codigo: 'LIQ_CAIXA_MIN',
        regra_descricao: 'Mínimo 5% do PL em caixa (alerta se < 7%)',
        status: statusCaixa,
        valor_atual: percCaixa,
        valor_limite: 0.05,
        detalhes: { patliq: totalPL, total_caixa: totalCaixa, ativos_contabilizados: ativosComPrazo.filter((a) => a.section === 'caixa') },
      });

      const limiteIliquido = 0.30;
      const alertaIliquido = 0.25;
      let statusIliquido: RuleStatus = percIliquido <= alertaIliquido ? 'ok' : percIliquido <= limiteIliquido ? 'alerta' : 'violacao';
      results.push({
        regra_codigo: 'LIQ_ILIQUIDO_MAX',
        regra_descricao: 'Máximo 30% do PL em ativos ilíquidos (sem prazo ou > 180 dias)',
        status: statusIliquido,
        valor_atual: percIliquido,
        valor_limite: limiteIliquido,
        detalhes: { patliq: totalPL, total_iliquido: totalIliquido, ativos_contabilizados: ativosComPrazo.filter((a) => a.prazos_em_dias == null || a.prazos_em_dias > 180) },
      });
    }
    */

    await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, 'liquidity', results);

    console.log('[rules-liquidity] Done. Results:', results.length);

    return new Response(
      JSON.stringify({ success: true, results } as RuleCheckResponse),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[rules-liquidity] Unexpected error:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
