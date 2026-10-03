import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { groupCvmMonthlyZipEntries } from "../../supabase/functions/_shared/cvm-monthly-csv.ts";
import { CVPAR_MONTHLY_2026 } from "../../supabase/functions/_shared/liquidity-monthly.ts";
import { FIXTURES, FUNDS } from "./support.ts";

const mock = vi.hoisted(() => ({ service: null as any }));
vi.mock("../../supabase/functions/_shared/monthly-auth.ts", () => ({
  monthlyCors: {}, monthlyError: (error: Error) => new Response(JSON.stringify({ error: error.message }), { status: 500 }),
  requireRiskUser: async () => "synthetic-user", serviceClient: () => mock.service,
}));

class Query {
  private filters: Array<(row: any) => boolean> = [];
  private sorts: Array<{ key: string; ascending: boolean }> = [];
  private cap = Infinity;
  private operation: "read" | "insert" | "update" | "upsert" = "read";
  private payload: any;
  constructor(private table: string, private db: Record<string, any[]>) {}
  select() { return this; }
  eq(key: string, value: unknown) { this.filters.push((row) => row[key] === value); return this; }
  gte(key: string, value: unknown) { this.filters.push((row) => row[key] >= value); return this; }
  lte(key: string, value: unknown) { this.filters.push((row) => row[key] <= value); return this; }
  order(key: string, options?: { ascending?: boolean }) { this.sorts.push({ key, ascending: options?.ascending !== false }); return this; }
  limit(cap: number) { this.cap = cap; return this; }
  insert(value: any) { this.operation = "insert"; this.payload = value; return this; }
  update(value: any) { this.operation = "update"; this.payload = value; return this; }
  upsert(value: any) { this.operation = "upsert"; this.payload = value; return this; }
  async single() { const { data } = await this.execute(); return { data: data?.[0] ?? null, error: null }; }
  async maybeSingle() { return this.single(); }
  private async execute() {
    if (this.operation === "insert" || this.operation === "upsert") {
      const inserted = { id: `synthetic-${this.table}-${this.db[this.table].length + 1}`, ...this.payload };
      this.db[this.table].push(inserted);
      return { data: [inserted], error: null };
    }
    if (this.operation === "update") {
      for (const row of this.db[this.table].filter((item) => this.filters.every((filter) => filter(item)))) Object.assign(row, this.payload);
      return { data: null, error: null };
    }
    const data = this.db[this.table].filter((row) => this.filters.every((filter) => filter(row)))
      .sort((a, b) => { for (const sort of this.sorts) { const comparison = String(a[sort.key]).localeCompare(String(b[sort.key])); if (comparison) return sort.ascending ? comparison : -comparison; } return 0; })
      .slice(0, this.cap);
    return { data, error: null };
  }
  then(resolve: (value: any) => void, reject: (reason: unknown) => void) { return this.execute().then(resolve, reject); }
}

describe("seleção · Carteira Diária na Edge Function", () => {
  it("escolhe maior data de posição e, no empate, maior imported_at dentro do mês", async () => {
    vi.resetModules();
    let handler: ((request: Request) => Promise<Response>) | undefined;
    vi.stubGlobal("Deno", { serve: (callback: typeof handler) => { handler = callback; } });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-03T00:00:00Z"));
    try {
      const zip = await JSZip.loadAsync(readFileSync(resolve(FIXTURES, "synthetic_informe_202601.zip")));
      const grouped = await groupCvmMonthlyZipEntries(zip.files, "2026-01", new Set([FUNDS[0]]));
      const filings = Object.entries(grouped.tablesByCnpj[FUNDS[0]]).map(([tabela, payload], index) => ({
        id: `synthetic-filing-${index}`, cnpj: FUNDS[0], competencia: "2026-01-01", tabela, payload,
        imported_at: "2026-02-01T00:00:00Z", registry_sync_log_id: null, source_sha256: "synthetic-hash",
        source_storage_path: "synthetic/zip", source_origin: "synthetic",
      }));
      const position = (id: string, reference_date: string, imported_at: string, administration: number) => ({
        id, cnpj: FUNDS[0], reference_date, imported_at, file_sha256: id,
        summary: { referenceDate: reference_date, cnpj: FUNDS[0], fileName: `${id}.csv`, expenses: {
          administration, custody: -2, management: -4, otherNegative: -3, cprBalance: administration - 9,
        }, cash: null, publicBonds: null, fundUnits: null },
      });
      const db: Record<string, any[]> = {
        ingest_runs: [], funds: [{ id: "synthetic-fund", cnpj_fundo_master: FUNDS[0], short_name: "Synthetic", min_subordination_index: .05 }],
        liquidity_monthly_methodologies: [{ ...CVPAR_MONTHLY_2026, active: true, configuration: CVPAR_MONTHLY_2026 }],
        fund_monthly_cvm_filing: filings,
        liquidity_position_snapshots: [
          position("older-date-later-import", "2026-01-30", "2026-02-03T10:00:00Z", -99),
          position("same-date-old", "2026-01-31", "2026-02-01T10:00:00Z", -10),
          position("same-date-new", "2026-01-31", "2026-02-02T10:00:00Z", -12),
          position("next-month", "2026-02-01", "2026-02-03T11:00:00Z", -100),
        ],
        liquidity_monthly_runs: [],
      };
      mock.service = { from: (table: string) => new Query(table, db) };
      await import("../../supabase/functions/calculate-liquidity-monthly/index.ts");
      const response = await handler!(new Request("http://localhost", { method: "POST", body: JSON.stringify({ cnpj: FUNDS[0], competencia: "2026-01" }) }));
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.run.result.metrics.administrationExpense.value).toBe(-12);
      expect(data.run.source_manifest.position.id).toBe("same-date-new");
      expect(data.run.result.evidence.positionDate).toBe("2026-01-31");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
