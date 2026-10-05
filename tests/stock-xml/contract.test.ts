import { expect, it } from "vitest";
import { stockXml2026_1 } from "../../supabase/functions/_shared/liquidity-stock-xml-methodology";

it("declara contratos próprios e mantém cobertura de passivo indisponível", () => {
  expect(stockXml2026_1.requiredInputs).toEqual(["estoque_recebiveis", "posicao_carteira_xml"]);
  expect(stockXml2026_1.optionalInputs).toEqual([]);
  expect(stockXml2026_1.appliesTo({ cnpj: "23104485000169" })).toBe(true);
  expect(stockXml2026_1.appliesTo({ cnpj: "00000000000000", type: "FIM" })).toBe(false);
});
