import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, FUNDS, MONTHS, loadReportRows } from "./support.ts";

describe("cobertura do contrato de 74 linhas", () => {
  it("cada linha tem identidade seção + indicador e consta em todas as quatro saídas esperadas", () => {
    const rows = loadReportRows();
    const ids = rows.map((row) => `${row.section} | ${row.label}`);
    expect(ids).toHaveLength(74);
    expect(new Set(ids).size).toBe(74);
    expect(rows.filter((row) => !row.key && !row.bucket)).toHaveLength(7);
    for (const month of MONTHS) for (const cnpj of FUNDS) {
      const expected = JSON.parse(readFileSync(resolve(FIXTURES, `synthetic_expected_${month.replace("-", "")}_${cnpj}.json`), "utf8"));
      expect(expected.reportRows.map((row: { id: string }) => row.id)).toEqual(ids);
      for (const [index, row] of rows.entries()) {
        const snapshot = expected.reportRows[index];
        if (row.key) {
          expect(snapshot.value).toBe(expected.result.metrics[row.key].value);
          expect(snapshot.status).toBe(expected.result.metrics[row.key].status);
          expect(snapshot.source).toBe(expected.result.metrics[row.key].source);
          expect(snapshot.note).toBe(expected.result.metrics[row.key].note ?? row.gap ?? null);
        } else if (!row.bucket) {
          expect(snapshot).toMatchObject({ value: null, status: "indisponivel", source: null, note: row.gap });
        }
      }
    }
  });
});
