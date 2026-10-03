/**
 * Chaves canônicas do Mapa de Fundos.
 *
 * Regra central: um nó por CNPJ de fundo (independente de quantas tranches/ISINs).
 * Arestas usam discriminant (isin + nome) para permanecer granulares por tranche.
 */

export const PREFIXO_FUNDO = "fundo:";
export const PREFIXO_ATIVO = "ativo:";
export const PREFIXO_COTISTA = "cotista:";

/**
 * Chave canônica de cotista PF/PJ (não-fundo).
 * Prefere codigo_clt para identidade estável; fallback por nome normalizado.
 */
export function buildCotistaKey(codigoClt: number | null, nome: string): string {
  if (codigoClt != null) return `${PREFIXO_COTISTA}clt:${codigoClt}`;
  const slug = nome
    .normalize("NFC")
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_]/g, "")
    .slice(0, 60);
  return `${PREFIXO_COTISTA}nome:${slug}`;
}

export function isNoCotista(key: string): boolean {
  return key.startsWith(PREFIXO_COTISTA);
}

/** Chave de exibição canônica: um círculo por CNPJ. */
export function buildFundoDisplayKey(cnpj: string): string {
  const digits = cnpj.replace(/\D/g, "").padStart(14, "0");
  return `${PREFIXO_FUNDO}${digits}`;
}

/** Extrai o CNPJ (14 dígitos) de uma chave de exibição de fundo. */
export function cnpjFromDisplayKey(key: string): string {
  return key.replace(PREFIXO_FUNDO, "");
}

/**
 * Chave de aresta com discriminant de tranche.
 * Cada linha de posicao_carteira gera ID próprio — nunca colapsa tranches.
 */
export function buildArestaId(
  source: string,
  target: string,
  isinInvestido: string | null | undefined,
  nomePosicao: string | null | undefined,
): string {
  const parts = [source, target];
  if (isinInvestido?.trim()) parts.push(isinInvestido.trim());
  if (nomePosicao?.trim()) parts.push(nomePosicao.trim().slice(0, 40));
  return parts.join("||");
}

/** Prefixo de chave de ativo (wrapper de ativoKey de getAtivoKeyFromRow). */
export function keyAtivoRede(ativoKey: string): string {
  return `${PREFIXO_ATIVO}${ativoKey}`;
}

export function isNoAtivo(key: string): boolean {
  return key.startsWith(PREFIXO_ATIVO);
}

export function isNoFundo(key: string): boolean {
  return key.startsWith(PREFIXO_FUNDO);
}

/** % PL mínimo para arestas de ativos (títulos, caixa, etc.). */
export const PCT_PL_MINIMO = 1e-5;

/** % acumulado mínimo na árvore revelada (abaixo disso = cota fantasma / 0.0%). */
export const PCT_CAMINHO_MINIMO = 5e-4;

/** Cotas declaradas no XML entram no grafo mesmo com 0% PL (ex.: SET → BACO). */
export function incluirCotaNoGrafo(pctPl: number): boolean {
  return Number.isFinite(pctPl) && pctPl >= 0;
}

export function incluirAtivoNoGrafo(pctPl: number): boolean {
  return pctPl >= PCT_PL_MINIMO;
}
