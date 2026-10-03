import { isinUtilizavel } from "@/hooks/useRentabilidadeCalc";
import { supabase } from "@/integrations/supabase/client";

export interface MapaAtivoNomeRow {
  ativo_tipo: string;
  ativo_identificador: string;
  ativo_isin: string | null;
  ativo_cnpj_emissor: string | null;
  ativo_cnpj_fundo: string | null;
  ativo_nome_imovel?: string | null;
  /** Nome fornecido pela própria posição, como a descrição ANBIMA da provisão. */
  ativo_nome?: string | null;
}

export interface NomeLookupKeys {
  cnpjs: string[];
  isins: string[];
}

const cleanCNPJ = (s: string | null | undefined) => (s ? s.replace(/\D/g, "") : "");

/** Coleta CNPJs e ISINs para lookup no cadastro (sempre ambos quando disponíveis). */
export function collectNomeLookupKeys(rows: MapaAtivoNomeRow[]): NomeLookupKeys {
  const cnpjs = new Set<string>();
  const isins = new Set<string>();

  for (const r of rows) {
    const isin = isinUtilizavel(r.ativo_isin);
    if (isin) isins.add(isin);

    const cnpjFundo = cleanCNPJ(r.ativo_cnpj_fundo);
    if (cnpjFundo) cnpjs.add(cnpjFundo);

    const cnpjEmissor = cleanCNPJ(r.ativo_cnpj_emissor);
    if (cnpjEmissor) cnpjs.add(cnpjEmissor);

    if (r.ativo_tipo === "participacoes") {
      const m = /^participacoes:(\d+)/.exec(r.ativo_identificador);
      if (m?.[1]) cnpjs.add(m[1]);
    }
  }

  return {
    cnpjs: [...cnpjs],
    isins: [...isins],
  };
}

export function buildNomeMapFromFundos(
  fundos: Array<{
    cnpj_classe?: string | null;
    cnpj_fundo?: string | null;
    nome_comercial?: string | null;
    isin?: string | null;
  }>,
): Map<string, string> {
  const m = new Map<string, string>();

  for (const f of fundos) {
    const nome = (f.nome_comercial || "").trim();
    if (!nome) continue;

    const cnpjClasse = cleanCNPJ(f.cnpj_classe);
    const cnpjFundo = cleanCNPJ(f.cnpj_fundo);
    const isin = isinUtilizavel(f.isin);

    if (cnpjClasse) m.set(cnpjClasse, nome);
    if (cnpjFundo) m.set(cnpjFundo, nome);
    if (isin) m.set(isin, nome);
    if (cnpjClasse && isin) m.set(`cotas:cnpj:${cnpjClasse}:isin:${isin}`, nome);
    if (cnpjFundo && isin) m.set(`cotas:cnpj:${cnpjFundo}:isin:${isin}`, nome);
  }

  return m;
}

export function buildNomeMapFromAtivos(
  ativos: Array<{
    isin?: string | null;
    cnpj?: string | null;
    nome_frontend?: string | null;
    descricao?: string | null;
  }>,
): Map<string, string> {
  const m = new Map<string, string>();

  for (const a of ativos) {
    const nome = (a.nome_frontend || a.descricao || "").trim();
    if (!nome) continue;

    const cnpj = cleanCNPJ(a.cnpj);
    const isin = isinUtilizavel(a.isin);

    if (cnpj) m.set(cnpj, nome);
    if (isin) m.set(isin, nome);
    if (cnpj && isin) m.set(`cotas:cnpj:${cnpj}:isin:${isin}`, nome);
  }

  return m;
}

export function mergeNomeMaps(...maps: Map<string, string>[]): Map<string, string> {
  const merged = new Map<string, string>();
  for (const map of maps) {
    for (const [k, v] of map) merged.set(k, v);
  }
  return merged;
}

/** Coleta CNPJs e ISINs de linhas de posicao_carteira para lookup de nomes. */
export function collectNomeLookupKeysFromPosicao(
  rows: Array<{
    section?: string | null;
    cnpjfundo?: string | null;
    cnpjemissor?: string | null;
    isin?: string | null;
  }>,
): NomeLookupKeys {
  const cnpjs = new Set<string>();
  const isins = new Set<string>();

  for (const r of rows) {
    const section = (r.section || "").toLowerCase();
    const cnpjRaw = section === "cotas" ? r.cnpjfundo : r.cnpjemissor;
    const cnpj = cleanCNPJ(cnpjRaw);
    if (cnpj) cnpjs.add(cnpj);

    const isin = isinUtilizavel(r.isin);
    if (isin) isins.add(isin);
  }

  return { cnpjs: [...cnpjs], isins: [...isins] };
}

/** Busca nomes em fundos_caracteristicas (cadastro ANBIMA). */
export async function fetchNomeMapFromFundosCaracteristicas(
  cnpjs: string[],
  isins: string[] = [],
): Promise<Map<string, string>> {
  const unique = [...new Set(cnpjs.map((c) => cleanCNPJ(c)).filter(Boolean))];
  const isinsUnique = [...new Set(isins.map((i) => i.trim().toUpperCase()).filter(Boolean))];
  if (unique.length === 0 && isinsUnique.length === 0) return new Map();

  const filters: string[] = [];
  if (unique.length) {
    filters.push(`cnpj_classe.in.(${unique.join(",")})`);
    filters.push(`cnpj_fundo.in.(${unique.join(",")})`);
  }
  if (isinsUnique.length) filters.push(`isin.in.(${isinsUnique.join(",")})`);

  const { data, error } = await supabase
    .from("fundos_caracteristicas" as never)
    .select("cnpj_classe, cnpj_fundo, nome_comercial, isin")
    .or(filters.join(","));

  if (error) {
    console.warn("[mapaAtivosNome] Erro ao buscar nomes ANBIMA:", error.message);
    return new Map();
  }

  return buildNomeMapFromFundos(
    (data ?? []) as Array<{
      cnpj_classe: string | null;
      cnpj_fundo: string | null;
      nome_comercial: string | null;
      isin: string | null;
    }>,
  );
}

/** Busca nomes em ativos (nome_frontend editável; fallback descricao do XML). */
export async function fetchNomeMapFromAtivosTable(
  cnpjs: string[],
  isins: string[],
): Promise<Map<string, string>> {
  const cnpjsUnique = [...new Set(cnpjs.map((c) => cleanCNPJ(c)).filter(Boolean))];
  const isinsUnique = [...new Set(isins.map((i) => i.trim().toUpperCase()).filter(Boolean))];
  if (cnpjsUnique.length === 0 && isinsUnique.length === 0) return new Map();

  const filters: string[] = [];
  if (cnpjsUnique.length) filters.push(`cnpj.in.(${cnpjsUnique.join(",")})`);
  if (isinsUnique.length) filters.push(`isin.in.(${isinsUnique.join(",")})`);

  const { data, error } = await supabase
    .from("ativos")
    .select("cnpj, isin, nome_frontend, descricao")
    .or(filters.join(","));

  if (error) {
    console.warn("[mapaAtivosNome] Erro ao buscar nomes frontend:", error.message);
    return new Map();
  }

  return buildNomeMapFromAtivos(
    (data ?? []) as Array<{
      cnpj: string | null;
      isin: string | null;
      nome_frontend: string | null;
      descricao: string | null;
    }>,
  );
}

/** Prioridade: nome_frontend/descricao (ativos) > nome_comercial (ANBIMA). */
export function mergeNomesAtivosCarteira(
  anbima: Map<string, string>,
  frontend: Map<string, string>,
): Map<string, string> {
  return mergeNomeMaps(anbima, frontend);
}

export function nomeMapToRecord(m: Map<string, string>): Record<string, string> {
  return Object.fromEntries(m);
}

function getFromNomeMap(
  nomeMap: Map<string, string> | Record<string, string>,
  key: string,
): string | undefined {
  if (nomeMap instanceof Map) return nomeMap.get(key);
  return nomeMap[key];
}

/** Lookup genérico: chave composta CNPJ+ISIN > ISIN > CNPJ. */
export function resolveNomeFromLookupMap(
  cnpj: string | null | undefined,
  isin: string | null | undefined,
  nomeMap: Map<string, string> | Record<string, string>,
): string | null {
  const cnpjClean = cleanCNPJ(cnpj);
  const isinClean = isinUtilizavel(isin);

  if (cnpjClean && isinClean) {
    const composto = getFromNomeMap(nomeMap, `cotas:cnpj:${cnpjClean}:isin:${isinClean}`);
    if (composto) return composto;
  }
  if (isinClean) {
    const byIsin = getFromNomeMap(nomeMap, isinClean);
    if (byIsin) return byIsin;
  }
  if (cnpjClean) {
    const byCnpj = getFromNomeMap(nomeMap, cnpjClean);
    if (byCnpj) return byCnpj;
  }
  return null;
}

/** Descrição de origem no cardápio: cadastro ANBIMA (por ISIN) > descricao do XML. */
export function resolveDescricaoOrigemAtivo(
  ativo: {
    descricao?: string | null;
    cnpj?: string | null;
    isin?: string | null;
    tipo_ativo?: string | null;
  },
  nomeMapAnbima: Map<string, string> | Record<string, string>,
): string {
  const isFundo = ativo.tipo_ativo === "FUNDO" || ativo.tipo_ativo === "FIDC";
  if (isFundo) {
    const fromAnbima = resolveNomeFromLookupMap(ativo.cnpj, ativo.isin, nomeMapAnbima);
    if (fromAnbima) return fromAnbima;
  }
  return (ativo.descricao || "").trim() || "Sem descricao";
}

/** Resolve nome do ativo priorizando chave composta ISIN+CNPJ. */
export function resolveMapaAtivoNome(
  row: MapaAtivoNomeRow,
  nomeMap: Map<string, string>,
): string {
  // Provisões não têm ISIN/CNPJ para lookup. A descrição já vem da tabela
  // ANBIMA via view e deve prevalecer sobre o código operacional (ex.: 999).
  if (row.ativo_nome?.trim()) {
    return row.ativo_nome.trim();
  }

  if (row.ativo_tipo === "imoveis" && row.ativo_nome_imovel) {
    return row.ativo_nome_imovel;
  }

  const byId = nomeMap.get(row.ativo_identificador);
  if (byId) return byId;

  const isin = isinUtilizavel(row.ativo_isin);
  const cnpjFundo = cleanCNPJ(row.ativo_cnpj_fundo);

  if (cnpjFundo && isin) {
    const composto = nomeMap.get(`cotas:cnpj:${cnpjFundo}:isin:${isin}`);
    if (composto) return composto;
  }

  if (isin) {
    const byIsin = nomeMap.get(isin);
    if (byIsin) return byIsin;
  }

  if (cnpjFundo) {
    const byCnpj = nomeMap.get(cnpjFundo);
    if (byCnpj) return byCnpj;
  }

  const cnpjEmissor = cleanCNPJ(row.ativo_cnpj_emissor);
  if (cnpjEmissor) {
    const byEmissor = nomeMap.get(cnpjEmissor);
    if (byEmissor) return byEmissor;
  }

  return "";
}

export function collectCnpjLookupKeys(rows: MapaAtivoNomeRow[]): string[] {
  const cnpjs = new Set<string>();

  const add = (v: string | null | undefined) => {
    const c = cleanCNPJ(v);
    if (c.length === 14) cnpjs.add(c);
  };

  for (const r of rows) {
    add(r.ativo_cnpj_fundo);
    add(r.ativo_cnpj_emissor);

    const cota = /cotas:cnpj:(\d{14})/.exec(r.ativo_identificador || "");
    if (cota?.[1]) cnpjs.add(cota[1]);

    if (r.ativo_tipo === "participacoes") {
      const part = /^participacoes:(\d{14})/.exec(r.ativo_identificador || "");
      if (part?.[1]) cnpjs.add(part[1]);
    }

    if (r.ativo_tipo === "titpublico" || r.ativo_tipo === "titprivado") {
      const parts = (r.ativo_identificador || "").split("|");
      add(parts[3]);
    }
  }

  return [...cnpjs];
}

/** CNPJ do ativo para lookup de administrador/gestor (somente dígitos). */
export function resolveCnpjAtivo(row: MapaAtivoNomeRow): string {
  const cnpjFundo = cleanCNPJ(row.ativo_cnpj_fundo);
  if (cnpjFundo.length === 14) return cnpjFundo;

  const cnpjEmissor = cleanCNPJ(row.ativo_cnpj_emissor);
  if (cnpjEmissor.length === 14) return cnpjEmissor;

  const cota = /cotas:cnpj:(\d{14})/.exec(row.ativo_identificador || "");
  if (cota?.[1]) return cota[1];

  if (row.ativo_tipo === "participacoes") {
    const part = /^participacoes:(\d{14})/.exec(row.ativo_identificador || "");
    if (part?.[1]) return part[1];
  }

  if (row.ativo_tipo === "titpublico" || row.ativo_tipo === "titprivado") {
    const parts = (row.ativo_identificador || "").split("|");
    const c = cleanCNPJ(parts[3]);
    if (c.length === 14) return c;
  }

  return "";
}

export interface MapaAtivoGestao {
  administrador: string;
  gestor: string;
}

const emptyGestao = (): MapaAtivoGestao => ({ administrador: "", gestor: "" });

function upsertGestaoEntry(
  m: Map<string, MapaAtivoGestao>,
  cnpj: string,
  administrador: string | null | undefined,
  gestor: string | null | undefined,
) {
  if (cnpj.length !== 14) return;

  const next: MapaAtivoGestao = {
    administrador: (administrador || "").trim(),
    gestor: (gestor || "").trim(),
  };
  if (!next.administrador && !next.gestor) return;

  const cur = m.get(cnpj);
  if (!cur) {
    m.set(cnpj, next);
    return;
  }

  m.set(cnpj, {
    administrador: cur.administrador || next.administrador,
    gestor: cur.gestor || next.gestor,
  });
}

export function buildGestaoMapFromFundos(
  fundos: Array<{
    cnpj_classe?: string | null;
    cnpj_fundo?: string | null;
    administrador?: string | null;
    gestor_principal?: string | null;
  }>,
): Map<string, MapaAtivoGestao> {
  const m = new Map<string, MapaAtivoGestao>();

  for (const f of fundos) {
    upsertGestaoEntry(m, cleanCNPJ(f.cnpj_classe), f.administrador, f.gestor_principal);
    upsertGestaoEntry(m, cleanCNPJ(f.cnpj_fundo), f.administrador, f.gestor_principal);
  }

  return m;
}

/** Resolve administrador/gestor do ativo via cadastro ANBIMA — match somente por CNPJ. */
export function resolveMapaAtivoGestao(
  row: MapaAtivoNomeRow,
  gestaoMap: Map<string, MapaAtivoGestao>,
): MapaAtivoGestao {
  const cnpj = resolveCnpjAtivo(row);
  if (!cnpj) return emptyGestao();
  return gestaoMap.get(cnpj) ?? emptyGestao();
}
