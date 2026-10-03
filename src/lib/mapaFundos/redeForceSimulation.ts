/**
 * Simulação de força contínua (d3-force) para o modo Rede completa.
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceRadial,
  type Simulation,
} from "d3-force";

export const REDE_WORLD_W = 1000;
export const REDE_WORLD_H = 700;

export interface RedeSimNodeInput {
  id: string;
  x: number;
  y: number;
  radius: number;
  degree: number;
}

export interface RedeSimLinkInput {
  source: string;
  target: string;
}

interface SimNode {
  id: string;
  x: number;
  y: number;
  radius: number;
  degree: number;
  fx?: number | null;
  fy?: number | null;
}

export function buildDegreeMap(
  nodeIds: string[],
  links: RedeSimLinkInput[],
): Map<string, number> {
  const degree = new Map<string, number>();
  for (const id of nodeIds) degree.set(id, 0);
  const seen = new Set<string>();
  for (const l of links) {
    if (!degree.has(l.source) || !degree.has(l.target)) continue;
    const pair = l.source < l.target ? `${l.source}|${l.target}` : `${l.target}|${l.source}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  return degree;
}

function radialTarget(nodes: RedeSimNodeInput[]): (d: SimNode) => number {
  const maxDeg = Math.max(1, ...nodes.map((n) => n.degree));
  const maxR = Math.min(REDE_WORLD_W, REDE_WORLD_H) * 0.44;
  return (d: SimNode) => {
    const t = 1 - d.degree / maxDeg;
    return 40 + t * maxR;
  };
}

export function createRedeForceSimulation(
  nodes: RedeSimNodeInput[],
  links: RedeSimLinkInput[],
  onTick: () => void,
): Simulation<SimNode, undefined> {
  const n = nodes.length;
  const simNodes: SimNode[] = nodes.map((nd) => ({
    id: nd.id,
    x: nd.x,
    y: nd.y,
    radius: nd.radius,
    degree: nd.degree,
  }));

  const idSet = new Set(simNodes.map((d) => d.id));
  const simLinks = links
    .filter((l) => idSet.has(l.source) && idSet.has(l.target) && l.source !== l.target)
    .map((l) => ({ source: l.source, target: l.target }));

  const charge = -Math.max(120, Math.min(520, 160 + n * 2.2));
  const radial = radialTarget(nodes);
  const cx = REDE_WORLD_W / 2;
  const cy = REDE_WORLD_H / 2;

  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink(simLinks)
        .id((d: SimNode) => d.id)
        .distance((l) => {
          const s = l.source as SimNode;
          const t = l.target as SimNode;
          return 55 + (s.radius + t.radius) * 0.6;
        })
        .strength(0.35),
    )
    .force("charge", forceManyBody<SimNode>().strength(charge).distanceMax(900))
    .force(
      "collide",
      forceCollide<SimNode>()
        .radius((d) => d.radius + 6)
        .strength(0.85)
        .iterations(2),
    )
    .force(
      "radial",
      forceRadial<SimNode>((d) => radial(d), cx, cy).strength(0.12),
    )
    .alphaDecay(0.012)
    .alphaMin(0.002)
    .velocityDecay(0.35)
    .on("tick", onTick);

  sim.alpha(1).restart();
  return sim;
}

export type RedeForceSimulation = Simulation<SimNode, undefined>;

export function getSimPositions(sim: RedeForceSimulation): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const nd of sim.nodes() ?? []) {
    if (nd.x != null && nd.y != null) out.set(nd.id, { x: nd.x, y: nd.y });
  }
  return out;
}

export function pinSimNode(sim: RedeForceSimulation, id: string, x: number, y: number): void {
  const nd = sim.nodes()?.find((n) => n.id === id);
  if (!nd) return;
  nd.fx = x;
  nd.fy = y;
  sim.alphaTarget(0.25).alpha(0.45).restart();
}

export function releaseSimNode(sim: RedeForceSimulation, id: string): void {
  const nd = sim.nodes()?.find((n) => n.id === id);
  if (!nd) return;
  nd.fx = null;
  nd.fy = null;
  sim.alphaTarget(0).alpha(0.35).restart();
}

export function reheatSimulation(sim: RedeForceSimulation, alpha = 0.3): void {
  sim.alphaTarget(0).alpha(alpha).restart();
}
