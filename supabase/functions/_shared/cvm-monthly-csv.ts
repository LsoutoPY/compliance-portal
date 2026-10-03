import type { CvmRow, CvmTables } from "./liquidity-monthly.ts";

type ZipEntry = { async(type: "uint8array"): Promise<Uint8Array> };

const TABLE_NAMES: Record<string, string> = {
  I: "tab_I", II: "tab_II", III: "tab_III", IV: "tab_IV", V: "tab_V",
  VI: "tab_VI", VII: "tab_VII", VIII: "tab_VIII", IX: "tab_IX", X: "tab_X",
  X_1: "tab_X_1", X_1_1: "tab_X_1_1", X_2: "tab_X_2", X_3: "tab_X_3",
  X_4: "tab_X_4", X_5: "tab_X_5", X_6: "tab_X_6", X_7: "tab_X_7",
};

export function normalizeCnpj(value: string | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 14 ? digits : null;
}

function parseRows(text: string, onRow: (row: Record<string, string>) => void): void {
  let headers: string[] | null = null;
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  const finishRow = () => {
    cells.push(cell);
    cell = "";
    if (cells.length === 1 && !cells[0]) { cells = []; return; }
    if (!headers) {
      headers = cells.map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, "") : value).trim());
    } else {
      if (cells.length !== headers.length) throw new Error("CSV mensal CVM com número de colunas inconsistente.");
      const row: Record<string, string> = {};
      headers.forEach((header, index) => { row[header] = cells[index]; });
      onRow(row);
    }
    cells = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (char === ";" && !quoted) {
      cells.push(cell);
      cell = "";
    } else if ((char === "\r" || char === "\n") && !quoted) {
      finishRow();
      if (char === "\r" && text[index + 1] === "\n") index++;
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("CSV mensal CVM com aspas não fechadas.");
  if (cell || cells.length) finishRow();
}

export async function groupCvmMonthlyZipEntries(
  entries: Record<string, ZipEntry>,
  competencia: string,
  monitoredCnpjs: ReadonlySet<string>,
): Promise<{ tablesByCnpj: Record<string, CvmTables>; rowsSeen: number; filesSeen: number }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia)) throw new Error("Competência deve ser AAAA-MM.");
  const yyyymm = competencia.replace("-", "");
  const tablesByCnpj: Record<string, CvmTables> = {};
  let rowsSeen = 0;
  let filesSeen = 0;
  const seenTables = new Set<string>();
  for (const [filename, entry] of Object.entries(entries)) {
    if (!filename.toLowerCase().endsWith(".csv")) continue;
    const basename = filename.replace(/\\/g, "/").split("/").pop() ?? "";
    const match = basename.match(/^inf_mensal_fidc_tab_(.+)_(\d{6})\.csv$/i);
    if (!match) continue;
    const table = TABLE_NAMES[match[1].toUpperCase()];
    if (!table) continue;
    if (match[2] !== yyyymm) throw new Error(`Arquivo de competência incompatível no ZIP: ${filename}`);
    if (seenTables.has(table)) throw new Error(`Tabela ${table} duplicada no ZIP mensal.`);
    seenTables.add(table);
    filesSeen++;
    const text = new TextDecoder("iso-8859-1").decode(await entry.async("uint8array"));
    parseRows(text, (row) => {
      if (row.DT_COMPTC && !row.DT_COMPTC.startsWith(competencia)) {
        throw new Error(`DT_COMPTC incompatível no arquivo ${filename}.`);
      }
      rowsSeen++;
      const cnpj = normalizeCnpj(row.CNPJ_FUNDO_CLASSE || row.CNPJ_CLASSE || row.CNPJ_FUNDO);
      if (!cnpj || !monitoredCnpjs.has(cnpj)) return;
      const tables = tablesByCnpj[cnpj] ?? {};
      (tables[table] ??= []).push(row as CvmRow);
      tablesByCnpj[cnpj] = tables;
    });
  }
  if (!filesSeen) throw new Error("ZIP sem tabelas do informe mensal FIDC da competência informada.");
  return { tablesByCnpj, rowsSeen, filesSeen };
}
