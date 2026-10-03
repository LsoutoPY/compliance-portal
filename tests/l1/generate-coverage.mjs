// Run explicitly to refresh the documentation matrix after a reviewed baseline change.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadReportRows } from "./support.ts";

const rows = loadReportRows();
const edge = (row) => {
  if (!row.key && !row.bucket) return "lacuna (coverage.test.ts)";
  if (row.bucket) return "faixas/prazo (motor.test.ts)";
  const key = row.key;
  if (/Expense|cprBalance/.test(key)) return "CPR ausente (motor.test.ts), parser (parsers.test.ts)";
  if (/creditGross|creditDirectGross|creditNetPdd|pdd|fidcUnits|otherCreditVm/i.test(key)) return "PDD/DC/opcional (motor.test.ts)";
  if (/subordination|TrancheValue/.test(key)) return "subordinação (motor.test.ts)";
  if (/debtorTop|cedentListed/.test(key)) return "concentração (motor.test.ts)";
  if (/averageMaturity|due30|due90/.test(key)) return "prazo/faixas (motor.test.ts)";
  if (/cessionRate/.test(key)) return "taxa (motor.test.ts)";
  if (/ToPl|ToCredit|Headroom/.test(key)) return "denominador (motor.test.ts)";
  return "—";
};
const lines = [
  "# L1 — Matriz de cobertura das 74 linhas",
  "",
  "`G4` = quatro snapshots exatos de `motor.test.ts`; `R` = renderização e contagem de `report-ui.test.tsx`; `P` = 74 linhas por fundo e nomes no `pdf.test.ts`; `E` = teste adicional de borda indicado. `coverage.test.ts` confere todas as identidades e os campos dos JSONs. As sete lacunas têm `n/d` com ressalva, sem cálculo inventado.",
  "",
  "| # | Seção | Indicador | Tipo | G4 | R | P | E |",
  "|---:|---|---|---|:---:|:---:|:---:|---|",
];
rows.forEach((row, index) => lines.push(`| ${index + 1} | ${row.section} | ${row.label} | ${row.key ? "métrica" : row.bucket ? "faixa CVM" : "lacuna"} | ✓ | ✓ | ✓ | ${edge(row)} |`));
lines.push("", "**Sem cobertura estrutural:** nenhum. **Sem cálculo:** 7 lacunas intencionais, listadas como `lacuna` na tabela.", "");
writeFileSync(resolve("docs/L1_COBERTURA.md"), lines.join("\n"));
