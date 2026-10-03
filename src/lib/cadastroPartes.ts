/** Utilitários compartilhados — cadastro de partes (cedente/sacado) aprovadas em comitê. */

import {
  mapHeadersFromKeys,
  parseDataCampo,
  parseLimiteCampo,
} from "./cadastroPartesParse";

export type TipoParte = "cedente" | "sacado";
export type EscopoLimite = "individual" | "grupo";
export type PoliticaCadastro = "vedar" | "alertar";
export type StatusParte = "ativo" | "suspenso" | "encerrado";

export interface CadastroPartesParams {
  verificar_cedente: boolean;
  verificar_sacado: boolean;
  base_calculo: string;
  usar_abatimento_pdd: boolean;
  usar_grupo_economico: boolean;
  politica_nao_cadastrado: PoliticaCadastro;
  politica_cadastro_vencido: PoliticaCadastro;
  politica_revisao_pendente: PoliticaCadastro;
  validade_inclusiva: boolean;
}

export const CADASTRO_PARTES_DEFAULTS: CadastroPartesParams = {
  verificar_cedente: true,
  verificar_sacado: false,
  base_calculo: "valor_presente",
  usar_abatimento_pdd: true,
  usar_grupo_economico: true,
  politica_nao_cadastrado: "vedar",
  politica_cadastro_vencido: "vedar",
  politica_revisao_pendente: "alertar",
  validade_inclusiva: true,
};

export interface CadastroParteRow {
  id?: string;
  fundo_cnpj: string;
  fundo_isin?: string;
  tipo_parte: TipoParte;
  doc_cnpj_cpf: string;
  nome: string | null;
  escopo_limite: EscopoLimite;
  grupo_chave: string | null;
  limite_operacao: number | null;
  dt_analise: string | null;
  dt_validade: string | null;
  numero_ata: string | null;
  consultoria: string | null;
  status: StatusParte;
  observacoes: string | null;
  vigente?: boolean;
}

export interface ImportAviso {
  linha: number;
  campo: string;
  problema: string;
  valor_original: string;
}

export interface LinhaImportPreview {
  linha: number;
  empresa: string;
  doc_cnpj_cpf: string;
  limite_operacao: number | null;
  dt_analise: string | null;
  dt_validade: string | null;
  consultoria: string | null;
  observacoes: string | null;
  escopo_limite: EscopoLimite;
  grupo_chave: string | null;
  avisos: ImportAviso[];
  rejeitada: boolean;
  motivo_rejeicao?: string;
}

export function cleanDoc(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

/** Normaliza CNPJ (14) ou CPF (11) com pad de zeros à esquerda. */
export function normalizeDoc(docRaw: unknown): string {
  const digits = cleanDoc(docRaw);
  if (!digits) return "";
  if (digits.length <= 11) return digits.padStart(11, "0");
  return digits.padStart(14, "0");
}

function calcCnpjCheckDigit(base: string, weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    sum += Number(base[i]) * weights[i];
  }
  const mod = sum % 11;
  return mod < 2 ? 0 : 11 - mod;
}

export function isValidCnpj(cnpj: string): boolean {
  const d = normalizeDoc(cnpj);
  if (d.length !== 14) return false;
  if (/^(\d)\1+$/.test(d)) return false;
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = calcCnpjCheckDigit(d.slice(0, 12), w1);
  const d2 = calcCnpjCheckDigit(d.slice(0, 12) + d1, w2);
  return d.slice(12) === `${d1}${d2}`;
}

export function isValidCpf(cpf: string): boolean {
  const d = normalizeDoc(cpf);
  if (d.length !== 11) return false;
  if (/^(\d)\1+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i);
  let mod = (sum * 10) % 11;
  if (mod === 10) mod = 0;
  if (mod !== Number(d[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(d[i]) * (11 - i);
  mod = (sum * 10) % 11;
  if (mod === 10) mod = 0;
  return mod === Number(d[10]);
}

export function isValidDoc(doc: string): boolean {
  const d = normalizeDoc(doc);
  if (d.length === 14) return isValidCnpj(d);
  if (d.length === 11) return isValidCpf(d);
  return false;
}

export {
  normalizeHeaderKey as normalizeHeader,
  mapHeadersFromKeys,
  parseLimiteCampo,
  parseDataCampo,
  parseLinhaPlanilhaConsultoria,
  parseRowsCadastroPartes,
} from "./cadastroPartesParse";
export type { ParseDataResult, ParseLimiteResult } from "./cadastroPartesParse";

/** Compat: retorna valor ou null (sem distinguir ausente vs. não numérico). */
export function parseBrMoney(v: unknown): number | null {
  const r = parseLimiteCampo(v);
  return r.rejeitar ? null : r.value;
}

/** Compat: use parseDataCampo para pendente/inválido distintos. */
export function parseDateFlexible(v: unknown): { date: string | null; invalid: boolean; pendente?: boolean } {
  const r = parseDataCampo(v);
  return { date: r.date, invalid: r.invalid, pendente: r.pendente };
}

export function detectPossivelGrupo(empresa: string, observacoes: string): boolean {
  const text = `${empresa} ${observacoes}`.toUpperCase();
  return text.includes("(GRUPO)") || text.includes("GRUPO ");
}

export function mapHeadersFromRow(row: Record<string, unknown>): Record<string, string> {
  return mapHeadersFromKeys(Object.keys(row));
}

export function hydrateCadastroPartesParams(raw: Record<string, unknown> | null | undefined): CadastroPartesParams {
  const p = raw ?? {};
  return {
    verificar_cedente: p.verificar_cedente !== false,
    verificar_sacado: p.verificar_sacado === true,
    base_calculo: String(p.base_calculo ?? CADASTRO_PARTES_DEFAULTS.base_calculo),
    usar_abatimento_pdd: p.usar_abatimento_pdd !== false,
    usar_grupo_economico: p.usar_grupo_economico !== false,
    politica_nao_cadastrado: (p.politica_nao_cadastrado as PoliticaCadastro) ?? CADASTRO_PARTES_DEFAULTS.politica_nao_cadastrado,
    politica_cadastro_vencido: (p.politica_cadastro_vencido as PoliticaCadastro) ?? CADASTRO_PARTES_DEFAULTS.politica_cadastro_vencido,
    politica_revisao_pendente: (p.politica_revisao_pendente as PoliticaCadastro) ?? CADASTRO_PARTES_DEFAULTS.politica_revisao_pendente,
    validade_inclusiva: p.validade_inclusiva !== false,
  };
}

export function isCadastroVencido(
  dataCessao: string,
  dtValidade: string | null,
  validadeInclusiva: boolean,
): boolean {
  if (!dtValidade) return false;
  if (validadeInclusiva) return dataCessao > dtValidade;
  return dataCessao >= dtValidade;
}

export function formatBRL(value: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

export function buildCodigoCadastroPartes(fundoCnpj: string): string {
  const suffix = cleanDoc(fundoCnpj).slice(-6);
  return `CESSAO_CADASTRO_PARTES_${suffix}`;
}

