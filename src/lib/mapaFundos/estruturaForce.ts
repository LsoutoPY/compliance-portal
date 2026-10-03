import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from 'd3-force';
import { CARD_ESTRUTURA, type ArestaGrafoEstrutura, type NoGrafoEstrutura } from './exploracao';

export interface EstruturaSimNode {
  id: string;
  col: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number | null;
  fy?: number | null;
}

export type EstruturaForceSim = Simulation<EstruturaSimNode, undefined>;

export function createEstruturaForceSimulation(
  nos: NoGrafoEstrutura[],
  arestas: ArestaGrafoEstrutura[],
  layout: Map<string, { x: number; y: number }>,
  onTick: (pos: Map<string, { x: number; y: number }>) => void,
): EstruturaForceSim {
  const cols = [...new Set(nos.map(n => n.col))].sort((a, b) => a - b);
  const colX = new Map(cols.map((c, i) => [c, CARD_ESTRUTURA.pad + i * (CARD_ESTRUTURA.w + CARD_ESTRUTURA.gapX)]));
  const nodes: EstruturaSimNode[] = nos.map(n => {
    const p = layout.get(n.key) ?? { x: colX.get(n.col) ?? 0, y: CARD_ESTRUTURA.pad };
    return { id: n.key, col: n.col, x: p.x, y: p.y, vx: 0, vy: 0 };
  });
  const ids = new Set(nodes.map(n => n.id));
  const links = arestas
    .filter(a => ids.has(a.source) && ids.has(a.target) && a.source !== a.target)
    .map(a => ({ source: a.source, target: a.target }));
  const midY = CARD_ESTRUTURA.pad + Math.max(1, ...cols.map(c => nos.filter(n => n.col === c).length)) * (CARD_ESTRUTURA.h + CARD_ESTRUTURA.gapY) / 2;

  const sim = forceSimulation(nodes)
    .force('x', forceX<EstruturaSimNode>(d => colX.get(d.col) ?? d.x).strength(0.55))
    .force('y', forceY<EstruturaSimNode>(midY).strength(0.02))
    .force(
      'link',
      forceLink(links)
        .id((d: EstruturaSimNode) => d.id)
        .distance(CARD_ESTRUTURA.w + 72)
        .strength(0.45),
    )
    .force('charge', forceManyBody<EstruturaSimNode>().strength(-55).distanceMax(420))
    .force(
      'collide',
      forceCollide<EstruturaSimNode>(Math.max(CARD_ESTRUTURA.w, CARD_ESTRUTURA.h) / 2 + 10).strength(0.9).iterations(2),
    )
    .alpha(0.85)
    .alphaDecay(0.022)
    .velocityDecay(0.28)
    .on('tick', () => {
      const pos = new Map<string, { x: number; y: number }>();
      for (const n of nodes) pos.set(n.id, { x: n.x, y: n.y });
      onTick(pos);
    });
  return sim;
}

export function pinEstruturaNode(sim: EstruturaForceSim, id: string, x: number, y: number) {
  const n = sim.nodes().find(d => d.id === id);
  if (!n) return;
  n.fx = x;
  n.fy = y;
  n.x = x;
  n.y = y;
  sim.alphaTarget(0.28).alpha(0.4).restart();
}

export function dropEstruturaNode(sim: EstruturaForceSim, id: string) {
  const n = sim.nodes().find(d => d.id === id);
  if (!n) return;
  n.fx = n.x;
  n.fy = n.y;
  sim.alphaTarget(0).alpha(0.25).restart();
}

export function soltarPinsEstrutura(sim: EstruturaForceSim) {
  for (const n of sim.nodes()) {
    n.fx = null;
    n.fy = null;
  }
  sim.alpha(0.8).alphaTarget(0).restart();
}
