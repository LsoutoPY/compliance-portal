export interface MethodologyAssignment {
  fund_id: string;
  methodology_code: string;
  methodology_version: string;
  valid_from: string;
  valid_to: string | null;
}

export interface MethodologyRun {
  id: string;
  fund_id: string;
  reference_month: string;
  methodology_code: string;
  methodology_version: string;
  calculated_at: string;
  result: { gaps?: string[] };
}

export type LiquidityWorkStatus =
  | "pendente_metodologia"
  | "pendente_calculo"
  | "aguardando_revisao";

export interface FundMethodologyStatus {
  assignment: MethodologyAssignment | null;
  run: MethodologyRun | null;
  status: LiquidityWorkStatus;
  pending: string[];
}

// O resultado do motor não equivale à aprovação. Uma execução calculada sempre
// permanece em revisão até existir uma trilha explícita de decisão.
export function methodologyStatusForFund(
  fundId: string,
  referenceMonth: string,
  assignments: MethodologyAssignment[],
  runs: MethodologyRun[],
): FundMethodologyStatus {
  const applicable = assignments.filter((item) => item.fund_id === fundId &&
    item.valid_from <= referenceMonth && (item.valid_to === null || item.valid_to >= referenceMonth));
  if (applicable.length !== 1) return {
    assignment: null, run: null, status: "pendente_metodologia",
    pending: [applicable.length ? "Vigências de metodologia conflitantes." : "Metodologia não atribuída à competência."],
  };
  const assignment = applicable[0];
  const matching = runs.filter((item) => item.fund_id === fundId && item.reference_month === referenceMonth &&
    item.methodology_code === assignment.methodology_code && item.methodology_version === assignment.methodology_version)
    .sort((a, b) => b.calculated_at.localeCompare(a.calculated_at));
  const run = matching[0] ?? null;
  if (!run) return { assignment, run: null, status: "pendente_calculo", pending: ["Execução ausente para a metodologia vigente."] };
  return { assignment, run, status: "aguardando_revisao", pending: run.result.gaps ?? [] };
}
