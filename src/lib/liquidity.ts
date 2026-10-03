import type { LiquidityReport } from "../types/database";

export type RiskLevel = "baixo" | "moderado" | "alto" | "critico";

export const RISK_LABEL: Record<RiskLevel, string> = {
  baixo: "Baixo",
  moderado: "Moderado",
  alto: "Alto",
  critico: "Crítico",
};

export const MONTH_LABELS = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

export const NAV_ITEMS = [
  { id: "mercado", label: "Mercado", icon: "trending-up", section: "Risco" },
  { id: "credito", label: "Crédito", icon: "credit-card", section: "Risco" },
  { id: "liquidez", label: "Liquidez", icon: "crosshair", section: "Risco", badge: "novo" },
  { id: "enquadramento", label: "Enquadramento", icon: "clipboard-check", section: "Compliance" },
  { id: "relatorios", label: "Relatórios", icon: "file-text", section: "Compliance" },
];

export const FAIXAS = [
  { key: "faixa_vencidos_ate_5d", label: "Até 5 dias", color: "var(--series-1)" },
  { key: "faixa_vencidos_6_30d", label: "6–30 dias", color: "var(--series-2)" },
  { key: "faixa_vencidos_31_60d", label: "31–60 dias", color: "var(--series-3)" },
  { key: "faixa_vencidos_61_90d", label: "61–90 dias", color: "var(--series-4)" },
  { key: "faixa_vencidos_91_120d", label: "91–120 dias", color: "var(--series-5)" },
  { key: "faixa_vencidos_acima_120d", label: "Acima de 120 dias", color: "var(--risk-critico)" },
] as const;

export const BUCKETS = [
  { key: "prev_liq_ate_5d", label: "≤5d" },
  { key: "prev_liq_6_30d", label: "6-30d" },
  { key: "prev_liq_31_60d", label: "31-60d" },
  { key: "prev_liq_61_90d", label: "61-90d" },
  { key: "prev_liq_91_120d", label: "91-120d" },
  { key: "prev_liq_121_180d", label: "121-180d" },
  { key: "prev_liq_181_240d", label: "181-240d" },
  { key: "prev_liq_241_300d", label: "241-300d" },
  { key: "prev_liq_301_365d", label: "301-365d" },
  { key: "prev_liq_acima_365d", label: ">365d" },
] as const;

export interface LiquidityViewRow extends Partial<LiquidityReport> {
  fund: string;
  month: number;
  reference_month: string;
  min_subordination: number | null;
}

export function monthFromReference(referenceMonth: string): number {
  const parts = referenceMonth.slice(0, 10).split("-");
  const month = Number(parts[1]);
  return Number.isFinite(month) && month >= 1 && month <= 12 ? month : 1;
}

export function yearFromReference(referenceMonth: string | undefined): number {
  if (!referenceMonth) return 2026;
  const year = Number(referenceMonth.slice(0, 4));
  return Number.isFinite(year) ? year : 2026;
}

export function uniqueInOrder<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export function findRow(
  rows: LiquidityViewRow[],
  fund: string,
  month: number
): LiquidityViewRow | undefined {
  return rows.find((d) => d.fund === fund && d.month === month);
}

export function fundHistory(
  rows: LiquidityViewRow[],
  fund: string,
  throughMonth: number
): LiquidityViewRow[] {
  return rows
    .filter((d) => d.fund === fund && d.month <= throughMonth)
    .sort((a, b) => a.month - b.month);
}

export function subordinationLevel(idx: number, min: number): RiskLevel {
  const margin = idx - min;
  if (margin < 0) return "critico";
  if (margin < min * 0.2) return "moderado";
  return "baixo";
}

export function concentrationLevel(pct: number): RiskLevel {
  if (pct < 10) return "baixo";
  if (pct < 25) return "moderado";
  return "alto";
}

export function num(row: LiquidityViewRow, key: string): number {
  const value = row[key as keyof LiquidityViewRow];
  return typeof value === "number" ? value : 0;
}
