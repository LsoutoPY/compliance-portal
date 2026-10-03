// Cálculo mensal a partir de fatos CVM. Não recebe células da planilha de Compliance.
export type CvmRow = Record<string, string | number | null | undefined>;
export type CvmTables = Record<string, CvmRow[]>;

export interface MonthlyMethodology {
  code: string;
  version: string;
  creditExtraFields: string[];
  grossUpPdd: boolean;
  includeMezzanineInSubordination: boolean;
}

export interface PositionEvidence {
  referenceDate: string;
  cnpj: string;
  fileName: string;
  expenses: {
    administration: number | null;
    custody: number | null;
    management: number | null;
    otherNegative: number | null;
    cprBalance: number | null;
  };
  cash: number | null;
  publicBonds: number | null;
  fundUnits: number | null;
}

export type MetricStatus = "apurado" | "aproximado" | "indisponivel";
export interface MonthlyMetric {
  value: number | null;
  status: MetricStatus;
  source: string;
  note?: string;
}

export interface MonthlyResult {
  methodology: string;
  referenceMonth: string;
  cnpj: string;
  metrics: Record<string, MonthlyMetric>;
  maturityCvm: Array<{ label: string; value: number | null }>;
  overdueCvm?: Array<{ label: string; value: number | null }>;
  gaps: string[];
  evidence: { tables: string[]; positionDate: string | null };
}

export const CVPAR_MONTHLY_2026: MonthlyMethodology = {
  code: "cvpar_fidc_mensal",
  version: "2026.2",
  creditExtraFields: [
    "TAB_I2H_VL_COTA_FIDC", "TAB_I2I_VL_COTA_FIDC_NP",
    "TAB_I2C1_VL_DEBENTURE", "TAB_I2C2_VL_CRI", "TAB_I2C3_VL_NP_COMERC",
    "TAB_I2C4_VL_LETRA_FINANC", "TAB_I2C6_VL_OUTRO",
  ],
  grossUpPdd: true,
  includeMezzanineInSubordination: true,
};

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).trim().replace(/\s/g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function first(tables: CvmTables, table: string): CvmRow | null {
  return tables[table]?.[0] ?? null;
}

function field(row: CvmRow | null, key: string): number | null {
  return row ? numeric(row[key]) : null;
}

function optionalField(row: CvmRow | null, key: string): number | null {
  return row && key in row ? numeric(row[key]) ?? 0 : null;
}

function sumKnown(values: Array<number | null>): number | null {
  return values.every((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
}

function m(value: number | null, source: string, status: MetricStatus = "apurado", note?: string): MonthlyMetric {
  return { value, source, status: value === null ? "indisponivel" : status, ...(note ? { note } : {}) };
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  return numerator !== null && denominator !== null && denominator !== 0
    ? numerator / denominator
    : null;
}

export function calculateMonthlyFidc(
  tables: CvmTables,
  referenceMonth: string,
  cnpj: string,
  methodology: MonthlyMethodology,
  position: PositionEvidence | null = null,
  minimumSubordination: number | string | null = null,
): MonthlyResult {
  const tabI = first(tables, "tab_I");
  const tabIV = first(tables, "tab_IV");
  const tabV = first(tables, "tab_V");
  const tabVI = first(tables, "tab_VI");
  const tabIII = first(tables, "tab_III");
  const tabVII = first(tables, "tab_VII");
  const tabIX = first(tables, "tab_IX");
  const expanded = methodology.version !== "2026.1";
  const pl = field(tabIV, "TAB_IV_A_VL_PL");
  const pddRisk = field(tabI, "TAB_I2A11_VL_REDUCAO_RECUP");
  const pddWithoutRisk = field(tabI, "TAB_I2B11_VL_REDUCAO_RECUP");
  const pddTotal = sumKnown([pddRisk, pddWithoutRisk]);
  const pdd = pddTotal === null ? null : -pddTotal;
  const creditBase = tabI
    ? sumKnown([
        field(tabI, "TAB_I2A_VL_DIRCRED_RISCO"),
        field(tabI, "TAB_I2B_VL_DIRCRED_SEM_RISCO"),
        ...methodology.creditExtraFields.map((key) => expanded ? optionalField(tabI, key) : field(tabI, key)),
      ])
    : null;
  const creditGross = creditBase === null || (methodology.grossUpPdd && pdd === null)
    ? null : creditBase + (methodology.grossUpPdd ? -(pdd ?? 0) : 0);
  const creditDirectGross = tabI && pdd !== null ? sumKnown([
    field(tabI, "TAB_I2A_VL_DIRCRED_RISCO"),
    field(tabI, "TAB_I2B_VL_DIRCRED_SEM_RISCO"),
    -pdd,
  ]) : null;
  const fidcUnits = tabI ? sumKnown([
    optionalField(tabI, "TAB_I2H_VL_COTA_FIDC"),
    optionalField(tabI, "TAB_I2I_VL_COTA_FIDC_NP"),
  ]) : null;
  const otherCreditVm = tabI ? sumKnown([
    "TAB_I2C1_VL_DEBENTURE", "TAB_I2C2_VL_CRI", "TAB_I2C3_VL_NP_COMERC",
    "TAB_I2C4_VL_LETRA_FINANC", "TAB_I2C6_VL_OUTRO",
  ].map((key) => optionalField(tabI, key))) : null;
  const overdue = tabV && tabVI
    ? sumKnown([field(tabV, "TAB_V_B_VL_DIRCRED_INAD"), field(tabVI, "TAB_VI_B_VL_DIRCRED_INAD")])
    : null;
  const publicBonds = tabI
    ? sumKnown([field(tabI, "TAB_I2D_VL_TITPUB_FED"), field(tabI, "TAB_I2F_VL_OPER_COMPROM")])
    : null;
  const subordinateRows = tables.tab_X_2 ?? [];
  const subordinateParts = subordinateRows.map((row) => {
        const label = String(row.TAB_X_CLASSE_SERIE ?? "").toLowerCase();
        const included = label.includes("subordinada") &&
          (methodology.includeMezzanineInSubordination || !label.includes("mezanino"));
        if (!included) return 0;
        const quantity = field(row, "TAB_X_QT_COTA");
        const unitValue = field(row, "TAB_X_VL_COTA");
        return quantity === null || unitValue === null ? null : quantity * unitValue;
      });
  const subordinateValue = subordinateRows.length ? sumKnown(subordinateParts) : null;
  const trancheValue = (predicate: (label: string) => boolean): number | null => {
    if (!subordinateRows.length) return null;
    return sumKnown(subordinateRows.filter((row) => predicate(String(row.TAB_X_CLASSE_SERIE ?? "").toLowerCase()))
      .map((row) => {
        const quantity = field(row, "TAB_X_QT_COTA");
        const unitValue = field(row, "TAB_X_VL_COTA");
        return quantity === null || unitValue === null ? null : quantity * unitValue;
      }));
  };
  const seniorValue = trancheValue((label) => label.includes("senior") || label.includes("sênior"));
  const mezzanineValue = trancheValue((label) => label.includes("mezanino"));
  const juniorValue = trancheValue((label) => label.includes("subordinada") && !label.includes("mezanino"));
  const operations = tables.tab_X_4 ?? [];
  const operationTotal = (kind: string): number | null => {
    if (!operations.length) return null;
    const matching = operations.filter((row) => String(row.TAB_X_TP_OPER ?? "").toLowerCase() === kind.toLowerCase());
    return matching.length ? sumKnown(matching.map((row) => field(row, "TAB_X_VL_TOTAL"))) : null;
  };
  const inflow = operationTotal("Captações no Mês");
  const redemptions = operationTotal("Resgates no Mês");
  const amortizations = operationTotal("Amortizações no Mês");
  const redemptionsRequested = operationTotal("Resgates Solicitados");
  const cash = field(tabI, "TAB_I1_VL_DISP");
  const fundUnits = field(tabI, "TAB_I2C5_VL_COTA_FIF");
  const redemptionsSigned = redemptions === null ? null : -(redemptions + (expanded ? amortizations ?? 0 : 0));
  const creditPerforming = creditGross === null || overdue === null ? null : creditGross - overdue;
  const passivo = field(tabIII, "TAB_III_VL_PASSIVO");
  const cprCvm = tabI && passivo !== null ? sumKnown([
    field(tabI, "TAB_I4_VL_OUTRO_ATIVO"), field(tabI, "TAB_I3_VL_POSICAO_DERIV"), -passivo,
  ]) : null;
  const acquisition = tabVII ? sumKnown([
    field(tabVII, "TAB_VII_A1_2_VL_DIRCRED_RISCO"), field(tabVII, "TAB_VII_A2_2_VL_DIRCRED_SEM_RISCO"),
  ]) : null;
  const acquisitionCount = tabVII ? sumKnown([
    field(tabVII, "TAB_VII_A1_1_QT_DIRCRED_RISCO"), field(tabVII, "TAB_VII_A2_1_QT_DIRCRED_SEM_RISCO"),
  ]) : null;
  const repurchase = field(tabVII, "TAB_VII_D_2_VL_RECOMPRA");
  const debtorValues = (tables.tab_VIII ?? [])
    .map((row) => field(row, "VALOR"))
    .filter((value): value is number => value !== null)
    .sort((a, b) => b - a);
  const debtorTop = (count: number) => debtorValues.length
    ? ratio(debtorValues.slice(0, count).reduce((sum, value) => sum + value, 0), pl)
    : null;
  const cedentPercentages = ["A", "B"].flatMap((group) => Array.from({ length: 9 }, (_, index) => {
    const number = index + 1;
    const id = String(tabI?.[`TAB_I2${group}12_CPF_CNPJ_CEDENTE_${number}`] ?? "");
    const share = field(tabI, `TAB_I2${group}12_PR_CEDENTE_${number}`);
    return id && share !== null ? { id, share } : null;
  })).filter((item): item is { id: string; share: number } => item !== null);
  const cedentTop1 = cedentPercentages.length ? Math.max(...cedentPercentages.map((item) => item.share)) / 100 : null;
  const immediateLiquidity = sumKnown([cash, publicBonds, fundUnits]);
  const configuredMinimum = numeric(minimumSubordination);
  const subordinationRatio = ratio(subordinateValue, pl);
  const metrics: Record<string, MonthlyMetric> = {
    pl: m(pl, "CVM · TAB_IV_A_VL_PL"),
    creditGross: m(creditGross, "CVM · TAB_I2A + TAB_I2B + campos configurados + reversão PDD", "aproximado", "Composição do relatório CVPAR observada; validar inclusão de cotas FIDC/outros valores para outras gestoras."),
    pdd: m(pdd, "CVM · TAB_I2A11 + TAB_I2B11"),
    overdue: m(overdue, "CVM · TAB_V_B + TAB_VI_B", "aproximado", "Total agregado; a base de vencidos da administradora pode divergir."),
    creditToPl: m(ratio(creditGross, pl), "Derivado · DC bruto / PL", "aproximado"),
    pddToCredit: m(ratio(pdd, creditGross), "Derivado · PDD / DC bruto", "aproximado"),
    overdueToCredit: m(ratio(overdue, creditGross), "Derivado · vencidos CVM / DC bruto", "aproximado"),
    overdueToPl: m(ratio(overdue, pl), "Derivado · vencidos CVM / PL", "aproximado"),
    creditPerforming: m(creditPerforming, "Derivado · DC bruto menos vencidos CVM", "aproximado", "A base de vencidos pode divergir da posição da administradora."),
    creditDirectGross: m(creditDirectGross, "CVM · TAB_I2A + TAB_I2B + reversão PDD"),
    fidcUnits: m(fidcUnits, "CVM · TAB_I2H + TAB_I2I"),
    otherCreditVm: m(otherCreditVm, "CVM · TAB_I2C1…C4 + TAB_I2C6"),
    creditNetPdd: m(creditGross === null || pdd === null ? null : creditGross + pdd, "Derivado · DC bruto + PDD (negativa)", "aproximado", "Corrige o rótulo 'líquido' da planilha, cuja fórmula de julho repete o bruto."),
    creditNetPddToPl: m(creditGross === null || pdd === null ? null : ratio(creditGross + pdd, pl), "Derivado · (DC bruto + PDD) / PL", "aproximado", "A fórmula do Excel em julho divide DC bruto pelo PL e não desconta a PDD."),
    pddToPl: m(ratio(pdd, pl), "Derivado · PDD / PL", "aproximado"),
    publicBonds: m(publicBonds, "CVM · TAB_I2D + TAB_I2F"),
    fundUnits: m(fundUnits, "CVM · TAB_I2C5"),
    fundUnitsToPl: m(ratio(fundUnits, pl), "Derivado · cotas de fundos / PL", "aproximado"),
    cash: m(cash, "CVM · TAB_I1"),
    cashToPl: m(ratio(cash, pl), "Derivado · tesouraria / PL", "aproximado"),
    inflow: m(inflow, "CVM · TAB_X_4 Captações no Mês"),
    redemptions: m(redemptionsSigned, expanded ? "CVM · TAB_X_4 resgates + amortizações" : "CVM · TAB_X_4 Resgates no Mês", "aproximado", "O informe pode omitir saídas da lâmina da administradora."),
    redemptionsRequested: m(redemptionsRequested, "CVM · TAB_X_4 Resgates Solicitados", "aproximado", "Demanda declarada; confirmar calendário de cotização e pagamento."),
    netFlows: m(inflow === null || redemptionsSigned === null ? null : inflow + redemptionsSigned, "Derivado · captações + saídas TAB_X_4", "aproximado", "Conferir lançamentos da lâmina fora do informe."),
    subordination: m(subordinationRatio, "CVM · TAB_X_2 cotas subordinadas / TAB_IV PL", "aproximado", "Inclui mezanino conforme configuração; conferir regulamento e base exata."),
    subordinationMinimum: m(configuredMinimum, "Cadastro do fundo · mínimo configurado", "aproximado", "Confirmar vigência do regulamento e regra por classe antes de tratar como limite oficial."),
    subordinationHeadroom: m(subordinationRatio === null || configuredMinimum === null ? null : subordinationRatio - configuredMinimum, "Derivado · subordinação apurada − mínimo configurado", "aproximado", "Diferença indicativa, sem decisão automática de enquadramento."),
    seniorTrancheValue: m(seniorValue, "CVM · TAB_X_2 quantidade × valor da cota, subclasses sênior"),
    mezzanineTrancheValue: m(mezzanineValue, "CVM · TAB_X_2 quantidade × valor da cota, subclasses mezanino"),
    juniorTrancheValue: m(juniorValue, "CVM · TAB_X_2 quantidade × valor da cota, subclasses subordinada júnior"),
    administrationExpense: m(position?.expenses.administration ?? null, "Carteira diária · CPR", "aproximado", "Posição de despesa a pagar; confirmar competência do fluxo mensal."),
    custodyExpense: m(position?.expenses.custody ?? null, "Carteira diária · CPR", "aproximado"),
    managementExpense: m(position?.expenses.management ?? null, "Carteira diária · CPR", "aproximado"),
    otherNegativeExpenses: m(position?.expenses.otherNegative ?? null, "Carteira diária · CPR", "aproximado"),
    cprBalance: m(position?.expenses.cprBalance ?? null, "Carteira diária · CPR"),
    cprCvm: m(cprCvm, "CVM · TAB_I4 + TAB_I3 − TAB_III", "aproximado", "Saldo residual de outros ativos/derivativos/passivo; não é a abertura de despesas por natureza."),
    immediateLiquidity: m(immediateLiquidity, "Derivado · caixa + títulos públicos/compromissadas + FIF", "aproximado", "Disponibilidade contábil, sujeita a prazo de resgate e negociação."),
    acquisitions: m(acquisition, "CVM · TAB_VII_A1_2 + TAB_VII_A2_2", "apurado", "Aquisições com e sem aquisição substancial de risco."),
    acquisitionCount: m(acquisitionCount, "CVM · TAB_VII_A1_1 + TAB_VII_A2_1"),
    repurchaseCvm: m(repurchase, "CVM · TAB_VII_D_2", "aproximado", "Recompra agregada; não substitui a apuração por títulos liquidados."),
    repurchaseToPl: m(ratio(repurchase, pl), "Derivado · recompra agregada CVM / PL", "aproximado"),
    cedentListedTop1: m(cedentTop1, "CVM · TAB_I2A12/I2B12 percentual declarado", "aproximado", "A lista da CVM contém até 9 cedentes por grupo e pode estar incompleta."),
    debtorTop1: m(debtorTop(1), "CVM · maior VALOR da TAB_VIII / PL", "aproximado", "A TAB_VIII lista até 25 devedores; conferir consolidação por CPF/CNPJ no estoque."),
    debtorTop5: m(debtorTop(5), "CVM · cinco maiores VALOR da TAB_VIII / PL", "aproximado"),
    debtorTop10: m(debtorTop(10), "CVM · dez maiores VALOR da TAB_VIII / PL", "aproximado", "Se a lista tiver menos de dez registros, o valor é apenas o total dos registros informados."),
    debtorTop15: m(debtorTop(15), "CVM · quinze maiores VALOR da TAB_VIII / PL", "aproximado", "Se a lista tiver menos de quinze registros, o valor é apenas o total dos registros informados."),
  };
  const maturityKeys = [
    ["Até 30 dias", 1], ["31–60 dias", 2], ["61–90 dias", 3], ["91–120 dias", 4],
    ["121–150 dias", 5], ["151–180 dias", 6], ["181–360 dias", 7],
    ["361–720 dias", 8], ["721–1080 dias", 9], [">1080 dias", 10],
  ] as const;
  const maturityCvm = maturityKeys.map(([label, index]) => {
    const suffix = index === 10 ? "MAIOR_1080" : String(index === 7 ? 360 : index === 8 ? 720 : index === 9 ? 1080 : index * 30);
    const vKey = `TAB_V_A${index}_VL_PRAZO_VENC_${suffix}`;
    const viKey = `TAB_VI_A${index}_VL_PRAZO_VENC_${suffix}`;
    return {
      label,
      value: tabV && tabVI ? sumKnown([field(tabV, vKey), field(tabVI, viKey)]) : null,
    };
  });
  const overdueCvm = maturityKeys.map(([label, index]) => {
    const suffix = index === 10 ? "MAIOR_1080" : String(index === 7 ? 360 : index === 8 ? 720 : index === 9 ? 1080 : index * 30);
    return {
      label,
      value: tabV && tabVI ? sumKnown([
        field(tabV, `TAB_V_B${index}_VL_INAD_${suffix}`),
        field(tabVI, `TAB_VI_B${index}_VL_INAD_${suffix}`),
      ]) : null,
    };
  });
  const maturityValues = maturityCvm.map((bucket) => bucket.value);
  const maturityTotal = sumKnown(maturityValues);
  const midpointDays = [15, 45, 75, 105, 135, 165, 270, 540, 900, 1080];
  const weightedDays = maturityTotal && maturityTotal > 0
    ? maturityValues.reduce<number>((sum, value, index) => sum + (value ?? 0) * midpointDays[index], 0) / maturityTotal
    : null;
  const overdue120 = sumKnown(overdueCvm.slice(4).map((bucket) => bucket.value));
  const overdue90 = sumKnown(overdueCvm.slice(3).map((bucket) => bucket.value));
  const due30 = maturityCvm[0].value;
  const due90 = sumKnown(maturityCvm.slice(0, 3).map((bucket) => bucket.value));
  metrics.overdue120 = m(overdue120, "CVM · TAB_V/VI_B5…B10", "apurado");
  metrics.overdue90 = m(overdue90, "CVM · TAB_V/VI_B4…B10", "apurado");
  metrics.due30 = m(due30, "CVM · TAB_V/VI_A1", "aproximado", "Faixa de vencimento dos DC, não fluxo de caixa projetado.");
  metrics.due90 = m(due90, "CVM · TAB_V/VI_A1…A3", "aproximado", "Soma das faixas de vencimento, sem ajuste para atraso e pré-pagamento.");
  metrics.immediatePlusDue30ToPl = m(immediateLiquidity === null || due30 === null ? null : ratio(immediateLiquidity + due30, pl), "Derivado · (liquidez imediata contábil + DC a vencer em 30 dias) / PL", "aproximado", "Não é índice de cobertura de resgates ou projeção de caixa disponível.");
  metrics.averageMaturityCalendarDays = m(weightedDays, "CVM · TAB_V/VI_A1…A10 ponderadas pelos pontos médios", "aproximado", "Faixa >1080 dias usa 1080 como limite inferior; não substitui cálculo título a título.");
  metrics.averageMaturityBusinessDays = m(weightedDays === null ? null : weightedDays * 252 / 365, "Derivado · dias corridos × 252/365", "aproximado", "Conversão aproximada; não usa calendário de feriados.");
  const purchaseRisk = field(tabVII, "TAB_VII_A1_2_VL_DIRCRED_RISCO");
  const purchaseNoRisk = field(tabVII, "TAB_VII_A2_2_VL_DIRCRED_SEM_RISCO");
  const rateRisk = field(tabIX, "TAB_IX_A1_1_2_COMPRA_MEDIA");
  const rateNoRisk = field(tabIX, "TAB_IX_B1_1_2_COMPRA_MEDIA");
  const rateParts = [
    { amount: purchaseRisk, rate: rateRisk }, { amount: purchaseNoRisk, rate: rateNoRisk },
  ].filter(({ amount, rate }) => amount !== null && amount > 0 && rate !== null && rate > 0 && rate <= 300);
  const rateWeight = rateParts.reduce((sum, item) => sum + (item.amount ?? 0), 0);
  const rateAnnual = rateWeight > 0 ? rateParts.reduce((sum, item) => sum + (item.amount ?? 0) * (item.rate ?? 0), 0) / rateWeight / 100 : null;
  metrics.cessionRateAnnual = m(rateAnnual, "CVM · TAB_IX compra média ponderada por TAB_VII", "aproximado", "Exclui taxas ausentes e fora de (0; 300]% a.a.; não equivale à taxa contrato a contrato.");
  metrics.cessionRateMonthly = m(rateAnnual === null ? null : Math.pow(1 + rateAnnual, 1 / 12) - 1, "Derivado · (1 + taxa a.a.)^(1/12) − 1", "aproximado");
  const gaps = [
    "Estoque individual por título: necessário para prazo médio, faixas até 5 dias, 6–30 dias e previsão de liquidação CVPAR.",
    "Títulos liquidados/recomprados: necessário para indicadores de recompra.",
    "Base de cedentes completa: Informe lista no máximo 9 por grupo; Top 5/10/15 não é fechado sem estoque.",
    "Base de sacados: TAB_VIII lista até 25 valores, sem identificador; confirmar consolidação por devedor no estoque.",
    "Cronograma de amortização/resgate, passivo de cotistas e premissas de mercado: necessários para cobertura e stress de liquidez.",
    "Regulamento vigente por fundo/classe: necessário para limite mínimo de subordinação.",
  ];
  if (!position) gaps.unshift("Carteira diária ausente para a data-base: despesas CPR não verificadas neste cálculo.");
  if (creditGross === null) gaps.unshift("Campos necessários da TAB_I ou PDD ausentes: DC bruto não calculado.");
  if (overdue === null) gaps.unshift("TAB_V/TAB_VI ou campos de inadimplência ausentes: vencidos não calculados.");
  if (!tables.tab_X_2?.length) gaps.unshift("TAB_X_2 ausente: índice de subordinação indisponível.");
  if (!tables.tab_X_4?.length) gaps.unshift("TAB_X_4 ausente: captações e resgates indisponíveis.");
  if (!tabI || !tabIV) gaps.unshift("TAB_I ou TAB_IV ausente: posição e PL incompletos.");
  return {
    methodology: `${methodology.code}@${methodology.version}`,
    referenceMonth,
    cnpj,
    metrics,
    maturityCvm,
    overdueCvm,
    gaps,
    evidence: { tables: Object.keys(tables).sort(), positionDate: position?.referenceDate ?? null },
  };
}
