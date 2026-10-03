// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FUNDS, loadSyntheticRuns } from "./support.ts";

const state = vi.hoisted(() => ({
  runs: [] as any[],
  funds: [] as any[],
  exportPdf: vi.fn(),
}));

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "synthetic-user" } }) }));
vi.mock("@/components/Layout", () => ({ Layout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/lib/liquidityMonthlyExport", () => ({ exportMonthlyPdf: state.exportPdf, exportMonthlyExcel: vi.fn() }));
vi.mock("recharts", () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    ResponsiveContainer: passthrough, CartesianGrid: passthrough, XAxis: passthrough, YAxis: passthrough,
    Tooltip: passthrough, Legend: passthrough, Bar: passthrough, Line: passthrough,
    BarChart: ({ data, children }: any) => <div data-chart="bar" data-values={JSON.stringify(data)}>{children}</div>,
    LineChart: ({ data, children }: any) => <div data-chart="line" data-values={JSON.stringify(data)}>{children}</div>,
  };
});

class Query {
  private filters: Array<(row: any) => boolean> = [];
  private sorts: Array<{ key: string; ascending: boolean }> = [];
  private cap = Infinity;
  constructor(private table: string) {}
  select() { return this; }
  eq(key: string, value: unknown) { this.filters.push((row) => row[key] === value); return this; }
  not(key: string, _operator: string, _value: unknown) { this.filters.push((row) => row[key] != null); return this; }
  order(key: string, options?: { ascending?: boolean }) { this.sorts.push({ key, ascending: options?.ascending !== false }); return this; }
  limit(value: number) { this.cap = value; return this; }
  async maybeSingle() { const data = await this.collect(); return { data: data[0] ?? null, error: null }; }
  private async collect() {
    const source = this.table === "funds" ? state.funds : this.table === "liquidity_monthly_runs" ? state.runs :
      this.table === "ingest_runs" ? ["2026-02-01", "2026-01-01"].map((competencia) => ({ dataset: "cvm_informe_mensal_fidc", status: "ok", competencia })) :
      this.table === "profiles" ? [{ id: "synthetic-user", role: "risco" }] : [{ id: "synthetic-user", access_type: "completo", is_active: true }];
    return source.filter((row) => this.filters.every((filter) => filter(row)))
      .sort((a, b) => { for (const sort of this.sorts) { const comparison = String(a[sort.key]).localeCompare(String(b[sort.key])); if (comparison) return sort.ascending ? comparison : -comparison; } return 0; })
      .slice(0, this.cap);
  }
  then(resolve: (value: any) => void, reject: (reason: unknown) => void) { return this.collect().then((data) => resolve({ data, error: null }), reject); }
}
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: (table: string) => new Query(table) } }));

import LiquidezMensalArtefato from "../../src/pages/liquidez/LiquidezMensalArtefato.tsx";

async function setup(options: { minimums?: Array<number | null>; mutate?: (runs: any[]) => void } = {}) {
  const synthetic = await loadSyntheticRuns();
  state.funds = FUNDS.map((cnpj, i) => ({ short_name: `Synthetic ${i + 1}`, cnpj_fundo_master: cnpj, min_subordination_index: options.minimums?.[i] ?? (i ? .05 : null), active: true }));
  state.runs = FUNDS.flatMap((cnpj) => [
    { cnpj, reference_month: "2026-02-01", methodology_code: "cvpar_fidc_mensal", methodology_version: "2026.2", calculated_at: "2026-02-04T00:00:00Z", result: synthetic["2026-02"][cnpj] },
    { cnpj, reference_month: "2026-02-01", methodology_code: "cvpar_fidc_mensal", methodology_version: "2026.2", calculated_at: "2026-02-03T00:00:00Z", result: { ...synthetic["2026-02"][cnpj], metrics: { ...synthetic["2026-02"][cnpj].metrics, pl: { value: 999999, status: "apurado", source: "synthetic-old" } } } },
    { cnpj, reference_month: "2026-01-01", methodology_code: "cvpar_fidc_mensal", methodology_version: "2026.2", calculated_at: "2026-01-31T00:00:00Z", result: synthetic["2026-01"][cnpj] },
    { cnpj, reference_month: "2026-02-01", methodology_code: "cvpar_fidc_mensal", methodology_version: "2026.1", calculated_at: "2026-02-05T00:00:00Z", result: { ...synthetic["2026-02"][cnpj], metrics: { ...synthetic["2026-02"][cnpj].metrics, pl: { value: 888888, status: "apurado", source: "synthetic-other-version" } } } },
  ]);
  options.mutate?.(state.runs);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={queryClient}><LiquidezMensalArtefato /></QueryClientProvider>);
  await waitFor(() => expect(view.container.querySelector(".lma-filters span")?.textContent).toContain("0/2"));
  fireEvent.change(screen.getByLabelText("Competência"), { target: { value: "2026-02" } });
  fireEvent.click(screen.getByRole("button", { name: "Selecionar todos" }));
  await waitFor(() => expect(view.container.querySelectorAll(".lma-summary-card")).toHaveLength(2));
  return view;
}

beforeEach(() => state.exportPdf.mockReset());
afterEach(() => cleanup());

describe("Relatório · caracterização da tela", () => {
  it("mostra 74 linhas e escolhe a execução mais recente de 2026.2 por fundo", async () => {
    const view = await setup();
    const table = within(screen.getByRole("region", { name: "Relatório mensal por fundo" }));
    expect(view.container.querySelectorAll(".lma-table-wrap tbody tr:not(.lma-section)")).toHaveLength(74);
    const plRow = table.getByText("Patrimônio líquido").closest("tr")!;
    expect(plRow.textContent).toContain("R$ 6.000,00");
    expect(plRow.textContent).not.toContain("999.999");
    expect(plRow.textContent).not.toContain("888.888");
  });

  it("filtra a matriz e compara com a competência anterior sem alterar as entradas do PDF", async () => {
    const view = await setup();
    fireEvent.change(screen.getByLabelText("Filtrar linhas"), { target: { value: "PDD" } });
    expect(view.container.querySelectorAll(".lma-table-wrap tbody tr:not(.lma-section)").length).toBeLessThan(74);
    fireEvent.click(screen.getByLabelText(/Comparar com mês anterior/));
    await waitFor(() => expect(view.container.querySelector(".lma-delta")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Exportar$/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Exportar PDF/ }));
    await waitFor(() => expect(state.exportPdf).toHaveBeenCalledTimes(1));
    const input = state.exportPdf.mock.calls[0][0];
    expect(input.rows).toHaveLength(74);
    expect(input.funds.map((fund: any) => fund.cnpj)).toEqual([...FUNDS]);
    expect(input.previousMonth).toBe("2026-01");
    expect(input.previousRuns[FUNDS[0]].metrics.pl.value).toBe(3000);
  });
});

describe("apresentacao · alertas e gráficos", () => {
  it("prioriza mínimo ausente, depois sacado >50%, depois vencidos >120, depois nenhum gatilho", async () => {
    const view = await setup({ minimums: [null, .05], mutate: (runs) => {
      const latest = runs.find((run) => run.cnpj === FUNDS[1] && run.calculated_at === "2026-02-04T00:00:00Z");
      latest.result.metrics.debtorTop1.value = .6;
      latest.result.metrics.overdue120.value = 10;
    } });
    const cards = view.container.querySelectorAll(".lma-summary-card");
    expect(cards[0].textContent).toContain("Mínimo de subordinação não parametrizado");
    expect(cards[1].textContent).toContain("Maior sacado = 60%");
    cleanup();
    const second = await setup({ minimums: [.05, .05], mutate: (runs) => {
      for (const run of runs.filter((item) => item.calculated_at === "2026-02-04T00:00:00Z")) {
        run.result.metrics.debtorTop1.value = .1;
        run.result.metrics.overdue120.value = run.cnpj === FUNDS[0] ? 10 : 0;
      }
    } });
    const nextCards = second.container.querySelectorAll(".lma-summary-card");
    expect(nextCards[0].textContent).toContain("Vencidos > 120 dias");
    expect(nextCards[1].textContent).toContain("Sem gatilhos nos dados disponíveis");
  });

  it("converte ausente para zero nos gráficos e limita curva acumulada a 100% do PL", async () => {
    const view = await setup({ minimums: [.05, .05], mutate: (runs) => {
      const latest = runs.find((run) => run.cnpj === FUNDS[0] && run.calculated_at === "2026-02-04T00:00:00Z");
      latest.result.metrics.immediateLiquidity.value = null;
      latest.result.maturityCvm[0].value = 999999;
    } });
    fireEvent.click(screen.getByRole("button", { name: "Painel" }));
    const bar = JSON.parse(view.container.querySelector('[data-chart="bar"]')!.getAttribute("data-values")!);
    const line = JSON.parse(view.container.querySelector('[data-chart="line"]')!.getAttribute("data-values")!);
    expect(bar[0].Imediata).toBe(0);
    expect(line.at(-1)["Synthetic 1"]).toBe(100);
  });
});
