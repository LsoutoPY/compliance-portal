import type { MonthlyMetric } from "./liquidity-monthly.ts";

export const STOCK_XML_METHODOLOGY = "cvpar_fidc_estoque_xml@2026.1";

export interface StockReceivable {
  doc_fundo: string | null;
  doc_sacado: string | null;
  doc_cedente: string | null;
  data_referencia: string | null;
  data_vencimento_ajustada: string | null;
  situacao_recebivel: string | null;
  tipo_recebivel: string | null;
  valor_presente: number | null;
  valor_pdd: number | null;
  valor_aquisicao: number | null;
  taxa_cessao: number | null;
}

export interface XmlPositionLine {
  fundo_cnpj: string;
  fundo_dtposicao: string | null;
  section: string;
  cnpjfundo: string | null;
  fundo_patliq: number | null;
  txadm: number | null;
  saldo: number | null;
  valor_padrao: number | null;
}

export interface StockXmlInputs {
  cnpj: string;
  referenceDate: string;
  stockImport: { id: string; fileName: string; importedRows: number };
  xmlFileName: string;
  stock: StockReceivable[];
  xml: XmlPositionLine[];
}

export interface StockXmlResult {
  methodology: typeof STOCK_XML_METHODOLOGY;
  referenceMonth: string;
  cnpj: string;
  metrics: Record<string, MonthlyMetric>;
  maturity: Array<{ label: string; value: number }>;
  overdue: Array<{ label: string; value: number }>;
  gaps: string[];
  evidence: {
    tables: string[];
    positionDate: string;
    stockImportId: string;
    stockFileName: string;
    stockRows: number;
    xmlFileName: string;
    xmlRows: number;
  };
}

const MATURITY_LABELS = [
  "Até 30 dias", "31–60 dias", "61–90 dias", "91–120 dias", "121–150 dias",
  "151–180 dias", "181–360 dias", "361–720 dias", "721–1080 dias", ">1080 dias",
];

function cents(value: number): number { return Math.round((value + Number.EPSILON) * 100); }
function money(value: number): number { return Math.round(value) / 100; }
function numeric(value: number | null): number | null {
  return value !== null && Number.isFinite(Number(value)) ? Number(value) : null;
}
function digits(value: string | null): string { return (value ?? "").replace(/\D/g, ""); }
function metric(value: number | null, source: string, status: MonthlyMetric["status"] = "apurado", note?: string): MonthlyMetric {
  return { value, source, status: value === null ? "indisponivel" : status, ...(note ? { note } : {}) };
}
function ratio(numerator: number | null, denominator: number | null): number | null {
  return numerator !== null && denominator !== null && denominator !== 0 ? numerator / denominator : null;
}
function daysBetween(date: string, referenceDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  const reference = Date.parse(`${referenceDate}T00:00:00Z`);
  return Number.isFinite(parsed) && Number.isFinite(reference) ? Math.round((parsed - reference) / 86_400_000) : null;
}
function bucketIndex(days: number): number {
  if (days <= 30) return 0;
  if (days <= 60) return 1;
  if (days <= 90) return 2;
  if (days <= 120) return 3;
  if (days <= 150) return 4;
  if (days <= 180) return 5;
  if (days <= 360) return 6;
  if (days <= 720) return 7;
  if (days <= 1080) return 8;
  return 9;
}

/** Nova metodologia indicativa. O motor CVM 2026.2 permanece intocado. */
export function calculateStockXmlMonthly(input: StockXmlInputs): StockXmlResult {
  const cnpj = digits(input.cnpj);
  if (!/^\d{14}$/.test(cnpj) || !/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(input.referenceDate)) {
    throw new Error("CNPJ ou data-base inválidos.");
  }
  if (!input.stock.length || !input.xml.length) throw new Error("Estoque e XML da data-base são obrigatórios.");
  if (input.stock.length !== input.stockImport.importedRows) throw new Error("Número de linhas do estoque não confere com a importação.");
  if (input.stock.some((row) => digits(row.doc_fundo) !== cnpj || row.data_referencia !== input.referenceDate)) {
    throw new Error("Estoque contém outro fundo ou data-base.");
  }
  const xmlDate = input.referenceDate.replace(/-/g, "");
  if (input.xml.some((row) => digits(row.fundo_cnpj) !== cnpj || row.fundo_dtposicao !== xmlDate)) {
    throw new Error("XML contém outro fundo ou data-base.");
  }

  const gaps: string[] = [];
  const plValues = [...new Set(input.xml.map((row) => numeric(row.fundo_patliq)).filter((value): value is number => value !== null))];
  const pl = plValues.length === 1 && plValues[0] > 0 ? money(cents(plValues[0])) : null;
  if (pl === null) gaps.push("PL do cabeçalho XML ausente ou divergente entre linhas.");
  const adminRows = input.xml.filter((row) => row.section === "despesas");
  const administrationRaw = adminRows.length === 1 ? numeric(adminRows[0].txadm) : null;
  const administration = administrationRaw === null ? null : money(cents(administrationRaw));
  if (administration === null) gaps.push("XML sem uma única linha de despesas com txadm.");

  const xmlSum = (section: string, field: "saldo" | "valor_padrao", predicate: (row: XmlPositionLine) => boolean = () => true) => {
    const rows = input.xml.filter((row) => row.section === section && predicate(row));
    return rows.length && rows.every((row) => numeric(row[field]) !== null)
      ? money(rows.reduce((sum, row) => sum + cents(Number(row[field])), 0)) : null;
  };
  const cash = xmlSum("caixa", "saldo");
  const publicBonds = xmlSum("titpublico", "valor_padrao");
  const privateBonds = xmlSum("titprivado", "valor_padrao");
  const ownFundUnits = xmlSum("cotas", "valor_padrao", (row) => digits(row.cnpjfundo) === cnpj);
  const otherFundUnits = xmlSum("cotas", "valor_padrao", (row) => digits(row.cnpjfundo) !== cnpj && !!digits(row.cnpjfundo));
  if (cash !== null && cash < 0) gaps.push("Caixa líquido do XML é negativo; manter o sinal contábil e conferir contas/compromissos antes de tratá-lo como disponibilidade.");
  if (input.xml.some((row) => row.section === "cotas" && !digits(row.cnpjfundo))) gaps.push("XML contém cota sem CNPJ do fundo investido; classificação de cotas incompleta.");

  let grossCents = 0, pddCents = 0, overdueCents = 0, overdueDateCents = 0;
  let due5Cents = 0, due6to30Cents = 0, overdue5Cents = 0, overdue6to30Cents = 0;
  let maturityWeight = 0, maturityBase = 0, cessionWeight = 0, cessionBase = 0;
  let missingDueDate = 0, statusDateMismatch = 0, missingCounterparty = 0, invalidPdd = 0;
  const maturityCents = Array<number>(10).fill(0);
  const overdueBucketCents = Array<number>(10).fill(0);
  const debtor = new Map<string, number>();
  const cedent = new Map<string, number>();
  for (const row of input.stock) {
    const present = numeric(row.valor_presente);
    if (present === null || present < 0) throw new Error("Estoque contém valor presente ausente ou negativo.");
    const amount = cents(present);
    grossCents += amount;
    const pdd = numeric(row.valor_pdd);
    if (pdd === null || pdd < 0) invalidPdd++;
    else pddCents += cents(pdd);
    const debtorId = digits(row.doc_sacado), cedentId = digits(row.doc_cedente);
    if (!debtorId || !cedentId) missingCounterparty++;
    if (debtorId) debtor.set(debtorId, (debtor.get(debtorId) ?? 0) + amount);
    if (cedentId) cedent.set(cedentId, (cedent.get(cedentId) ?? 0) + amount);
    const days = row.data_vencimento_ajustada ? daysBetween(row.data_vencimento_ajustada, input.referenceDate) : null;
    if (days === null) missingDueDate++;
    const status = (row.situacao_recebivel ?? "").trim().toLocaleLowerCase("pt-BR");
    const isOverdue = status === "vencido";
    const isPerforming = status === "a vencer";
    if (!isOverdue && !isPerforming) throw new Error(`Situação de recebível desconhecida: ${row.situacao_recebivel ?? "n/d"}.`);
    if (days !== null && ((isOverdue && days >= 0) || (isPerforming && days < 0))) statusDateMismatch++;
    if (isOverdue) {
      overdueCents += amount;
      if (days !== null && days < 0) {
        const age = -days;
        overdueDateCents += amount;
        overdueBucketCents[bucketIndex(age)] += amount;
        if (age <= 5) overdue5Cents += amount;
        else if (age <= 30) overdue6to30Cents += amount;
      }
    } else if (days !== null && days >= 0) {
      maturityCents[bucketIndex(days)] += amount;
      if (days <= 5) due5Cents += amount;
      else if (days <= 30) due6to30Cents += amount;
      maturityWeight += amount * days;
      maturityBase += amount;
    }
    const rate = numeric(row.taxa_cessao), acquisition = numeric(row.valor_aquisicao);
    if (rate !== null && rate > 0 && rate <= 3 && acquisition !== null && acquisition > 0) {
      const weight = cents(acquisition);
      cessionWeight += rate * weight;
      cessionBase += weight;
    }
  }
  if (invalidPdd) gaps.push(`${invalidPdd} linha(s) com PDD ausente/negativa; PDD total indisponível.`);
  if (missingDueDate) gaps.push(`${missingDueDate} linha(s) sem vencimento ajustado; faixas e prazo médio são parciais.`);
  if (statusDateMismatch) gaps.push(`${statusDateMismatch} linha(s) com divergência entre situação e data; ficam fora das faixas de vencimento/atraso, mas entram no total por situação.`);
  if (missingCounterparty) gaps.push(`${missingCounterparty} linha(s) sem sacado ou cedente; concentração pode estar subestimada.`);
  const gross = money(grossCents);
  const pdd = invalidPdd ? null : -money(pddCents);
  const net = pdd === null ? null : money(grossCents - pddCents);
  const overdue = money(overdueCents);
  const due30 = money(maturityCents[0]);
  const due90 = money(maturityCents.slice(0, 3).reduce((sum, value) => sum + value, 0));
  const averageMaturity = maturityBase > 0 ? maturityWeight / maturityBase : null;
  const annualRate = cessionBase > 0 ? cessionWeight / cessionBase : null;
  const bucketNote = missingDueDate || statusDateMismatch
    ? `${missingDueDate} sem vencimento; ${statusDateMismatch} com divergência situação/data. Valores de faixas são parciais e seguem a situação do estoque.`
    : undefined;
  const concentration = (group: Map<string, number>, top: number): number | null => {
    if (missingCounterparty || pl === null || !group.size) return null;
    return ratio(money([...group.values()].sort((a, b) => b - a).slice(0, top).reduce((sum, value) => sum + value, 0)), pl);
  };
  const immediateAccounting = cash !== null && publicBonds !== null ? money(cents(cash) + cents(publicBonds)) : null;
  const metrics: Record<string, MonthlyMetric> = {
    pl: metric(pl, "XML · fundo_patliq"),
    administrationExpense: metric(administration, "XML · despesas.txadm", "apurado", "Despesa de administração informada no XML para o mês, em regime de caixa; não é taxa percentual."),
    stockGross: metric(gross, "Estoque · soma de valor_presente", "apurado", "Universo bruto do arquivo, não valor contábil reconciliado de DC."),
    pdd: metric(pdd, "Estoque · −soma de valor_pdd"),
    stockNet: metric(net, "Estoque · valor_presente − valor_pdd", "aproximado", "Não equivale necessariamente à posição contábil do XML."),
    overdue: metric(overdue, "Estoque · situacao_recebivel = Vencido", "apurado", "A situação do arquivo prevalece sobre a data quando há divergência."),
    overdueByDate: metric(money(overdueDateCents), "Estoque · Vencido com data anterior à posição", "apurado"),
    performing: metric(money(grossCents - overdueCents), "Estoque · situacao_recebivel = A vencer"),
    due5: metric(money(due5Cents), "Estoque · A vencer em 0–5 dias", "aproximado", `Vencimento contratual, não caixa efetivo.${bucketNote ? ` ${bucketNote}` : ""}`),
    due6to30: metric(money(due6to30Cents), "Estoque · A vencer em 6–30 dias", "aproximado", `Vencimento contratual, não caixa efetivo.${bucketNote ? ` ${bucketNote}` : ""}`),
    due30: metric(due30, "Estoque · A vencer em até 30 dias", "aproximado", `Inclui títulos com vencimento na data-base.${bucketNote ? ` ${bucketNote}` : ""}`),
    due90: metric(due90, "Estoque · A vencer em até 90 dias", "aproximado", bucketNote),
    overdue5: metric(money(overdue5Cents), "Estoque · Vencido há até 5 dias", "aproximado", bucketNote),
    overdue6to30: metric(money(overdue6to30Cents), "Estoque · Vencido há 6–30 dias", "aproximado", bucketNote),
    overdue90: metric(money(overdueBucketCents.slice(3).reduce((sum, value) => sum + value, 0)), "Estoque · atraso > 90 dias", "aproximado", bucketNote),
    overdue120: metric(money(overdueBucketCents.slice(4).reduce((sum, value) => sum + value, 0)), "Estoque · atraso > 120 dias", "aproximado", bucketNote),
    averageMaturityCalendarDays: metric(averageMaturity, "Estoque · prazo individual ponderado por valor_presente", "aproximado", `Somente títulos A vencer; data ajustada; não usa fluxo de amortização.${bucketNote ? ` ${bucketNote}` : ""}`),
    averageMaturityBusinessDays: metric(averageMaturity === null ? null : averageMaturity * 252 / 365, "Derivado · dias corridos × 252/365", "aproximado", "Conversão convencional, sem calendário de feriados."),
    cessionRateAnnual: metric(annualRate, "Estoque · taxa_cessao ponderada por valor_aquisicao", "aproximado", "Taxa no arquivo em fração a.a.; só pesos positivos e taxas em (0;300%]."),
    cessionRateMonthly: metric(annualRate === null ? null : Math.pow(1 + annualRate, 1 / 12) - 1, "Derivado · (1 + taxa a.a.)^(1/12) − 1", "aproximado"),
    cash: metric(cash, "XML · soma de caixa.saldo", "apurado", "Saldo líquido contábil, inclusive valores negativos."),
    publicBonds: metric(publicBonds, "XML · soma de titpublico.valor_padrao", "apurado", "Posição contábil; prazo de negociação não verificado."),
    privateBonds: metric(privateBonds, "XML · soma de titprivado.valor_padrao", "apurado", "Pode sobrepor parte do estoque; não somar sem conciliação."),
    ownFundUnits: metric(ownFundUnits, "XML · cotas com cnpjfundo igual ao fundo", "apurado", "A posição se aproxima do estoque a vencer; é evidência de conciliação, não ativo adicional."),
    otherFundUnits: metric(otherFundUnits, "XML · cotas de outros CNPJs", "apurado", "Prazo de resgate e liquidez não verificados."),
    immediateAccounting: metric(immediateAccounting, "Derivado · caixa líquido + títulos públicos", "aproximado", "Saldo contábil assinado, não caixa imediatamente realizável."),
    stockGrossToPl: metric(ratio(gross, pl), "Derivado · estoque bruto / PL", "aproximado", "O estoque pode superar o PL; razão não mede cobertura."),
    pddToPl: metric(ratio(pdd, pl), "Derivado · PDD / PL", "aproximado"),
    overdueToStock: metric(ratio(overdue, gross), "Derivado · vencidos / estoque bruto", "aproximado"),
    immediatePlusDue30ToPl: metric(due30 === null || immediateAccounting === null ? null : ratio(immediateAccounting + due30, pl), "Derivado · (caixa + títulos públicos + vencimentos até 30 dias) / PL", "aproximado", "Indicador contratual, não cobertura de resgates nem caixa projetado."),
    ownUnitsVsStockNet: metric(ownFundUnits === null || net === null ? null : money(cents(ownFundUnits) - cents(net)), "Conciliação · cotas do próprio CNPJ no XML − estoque líquido", "aproximado", "Diferença requer validação de critérios contábeis e perímetro."),
  };
  for (const [name, group] of [["debtor", debtor], ["cedent", cedent]] as const) {
    for (const count of [1, 5, 10, 15]) {
      metrics[`${name}Top${count}`] = metric(concentration(group, count), `Estoque · Top ${count} ${name === "debtor" ? "sacados" : "cedentes"} por documento / PL`, "aproximado", "Consolidação por CPF/CNPJ do arquivo; inclui títulos vencidos.");
    }
  }
  for (const [key, explanation] of Object.entries({
    inflow: "Captações do mês", redemptions: "Resgates/amortizações do mês", netFlows: "Fluxo líquido do mês",
    subordination: "Cotas por classe e índice de subordinação", subordinationMinimum: "Mínimo regulatório vigente",
    subordinationHeadroom: "Folga sobre o mínimo", coverageIndex: "Cobertura de passivo e resgates",
    custodyExpense: "Despesa de custódia por natureza", managementExpense: "Despesa de gestão por natureza",
    repurchases: "Recompras e títulos liquidados",
  })) metrics[key] = metric(null, "Estoque + XML", "indisponivel", `${explanation} não identificável com segurança nessas duas fontes.`);
  gaps.push("Captações, saídas, amortizações, recompras, passivo de cotistas, subordinação por classe e mínimo regulamentar exigem outras fontes ou mapeamento validado.");
  gaps.push("Vencimento contratual de recebíveis não equivale a entrada de caixa; índice de cobertura de resgates permanece indisponível.");
  gaps.push("Importação do estoque não registra hash do arquivo original; evidência usa ID/arquivo e hash dos dados normalizados na execução.");
  return {
    methodology: STOCK_XML_METHODOLOGY,
    referenceMonth: `${input.referenceDate.slice(0, 7)}-01`,
    cnpj,
    metrics,
    maturity: MATURITY_LABELS.map((label, index) => ({ label, value: money(maturityCents[index]) })),
    overdue: MATURITY_LABELS.map((label, index) => ({ label, value: money(overdueBucketCents[index]) })),
    gaps,
    evidence: { tables: ["estoque_fidc", "posicao_carteira"], positionDate: input.referenceDate,
      stockImportId: input.stockImport.id, stockFileName: input.stockImport.fileName, stockRows: input.stock.length,
      xmlFileName: input.xmlFileName, xmlRows: input.xml.length },
  };
}
