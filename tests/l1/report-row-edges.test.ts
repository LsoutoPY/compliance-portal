import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { groupCvmMonthlyZipEntries } from "../../supabase/functions/_shared/cvm-monthly-csv.ts";
import { calculateMonthlyFidc, CVPAR_MONTHLY_2026, type CvmTables } from "../../supabase/functions/_shared/liquidity-monthly.ts";
import { FIXTURES, FUNDS, loadReportRows, projectReportRows } from "./support.ts";

async function input(): Promise<CvmTables> {
  const zip = await JSZip.loadAsync(readFileSync(resolve(FIXTURES, "synthetic_informe_202601.zip")));
  const grouped = await groupCvmMonthlyZipEntries(zip.files, "2026-01", new Set([FUNDS[0]]));
  return structuredClone(grouped.tablesByCnpj[FUNDS[0]]);
}
const report = (tables: CvmTables) => projectReportRows(
  calculateMonthlyFidc(tables, "2026-01-01", FUNDS[0], CVPAR_MONTHLY_2026, null, .05), loadReportRows());
const line = (rows: ReturnType<typeof report>, index: number, id: string) => {
  expect(rows[index - 1].id).toBe(id);
  return rows[index - 1];
};

// Numeração da matriz de 74 linhas em docs/L1_COBERTURA.md, não da planilha original.
describe("bordas das linhas 7, 33 e 66 do Relatório", () => {
  it("linha 7: amortização isolada sem linha de resgate fica n/d; resgate explícito zero produz saída", async () => {
    const tables = await input();
    tables.tab_X_4 = tables.tab_X_4.filter((row) => row.TAB_X_TP_OPER !== "Resgates no Mês");
    expect(line(report(tables), 7, "Movimentação | Saídas / resgates e amortizações"))
      .toMatchObject({ value: null, status: "indisponivel" });
    tables.tab_X_4.push({ TAB_X_TP_OPER: "Resgates no Mês", TAB_X_VL_TOTAL: "0" });
    expect(line(report(tables), 7, "Movimentação | Saídas / resgates e amortizações"))
      .toMatchObject({ value: -5, status: "aproximado" });
  });

  it("linha 33: bucket 91–120 não entra em >120; campo do bucket seguinte ausente torna n/d", async () => {
    const tables = await input();
    for (const table of ["tab_V", "tab_VI"]) {
      for (const key of Object.keys(tables[table][0])) if (/_B\d+_VL_INAD_/.test(key)) tables[table][0][key] = "0";
    }
    tables.tab_V[0].TAB_V_B4_VL_INAD_120 = "7";
    tables.tab_VI[0].TAB_VI_B5_VL_INAD_150 = "11";
    expect(line(report(tables), 33, "Inadimplência | Vencidos > 120 dias"))
      .toMatchObject({ value: 11, status: "apurado" });
    delete tables.tab_VI[0].TAB_VI_B5_VL_INAD_150;
    expect(line(report(tables), 33, "Inadimplência | Vencidos > 120 dias"))
      .toMatchObject({ value: null, status: "indisponivel" });
  });

  it("linha 66: recompra CVM preserva zero e negativo; campo vazio fica n/d", async () => {
    const tables = await input();
    for (const [field, value, status] of [
      ["0", 0, "aproximado"], ["-3", -3, "aproximado"], ["", null, "indisponivel"],
    ] as const) {
      tables.tab_VII[0].TAB_VII_D_2_VL_RECOMPRA = field;
      expect(line(report(tables), 66, "Recompra | Recompra agregada CVM"))
        .toMatchObject({ value, status });
    }
  });
});
