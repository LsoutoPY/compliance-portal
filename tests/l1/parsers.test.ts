import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { groupCvmMonthlyZipEntries } from "../../supabase/functions/_shared/cvm-monthly-csv.ts";
import { parseCvparPositionCsv } from "../../supabase/functions/_shared/cvpar-position-csv.ts";
import { FIXTURES, FUNDS } from "./support.ts";

const zipFile = () => JSZip.loadAsync(readFileSync(resolve(FIXTURES, "synthetic_informe_202601.zip")));
const position = (cnpj = FUNDS[0]) => readFileSync(resolve(FIXTURES, `synthetic_carteira_${cnpj}_202601.csv`));

describe("parser · Informe Mensal CVM", () => {
  it("lê ;, ISO-8859-1 e as dez tabelas consumidas, selecionando CNPJ e competência", async () => {
    const zip = await zipFile();
    const selected = await groupCvmMonthlyZipEntries(zip.files, "2026-01", new Set([FUNDS[0]]));
    expect(selected.filesSeen).toBe(10);
    expect(selected.rowsSeen).toBeGreaterThan(10);
    expect(Object.keys(selected.tablesByCnpj)).toEqual([FUNDS[0]]);
    expect(Object.keys(selected.tablesByCnpj[FUNDS[0]]).sort()).toEqual(
      ["tab_I", "tab_III", "tab_IV", "tab_V", "tab_VI", "tab_VII", "tab_VIII", "tab_IX", "tab_X_2", "tab_X_4"].sort(),
    );
    expect(selected.tablesByCnpj[FUNDS[0]].tab_X_4[0].TAB_X_TP_OPER).toBe("Captações no Mês");
    expect(selected.tablesByCnpj[FUNDS[0]].tab_I[0].TAB_I2A_VL_DIRCRED_RISCO).toBe("1000");
  });

  it("rejeita competência diferente no nome ou no campo da linha", async () => {
    const zip = await zipFile();
    await expect(groupCvmMonthlyZipEntries(zip.files, "2026-02", new Set(FUNDS))).rejects.toThrow("competência incompatível");
    const one = { "inf_mensal_fidc_tab_I_202601.csv": { async: async () => new TextEncoder().encode(`CNPJ_FUNDO;DT_COMPTC\n${FUNDS[0]};2026-02-01`) } };
    await expect(groupCvmMonthlyZipEntries(one, "2026-01", new Set(FUNDS))).rejects.toThrow("DT_COMPTC incompatível");
  });

  it("rejeita tabela repetida no ZIP", async () => {
    const zip = await zipFile();
    zip.file("pasta/inf_mensal_fidc_tab_I_202601.csv", `CNPJ_FUNDO;DT_COMPTC\n${FUNDS[0]};2026-01-01`);
    await expect(groupCvmMonthlyZipEntries(zip.files, "2026-01", new Set(FUNDS))).rejects.toThrow("duplicada");
  });
});

describe("parser · Carteira Diária", () => {
  it("decodifica Windows-1252, data na segunda linha e rubricas CPR", () => {
    const result = parseCvparPositionCsv(new TextDecoder("windows-1252").decode(position()), "synthetic_carteira.csv");
    expect(result).toMatchObject({ referenceDate: "2026-01-31", cnpj: FUNDS[0], expenses: {
      administration: -10, custody: -2, management: -4, otherNegative: -3, cprBalance: -18,
    } });
  });

  it("preserva caractere exclusivo de Windows-1252 antes de interpretar a carteira", () => {
    const bytes = Buffer.concat([
      Buffer.from("CARTEIRA "), Buffer.from([0x80]),
      Buffer.from(`\n31/01/2026\nFundo,,,,,,,,,${FUNDS[0]}\nCPR\n31/01/2026,Taxa de administracao,-7\n`),
    ]);
    const decoded = new TextDecoder("windows-1252").decode(bytes);
    expect(decoded).toContain("CARTEIRA €");
    expect(parseCvparPositionCsv(decoded, "synthetic_cp1252.csv").expenses.administration).toBe(-7);
  });

  it.each([9, 26, 16])("encontra CNPJ na posição %i", (column) => {
    const cells = Array(27).fill("");
    cells[column] = FUNDS[0];
    const csv = `Cabeçalho\n31/01/2026\n${cells.join(",")}\nCPR\n31/01/2026,Administração,-1`;
    expect(parseCvparPositionCsv(csv, "synthetic_posicao.csv").cnpj).toBe(FUNDS[0]);
  });

  it("rejeita data ausente na segunda linha", () => {
    expect(() => parseCvparPositionCsv("Cabeçalho\nsem data", "synthetic.csv")).toThrow("sem data");
  });
});

describe("limite de upload ZIP no handler atual", () => {
  it("rejeita multipart acima de 15 MB antes de consultar o banco", async () => {
    vi.resetModules();
    let handler: ((request: Request) => Promise<Response>) | undefined;
    vi.stubGlobal("Deno", { env: { get: () => "synthetic" }, serve: (callback: typeof handler) => { handler = callback; } });
    vi.doMock("@supabase/supabase-js", () => ({ createClient: () => ({}) }));
    vi.doMock("../../supabase/functions/_shared/monthly-auth.ts", () => ({ requireRiskUser: async () => "synthetic-user" }));
    await import("../../supabase/functions/import-liquidity-monthly-cvm/index.ts");
    const form = new FormData();
    form.set("competencia", "2026-01");
    form.set("file", new File([new Uint8Array(15_000_001)], "synthetic_oversize.zip", { type: "application/zip" }));
    const response = await handler!(new Request("http://localhost", { method: "POST", body: form }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Envie um ZIP FIDC de até 15 MB." });
    vi.unstubAllGlobals();
    vi.doUnmock("@supabase/supabase-js");
    vi.doUnmock("../../supabase/functions/_shared/monthly-auth.ts");
  });

  it("rejeita resposta remota acima de 50 MB antes de abrir o ZIP", async () => {
    vi.resetModules();
    let handler: ((request: Request) => Promise<Response>) | undefined;
    vi.stubGlobal("Deno", { env: { get: () => "synthetic" }, serve: (callback: typeof handler) => { handler = callback; } });
    const logs: any[] = [];
    const chain = (table: string) => ({
      select: () => chain(table), not: () => chain(table),
      insert: (row: any) => { logs.push({ table, row }); return chain(table); },
      update: () => chain(table), eq: () => Promise.resolve({ error: null }),
      single: async () => ({ data: { id: `synthetic-${table}` }, error: null }),
      then: (resolve: (value: any) => void) => Promise.resolve(resolve({ data: [{ cnpj_fundo_master: FUNDS[0] }], error: null })),
    });
    vi.doMock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (table: string) => chain(table) }) }));
    vi.doMock("../../supabase/functions/_shared/monthly-auth.ts", () => ({ requireRiskUser: async () => "synthetic-user" }));
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(50_000_001), { status: 200 }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-31T00:00:00Z"));
    try {
      await import("../../supabase/functions/import-liquidity-monthly-cvm/index.ts");
      const response = await handler!(new Request("http://localhost", { method: "POST", body: JSON.stringify({ competencia: "2026-01" }) }));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "ZIP mensal acima do limite de 50 MB." });
      expect(logs.some((item) => item.table === "registry_sync_log")).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.doUnmock("@supabase/supabase-js");
      vi.doUnmock("../../supabase/functions/_shared/monthly-auth.ts");
    }
  });
});
