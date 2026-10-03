import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { groupCvmMonthlyZipEntries } from "../../supabase/functions/_shared/cvm-monthly-csv.ts";
import { parseCvparPositionCsv } from "../../supabase/functions/_shared/cvpar-position-csv.ts";
import { calculateMonthlyFidc, CVPAR_MONTHLY_2026 } from "../../supabase/functions/_shared/liquidity-monthly.ts";
import { fidcMensal2026_2, resolveLiquidityMethodology } from "../../supabase/functions/_shared/liquidity-methodology.ts";
import { FIXTURES, FUNDS, MONTHS } from "../l1/support.ts";

describe("L2 · encapsulamento sem mudança do motor", () => {
  it("registra a versão congelada e seus contratos de entrada", () => {
    expect(resolveLiquidityMethodology("cvpar_fidc_mensal", "2026.2")).toBe(fidcMensal2026_2);
    expect(resolveLiquidityMethodology("cvpar_fidc_mensal", "2026.1")).toBeNull();
    expect(fidcMensal2026_2.requiredInputs).toEqual(["informe_mensal_cvm"]);
    expect(fidcMensal2026_2.optionalInputs).toEqual(["carteira_diaria", "minimo_subordinacao"]);
    expect(fidcMensal2026_2.appliesTo({ cnpj: "51864349000102" })).toBe(true);
    expect(fidcMensal2026_2.appliesTo({ cnpj: "00000000000002" })).toBe(false);
  });

  for (const month of MONTHS) for (const cnpj of FUNDS) {
    it(`preserva exatamente ${cnpj} em ${month}`, async () => {
      const zip = await JSZip.loadAsync(readFileSync(resolve(FIXTURES, `synthetic_informe_${month.replace("-", "")}.zip`)));
      const grouped = await groupCvmMonthlyZipEntries(zip.files, month, new Set(FUNDS));
      const tables = grouped.tablesByCnpj[cnpj];
      const positionPath = resolve(FIXTURES, `synthetic_carteira_${cnpj}_${month.replace("-", "")}.csv`);
      let position = null;
      try { position = parseCvparPositionCsv(new TextDecoder("windows-1252").decode(readFileSync(positionPath)), positionPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const referenceMonth = `${month}-01`;
      const minimumSubordination = cnpj === FUNDS[0] ? 0.05 : null;
      const expected = calculateMonthlyFidc(tables, referenceMonth, cnpj, CVPAR_MONTHLY_2026, position, minimumSubordination);
      const actual = fidcMensal2026_2.compute({ tables, referenceMonth, cnpj, position, minimumSubordination }, CVPAR_MONTHLY_2026);
      expect(actual).toStrictEqual(expected);
      expect(fidcMensal2026_2.validate({ tables, referenceMonth, cnpj, position, minimumSubordination })).toEqual([]);
      expect(fidcMensal2026_2.toCommonResult(actual).calculationMemory).toBe(actual.metrics);
      expect(fidcMensal2026_2.toCommonResult(actual).coverageIndex).toBeNull();
    });
  }
});
