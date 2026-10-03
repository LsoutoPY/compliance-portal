/**
 * Cálculo de prazo médio de títulos RF com amortizações intermediárias.
 *
 * Implementa Art. 4º §2º inciso II IN RFB 1585/2015:
 *   prazo_título = Σ(valor_nominal_j × dias_corridos_j) / Σ(valor_nominal_j)
 *
 * Também expõe helpers de resolução de chave para linking
 * posicao_carteira → titulo_rf_fluxo.
 */

// ──────────────────────────────────────────────────────────────
// Tipos públicos
// ──────────────────────────────────────────────────────────────

export interface FluxoPagamento {
  data_pagamento: string; // ISO "YYYY-MM-DD" ou "YYYYMMDD"
  valor_nominal: number;
  tipo_fluxo?: "amortizacao" | "juros" | "residual";
}

export type MetodoPrazoRf = "vencimento" | "fluxo_nominal";

export interface ResultadoPrazoFluxos {
  prazo: number;
  metodo: MetodoPrazoRf;
  fluxos_considerados: number;
  soma_nominal: number;
  /** Detalhe de cada fluxo futuro (para exibição na UI) */
  fluxos_resumo: Array<{ data: string; valor_nominal: number; dias: number }>;
  motivo: string;
}

// ──────────────────────────────────────────────────────────────
// Helpers de data
// ──────────────────────────────────────────────────────────────

/** Normaliza data YYYYMMDD ou YYYY-MM-DD para Date (noon UTC). */
export function parseDataFluxo(raw: string): Date | null {
  const s = String(raw ?? "").trim().replace(/\D/g, "").slice(0, 8);
  if (s.length !== 8) return null;
  const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Dias corridos entre dtRef e dtPagamento (positivo = no futuro). */
export function diasCorridosEntre(dtRef: Date, dtPag: Date): number {
  return Math.round((dtPag.getTime() - dtRef.getTime()) / (24 * 60 * 60 * 1000));
}

/** Dias úteis entre duas datas (seg–sex, sem feriados). */
export function diasUteisEntre(dtRef: Date, dtPag: Date): number {
  let count = 0;
  const cur = new Date(dtRef);
  cur.setUTCHours(12, 0, 0, 0);
  const fim = new Date(dtPag);
  fim.setUTCHours(12, 0, 0, 0);

  if (fim <= cur) return 0;

  cur.setUTCDate(cur.getUTCDate() + 1);
  while (cur <= fim) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

// ──────────────────────────────────────────────────────────────
// Cálculo por fluxos (inciso II)
// ──────────────────────────────────────────────────────────────

/**
 * Calcula o prazo médio ponderado por fluxos nominais futuros (Art. 4º §2º II).
 *
 * @param fluxos    Cronograma completo do título (amortizações + juros)
 * @param dtRefIso  Data de referência ISO "YYYY-MM-DD" (data da posição)
 * @param usarDiasCorridos  true → Art. 4º (tributário); false → dias úteis (liquidez)
 * @returns ResultadoPrazoFluxos ou null se não houver fluxos futuros elegíveis
 */
export function calcularPrazoMedioPorFluxos(
  fluxos: FluxoPagamento[],
  dtRefIso: string,
  usarDiasCorridos = true,
): ResultadoPrazoFluxos | null {
  const dtRef = parseDataFluxo(dtRefIso.replace(/-/g, ""));
  if (!dtRef) return null;

  const futuros = fluxos
    .map((f) => {
      const dtPag = parseDataFluxo(f.data_pagamento);
      if (!dtPag) return null;
      const dias = usarDiasCorridos
        ? diasCorridosEntre(dtRef, dtPag)
        : diasUteisEntre(dtRef, dtPag);
      return { ...f, dtPag, dias };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null && f.dias > 0);

  if (futuros.length === 0) return null;

  const somaNominal = futuros.reduce((s, f) => s + f.valor_nominal, 0);
  if (somaNominal <= 0) return null;

  const somaPonderada = futuros.reduce((s, f) => s + f.valor_nominal * f.dias, 0);
  const prazo = somaPonderada / somaNominal;

  return {
    prazo,
    metodo: "fluxo_nominal",
    fluxos_considerados: futuros.length,
    soma_nominal: somaNominal,
    fluxos_resumo: futuros.map((f) => ({
      data: f.dtPag.toISOString().slice(0, 10),
      valor_nominal: f.valor_nominal,
      dias: f.dias,
    })),
    motivo: `${futuros.length} fluxo(s) nominal(is) (Art. 4º §2º II) → ${prazo.toFixed(2)}d`,
  };
}

// ──────────────────────────────────────────────────────────────
// Chave canônica para linking posicao_carteira → titulo_rf_fluxo
// ──────────────────────────────────────────────────────────────

/**
 * Gera a lista de chaves canônicas a testar para um ativo da posição.
 *
 * Ordem de prioridade:
 * 1. "isin:<ISIN>"        — campo `isin` da linha de posicao_carteira
 * 2. "cetip:<CODATIVO>"   — campo `codativo` (código CETIP/SELIC)
 * 3. "cetip:<IDINTERNO>"  — campo `idinternoativo` (fallback custódia)
 *
 * O mesmo conjunto é usado para indexar a tabela titulo_rf_fluxo.chave_ativo.
 */
export function resolveChavesAtivo(row: {
  isin?: string | null;
  codativo?: string | null;
  idinternoativo?: string | null;
}): string[] {
  const chaves: string[] = [];
  const limpa = (v: unknown) => String(v ?? "").trim().toUpperCase();

  const isin = limpa(row.isin);
  if (isin) chaves.push(`isin:${isin}`);

  const cetip = limpa(row.codativo);
  if (cetip) chaves.push(`cetip:${cetip}`);

  const interno = limpa(row.idinternoativo);
  if (interno && interno !== cetip) chaves.push(`cetip:${interno}`);

  return chaves;
}

/**
 * Normaliza código CETIP/SELIC ou ISIN para a chave canônica.
 * Uso: ao importar o CSV de fluxos, converter a coluna de identificação.
 */
export function normalizarChaveAtivo(tipo: "isin" | "cetip", codigo: string): string {
  return `${tipo}:${String(codigo).trim().toUpperCase()}`;
}
