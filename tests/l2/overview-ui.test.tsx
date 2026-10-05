// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  funds: [
    { id: "synthetic-a", short_name: "Synthetic A", cnpj_fundo_master: "00000000000001", active: true },
    { id: "synthetic-b", short_name: "Synthetic B", cnpj_fundo_master: "00000000000002", active: true },
  ],
  assignments: [{ fund_id: "synthetic-a", methodology_code: "cvpar_fidc_mensal", methodology_version: "2026.2", valid_from: "2026-01-01", valid_to: null }],
  runs: [{ id: "synthetic-run", fund_id: "synthetic-a", cnpj: "00000000000001", reference_month: "2026-09-01",
    methodology_code: "cvpar_fidc_mensal", methodology_version: "2026.2", calculated_at: "2026-10-01T00:00:00Z",
    input_sha256: "synthetic-hash", source_manifest: { cvm: [], position: null },
    result: { gaps: ["synthetic-gap"], metrics: { pl: { value: 1000, status: "apurado", source: "synthetic-CVM" } }, evidence: { tables: ["tab_IV"], positionDate: null } } }],
  reviews: [] as any[],
}));

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "synthetic-user" } }) }));
vi.mock("@/components/Layout", () => ({ Layout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("react-router-dom", async () => ({ ...(await vi.importActual("react-router-dom")), useNavigate: () => vi.fn() }));

class Query {
  private filters: Array<(row: any) => boolean> = [];
  private sorts: Array<{ key: string; ascending: boolean }> = [];
  private cap = Infinity;
  constructor(private table: string) {}
  select() { return this; }
  eq(key: string, value: unknown) { this.filters.push((row) => row[key] === value); return this; }
  lte(key: string, value: string) { this.filters.push((row) => row[key] <= value); return this; }
  or() { return this; }
  in(key: string, values: string[]) { this.filters.push((row) => values.includes(row[key])); return this; }
  order(key: string, options?: { ascending?: boolean }) { this.sorts.push({ key, ascending: options?.ascending !== false }); return this; }
  limit(value: number) { this.cap = value; return this; }
  async maybeSingle() { const data = await this.collect(); return { data: data[0] ?? null, error: null }; }
  private async collect() {
    const source = this.table === "funds" ? state.funds : this.table === "liquidity_methodology_assignments" ? state.assignments :
      this.table === "liquidity_monthly_runs" ? state.runs : this.table === "liquidity_monthly_review_events" ? state.reviews : [];
    return source.filter((row) => this.filters.every((filter) => filter(row)))
      .sort((a, b) => { for (const sort of this.sorts) { const comparison = String(a[sort.key]).localeCompare(String(b[sort.key])); if (comparison) return sort.ascending ? comparison : -comparison; } return 0; })
      .slice(0, this.cap);
  }
  then(resolve: (value: any) => void, reject: (reason: unknown) => void) { return this.collect().then((data) => resolve({ data, error: null }), reject); }
}
vi.mock("@/integrations/supabase/client", () => ({ supabase: {
  from: (table: string) => new Query(table), storage: { from: () => ({ createSignedUrl: vi.fn() }) },
} }));

import LiquidezVisaoGeral from "../../src/pages/liquidez/LiquidezVisaoGeral.tsx";

afterEach(() => cleanup());

describe("L2 · visão geral da liquidez", () => {
  it("mostra pendência de metodologia mesmo quando há fundos ativos", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><LiquidezVisaoGeral /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText("Synthetic B")).toBeTruthy());
    const row = screen.getByText("Synthetic B").closest("tr")!;
    expect(row.textContent).toContain("Metodologia pendente");
    expect(row.textContent).not.toContain("Aprovado");
    const calculated = screen.getByText("Synthetic A").closest("tr")!;
    expect(calculated.textContent).toContain("Aguardando revisão");
    expect(screen.queryByRole("button", { name: /Aprovar/ })).toBeNull();
  });

  it("abre histórico, memória e evidências sem conceder aprovação", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><LiquidezVisaoGeral /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText("Synthetic A")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Abrir fundo" })[0]);
    await waitFor(() => expect(screen.getByText("synthetic-CVM")).toBeTruthy());
    expect(screen.getByText(/A regra de quem aprova o fechamento será definida/)).toBeTruthy();
    expect(screen.getByText(/tab_IV/)).toBeTruthy();
  });
});
