/**
 * Calcula o choque de stress de liquidez.
 *
 * Regra:
 *   1. Seleciona os 3 maiores cotistas por valor (N fixo = 3).
 *   2. Soma os 3 → candidata cotistas.
 *   3. Se candidata > 20% PL → cap em 20% PL (teto).
 *   4. Se candidata ≤ 20% PL → choque = 20% PL (piso).
 *   → CHOQUE = MAX(20% PL, MIN(soma_top3, 20% PL)) = 20% do PL.
 *
 * O campo `somaCotistasTop3` mostra o valor bruto dos top 3 para contexto.
 * O campo `binding` indica se a soma ultrapassou o teto ("cap20") ou
 * ficou abaixo do piso ("piso20").
 *
 * Edge-cases:
 *   - PL ≤ 0 → choque = 0 (sem referência válida).
 *   - Lista de cotistas vazia → candidata = 0, choque = piso20.
 */

export interface LiquidezStressChoqueResult {
  /** Valor do choque a ser somado ao passivo do vértice do prazo (R$). */
  choque: number;
  /** 20% do PL — piso mínimo e teto máximo do choque. */
  piso20: number;
  /** Soma bruta dos top 3 cotistas (pode ser > ou < piso20). */
  somaCotistasTop3: number;
  /** Quantos cotistas entram no cálculo (0–3). */
  nCotistasTop3: number;
  /** "cap20" quando top3 > 20% PL (teto ativado); "piso20" nos demais casos. */
  binding: "piso20" | "cap20";
}

/**
 * @param plFund           PL do fundo na data de referência (totalPL da Edge Function).
 * @param valoresDescTop3  Valores em R$ dos cotistas, ordenados do maior para menor, máx 3 itens.
 */
export function computeLiquidezStressChoque(
  plFund: number,
  valoresDescTop3: number[],
): LiquidezStressChoqueResult {
  if (plFund <= 0) {
    return { choque: 0, piso20: 0, somaCotistasTop3: 0, nCotistasTop3: 0, binding: "piso20" };
  }

  const piso20 = plFund * 0.2;
  const lista = valoresDescTop3.slice(0, 3);
  const somaCotistasTop3 = lista.reduce((s, v) => s + v, 0);

  // Choque é sempre 20% do PL:
  //   - Se soma top 3 > 20% PL → cotistas excedem o teto; usamos 20% (cap).
  //   - Se soma top 3 ≤ 20% PL → cotistas estão abaixo do piso; usamos 20% (piso).
  const binding: "piso20" | "cap20" = somaCotistasTop3 > piso20 ? "cap20" : "piso20";
  const choque = piso20;

  return { choque, piso20, somaCotistasTop3, nCotistasTop3: lista.length, binding };
}
