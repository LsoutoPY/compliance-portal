/**
 * Snapshot da rede de fundos para o Mapa de Fundos.
 *
 * Regras de identidade:
 *   - Um NÓ por CNPJ de fundo (consolidado; ignora ISIN/tranche para exibição)
 *   - Uma ARESTA por linha de posicao_carteira (granular; mantém sinal de subordinação)
 *
 * Carteira por fundo: usa o XML mais recente disponível (<= data de referência;
 * se não houver, usa a data absoluta mais recente do fundo).
 */

import { supabase } from "@/integrations/supabase/client";
import {
  getAtivoKeyFromRow,
  isinUtilizavel,
  type PosicaoCarteiraRow,
} from "@/hooks/useRentabilidadeCalc";
import {
  fetchParesMonitorados,
  normalizeCnpjDigits,
} from "@/lib/fundosMonitorados";
import {
  buildFundoDisplayKey,
  buildArestaId,
  keyAtivoRede,
  cnpjFromDisplayKey,
  isNoFundo,
  incluirAtivoNoGrafo,
  incluirCotaNoGrafo,
} from "./keys";
import { formatNomeAtivo, fetchNomesFundosCaracteristicas, nomeFundoComCadastro, donoPorNomeCanonico } from "./nomes";
import { isTrancheSubordinada } from "./subordinacao";
import { computeLayout } from "./layout";

export type TipoNoRede = "fundo" | "ativo" | "cotista";

export interface NoRede {
  key: string;
  tipo: TipoNoRede;
  nome: string;
  x: number;
  y: number;
  cnpj?: string;
  cnpjGestor?: string | null;
  cnpjAdm?: string | null;
  gestorNome?: string | null;
  administradorNome?: string | null;
  /** PL do próprio fundo no XML usado para a árvore. */
  patrimonioLiquido?: number | null;
  /** Data efetiva da carteira/PL, no formato YYYYMMDD. */
  dataCarteira?: string | null;
  cnpjContraparte?: string | null;
  custodianteNome?: string | null;
  section?: string;
}

export type TipoAresta = "cota" | "ativo" | "passivo";

export interface ArestaRede {
  id: string;
  source: string;
  target: string;
  pctPl: number;
  /** Valor da posição da cota no fundo de origem. */
  valorFinanceiro?: number | null;
  tipo: TipoAresta;
  isSubordinada: boolean;
  nomeAresta: string;
}

export interface RedeSnapshot {
  nos: NoRede[];
  arestas: ArestaRede[];
  dtposicao: string;
  monitoredCnpjs: Set<string>;
  nFundos: number;
  nAtivos: number;
}

const SECTIONS_ATIVOS = [
  "titpublico",
  "titprivado",
  "caixa",
  "participacoes",
  "acoes",
  "termorf",
  "imoveis",
] as const;

const PORTFOLIO_SECTIONS = ["cotas", ...SECTIONS_ATIVOS] as const;

type RowFull = PosicaoCarteiraRow & { fundo_cnpjadm?: string | null };

const PAGE_SIZE = 1000;
const CARTEIRA_BATCH = 20;
const CARTEIRA_MAX_ONDAS = 12;

/** Alvos de cota ainda sem carteira carregada (look-through em profundidade). */
export function alvosCotaPendentes(
  arestaMap: Map<string, ArestaRede>,
  carregados: Set<string>,
): string[] {
  const out = new Set<string>();
  for (const e of arestaMap.values()) {
    if (e.tipo !== "cota" || !isNoFundo(e.target)) continue;
    const cnpj = cnpjFromDisplayKey(e.target);
    if (cnpj && !carregados.has(cnpj)) out.add(cnpj);
  }
  return [...out];
}

function isinsCotaParaLookup(rows: PosicaoCarteiraRow[]): string[] {
  const isins: string[] = [];
  for (const row of rows) {
    if ((row.section || "").toLowerCase() !== "cotas") continue;
    const isin = isinUtilizavel(row.isin);
    if (isin) isins.push(isin);
  }
  return isins;
}

async function enrichCotaResolverFromRows(
  rows: PosicaoCarteiraRow[],
  ctx: PortfolioContext,
): Promise<void> {
  const neededIsins: string[] = [];
  for (const row of rows) {
    if ((row.section || "").toLowerCase() !== "cotas") continue;
    const isin = isinUtilizavel(row.isin);
    if (isin && !ctx.isinParaCnpj.has(isin)) neededIsins.push(isin);
  }
  if (neededIsins.length) {
    for (const [k, v] of await fetchCnpjPorIsin(neededIsins)) {
      ctx.isinParaCnpj.set(k, v);
      ctx.cnpjsFundosValidos.add(v);
    }
  }

  const resolver = resolverFromCtx(ctx);
  const nomes = nomesCotaParaLookup(rows).filter(
    (n) => !ctx.nomeParaCnpj.has(normalizarNomeCotaLookup(n)),
  );
  if (nomes.length) {
    for (const [k, v] of await fetchCnpjPorNomeComercial(nomes)) {
      ctx.nomeParaCnpj.set(k, v);
      ctx.cnpjsFundosValidos.add(v);
    }
  }
}

/**
 * Carrega carteiras em ondas: cada lote pode revelar novos fundos investidos (ex.: THEMIS
 * via FIF T1.0) que precisam do próprio XML para expandir ativos.
 */
async function carregarCarteirasEmOndas(
  seeds: Iterable<string>,
  dtposicao: string,
  ctx: PortfolioContext,
  estrito = false,
): Promise<void> {
  const carregados = new Set<string>();
  let fila = [...new Set(seeds)].filter(Boolean);

  for (let onda = 0; onda < CARTEIRA_MAX_ONDAS && fila.length > 0; onda++) {
    const lote = fila.filter((c) => !carregados.has(c));
    if (lote.length === 0) break;
    fila = [];

    for (let i = 0; i < lote.length; i += CARTEIRA_BATCH) {
      const chunk = lote.slice(i, i + CARTEIRA_BATCH);
      await Promise.all(
        chunk.map(async (cnpj) => {
          carregados.add(cnpj);
          const rows = await fetchPosicoesFundoMaisRecente(cnpj, dtposicao, estrito);
          await enrichCotaResolverFromRows(rows, ctx);
          appendPortfolioRows(rows, ctx);
        }),
      );
    }

    fila = alvosCotaPendentes(ctx.arestaMap, carregados);
  }
}

const POSICAO_SELECT =
  "fundo_cnpj, fundo_isin, fundo_nome, nome_fundo, fundo_patliq, valor_padrao, valorcontabil, section, " +
  "fundo_nomegestor, fundo_cnpjgestor, fundo_nomeadm, fundo_cnpjadm, fundo_nomecustodiante, cnpjfundo, cnpjemissor, cnpjpart, isin, codativo, nomecomercial, " +
  "matricula, logradouro, numero, dtemissao, dtvencimento, isininstituicao, fundo_dtposicao";

function pctPl(row: Pick<PosicaoCarteiraRow, "fundo_patliq" | "valor_padrao" | "section" | "valorcontabil">): number {
  if (!row.fundo_patliq || row.fundo_patliq <= 0) return 0;
  const section = (row.section || "").toLowerCase();
  const valor =
    section === "imoveis" && row.valorcontabil != null
      ? row.valorcontabil
      : row.valor_padrao;
  if (valor == null || valor <= 0) return 0;
  return valor / row.fundo_patliq;
}

/**
 * CNPJ do fundo investido em linha de cota.
 * Usa SOMENTE `cnpjfundo` — nunca `cnpjemissor` (evita cotas fantasma SET→ERGA).
 */
export function targetCnpjCota(row: Pick<PosicaoCarteiraRow, "cnpjfundo">): string | null {
  const raw = row.cnpjfundo?.trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  // Exige 14 dígitos — padStart em CNPJ curto gerava alvo fantasma (ex.: BACO → CONDOCASH).
  if (digits.length !== 14) return null;
  return digits;
}

/**
 * Resolve CNPJ do fundo investido.
 * Prioridade: ISIN (classe/tranche no cadastro ANBIMA) > nomecomercial > cnpjfundo do XML.
 * O XML frequentemente traz cnpjfundo errado (ex.: administrador) enquanto o ISIN identifica
 * a classe correta (Pedra Azul SR/MZ com ISIN distintos).
 */
export function resolveTargetCnpjCota(
  row: Pick<PosicaoCarteiraRow, "cnpjfundo" | "isin" | "nomecomercial" | "cnpjemissor">,
  resolver: CotaTargetResolver,
): string | null {
  const direct = targetCnpjCota(row);
  const isin = isinUtilizavel(row.isin);

  if (isin) {
    const mapped = resolver.isinParaCnpj.get(isin);
    if (mapped) {
      const norm = normalizeCnpjDigits(mapped);
      if (norm.length === 14) return norm;
    }
  }

  const nomeKey = normalizarNomeCotaLookup(row.nomecomercial || "");
  const byNome = nomeKey ? resolver.nomeParaCnpj.get(nomeKey) : undefined;

  if (byNome && direct && byNome !== direct) {
    return byNome;
  }

  if (direct) return direct;

  if (byNome) return byNome;

  const emissor = row.cnpjemissor?.replace(/\D/g, "") ?? "";
  if (emissor.length === 14 && nomeKey && resolver.cnpjsFundosValidos.has(emissor)) {
    const nomeRaw = row.nomecomercial?.trim() || "";
    if (/fidc|fif|fip|fii|fim|reag|cash|baco|set\b|master/i.test(nomeRaw)) {
      return emissor;
    }
  }

  return null;
}

export interface CotaTargetResolver {
  isinParaCnpj: Map<string, string>;
  nomeParaCnpj: Map<string, string>;
  cnpjsFundosValidos: Set<string>;
}

export function normalizarNomeCotaLookup(nome: string): string {
  return nome.trim().toLowerCase().replace(/\s+/g, " ");
}

function scoreMatchNomeCota(busca: string, candidato: string): number {
  const a = normalizarNomeCotaLookup(busca);
  const b = normalizarNomeCotaLookup(candidato);
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.88;
  const tokensA = new Set(a.split(" ").filter(Boolean));
  const tokensB = b.split(" ").filter(Boolean);
  if (!tokensB.length) return 0;
  const overlap = tokensB.filter((t) => tokensA.has(t)).length;
  return overlap / Math.max(tokensB.length, tokensA.size);
}

const ISIN_CNPJ_BATCH = 80;

async function fetchCnpjPorIsin(isins: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(isins.map((i) => isinUtilizavel(i)).filter(Boolean) as string[])];
  if (unique.length === 0) return new Map();

  const out = new Map<string, string>();

  for (let i = 0; i < unique.length; i += ISIN_CNPJ_BATCH) {
    const chunk = unique.slice(i, i + ISIN_CNPJ_BATCH);
    const { data, error } = await supabase
      .from("fundos_caracteristicas" as never)
      .select("isin, cnpj_fundo, cnpj_classe")
      .in("isin", chunk);

    if (error) {
      console.warn("[mapaFundos] Erro ao resolver CNPJ por ISIN:", error.message);
      continue;
    }

    for (const row of (data ?? []) as Array<{
      isin: string | null;
      cnpj_fundo: string | null;
      cnpj_classe: string | null;
    }>) {
      const isin = isinUtilizavel(row.isin);
      if (!isin || out.has(isin)) continue;
      const cnpjClasse = normalizeCnpjDigits(row.cnpj_classe);
      const cnpjFundo = normalizeCnpjDigits(row.cnpj_fundo);
      // ISIN identifica a classe/tranche — cnpj_classe tem precedência sobre cnpj_fundo
      const cnpj =
        cnpjClasse.length === 14 ? cnpjClasse : cnpjFundo.length === 14 ? cnpjFundo : "";
      if (cnpj.length === 14) out.set(isin, cnpj);
    }
  }

  return out;
}

function nomesCotaParaLookup(rows: PosicaoCarteiraRow[]): string[] {
  const nomes: string[] = [];
  for (const row of rows) {
    if ((row.section || "").toLowerCase() !== "cotas") continue;
    const nome = row.nomecomercial?.trim();
    if (nome) nomes.push(nome);
  }
  return nomes;
}

async function fetchCnpjPorNomeComercial(nomes: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(nomes.map((n) => n.trim()).filter((n) => n.length >= 4))];

  for (const nome of unique) {
    const key = normalizarNomeCotaLookup(nome);
    if (out.has(key)) continue;

    const termo = nome
      .trim()
      .replace(/[^\w\sÁÀÃÉÍÓÚÇ]/gi, " ")
      .split(/\s+/)
      .slice(0, 4)
      .join(" ");
    if (termo.length < 4) continue;

    const { data, error } = await supabase
      .from("fundos_caracteristicas" as never)
      .select("nome_comercial, cnpj_fundo, cnpj_classe")
      .ilike("nome_comercial", `%${termo}%`)
      .limit(25);

    if (error) {
      console.warn("[mapaFundos] Erro ao resolver CNPJ por nome:", error.message);
      continue;
    }

    let best: { cnpj: string; score: number } | null = null;
    for (const row of (data ?? []) as Array<{
      nome_comercial: string | null;
      cnpj_fundo: string | null;
      cnpj_classe: string | null;
    }>) {
      const nc = row.nome_comercial?.trim();
      if (!nc) continue;
      const score = scoreMatchNomeCota(nome, nc);
      const cnpj = normalizeCnpjDigits(row.cnpj_fundo || row.cnpj_classe);
      if (cnpj.length !== 14 || score < 0.55) continue;
      if (!best || score > best.score) best = { cnpj, score };
    }
    if (best) out.set(key, best.cnpj);
  }

  return out;
}

async function buildCotaTargetResolver(rows: PosicaoCarteiraRow[]): Promise<CotaTargetResolver> {
  const isinParaCnpj = await fetchCnpjPorIsin(isinsCotaParaLookup(rows));
  const cnpjsFundosValidos = new Set<string>(isinParaCnpj.values());
  const partial: CotaTargetResolver = {
    isinParaCnpj,
    nomeParaCnpj: new Map(),
    cnpjsFundosValidos,
  };
  partial.nomeParaCnpj = await fetchCnpjPorNomeComercial(nomesCotaParaLookup(rows));
  for (const cnpj of partial.nomeParaCnpj.values()) partial.cnpjsFundosValidos.add(cnpj);
  return partial;
}

function resolverFromCtx(ctx: PortfolioContext): CotaTargetResolver {
  return {
    isinParaCnpj: ctx.isinParaCnpj,
    nomeParaCnpj: ctx.nomeParaCnpj,
    cnpjsFundosValidos: ctx.cnpjsFundosValidos,
  };
}

/** @deprecated uso interno legado — preferir targetCnpjCota para section=cotas */
function targetCnpj(row: PosicaoCarteiraRow): string | null {
  const section = (row.section || "").toLowerCase();
  if (section === "cotas") return targetCnpjCota(row);
  const raw = row.cnpjfundo || row.cnpjemissor;
  if (!raw) return null;
  return normalizeCnpjDigits(raw);
}

function nomeAresta(row: PosicaoCarteiraRow): string {
  const nome = row.nomecomercial?.trim() || row.nome_fundo?.trim() || row.fundo_nome?.trim();
  return nome || (row.isin?.trim() ?? "");
}

function cnpjFormatVariants(cnpj: string): string[] {
  const norm = normalizeCnpjDigits(cnpj);
  const digits = cnpj.replace(/\D/g, "");
  const out = new Set<string>([norm, digits]);
  if (norm.length === 14) {
    out.add(
      norm.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5"),
    );
  }
  return [...out];
}

function cnpjMatchesRow(rowCnpj: string | null | undefined, alvo: string): boolean {
  if (!rowCnpj) return false;
  return normalizeCnpjDigits(rowCnpj) === normalizeCnpjDigits(alvo);
}

async function fetchPosicaoPaginado(
  dtposicao: string,
  sections: readonly string[],
): Promise<PosicaoCarteiraRow[]> {
  let all: PosicaoCarteiraRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("posicao_carteira")
      .select(POSICAO_SELECT)
      .eq("fundo_dtposicao", dtposicao)
      .in("section", [...sections])
      .order("fundo_cnpj", { ascending: true })
      .order("section", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    if (!data?.length) break;

    all = all.concat(data as PosicaoCarteiraRow[]);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return all;
}

async function queryUltimaDataFundo(
  cnpj: string,
  ateDt: string | null,
): Promise<string | null> {
  for (const variant of cnpjFormatVariants(cnpj)) {
    let q = supabase
      .from("posicao_carteira")
      .select("fundo_dtposicao")
      .eq("fundo_cnpj", variant)
      .in("section", [...PORTFOLIO_SECTIONS]);

    if (ateDt) q = q.lte("fundo_dtposicao", ateDt);

    const { data, error } = await q
      .order("fundo_dtposicao", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (data?.fundo_dtposicao) return data.fundo_dtposicao;
  }
  return null;
}

/**
 * Resolve a data do XML de carteira de um fundo:
 * 1) data exata se houver linhas; 2) mais recente <= dtRef; 3) mais recente absoluta.
 */
async function resolveDataCarteiraFundo(cnpj: string, dtRef: string, estrito = false): Promise<string | null> {
  const exactRows = await fetchPosicoesFundoNaData(cnpj, dtRef);
  if (exactRows.length > 0) return dtRef;

  const ateRef = await queryUltimaDataFundo(cnpj, dtRef);
  if (ateRef) return ateRef;

  return estrito ? null : queryUltimaDataFundo(cnpj, null);
}

/** Posições de um fundo numa data — filtra por CNPJ normalizado. */
async function fetchPosicoesFundoNaData(
  cnpj: string,
  dtposicao: string,
): Promise<PosicaoCarteiraRow[]> {
  const alvo = normalizeCnpjDigits(cnpj);

  for (const variant of cnpjFormatVariants(cnpj)) {
    let from = 0;
    const batch: PosicaoCarteiraRow[] = [];

    while (true) {
      const { data, error } = await supabase
        .from("posicao_carteira")
        .select(POSICAO_SELECT)
        .eq("fundo_dtposicao", dtposicao)
        .eq("fundo_cnpj", variant)
        .in("section", [...PORTFOLIO_SECTIONS])
        .range(from, from + PAGE_SIZE - 1);

      if (error) throw error;
      if (!data?.length) break;

      batch.push(...(data as PosicaoCarteiraRow[]));
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    if (batch.length > 0) {
      return batch.filter((r) => cnpjMatchesRow(r.fundo_cnpj, alvo));
    }
  }

  const allOnDate = await fetchPosicaoPaginado(dtposicao, PORTFOLIO_SECTIONS);
  return allOnDate.filter((r) => cnpjMatchesRow(r.fundo_cnpj, alvo));
}

/** Carteira completa do fundo no XML mais recente disponível. */
async function fetchPosicoesFundoMaisRecente(
  cnpj: string,
  dtRef: string,
  estrito = false,
): Promise<PosicaoCarteiraRow[]> {
  const dt = await resolveDataCarteiraFundo(cnpj, dtRef, estrito);
  if (!dt) return [];
  return fetchPosicoesFundoNaData(cnpj, dt);
}

interface PortfolioContext {
  arestaMap: Map<string, ArestaRede>;
  /** Nomes do próprio fundo (fundo_cnpj = cnpj na linha). */
  fundoNomesOwner: Map<string, string[]>;
  /** Nomes inferidos de cotas de terceiros (cnpjfundo = cnpj). */
  fundoNomesRef: Map<string, string[]>;
  fundoGestor: Map<string, string | null>;
  fundoAdm: Map<string, string | null>;
  fundoGestorNome: Map<string, string | null>;
  fundoAdmNome: Map<string, string | null>;
  fundoPl: Map<string, number | null>;
  fundoData: Map<string, string>;
  fundoCustodiante: Map<string, string>;
  ativoMeta: Map<string, { nome: string; section: string; cnpjContraparte?: string }>;
  /** ISIN → CNPJ (fundos_caracteristicas) para cotas sem cnpjfundo. */
  isinParaCnpj: Map<string, string>;
  /** nomecomercial normalizado → CNPJ (ex.: "reag cash ii"). */
  nomeParaCnpj: Map<string, string>;
  /** CNPJs já validados no cadastro ANBIMA (emissor seguro). */
  cnpjsFundosValidos: Set<string>;
}

function ensureFundoMeta(cnpj: string, ctx: PortfolioContext): void {
  if (!ctx.fundoNomesOwner.has(cnpj)) {
    ctx.fundoNomesOwner.set(cnpj, []);
    ctx.fundoNomesRef.set(cnpj, []);
    ctx.fundoGestor.set(cnpj, null);
    ctx.fundoAdm.set(cnpj, null);
    ctx.fundoGestorNome.set(cnpj, null);
    ctx.fundoAdmNome.set(cnpj, null);
    ctx.fundoPl.set(cnpj, null);
  }
}

function registrarLinhaCota(row: PosicaoCarteiraRow, ctx: PortfolioContext): void {
  const srcCnpj = normalizeCnpjDigits(row.fundo_cnpj);
  if (!srcCnpj) return;

  ensureFundoMeta(srcCnpj, ctx);
  if (row.nome_fundo?.trim()) ctx.fundoNomesOwner.get(srcCnpj)!.push(row.nome_fundo.trim());
  if (row.fundo_nome?.trim()) ctx.fundoNomesOwner.get(srcCnpj)!.push(row.fundo_nome.trim());

  const pct = pctPl(row);
  if (!incluirCotaNoGrafo(pct)) return;

  const tgt = resolveTargetCnpjCota(row, resolverFromCtx(ctx));
  if (!tgt || srcCnpj === tgt) return;

  ensureFundoMeta(tgt, ctx);
  const sourceKey = buildFundoDisplayKey(srcCnpj);
  const targetKey = buildFundoDisplayKey(tgt);
  const nomPos = nomeAresta(row);

  const id = buildArestaId(sourceKey, targetKey, row.isin, nomPos);
  ctx.arestaMap.set(id, {
    id,
    source: sourceKey,
    target: targetKey,
    pctPl: pct,
    valorFinanceiro: row.valor_padrao ?? null,
    tipo: "cota",
    isSubordinada: isTrancheSubordinada(nomPos || row.nomecomercial),
    nomeAresta: nomPos || tgt,
  });

  if (nomPos) ctx.fundoNomesRef.get(tgt)!.push(nomPos);
}

function appendPortfolioRows(rows: PosicaoCarteiraRow[], ctx: PortfolioContext): void {
  for (const row of rows) {
    const srcCnpj = normalizeCnpjDigits(row.fundo_cnpj);
    if (!srcCnpj) continue;

    ensureFundoMeta(srcCnpj, ctx);
    if (row.nome_fundo?.trim()) ctx.fundoNomesOwner.get(srcCnpj)!.push(row.nome_fundo.trim());
    if (row.fundo_nome?.trim()) ctx.fundoNomesOwner.get(srcCnpj)!.push(row.fundo_nome.trim());
    if (row.fundo_cnpjgestor) ctx.fundoGestor.set(srcCnpj, row.fundo_cnpjgestor);
    if (row.fundo_nomegestor?.trim()) ctx.fundoGestorNome.set(srcCnpj, row.fundo_nomegestor.trim());
    if (row.fundo_cnpjadm) ctx.fundoAdm.set(srcCnpj, row.fundo_cnpjadm);
    if (row.fundo_nomeadm?.trim()) ctx.fundoAdmNome.set(srcCnpj, row.fundo_nomeadm.trim());
    if (row.fundo_patliq != null && row.fundo_patliq > 0) ctx.fundoPl.set(srcCnpj, row.fundo_patliq);
    if (row.fundo_dtposicao) ctx.fundoData.set(srcCnpj, row.fundo_dtposicao);
    const custodiante = (row as PosicaoCarteiraRow & { fundo_nomecustodiante?: string }).fundo_nomecustodiante;
    if (custodiante) ctx.fundoCustodiante.set(srcCnpj, custodiante);

    const section = (row.section || "").toLowerCase();

    if (section === "cotas") {
      registrarLinhaCota(row, ctx);
      continue;
    }

    const pct = pctPl(row);
    if (!incluirAtivoNoGrafo(pct)) continue;

    const sourceKey = buildFundoDisplayKey(srcCnpj);

    if (SECTIONS_ATIVOS.includes(section as (typeof SECTIONS_ATIVOS)[number])) {
      const ativoKey = getAtivoKeyFromRow(row);
      const targetKey = keyAtivoRede(ativoKey);

      const id = buildArestaId(sourceKey, targetKey, row.isin, row.nomecomercial);
      ctx.arestaMap.set(id, {
        id,
        source: sourceKey,
        target: targetKey,
        pctPl: pct,
        valorFinanceiro: row.section === "imoveis" ? row.valorcontabil ?? null : row.valor_padrao ?? null,
        tipo: "ativo",
        isSubordinada: false,
        nomeAresta: formatNomeAtivo(row),
      });

      if (!ctx.ativoMeta.has(targetKey)) {
        ctx.ativoMeta.set(targetKey, { nome: formatNomeAtivo(row), section, cnpjContraparte: row.cnpjemissor || row.cnpjpart || undefined });
      }
    }
  }
}

export async function buildSnapshot(dtposicao: string, options: { estrito?: boolean } = {}): Promise<RedeSnapshot> {
  const pares = await fetchParesMonitorados(dtposicao);
  const monitoredCnpjs = new Set(pares.map((p) => normalizeCnpjDigits(p.fundo_cnpj)));

  const cotasRows = (await fetchPosicaoPaginado(dtposicao, ["cotas"])) as RowFull[];
  const cotaResolver = await buildCotaTargetResolver(cotasRows);

  const fwdAdj = new Map<string, string[]>();
  const revAdj = new Map<string, string[]>();
  for (const row of cotasRows) {
    const src = normalizeCnpjDigits(row.fundo_cnpj);
    const tgt = resolveTargetCnpjCota(row, cotaResolver);
    if (!src || !tgt || src === tgt) continue;
    if (!incluirCotaNoGrafo(pctPl(row))) continue;
    const fwd = fwdAdj.get(src) ?? [];
    fwd.push(tgt);
    fwdAdj.set(src, fwd);
    const rev = revAdj.get(tgt) ?? [];
    rev.push(src);
    revAdj.set(tgt, rev);
  }

  const reachable = new Set<string>(monitoredCnpjs);
  const queue = [...monitoredCnpjs];
  while (queue.length > 0) {
    const cnpj = queue.shift()!;
    for (const nbr of [...(fwdAdj.get(cnpj) ?? []), ...(revAdj.get(cnpj) ?? [])]) {
      if (!reachable.has(nbr)) {
        reachable.add(nbr);
        queue.push(nbr);
      }
    }
  }

  const fundoNomesOwner = new Map<string, string[]>();
  const fundoNomesRef = new Map<string, string[]>();
  const fundoGestor = new Map<string, string | null>();
  const fundoAdm = new Map<string, string | null>();
  const fundoGestorNome = new Map<string, string | null>();
  const fundoAdmNome = new Map<string, string | null>();
  const fundoPl = new Map<string, number | null>();
  const fundoData = new Map<string, string>();
  const fundoCustodiante = new Map<string, string>();
  const ativoMeta = new Map<string, { nome: string; section: string; cnpjContraparte?: string }>();
  const arestaMap = new Map<string, ArestaRede>();

  const ctx: PortfolioContext = {
    arestaMap,
    fundoNomesOwner,
    fundoNomesRef,
    fundoGestor,
    fundoAdm,
    fundoGestorNome,
    fundoAdmNome,
    fundoPl,
    fundoData,
    fundoCustodiante,
    ativoMeta,
    isinParaCnpj: cotaResolver.isinParaCnpj,
    nomeParaCnpj: cotaResolver.nomeParaCnpj,
    cnpjsFundosValidos: cotaResolver.cnpjsFundosValidos,
  };

  for (const p of pares) {
    const cnpj = normalizeCnpjDigits(p.fundo_cnpj);
    ensureFundoMeta(cnpj, ctx);
    if (p.nome_fundo?.trim()) ctx.fundoNomesOwner.get(cnpj)!.push(p.nome_fundo.trim());
    if (p.cnpj_gestor) ctx.fundoGestor.set(cnpj, p.cnpj_gestor);
    if (p.gestor_nome?.trim()) ctx.fundoGestorNome.set(cnpj, p.gestor_nome.trim());
    if (p.fundo_patliq != null && p.fundo_patliq > 0) ctx.fundoPl.set(cnpj, p.fundo_patliq);
  }

  for (const row of cotasRows) {
    const src = normalizeCnpjDigits(row.fundo_cnpj);
    if (!reachable.has(src)) continue;
    if (!incluirCotaNoGrafo(pctPl(row))) continue;
    ensureFundoMeta(src, ctx);
    if (row.nome_fundo?.trim()) ctx.fundoNomesOwner.get(src)!.push(row.nome_fundo.trim());
    if (row.fundo_nome?.trim()) ctx.fundoNomesOwner.get(src)!.push(row.fundo_nome.trim());
    const tgt = resolveTargetCnpjCota(row, cotaResolver);
    if (tgt && reachable.has(tgt)) ensureFundoMeta(tgt, ctx);
  }

  const seedsIniciais = new Set<string>([...monitoredCnpjs, ...reachable]);

  for (const row of cotasRows) {
    const tgt = resolveTargetCnpjCota(row, cotaResolver);
    if (tgt && incluirCotaNoGrafo(pctPl(row))) seedsIniciais.add(tgt);
  }

  await carregarCarteirasEmOndas(seedsIniciais, dtposicao, ctx, options.estrito);

  // Cotas da data de referência (inclui 0% PL) — garante SET→BACO/REAG mesmo se XML do fundo for de outra data.
  for (const row of cotasRows) {
    const src = normalizeCnpjDigits(row.fundo_cnpj);
    if (!reachable.has(src)) continue;
    registrarLinhaCota(row, ctx);
  }

  for (const e of arestaMap.values()) {
    if (e.tipo !== "cota" || !e.nomeAresta?.trim()) continue;
    const tgt = cnpjFromDisplayKey(e.target);
    if (!tgt) continue;
    ensureFundoMeta(tgt, ctx);
    ctx.fundoNomesRef.get(tgt)!.push(e.nomeAresta.trim());
  }

  const arestas = [...arestaMap.values()];
  const fundoKeysSorted = [
    ...new Set([...fundoNomesOwner.keys(), ...fundoNomesRef.keys()]),
  ].sort();
  const ativoKeysSorted = [...ativoMeta.keys()].sort();
  const layout = computeLayout(
    fundoKeysSorted,
    ativoKeysSorted,
    arestas.map((e) => ({ source: e.source, target: e.target })),
  );
  const nomesCadastro = await fetchNomesFundosCaracteristicas(fundoKeysSorted);
  const donoPorNome = donoPorNomeCanonico(
    fundoKeysSorted.map((cnpj) => ({
      cnpj,
      ownerNomes: fundoNomesOwner.get(cnpj) ?? [],
      cadastro: nomesCadastro.get(cnpj),
    })),
  );

  const nos: NoRede[] = [
    ...fundoKeysSorted.map((cnpj) => {
      const displayKey = buildFundoDisplayKey(cnpj);
      const pos = layout.get(displayKey) ?? { x: 500, y: 350 };
      return {
        key: displayKey,
        tipo: "fundo" as const,
        nome: nomeFundoComCadastro(
          cnpj,
          fundoNomesOwner.get(cnpj) ?? [],
          fundoNomesRef.get(cnpj) ?? [],
          nomesCadastro,
          donoPorNome,
        ),
        x: pos.x,
        y: pos.y,
        cnpj,
        cnpjGestor: fundoGestor.get(cnpj) ?? null,
        cnpjAdm: fundoAdm.get(cnpj) ?? null,
        gestorNome: fundoGestorNome.get(cnpj) ?? null,
        administradorNome: fundoAdmNome.get(cnpj) ?? null,
        patrimonioLiquido: fundoPl.get(cnpj) ?? null,
        dataCarteira: fundoData.get(cnpj) ?? null,
        custodianteNome: fundoCustodiante.get(cnpj) ?? null,
      };
    }),
    ...ativoKeysSorted.map((key) => {
      const meta = ativoMeta.get(key)!;
      const pos = layout.get(key) ?? { x: 500, y: 100 };
      return {
        key,
        tipo: "ativo" as const,
        nome: meta.nome,
        x: pos.x,
        y: pos.y,
        section: meta.section,
        cnpjContraparte: meta.cnpjContraparte,
      };
    }),
  ];

  return {
    nos,
    arestas,
    dtposicao,
    monitoredCnpjs,
    nFundos: fundoKeysSorted.length,
    nAtivos: ativoMeta.size,
  };
}
