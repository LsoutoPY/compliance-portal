// Run explicitly once when establishing the L1 baseline. Tests never call this file.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { FUNDS, MONTHS, FIXTURES, loadReportRows, loadSyntheticRuns, projectReportRows } from "./support.ts";

mkdirSync(FIXTURES, { recursive: true });
const suffixes = ["30", "60", "90", "120", "150", "180", "360", "720", "1080", "MAIOR_1080"];
const makeRow = (cnpj, month, values) => ({ CNPJ_FUNDO: cnpj, DT_COMPTC: `${month}-01`, ...values });
const csv = (rows) => {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [headers.join(";"), ...rows.map((row) => headers.map((header) => String(row[header] ?? "").replaceAll('"', '""')).join(";"))];
  return Buffer.from(`${lines.join("\r\n")}\r\n`, "latin1");
};

for (const [monthIndex, month] of MONTHS.entries()) {
  const tables = Object.fromEntries(["I", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X_2", "X_4"].map((name) => [name, []]));
  for (const [fundIndex, cnpj] of FUNDS.entries()) {
    const n = (fundIndex + 1) * (monthIndex + 1);
    const fieldsI = {
      TAB_I2A_VL_DIRCRED_RISCO: 1000 * n, TAB_I2B_VL_DIRCRED_SEM_RISCO: 500 * n,
      TAB_I2A11_VL_REDUCAO_RECUP: 10 * n, TAB_I2B11_VL_REDUCAO_RECUP: 5 * n,
      TAB_I2H_VL_COTA_FIDC: 20 * n, TAB_I2I_VL_COTA_FIDC_NP: 4 * n,
      TAB_I2C1_VL_DEBENTURE: 3 * n, TAB_I2C2_VL_CRI: 2 * n,
      TAB_I2C3_VL_NP_COMERC: 1 * n, TAB_I2C4_VL_LETRA_FINANC: 2 * n,
      TAB_I2C6_VL_OUTRO: 6 * n, TAB_I2D_VL_TITPUB_FED: 100 * n,
      TAB_I2F_VL_OPER_COMPROM: 10 * n, TAB_I2C5_VL_COTA_FIF: 50 * n,
      TAB_I1_VL_DISP: 25 * n, TAB_I4_VL_OUTRO_ATIVO: 30 * n,
      TAB_I3_VL_POSICAO_DERIV: 5 * n,
      TAB_I2A12_CPF_CNPJ_CEDENTE_1: "11111111111", TAB_I2A12_PR_CEDENTE_1: 14,
      TAB_I2B12_CPF_CNPJ_CEDENTE_1: "22222222222", TAB_I2B12_PR_CEDENTE_1: 22,
    };
    tables.I.push(makeRow(cnpj, month, fieldsI));
    tables.III.push(makeRow(cnpj, month, { TAB_III_VL_PASSIVO: 20 * n }));
    tables.IV.push(makeRow(cnpj, month, { TAB_IV_A_VL_PL: 3000 * n }));
    for (const [table, multiplier] of [["V", 1], ["VI", 2]]) {
      const values = { [`TAB_${table}_B_VL_DIRCRED_INAD`]: 12 * n * multiplier };
      suffixes.forEach((suffix, index) => {
        values[`TAB_${table}_A${index + 1}_VL_PRAZO_VENC_${suffix}`] = (index + 1) * n * multiplier;
        values[`TAB_${table}_B${index + 1}_VL_INAD_${suffix}`] = n * multiplier;
      });
      tables[table].push(makeRow(cnpj, month, values));
    }
    tables.VII.push(makeRow(cnpj, month, {
      TAB_VII_A1_2_VL_DIRCRED_RISCO: 200 * n, TAB_VII_A2_2_VL_DIRCRED_SEM_RISCO: 100 * n,
      TAB_VII_A1_1_QT_DIRCRED_RISCO: 8 * n, TAB_VII_A2_1_QT_DIRCRED_SEM_RISCO: 4 * n,
      TAB_VII_D_2_VL_RECOMPRA: 7 * n,
    }));
    for (const value of [80, 50, 20]) tables.VIII.push(makeRow(cnpj, month, { VALOR: value * n }));
    tables.IX.push(makeRow(cnpj, month, { TAB_IX_A1_1_2_COMPRA_MEDIA: 12, TAB_IX_B1_1_2_COMPRA_MEDIA: 18 }));
    for (const [label, quantity, price] of [["Sênior", 20, 100], ["Subordinada Mezanino", 5, 100], ["Subordinada Júnior", 5, 100]]) {
      tables.X_2.push(makeRow(cnpj, month, { TAB_X_CLASSE_SERIE: label, TAB_X_QT_COTA: quantity * n, TAB_X_VL_COTA: price }));
    }
    for (const [kind, total] of [["Captações no Mês", 100], ["Resgates no Mês", 20], ["Amortizações no Mês", 5], ["Resgates Solicitados", 10]]) {
      tables.X_4.push(makeRow(cnpj, month, { TAB_X_TP_OPER: kind, TAB_X_VL_TOTAL: total * n }));
    }
  }
  const zip = new JSZip();
  for (const [table, rows] of Object.entries(tables)) zip.file(`inf_mensal_fidc_tab_${table}_${month.replace("-", "")}.csv`, csv(rows));
  writeFileSync(resolve(FIXTURES, `synthetic_informe_${month.replace("-", "")}.zip`), await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
}

for (const [fundIndex, cnpj] of FUNDS.entries()) {
  const date = "31/01/2026";
  const line = (cells) => cells.join(",");
  const contents = [
    "CARTEIRA DIÁRIA SINTÉTICA", date,
    line(["Fundo", "", "", "", "", "", "", "", "", cnpj]),
    "CPR",
    line([date, "Taxa de administração", -10 * (fundIndex + 1), "", "", ""]),
    line([date, "Taxa de custódia", -2 * (fundIndex + 1), "", "", ""]),
    line([date, "Taxa de gestão", -4 * (fundIndex + 1), "", "", ""]),
    line([date, "Despesa não classificada", -3 * (fundIndex + 1), "", "", ""]),
    line([date, "Diferimento positivo", 1 * (fundIndex + 1), "", "", ""]),
  ].join("\r\n") + "\r\n";
  writeFileSync(resolve(FIXTURES, `synthetic_carteira_${cnpj}_202601.csv`), Buffer.from(contents, "latin1"));
}

const rows = loadReportRows();
if (rows.length !== 74) throw new Error(`Esperadas 74 linhas, encontradas ${rows.length}`);
const runs = await loadSyntheticRuns();
for (const month of MONTHS) for (const cnpj of FUNDS) {
  const result = runs[month][cnpj];
  const expected = { result, reportRows: projectReportRows(result, rows) };
  writeFileSync(resolve(FIXTURES, `synthetic_expected_${month.replace("-", "")}_${cnpj}.json`), JSON.stringify(expected, null, 2) + "\n");
}
