import {
  calculateMonthlyFidc,
  type CvmTables,
  type MonthlyMethodology,
  type MonthlyResult,
  type PositionEvidence,
} from "./liquidity-monthly.ts";

export type LiquidityInputContract =
  | "informe_mensal_cvm"
  | "carteira_diaria"
  | "minimo_subordinacao"
  | "estoque_recebiveis"
  | "posicao_carteira_xml";

export interface FidcMonthlyInputs {
  tables: CvmTables;
  referenceMonth: string;
  cnpj: string;
  position: PositionEvidence | null;
  minimumSubordination: number | string | null;
}

export interface LiquidityCommonResult {
  methodologyId: string;
  methodologyVersion: string;
  primaryIndicator: number | null;
  horizon: string;
  coverageIndex: number | null;
  status: "apurado" | "aproximado" | "indisponivel";
  calculationMemory: MonthlyResult["metrics"];
  evidence: MonthlyResult["evidence"];
  gaps: string[];
}

export interface LiquidityMethodology<Inputs, Params, Result> {
  readonly id: string;
  readonly version: string;
  readonly requiredInputs: readonly LiquidityInputContract[];
  readonly optionalInputs: readonly LiquidityInputContract[];
  appliesTo(fund: { cnpj: string; type?: string | null }): boolean;
  validate(inputs: Inputs): string[];
  compute(inputs: Inputs, params: Params): Result;
  explain(result: Result): string[];
  toCommonResult(result: Result): LiquidityCommonResult;
}

const CURRENT_FIDC_CNPJS = new Set([
  "51864349000102", "23104485000169", "47425841000104", "58426775000103",
]);

// A versão 2026.2 é um invólucro do motor congelado. Os parâmetros continuam
// vindos da linha versionada em liquidity_monthly_methodologies.
export const fidcMensal2026_2: LiquidityMethodology<FidcMonthlyInputs, MonthlyMethodology, MonthlyResult> = {
  id: "cvpar_fidc_mensal",
  version: "2026.2",
  requiredInputs: ["informe_mensal_cvm"],
  optionalInputs: ["carteira_diaria", "minimo_subordinacao"],
  appliesTo: (fund) => CURRENT_FIDC_CNPJS.has(fund.cnpj) || fund.type?.toUpperCase() === "FIDC",
  validate: (inputs) => {
    const errors: string[] = [];
    if (!/^\d{14}$/.test(inputs.cnpj)) errors.push("CNPJ do fundo inválido.");
    if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(inputs.referenceMonth)) errors.push("Competência inválida.");
    if (!Object.values(inputs.tables).some((rows) => rows.length > 0)) errors.push("Informe mensal CVM ausente.");
    return errors;
  },
  compute: (inputs, params) => calculateMonthlyFidc(
    inputs.tables, inputs.referenceMonth, inputs.cnpj, params,
    inputs.position, inputs.minimumSubordination,
  ),
  explain: (result) => Object.entries(result.metrics).map(([key, metric]) =>
    `${key}: ${metric.source}${metric.note ? ` — ${metric.note}` : ""}`),
  toCommonResult: (result) => ({
    methodologyId: "cvpar_fidc_mensal",
    methodologyVersion: "2026.2",
    primaryIndicator: result.metrics.immediatePlusDue30ToPl?.value ?? null,
    horizon: "30 dias (vencimento contratual)",
    coverageIndex: null,
    status: result.metrics.immediatePlusDue30ToPl?.status ?? "indisponivel",
    calculationMemory: result.metrics,
    evidence: result.evidence,
    gaps: result.gaps,
  }),
};

export function resolveLiquidityMethodology(code: string, version: string) {
  return code === fidcMensal2026_2.id && version === fidcMensal2026_2.version
    ? fidcMensal2026_2
    : null;
}
