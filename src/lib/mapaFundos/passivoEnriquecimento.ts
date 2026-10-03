/**
 * Enriquecimento do modo Passivo do Mapa de Fundos com dados de passivo_fundos.
 *
 * Regra por tipo de fundo alvo:
 *   - Fundo monitorado (gestor): L1 só passivo_fundos (planilhas FINVEST, BTG, Posição Cotas)
 *   - Fundo externo: L1 só XML (cotas invertidas) — este módulo não é usado
 *
 * Resolução cotista→fundo via passivo_cotista_de_para + CNPJ 14 dígitos.
 * Expansão L2+ de cotistas-fundo identificados continua via XML.
 */

import { supabase } from "@/integrations/supabase/client";
import { normalizeCnpj14 } from "@/lib/liquidezFundosCaracteristicas";
import {
  resolvePassivoRowsForMapa,
  aggregatePassivoCotistas,
  filterPassivoRowsForSubclasse,
  normalizePassivoFundName,
  pickPassivoRowsForTargetName,
  type PassivoFundoRow,
} from "@/lib/passivoFundoMatch";
import {
  buildFundoDisplayKey,
  buildCotistaKey,
  isNoCotista,
} from "./keys";
import type { NoRede, ArestaRede } from "./snapshot";

export interface PassivoEnriquecimento {
  /** Nós extras (cotistas PF/PJ) a injetar no snapshot para exibição. */
  nosExtra: NoRede[];
  /**
   * Arestas passivo a injetar.
   * - Cotista PF/PJ: source = cotistaKey, target = seedKey
   * - Cotista fundo identificado: source = fundoDisplayKey, target = seedKey
   * pctPl = valor / plPassivoTotal
   */
  arestasExtra: ArestaRede[];
  /**
   * Chaves de fundo (buildFundoDisplayKey) cujos cotistas já aparecem no
   * passivo_fundos como fundos identificados. O BFS exclui arestas XML
   * invertidas para esses nós no nível 1 (evita duplicação).
   */
  fundosJaNoPassivo: Set<string>;
  /** Total do passivo do fundo (denominador do %). */
  plPassivoTotal: number;
  /** Data da posição do passivo usada (pode ser anterior à data do mapa). */
  dataPassivoUsada: string;
  /** Indica se há dados importados de passivo para este fundo. */
  temDados: boolean;
  /** Motivo quando temDados=false (para mensagem na UI). */
  motivoSemPassivo?: MotivoSemPassivo;
}

/** Por que o passivo importado não entrou no grafo. */
export type MotivoSemPassivo =
  | "sem_importacao"
  | "subclasse_nao_resolvida"
  | "filtro_data"
  | "pl_zero";

export interface PassivoEnriquecimentoOpts {
  /** Nome do fundo no grafo — desambigua subclasses no mesmo CNPJ. */
  fundName?: string | null;
  /** Nomes alternativos (cadastro, catálogo, XML). */
  fundNameCandidates?: string[];
  isin?: string | null;
}

export const PASSIVO_ENRIQUECIMENTO_VAZIO: PassivoEnriquecimento = {
  nosExtra: [],
  arestasExtra: [],
  fundosJaNoPassivo: new Set(),
  plPassivoTotal: 0,
  dataPassivoUsada: "",
  temDados: false,
  motivoSemPassivo: undefined,
};

const PASSIVO_SELECT =
  "fundo, fundo_cnpj, fundo_isin, cotista, valor, codigo_clt, administradora, data_posicao";

function expandNameVariants(names: string[]): string[] {
  const set = new Set<string>();
  for (const n of names) {
    if (!n?.trim()) continue;
    set.add(n.trim());
    try {
      set.add(n.normalize("NFC"));
      set.add(n.normalize("NFD"));
      set.add(n.normalize("NFKC"));
      set.add(n.normalize("NFKD"));
    } catch {
      /* ignore */
    }
  }
  return [...set].filter(Boolean);
}

function mergePassivoRows(lists: PassivoFundoRow[][]): PassivoFundoRow[] {
  const seen = new Set<string>();
  const merged: PassivoFundoRow[] = [];
  for (const list of lists) {
    for (const r of list) {
      const k = [r.administradora, r.data_posicao, r.fundo, r.fundo_cnpj, r.cotista, r.valor].join("\0");
      if (!seen.has(k)) {
        seen.add(k);
        merged.push(r);
      }
    }
  }
  return merged;
}

async function fetchPassivoByCnpjEq(eq: string): Promise<PassivoFundoRow[]> {
  const { data, error } = await (supabase as any)
    .from("passivo_fundos")
    .select(PASSIVO_SELECT)
    .eq("fundo_cnpj", eq)
    .order("data_posicao", { ascending: false })
    .limit(50000);
  if (error) throw error;
  return (data || []) as PassivoFundoRow[];
}

async function fetchPassivoByFundoIn(names: string[]): Promise<PassivoFundoRow[]> {
  const variants = expandNameVariants(names);
  if (variants.length === 0) return [];

  const chunkSize = 80;
  const parts: PassivoFundoRow[][] = [];
  for (let i = 0; i < variants.length; i += chunkSize) {
    const slice = variants.slice(i, i + chunkSize);
    const { data, error } = await (supabase as any)
      .from("passivo_fundos")
      .select(PASSIVO_SELECT)
      .in("fundo", slice)
      .order("data_posicao", { ascending: false })
      .limit(50000);
    if (error) throw error;
    if (data?.length) parts.push(data as PassivoFundoRow[]);
  }
  return mergePassivoRows(parts);
}

async function fetchPassivoByFundoIlike(token: string): Promise<PassivoFundoRow[]> {
  if (!token || token.length < 4) return [];
  const { data, error } = await (supabase as any)
    .from("passivo_fundos")
    .select(PASSIVO_SELECT)
    .ilike("fundo", `%${token}%`)
    .order("data_posicao", { ascending: false })
    .limit(20000);
  if (error) throw error;
  return (data || []) as PassivoFundoRow[];
}

async function fetchCadastroNames(cnpj: string): Promise<string[]> {
  const clean = normalizeCnpj14(cnpj);
  if (!clean) return [];
  const { data, error } = await (supabase as any)
    .from("fundos_caracteristicas")
    .select("nome_comercial, denominacao_social")
    .or(`cnpj_classe.eq.${clean},cnpj_fundo.eq.${clean}`);
  if (error) return [];
  const names = new Set<string>();
  for (const r of data || []) {
    const nc = (r as { nome_comercial?: string }).nome_comercial?.trim();
    const ds = (r as { denominacao_social?: string }).denominacao_social?.trim();
    if (nc) names.add(nc);
    if (ds) names.add(ds);
  }
  return [...names];
}

function passivoSearchTokens(fundNames: string[]): string[] {
  const skip = new Set(["MULTIMERCADO", "FIM", "FIC", "FIF", "FIDC", "FIP", "FUNDO"]);
  const tokens = new Set<string>();
  for (const name of fundNames) {
    for (const t of normalizePassivoFundName(name).split(/\s+/)) {
      if (t.length >= 5 && !skip.has(t)) tokens.add(t);
    }
  }
  return [...tokens];
}

/** Busca linhas brutas — CNPJ, cadastro, nome exato e ilike (como tela de detalhe). */
async function fetchPassivoRowsForMap(
  cnpj: string,
  opts: PassivoEnriquecimentoOpts,
): Promise<PassivoFundoRow[]> {
  const cnpjClean = cnpj.replace(/\D/g, "");
  const cnpjFormatted =
    cnpjClean.length === 14
      ? cnpjClean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
      : "";

  const nameCandidates = [
    opts.fundName,
    ...(opts.fundNameCandidates ?? []),
  ].filter((n): n is string => !!n?.trim());

  const parts: PassivoFundoRow[][] = [];

  if (cnpjClean) {
    parts.push(await fetchPassivoByCnpjEq(cnpjClean));
    if (cnpjFormatted && cnpjFormatted !== cnpjClean) {
      parts.push(await fetchPassivoByCnpjEq(cnpjFormatted));
    }

    const cadastroNames = await fetchCadastroNames(cnpjClean);
    nameCandidates.push(...cadastroNames);
  }

  const uniqueNames = [...new Set(nameCandidates.map((n) => n.trim()).filter(Boolean))];
  if (uniqueNames.length > 0) {
    parts.push(await fetchPassivoByFundoIn(uniqueNames));
  }

  let merged = mergePassivoRows(parts);
  if (merged.length > 0) return merged;

  for (const tok of passivoSearchTokens(uniqueNames)) {
    const byIlike = await fetchPassivoByFundoIlike(tok);
    if (byIlike.length === 0) continue;
    for (const name of uniqueNames) {
      const matched = filterPassivoRowsForSubclasse(byIlike, { fundName: name });
      if (matched.length > 0) return matched;
      const picked = pickPassivoRowsForTargetName(byIlike, name);
      if (picked.length > 0) return picked;
    }
  }

  return merged;
}

/**
 * Tenta resolver um cotista como fundo via cpf_cnpj no De-Para.
 * Retorna buildFundoDisplayKey se o cpf_cnpj tiver 14 dígitos (CNPJ), senão null.
 */
async function resolverCotistaParaFundoKey(
  codigoClt: number | null,
): Promise<string | null> {
  if (codigoClt == null) return null;
  const { data, error } = await (supabase as any)
    .from("passivo_cotista_de_para")
    .select("cpf_cnpj")
    .eq("codigo_cliente", codigoClt)
    .maybeSingle();
  if (error || !(data as { cpf_cnpj?: string } | null)?.cpf_cnpj) return null;
  const digits = (data as { cpf_cnpj: string }).cpf_cnpj.replace(/\D/g, "");
  if (digits.length === 14) return buildFundoDisplayKey(digits);
  return null;
}

function emptyPassivo(motivo: MotivoSemPassivo): PassivoEnriquecimento {
  return { ...PASSIVO_ENRIQUECIMENTO_VAZIO, motivoSemPassivo: motivo };
}

function diagnosticarSemPassivo(
  allRows: PassivoFundoRow[],
  cnpj: string,
  opts: PassivoEnriquecimentoOpts,
  dtposicao: string,
): MotivoSemPassivo {
  const cnpjNorm = normalizeCnpj14(cnpj);
  const porCnpj = cnpjNorm
    ? allRows.filter((r) => normalizeCnpj14(r.fundo_cnpj) === cnpjNorm)
    : [];

  if (porCnpj.length === 0 && allRows.length === 0) return "sem_importacao";

  const semFiltroData = resolvePassivoRowsForMapa(allRows, {
    cnpj,
    isin: opts.isin,
    fundName: opts.fundName,
    fundNameCandidates: opts.fundNameCandidates,
  });
  if (semFiltroData.length > 0) return "filtro_data";

  if (allRows.length > 0) return "subclasse_nao_resolvida";
  return "sem_importacao";
}

/**
 * Carrega e prepara o enriquecimento de passivo para o modo passivo do Mapa de Fundos.
 *
 * @param seedKey   - chave de exibição do fundo alvo (buildFundoDisplayKey)
 * @param cnpj      - CNPJ do fundo alvo (com ou sem formatação)
 * @param dtposicao - data de referência do mapa (YYYY-MM-DD ou YYYYMMDD)
 * @param opts      - fundName/isin para desambiguar subclasses (mesma regra do detalhe)
 */
export async function fetchPassivoEnriquecimento(
  seedKey: string,
  cnpj: string,
  dtposicao: string,
  opts: PassivoEnriquecimentoOpts = {},
): Promise<PassivoEnriquecimento> {
  if (!cnpj) return PASSIVO_ENRIQUECIMENTO_VAZIO;

  let allRows: PassivoFundoRow[];
  try {
    allRows = await fetchPassivoRowsForMap(cnpj, opts);
  } catch {
    return emptyPassivo("sem_importacao");
  }
  if (allRows.length === 0) return emptyPassivo("sem_importacao");

  const rows = resolvePassivoRowsForMapa(allRows, {
    cnpj,
    isin: opts.isin,
    fundName: opts.fundName,
    fundNameCandidates: opts.fundNameCandidates,
    asOfDate: dtposicao,
  });
  if (rows.length === 0) {
    return emptyPassivo(diagnosticarSemPassivo(allRows, cnpj, opts, dtposicao));
  }

  const cotistas = aggregatePassivoCotistas(rows);
  const plTotal = cotistas.reduce((s, c) => s + c.valor, 0);
  const dataUsada = rows.reduce((max, r) => {
    const d = String(r.data_posicao ?? "");
    return d > max ? d : max;
  }, "");

  if (plTotal <= 0) return emptyPassivo("pl_zero");

  // Resolve cotistas que são fundos via De-Para (paralelo)
  const resolucoes = await Promise.all(
    cotistas.map(async (c) => {
      const cotistaKey = buildCotistaKey(c.codigo_clt, c.cotista);
      const fundoKey = await resolverCotistaParaFundoKey(c.codigo_clt);
      return { cotistaKey, fundoKey, cotista: c };
    }),
  );

  const nosExtra: NoRede[] = [];
  const arestasExtra: ArestaRede[] = [];
  const fundosJaNoPassivo = new Set<string>();

  for (const { cotistaKey, fundoKey, cotista } of resolucoes) {
    const pctPl = cotista.valor / plTotal;

    if (fundoKey) {
      // Cotista identificado como fundo: usa fundo key diretamente para
      // permitir BFS continuar no nível 2+ via XML.
      fundosJaNoPassivo.add(fundoKey);
      arestasExtra.push({
        id: `passivo||${seedKey}||${fundoKey}`,
        source: fundoKey,
        target: seedKey,
        pctPl,
        tipo: "passivo",
        isSubordinada: false,
        nomeAresta: cotista.cotista,
      } as ArestaRede);
    } else {
      // Cotista PF/PJ: nó cotista + aresta passivo (sempre folha)
      nosExtra.push({
        key: cotistaKey,
        tipo: "cotista",
        nome: cotista.cotista,
        x: 0,
        y: 0,
      } as NoRede);
      arestasExtra.push({
        id: `passivo||${seedKey}||${cotistaKey}`,
        source: cotistaKey,
        target: seedKey,
        pctPl,
        tipo: "passivo",
        isSubordinada: false,
        nomeAresta: cotista.cotista,
      } as ArestaRede);
    }
  }

  return {
    nosExtra,
    arestasExtra,
    fundosJaNoPassivo,
    plPassivoTotal: plTotal,
    dataPassivoUsada: dataUsada,
    temDados: true,
  };
}

/**
 * Retorna o CNPJ (14 dígitos) de uma seedKey de fundo, ou string vazia
 * se a key não corresponder a um fundo identificável.
 */
export function cnpjDeSeedKey(seedKey: string): string {
  if (!seedKey.startsWith("fundo:")) return "";
  return seedKey.replace("fundo:", "");
}

/** Tipo guard para saber se um nó extra é cotista (não-fundo). */
export function isNoExtraCotista(key: string): boolean {
  return isNoCotista(key);
}

/** Mensagem de aviso quando passivo importado não entrou no grafo. */
export function mensagemAvisoSemPassivo(
  motivo: MotivoSemPassivo | undefined,
  fundName?: string,
): string {
  switch (motivo) {
    case "subclasse_nao_resolvida":
      return fundName
        ? `Passivo importado existe para o CNPJ, mas a subclasse "${fundName}" não foi resolvida — exibindo apenas cadeia XML`
        : "Passivo importado existe para o CNPJ, mas a subclasse não foi resolvida (informe o nome do fundo) — exibindo apenas cadeia XML";
    case "filtro_data":
      return "Passivo importado existe, mas não há posição na data do mapa — exibindo apenas cadeia XML";
    case "pl_zero":
      return "Passivo importado sem PL válido — exibindo apenas cadeia XML";
    case "sem_importacao":
    default:
      return "Sem dados de Passivo Fundos para este fundo — exibindo apenas cadeia XML";
  }
}
