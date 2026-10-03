/**
 * Helper de persistência para os resultados do cálculo de risco de liquidez.
 *
 * Os resultados ficam na tabela `liquidez_monitoramento_risco` (Supabase),
 * garantindo que datas passadas já calculadas não precisem ser recalculadas
 * ao trocar de sessão, navegador ou dispositivo.
 */

import { supabase } from "@/integrations/supabase/client";

function cnpjFromMapKey(key: string): string {
  const part = key.split("|")[0] || key;
  return String(part).replace(/\D/g, "");
}

const STATUS_SEVERITY: Record<string, number> = {
  violacao: 4,
  alerta: 3,
  pendente: 2,
  ok: 1,
};

function resultCompleteness(row: LiquidezMonitoramentoRiscoRow): number {
  return [
    row.indice_liquidez,
    row.meses_cobertura,
    row.prazo_resgate,
    row.total_pl,
  ].filter((value) => value != null).length;
}

function shouldReplaceConsolidatedRow(
  current: LiquidezMonitoramentoRiscoRow,
  candidate: LiquidezMonitoramentoRiscoRow,
): boolean {
  const currentSeverity = STATUS_SEVERITY[current.status] ?? 0;
  const candidateSeverity = STATUS_SEVERITY[candidate.status] ?? 0;
  if (candidateSeverity !== currentSeverity) return candidateSeverity > currentSeverity;
  return resultCompleteness(candidate) > resultCompleteness(current);
}

export type LiquidezMonitoramentoRiscoRow = {
  fundo_cnpj: string;
  dt_posicao: string;
  total_pl: number | null;
  is_fundo_fechado: boolean;
  prazo_resgate: number | null;
  indice_liquidez: number | null;
  status: string;
  intermediate_status: string | null;
  meses_cobertura?: number | null;
  status_cobertura?: string | null;
  disp_pl?: number | null;
  fonte_despesa?: string | null;
  calculado_em?: string;
};

/** Carrega os resultados persistidos para uma data de posição. */
export async function loadLiquidezResultsFromDb(
  dtPosicao: string
): Promise<Map<string, Omit<LiquidezMonitoramentoRiscoRow, "fundo_cnpj" | "dt_posicao">>> {
  try {
    const { data, error } = await supabase
      .from("liquidez_monitoramento_risco")
      .select("fundo_cnpj, total_pl, is_fundo_fechado, prazo_resgate, indice_liquidez, status, intermediate_status, meses_cobertura, status_cobertura, disp_pl, fonte_despesa, calculado_em")
      .eq("dt_posicao", dtPosicao);

    if (error) {
      // Silencia erros de tabela inexistente (migração pendente) e outros erros de DB
      if (!error.message?.includes("does not exist")) {
        console.warn("[liquidez-db] Erro ao carregar resultados do banco:", error.message);
      }
      return new Map();
    }

    const map = new Map<string, Omit<LiquidezMonitoramentoRiscoRow, "fundo_cnpj" | "dt_posicao">>();
    for (const row of data ?? []) {
      const cnpjKey = String(row.fundo_cnpj ?? "").replace(/\D/g, "");
      if (cnpjKey) {
        map.set(cnpjKey, {
          total_pl: row.total_pl ?? null,
          is_fundo_fechado: row.is_fundo_fechado ?? false,
          prazo_resgate: row.prazo_resgate ?? null,
          indice_liquidez: row.indice_liquidez ?? null,
          status: row.status ?? "pendente",
          intermediate_status: row.intermediate_status ?? null,
          meses_cobertura: row.meses_cobertura ?? null,
          status_cobertura: row.status_cobertura ?? null,
          disp_pl: row.disp_pl ?? null,
          fonte_despesa: row.fonte_despesa ?? null,
          calculado_em: row.calculado_em,
        });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Persiste (upsert) um lote de resultados para uma data de posição. */
export async function saveLiquidezResultsToDb(
  dtPosicao: string,
  results: Map<string, {
    totalPL: number;
    isFundoFechado: boolean;
    prazoResgate: number | null;
    indiceLiquidez: number | null;
    status: string;
    intermediateStatus?: string | null;
    mesesCobertura?: number | null;
    dispPL?: number | null;
    statusCobertura?: string | null;
    fonteDespesa?: string | null;
  }>
): Promise<void> {
  if (results.size === 0) return;

  // A tela pode calcular mais de uma classe (CNPJ + ISIN), enquanto a tabela
  // persiste o monitoramento no nível do fundo (CNPJ + data). Consolidamos
  // antes do upsert para nunca enviar duas linhas com a mesma chave e, em caso
  // de divergência entre classes, preservamos o resultado mais conservador.
  const rowsByFund = new Map<string, LiquidezMonitoramentoRiscoRow>();
  for (const [cnpjKey, v] of results.entries()) {
    const fundoCnpj = cnpjFromMapKey(cnpjKey);
    if (!fundoCnpj) continue;
    const candidate: LiquidezMonitoramentoRiscoRow = {
      fundo_cnpj: fundoCnpj,
      dt_posicao: dtPosicao,
      total_pl: v.totalPL ?? null,
      is_fundo_fechado: v.isFundoFechado ?? false,
      prazo_resgate: v.prazoResgate ?? null,
      indice_liquidez: v.isFundoFechado ? null : (v.indiceLiquidez ?? null),
      status: v.status ?? "pendente",
      intermediate_status: v.intermediateStatus ?? null,
      meses_cobertura: v.isFundoFechado ? (v.mesesCobertura ?? v.indiceLiquidez ?? null) : null,
      status_cobertura: v.isFundoFechado ? (v.statusCobertura ?? null) : null,
      disp_pl: v.isFundoFechado ? (v.dispPL ?? null) : null,
      fonte_despesa: v.isFundoFechado ? (v.fonteDespesa ?? null) : null,
    };
    const current = rowsByFund.get(fundoCnpj);
    if (!current || shouldReplaceConsolidatedRow(current, candidate)) {
      rowsByFund.set(fundoCnpj, candidate);
    }
  }

  const rows = [...rowsByFund.values()];

  // Upsert em lotes de 100 para evitar payload excessivo
  const BATCH_SIZE = 100;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("liquidez_monitoramento_risco")
      .upsert(batch, { onConflict: "fundo_cnpj,dt_posicao" });

    if (error && !error.message?.includes("does not exist")) {
      console.warn("[liquidez-db] Erro ao salvar resultados no banco:", error.message);
    }
  }
}
