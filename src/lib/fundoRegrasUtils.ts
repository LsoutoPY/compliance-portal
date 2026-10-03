/** Utilitários para associação regra↔fundo por (CNPJ, ISIN). */

export function normalizeCnpj14(cnpj: string): string {
  return String(cnpj ?? "").replace(/\D/g, "").padStart(14, "0").slice(-14);
}

export function fundPairKey(cnpj: string, isin?: string | null): string {
  return `${normalizeCnpj14(cnpj)}|${isin ?? ""}`;
}

export function parseFundPairKey(key: string): { cnpj: string; isin: string } {
  const [cnpj, ...rest] = key.split("|");
  return { cnpj: normalizeCnpj14(cnpj), isin: rest.join("|") };
}

/** Valores de fundo_isin para query Supabase (.in). */
export function fundoRegrasIsinQueryValues(fundoIsin?: string | null): string[] {
  const isin = fundoIsin ?? "";
  return isin ? [isin, ""] : [""];
}

export interface FundoSubclasseItem {
  cnpj: string;
  isin: string;
  nome: string;
  key: string;
}

/** Lista fundos distintos por (CNPJ, ISIN) a partir de posicao_carteira. */
function resolveFundoNomeRow(row: {
  fundo_nome?: string | null;
  nome_fundo?: string | null;
}): string {
  return String(row.nome_fundo ?? row.fundo_nome ?? "").trim();
}

export function buildFundosSubclasseList(
  rows: Array<{
    fundo_cnpj: string;
    fundo_isin?: string | null;
    fundo_nome?: string | null;
    nome_fundo?: string | null;
  }>,
): FundoSubclasseItem[] {
  const map = new Map<string, FundoSubclasseItem>();

  for (const row of rows) {
    if (!row.fundo_cnpj) continue;
    const cnpj = normalizeCnpj14(row.fundo_cnpj);
    const isin = row.fundo_isin ?? "";
    const key = fundPairKey(cnpj, isin);
    const nome = resolveFundoNomeRow(row);
    const current = map.get(key);
    if (!current) {
      map.set(key, {
        cnpj,
        isin,
        nome: nome || cnpj,
        key,
      });
      continue;
    }
    // Linha mais recente pode vir sem nome; não bloquear atualização com nome real
    if (nome && (current.nome === current.cnpj || !current.nome)) {
      map.set(key, { ...current, nome });
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const byNome = a.nome.localeCompare(b.nome, "pt-BR");
    if (byNome !== 0) return byNome;
    return a.isin.localeCompare(b.isin);
  });
}

/** Adiciona opção "todas subclasses" para CNPJs com múltiplos ISINs. */
export function addTodasSubclassesOptions(items: FundoSubclasseItem[]): FundoSubclasseItem[] {
  const isinsByCnpj = new Map<string, Set<string>>();
  for (const f of items) {
    if (!f.isin) continue;
    if (!isinsByCnpj.has(f.cnpj)) isinsByCnpj.set(f.cnpj, new Set());
    isinsByCnpj.get(f.cnpj)!.add(f.isin);
  }

  const extras: FundoSubclasseItem[] = [];
  for (const [cnpj, isins] of isinsByCnpj) {
    if (isins.size <= 1) continue;
    const sample = items.find((f) => f.cnpj === cnpj && f.isin);
    const baseNome = sample?.nome.replace(/\s+(JR|SR|MEZ[A-Z]*|S[êe]NIOR|J[úu]NIOR)\s*$/i, "").trim() || cnpj;
    extras.push({
      cnpj,
      isin: "",
      nome: baseNome,
      key: fundPairKey(cnpj, ""),
    });
  }

  const existingKeys = new Set(items.map((f) => f.key));
  const merged = [...items];
  for (const extra of extras) {
    if (!existingKeys.has(extra.key)) merged.push(extra);
  }

  return merged.sort((a, b) => {
    const byNome = a.nome.localeCompare(b.nome, "pt-BR");
    if (byNome !== 0) return byNome;
    if (!a.isin && b.isin) return 1;
    if (a.isin && !b.isin) return -1;
    return a.isin.localeCompare(b.isin);
  });
}

/** Remove sufixo JR/SR/MEZ do fundo_nome para rótulo "todas subclasses". */
export function inferFundoNomeBase(nomes: string[]): string {
  const valid = nomes.map((n) => n.trim()).filter(Boolean);
  if (valid.length === 0) return "";
  const sample = valid[0];
  const stripped = sample.replace(/\s+(JR|SR|MEZ[A-Z]*|S[êe]NIOR|J[úu]NIOR)\s*$/i, "").trim();
  return stripped || sample;
}

/** Preenche nameMap com fundo_nome por (CNPJ, ISIN) e rótulo global CNPJ|''. */
export function populateFundoNomeMapFromPosicao(
  nameMap: Map<string, string>,
  rows: Array<{
    fundo_cnpj: string;
    fundo_isin?: string | null;
    fundo_nome?: string | null;
    nome_fundo?: string | null;
  }>,
  cnpjsNorm: string[],
): void {
  const nomesByCnpj = new Map<string, string[]>();

  for (const row of rows) {
    if (!row.fundo_cnpj) continue;
    const cnpjNorm = normalizeCnpj14(row.fundo_cnpj);
    if (!cnpjsNorm.includes(cnpjNorm)) continue;
    const nome = resolveFundoNomeRow(row);
    if (!nome) continue;
    const isin = row.fundo_isin ?? "";
    const key = fundPairKey(cnpjNorm, isin);
    if (!nameMap.has(key)) nameMap.set(key, nome);
    const list = nomesByCnpj.get(cnpjNorm) ?? [];
    if (!list.includes(nome)) list.push(nome);
    nomesByCnpj.set(cnpjNorm, list);
  }

  for (const [cnpjNorm, nomes] of nomesByCnpj) {
    const globalKey = fundPairKey(cnpjNorm, "");
    if (nameMap.has(globalKey)) continue;
    const base = nomes.length === 1 ? nomes[0] : inferFundoNomeBase(nomes);
    if (base) nameMap.set(globalKey, base);
  }
}

export function resolveFundoNomeFromMap(
  nameMap: Map<string, string>,
  cnpj: string,
  isin?: string | null,
): string | null {
  const cnpjNorm = normalizeCnpj14(cnpj);
  const isinNorm = isin ?? "";
  const direct =
    nameMap.get(fundPairKey(cnpjNorm, isinNorm)) ??
    nameMap.get(fundPairKey(cnpjNorm, "")) ??
    nameMap.get(cnpjNorm);
  if (direct) return direct;

  // Associação global ou CNPJ sem chave '' — usa qualquer fundo_nome da mesma classe
  if (!isinNorm) {
    for (const [key, nome] of nameMap) {
      if (key.startsWith(`${cnpjNorm}|`) && key !== `${cnpjNorm}|`) return nome;
    }
  }
  return null;
}

/** Resolve regras aplicáveis: global ('') + específica da subclasse; específica prevalece. */
export function resolveFundoRegrasForIsin<T extends { fundo_isin?: string | null; regra_id: string }>(
  rows: T[] | null | undefined,
  fundoIsin?: string | null,
): T[] {
  const isin = fundoIsin ?? "";
  const applicable = (rows ?? []).filter((r) => {
    const rowIsin = r.fundo_isin ?? "";
    return rowIsin === "" || rowIsin === isin;
  });

  const byRegra = new Map<string, T>();
  for (const row of applicable) {
    const rowIsin = row.fundo_isin ?? "";
    const existing = byRegra.get(row.regra_id);
    if (!existing) {
      byRegra.set(row.regra_id, row);
      continue;
    }
    if (rowIsin !== "" && (existing.fundo_isin ?? "") === "") {
      byRegra.set(row.regra_id, row);
    }
  }
  return Array.from(byRegra.values());
}

export function fundoRegrasDisplayLabel(nome: string, isin: string): string {
  if (!isin) return `${nome} (todas subclasses)`;
  return nome;
}

export type RegraAssociadaResumo = {
  codigo: string;
  descricao?: string | null;
};

export type FundoRegrasResumoItem = {
  fundo_cnpj: string;
  fundo_isin: string;
  nome_fundo: string | null;
  key: string;
  count: number;
  regras: RegraAssociadaResumo[];
};

export type FundoRegraStatusAprovacao = "ativo" | "pendente" | "rejeitado";

/** Vínculo aprovado e elegível para enquadramento (manual ou importação autorizada). */
export function isFundoRegraAtivaParaEnquadramento(row: {
  ativo?: boolean | null;
  status_aprovacao?: FundoRegraStatusAprovacao | string | null;
}): boolean {
  return row.ativo !== false && (row.status_aprovacao ?? "ativo") === "ativo";
}

/** Verifica se a data de posição (YYYYMMDD) está dentro da vigência do vínculo. */
export function isFundoRegraVigente(
  row: { dt_inicio_vigencia?: string | null; dt_fim_vigencia?: string | null },
  fundoDtposicao: string,
): boolean {
  const pos = String(fundoDtposicao ?? "").replace(/\D/g, "").slice(0, 8);
  if (pos.length !== 8) return true;
  const posDate = `${pos.slice(0, 4)}-${pos.slice(4, 6)}-${pos.slice(6, 8)}`;
  if (row.dt_inicio_vigencia && posDate < row.dt_inicio_vigencia) return false;
  if (row.dt_fim_vigencia && posDate > row.dt_fim_vigencia) return false;
  return true;
}

export function labelStatusAprovacaoFundoRegra(status?: string | null): string {
  switch (status ?? "ativo") {
    case "pendente":
      return "Enviado para autorização";
    case "rejeitado":
      return "Rejeitado";
    default:
      return "Ativo";
  }
}

/** Agrupa vínculos ativos fundo↔regra para visão consolidada por fundo. */
export function buildRegrasAssociadasPorFundo(
  associacoes: Array<{
    fundo_cnpj: string;
    fundo_isin?: string | null;
    ativo?: boolean | null;
    status_aprovacao?: string | null;
    fundo_nome?: string | null;
    regras_compliance?: { codigo?: string; descricao?: string | null } | null;
  }>,
): { total: number; porFundo: FundoRegrasResumoItem[] } {
  const active = associacoes.filter(isFundoRegraAtivaParaEnquadramento);
  const map = new Map<string, FundoRegrasResumoItem>();

  for (const a of active) {
    const cnpj = normalizeCnpj14(a.fundo_cnpj);
    const isin = a.fundo_isin ?? "";
    const key = fundPairKey(cnpj, isin);
    const regra = a.regras_compliance;
    const codigo = regra?.codigo ?? "?";

    let item = map.get(key);
    if (!item) {
      item = {
        fundo_cnpj: cnpj,
        fundo_isin: isin,
        nome_fundo: a.fundo_nome ?? null,
        key,
        count: 0,
        regras: [],
      };
      map.set(key, item);
    }
    if (!item.nome_fundo && a.fundo_nome) item.nome_fundo = a.fundo_nome;

    item.regras.push({ codigo, descricao: regra?.descricao });
    item.count += 1;
  }

  const porFundo = Array.from(map.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const nomeA = a.nome_fundo ?? a.fundo_cnpj;
    const nomeB = b.nome_fundo ?? b.fundo_cnpj;
    return nomeA.localeCompare(nomeB, "pt-BR");
  });

  return { total: active.length, porFundo };
}
