import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import JSZip from "jszip";
import { groupCvmMonthlyZipEntries } from "../../supabase/functions/_shared/cvm-monthly-csv.ts";
import { calculateMonthlyFidc, CVPAR_MONTHLY_2026, type MonthlyResult, type PositionEvidence } from "../../supabase/functions/_shared/liquidity-monthly.ts";
import { parseCvparPositionCsv } from "../../supabase/functions/_shared/cvpar-position-csv.ts";

export const FUNDS = ["00000000000001", "00000000000002"] as const;
export const MONTHS = ["2026-01", "2026-02"] as const;
export const FIXTURES = resolve("tests/fixtures");

export type ReportRow = {
  section: string;
  label: string;
  key?: string;
  bucket?: { type: "maturityCvm" | "overdueCvm"; index: number };
  unit?: "percent" | "days" | "count";
  gap?: string;
};

// Evaluate only the existing row declaration, without exporting or changing production code.
export function loadReportRows(): ReportRow[] {
  const file = readFileSync(resolve("src/pages/liquidez/LiquidezMensalArtefato.tsx"), "utf8");
  const source = ts.createSourceFile("report.tsx", file, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | undefined;
  source.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === "rows") initializer = declaration.initializer;
    }
  });
  if (!initializer) throw new Error("Declaração rows não encontrada na página FIDC mensal.");
  const text = `const rows = ${initializer.getText(source)}; rows;`;
  const javascript = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
  return vm.runInNewContext(javascript, {}) as ReportRow[];
}

export function projectReportRows(result: MonthlyResult, rows: ReportRow[]) {
  return rows.map((row) => {
    const metric = row.key ? result.metrics[row.key] : undefined;
    const bucket = row.bucket ? result[row.bucket.type]?.[row.bucket.index] : undefined;
    return {
      id: `${row.section} | ${row.label}`,
      value: metric?.value ?? bucket?.value ?? null,
      status: metric?.status ?? (row.bucket ? "aproximado" : "indisponivel"),
      source: metric?.source ?? (row.bucket ? `CVM · TAB_V/VI_${row.bucket.type === "maturityCvm" ? "A" : "B"}${row.bucket.index + 1}` : null),
      note: metric?.note ?? (row.bucket ? row.bucket.type === "maturityCvm" ? "Vencimento contratual, não caixa projetado." : "Faixa agregada do informe." : row.gap ?? null),
    };
  });
}

export async function loadSyntheticRuns(): Promise<Record<string, Record<string, MonthlyResult>>> {
  const runs: Record<string, Record<string, MonthlyResult>> = {};
  for (const month of MONTHS) {
    const bytes = readFileSync(resolve(FIXTURES, `synthetic_informe_${month.replace("-", "")}.zip`));
    const zip = await JSZip.loadAsync(bytes);
    const grouped = await groupCvmMonthlyZipEntries(zip.files, month, new Set(FUNDS));
    runs[month] = {};
    for (const cnpj of FUNDS) {
      const positionFile = resolve(FIXTURES, `synthetic_carteira_${cnpj}_${month.replace("-", "")}.csv`);
      let position: PositionEvidence | null = null;
      try {
        const positionBytes = readFileSync(positionFile);
        position = parseCvparPositionCsv(new TextDecoder("windows-1252").decode(positionBytes), positionFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      runs[month][cnpj] = calculateMonthlyFidc(grouped.tablesByCnpj[cnpj], `${month}-01`, cnpj, CVPAR_MONTHLY_2026, position, cnpj === FUNDS[0] ? 0.05 : null);
    }
  }
  return runs;
}
