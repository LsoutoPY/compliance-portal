/**
 * Universo de monitoramento: helpers para filtrar listas operacionais
 * pelos gestores cadastrados em `gestores_monitorados`.
 *
 * Regra central: fundos cujo `fundo_cnpjgestor` não está na allowlist
 * são importados apenas para look-through — não aparecem em
 * Enquadramento, Liquidez, Posição Fundos, Rentabilidade, etc.
 */

import { supabase } from "@/integrations/supabase/client";

// ── Tipos ────────────────────────────────────────────────────────────────────

export interface GestorMonitorado {
  id: string;
  cnpj_gestor: string;
  nome: string;
  ativo: boolean;
  created_at: string;
  updated_at: string;
}

export interface ParFundoMonitorado {
  fundo_cnpj: string;
  fundo_isin: string;
  nome_fundo: string;
  gestor_nome: string | null;
  cnpj_gestor: string | null;
  fundo_patliq: number | null;
}

// ── Helpers de CNPJ ──────────────────────────────────────────────────────────

/** Remove não-dígitos e preenche com zeros à esquerda até 14 dígitos. */
export function normalizeCnpjDigits(cnpj: string | null | undefined): string {
  if (!cnpj) return "";
  const digits = cnpj.replace(/\D/g, "");
  return digits.padStart(14, "0");
}

/** Chave canônica de par fundo para uso em Maps e conjuntos. */
export function buildParKey(cnpj: string, isin: string | null | undefined): string {
  return `${normalizeCnpjDigits(cnpj)}|${isin ?? ""}`;
}

// ── Queries Supabase ─────────────────────────────────────────────────────────

/** Retorna todos os gestores monitorados ativos. */
export async function fetchGestoresMonitorados(): Promise<GestorMonitorado[]> {
  const { data, error } = await (supabase as any)
    .from("gestores_monitorados")
    .select("*")
    .eq("ativo", true)
    .order("nome");
  if (error) throw error;
  return (data ?? []) as GestorMonitorado[];
}

/** Allowlist completa (ativos e inativos) — tela de cadastro. */
export async function fetchTodosGestoresMonitorados(): Promise<GestorMonitorado[]> {
  const { data, error } = await (supabase as any)
    .from("gestores_monitorados")
    .select("*")
    .order("nome");
  if (error) throw error;
  return (data ?? []) as GestorMonitorado[];
}

export interface GestorDetectadoXml {
  cnpj_gestor: string;
  nome: string;
}

/** CNPJs de gestor distintos nos XMLs importados, para seleção na allowlist. */
export async function fetchGestoresDetectadosNosXmls(): Promise<GestorDetectadoXml[]> {
  const byCnpj = new Map<string, string>();
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await (supabase as any)
      .from("posicao_carteira")
      .select("fundo_cnpjgestor, fundo_nomegestor")
      .in("section", ["caixa", "despesas"])
      .not("fundo_cnpjgestor", "is", null)
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      const cnpj = normalizeCnpjDigits(row.fundo_cnpjgestor);
      if (!cnpj || cnpj === "00000000000000") continue;
      if (!byCnpj.has(cnpj)) {
        byCnpj.set(cnpj, String(row.fundo_nomegestor || "").trim() || cnpj);
      }
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return [...byCnpj.entries()]
    .map(([cnpj_gestor, nome]) => ({ cnpj_gestor, nome }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));
}

/**
 * Pares da data lidos direto de `posicao_carteira` (headers caixa/despesas).
 * Usado quando a RPC de monitoramento volta vazia (portal sem login ou
 * allowlist de gestores ainda não cadastrada).
 */
async function fetchParesFromPosicao(dtposicao: string): Promise<ParFundoMonitorado[]> {
  const byKey = new Map<string, ParFundoMonitorado>();
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await (supabase as any)
      .from("posicao_carteira")
      .select(
        "fundo_cnpj, fundo_isin, nome_fundo, fundo_nome, fundo_nomegestor, fundo_cnpjgestor, fundo_patliq",
      )
      .eq("fundo_dtposicao", dtposicao)
      .in("section", ["caixa", "despesas"])
      .range(offset, offset + pageSize - 1);

    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      if (!row.fundo_cnpj) continue;
      const key = buildParKey(row.fundo_cnpj, row.fundo_isin);
      if (byKey.has(key)) continue;
      byKey.set(key, {
        fundo_cnpj: row.fundo_cnpj,
        fundo_isin: row.fundo_isin ?? "",
        nome_fundo: row.nome_fundo || row.fundo_nome || row.fundo_cnpj,
        gestor_nome: row.fundo_nomegestor ?? null,
        cnpj_gestor: row.fundo_cnpjgestor ?? null,
        fundo_patliq: row.fundo_patliq ?? null,
      });
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return [...byKey.values()].sort((a, b) =>
    a.nome_fundo.localeCompare(b.nome_fundo, "pt-BR", { sensitivity: "base" }),
  );
}

/**
 * Retorna pares (fundo_cnpj, fundo_isin) monitorados para uma data via RPC.
 * Encapsula a regra SQL `is_gestor_monitorado` centralizada no banco.
 *
 * Se a RPC não devolver fundos (usuário anônimo sem `user_is_active`, ou
 * `gestores_monitorados` vazia), cai no fallback da posição importada.
 */
export async function fetchParesMonitorados(
  dtposicao: string,
): Promise<ParFundoMonitorado[]> {
  const { data, error } = await (supabase as any).rpc(
    "get_pares_fundo_monitorado",
    { p_dtposicao: dtposicao },
  );
  if (!error && data?.length) return data as ParFundoMonitorado[];
  if (error) {
    console.warn("[fetchParesMonitorados] RPC indisponível, usando posição:", error.message);
  }

  const [gestores, pares] = await Promise.all([
    fetchGestoresMonitorados().catch(() => [] as GestorMonitorado[]),
    fetchParesFromPosicao(dtposicao),
  ]);
  if (gestores.length === 0) return pares;

  const gestoresSet = new Set(gestores.map((g) => normalizeCnpjDigits(g.cnpj_gestor)));
  return pares.filter((p) => gestoresSet.has(normalizeCnpjDigits(p.cnpj_gestor)));
}

/**
 * Retorna um Set de chaves `"cnpj14|isin"` para os pares monitorados
 * na data — pronto para `.has()` em filtros de listas.
 */
export async function fetchParKeySetMonitorado(
  dtposicao: string,
): Promise<Set<string>> {
  const pares = await fetchParesMonitorados(dtposicao);
  return new Set(pares.map((p) => buildParKey(p.fundo_cnpj, p.fundo_isin)));
}

/**
 * Extrai o conjunto de CNPJs monitorados a partir das chaves "cnpj|isin".
 * Útil quando a fonte de dados não expõe ISIN (ex.: vw_mapa_ativos_fundos).
 */
export function buildMonitoredCnpjSet(parKeys: Set<string>): Set<string> {
  const cnpjs = new Set<string>();
  for (const key of parKeys) {
    const cnpj = key.split("|")[0];
    if (cnpj) cnpjs.add(cnpj);
  }
  return cnpjs;
}

/** Verifica se um fundo (por CNPJ) está no universo monitorado na data. */
export function isFundoCnpjMonitorado(
  cnpj: string,
  parKeys: Set<string>,
): boolean {
  if (parKeys.size === 0) return true; // allowlist vazia ou sem pares na data
  return buildMonitoredCnpjSet(parKeys).has(normalizeCnpjDigits(cnpj));
}

/**
 * CNPJs distintos de fundos cujo gestor está na allowlist.
 * Usa RPC `get_universo_cnpjs_monitorados` (fund_last_updates_cache).
 *
 * @returns `null` se não há gestores cadastrados (fallback: sem filtro).
 */
export async function fetchUniversoCnpjsMonitorados(): Promise<Set<string> | null> {
  const gestores = await fetchGestoresMonitorados();
  if (gestores.length === 0) return null;

  const { data, error } = await (supabase as any).rpc(
    "get_universo_cnpjs_monitorados",
  );

  if (!error) {
    return new Set(
      (data ?? []).map((row: { fundo_cnpj: string }) =>
        normalizeCnpjDigits(row.fundo_cnpj),
      ),
    );
  }

  // RPC ausente (migration pendente) ou falha pontual — fallback via cache
  console.warn(
    "[fetchUniversoCnpjsMonitorados] RPC indisponível, usando cache:",
    error.message,
  );
  return fetchUniversoCnpjsFromCache(gestores);
}

/** Fallback quando `get_universo_cnpjs_monitorados` ainda não foi aplicada. */
async function fetchUniversoCnpjsFromCache(
  gestores: GestorMonitorado[],
): Promise<Set<string>> {
  const gestoresSet = new Set(
    gestores.map((g) => normalizeCnpjDigits(g.cnpj_gestor)),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("fund_last_updates_cache")
    .select("cnpj_fundo, cnpj_gestor, cnpj_admin");

  if (error) {
    // Cache sem cnpj_admin (migration 20260816 pendente)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dataLegacy, error: errLegacy } = await (supabase as any)
      .from("fund_last_updates_cache")
      .select("cnpj_fundo, cnpj_gestor");
    if (errLegacy) throw errLegacy;

    const result = new Set<string>();
    for (const row of dataLegacy ?? []) {
      const cnpj = normalizeCnpjDigits(row.cnpj_fundo);
      const gestor = normalizeCnpjDigits(row.cnpj_gestor);
      if (gestor && gestoresSet.has(gestor)) result.add(cnpj);
    }
    return result;
  }

  const result = new Set<string>();
  for (const row of data ?? []) {
    const cnpj = normalizeCnpjDigits(row.cnpj_fundo);
    const gestor = normalizeCnpjDigits(row.cnpj_gestor);
    if (gestor && gestoresSet.has(gestor)) result.add(cnpj);
  }

  const adminGrupoH = await fetchAdminCnpjsGrupoH(gestores);
  if (adminGrupoH.size > 0) {
    for (const row of data ?? []) {
      const adm = normalizeCnpjDigits(row.cnpj_admin);
      if (adm && adminGrupoH.has(adm)) {
        result.add(normalizeCnpjDigits(row.cnpj_fundo));
      }
    }
  }

  return result;
}

/** CNPJs de administradores mapeados ao grupo H quando Hieron está monitorado. */
export async function fetchAdminCnpjsGrupoH(
  gestores: GestorMonitorado[],
): Promise<Set<string>> {
  const hieronAtivo = gestores.some((g) => /hieron/i.test(g.nome));
  if (!hieronAtivo) return new Set();

  const { data, error } = await (supabase as any)
    .from("mapa_fundos_grupos")
    .select("cnpj")
    .eq("tipo", "admin")
    .eq("grupo", "H")
    .eq("ativo", true);

  if (error) {
    console.warn("[fetchAdminCnpjsGrupoH]", error.message);
    return new Set();
  }

  return new Set(
    (data ?? []).map((r: { cnpj: string }) => normalizeCnpjDigits(r.cnpj)),
  );
}

export interface FundoParaFiltroGestor {
  fundo_cnpj: string;
  cnpj_gestor?: string | null;
  gestor?: string | null;
  denominacao_social?: string | null;
  responsabilidade?: string | null;
  cnpj_administrador?: string | null;
}

/** Verifica se o fundo pertence a um gestor da allowlist (cadastro + posição). */
export function fundoEhGestorMonitorado(
  fundo: FundoParaFiltroGestor,
  gestores: GestorMonitorado[],
  universoPosicao: Set<string> | null,
  adminGrupoH: Set<string> = new Set(),
): boolean {
  if (gestores.length === 0) return true;

  const gestoresSet = new Set(
    gestores.map((g) => normalizeCnpjDigits(g.cnpj_gestor)),
  );
  const cnpj = normalizeCnpjDigits(fundo.fundo_cnpj);

  if (universoPosicao?.has(cnpj)) return true;

  const cnpjGestor = normalizeCnpjDigits(fundo.cnpj_gestor);
  if (cnpjGestor && gestoresSet.has(cnpjGestor)) return true;

  const cnpjAdm = normalizeCnpjDigits(fundo.cnpj_administrador);
  if (cnpjAdm && adminGrupoH.has(cnpjAdm)) return true;

  const texto = [
    fundo.gestor,
    fundo.denominacao_social,
    fundo.responsabilidade,
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();

  for (const g of gestores) {
    const token = g.nome.toUpperCase().trim();
    if (token.length >= 4 && texto.includes(token)) return true;
    // Hieron: aceita variações com/sem acento
    if (/HIERON/i.test(g.nome) && /HIERON|HIÉRON/i.test(texto)) return true;
  }

  return false;
}

/** Filtra lista de fundos_taxas pelos gestores monitorados. */
export function filtrarFundosPorGestoresMonitorados<
  T extends FundoParaFiltroGestor,
>(
  fundos: T[],
  gestores: GestorMonitorado[],
  universoPosicao: Set<string> | null,
  adminGrupoH: Set<string> = new Set(),
): T[] {
  if (gestores.length === 0) return fundos;
  return fundos.filter((f) =>
    fundoEhGestorMonitorado(f, gestores, universoPosicao, adminGrupoH),
  );
}

/** Filtra fundos pelo universo monitorado (`null` = sem filtro). */
export function filtrarFundosUniversoMonitorado<T extends { cnpj: string }>(
  fundos: T[],
  universo: Set<string> | null,
): T[] {
  if (universo === null) return fundos;
  return fundos.filter((f) => universo.has(normalizeCnpjDigits(f.cnpj)));
}

/**
 * Filtra um array de registros usando um Set de chaves monitoradas.
 * Aceita qualquer objeto com `fundo_cnpj` e `fundo_isin` opcionais.
 */
export function filtrarPorParesMonitorados<
  T extends { fundo_cnpj: string | null; fundo_isin?: string | null },
>(rows: T[], parKeys: Set<string>): T[] {
  if (parKeys.size === 0) return rows; // se vazio (tabela não populada), retorna tudo
  return rows.filter(
    (r) => r.fundo_cnpj && parKeys.has(buildParKey(r.fundo_cnpj, r.fundo_isin)),
  );
}

// ── CRUD de gestores ─────────────────────────────────────────────────────────

export async function createGestorMonitorado(
  cnpj_gestor: string,
  nome: string,
): Promise<void> {
  const { error } = await (supabase as any)
    .from("gestores_monitorados")
    .insert({ cnpj_gestor: normalizeCnpjDigits(cnpj_gestor), nome });
  if (error) throw error;
}

export async function updateGestorMonitorado(
  id: string,
  patch: Partial<Pick<GestorMonitorado, "nome" | "ativo">>,
): Promise<void> {
  const { error } = await (supabase as any)
    .from("gestores_monitorados")
    .update(patch)
    .eq("id", id);
  if (error) throw error;
}

// ── Look-through invertido ───────────────────────────────────────────────────

/**
 * Uma linha retornada pela RPC `get_investidores_fundo`.
 * Representa um nó em um caminho do grafo de investidores.
 */
export interface InvestidorPath {
  /** Caminho completo serializado: "cnpj1|isin1→cnpj2|isin2→..." */
  caminho_id: string;
  /** Profundidade do nó neste caminho (1 = detentor direto do alvo) */
  nivel: number;
  fundo_cnpj: string;
  fundo_isin: string;
  nome_fundo: string;
  /** % do PL do fundo detentor alocado no fundo investido (passo direto) */
  pct_pl: number | null;
  /** Exposição acumulada: produto dos pct_pl ao longo de todo o caminho */
  pct_lookthrough: number | null;
}

/**
 * Resultado da agregação de convergência para um nó terminal (fundo raiz).
 */
export interface ConvergenciaResult {
  fundo_cnpj_raiz: string;
  fundo_isin_raiz: string;
  nome_raiz: string;
  /** Caminhos distintos (rotas ou classes diretas, conforme o tipo) */
  n_caminhos: number;
  /** Soma dos pct_lookthrough de cada caminho/rota */
  pct_total: number;
  caminhos: InvestidorPath[][];
  /**
   * Convergência real: a raiz (CNPJ) chega ao alvo por 2+ rotas com
   * intermediários estruturalmente distintos (ex.: direto + via ALVORA).
   */
  is_convergencia_multi_hop: boolean;
  /**
   * Mesmo CNPJ raiz com 2+ cotas/classes em posição direta (nível 1),
   * sem intermediário — somar %, mas NÃO é convergência multi-hop.
   */
  is_exposicao_direta_multi_classe: boolean;
}

/**
 * Chama a RPC `get_investidores_fundo` e retorna todos os caminhos
 * do grafo de investidores do fundo-alvo na data indicada.
 */
export async function fetchInvestidoresFundo(
  cnpj: string,
  isin: string,
  dtposicao: string,
  maxNiveis = 5,
): Promise<InvestidorPath[]> {
  const { data, error } = await (supabase as any).rpc("get_investidores_fundo", {
    p_cnpj: normalizeCnpjDigits(cnpj),
    p_isin: isin ?? "",
    p_dtposicao: dtposicao,
    p_max_niveis: maxNiveis,
  });
  if (error) throw error;
  return (data ?? []) as InvestidorPath[];
}

/** Chave canônica de nó no grafo de investidores (CNPJ normalizado + ISIN). */
export function buildFundoNodeKey(cnpj: string, isin: string | null | undefined): string {
  return `${normalizeCnpjDigits(cnpj)}|${isin ?? ""}`;
}

/** Resumo legível de um caminho completo até o fundo-alvo. */
export interface CaminhoResumo {
  caminho_id: string;
  pct_exposicao: number;
  /** Nós do caminho, nivel 1 = detentor direto do alvo */
  nodos: InvestidorPath[];
  /** Ex.: "RMF → FIF QI PLUS → ALVORA (11,4%)" */
  descricao: string;
}

export function resumirCaminho(linhas: InvestidorPath[], nomeAlvo: string): CaminhoResumo {
  const nodos = [...linhas].sort((a, b) => a.nivel - b.nivel);
  const terminal = nodos.reduce((max, cur) => (cur.nivel > max.nivel ? cur : max), nodos[0]);
  const pct = terminal?.pct_lookthrough ?? 0;
  const cadeia = [...nodos]
    .sort((a, b) => b.nivel - a.nivel)
    .map((n) => n.nome_fundo || n.fundo_cnpj);
  cadeia.push(nomeAlvo);
  const descricao = `${cadeia.join(" → ")} (${(pct * 100).toFixed(1)}%)`;
  return {
    caminho_id: linhas[0]?.caminho_id ?? "",
    pct_exposicao: pct,
    nodos,
    descricao,
  };
}

export function resumirCaminhosConvergencia(
  conv: ConvergenciaResult,
  nomeAlvo: string,
): CaminhoResumo[] {
  return conv.caminhos.map((c) => resumirCaminho(c, nomeAlvo));
}

/**
 * Agrupa linhas brutas da RPC por caminho_id — útil para debug.
 */
export function agruparPathsPorCaminho(paths: InvestidorPath[]): Map<string, InvestidorPath[]> {
  const map = new Map<string, InvestidorPath[]>();
  for (const p of paths) {
    const list = map.get(p.caminho_id) ?? [];
    list.push(p);
    map.set(p.caminho_id, list);
  }
  return map;
}

/**
 * Assinatura estrutural de uma rota (alvo → raiz).
 * Caminhos só-diretos (nível 1) compartilham "__DIRETO__" — diferença de ISIN
 * no terminal não conta como rota distinta.
 */
export function buildAssinaturaRota(linhas: InvestidorPath[]): string {
  const sorted = [...linhas].sort((a, b) => a.nivel - b.nivel);
  const maxNivel = sorted[sorted.length - 1]?.nivel ?? 1;
  if (maxNivel === 1) return "__DIRETO__";
  return sorted.map((n) => buildFundoNodeKey(n.fundo_cnpj, n.fundo_isin)).join("→");
}

/**
 * Detecta convergência multi-hop e exposição direta multi-classe.
 *
 * Agrupa caminhos pelo CNPJ da raiz (terminal), não pelo par CNPJ+ISIN:
 * - Várias classes diretas (só nível 1, mesmo CNPJ) → exposição direta total
 * - Rotas com intermediários estruturalmente distintos → convergência real
 *
 * Algoritmo:
 *  1. Agrupar linhas por caminho_id
 *  2. Para cada caminho, nó terminal = maior `nivel` DENTRO daquele caminho
 *  3. Agrupar caminhos pelo CNPJ normalizado do terminal
 *  4. Se todos os caminhos do grupo são diretos (max nivel = 1):
 *     is_exposicao_direta_multi_classe quando count > 1; sem convergência
 *  5. Senão, contar assinaturas de rota distintas (buildAssinaturaRota):
 *     2+ assinaturas → is_convergencia_multi_hop; pct_total = soma por caminho
 */
export function detectarConvergencia(paths: InvestidorPath[]): ConvergenciaResult[] {
  if (paths.length === 0) return [];

  type CaminhoMeta = {
    linhas: InvestidorPath[];
    terminal: InvestidorPath;
    assinatura: string;
    pct: number;
  };

  const porCaminho = new Map<string, InvestidorPath[]>();
  for (const p of paths) {
    const list = porCaminho.get(p.caminho_id) ?? [];
    list.push(p);
    porCaminho.set(p.caminho_id, list);
  }

  const metas: CaminhoMeta[] = [];
  for (const linhas of porCaminho.values()) {
    const linhsOrdenadas = [...linhas].sort((a, b) => a.nivel - b.nivel);
    const terminal = linhas.reduce(
      (max, cur) => (cur.nivel > max.nivel ? cur : max),
      linhas[0],
    );
    metas.push({
      linhas: linhsOrdenadas,
      terminal,
      assinatura: buildAssinaturaRota(linhsOrdenadas),
      pct: terminal.pct_lookthrough ?? 0,
    });
  }

  // Agrupa pelo CNPJ da raiz (ignora ISIN do terminal para classificação)
  const porCnpjRaiz = new Map<string, CaminhoMeta[]>();
  for (const m of metas) {
    const cnpj = normalizeCnpjDigits(m.terminal.fundo_cnpj);
    const list = porCnpjRaiz.get(cnpj) ?? [];
    list.push(m);
    porCnpjRaiz.set(cnpj, list);
  }

  const results: ConvergenciaResult[] = [];

  for (const [cnpj, grupo] of porCnpjRaiz) {
    const nome_raiz = grupo.reduce(
      (best, m) =>
        (m.terminal.nome_fundo?.length ?? 0) > best.length
          ? m.terminal.nome_fundo
          : best,
      grupo[0].terminal.nome_fundo || cnpj,
    );
    const todosDiretos = grupo.every((m) => m.assinatura === "__DIRETO__");

    if (todosDiretos) {
      results.push({
        fundo_cnpj_raiz: grupo[0].terminal.fundo_cnpj,
        fundo_isin_raiz: grupo[0].terminal.fundo_isin,
        nome_raiz,
        n_caminhos: grupo.length,
        pct_total: grupo.reduce((s, m) => s + m.pct, 0),
        caminhos: grupo.map((m) => m.linhas),
        is_convergencia_multi_hop: false,
        is_exposicao_direta_multi_classe: grupo.length > 1,
      });
      continue;
    }

    // Rotas multi-hop: convergência só se assinaturas estruturais distintas
    const porAssinatura = new Map<string, CaminhoMeta[]>();
    for (const m of grupo) {
      const list = porAssinatura.get(m.assinatura) ?? [];
      list.push(m);
      porAssinatura.set(m.assinatura, list);
    }

    const nRotasDistintas = porAssinatura.size;
    results.push({
      fundo_cnpj_raiz: grupo[0].terminal.fundo_cnpj,
      fundo_isin_raiz: grupo[0].terminal.fundo_isin,
      nome_raiz,
      n_caminhos: nRotasDistintas,
      pct_total: grupo.reduce((s, m) => s + m.pct, 0),
      caminhos: grupo.map((m) => m.linhas),
      is_convergencia_multi_hop: nRotasDistintas > 1,
      is_exposicao_direta_multi_classe: false,
    });
  }

  return results.sort((a, b) => b.pct_total - a.pct_total);
}
