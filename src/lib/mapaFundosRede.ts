/**
 * Mapa fixo — fundos monitorados (anel interno) + ativos (anel externo).
 * Layout estático; BFS por nível destaca caminhos fundo→fundo→ativo.
 */

import { supabase } from "@/integrations/supabase/client";
import {
  getAtivoKeyFromRow,
  type PosicaoCarteiraRow,
} from "@/hooks/useRentabilidadeCalc";
import {
  buildFundoNodeKey,
  fetchParesMonitorados,
  normalizeCnpjDigits,
  type ParFundoMonitorado,
} from "@/lib/fundosMonitorados";

export type DirecaoRede = "passivo" | "ativo";

export const DIRECAO_REDE_LABEL: Record<DirecaoRede, string> = {
  passivo: "Passivo — quem investe aqui (sobe)",
  ativo: "Ativo — carteira e look-through (desce)",
};

export type TipoNoRede = "fundo" | "ativo";

export interface NoRede {
  key: string;
  tipo: TipoNoRede;
  nome: string;
  x: number;
  y: number;
  /** Preenchido para fundos */
  cnpj?: string;
  isin?: string;
  gestor?: string | null;
  /** Preenchido para ativos — section da posicao_carteira */
  section?: string;
}

export type TipoArestaRede = "cota" | "ativo";

export interface ArestaRede {
  id: string;
  source: string;
  target: string;
  pctPl: number;
  tipo: TipoArestaRede;
}

export interface RedeFundosSnapshot {
  nos: NoRede[];
  arestas: ArestaRede[];
  dtposicao: string;
  nFundos: number;
  nAtivos: number;
}

export interface NoDestaque {
  depth: number;
  pctAcum: number;
}

export interface ResultadoExpansao {
  nosAtivos: Map<string, NoDestaque>;
  arestasAtivas: Set<string>;
}

/** Sections de ativos incluídas no mapa (exclui despesas/provisao). */
const SECTIONS_ATIVOS_MAPA = [
  "titpublico",
  "titprivado",
  "caixa",
  "participacoes",
  "acoes",
  "termorf",
  "imoveis",
] as const;

const PREFIXO_ATIVO = "ativo:";

export function keyAtivoRede(ativoKey: string): string {
  return `${PREFIXO_ATIVO}${ativoKey}`;
}

export function isNoAtivo(key: string): boolean {
  return key.startsWith(PREFIXO_ATIVO);
}

export function isNoFundo(key: string): boolean {
  return !isNoAtivo(key);
}

function layoutCircular(
  items: Array<{ key: string }>,
  cx: number,
  cy: number,
  radius: number,
): Map<string, { x: number; y: number }> {
  const sorted = [...items].sort((a, b) => a.key.localeCompare(b.key));
  const pos = new Map<string, { x: number; y: number }>();
  sorted.forEach((item, i) => {
    const angle = (2 * Math.PI * i) / Math.max(sorted.length, 1) - Math.PI / 2;
    pos.set(item.key, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });
  return pos;
}

/** Fundos no anel interno, ativos no anel externo — posições fixas. */
export function computeLayoutFundosEAtivos(
  fundos: Array<{ key: string }>,
  ativos: Array<{ key: string }>,
  width = 1000,
  height = 700,
): Map<string, { x: number; y: number }> {
  const cx = width / 2;
  const cy = height / 2;
  const base = Math.min(width, height);
  const inner = layoutCircular(fundos, cx, cy, base * 0.30);
  const outer = layoutCircular(ativos, cx, cy, base * 0.46);
  return new Map([...inner, ...outer]);
}

function pctPlFromRow(row: Pick<PosicaoCarteiraRow, "fundo_patliq" | "valor_padrao">): number {
  if (!row.fundo_patliq || row.fundo_patliq <= 0 || row.valor_padrao == null) return 0;
  return row.valor_padrao / row.fundo_patliq;
}

function investedFundoKey(row: PosicaoCarteiraRow): string | null {
  const cnpj = row.cnpjfundo || row.cnpjemissor;
  if (!cnpj) return null;
  return buildFundoNodeKey(cnpj, row.isin ?? "");
}

function nomeAtivoFromRow(row: PosicaoCarteiraRow): string {
  if (row.nomecomercial?.trim()) return row.nomecomercial.trim();
  if (row.codativo?.trim()) return row.codativo.trim();
  if (row.isin?.trim()) return row.isin.trim();
  const sec = (row.section || "ativo").toLowerCase();
  if (sec === "caixa") return "Caixa";
  return sec;
}

function labelSection(sec: string): string {
  const map: Record<string, string> = {
    titpublico: "Tít. público",
    titprivado: "Tít. privado",
    caixa: "Caixa",
    participacoes: "Participação",
    acoes: "Ação",
    termorf: "Termo RF",
    imoveis: "Imóvel",
  };
  return map[sec] ?? sec;
}

/**
 * Carrega rede completa: fundos monitorados + ativos + arestas cota e carteira.
 */
export async function fetchRedeFundosSnapshot(dtposicao: string): Promise<RedeFundosSnapshot> {
  const pares = await fetchParesMonitorados(dtposicao);
  const nodeKeysMonitorados = new Set(pares.map((p) => buildFundoNodeKey(p.fundo_cnpj, p.fundo_isin)));

  const fundoMeta = new Map<string, { nome: string; cnpj: string; isin: string; gestor: string | null }>();
  for (const p of pares) {
    const key = buildFundoNodeKey(p.fundo_cnpj, p.fundo_isin);
    fundoMeta.set(key, {
      nome: p.nome_fundo || p.fundo_cnpj,
      cnpj: p.fundo_cnpj,
      isin: p.fundo_isin ?? "",
      gestor: p.gestor_nome,
    });
  }

  const sections = ["cotas", ...SECTIONS_ATIVOS_MAPA];

  const { data, error } = await supabase
    .from("posicao_carteira")
    .select(
      "fundo_cnpj, fundo_isin, fundo_nome, nome_fundo, fundo_patliq, valor_padrao, section, " +
        "cnpjfundo, cnpjemissor, cnpjpart, isin, codativo, nomecomercial, matricula, logradouro, numero, dtemissao, dtvencimento",
    )
    .eq("fundo_dtposicao", dtposicao)
    .in("section", sections);

  if (error) throw error;

  const arestaMap = new Map<string, ArestaRede>();
  const ativoMeta = new Map<string, { nome: string; section: string }>();

  for (const raw of (data ?? []) as PosicaoCarteiraRow[]) {
    const source = buildFundoNodeKey(raw.fundo_cnpj, raw.fundo_isin ?? "");
    if (!nodeKeysMonitorados.has(source)) continue;

    const section = (raw.section || "").toLowerCase();
    const pct = pctPlFromRow(raw);

    if (section === "cotas") {
      const target = investedFundoKey(raw);
      if (!target || !nodeKeysMonitorados.has(target)) continue;
      const id = `cota:${source}→${target}`;
      const ex = arestaMap.get(id);
      if (ex) ex.pctPl += pct;
      else arestaMap.set(id, { id, source, target, pctPl: pct, tipo: "cota" });
      if (!fundoMeta.has(target)) {
        const cnpjInv = raw.cnpjfundo || raw.cnpjemissor || "";
        fundoMeta.set(target, { nome: cnpjInv, cnpj: cnpjInv, isin: raw.isin ?? "", gestor: null });
      }
    } else if (SECTIONS_ATIVOS_MAPA.includes(section as (typeof SECTIONS_ATIVOS_MAPA)[number])) {
      if (pct <= 0) continue;
      const ativoKey = getAtivoKeyFromRow(raw);
      const target = keyAtivoRede(ativoKey);
      const id = `ativo:${source}→${target}`;
      const ex = arestaMap.get(id);
      if (ex) ex.pctPl += pct;
      else arestaMap.set(id, { id, source, target, pctPl: pct, tipo: "ativo" });

      if (!ativoMeta.has(target)) {
        ativoMeta.set(target, {
          nome: nomeAtivoFromRow(raw),
          section,
        });
      }
    }
  }

  const fundosLayout = [...fundoMeta.keys()].map((key) => ({ key }));
  const ativosLayout = [...ativoMeta.keys()].map((key) => ({ key }));
  const layout = computeLayoutFundosEAtivos(fundosLayout, ativosLayout);

  const nos: NoRede[] = [
    ...[...fundoMeta.entries()].map(([key, m]) => {
      const p = layout.get(key) ?? { x: 500, y: 350 };
      return {
        key,
        tipo: "fundo" as const,
        nome: m.nome,
        cnpj: m.cnpj,
        isin: m.isin,
        gestor: m.gestor,
        x: p.x,
        y: p.y,
      };
    }),
    ...[...ativoMeta.entries()].map(([key, m]) => {
      const p = layout.get(key) ?? { x: 500, y: 100 };
      return {
        key,
        tipo: "ativo" as const,
        nome: m.nome,
        section: m.section,
        x: p.x,
        y: p.y,
      };
    }),
  ];

  return {
    nos,
    arestas: [...arestaMap.values()],
    dtposicao,
    nFundos: fundoMeta.size,
    nAtivos: ativoMeta.size,
  };
}

function buildAdjacencia(
  arestas: ArestaRede[],
  direcao: DirecaoRede,
): Map<string, Array<{ neighbor: string; edgeId: string; pctPl: number; leaf: boolean }>> {
  const adj = new Map<string, Array<{ neighbor: string; edgeId: string; pctPl: number; leaf: boolean }>>();
  const add = (from: string, to: string, edgeId: string, pctPl: number, leaf: boolean) => {
    const list = adj.get(from) ?? [];
    list.push({ neighbor: to, edgeId, pctPl, leaf });
    adj.set(from, list);
  };

  for (const e of arestas) {
    if (direcao === "passivo" && e.tipo === "ativo") continue;

    if (direcao === "ativo") {
      add(e.source, e.target, e.id, e.pctPl, e.tipo === "ativo" || isNoAtivo(e.target));
    } else {
      add(e.target, e.source, e.id, e.pctPl, false);
    }
  }
  return adj;
}

export function expandirRedePorNivel(
  seedKey: string,
  maxDepth: number,
  direcao: DirecaoRede,
  arestas: ArestaRede[],
): ResultadoExpansao {
  const nosAtivos = new Map<string, NoDestaque>();
  const arestasAtivas = new Set<string>();

  if (!seedKey || maxDepth < 0) return { nosAtivos, arestasAtivas };

  nosAtivos.set(seedKey, { depth: 0, pctAcum: 1 });
  if (maxDepth === 0) return { nosAtivos, arestasAtivas };

  const adj = buildAdjacencia(arestas, direcao);
  const queue: Array<{ key: string; depth: number; pct: number }> = [{ key: seedKey, depth: 0, pct: 1 }];
  const visitedAtDepth = new Map<string, number>();

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    if (isNoAtivo(cur.key)) continue;

    for (const { neighbor, edgeId, pctPl, leaf } of adj.get(cur.key) ?? []) {
      const nextDepth = cur.depth + 1;
      if (nextDepth > maxDepth) continue;

      const nextPct = cur.pct * pctPl;
      arestasAtivas.add(edgeId);

      const prev = nosAtivos.get(neighbor);
      if (prev) {
        nosAtivos.set(neighbor, {
          depth: Math.min(prev.depth, nextDepth),
          pctAcum: prev.pctAcum + nextPct,
        });
      } else {
        nosAtivos.set(neighbor, { depth: nextDepth, pctAcum: nextPct });
      }

      if (!leaf) {
        const lastDepth = visitedAtDepth.get(neighbor);
        if (lastDepth == null || lastDepth < nextDepth) {
          visitedAtDepth.set(neighbor, nextDepth);
          if (nextDepth < maxDepth) {
            queue.push({ key: neighbor, depth: nextDepth, pct: nextPct });
          }
        }
      }
    }
  }

  return { nosAtivos, arestasAtivas };
}

export function corPorCnpj(cnpj: string): string {
  const n = parseInt(normalizeCnpjDigits(cnpj).slice(-6), 10) || 0;
  const hues = [217, 262, 173, 32, 340, 199, 142];
  return `hsl(${hues[n % hues.length]}, 62%, 52%)`;
}

export function corPorSection(section: string | undefined): string {
  const map: Record<string, string> = {
    titpublico: "#f59e0b",
    titprivado: "#eab308",
    caixa: "#22c55e",
    participacoes: "#a855f7",
    acoes: "#06b6d4",
    termorf: "#f97316",
    imoveis: "#78716c",
  };
  return map[section ?? ""] ?? "#64748b";
}

export function truncNomeRede(nome: string, max = 16): string {
  if (!nome) return "—";
  return nome.length > max ? nome.slice(0, max - 1) + "…" : nome;
}

export function fmtPctRede(v: number): string {
  return (v * 100).toFixed(1) + "%";
}

export function paresParaSeletor(pares: ParFundoMonitorado[]) {
  return [...pares].sort((a, b) =>
    (a.nome_fundo || a.fundo_cnpj).localeCompare(b.nome_fundo || b.fundo_cnpj),
  );
}

export { labelSection };

/** @deprecated use ArestaRede */
export type ArestaCota = ArestaRede;

/** @deprecated use NoRede */
export type FundoNoRede = NoRede;

export function computeLayoutCircular(
  fundos: Array<{ key: string; nome: string }>,
  width = 1000,
  height = 700,
): Map<string, { x: number; y: number }> {
  const cx = width / 2;
  const cy = height / 2;
  return layoutCircular(fundos, cx, cy, Math.min(width, height) * 0.38);
}
