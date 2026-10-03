/**
 * Tipos, constantes e formatadores para o módulo Matriz de Risco de Crédito.
 * Reutiliza formatBRL, formatPct de creditoIndicadores.ts.
 */

export { formatBRL, formatPct, formatPctPoints, formatDateBR } from "./creditoIndicadores";

// ─── Constantes de faixas ──────────────────────────────────────────────────

export const FAIXAS_PRAZO_ORDEM = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type FaixaPrazoOrdem = (typeof FAIXAS_PRAZO_ORDEM)[number];

export const FAIXA_PRAZO_LABELS: Record<number, string> = {
  0: "Adimplente",
  1: "Até 30 dias",
  2: "Até 60 dias",
  3: "Até 90 dias",
  4: "Até 120 dias",
  5: "Até 150 dias",
  6: "Até 180 dias",
  7: "Até 360 dias",
  8: "Até 720 dias",
  9: "Até 1080 dias",
  10: "Acima de 1080 dias",
};

export const FAIXA_PRAZO_KEYS: Record<number, string> = {
  0: "Adimplente",
  1: "Até 30 dias",
  2: "Até 60 dias",
  3: "Até 90 dias",
  4: "Até 120 dias",
  5: "Até 150 dias",
  6: "Até 180 dias",
  7: "Até 360 dias",
  8: "Até 720 dias",
  9: "Até 1080 dias",
  10: "Acima de 1080 dias",
};

/** Cor semântica de risco por faixa (hex) */
export const FAIXA_PRAZO_COLORS: Record<number, string> = {
  0:  "#16a34a",  // verde
  1:  "#65a30d",  // lima
  2:  "#ca8a04",  // amarelo
  3:  "#d97706",  // âmbar
  4:  "#ea580c",  // laranja
  5:  "#dc2626",  // vermelho médio
  6:  "#b91c1c",  // vermelho forte
  7:  "#991b1b",  // vermelho escuro
  8:  "#7f1d1d",  // vermelho muito escuro
  9:  "#6b21a8",  // roxo (crítico)
  10: "#4c0519",  // vinho (write-off)
};

export const FAIXAS_VENCIMENTO = [
  { key: "vp_vence_esta_semana",  label: "Esta semana",   qtdKey: "qtd_vence_esta_semana" },
  { key: "vp_vence_este_mes",     label: "Este mês",      qtdKey: "qtd_vence_este_mes" },
  { key: "vp_vence_proximo_mes",  label: "Próximo mês",   qtdKey: "qtd_vence_proximo_mes" },
  { key: "vp_vence_3_meses",      label: "Até 3 meses",   qtdKey: "qtd_vence_3_meses" },
  { key: "vp_vence_6_meses",      label: "Até 6 meses",   qtdKey: "qtd_vence_6_meses" },
] as const;

export type PeriodoSerie = "6m" | "12m" | "24m" | "all";
export const PERIODOS_SERIE: { value: PeriodoSerie; label: string }[] = [
  { value: "6m",  label: "6 meses" },
  { value: "12m", label: "12 meses" },
  { value: "24m", label: "24 meses" },
  { value: "all", label: "Todos" },
];

// ─── Tipos das views SQL ──────────────────────────────────────────────────

/** vw_credito_matriz_prazo */
export type MatrizPrazoRow = {
  doc_fundo: string;
  data_referencia: string;
  nome_fundo: string;
  faixa_prazo: string;
  faixa_prazo_ordem: number;
  vp_adimplente: number;
  qtd_adimplente: number;
  vp_inadimplente: number;
  qtd_inadimplente: number;
  vp_pdd: number;
  vp_writeoff: number;
  qtd_writeoff: number;
  vp_total: number;
  pdd_total: number;
  qtd_total: number;
  pct_adimplente: number;
  pct_inadimplente: number;
  pct_pdd: number;
};

/** vw_credito_matriz_cobertura_pdd */
export type CoberturaPddRow = {
  doc_fundo: string;
  data_referencia: string;
  nome_fundo: string;
  faixa_prazo: string;
  faixa_prazo_ordem: number;
  vp_total_faixa: number;
  vp_pdd_faixa: number;
  cobertura_pdd: number;
};

/** vw_credito_matriz_visao_geral */
export type VisaoGeralKpis = {
  doc_fundo: string;
  data_referencia: string;
  nome_fundo: string;
  vp_total: number;
  pdd_total: number;
  vp_a_vencer: number;
  qtd_a_vencer: number;
  vp_vencido: number;
  qtd_vencido: number;
  /** Buckets mutuamente exclusivos para barra de composição */
  vp_comp_adimplente?: number;
  vp_comp_vencido_ate_90?: number;
  vp_comp_vencido_91_180?: number;
  vp_writeoff: number;
  qtd_writeoff: number;
  vp_over90: number;
  vp_vence_esta_semana: number;
  vp_vence_este_mes: number;
  vp_vence_proximo_mes: number;
  vp_vence_3_meses: number;
  vp_vence_6_meses: number;
  vp_vence_acima_6_meses?: number;
  qtd_vence_esta_semana: number;
  qtd_vence_este_mes: number;
  qtd_vence_proximo_mes: number;
  qtd_vence_3_meses: number;
  qtd_vence_6_meses: number;
  qtd_vence_acima_6_meses?: number;
  pct_vencido: number;
  pct_over90: number;
  pct_pdd_carteira: number;
};

/** vw_credito_concentracao_cedente */
export type ConcentracaoCedenteRow = {
  doc_fundo: string;
  data_referencia: string;
  nome_fundo: string;
  doc_cedente: string;
  nome_cedente: string;
  vp_cedente: number;
  vp_total: number;
  pct_vp_total: number;
  ranking: number;
};

/** vw_credito_matriz_fundo_resumo */
export type FundoResumoCredito = {
  doc_fundo: string;
  data_referencia: string;
  nome_fundo: string;
  qtd_classes: number;
  pl_total: number | null;
  rentabilidade_dia_pct: number | null;
  rentabilidade_mes_pct: number | null;
  rentabilidade_ano_pct: number | null;
  rentabilidade_12m_pct: number | null;
};

/** vw_credito_matriz_concentracao_parte */
export type ConcentracaoParteCarteira = {
  tipo_parte: "cedente" | "sacado";
  doc_fundo: string;
  data_referencia: string;
  nome_fundo: string;
  doc_parte: string;
  nome_parte: string | null;
  vp_parte: number;
  vp_total: number;
  pct_carteira: number;
  pct_pl: number | null;
  ranking: number;
};

/** vw_credito_matriz_enquadramento */
export type EnquadramentoCreditoRow = {
  doc_fundo: string;
  data_referencia: string;
  regra_categoria: string;
  regra_codigo: string;
  regra_descricao: string | null;
  status: "ok" | "alerta" | "violacao";
  valor_atual: number | null;
  valor_limite: number | null;
  detalhes: Record<string, unknown> | null;
  verificado_em: string | null;
};

/** vw_credito_safras_emissao_serie */
export type SafraEmissaoRow = {
  doc_fundo: string;
  data_referencia: string;
  nome_fundo: string;
  safra_emissao: string;
  safra_label: string;
  qtd_titulos: number;
  vn_total: number;
  vp_total: number;
  vp_com_taxa?: number;
  taxa_media_cessao: number | null;
  pct_vencido_cohort: number;
  pct_writeoff_cohort: number;
  status_cohort: "ok" | "atencao" | "critico";
};

/** vw_credito_safras_emissao_metricas */
export type SafraEmissaoMetricas = {
  doc_fundo: string;
  data_referencia: string;
  nome_fundo: string;
  qtd_titulos_total: number;
  vp_total: number;
  vp_com_taxa?: number;
  prazo_medio_recebimento_dias: number | null;
  taxa_media_mensal: number | null;
  taxa_media_anualizada: number | null;
};

/** vw_credito_serie_mensal */
export type SerieMensalRow = {
  mes_referencia: string;
  doc_fundo: string;
  nome_fundo: string | null;
  provisao_total: number | null;
  inadimplencia_pct: number | null;
  over90_pct: number | null;
  over180_pct: number | null;
  writeoff_total: number | null;
  retorno_medio_credito: number | null;
  vp_total: number | null;
  qtd_titulos: number | null;
  calc_version: string;
  snapshot_updated_at: string;
  is_stale: boolean | null;
};

// ─── Utilidades de formatação extra ──────────────────────────────────────

/** Taxa em pontos percentuais (TX_RECEBIVEL: 0,2442 = 0,2442% a.m. — sem multiplicar por 100). */
export const formatTaxa = (v: number | null | undefined, casas = 4): string => {
  if (v == null) return "—";
  return `${Number(v).toFixed(casas)}%`;
};

/** Anualiza taxa mensal em pontos percentuais → pontos percentuais a.a. (composta). */
export const anualizarTaxaPctPoints = (mensalPctPoints: number): number =>
  (Math.pow(1 + mensalPctPoints / 100, 12) - 1) * 100;

/** Prazo em dias com label curta */
export const formatPrazoDias = (v: number | null | undefined): string => {
  if (v == null) return "—";
  const d = Math.round(v as number);
  if (d < 30) return `${d}d`;
  const m = Math.round(d / 30.44);
  return `${m} ${m === 1 ? "mês" : "meses"}`;
};

/** Cor semântica de saúde para over90 / inadimplência */
export function corSeveridade(pct: number): "ok" | "atencao" | "critico" {
  if (pct >= 0.10) return "critico";
  if (pct >= 0.05) return "atencao";
  return "ok";
}

export const SEVERITY_CLASSES = {
  ok:      { badge: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30", dot: "bg-emerald-500" },
  atencao: { badge: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",   dot: "bg-yellow-500" },
  critico: { badge: "bg-red-500/20 text-red-400 border-red-500/30",             dot: "bg-red-500" },
};
