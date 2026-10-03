/**
 * Invariante automatizada: canvas organograma ↔ painel revelados.
 *
 * Previne o bug de convergência silenciosa (filtro lvl+1 do protótipo) de reaparecer:
 * toda aresta que o expansao.arestasInstancia inclui DEVE estar no conjunto drawn.
 * Toda instância revelada DEVE ter posição no layout.
 * O pctAcum usado no painel DEVE ser exatamente o de nosAtivos (tolerância 1e-6).
 */

import type { ResultadoExpansao } from "./expansao";

export interface DrawnOrganogram {
  /** IDs de todas as instâncias que receberam posição no layout. */
  instanceIds: Set<string>;
  /** IDs de todas as arestas instância que foram desenhadas. */
  arestaInstanciaIds: Set<string>;
  /** pctAcum usado no painel por node key (deve corresponder a nosAtivos). */
  painelPctAcum: Map<string, number>;
}

export type ConsistencyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verifica consistência entre o que o organograma declarou desenhar e os dados de expansão.
 *
 * Regras:
 *  1. Instâncias — todo inst em instanciasPorNivel (exceto depth=0/seed) ∈ drawn.instanceIds
 *  2. Arestas    — toda aresta com ambos os endpoints em drawn.instanceIds ∈ drawn.arestaInstanciaIds
 *  3. pctAcum    — valor usado no painel === nosAtivos.pctAcum (tolerância 1e-6)
 *  4. Contagem   — drawn.arestaInstanciaIds.size === arestas esperadas (não descarta silenciosamente)
 */
export function assertOrganogramConsistency(
  expansao: ResultadoExpansao,
  seedKey: string,
  drawn: DrawnOrganogram,
): ConsistencyResult {
  // Regra 1: todas as instâncias reveladas (excluindo o seed em depth=0) têm posição
  for (const [, instancias] of expansao.instanciasPorNivel) {
    for (const inst of instancias) {
      if (inst.key === seedKey && inst.depth === 0) continue;
      if (!drawn.instanceIds.has(inst.instanceId)) {
        return {
          ok: false,
          reason: `Instância ${inst.instanceId} (key=${inst.key}, depth=${inst.depth}) está em instanciasPorNivel mas não em drawn.instanceIds`,
        };
      }
    }
  }

  // Regra 2: todas as arestas cujos dois endpoints foram desenhados também foram desenhadas
  let expectedEdgeCount = 0;
  for (const aresta of expansao.arestasInstancia) {
    const srcDrawn = drawn.instanceIds.has(aresta.sourceInstanceId);
    const tgtDrawn = drawn.instanceIds.has(aresta.targetInstanceId);
    if (srcDrawn && tgtDrawn) {
      expectedEdgeCount++;
      if (!drawn.arestaInstanciaIds.has(aresta.edgeId)) {
        return {
          ok: false,
          reason: `Aresta ${aresta.edgeId} (${aresta.sourceInstanceId} → ${aresta.targetInstanceId}) ` +
            `tem ambos os endpoints no drawn mas não está em drawn.arestaInstanciaIds. ` +
            `(Possível regressão do filtro lvl+1 do protótipo)`,
        };
      }
    }
  }

  // Regra 4: contagem de arestas desenhadas bate com o esperado
  if (drawn.arestaInstanciaIds.size !== expectedEdgeCount) {
    return {
      ok: false,
      reason: `drawn.arestaInstanciaIds.size=${drawn.arestaInstanciaIds.size} mas esperado=${expectedEdgeCount}. ` +
        `Alguma aresta foi adicionada ao drawn sem passar pelos endpoints filtrados.`,
    };
  }

  // Regra 3: pctAcum do painel bate com nosAtivos
  for (const [key, painelPct] of drawn.painelPctAcum) {
    if (key === seedKey) continue;
    const dest = expansao.nosAtivos.get(key);
    if (!dest) {
      return {
        ok: false,
        reason: `Painel exibe key=${key} mas key não está em nosAtivos`,
      };
    }
    if (Math.abs(painelPct - dest.pctAcum) > 1e-6) {
      return {
        ok: false,
        reason: `pctAcum diverge para key=${key}: painel=${painelPct} vs nosAtivos=${dest.pctAcum}`,
      };
    }
  }

  return { ok: true };
}

/**
 * Constrói o DrawnOrganogram a partir das estruturas que o canvas e painel usam.
 * Permite testar sem DOM — basta passar os dados já computados.
 */
export function buildDrawnFromExpansao(
  expansao: ResultadoExpansao,
  seedKey: string,
): DrawnOrganogram {
  const instanceIds = new Set<string>();
  for (const instancias of expansao.instanciasPorNivel.values()) {
    for (const inst of instancias) {
      instanceIds.add(inst.instanceId);
    }
  }

  const arestaInstanciaIds = new Set<string>();
  for (const aresta of expansao.arestasInstancia) {
    if (instanceIds.has(aresta.sourceInstanceId) && instanceIds.has(aresta.targetInstanceId)) {
      arestaInstanciaIds.add(aresta.edgeId);
    }
  }

  const painelPctAcum = new Map<string, number>();
  for (const [key, dest] of expansao.nosAtivos) {
    if (key !== seedKey) painelPctAcum.set(key, dest.pctAcum);
  }

  return { instanceIds, arestaInstanciaIds, painelPctAcum };
}
