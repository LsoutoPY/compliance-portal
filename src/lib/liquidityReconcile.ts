import type { LiquidityViewRow } from "./liquidity";
import type { RiskLevel } from "./liquidity";

export type ReconcileKind = "brl" | "pct" | "tesouraria";

export interface ReconcileField {
  key: string;
  label: string;
  kind: ReconcileKind;
  /** Compare absolute values (planilha grava saídas negativas; CVM positivas). */
  abs?: boolean;
}

export const RECONCILE_FIELDS: ReconcileField[] = [
  { key: "pl", label: "Patrimônio Líquido", kind: "brl" },
  { key: "indice_subordinacao", label: "Índice de Subordinação", kind: "pct" },
  { key: "mov_entradas", label: "Entradas / Captações", kind: "brl" },
  { key: "mov_saidas", label: "Saídas / Resgates", kind: "brl", abs: true },
  { key: "mov_captacoes_liquidas", label: "Captações Líquidas", kind: "brl" },
  { key: "baixa_recompra", label: "Baixa por Recompra", kind: "brl" },
  { key: "volume_dc_total", label: "Volume em DC (total)", kind: "brl" },
  { key: "volume_dc_vencidos", label: "Volume de DC Vencidos", kind: "brl" },
  { key: "valor_vencidos_total", label: "Valor de Vencidos Total", kind: "brl" },
  { key: "titulos_publicos_compromissadas", label: "Títulos Públicos | Compromissadas", kind: "brl" },
  { key: "saldo_tesouraria", label: "Saldo Tesouraria | Caixa", kind: "tesouraria" },
  { key: "conc_sacados_top1", label: "Concentração Sacados – Top 1", kind: "pct" },
  { key: "conc_sacados_top5", label: "Concentração Sacados – Top 5", kind: "pct" },
];

export type ReconcileStatus = "ok" | "alerta" | "diff" | "na";

export interface ReconcileRow {
  key: string;
  label: string;
  kind: ReconcileKind;
  xlsx: number | null;
  cvm: number | null;
  /** Values actually compared after unit/sign normalization */
  left: number | null;
  right: number | null;
  relDiff: number | null;
  status: ReconcileStatus;
  note: string | null;
}

export function reconcileStatusLevel(status: ReconcileStatus): RiskLevel {
  if (status === "ok") return "baixo";
  if (status === "alerta") return "moderado";
  if (status === "diff") return "alto";
  return "moderado";
}

function numOrNull(row: LiquidityViewRow | undefined, key: string): number | null {
  if (!row) return null;
  const value = row[key as keyof LiquidityViewRow];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function relativeDiff(a: number, b: number): number {
  const den = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return Math.abs(a - b) / den;
}

function statusFromRel(rel: number): ReconcileStatus {
  if (rel < 0.01) return "ok";
  if (rel < 0.05) return "alerta";
  return "diff";
}

/** Align units/signs so planilha and CVM can be compared. */
export function comparablePair(
  field: ReconcileField,
  xlsx: number | null,
  cvm: number | null,
  plXlsx: number | null,
  plCvm: number | null
): { left: number | null; right: number | null; note: string | null } {
  if (xlsx == null || cvm == null) {
    return { left: xlsx, right: cvm, note: null };
  }

  if (field.abs) {
    return { left: Math.abs(xlsx), right: Math.abs(cvm), note: "comparado em valor absoluto" };
  }

  if (field.kind === "tesouraria") {
    const xlsxIsPct = Math.abs(xlsx) <= 1;
    const cvmIsAbs = Math.abs(cvm) > 1;
    const pl = plCvm || plXlsx;
    if (xlsxIsPct && cvmIsAbs && pl) {
      return {
        left: xlsx,
        right: cvm / pl,
        note: "planilha em % do PL; CVM em R$ — comparado em %",
      };
    }
  }

  return { left: xlsx, right: cvm, note: null };
}

export function buildReconcileRows(
  xlsx: LiquidityViewRow | undefined,
  cvm: LiquidityViewRow | undefined
): ReconcileRow[] {
  const plX = numOrNull(xlsx, "pl");
  const plC = numOrNull(cvm, "pl");

  return RECONCILE_FIELDS.map((field) => {
    const xv = numOrNull(xlsx, field.key);
    const cv = numOrNull(cvm, field.key);
    const { left, right, note } = comparablePair(field, xv, cv, plX, plC);

    let relDiff: number | null = null;
    let status: ReconcileStatus = "na";
    if (left != null && right != null) {
      relDiff = relativeDiff(left, right);
      status = statusFromRel(relDiff);
    }

    return {
      key: field.key,
      label: field.label,
      kind: field.kind,
      xlsx: xv,
      cvm: cv,
      left,
      right,
      relDiff,
      status,
      note,
    };
  });
}

export function summarizeReconcile(rows: ReconcileRow[]): {
  ok: number;
  alerta: number;
  diff: number;
  na: number;
} {
  return {
    ok: rows.filter((r) => r.status === "ok").length,
    alerta: rows.filter((r) => r.status === "alerta").length,
    diff: rows.filter((r) => r.status === "diff").length,
    na: rows.filter((r) => r.status === "na").length,
  };
}
