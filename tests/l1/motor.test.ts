import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { groupCvmMonthlyZipEntries } from "../../supabase/functions/_shared/cvm-monthly-csv.ts";
import { calculateMonthlyFidc, CVPAR_MONTHLY_2026, type CvmTables } from "../../supabase/functions/_shared/liquidity-monthly.ts";
import { FIXTURES, FUNDS, MONTHS, loadReportRows, loadSyntheticRuns, projectReportRows } from "./support.ts";

async function tables(): Promise<CvmTables> {
  const zip = await JSZip.loadAsync(readFileSync(resolve(FIXTURES, "synthetic_informe_202601.zip")));
  const parsed = await groupCvmMonthlyZipEntries(zip.files, "2026-01", new Set(FUNDS));
  return structuredClone(parsed.tablesByCnpj[FUNDS[0]]);
}
const run = (input: CvmTables, position = null, minimum: number | null = .05) =>
  calculateMonthlyFidc(input, "2026-01-01", FUNDS[0], CVPAR_MONTHLY_2026, position, minimum);

describe("motor · golden master sintético", () => {
  it.each(MONTHS.flatMap((month) => FUNDS.map((cnpj) => [month, cnpj] as const)))
    ("congela 74 linhas e resultado completo em %s / %s", async (month, cnpj) => {
      const actual = (await loadSyntheticRuns())[month][cnpj];
      const expected = JSON.parse(readFileSync(resolve(FIXTURES, `synthetic_expected_${month.replace("-", "")}_${cnpj}.json`), "utf8"));
      const rows = loadReportRows();
      expect(rows).toHaveLength(74);
      expect(JSON.parse(JSON.stringify(projectReportRows(actual, rows)))).toStrictEqual(expected.reportRows);
      expect(actual).toStrictEqual(expected.result);
    });
});

describe("motor · casos de borda sintéticos", () => {
  it("campo opcional presente vazio vira zero; coluna inexistente vira null", async () => {
    const input = await tables();
    input.tab_I[0].TAB_I2H_VL_COTA_FIDC = "";
    expect(run(input).metrics.fidcUnits.value).toBe(4);
    delete input.tab_I[0].TAB_I2A_VL_DIRCRED_RISCO;
    expect(run(input).metrics.creditGross).toMatchObject({ value: null, status: "indisponivel" });
  });

  it("denominador ausente ou zero deixa razão indisponível", async () => {
    const input = await tables();
    input.tab_IV[0].TAB_IV_A_VL_PL = "0";
    expect(run(input).metrics.creditToPl).toMatchObject({ value: null, status: "indisponivel" });
    delete input.tab_IV[0].TAB_IV_A_VL_PL;
    expect(run(input).metrics.subordination).toMatchObject({ value: null, status: "indisponivel" });
  });

  it("usa somente a primeira linha das tabelas agregadas", async () => {
    const input = await tables();
    input.tab_IV.push({ TAB_IV_A_VL_PL: "999999" });
    input.tab_I.push({ TAB_I1_VL_DISP: "999999" });
    expect(run(input).metrics.pl.value).toBe(3000);
    expect(run(input).metrics.cash.value).toBe(25);
  });

  it("inclui subordinada mezanino e exclui mezanino sem subordinada", async () => {
    const input = await tables();
    input.tab_X_2.push({ TAB_X_CLASSE_SERIE: "Mezanino", TAB_X_QT_COTA: "99", TAB_X_VL_COTA: "100" });
    expect(run(input).metrics.subordination.value).toBe(1000 / 3000);
    input.tab_X_2[1].TAB_X_CLASSE_SERIE = "Mezanino";
    expect(run(input).metrics.subordination.value).toBe(500 / 3000);
  });

  it("Top N sacados soma linhas repetidas sem consolidar identificador; cedente usa até nove posições", async () => {
    const input = await tables();
    input.tab_VIII = [
      { VALOR: "80", CNPJ: "mesmo" }, { VALOR: "50", CNPJ: "mesmo" }, { VALOR: "20", CNPJ: "outro" },
    ];
    input.tab_I[0].TAB_I2A12_CPF_CNPJ_CEDENTE_9 = "33333333333";
    input.tab_I[0].TAB_I2A12_PR_CEDENTE_9 = "51";
    input.tab_I[0].TAB_I2A12_CPF_CNPJ_CEDENTE_10 = "44444444444";
    input.tab_I[0].TAB_I2A12_PR_CEDENTE_10 = "90";
    const result = run(input);
    expect(result.metrics.debtorTop1.value).toBe(80 / 3000);
    expect(result.metrics.debtorTop5.value).toBe(150 / 3000);
    expect(result.metrics.cedentListedTop1.value).toBe(.51);
  });

  it("prazo médio usa pontos médios fixos e 252/365", async () => {
    const input = await tables();
    for (const table of ["tab_V", "tab_VI"]) {
      for (const key of Object.keys(input[table][0])) if (key.includes("_VL_PRAZO_VENC_")) input[table][0][key] = "0";
      input[table][0][`TAB_${table.slice(4).toUpperCase()}_A1_VL_PRAZO_VENC_30`] = "1";
      input[table][0][`TAB_${table.slice(4).toUpperCase()}_A10_VL_PRAZO_VENC_MAIOR_1080`] = "1";
    }
    const result = run(input);
    expect(result.metrics.averageMaturityCalendarDays.value).toBe((15 + 1080) / 2);
    expect(result.metrics.averageMaturityBusinessDays.value).toBe(((15 + 1080) / 2) * 252 / 365);
  });

  it("taxa de cessão filtra valor positivo e taxa em (0;300]% e converte para mês", async () => {
    const input = await tables();
    input.tab_IX[0].TAB_IX_A1_1_2_COMPRA_MEDIA = "300";
    input.tab_IX[0].TAB_IX_B1_1_2_COMPRA_MEDIA = "301";
    expect(run(input).metrics.cessionRateAnnual.value).toBe(3);
    expect(run(input).metrics.cessionRateMonthly.value).toBe(Math.pow(4, 1 / 12) - 1);
    input.tab_VII[0].TAB_VII_A1_2_VL_DIRCRED_RISCO = "0";
    expect(run(input).metrics.cessionRateAnnual.value).toBeNull();
  });

  it("PDD, DC direto bruto e DC total seguem configuração 2026.2", async () => {
    const result = run(await tables());
    expect(result.metrics.pdd.value).toBe(-15);
    expect(result.metrics.creditDirectGross.value).toBe(1515);
    expect(result.metrics.creditGross.value).toBe(1553);
    expect(result.metrics.creditNetPdd.value).toBe(1538);
  });

  it("sem Carteira Diária despesas ficam indisponíveis e cálculo continua", async () => {
    const result = run(await tables());
    for (const key of ["administrationExpense", "custodyExpense", "managementExpense", "otherNegativeExpenses", "cprBalance"])
      expect(result.metrics[key]).toMatchObject({ value: null, status: "indisponivel" });
    expect(result.metrics.pl.value).toBe(3000);
    expect(result.gaps[0]).toContain("Carteira diária ausente");
  });
});
