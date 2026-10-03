/** Catálogo e cálculos de subordinação FIDC multiclasse (fidc-estrutura). */

export type ClasseAlvoSubordinacao = "senior" | "mezanino";
export type ComposicaoNumeradorSubordinacao = "jr" | "jr_mez";
export type ComposicaoDenominadorSubordinacao = "pl_classe";
export type OrigemPlEstrutura = "pl_atual_xml" | "pl_mes_anterior_posicao";

export interface SeriesSubordinacao {
  jr?: string[];
  mez?: string[];
  senior?: string[];
}

export interface ParametrosFidcSubordinacao {
  tipo_regra: "fidc_subordinacao";
  classe_alvo: ClasseAlvoSubordinacao;
  limite_min: number;
  limite_alerta: number;
  composicao_numerador: ComposicaoNumeradorSubordinacao;
  composicao_denominador: ComposicaoDenominadorSubordinacao;
  origem_pl: OrigemPlEstrutura;
  series: SeriesSubordinacao;
  observacao?: string;
}

export type RuleStatusEstrutura = "ok" | "alerta" | "violacao";

export interface PlPorIsin {
  isin: string;
  papel: "jr" | "mez" | "senior";
  pl: number;
  nome?: string | null;
  origem_pl?: string;
  data_pl_referencia?: string;
}

export interface ResultadoSubordinacaoCalc {
  pl_jr: number;
  pl_mez: number;
  pl_sr: number;
  pl_classe: number;
  numerador: number;
  indice_calculado: number;
  limite_minimo: number;
  limite_alerta: number;
  excesso_cobertura: number;
  status: RuleStatusEstrutura;
}

export const ORIGEM_PL_ESTRUTURA_DEFAULT: OrigemPlEstrutura = "pl_mes_anterior_posicao";

export function parseIsinList(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((v) => String(v ?? "").trim()).filter(Boolean))];
  }
  if (typeof raw === "string") {
    return [...new Set(raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))];
  }
  return [];
}

export function normalizeSeries(raw: unknown): SeriesSubordinacao {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    jr: parseIsinList(s.jr),
    mez: parseIsinList(s.mez),
    senior: parseIsinList(s.senior),
  };
}

export function parseParametrosFidcSubordinacao(
  parametros: Record<string, unknown> | null | undefined,
): ParametrosFidcSubordinacao | null {
  if (!parametros || parametros.tipo_regra !== "fidc_subordinacao") return null;
  const classeAlvo = parametros.classe_alvo === "mezanino" ? "mezanino" : "senior";
  const numerador =
    parametros.composicao_numerador === "jr" ? "jr" : "jr_mez";
  const origemPl =
    parametros.origem_pl === "pl_atual_xml"
      ? "pl_atual_xml"
      : ORIGEM_PL_ESTRUTURA_DEFAULT;
  const limiteMin = Number(parametros.limite_min);
  const limiteAlerta = Number(parametros.limite_alerta);
  return {
    tipo_regra: "fidc_subordinacao",
    classe_alvo: classeAlvo,
    limite_min: Number.isFinite(limiteMin) ? limiteMin : 0.1,
    limite_alerta: Number.isFinite(limiteAlerta) ? limiteAlerta : 0.12,
    composicao_numerador: numerador,
    composicao_denominador: "pl_classe",
    origem_pl: origemPl,
    series: normalizeSeries(parametros.series),
    observacao: parametros.observacao ? String(parametros.observacao) : undefined,
  };
}

/** ISINs da subclasse alvo em que a regra deve ser executada. */
export function getTargetIsinsForClasseAlvo(params: ParametrosFidcSubordinacao): string[] {
  const series = params.series;
  return params.classe_alvo === "mezanino"
    ? (series.mez ?? [])
    : (series.senior ?? []);
}

/** Executa validação somente na subclasse alvo. */
export function shouldRunSubordinacaoOnIsin(
  fundoIsin: string | null | undefined,
  params: ParametrosFidcSubordinacao,
): boolean {
  const isin = (fundoIsin ?? "").trim();
  if (!isin) return false;
  const targets = getTargetIsinsForClasseAlvo(params);
  return targets.includes(isin);
}

export function allSeriesIsins(series: SeriesSubordinacao): string[] {
  return [...new Set([...(series.jr ?? []), ...(series.mez ?? []), ...(series.senior ?? [])])];
}

export function buildCodigoSubordinacao(
  classeAlvo: ClasseAlvoSubordinacao,
  limiteMinPct: number | string,
): string {
  const pct = Math.round(Number(limiteMinPct) || 10);
  const suffix = classeAlvo === "mezanino" ? "MEZ" : "SR";
  return `SUB_${suffix}_${pct}`;
}

export function buildDescricaoSubordinacao(
  classeAlvo: ClasseAlvoSubordinacao,
  limiteMinPct: number,
  limiteAlertaPct: number,
  numerador: ComposicaoNumeradorSubordinacao,
  observacao?: string,
): string {
  const numLabel = numerador === "jr" ? "JR / PL Classe" : "(JR + MEZ) / PL Classe";
  const alvoLabel = classeAlvo === "mezanino" ? "Mezanino" : "Sênior";
  const base = `Subordinação ${alvoLabel}: mín. ${limiteMinPct}% (${numLabel}) — alerta ${limiteAlertaPct}%`;
  return observacao?.trim() ? `${base} — ${observacao.trim()}` : base;
}

export function buildParametrosSubordinacao(input: {
  classeAlvo: ClasseAlvoSubordinacao;
  limiteMinPct: number;
  limiteAlertaPct: number;
  composicaoNumerador: ComposicaoNumeradorSubordinacao;
  origemPl: OrigemPlEstrutura;
  series: SeriesSubordinacao;
  observacao?: string;
}): ParametrosFidcSubordinacao {
  return {
    tipo_regra: "fidc_subordinacao",
    classe_alvo: input.classeAlvo,
    limite_min: input.limiteMinPct / 100,
    limite_alerta: input.limiteAlertaPct / 100,
    composicao_numerador: input.composicaoNumerador,
    composicao_denominador: "pl_classe",
    origem_pl: input.origemPl,
    series: {
      jr: input.series.jr ?? [],
      mez: input.series.mez ?? [],
      senior: input.series.senior ?? [],
    },
    observacao: input.observacao?.trim() || undefined,
  };
}

export function calcSubordinacaoIndice(
  params: ParametrosFidcSubordinacao,
  plPorPapel: { jr: number; mez: number; senior: number },
): ResultadoSubordinacaoCalc {
  const pl_jr = plPorPapel.jr;
  const pl_mez = plPorPapel.mez;
  const pl_sr = plPorPapel.senior;
  const pl_classe = pl_jr + pl_mez + pl_sr;

  const numerador =
    params.composicao_numerador === "jr"
      ? pl_jr
      : pl_jr + pl_mez;

  const indice_calculado = pl_classe > 0 ? numerador / pl_classe : 0;
  const limite_minimo = params.limite_min;
  const limite_alerta = params.limite_alerta;

  let status: RuleStatusEstrutura = "ok";
  if (pl_classe <= 0) {
    status = "alerta";
  } else if (indice_calculado < limite_minimo) {
    status = "violacao";
  } else if (indice_calculado < limite_alerta) {
    status = "alerta";
  }

  const excesso_cobertura = Math.max(0, numerador - limite_minimo * pl_classe);

  return {
    pl_jr,
    pl_mez,
    pl_sr,
    pl_classe,
    numerador,
    indice_calculado,
    limite_minimo,
    limite_alerta,
    excesso_cobertura,
    status,
  };
}

export function categoriaEnquadramentoFidcEstrutura(
  parametros?: Record<string, unknown> | null,
): string | null {
  if (parametros?.tipo_regra === "fidc_subordinacao") return "fidc-estrutura";
  return null;
}
