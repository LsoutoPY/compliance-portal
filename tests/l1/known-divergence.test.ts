import { describe, expect, it } from "vitest";
import preview from "../../src/data/liquidityCvmPreview2026.json";

const funds = Object.fromEntries(preview.funds.map((fund) => [fund.shortName, fund.cnpj]));
const metric = (month: string, fund: string, key: string) => (preview.runs as any)[month][funds[fund]].metrics[key].value as number;

// Fonte: docs/VALIDACAO_LIQUIDEZ_CVPAR_2026.md, confronto de 23/09/2026.
// Estes checks preservam a prévia existente; os ZIPs originais e o Excel não estão em tests/fixtures.
// Portanto não representam recálculo independente nem aprovação financeira.
describe("known-divergence · prévia anterior versus planilha de Compliance", () => {
  it("saídas EDUC e NC em junho permanecem zero na prévia", () => {
    expect(metric("2026-06", "CVPAR EDUC", "redemptions")).toBe(0); // Excel: -454,26
    expect(metric("2026-06", "CVPAR NC", "redemptions")).toBe(0); // Excel: -246,06
  });
  it("vencidos CVPAR II em junho preservam diferença de 727.901,91", () => {
    expect(metric("2026-06", "CVPAR II", "overdue")).toBe(5_270_447.80); // Excel: 5.998.349,71
  });
  it("vencidos EDUC em julho preservam diferença de bases", () => {
    expect(metric("2026-07", "CVPAR EDUC", "overdue")).toBe(89_254.25); // Excel C44: 174.063,04
  });
  it("captações e saídas CVPAR I em julho permanecem nos valores da prévia", () => {
    expect(metric("2026-07", "CVPAR I", "inflow")).toBe(2_200_000); // Excel: 1.100.000,00
    expect(metric("2026-07", "CVPAR I", "redemptions")).toBe(-7_033_798.79); // Excel: -7.029.634,62
  });
  it("DC bruto e CPR CVPAR II preservam o desvio de R$ 447,15", () => {
    expect(metric("2026-07", "CVPAR II", "creditGross")).toBe(190_146_105.49); // Excel: 190.145.658,34
    expect(Number(metric("2026-07", "CVPAR II", "cprCvm").toFixed(2))).toBe(-780_739.44); // Excel: -780.292,29
  });
});
