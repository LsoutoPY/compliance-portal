import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { FIXTURES, FUNDS, MONTHS, loadSyntheticRuns } from "./support.ts";

type Row = Record<string, string>;
type Tables = Record<string, Row[]>;

// Oráculo independente: fórmulas da seção 4/5 de docs/METODOLOGIA_LIQUIDEZ_FIDC.md.
// Lê o CSV bruto dos ZIPs sintéticos; não chama o parser CVM nem o motor para obter esperados.
async function rawTables(month: string, cnpj: string): Promise<Tables> {
  const zip = await JSZip.loadAsync(readFileSync(resolve(FIXTURES, `synthetic_informe_${month.replace("-", "")}.zip`)));
  const result: Tables = {};
  for (const table of ["I", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X_2", "X_4"]) {
    const filename = `inf_mensal_fidc_tab_${table}_${month.replace("-", "")}.csv`;
    const entry = zip.file(filename);
    if (!entry) throw new Error(`Fixture sem ${filename}`);
    const lines = new TextDecoder("iso-8859-1").decode(await entry.async("uint8array")).trim().split(/\r?\n/);
    const headers = lines.shift()!.split(";");
    result[`tab_${table}`] = lines.map((line) => {
      const cells = line.split(";");
      if (cells.length !== headers.length) throw new Error(`Layout sintético inesperado: ${filename}`);
      return Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
    }).filter((row) => row.CNPJ_FUNDO === cnpj);
  }
  return result;
}

function independentExpected(tables: Tables, minimum: number | null) {
  const one = (table: string) => tables[table][0];
  const amount = (row: Row, field: string) => {
    if (!row || row[field] === undefined || row[field] === "") throw new Error(`Campo necessário à amostra: ${field}`);
    const value = Number(row[field].replace(",", "."));
    if (!Number.isFinite(value)) throw new Error(`Valor inválido: ${field}`);
    return value;
  };
  const i = one("tab_I"), iv = one("tab_IV"), v = one("tab_V"), vi = one("tab_VI");
  const vii = one("tab_VII"), ix = one("tab_IX");
  const pl = amount(iv, "TAB_IV_A_VL_PL");
  const pdd = -(amount(i, "TAB_I2A11_VL_REDUCAO_RECUP") + amount(i, "TAB_I2B11_VL_REDUCAO_RECUP"));
  const direct = amount(i, "TAB_I2A_VL_DIRCRED_RISCO") + amount(i, "TAB_I2B_VL_DIRCRED_SEM_RISCO");
  const extraFields = ["TAB_I2H_VL_COTA_FIDC", "TAB_I2I_VL_COTA_FIDC_NP", "TAB_I2C1_VL_DEBENTURE",
    "TAB_I2C2_VL_CRI", "TAB_I2C3_VL_NP_COMERC", "TAB_I2C4_VL_LETRA_FINANC", "TAB_I2C6_VL_OUTRO"];
  const creditGross = direct + extraFields.map((field) => amount(i, field)).reduce((sum, value) => sum + value, 0) - pdd;
  const overdue = amount(v, "TAB_V_B_VL_DIRCRED_INAD") + amount(vi, "TAB_VI_B_VL_DIRCRED_INAD");
  const outflow = -(tables.tab_X_4.filter((row) => ["Resgates no Mês", "Amortizações no Mês"].includes(row.TAB_X_TP_OPER))
    .map((row) => amount(row, "TAB_X_VL_TOTAL")).reduce((sum, value) => sum + value, 0));
  const subordinateValue = tables.tab_X_2.filter((row) => row.TAB_X_CLASSE_SERIE.toLowerCase().includes("subordinada"))
    .map((row) => amount(row, "TAB_X_QT_COTA") * amount(row, "TAB_X_VL_COTA"))
    .reduce((sum, value) => sum + value, 0);
  const subordination = subordinateValue / pl;
  const debtorTop5 = tables.tab_VIII.map((row) => amount(row, "VALOR"))
    .sort((a, b) => b - a).slice(0, 5).reduce((sum, value) => sum + value, 0) / pl;
  const suffixes = ["30", "60", "90", "120", "150", "180", "360", "720", "1080", "MAIOR_1080"];
  const midpoints = [15, 45, 75, 105, 135, 165, 270, 540, 900, 1080];
  const maturity = suffixes.map((suffix, index) =>
    amount(v, `TAB_V_A${index + 1}_VL_PRAZO_VENC_${suffix}`) +
    amount(vi, `TAB_VI_A${index + 1}_VL_PRAZO_VENC_${suffix}`));
  const averageMaturityCalendarDays = maturity.reduce((sum, value, index) => sum + value * midpoints[index], 0) /
    maturity.reduce((sum, value) => sum + value, 0);
  const purchases = [
    [amount(vii, "TAB_VII_A1_2_VL_DIRCRED_RISCO"), amount(ix, "TAB_IX_A1_1_2_COMPRA_MEDIA")],
    [amount(vii, "TAB_VII_A2_2_VL_DIRCRED_SEM_RISCO"), amount(ix, "TAB_IX_B1_1_2_COMPRA_MEDIA")],
  ].filter(([value, rate]) => value > 0 && rate > 0 && rate <= 300);
  const cessionRateAnnual = purchases.reduce((sum, [value, rate]) => sum + value * rate, 0) /
    purchases.reduce((sum, [value]) => sum + value, 0) / 100;
  return {
    pl, pdd, creditGross, overdue, redemptions: outflow, subordination, debtorTop5,
    averageMaturityCalendarDays, cessionRateAnnual,
    subordinationHeadroom: minimum === null ? null : subordination - minimum,
  };
}

describe("L0 · 10 fórmulas independentes sobre entradas sintéticas", () => {
  it.each(MONTHS.flatMap((month) => FUNDS.map((cnpj) => [month, cnpj] as const)))
    ("compara 10 indicadores em %s / %s", async (month, cnpj) => {
      const minimum = cnpj === FUNDS[0] ? .05 : null;
      const expected = independentExpected(await rawTables(month, cnpj), minimum);
      expect(Object.keys(expected)).toHaveLength(10);
      const actual = (await loadSyntheticRuns())[month][cnpj];
      for (const [key, value] of Object.entries(expected))
        expect(actual.metrics[key].value, `${month} ${cnpj} ${key}`).toBe(value);
    });
});
