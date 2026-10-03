/** Cálculo do drill-down do score (espelha vw_credito_score_fundo). */

export type ScoreFundoDetalhe = {
  doc_fundo: string;
  nome_fundo: string;
  data_referencia?: string;
  score_qualidade: number;
  faixa_score: string;
  over90?: number;
  over180?: number;
  coverage_npl?: number;
  aderencia_pdd?: number;
  delta_over90?: number;
  gap_relativo?: number;
  concentracao_over90?: number;
};

export type ScoreBreakdownItem = {
  key: string;
  label: string;
  /** Impacto em pontos vs. teto do componente (negativo = puxa score para baixo). 0 = sem penalidade. */
  pontos: number;
};

/**
 * Documentação das dimensões do score (vw_credito_score_fundo / credito_score_parametros).
 * Score final = soma ponderada de componentes normalizados 0–1, × 100.
 * "0 pts" no breakdown = componente no teto (sem penalidade), não "não implementado".
 */
export const SCORE_DIMENSION_DOCS: Record<string, {
  titulo: string;
  peso: string;
  referencia: string;
  formula: string;
  interpretacaoZero: string;
}> = {
  over90: {
    titulo: "Over90",
    peso: "20%",
    referencia: "ref. 15% da carteira",
    formula: "c = max(0, 1 − over90 / 15%). Quanto menor a inadimplência >90d, melhor.",
    interpretacaoZero: "0 pts = over90 no limite ou acima da referência (sem crédito nesta dimensão).",
  },
  coverage: {
    titulo: "Coverage NPL",
    peso: "20%",
    referencia: "ref. 100% (PDD cobre todo o Over90)",
    formula: "c = min(1, PDD_total / exposição_Over90). Mede se a provisão cobre a inadimplência grave.",
    interpretacaoZero: "0 pts = cobertura plena (PDD ≥ Over90) — dimensão no teto, sem penalidade.",
  },
  aderencia: {
    titulo: "Aderência PDD",
    peso: "15%",
    referencia: "ref. 100% (PDD atual = PDD modelo)",
    formula: "c = min(1, PDD_atual / PDD_modelo). Quão próximo o PDD registrado está do modelo interno.",
    interpretacaoZero: "0 pts = aderência plena ao modelo — sem penalidade.",
  },
  gap: {
    titulo: "Gap PDD",
    peso: "10%",
    referencia: "ref. gap relativo ≤ 20% do modelo",
    formula: "c = max(0, 1 − gap_relativo / 20%). Gap = (PDD_modelo − PDD_atual) / PDD_modelo.",
    interpretacaoZero: "0 pts = gap dentro do limite — provisão alinhada ao modelo.",
  },
  concentracao: {
    titulo: "Concentração Over90",
    peso: "5%",
    referencia: "ref. top cedente ≤ 70% do Over90",
    formula: "c = max(0, 1 − pct_top1_cedente / 70%). Penaliza concentração da inadimplência grave.",
    interpretacaoZero: "0 pts = concentração aceitável — sem penalidade.",
  },
  trend: {
    titulo: "Trend Δ Over90",
    peso: "15%",
    referencia: "ref. variação ≤ 5 p.p. vs. mês anterior",
    formula: "c = max(0, 1 − |Δover90| / 5 p.p.). Penaliza deterioração rápida da inadimplência.",
    interpretacaoZero: "0 pts = variação dentro do limite — tendência estável.",
  },
};

const DEFAULT_PESOS = {
  over90: 0.20,
  coverage_npl: 0.20,
  aderencia_pdd: 0.15,
  delta_over90: 0.15,
  gap_relativo: 0.10,
  concentracao_over90: 0.05,
} as const;

const DEFAULT_REFS = {
  over90: 0.15,
  coverage_npl: 1.0,
  aderencia_pdd: 1.0,
  delta_over90: 0.05,
  gap_relativo: 0.20,
  concentracao_over90: 0.70,
} as const;

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

/** Pontos de impacto: peso × (c − 1) / pesoTotal × 100. c=1 → 0 pts (teto). c<1 → negativo. */
function impactoComponente(peso: number, c: number, pesoTotal: number): number {
  if (pesoTotal <= 0) return 0;
  return Math.round((peso * (c - 1)) / pesoTotal * 1000) / 10;
}

/** Limite de concentração exibido no banner executivo (política interna). */
export const LIMITE_CONCENTRACAO_RECOMENDADO = 0.25;

export function computeScoreBreakdown(score: ScoreFundoDetalhe): ScoreBreakdownItem[] {
  const over90 = score.over90 ?? 0;
  const coverageNpl = score.coverage_npl ?? 0;
  const aderencia = score.aderencia_pdd ?? 0;
  const delta = score.delta_over90 ?? 0;
  const gap = score.gap_relativo ?? 0;
  const conc = score.concentracao_over90 ?? 0;

  const cOver90 = clamp01(1 - over90 / DEFAULT_REFS.over90);
  const cCov = clamp01(coverageNpl / DEFAULT_REFS.coverage_npl);
  const cAder = clamp01(aderencia / DEFAULT_REFS.aderencia_pdd);
  const cDelta = clamp01(1 - Math.abs(delta) / DEFAULT_REFS.delta_over90);
  const cGap = clamp01(1 - Math.max(gap, 0) / DEFAULT_REFS.gap_relativo);
  const cConc = clamp01(1 - conc / DEFAULT_REFS.concentracao_over90);

  const pesoTotal =
    DEFAULT_PESOS.over90 +
    DEFAULT_PESOS.coverage_npl +
    DEFAULT_PESOS.aderencia_pdd +
    DEFAULT_PESOS.delta_over90 +
    DEFAULT_PESOS.gap_relativo +
    DEFAULT_PESOS.concentracao_over90;

  return [
    { key: "over90", label: "Over90", pontos: impactoComponente(DEFAULT_PESOS.over90, cOver90, pesoTotal) },
    { key: "coverage", label: "Coverage", pontos: impactoComponente(DEFAULT_PESOS.coverage_npl, cCov, pesoTotal) },
    { key: "aderencia", label: "Aderência PDD", pontos: impactoComponente(DEFAULT_PESOS.aderencia_pdd, cAder, pesoTotal) },
    { key: "gap", label: "Gap", pontos: impactoComponente(DEFAULT_PESOS.gap_relativo, cGap, pesoTotal) },
    { key: "concentracao", label: "Concentração", pontos: impactoComponente(DEFAULT_PESOS.concentracao_over90, cConc, pesoTotal) },
    { key: "trend", label: "Trend", pontos: impactoComponente(DEFAULT_PESOS.delta_over90, cDelta, pesoTotal) },
  ];
}

export function formatScorePontos(pontos: number): string {
  if (pontos === 0) return "0";
  return pontos > 0 ? `+${pontos.toFixed(0)}` : pontos.toFixed(0);
}
