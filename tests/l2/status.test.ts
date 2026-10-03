import { describe, expect, it } from "vitest";
import { methodologyStatusForFund, type MethodologyAssignment, type MethodologyRun } from "../../src/lib/liquidityMethodologyStatus.ts";

const assignment: MethodologyAssignment = {
  fund_id: "synthetic-fund", methodology_code: "cvpar_fidc_mensal", methodology_version: "2026.2",
  valid_from: "2026-01-01", valid_to: null,
};
const run = (id: string, version: string, calculatedAt: string): MethodologyRun => ({
  id, fund_id: "synthetic-fund", reference_month: "2026-02-01",
  methodology_code: "cvpar_fidc_mensal", methodology_version: version,
  calculated_at: calculatedAt, result: { gaps: ["synthetic-gap"] },
});

describe("L2 · status da visão geral", () => {
  it("nunca considera fundo sem atribuição como concluído", () => {
    expect(methodologyStatusForFund("synthetic-fund", "2026-02-01", [], [run("r1", "2026.2", "2026-02-03")]).status)
      .toBe("pendente_metodologia");
  });
  it("respeita vigência e versão, escolhendo a execução mais recente", () => {
    const status = methodologyStatusForFund("synthetic-fund", "2026-02-01", [assignment], [
      run("old", "2026.2", "2026-02-03"), run("other-version", "2026.1", "2026-02-05"),
      run("new", "2026.2", "2026-02-04"),
    ]);
    expect(status.status).toBe("aguardando_revisao");
    expect(status.run?.id).toBe("new");
    expect(status.pending).toEqual(["synthetic-gap"]);
  });
  it("mantém cálculo e vigência ausentes como pendência", () => {
    expect(methodologyStatusForFund("synthetic-fund", "2026-02-01", [assignment], []).status).toBe("pendente_calculo");
    expect(methodologyStatusForFund("synthetic-fund", "2025-12-01", [assignment], []).status).toBe("pendente_metodologia");
    expect(methodologyStatusForFund("synthetic-fund", "2026-02-01", [assignment, assignment], []).status)
      .toBe("pendente_metodologia");
  });
  it("só mostra aprovação explícita da execução mais recente", () => {
    const runs = [run("old", "2026.2", "2026-02-03"), run("new", "2026.2", "2026-02-04")];
    const approvals = [{ id: "event-1", run_id: "old", decision: "approved" as const, created_at: "2026-02-05" }];
    expect(methodologyStatusForFund("synthetic-fund", "2026-02-01", [assignment], runs, approvals).status)
      .toBe("aguardando_revisao");
    const current = [...approvals, { id: "event-2", run_id: "new", decision: "approved" as const, created_at: "2026-02-06" }];
    expect(methodologyStatusForFund("synthetic-fund", "2026-02-01", [assignment], runs, current).status)
      .toBe("aprovado");
    const returned = [...current, { id: "event-3", run_id: "new", decision: "returned" as const, created_at: "2026-02-07" }];
    expect(methodologyStatusForFund("synthetic-fund", "2026-02-01", [assignment], runs, returned).status)
      .toBe("aguardando_revisao");
  });
});
