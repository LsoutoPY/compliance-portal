/**
 * Resolve qual linha de fundos_caracteristicas corresponde a uma posição da carteira.
 * Prioridade: CNPJ da linha + ISIN (subclasse) quando o ISIN existe na posição;
 * caso contrário, fallback só por CNPJ (prefere registro sem ISIN de subclasse / estrutura Classe|Fundo).
 */

export type FundoCaracteristicaLinha = {
  id?: string;
  cnpj_classe?: string | null;
  cnpj_fundo?: string | null;
  isin?: string | null;
  estrutura?: string | null;
  nome_comercial?: string | null;
  prazo_pagamento_resgate_dias?: number | null;
};

export function normalizeCnpjDigits(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

export function normalizeCnpj14(v: unknown): string | null {
  const d = normalizeCnpjDigits(v);
  if (!d) return null;
  return d.length >= 14 ? d.slice(-14) : d.padStart(14, "0");
}

/** ISIN utilizável para match (ignora vazio / mascarado ANBIMA) */
export function normalizeIsinLiquidez(v: unknown): string | null {
  const s = String(v ?? "").trim().toUpperCase();
  if (!s || s.includes("*")) return null;
  return s;
}

export function cnpjMatchCaracteristica(row: FundoCaracteristicaLinha, cnpj14: string | null): boolean {
  if (!cnpj14) return false;
  const target = cnpj14;
  const nc = normalizeCnpj14(row.cnpj_classe);
  const nf = normalizeCnpj14(row.cnpj_fundo);
  return nc === target || nf === target;
}

/** Preferir linhas agregadas Classe/Fundo ao resolver fallback sem ISIN (evita pegar subclasse aleatória). */
export function preferEstruturaClasseFundo(r: FundoCaracteristicaLinha): boolean {
  const e = r.estrutura;
  return e == null || e === "Classe" || e === "Fundo";
}

/**
 * Deduplica linhas trazidas por cnpj_classe / cnpj_fundo (mesmo registro pode aparecer nas duas queries).
 */
export function dedupeCaracteristicasLinhas(linhas: FundoCaracteristicaLinha[]): FundoCaracteristicaLinha[] {
  const seen = new Set<string>();
  const out: FundoCaracteristicaLinha[] = [];
  for (const r of linhas) {
    const key = r.id ?? `${r.cnpj_classe}|${r.cnpj_fundo}|${r.isin}|${r.prazo_pagamento_resgate_dias}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export function pickCaracteristicaParaPosicao(
  linhas: FundoCaracteristicaLinha[],
  cnpjLinhaRaw: unknown,
  isinLinhaRaw: unknown,
): FundoCaracteristicaLinha | null {
  const cnpj14 = normalizeCnpj14(cnpjLinhaRaw);
  if (!cnpj14) return null;

  const isinPos = normalizeIsinLiquidez(isinLinhaRaw);
  const candidatos = linhas.filter((r) => cnpjMatchCaracteristica(r, cnpj14));
  if (candidatos.length === 0) return null;

  if (isinPos) {
    const exato = candidatos.find((r) => normalizeIsinLiquidez(r.isin) === isinPos);
    if (exato) return exato;
  }

  const withPrazo = candidatos.filter((r) => r.prazo_pagamento_resgate_dias != null);
  const pool = withPrazo.length > 0 ? withPrazo : candidatos;
  const estruturaOk = pool.filter(preferEstruturaClasseFundo);
  const pickFrom = estruturaOk.length > 0 ? estruturaOk : pool;
  const semIsinSubclasse = pickFrom.filter((r) => !normalizeIsinLiquidez(r.isin));
  return semIsinSubclasse[0] ?? pickFrom[0] ?? null;
}
