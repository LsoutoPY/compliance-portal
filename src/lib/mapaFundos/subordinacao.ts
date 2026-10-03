/**
 * Detecção de tranches subordinadas — sinal da ARESTA, independente do grupo do nó.
 *
 * "É REAG" e "é tranche subordinada" são perguntas ortogonais:
 *  - resolveGrupoNo → cor do NÓ (A/B/C/H/R/CVPAR/CASA/EXT)
 *  - isTrancheSubordinada → estilo da ARESTA (vermelho)
 * Ambas rodam sempre; nunca uma substitui a outra.
 */

const SUBORDINADA_RE =
  /\b(SUB|SUBORDINADA?|JR|J[ÚU]NIOR|MZ|MEZANINO|MEZZAN[I]?NO)\b/i;

/**
 * Retorna true se o nome da posição indica tranche subordinada/mezanino/júnior.
 * Usar com o `nomecomercial` (ou `nome_fundo`) da linha de posicao_carteira — por aresta.
 */
export function isTrancheSubordinada(nome: string | null | undefined): boolean {
  if (!nome?.trim()) return false;
  return SUBORDINADA_RE.test(nome);
}

/** Label de exibição para tooltip/legenda. */
export function labelSubordinacao(isSubordinada: boolean): string {
  return isSubordinada ? "Subordinada / Mezanino" : "Sênior / Base";
}
