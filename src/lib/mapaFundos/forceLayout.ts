/**
 * Layout force-directed (estilo spring / bubble map) para modos de rede.
 * Calculado uma vez no buildSnapshot — determinístico por chave de nó.
 */

export interface ForceLayoutEdge {
  source: string;
  target: string;
}

interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
}

/** Hash determinístico → ângulo inicial [0, 2π). */
function seededAngle(id: string, index: number): number {
  let h = index * 2654435761;
  for (let i = 0; i < id.length; i++) {
    h = (h ^ id.charCodeAt(i)) * 16777619;
  }
  return ((h >>> 0) % 10_000) / 10_000 * Math.PI * 2;
}

function buildDegreeAndLinks(
  nodeKeys: string[],
  edges: ForceLayoutEdge[],
): { degree: Map<string, number>; links: Array<{ s: string; t: string }> } {
  const keySet = new Set(nodeKeys);
  const degree = new Map<string, number>();
  for (const k of nodeKeys) degree.set(k, 0);

  const linkSet = new Set<string>();
  const links: Array<{ s: string; t: string }> = [];

  for (const e of edges) {
    if (!keySet.has(e.source) || !keySet.has(e.target) || e.source === e.target) continue;
    const pair = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
    if (linkSet.has(pair)) continue;
    linkSet.add(pair);
    links.push({ s: e.source, t: e.target });
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  return { degree, links };
}

/**
 * Simulação de força leve: molas nas arestas, repulsão global, radial por grau.
 * Hubs (maior grau) gravitam para o centro; vizinhos conectados se atraem.
 */
export function computeForceLayout(
  nodeKeys: string[],
  edges: ForceLayoutEdge[],
  width = 1000,
  height = 700,
): Map<string, { x: number; y: number }> {
  const cx = width / 2;
  const cy = height / 2;
  const padding = 48;

  if (nodeKeys.length === 0) return new Map();

  if (nodeKeys.length === 1) {
    return new Map([[nodeKeys[0], { x: cx, y: cy }]]);
  }

  const { degree, links } = buildDegreeAndLinks(nodeKeys, edges);
  const maxDeg = Math.max(1, ...degree.values());
  const maxR = Math.min(width, height) * 0.38;

  const sorted = [...nodeKeys].sort();
  const nodes = new Map<string, SimNode>();

  sorted.forEach((id, i) => {
    const d = degree.get(id) ?? 0;
    const rFrac = 0.08 + 0.42 * (1 - d / maxDeg);
    const R = maxR * rFrac;
    const angle = seededAngle(id, i);
    nodes.set(id, {
      id,
      x: cx + R * Math.cos(angle),
      y: cy + R * Math.sin(angle),
      vx: 0,
      vy: 0,
      degree: d,
    });
  });

  const n = nodes.size;
  const iterations = Math.min(400, 80 + n * 3);
  let alpha = 1;

  const nodeList = () => [...nodes.values()];

  for (let iter = 0; iter < iterations; iter++) {
    for (const nd of nodes.values()) {
      nd.vx = 0;
      nd.vy = 0;
    }

    const linkDist = 70 + Math.min(40, n * 0.15);
    const linkK = 0.35 * alpha;
    for (const { s, t } of links) {
      const a = nodes.get(s)!;
      const b = nodes.get(t)!;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const f = ((dist - linkDist) * linkK) / dist;
      a.vx += dx * f;
      a.vy += dy * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
    }

    const repK = (600 + n * 8) * alpha;
    const list = nodeList();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const dist2 = dx * dx + dy * dy + 1;
        const f = repK / dist2;
        const dist = Math.sqrt(dist2);
        a.vx += (dx / dist) * f;
        a.vy += (dy / dist) * f;
        b.vx -= (dx / dist) * f;
        b.vy -= (dy / dist) * f;
      }
    }

    const radialK = 0.1 * alpha;
    for (const nd of nodes.values()) {
      const targetR = maxR * (0.12 + 0.88 * (1 - nd.degree / maxDeg));
      let dx = cx - nd.x;
      let dy = cy - nd.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const f = ((dist - targetR) * radialK) / dist;
      nd.vx += dx * f;
      nd.vy += dy * f;
    }

    const damp = 0.55;
    for (const nd of nodes.values()) {
      nd.vx *= damp;
      nd.vy *= damp;
      nd.x += nd.vx;
      nd.y += nd.vy;
      nd.x = Math.max(padding, Math.min(width - padding, nd.x));
      nd.y = Math.max(padding, Math.min(height - padding, nd.y));
    }

    alpha *= 0.985;
  }

  const out = new Map<string, { x: number; y: number }>();
  for (const [id, nd] of nodes) out.set(id, { x: nd.x, y: nd.y });
  return out;
}
