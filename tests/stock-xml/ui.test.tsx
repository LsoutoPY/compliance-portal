// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  role: "risco",
  invoke: vi.fn(async () => ({ data: { run: { id: "synthetic-run" } }, error: null })),
  funds: [{ id: "synthetic-fund", short_name: "Synthetic FIDC", cnpj_fundo_master: "23104485000169", active: true }],
  imports: [{ id: "synthetic-import", reference_date: "2026-07-31", fund_document: "23.104.485/0001-69", file_name: "synthetic_stock.csv", imported_rows: 3, status: "success" }],
  xml: [{ fundo_cnpj: "23104485000169", fundo_dtposicao: "20260731", arquivo_nome: "synthetic_position.xml", fundo_nome: "Synthetic subordinada", fundo_isin: "SYNTHETIC-CLASS" }],
  runs: [{ id: "synthetic-run", cnpj: "23104485000169", reference_month: "2026-07-01", methodology_code: "cvpar_fidc_estoque_xml", methodology_version: "2026.1",
    calculated_at: "2026-10-05T00:00:00Z", input_sha256: "synthetic-hash", result: {
      methodology: "cvpar_fidc_estoque_xml@2026.1", metrics: {
        pl: { value: null, status: "indisponivel", source: "PL consolidado ausente" },
        classPl: { value: 1000, status: "apurado", source: "XML da classe" },
        administrationExpense: { value: 8, status: "apurado", source: "XML despesas.txadm" },
        stockGross: { value: 600, status: "apurado", source: "Estoque" },
        due30: { value: 100, status: "aproximado", source: "Estoque vencimento" },
        overdue: { value: 300, status: "apurado", source: "Estoque situação" },
      },
      maturity: [{ label: "Até 30 dias", value: 100 }], overdue: [{ label: "Até 30 dias", value: 300 }],
      gaps: ["Synthetic: PL consolidado ausente"], evidence: { positionDate: "2026-07-31", stockImportId: "synthetic-import", stockFileName: "synthetic_stock.csv", stockRows: 3,
        xmlFileName: "synthetic_position.xml", xmlRows: 3, xmlPositionName: "Synthetic subordinada", xmlIsin: "SYNTHETIC-CLASS" },
    } }],
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "synthetic-user" } }) }));
vi.mock("@/components/Layout", () => ({ Layout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

class Query {
  private filters: Array<(row: any) => boolean> = [];
  private sorts: Array<{ key: string; ascending: boolean }> = [];
  private cap = Infinity;
  constructor(private table: string) {}
  select() { return this; }
  eq(key: string, value: unknown) { this.filters.push((row) => row[key] === value); return this; }
  order(key: string, options?: { ascending?: boolean }) { this.sorts.push({ key, ascending: options?.ascending !== false }); return this; }
  limit(value: number) { this.cap = value; return this; }
  async maybeSingle() { const rows = await this.collect(); return { data: rows[0] ?? null, error: null }; }
  private async collect() {
    const source = this.table === "funds" ? state.funds : this.table === "importacoes_estoque_fidc" ? state.imports :
      this.table === "posicao_carteira" ? state.xml : this.table === "liquidity_monthly_runs" ? state.runs :
      this.table === "profiles" ? [{ id: "synthetic-user", role: state.role }] :
      this.table === "user_profiles" ? [{ id: "synthetic-user", access_type: "completo", is_active: true }] : [];
    return source.filter((row) => this.filters.every((filter) => filter(row)))
      .sort((a, b) => { for (const sort of this.sorts) { const comparison = String(a[sort.key]).localeCompare(String(b[sort.key])); if (comparison) return sort.ascending ? comparison : -comparison; } return 0; })
      .slice(0, this.cap);
  }
  then(resolve: (value: any) => void, reject: (reason: unknown) => void) { return this.collect().then((data) => resolve({ data, error: null }), reject); }
}
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: (table: string) => new Query(table), functions: { invoke: state.invoke } } }));

import LiquidezEstoqueXml from "../../src/pages/liquidez/LiquidezEstoqueXml.tsx";

afterEach(() => { cleanup(); state.role = "risco"; state.invoke.mockClear(); });

it("mostra estoque e XML da classe separados, com PL consolidado indisponível", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><LiquidezEstoqueXml /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByText("PL da posição/classe XML")).toBeTruthy());
  const plRow = screen.getByText("PL consolidado do fundo").closest("tr")!;
  expect(plRow.textContent).toContain("n/d");
  expect(screen.getByText("Synthetic subordinada · ISIN SYNTHETIC-CLASS")).toBeTruthy();
  expect(screen.getByText(/Synthetic: PL consolidado ausente/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Aprovar/ })).toBeNull();
});

it("calcula via Edge Function apenas para Risco ativo", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><LiquidezEstoqueXml /></QueryClientProvider>);
  const button = await screen.findByRole("button", { name: "Calcular dados importados" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(state.invoke).toHaveBeenCalledWith("calculate-liquidity-stock-xml", { body: { cnpj: "23104485000169", competencia: "2026-07" } }));
});

it("bloqueia cálculo para Compliance", async () => {
  state.role = "compliance";
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><LiquidezEstoqueXml /></QueryClientProvider>);
  const button = await screen.findByRole("button", { name: "Calcular dados importados" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
  expect(state.invoke).not.toHaveBeenCalled();
});
