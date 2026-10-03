import {
  calcCdiAcumulado12M,
  calcCdiAcumuladoAno,
  calcCdiAcumuladoMes,
} from "../send-rentabilidade-report-auto/calc.ts";

// A versão invalida os acumulados legados, que podiam ter sido gravados em D-1.
export const CDI_CACHE_SOURCE = "bcb_sgs_12_20260915";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CdiSnapshot {
  dia: number | null;
  mes: number | null;
  ano: number | null;
  dozeMeses: number | null;
}

export interface CdiCacheRow {
  cdi_dia_pct: number | null;
  cdi_mes_pct: number | null;
  cdi_ano_pct: number | null;
  cdi_12m_pct: number | null;
  source: string;
  calculated_at: string;
}

export async function resolveCdiSnapshot(
  dataReferencia: string,
  cached: CdiCacheRow | null,
  fetchRates: () => Promise<Record<string, number>>,
  save: (snapshot: CdiSnapshot) => Promise<void>,
  now = Date.now(),
): Promise<CdiSnapshot> {
  const age = cached ? now - Date.parse(cached.calculated_at) : NaN;
  if (cached?.source === CDI_CACHE_SOURCE && age >= 0 && age < CACHE_MAX_AGE_MS
    && [cached.cdi_dia_pct, cached.cdi_mes_pct, cached.cdi_ano_pct, cached.cdi_12m_pct]
      .every((value) => typeof value === "number" && Number.isFinite(value))) {
    return {
      dia: cached.cdi_dia_pct, mes: cached.cdi_mes_pct,
      ano: cached.cdi_ano_pct, dozeMeses: cached.cdi_12m_pct,
    };
  }

  const rates = await fetchRates();
  // Sem taxa na data exata, não comparar o retorno de D com o CDI até D-1.
  // A ausência permanece explícita, inclusive em datas sem publicação.
  const hasReferenceRate = Number.isFinite(rates[dataReferencia]);
  const snapshot: CdiSnapshot = {
    dia: hasReferenceRate ? rates[dataReferencia] * 100 : null,
    mes: hasReferenceRate ? calcCdiAcumuladoMes(rates, dataReferencia) : null,
    ano: hasReferenceRate ? calcCdiAcumuladoAno(rates, dataReferencia) : null,
    dozeMeses: hasReferenceRate ? calcCdiAcumulado12M(rates, dataReferencia) : null,
  };
  // Não gravar uma resposta parcial sobre um cache anterior. Sem cache válido,
  // uma próxima execução consultará novamente o BCB.
  if (hasReferenceRate) await save(snapshot);
  return snapshot;
}
