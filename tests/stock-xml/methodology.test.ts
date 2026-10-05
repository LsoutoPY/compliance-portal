import { describe, expect, it } from "vitest";
import { calculateStockXmlMonthly, type StockXmlInputs, type StockReceivable } from "../../supabase/functions/_shared/liquidity-stock-xml";

const cnpj = "00000000000001";
const baseStock: StockReceivable[] = [
  { doc_fundo: cnpj, doc_sacado: "11", doc_cedente: "21", data_referencia: "2026-07-31", data_vencimento_ajustada: "2026-08-05", situacao_recebivel: "A vencer", tipo_recebivel: "Duplicata", valor_presente: 100, valor_pdd: 0, valor_aquisicao: 90, taxa_cessao: .12 },
  { doc_fundo: cnpj, doc_sacado: "11", doc_cedente: "22", data_referencia: "2026-07-31", data_vencimento_ajustada: "2026-08-31", situacao_recebivel: "A vencer", tipo_recebivel: "Duplicata", valor_presente: 200, valor_pdd: 10, valor_aquisicao: 190, taxa_cessao: .24 },
  { doc_fundo: cnpj, doc_sacado: "12", doc_cedente: "22", data_referencia: "2026-07-31", data_vencimento_ajustada: "2026-07-01", situacao_recebivel: "Vencido", tipo_recebivel: "Duplicata", valor_presente: 300, valor_pdd: 20, valor_aquisicao: 250, taxa_cessao: 4 },
];
function input(stock = baseStock): StockXmlInputs {
  return { cnpj, referenceDate: "2026-07-31", stockImport: { id: "synthetic-import", fileName: "synthetic_stock.csv", importedRows: stock.length },
    xmlFileName: "synthetic_position.xml", stock,
    xml: [
      { fundo_cnpj: cnpj, fundo_dtposicao: "20260731", section: "despesas", cnpjfundo: null, fundo_patliq: 1000, txadm: 8, saldo: null, valor_padrao: null },
      { fundo_cnpj: cnpj, fundo_dtposicao: "20260731", section: "caixa", cnpjfundo: null, fundo_patliq: 1000, txadm: null, saldo: -20, valor_padrao: -20 },
      { fundo_cnpj: cnpj, fundo_dtposicao: "20260731", section: "titpublico", cnpjfundo: null, fundo_patliq: 1000, txadm: null, saldo: null, valor_padrao: 30 },
      { fundo_cnpj: cnpj, fundo_dtposicao: "20260731", section: "cotas", cnpjfundo: cnpj, fundo_patliq: 1000, txadm: null, saldo: null, valor_padrao: 270 },
      { fundo_cnpj: cnpj, fundo_dtposicao: "20260731", section: "cotas", cnpjfundo: "00000000000002", fundo_patliq: 1000, txadm: null, saldo: null, valor_padrao: 50 },
    ] };
}

describe("synthetic_estoque_xml@2026.1", () => {
  it("separa patrimônio, taxa paga no XML, estoque, PDD e cotas próprias sem dupla contagem", () => {
    const result = calculateStockXmlMonthly(input());
    expect(result.metrics.pl.value).toBe(1000);
    expect(result.metrics.administrationExpense.value).toBe(8);
    expect(result.metrics.stockGross.value).toBe(600);
    expect(result.metrics.pdd.value).toBe(-30);
    expect(result.metrics.stockNet.value).toBe(570);
    expect(result.metrics.ownFundUnits.value).toBe(270);
    expect(result.metrics.otherFundUnits.value).toBe(50);
    expect(result.metrics.immediateAccounting.value).toBe(10);
  });

  it("usa situação e data para vencimentos, atraso e prazo individual", () => {
    const result = calculateStockXmlMonthly(input());
    expect(result.metrics.overdue.value).toBe(300);
    expect(result.metrics.due5.value).toBe(100);
    expect(result.metrics.due30.value).toBe(100);
    expect(result.metrics.due90.value).toBe(300);
    expect(result.metrics.overdue6to30.value).toBe(300);
    expect(result.metrics.averageMaturityCalendarDays.value).toBeCloseTo((100 * 5 + 200 * 31) / 300, 12);
    expect(result.metrics.immediatePlusDue30ToPl.value).toBe(.11);
  });

  it("consolida identificadores e filtra taxa acima de 300% a.a.", () => {
    const result = calculateStockXmlMonthly(input());
    expect(result.metrics.debtorTop1.value).toBe(.3);
    expect(result.metrics.debtorTop5.value).toBe(.6);
    expect(result.metrics.cedentTop1.value).toBe(.5);
    expect(result.metrics.cessionRateAnnual.value).toBeCloseTo((90 * .12 + 190 * .24) / 280, 12);
  });

  it("expõe divergência entre situação e data sem ocultar as faixas válidas", () => {
    const inconsistent = { ...baseStock[2], data_vencimento_ajustada: "2026-08-01" };
    const result = calculateStockXmlMonthly(input([...baseStock.slice(0, 2), inconsistent]));
    expect(result.metrics.overdue.value).toBe(300);
    expect(result.metrics.overdueByDate.value).toBe(0);
    expect(result.metrics.due30.value).toBe(100);
    expect(result.metrics.due30.note).toContain("divergência");
    expect(result.gaps.some((gap) => gap.includes("1 linha(s)"))).toBe(true);
  });

  it("mantém saídas, subordinação e cobertura indisponíveis", () => {
    const result = calculateStockXmlMonthly(input());
    for (const key of ["redemptions", "subordination", "coverageIndex"]) {
      expect(result.metrics[key]).toMatchObject({ value: null, status: "indisponivel" });
    }
  });

  it("rejeita mistura de fundo, data ou importação incompleta", () => {
    expect(() => calculateStockXmlMonthly({ ...input(), stockImport: { id: "x", fileName: "x", importedRows: 1 } })).toThrow("Número de linhas");
    expect(() => calculateStockXmlMonthly(input([{ ...baseStock[0], doc_fundo: "00000000000002" }]))).toThrow("Estoque contém outro fundo");
    expect(() => calculateStockXmlMonthly({ ...input(), xml: input().xml.map((row) => ({ ...row, fundo_dtposicao: "20260630" })) })).toThrow("XML contém outro fundo");
  });
});
