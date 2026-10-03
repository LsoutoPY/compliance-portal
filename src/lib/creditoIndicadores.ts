/** Helpers de formatação e métricas derivadas do módulo de crédito. */

export const formatBRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(v || 0);

export const formatPct = (v: number | null | undefined, decimals = 2) =>
  `${(((v ?? 0) as number) * 100).toFixed(decimals)}%`;

export const formatPctPoints = (v: number | null | undefined, decimals = 2) => {
  if (v == null || Number.isNaN(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(decimals)} p.p.`;
};

export const formatDateBR = (d: string) => {
  if (!d) return "-";
  const date = new Date(d.includes("T") ? d : `${d}T00:00:00`);
  if (Number.isNaN(date.getTime())) return d;
  return new Intl.DateTimeFormat("pt-BR").format(date);
};

/** PDD atual ÷ PDD modelo */
export function calcAderenciaPdd(pddAtual: number, pddModelo: number): number | null {
  if (!pddModelo) return null;
  return pddAtual / pddModelo;
}

export function isMissingColumnError(error: unknown, columns: string[]) {
  const msg = String((error as { message?: string } | null)?.message || "").toLowerCase();
  return msg.includes("column") && columns.some((c) => msg.includes(c.toLowerCase()));
}

export const INDICADOR_EXTENDED_COLUMNS = [
  "pl",
  "pdd_sobre_pl",
  "pdd_sobre_over90",
  "impacto_stress_pl",
  "coverage_npl",
  "aderencia_pdd",
  "delta_over90",
  "delta_over180",
] as const;

export type IndicadorCreditoExtended = {
  import_id: string;
  criado_em?: string;
  nome_fundo: string;
  doc_fundo: string | null;
  data_referencia: string;
  carteira_total: number;
  over90: number;
  over180: number;
  coverage_vencidos: number;
  gap_total: number;
  pdd_atual_total: number;
  pdd_modelo_total: number;
  pl: number;
  pdd_sobre_pl: number;
  pdd_sobre_over90: number;
  impacto_stress_pl: number;
  coverage_npl: number;
  aderencia_pdd: number;
  delta_over90: number | null;
  delta_over180: number | null;
};

export const INDICADOR_BASE_SELECT =
  "import_id, criado_em, nome_fundo, doc_fundo, data_referencia, carteira_total, over90, over180, coverage_vencidos, gap_total, pdd_atual_total, pdd_modelo_total";

export const INDICADOR_EXTENDED_SELECT =
  `${INDICADOR_BASE_SELECT}, pl, pdd_sobre_pl, pdd_sobre_over90, impacto_stress_pl, coverage_npl, aderencia_pdd, delta_over90, delta_over180`;

export function mapIndicadorRow(r: Record<string, unknown>): IndicadorCreditoExtended {
  const pddAtual = Number(r.pdd_atual_total ?? 0);
  const pddModelo = Number(r.pdd_modelo_total ?? 0);
  const coverageNpl = r.coverage_npl != null
    ? Number(r.coverage_npl)
    : Number(r.pdd_sobre_over90 ?? 0);
  const aderencia = r.aderencia_pdd != null
    ? Number(r.aderencia_pdd)
    : (calcAderenciaPdd(pddAtual, pddModelo) ?? 0);

  return {
    import_id: String(r.import_id),
    criado_em: r.criado_em as string | undefined,
    nome_fundo: String(r.nome_fundo),
    doc_fundo: (r.doc_fundo as string | null) ?? null,
    data_referencia: String(r.data_referencia),
    carteira_total: Number(r.carteira_total ?? 0),
    over90: Number(r.over90 ?? 0),
    over180: Number(r.over180 ?? 0),
    coverage_vencidos: Number(r.coverage_vencidos ?? 0),
    gap_total: Number(r.gap_total ?? 0),
    pdd_atual_total: pddAtual,
    pdd_modelo_total: pddModelo,
    pl: Number(r.pl ?? 0),
    pdd_sobre_pl: Number(r.pdd_sobre_pl ?? 0),
    pdd_sobre_over90: Number(r.pdd_sobre_over90 ?? coverageNpl),
    impacto_stress_pl: Number(r.impacto_stress_pl ?? 0),
    coverage_npl: coverageNpl,
    aderencia_pdd: aderencia,
    delta_over90: r.delta_over90 != null ? Number(r.delta_over90) : null,
    delta_over180: r.delta_over180 != null ? Number(r.delta_over180) : null,
  };
}
