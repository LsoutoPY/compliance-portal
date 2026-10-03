/**
 * Expansão BFS por nível para o Mapa de Fundos.
 *
 * Múltiplas arestas entre o mesmo par (ex.: 4 tranches Pedra Azul) são tratadas
 * individualmente no grafo de arestas; pctAcum no nó é a soma de todas elas.
 */

import type { ArestaRede } from "./snapshot";
import { incluirAtivoNoGrafo, incluirCotaNoGrafo, isNoAtivo, isNoCotista, PCT_CAMINHO_MINIMO } from "./keys";

export type DirecaoRede = "passivo" | "ativo";

export const DIRECAO_LABEL: Record<DirecaoRede, string> = {
  passivo: "Passivo — quem investe aqui (sobe)",
  ativo: "Ativo — carteira e look-through (desce)",
};

export interface NoDestaque {
  depth: number;
  /** Soma acumulada de todos os caminhos/tranches que chegam neste nó */
  pctAcum: number;
  /** Todos os níveis em que o nó aparece na expansão (look-through convergente) */
  profundidades: number[];
}

/** Instância visual — um nó por caminho (organograma em colunas). */
export interface InstanciaNo {
  instanceId: string;
  key: string;
  depth: number;
  pctCaminho: number;
}

export interface ArestaInstancia {
  edgeId: string;
  sourceInstanceId: string;
  targetInstanceId: string;
}

export interface ResultadoExpansao {
  nosAtivos: Map<string, NoDestaque>;
  arestasAtivas: Set<string>;
  /** Chaves que aparecem em mais de um caminho ou nível */
  nosRepetidos: Set<string>;
  /** Colunas do organograma (permite repetir o mesmo fundo/ativo) */
  instanciasPorNivel: Map<number, InstanciaNo[]>;
  /** Arestas entre instâncias (organograma) */
  arestasInstancia: ArestaInstancia[];
}

function registrarInstancia(
  key: string,
  depth: number,
  pctCaminho: number,
  instanciasPorNivel: Map<number, InstanciaNo[]>,
  contador: Map<string, number>,
): InstanciaNo {
  const slot = `${key}|${depth}`;
  const idx = contador.get(slot) ?? 0;
  contador.set(slot, idx + 1);
  const instanceId = idx === 0 ? `${key}@${depth}` : `${key}@${depth}#${idx}`;
  const inst: InstanciaNo = { instanceId, key, depth, pctCaminho };
  const list = instanciasPorNivel.get(depth) ?? [];
  list.push(inst);
  instanciasPorNivel.set(depth, list);
  return inst;
}

/** Marca nós que aparecem mais de uma vez na árvore revelada. */
export function calcularNosRepetidos(
  instanciasPorNivel: Map<number, InstanciaNo[]>,
): Set<string> {
  const ocorrencias = new Map<string, number>();
  const profundidades = new Map<string, Set<number>>();

  for (const instancias of instanciasPorNivel.values()) {
    for (const inst of instancias) {
      ocorrencias.set(inst.key, (ocorrencias.get(inst.key) ?? 0) + 1);
      const depths = profundidades.get(inst.key) ?? new Set<number>();
      depths.add(inst.depth);
      profundidades.set(inst.key, depths);
    }
  }

  const repetidos = new Set<string>();
  for (const [key, count] of ocorrencias) {
    if (count > 1 || (profundidades.get(key)?.size ?? 0) > 1) {
      repetidos.add(key);
    }
  }
  return repetidos;
}

type AdjEntry = {
  neighbor: string;
  edgeId: string;
  pctPl: number;
  leaf: boolean;
  isSubordinada: boolean;
};

/** Opções de expansão passiva (L1 planilha vs XML). */
export interface ExpansaoPassivoOpts {
  /** Fundos cujo cotista já veio do passivo_fundos — suprime XML L1 por investidor. */
  fundosJaNoPassivo?: Set<string>;
  /**
   * Fundo monitorado com passivo importado: ignora todas as cotas XML cujo alvo
   * é o seed (L1). Expansão L2+ via XML permanece inalterada.
   */
  passivoSomentePlanilhaSeed?: string;
}

function normalizePassivoOpts(opts?: ExpansaoPassivoOpts | Set<string>): ExpansaoPassivoOpts {
  if (!opts) return {};
  if (opts instanceof Set) return { fundosJaNoPassivo: opts };
  return opts;
}

function buildAdj(
  arestas: ArestaRede[],
  direcao: DirecaoRede,
  passivoOpts: ExpansaoPassivoOpts = {},
): Map<string, AdjEntry[]> {
  const fundosJaNoPassivo = passivoOpts.fundosJaNoPassivo ?? new Set<string>();
  const passivoSomentePlanilhaSeed = passivoOpts.passivoSomentePlanilhaSeed;
  const adj = new Map<string, AdjEntry[]>();

  const add = (
    from: string,
    to: string,
    edgeId: string,
    pctPl: number,
    leaf: boolean,
    isSubordinada: boolean,
  ) => {
    const list = adj.get(from) ?? [];
    list.push({ neighbor: to, edgeId, pctPl, leaf, isSubordinada });
    adj.set(from, list);
  };

  for (const e of arestas) {
    // Arestas de passivo_fundos (cotista→fundo): tratadas apenas no modo passivo.
    if (e.tipo === "passivo") {
      if (direcao === "passivo") {
        // Inverte para BFS: fundo → cotista/fundo-cotista.
        // Cotistas PF/PJ (isNoCotista) são folhas; fundos identificados não são.
        add(e.target, e.source, e.id, e.pctPl, isNoCotista(e.source), false);
      }
      continue;
    }

    if (e.tipo === "cota") {
      if (!incluirCotaNoGrafo(e.pctPl)) continue;
    } else if (!incluirAtivoNoGrafo(e.pctPl)) continue;

    if (direcao === "passivo" && e.tipo === "ativo") continue;

    if (direcao === "ativo") {
      add(
        e.source,
        e.target,
        e.id,
        e.pctPl,
        e.tipo === "ativo" || isNoAtivo(e.target),
        e.isSubordinada,
      );
    } else {
      // passivo: sobe pelo grafo de cotas (inverte direção).
      // Fundo gestor com passivo importado: L1 só planilha — pula cotas XML no seed.
      if (
        passivoSomentePlanilhaSeed &&
        e.tipo === "cota" &&
        e.target === passivoSomentePlanilhaSeed
      ) {
        continue;
      }
      // Pula se o fundo investidor já está coberto pelo passivo_fundos — a aresta
      // passivo correspondente já foi injetada com dados mais precisos.
      if (fundosJaNoPassivo.has(e.source)) continue;
      add(e.target, e.source, e.id, e.pctPl, false, e.isSubordinada);
    }
  }
  return adj;
}

/**
 * Calcula a profundidade máxima possível a partir de um seed, sem limite artificial.
 * Usado para definir dinamicamente o teto do stepper de nível.
 *
 * Guard de segurança: limite absoluto de 30 saltos para evitar ciclos
 * (improvável na prática, mas defensivo).
 */
export function calcMaxDepthPossivel(
  seedKey: string,
  direcao: DirecaoRede,
  arestas: ArestaRede[],
  passivoOpts?: ExpansaoPassivoOpts | Set<string>,
): number {
  if (!seedKey) return 0;
  const GUARD = 30;
  const r = expandirRedePorNivel(seedKey, GUARD, direcao, arestas, passivoOpts);
  if (r.nosAtivos.size <= 1) return 0;
  let maxD = 0;
  for (const { depth } of r.nosAtivos.values()) {
    if (depth > maxD) maxD = depth;
  }
  return maxD;
}

export function expandirRedePorNivel(
  seedKey: string,
  maxDepth: number,
  direcao: DirecaoRede,
  arestas: ArestaRede[],
  passivoOpts?: ExpansaoPassivoOpts | Set<string>,
): ResultadoExpansao {
  const opts = normalizePassivoOpts(passivoOpts);
  const nosAtivos = new Map<string, NoDestaque>();
  const arestasAtivas = new Set<string>();
  const instanciasPorNivel = new Map<number, InstanciaNo[]>();
  const arestasInstancia: ArestaInstancia[] = [];
  const contadorInstancia = new Map<string, number>();
  const profundidadesPorNo = new Map<string, Set<number>>();

  const empty: ResultadoExpansao = {
    nosAtivos,
    arestasAtivas,
    nosRepetidos: new Set(),
    instanciasPorNivel,
    arestasInstancia,
  };

  if (!seedKey || maxDepth < 0) return empty;

  const addProfundidade = (key: string, depth: number) => {
    const set = profundidadesPorNo.get(key) ?? new Set<number>();
    set.add(depth);
    profundidadesPorNo.set(key, set);
  };

  const seedInst = registrarInstancia(seedKey, 0, 1, instanciasPorNivel, contadorInstancia);
  addProfundidade(seedKey, 0);
  nosAtivos.set(seedKey, { depth: 0, pctAcum: 1, profundidades: [0] });
  if (maxDepth === 0) {
    empty.nosRepetidos = calcularNosRepetidos(instanciasPorNivel);
    return empty;
  }

  const adj = buildAdj(arestas, direcao, opts);
  const queue: Array<{
    instanceId: string;
    key: string;
    depth: number;
    pct: number;
    /** Fundos já visitados neste caminho — evita ciclo (BACO→…→BACO). */
    path: Set<string>;
  }> = [
    {
      instanceId: seedInst.instanceId,
      key: seedKey,
      depth: 0,
      pct: 1,
      path: new Set([seedKey]),
    },
  ];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    // Ativos e cotistas PF/PJ são folhas — não há expansão a partir deles.
    if (isNoAtivo(cur.key) || isNoCotista(cur.key)) continue;

    for (const { neighbor, edgeId, pctPl, leaf, isSubordinada } of adj.get(cur.key) ?? []) {
      const nextDepth = cur.depth + 1;
      if (nextDepth > maxDepth) continue;

      // Mesmo fundo (CNPJ) no caminho = look-through circular inválido na árvore
      if (cur.path.has(neighbor)) continue;

      const nextPct = cur.pct * pctPl;
      // Cotas com 0% PL seguem no grafo; filtro de caminho só para posições com peso > 0.
      // Subordinação nunca é cortada só por peso — eixo independente de grupo/cor.
      if (!isSubordinada && pctPl > 0 && nextPct < PCT_CAMINHO_MINIMO) continue;

      arestasAtivas.add(edgeId);
      addProfundidade(neighbor, nextDepth);

      const childInst = registrarInstancia(
        neighbor,
        nextDepth,
        nextPct,
        instanciasPorNivel,
        contadorInstancia,
      );
      arestasInstancia.push({
        edgeId,
        sourceInstanceId: cur.instanceId,
        targetInstanceId: childInst.instanceId,
      });

      const prev = nosAtivos.get(neighbor);
      const depths = profundidadesPorNo.get(neighbor) ?? new Set<number>();
      if (prev) {
        nosAtivos.set(neighbor, {
          depth: Math.min(prev.depth, nextDepth),
          pctAcum: prev.pctAcum + nextPct,
          profundidades: [...depths].sort((a, b) => a - b),
        });
      } else {
        nosAtivos.set(neighbor, {
          depth: nextDepth,
          pctAcum: nextPct,
          profundidades: [...depths].sort((a, b) => a - b),
        });
      }

      if (!leaf && nextDepth < maxDepth) {
        const nextPath = new Set(cur.path);
        nextPath.add(neighbor);
        queue.push({
          instanceId: childInst.instanceId,
          key: neighbor,
          depth: nextDepth,
          pct: nextPct,
          path: nextPath,
        });
      }
    }
  }

  empty.nosRepetidos = calcularNosRepetidos(instanciasPorNivel);
  return empty;
}
