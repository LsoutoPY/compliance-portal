/**
 * Carregamento e resolução dos resultados processados de risco de liquidez.
 * Espelha o padrão do enquadramento: DB como fonte primária + fallback localStorage
 * e lookup por CNPJ|ISIN com retrocompatibilidade para chaves só-CNPJ.
 */

import {
  loadLiquidezResultsFromDb,
  saveLiquidezResultsToDb,
  type LiquidezMonitoramentoRiscoRow,
} from "@/lib/liquidezMonitoramentoRiscoDb";

export type LiquidezProcessedFundData = {
  totalPL: number;
  isFundoFechado: boolean;
  prazoResgate: number | null;
  indiceLiquidez: number | null;
  status: string;
  intermediateStatus?: string | null;
  /** Fundos fechados — trilha cobertura operacional */
  mesesCobertura?: number | null;
  dispPL?: number | null;
  statusCobertura?: string | null;
  fonteDespesa?: string | null;
};

export const LIQUIDEZ_STORAGE_KEY_PREFIX = "liquidez-monitoramento-processed-";

export function liquidezStorageKey(dtPosicao: string): string {
  return `${LIQUIDEZ_STORAGE_KEY_PREFIX}${dtPosicao}`;
}

export function cleanCnpjKey(cnpj: string): string {
  return String(cnpj ?? "").replace(/\D/g, "");
}

/** Chave estável para cache: CNPJ limpo + ISIN */
export function fundCacheKey(cnpj: string, isin?: string | null): string {
  return `${cleanCnpjKey(cnpj)}|${String(isin ?? "").trim()}`;
}

/** Normaliza chaves vindas do localStorage (cnpj, cnpj|isin ou CNPJ formatado). */
export function normalizeProcessedMapKey(key: string): string {
  const raw = String(key ?? "").trim();
  if (!raw) return "";
  if (raw.includes("|")) {
    const [cnpjPart, isinPart = ""] = raw.split("|", 2);
    const ck = cleanCnpjKey(cnpjPart);
    return ck ? `${ck}|${String(isinPart).trim()}` : "";
  }
  const ck = cleanCnpjKey(raw);
  return ck ? `${ck}|` : "";
}

/** CNPJ de 14 dígitos para persistência no banco (unique por fundo+data). */
export function cnpjFromMapKey(key: string): string {
  return cleanCnpjKey(key.split("|")[0] || key);
}

function dbRowToProcessed(
  row: Omit<LiquidezMonitoramentoRiscoRow, "fundo_cnpj" | "dt_posicao">
): LiquidezProcessedFundData {
  const isFechado = row.is_fundo_fechado ?? false;
  return {
    totalPL: row.total_pl ?? 0,
    isFundoFechado: isFechado,
    prazoResgate: row.prazo_resgate ?? null,
    indiceLiquidez: isFechado ? (row.meses_cobertura ?? null) : (row.indice_liquidez ?? null),
    status: isFechado
      ? (row.status_cobertura && row.status_cobertura !== "indisponivel"
          ? row.status_cobertura
          : row.status ?? "pendente")
      : (row.status ?? "pendente"),
    intermediateStatus: row.intermediate_status ?? null,
    mesesCobertura: row.meses_cobertura ?? null,
    dispPL: row.disp_pl ?? null,
    statusCobertura: row.status_cobertura ?? null,
    fonteDespesa: row.fonte_despesa ?? null,
  };
}

/**
 * Resolve resultado processado para um fundo.
 * 1. Par exato cnpj|isin
 * 2. Fallback cnpj| (registros antes da migração ISIN / DB só com CNPJ)
 * 3. Legado: chave só com CNPJ no mapa
 */
export function resolveProcessedFund(
  map: Map<string, LiquidezProcessedFundData>,
  cnpj: string,
  isin?: string | null
): LiquidezProcessedFundData | undefined {
  const cnpjClean = cleanCnpjKey(cnpj);
  if (!cnpjClean) return undefined;

  const isinNorm = String(isin ?? "").trim();
  const exact = map.get(`${cnpjClean}|${isinNorm}`);
  if (exact) return exact;

  if (isinNorm) {
    const legacy = map.get(`${cnpjClean}|`);
    if (legacy) return legacy;
  }

  return map.get(cnpjClean) ?? map.get(`${cnpjClean}|`);
}

/** Lê localStorage preservando chaves cnpj|isin e normalizando legado só-CNPJ. */
export function loadLiquidezProcessedFromLocalStorage(
  dtPosicao: string
): Map<string, LiquidezProcessedFundData> {
  try {
    const raw = localStorage.getItem(liquidezStorageKey(dtPosicao));
    if (!raw) return new Map();

    const parsed = JSON.parse(raw) as Record<string, LiquidezProcessedFundData>;
    const map = new Map<string, LiquidezProcessedFundData>();
    for (const [k, v] of Object.entries(parsed)) {
      const nk = normalizeProcessedMapKey(k);
      if (nk) map.set(nk, v);
      else {
        const ck = cleanCnpjKey(k);
        if (ck) map.set(ck, v);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Mescla localStorage (histórico) + banco (fonte primária por CNPJ).
 * Registros do banco sobrescrevem o cache local na mesma chave cnpj|.
 */
export async function loadAllLiquidezProcessedResults(
  dtPosicao: string
): Promise<Map<string, LiquidezProcessedFundData>> {
  const [dbMap, localMap] = await Promise.all([
    loadLiquidezResultsFromDb(dtPosicao),
    Promise.resolve(loadLiquidezProcessedFromLocalStorage(dtPosicao)),
  ]);

  const merged = new Map<string, LiquidezProcessedFundData>();

  for (const [k, v] of localMap.entries()) {
    merged.set(k, v);
  }

  for (const [cnpjKey, row] of dbMap.entries()) {
    const data = dbRowToProcessed(row);
    const nk = normalizeProcessedMapKey(cnpjKey) || fundCacheKey(cnpjKey, "");
    if (nk) merged.set(nk, data);
    const ck = cleanCnpjKey(cnpjKey);
    if (ck) merged.set(ck, data);
  }

  return merged;
}

/** Carrega tudo e migra localStorage → banco quando houver dados só no cache local. */
export async function loadAndMigrateLiquidezProcessedResults(
  dtPosicao: string
): Promise<Map<string, LiquidezProcessedFundData>> {
  const localMap = loadLiquidezProcessedFromLocalStorage(dtPosicao);
  const merged = await loadAllLiquidezProcessedResults(dtPosicao);

  if (localMap.size > 0) {
    saveLiquidezResultsToDb(dtPosicao, merged).catch(() => {});
  }

  return merged;
}
