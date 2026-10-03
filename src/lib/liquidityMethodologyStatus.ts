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

export interface LiquidityReviewEvent {
  run_id: string;
  decision: "submitted" | "approved" | "returned";
  created_at: string;
  id: string;
}

export type LiquidityWorkStatus =
  | "pendente_metodologia"
  | "pendente_calculo"
  | "aguardando_revisao"
  | "aprovado";

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
  reviewEvents: LiquidityReviewEvent[] = [],
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
  const latestDecision = reviewEvents.filter((event) => event.run_id === run.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
  return {
    assignment, run,
    status: latestDecision?.decision === "approved" ? "aprovado" : "aguardando_revisao",
    pending: run.result.gaps ?? [],
  };
}
