/**
 * Lookup de nomes de ativos — porte Deno de `src/lib/mapaAtivosNome.ts` (subset).
 */

import { isinUtilizavel } from "./calc.ts";

const cleanCNPJ = (s: string | null | undefined) => (s ? s.replace(/\D/g, "") : "");

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
