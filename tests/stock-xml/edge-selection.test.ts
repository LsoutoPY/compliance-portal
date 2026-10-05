import { expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ service: null as any }));
vi.mock("../../supabase/functions/_shared/monthly-auth.ts", () => ({
  monthlyCors: {}, monthlyError: (error: Error) => new Response(JSON.stringify({ error: error.message }), { status: 500 }),
  requireRiskUser: async () => "synthetic-user", serviceClient: () => mock.service,
}));

class Query {
  private filters: Array<(row: any) => boolean> = [];
  private sorts: Array<{ key: string; ascending: boolean }> = [];
  private cap = Infinity;
  private start = 0;
  private operation: "read" | "insert" | "update" | "upsert" = "read";
  private payload: any;
  constructor(private table: string, private db: Record<string, any[]>) {}
  select() { return this; }
  eq(key: string, value: unknown) { this.filters.push((row) => row[key] === value); return this; }
  order(key: string, options?: { ascending?: boolean }) { this.sorts.push({ key, ascending: options?.ascending !== false }); return this; }
  limit(cap: number) { this.cap = cap; return this; }
  range(start: number, end: number) { this.start = start; this.cap = end - start + 1; return this; }
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
      .slice(this.start, this.start + this.cap);
    return { data, error: null };
  }
  then(resolve: (value: any) => void, reject: (reason: unknown) => void) { return this.execute().then(resolve, reject); }
}

it("seleciona o último estoque concluído e o último XML da mesma data-base", async () => {
  vi.resetModules();
  let handler: ((request: Request) => Promise<Response>) | undefined;
  vi.stubGlobal("Deno", { serve: (callback: typeof handler) => { handler = callback; } });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
  try {
    const cnpj = "23104485000169";
    const stock = (importId: string, amount: number) => ({ id: `synthetic-${importId}`, import_id: importId,
      doc_fundo: cnpj, doc_sacado: "11", doc_cedente: "22", data_referencia: "2026-07-31",
      data_vencimento_ajustada: "2026-08-05", situacao_recebivel: "A vencer", tipo_recebivel: "Duplicata",
      valor_presente: amount, valor_pdd: 0, valor_aquisicao: amount, taxa_cessao: .1 });
    const xml = (file: string, importedAt: string, txadm: number) => [
      { id: `${file}-1`, arquivo_nome: file, created_at: importedAt, fundo_cnpj: cnpj, fundo_dtposicao: "20260731", fundo_isin: "SYNTHETIC-CLASS", fundo_nome: "Synthetic subordinada", section: "despesas", cnpjfundo: null, fundo_patliq: 1000, txadm, saldo: null, valor_padrao: null },
      { id: `${file}-2`, arquivo_nome: file, created_at: importedAt, fundo_cnpj: cnpj, fundo_dtposicao: "20260731", fundo_isin: "SYNTHETIC-CLASS", fundo_nome: "Synthetic subordinada", section: "caixa", cnpjfundo: null, fundo_patliq: 1000, txadm: null, saldo: 20, valor_padrao: 20 },
      { id: `${file}-3`, arquivo_nome: file, created_at: importedAt, fundo_cnpj: cnpj, fundo_dtposicao: "20260731", fundo_isin: "SYNTHETIC-CLASS", fundo_nome: "Synthetic subordinada", section: "titpublico", cnpjfundo: null, fundo_patliq: 1000, txadm: null, saldo: null, valor_padrao: 30 },
    ];
    const db: Record<string, any[]> = {
      funds: [{ id: "synthetic-fund", cnpj_fundo_master: cnpj, short_name: "Synthetic" }],
      liquidity_monthly_methodologies: [{ code: "cvpar_fidc_estoque_xml", version: "2026.1", active: true }],
      importacoes_estoque_fidc: [
        { id: "old", reference_date: "2026-07-31", status: "success", fund_document: cnpj, file_name: "synthetic_old.csv", imported_rows: 1, created_at: "2026-10-01T00:00:00Z" },
        { id: "new", reference_date: "2026-07-31", status: "success", fund_document: cnpj, file_name: "synthetic_new.csv", imported_rows: 1, created_at: "2026-10-02T00:00:00Z" },
        { id: "wrong-date", reference_date: "2026-06-30", status: "success", fund_document: cnpj, file_name: "synthetic_wrong.csv", imported_rows: 1, created_at: "2026-10-03T00:00:00Z" },
      ],
      estoque_fidc: [stock("old", 90), stock("new", 100), stock("wrong-date", 200)],
      posicao_carteira: [...xml("synthetic_old.xml", "2026-10-01T00:00:00Z", 5), ...xml("synthetic_new.xml", "2026-10-02T00:00:00Z", 8)],
      ingest_runs: [], liquidity_monthly_runs: [],
    };
    mock.service = { from: (table: string) => new Query(table, db) };
    await import("../../supabase/functions/calculate-liquidity-stock-xml/index.ts");
    const response = await handler!(new Request("http://localhost", { method: "POST", body: JSON.stringify({ cnpj, competencia: "2026-07" }) }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.run.result.metrics.stockGross.value).toBe(100);
    expect(payload.run.result.metrics.administrationExpense.value).toBe(8);
    expect(payload.run.source_manifest.stock.import_id).toBe("new");
    expect(payload.run.source_manifest.xml.file_name).toBe("synthetic_new.xml");
    expect(db.ingest_runs[0].status).toBe("ok");
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
