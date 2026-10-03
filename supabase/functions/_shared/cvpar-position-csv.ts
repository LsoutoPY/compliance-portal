import type { PositionEvidence } from "./liquidity-monthly.ts";

function parseLine(line: string): string[] {
  const columns: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      columns.push(value.trim());
      value = "";
    } else value += char;
  }
  columns.push(value.trim());
  return columns;
}

function amount(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCnpj(value: string | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

export function parseCvparPositionCsv(text: string, fileName: string): PositionEvidence {
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean).map(parseLine);
  const dateMatch = rows[1]?.[0]?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!dateMatch) throw new Error("Carteira diária sem data de posição reconhecida.");
  const referenceDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
  const cnpj = rows.map((row) => normalizeCnpj(row[9] || row[26] || row[16])).find((value) => value.length === 14);
  if (!cnpj) throw new Error("Carteira diária sem CNPJ do fundo reconhecido.");
  let section = "";
  let instrument = "";
  let administration: number | null = null;
  let custody: number | null = null;
  let management: number | null = null;
  let otherNegative = 0;
  let cprBalance = 0;
  let cprRows = 0;
  let cash: number | null = null;
  let publicBonds = 0;
  let publicRows = 0;
  let fundUnits = 0;
  let fundRows = 0;
  for (const row of rows) {
    const marker = row[0]?.toLowerCase() ?? "";
    if (marker === "cpr" || marker === "outrosfundos" || marker === "rf" || marker === "tesouraria") {
      section = marker;
      instrument = "";
      continue;
    }
    if (marker === "totais:") {
      if (section === "rf") instrument = "";
      else section = "";
      continue;
    }
    if (section === "rf" && marker === "ntn-b") { instrument = "public"; continue; }
    if (section === "rf" && marker && !/^c\d/i.test(row[0] ?? "") && marker !== "código") {
      instrument = "";
      continue;
    }
    if (section === "cpr" && row[0] === `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}`) {
      const value = amount(row[2]);
      if (value === null) continue;
      cprBalance += value;
      cprRows++;
      const description = `${row[1] ?? ""} ${row[5] ?? ""}`.toLowerCase();
      if (description.includes("administra")) administration = (administration ?? 0) + value;
      else if (description.includes("custódia") || description.includes("custodia")) custody = (custody ?? 0) + value;
      else if (description.includes("gestão") || description.includes("gestao")) management = (management ?? 0) + value;
      else if (value < 0) otherNegative += value;
    }
    if (section === "tesouraria" && marker === `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}`) {
      const value = amount(row[2]);
      if (value !== null) cash = (cash ?? 0) + value;
    }
    if (section === "outrosfundos" && /^\w/.test(row[0] ?? "") && row[1] === `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}`) {
      const value = amount(row[8]);
      if (value !== null) { fundUnits += value; fundRows++; }
    }
    if (section === "rf" && instrument === "public" && /^c\d/i.test(row[0] ?? "")) {
      const value = amount(row[16]);
      if (value !== null) { publicBonds += value; publicRows++; }
    }
  }
  return {
    referenceDate,
    cnpj,
    fileName,
    expenses: {
      administration,
      custody,
      management,
      otherNegative: cprRows ? otherNegative : null,
      cprBalance: cprRows ? cprBalance : null,
    },
    cash,
    publicBonds: publicRows ? publicBonds : null,
    fundUnits: fundRows ? fundUnits : null,
  };
}
