/**
 * Fan-out do organograma: agrega instâncias repetidas (CNPJ / nome) e aplica top-N
 * com bucket "+N posições menores" expansível por coluna.
 */

import { isNoFundo, isNoCotista } from "./keys";
import type { InstanciaNo } from "./expansao";

/** Máximo de linhas visíveis por coluna antes do bucket. */
export const FANOUT_TOP_N = 10;

export type LinhaOrganograma =
  | {
      tipo: "instancia";
      inst: InstanciaNo;
      layoutKey: string;
      pctExibicao: number;
      /** Todas as instâncias agregadas na linha (ex.: ACARI via P12 e via SET). */
      todasInstancias: InstanciaNo[];
    }
  | {
      tipo: "bucket";
      layoutKey: string;
      depth: number;
      count: number;
      pctTotal: number;
      instancias: InstanciaNo[];
    };

/**
 * Chave de agregação por tipo de nó:
 * - Fundo: CNPJ key (consolida tranches)
 * - Cotista: key individual (cada cotista é distinto, não agrega por nome)
 * - Ativo: rótulo normalizado (agrupa ativos com mesmo nome)
 */
export function chaveAgregacao(nodeKey: string, rotulo: string): string {
  if (isNoFundo(nodeKey)) return nodeKey;
  if (isNoCotista(nodeKey)) return nodeKey;
  return `ativo:${rotulo.trim().toLowerCase()}`;
}

/** Mantém a instância de maior pctCaminho por node key na coluna. */
export function deduplicarPorNodeKey(instancias: InstanciaNo[]): InstanciaNo[] {
  const best = new Map<string, InstanciaNo>();
  for (const inst of instancias) {
    const cur = best.get(inst.key);
    if (!cur || inst.pctCaminho > cur.pctCaminho) best.set(inst.key, inst);
  }
  return [...best.values()];
}

export interface GrupoAgregado {
  aggKey: string;
  inst: InstanciaNo;
  pctAgregado: number;
  count: number;
  /** Todas as instâncias do grupo (para remapeamento de arestas). */
  todasInstancias: InstanciaNo[];
}

export function agruparInstanciasColuna(
  instancias: InstanciaNo[],
  rotulos: Map<string, string>,
): GrupoAgregado[] {
  const groups = new Map<string, GrupoAgregado>();

  for (const inst of instancias) {
    const rotulo = rotulos.get(inst.key) ?? inst.key;
    const aggKey = chaveAgregacao(inst.key, rotulo);
    const g = groups.get(aggKey);
    if (!g) {
      groups.set(aggKey, {
        aggKey,
        inst,
        pctAgregado: inst.pctCaminho,
        count: 1,
        todasInstancias: [inst],
      });
    } else {
      g.pctAgregado += inst.pctCaminho;
      g.count += 1;
      g.todasInstancias.push(inst);
      if (inst.pctCaminho > g.inst.pctCaminho) g.inst = inst;
    }
  }

  return [...groups.values()];
}

export function aplicarTopNColuna(
  grupos: GrupoAgregado[],
  depth: number,
  topN: number,
  colunasExpandidas: Set<number>,
  /** Prefixo adicionado ao layoutKey do bucket (evita colisão no organograma bidirecional). */
  bucketKeyPrefix = "",
): LinhaOrganograma[] {
  const sorted = [...grupos].sort((a, b) => b.pctAgregado - a.pctAgregado);

  const mostrarTodos = depth === 0 || colunasExpandidas.has(depth) || sorted.length <= topN;

  if (mostrarTodos) {
    return sorted.map((g) => ({
      tipo: "instancia" as const,
      inst: g.inst,
      layoutKey: g.inst.instanceId,
      pctExibicao: g.pctAgregado,
      todasInstancias: g.todasInstancias,
    }));
  }

  const top = sorted.slice(0, topN);
  const rest = sorted.slice(topN);
  const linhas: LinhaOrganograma[] = top.map((g) => ({
    tipo: "instancia",
    inst: g.inst,
    layoutKey: g.inst.instanceId,
    pctExibicao: g.pctAgregado,
    todasInstancias: g.todasInstancias,
  }));

  if (rest.length > 0) {
    const bucketKey = `${bucketKeyPrefix}bucket@${depth}`;
    linhas.push({
      tipo: "bucket",
      layoutKey: bucketKey,
      depth,
      count: rest.reduce((s, g) => s + g.count, 0),
      pctTotal: rest.reduce((s, g) => s + g.pctAgregado, 0),
      instancias: rest.flatMap((g) => g.todasInstancias),
    });
  }

  return linhas;
}

/** Mapeia instanceId → layoutKey visível (inclui instâncias dentro de bucket). */
export function buildInstanceToLayoutKey(
  linhasPorDepth: Map<number, LinhaOrganograma[]>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const linhas of linhasPorDepth.values()) {
    for (const linha of linhas) {
      if (linha.tipo === "instancia") {
        for (const inst of linha.todasInstancias) {
          map.set(inst.instanceId, linha.layoutKey);
        }
      } else {
        for (const inst of linha.instancias) {
          map.set(inst.instanceId, linha.layoutKey);
        }
      }
    }
  }
  return map;
}
