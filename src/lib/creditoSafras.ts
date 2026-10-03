/** Tipos e helpers — Performance de Safras (cohorts por data_aquisicao). */

export type SafraResumo = {
  doc_fundo: string;
  nome_fundo: string;
  data_referencia: string;
  safra: string;
  safra_label: string;
  mob_max: number;
  mob_medio: number;
  qtd_ativos: number;
  exposicao: number;
  exposicao_atraso: number;
  exposicao_over90: number;
  exposicao_over180: number;
  pct_atraso: number;
  pct_over90: number;
  pct_over180: number;
};

export type SafraCurva = {
  doc_fundo: string;
  nome_fundo: string;
  safra_label: string;
  mob_meses: number;
  qtd_ativos: number;
  exposicao: number;
  exposicao_over90: number;
  pct_over90: number;
  pct_atraso: number;
};

export type SafraBucket = {
  doc_fundo: string;
  nome_fundo: string;
  data_referencia: string;
  safra_label: string;
  bucket_canonico: string;
  bucket_ordem: number;
  qtd_ativos: number;
  exposicao: number;
  pct_safra: number;
};

export type SafraVolumeOrigem = {
  doc_fundo: string;
  nome_fundo: string;
  safra_label: string;
  primeira_observacao: string;
  volume_originado: number;
  qtd_ativos_originados: number;
};

const MESES_PT = [
  "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
  "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];

/** "2024-03" → "Mar/2024" */
export function formatSafraLabel(label: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) return label;
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return label;
  return `${MESES_PT[month - 1]}/${m[1]}`;
}

export const CURVA_COLORS = [
  "#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed",
  "#0891b2", "#ca8a04", "#be185d", "#4f46e5", "#059669",
];
