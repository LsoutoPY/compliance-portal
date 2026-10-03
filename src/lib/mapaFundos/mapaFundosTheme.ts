/**
 * Tokens visuais compartilhados — todos os modos do Mapa de Fundos.
 */

import type { ArestaRede } from "./snapshot";

/** Cota entre fundos (look-through). */
export const MAPA_EDGE_COTA = "rgba(22, 163, 74, 0.85)";
/** Tranche subordinada / mezanino. */
export const MAPA_EDGE_SUB = "rgba(220, 38, 38, 0.85)";
/** Posição em ativo da carteira (título, caixa, etc.). */
export const MAPA_EDGE_ATIVO = "rgba(2, 132, 199, 0.85)";
/** Passivo: cotista → fundo (dados de passivo_fundos). */
export const MAPA_EDGE_PASSIVO = "rgba(29, 78, 216, 0.85)";
export const MAPA_EDGE_OFF = "#cbd5e1";

export function corArestaMapa(e: Pick<ArestaRede, "isSubordinada" | "tipo">, off = false): string {
  if (off) return MAPA_EDGE_OFF;
  if (e.isSubordinada) return MAPA_EDGE_SUB;
  if (e.tipo === "ativo") return MAPA_EDGE_ATIVO;
  if (e.tipo === "passivo") return MAPA_EDGE_PASSIVO;
  return MAPA_EDGE_COTA;
}

/** Cores sólidas e mais contrastantes para o organograma em colunas. */
export function corArestaOrganograma(e: Pick<ArestaRede, "isSubordinada" | "tipo">): string {
  if (e.isSubordinada) return "#dc2626";
  if (e.tipo === "ativo") return "#0369a1";
  if (e.tipo === "passivo") return "#1d4ed8";   // azul uniforme para todas as arestas passivo
  return "#15803d";
}

/** Cor do nó cotista (modo organograma e rede). */
export const COR_NO_COTISTA = "#1d4ed8";
/** Cor da borda do nó cotista. */
export const COR_BORDA_COTISTA = "#1e3a8a";
