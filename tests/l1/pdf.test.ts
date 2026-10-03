// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FUNDS, loadReportRows, loadSyntheticRuns } from "./support.ts";

const capture = vi.hoisted(() => ({ docs: [] as any[], tables: [] as any[] }));
vi.mock("jspdf", () => ({ jsPDF: class {
  pages = 1;
  texts: string[] = [];
  saved = "";
  constructor() { capture.docs.push(this); }
  addPage() { this.pages++; }
  setFillColor() { return this; }
  rect() { return this; }
  setFont() { return this; }
  setFontSize() { return this; }
  setTextColor() { return this; }
  text(value: string) { this.texts.push(value); return this; }
  getNumberOfPages() { return this.pages; }
  setPage() { return this; }
  save(filename: string) { this.saved = filename; }
} }));
vi.mock("jspdf-autotable", () => ({ default: (_pdf: any, options: any) => { capture.tables.push(options); options.didDrawPage(); } }));

import { exportMonthlyPdf } from "../../src/lib/liquidityMonthlyExport.ts";

beforeEach(() => {
  capture.docs.length = 0;
  capture.tables.length = 0;
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "#125d69" }));
});

describe("PDF · contrato textual e estrutural", () => {
  it("emite todos os fundos e 74 linhas, quatro colunas, metadados, lacunas, simulação e rodapé", async () => {
    const runs = (await loadSyntheticRuns())["2026-01"];
    const rows = loadReportRows();
    exportMonthlyPdf({
      month: "2026-01", source: "portal", funds: FUNDS.map((cnpj, i) => ({ cnpj, shortName: `Synthetic ${i + 1}` })),
      rows, runs, simulated: true,
    });
    expect(capture.docs).toHaveLength(1);
    expect(capture.docs[0].saved).toBe("Liquidez_FIDC_202601_portal.pdf");
    expect(capture.docs[0].pages).toBe(2);
    expect(capture.tables).toHaveLength(2);
    const pdfContract = { filename: capture.docs[0].saved, pages: capture.docs[0].pages,
      texts: capture.docs[0].texts, tables: capture.tables.map((table) => ({ head: table.head, body: table.body })) };
    const fixture = resolve("tests/fixtures/synthetic_pdf_expected_202601.json");
    expect(pdfContract).toStrictEqual(JSON.parse(readFileSync(fixture, "utf8")));
    for (const [index, table] of capture.tables.entries()) {
      expect(table.head).toEqual([["Indicador", "Valor", "Qualidade", "Origem / ressalva"]]);
      expect(Object.keys(table.columnStyles)).toEqual(["0", "1", "2", "3"]);
      const rowCells = table.body.filter((entry: any[]) => entry.length === 4);
      expect(rowCells).toHaveLength(74);
      expect(rowCells.map((entry: any[]) => entry[0])).toEqual(rows.map((row) => row.label.replace(/≤/g, "<=").replace(/[–—]/g, "-")));
      const gaps = table.body.filter((entry: any[]) => entry[0]?.content === "LACUNAS DA FONTE");
      expect(gaps).toHaveLength(1);
      expect(table.body.some((entry: any[]) => String(entry[0]?.content ?? "").includes("Estoque individual"))).toBe(true);
      expect(capture.docs[0].texts.join(" | ")).toContain(`CNPJ ${FUNDS[index]}  |  2026-01  |  Base do portal  |  cvpar_fidc_mensal@2026.2`);
    }
    const text = capture.docs[0].texts.join(" | ");
    expect(text).toContain("RISCO CVPAR  /  RELATÓRIO MENSAL FIDC");
    expect(text).toContain("ATENÇÃO: inclui parâmetro local simulado; não salvo no banco.");
    expect(text).toContain("Fonte: Informe Mensal CVM.");
    expect(text).toContain("1 / 2");
    expect(text).toContain("2 / 2");
  });

  it("registra n/d e indisponível no PDF para bucket ausente", async () => {
    const run = structuredClone((await loadSyntheticRuns())["2026-01"][FUNDS[0]]);
    run.maturityCvm[0].value = null;
    exportMonthlyPdf({ month: "2026-01", source: "preview", funds: [{ cnpj: FUNDS[0], shortName: "Synthetic 1" }],
      rows: loadReportRows(), runs: { [FUNDS[0]]: run }, simulated: false });
    const row = capture.tables[0].body.find((entry: any[]) => entry[0] === "DC a vencer · Até 30 dias");
    expect(row.slice(1, 3)).toEqual(["n/d", "Indisponível"]);
    expect(capture.docs[0].saved).toBe("Liquidez_FIDC_202601_previa.pdf");
  });
});
