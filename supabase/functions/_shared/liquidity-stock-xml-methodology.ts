import type { LiquidityMethodology } from "./liquidity-methodology.ts";
import { calculateStockXmlMonthly, type StockXmlInputs, type StockXmlResult } from "./liquidity-stock-xml.ts";

export const stockXml2026_1: LiquidityMethodology<StockXmlInputs, undefined, StockXmlResult> = {
  id: "cvpar_fidc_estoque_xml",
  version: "2026.1",
  requiredInputs: ["estoque_recebiveis", "posicao_carteira_xml"],
  optionalInputs: [],
  appliesTo: (fund) => fund.type?.toUpperCase() === "FIDC" || [
    "23104485000169", "47425841000104", "51864349000102", "58426775000103",
  ].includes(fund.cnpj),
  validate: (inputs) => {
    const errors: string[] = [];
    if (!/^\d{14}$/.test(inputs.cnpj)) errors.push("CNPJ inválido.");
    if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(inputs.referenceDate)) errors.push("Data-base inválida.");
    if (!inputs.stock.length) errors.push("Estoque da data-base ausente.");
    if (!inputs.xml.length) errors.push("XML da data-base ausente.");
    return errors;
  },
  compute: (inputs) => calculateStockXmlMonthly(inputs),
  explain: (result) => Object.entries(result.metrics).map(([key, value]) =>
    `${key}: ${value.source}${value.note ? ` — ${value.note}` : ""}`),
  toCommonResult: (result) => ({
    methodologyId: "cvpar_fidc_estoque_xml",
    methodologyVersion: "2026.1",
    primaryIndicator: result.metrics.immediatePlusDue30ToPl.value,
    horizon: "30 dias de vencimento contratual",
    coverageIndex: null,
    status: result.metrics.immediatePlusDue30ToPl.status,
    calculationMemory: result.metrics,
    evidence: result.evidence,
    gaps: result.gaps,
  }),
};
