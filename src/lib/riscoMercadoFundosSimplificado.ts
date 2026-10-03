import { supabase } from '@/integrations/supabase/client';
import type {
  FundoRiscoSimplificado,
  FundoRiscoSimplificadoDia,
  RiscoMercadoFundosCalcLog,
} from '@/types/risco-mercado-fundos-simplificado';

// ── Snapshot atual de todos os fundos ────────────────────────

export async function fetchFundosRiscoSimplificado(): Promise<FundoRiscoSimplificado[]> {
  const { data, error } = await supabase
    .from('vw_risco_mercado_fundos_diario_atual')
    .select('*')
    .order('nome_fundo', { ascending: true });

  if (error) throw new Error(`fetchFundosRiscoSimplificado: ${error.message}`);
  return (data ?? []) as FundoRiscoSimplificado[];
}

// ── Série diária de um fundo (últimos N dias) ────────────────

export async function fetchFundoSerieDiaria(
  cnpj: string,
  dias = 90,
): Promise<FundoRiscoSimplificadoDia[]> {
  const dataCorte = new Date();
  dataCorte.setDate(dataCorte.getDate() - dias);
  const dataCorteStr = dataCorte.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('risco_mercado_fundos_diario')
    .select(
      'cnpj,data_ref,pl,cota,delta_cota_pct,cdi_valor,delta_cdi_pct,' +
      'relacao_cota_cdi,status_cota_cdi,var_param_dia_pct,' +
      'var_95_param_1d_pct,var_95_hist_21d_pct,var_95_param_pct,var_95_hist_pct'
    )
    .eq('cnpj', cnpj)
    .gte('data_ref', dataCorteStr)
    .order('data_ref', { ascending: true });

  if (error) throw new Error(`fetchFundoSerieDiaria(${cnpj}): ${error.message}`);
  return (data ?? []) as FundoRiscoSimplificadoDia[];
}

// ── Última execução do cálculo ────────────────────────────────

export async function fetchUltimaExecucaoRiscoMercadoFundos(): Promise<RiscoMercadoFundosCalcLog | null> {
  const { data, error } = await supabase
    .from('risco_mercado_fundos_calc_log')
    .select('*')
    .in('status', ['success', 'error'])
    .order('iniciado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`fetchUltimaExecucaoRiscoMercadoFundos: ${error.message}`);
  return data as RiscoMercadoFundosCalcLog | null;
}

// ── Disparar recálculo manual ────────────────────────────────

export async function recalcularRiscoMercadoFundos(): Promise<{ ok: boolean; message: string }> {
  const { data, error } = await supabase.functions.invoke(
    'calcular-risco-mercado-fundos',
    { body: { action: 'run', origem: 'manual' } },
  );

  if (error) {
    return { ok: false, message: error.message ?? 'Erro ao invocar a edge function.' };
  }

  const d = data as { ok?: boolean; fundos_processados?: number; fundos_com_erro?: number; error?: string };

  if (!d?.ok) {
    return { ok: false, message: d?.error ?? 'Erro desconhecido na edge function.' };
  }

  return {
    ok:      true,
    message: `${d.fundos_processados ?? 0} fundos processados` +
             (d.fundos_com_erro ? `, ${d.fundos_com_erro} com erro` : '') + '.',
  };
}
