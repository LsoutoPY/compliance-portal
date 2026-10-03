import { normalizeCnpj14, normalizeIsinLiquidez } from "@/lib/liquidezFundosCaracteristicas";

export type PassivoFundoRow = {
  fundo?: string | null;
  fundo_cnpj?: string | null;
  fundo_isin?: string | null;
  cotista?: string | null;
  valor?: number | null;
  codigo_clt?: number | null;
  administradora?: string | null;
  data_posicao?: string | null;
};

/** Rótulos de cabeçalho/subtotal da planilha — não são fundos reais */
export function isPassivoMetaLabel(text: string): boolean {
  const n = normalizePassivoFundName(text)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!n || n.length < 2) return true;
  const blocked = new Set([
    "CONTA DA CLASSE",
    "CONTA DA SUBCLASSE",
    "CONTA DA CLASSE/SUBCLASSE",
    "CLASSE/SUBCLASSE",
    "SUBTOTAL",
    "TOTAL GERAL",
    "TOTAL",
    "FUNDO NAO IDENTIFICADO",
    "COTISTA",
    "COTISTAS",
    "INVESTIDOR",
    "INVESTIDORES",
    "NOME DO FUNDO",
    "NOME DO COTISTA",
    "CLIENTE",
    "FUNDO",
    "RAZAO SOCIAL",
  ]);
  if (blocked.has(n)) return true;
  if (n.startsWith("TOTAL ") || n.endsWith(" TOTAL")) return true;
  if (n.includes("CONTA DA CLASSE") || n.includes("CLASSE/SUBCLASSE")) return true;
  return false;
}

/** Título de planilha / nome de arquivo — não é fundo */
export function isInvalidPassivoFundoName(text: string): boolean {
  if (isPassivoMetaLabel(text)) return true;
  const raw = String(text ?? "").trim();
  if (!raw || raw.length < 3) return true;
  const lower = raw.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  if (/\.(xlsx?|xltx?|csv)$/i.test(lower)) return true;
  if (/posi(cao|ção)\s*(de\s*)?cotistas?/i.test(lower)) return true;
  if (/passivo\s*(de\s*)?fundos?/i.test(lower)) return true;
  if (/^posi(cao|ção)\s*cotas?$/i.test(lower)) return true;
  if (/^(relatorio|planilha|exportacao|exportação)\b/i.test(lower)) return true;
  return false;
}

export function isPassivoMetaCotista(text: string): boolean {
  if (isInvalidPassivoFundoName(text)) return true;
  const n = String(text ?? "").trim().toLowerCase();
  return n === "total" || n.startsWith("total ");
}

/** Normaliza nome do fundo para match passivo ↔ carteira (preserva CP/LP) */
export function normalizePassivoFundName(name: string): string {
  const normalized = (name || "")
    .normalize("NFC")
    .replace(/\uFFFD/g, "")
    .toUpperCase()
    .replace(/\s*-\s*FIC\s+FIM\s*$/i, "")
    .replace(/\s+FIC\s+FIM\s*$/i, "")
    .replace(/\s*-\s*FIM\s*$/i, "")
    .replace(/\s+FUNDO\s+DE\s+INVESTIMENTO\s*$/i, "")
    .replace(/\s+EM\s+COTAS\s+DE\s+FUNDOS\s+DE\s+INVESTIMENTO\s*$/i, "")
    .replace(/\s+EM\s+COTAS\s+DE\s*$/i, "")
    .replace(/\s+MULTIMERCADO\s*$/i, "")
    .replace(/\s+CRÉDITO\s+PRIVADO\s*$/i, "")
    .replace(/\s+CREDITO\s+PRIVADO\s*$/i, "")
    .replace(/\s+FIC\s*$/i, "")
    .replace(/\s+FI\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  // A API Finvest/Sinqia e os arquivos históricos usam denominações distintas
  // para as mesmas subclasses. Essas equivalências foram validadas com a operação.
  const aliases: Record<string, string> = {
    "NEXUM FIDC": "FIDC NEXUM JR",
    "NEXUM FIDC SR": "FIDC NEXUM SR",
    "FICFIF QI ALVORADA": "FICFIF QI ALVORA",
  };
  return aliases[normalized] ?? normalized;
}

/** Nomes cuja equivalência foi confirmada mesmo quando a fonte histórica traz CNPJ divergente. */
const PASSIVO_ALIAS_FORCE_SINGLE_IDENTITY = new Set([
  "FIDC NEXUM JR",
  "FIDC NEXUM SR",
  "FICFIF QI ALVORA",
]);

const STOP_WORDS = new Set([
  "DE", "DO", "DA", "DOS", "DAS", "E", "EM", "NO", "NA", "PARA", "COM", "A", "O",
]);

/** Sufixos que distinguem subclasses no mesmo CNPJ (JR/SR, CP/LP, série romana, etc.) */
const SUBCLASSE_DISCRIMINATORS = new Set([
  "JR",
  "SR",
  "JUNIOR",
  "SENIOR",
  "CP",
  "LP",
  "I",
  "II",
  "III",
  "IV",
  "V",
]);

function extractSubclasseDiscriminators(name: string): Set<string> {
  return new Set(
    normalizePassivoFundName(name)
      .split(/\s+/)
      .filter((t) => SUBCLASSE_DISCRIMINATORS.has(t)),
  );
}

/** Bloqueia match JR↔SR quando ambos os lados declaram sufixo de subclasse diferente */
export function passivoSubclasseDiscriminatorsCompatible(a: string, b: string): boolean {
  const da = extractSubclasseDiscriminators(a);
  const db = extractSubclasseDiscriminators(b);
  if (da.size === 0 || db.size === 0) return true;
  for (const t of da) {
    if (db.has(t)) return true;
  }
  return false;
}

function tokenizePassivoName(name: string): string[] {
  return normalizePassivoFundName(name)
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

export function passivoNameSimilarity(a: string, b: string): number {
  if (!passivoSubclasseDiscriminatorsCompatible(a, b)) return 0;

  const tokA = tokenizePassivoName(a);
  const tokB = tokenizePassivoName(b);
  if (tokA.length === 0 || tokB.length === 0) return 0;

  let overlap = 0;
  for (const t of tokA) {
    if (tokB.includes(t)) {
      overlap++;
      continue;
    }
    for (const tb of tokB) {
      if (tb.startsWith(t) || t.startsWith(tb)) {
        overlap += 0.7;
        break;
      }
      // ALVORA ↔ ALVORADA e variantes truncadas
      const stem = Math.min(t.length, tb.length, 5);
      if (stem >= 5 && t.slice(0, stem) === tb.slice(0, stem)) {
        overlap += 0.75;
        break;
      }
    }
  }
  return overlap / Math.max(tokA.length, tokB.length);
}

function scorePassivoNameMatch(passivoName: string, targetName: string): number {
  const pf = normalizePassivoFundName(passivoName);
  const clean = normalizePassivoFundName(targetName);
  if (!pf || !clean) return 0;
  if (pf === clean) return 3;
  if (!passivoSubclasseDiscriminatorsCompatible(pf, clean)) return 0;
  if (pf.length >= 4 && clean.length >= 4 && (pf.includes(clean) || clean.includes(pf))) {
    const shorter = pf.length <= clean.length ? pf : clean;
    const longer = pf.length <= clean.length ? clean : pf;
    if (extractSubclasseDiscriminators(longer).size > 0 && !extractSubclasseDiscriminators(shorter).size) {
      return 0;
    }
    return 2;
  }
  const sim = passivoNameSimilarity(pf, clean);
  return sim >= 0.75 ? sim : 0;
}

function filterRowsByFundName<T extends PassivoFundoRow>(rows: T[], fundName: string): T[] {
  const matching = rows
    .map((r) => ({ row: r, score: scorePassivoNameMatch(String(r.fundo ?? ""), fundName) }))
    .filter((m) => m.score > 0);
  if (matching.length === 0) return [];

  const bestScore = Math.max(...matching.map((m) => m.score));
  const threshold = bestScore >= 2 ? bestScore : bestScore * 0.9;
  const bestRows = matching.filter((m) => m.score >= threshold);
  const bestFundos = [...new Set(bestRows.map((m) => String(m.row.fundo ?? "").trim()))];
  const chosenFundo =
    bestFundos.length === 1
      ? bestFundos[0]
      : bestFundos.sort(
          (a, b) => normalizePassivoFundName(b).length - normalizePassivoFundName(a).length,
        )[0] ?? null;

  if (!chosenFundo) return [];
  return bestRows.filter((m) => String(m.row.fundo ?? "").trim() === chosenFundo).map((m) => m.row);
}

function distinctIsinsOnRows(rows: PassivoFundoRow[]): string[] {
  return [
    ...new Set(
      rows
        .map((r) => normalizeIsinLiquidez(r.fundo_isin))
        .filter((isin): isin is string => !!isin),
    ),
  ];
}

/**
 * Filtra linhas de passivo para a subclasse analisada (CNPJ + ISIN, com fallback por nome).
 */
export function filterPassivoRowsForSubclasse<T extends PassivoFundoRow>(
  rows: T[],
  opts: { cnpj?: string | null; isin?: string | null; fundName?: string | null },
): T[] {
  if (rows.length === 0) return [];

  const cnpjClean = opts.cnpj ? normalizeCnpj14(opts.cnpj) : "";
  const isinNorm = normalizeIsinLiquidez(opts.isin);
  const fundName = String(opts.fundName ?? "").trim();

  if (cnpjClean && isinNorm) {
    const byPair = rows.filter(
      (r) =>
        normalizeCnpj14(r.fundo_cnpj) === cnpjClean &&
        normalizeIsinLiquidez(r.fundo_isin) === isinNorm,
    );
    if (byPair.length > 0) return byPair;
  }

  if (cnpjClean) {
    const byCnpj = rows.filter((r) => normalizeCnpj14(r.fundo_cnpj) === cnpjClean);
    if (byCnpj.length > 0) {
      const isins = distinctIsinsOnRows(byCnpj);
      if (isinNorm) {
        const byIsinOnly = byCnpj.filter((r) => normalizeIsinLiquidez(r.fundo_isin) === isinNorm);
        if (byIsinOnly.length > 0) return byIsinOnly;
      }
      if (isins.length <= 1 && !isinNorm) return byCnpj;
      if (fundName) {
        const byName = filterRowsByFundName(byCnpj, fundName);
        if (byName.length > 0) return byName;
      }
      if (isins.length <= 1) return byCnpj;
      // Múltiplas subclasses no mesmo CNPJ — não agregar tudo
      return [];
    }
  }

  if (fundName) {
    return filterRowsByFundName(rows, fundName);
  }

  return [];
}

/** Nome normalizado + sem acento — identidade principal na visualização do passivo */
export function getPassivoNomeFold(row: PassivoFundoRow): string {
  const nome = normalizePassivoFundName(String(row.fundo ?? ""));
  return nome
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve chave de visualização com contexto do lote:
 * - Mesmo nome + um único CNPJ → uma linha (corrige duplicata com/sem CNPJ no BTG)
 * - Mesmo nome + vários CNPJs → separa por CNPJ (ex.: CP/LP com nome igual no arquivo)
 * - JR/SR → nomes distintos, sempre separados
 */
export function buildPassivoViewKeyResolver(
  rows: PassivoFundoRow[],
): (row: PassivoFundoRow) => string {
  const cnpjsByNome = new Map<string, Set<string>>();
  for (const r of rows) {
    const nomeFold = getPassivoNomeFold(r);
    if (!nomeFold) continue;
    const cnpj = normalizeCnpj14(r.fundo_cnpj);
    if (!cnpjsByNome.has(nomeFold)) cnpjsByNome.set(nomeFold, new Set());
    if (cnpj) cnpjsByNome.get(nomeFold)!.add(cnpj);
  }

  return (row: PassivoFundoRow) => {
    const nomeFold = getPassivoNomeFold(row);
    const cnpj = normalizeCnpj14(row.fundo_cnpj);
    const isin = normalizeIsinLiquidez(row.fundo_isin);

    if (nomeFold) {
      const cnpjs = cnpjsByNome.get(nomeFold);
      if (cnpjs && cnpjs.size > 1 && cnpj && !PASSIVO_ALIAS_FORCE_SINGLE_IDENTITY.has(nomeFold)) {
        return `${cnpj}|${nomeFold}`;
      }
      return nomeFold;
    }
    if (cnpj && isin) return `${cnpj}|${isin}`;
    if (cnpj) return cnpj;
    return String(row.fundo ?? "").trim() || "unknown";
  };
}

/** Chave de identidade do fundo: CNPJ+ISIN ou CNPJ+nome (subclasses JR/SR), nunca CNPJ sozinho. */
export function passivoFundDedupeKey(row: PassivoFundoRow): string {
  const cnpj = normalizeCnpj14(row.fundo_cnpj);
  const isin = normalizeIsinLiquidez(row.fundo_isin);
  const nomeFold = getPassivoNomeFold(row);

  if (cnpj && nomeFold) return `${cnpj}|${nomeFold}`;
  if (cnpj && isin) return `${cnpj}|${isin}`;
  if (nomeFold) return nomeFold;
  if (cnpj) return cnpj;
  return String(row.fundo ?? "").trim() || "unknown";
}

/** Chave simples (sem contexto do lote) — prefira buildPassivoViewKeyResolver na UI. */
export function passivoFundViewKey(row: PassivoFundoRow): string {
  return passivoFundDedupeKey(row);
}

/** Prioridade da fonte de passivo (menor = preferida). Posição Cotas é a referência operacional. */
export function passivoAdminSourcePriority(admin: string): number {
  const key = String(admin ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (key.includes("posicao") && key.includes("cotas")) return 0;
  if (key === "btg") return 1;
  if (key === "itau") return 2;
  if (key === "finvest.api" || key.includes("finvest") && key.includes("api")) return 3;
  if (key === "finvest") return 4;
  if (key.includes("finvest") && key.includes("growth")) return 5;
  return 50;
}

/** FINVEST manual e FINVEST.API representam a mesma família de fonte; vence a posição mais recente. */
function passivoAdminSourceGroup(admin: string): string {
  const key = String(admin ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (key === "finvest" || key === "finvest.api" || key.includes("finvest") && key.includes("api")) {
    return "finvest";
  }
  return key;
}

/** Agrega linhas de passivo por codigo_clt (quando houver) ou nome do cotista. */
export function aggregatePassivoCotistas(rows: PassivoFundoRow[]): PassivoCotistaAgg[] {
  const byKey = new Map<string, PassivoCotistaAgg>();
  for (const r of rows) {
    const cotista = String(r.cotista ?? "").trim();
    if (!cotista) continue;
    const key = r.codigo_clt != null ? `clt:${r.codigo_clt}` : `nome:${cotista}`;
    const val = Number(r.valor) || 0;
    const existing = byKey.get(key);
    if (existing) {
      existing.valor += val;
      if (existing.codigo_clt == null && r.codigo_clt != null) {
        existing.codigo_clt = r.codigo_clt;
      }
    } else {
      byKey.set(key, { cotista, valor: val, codigo_clt: r.codigo_clt ?? null });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.valor - a.valor);
}

/**
 * Escolhe linhas de passivo cujo rótulo `fundo` melhor corresponde ao nome alvo
 * (match estrito ou fuzzy quando nomes divergem entre XML e planilha).
 */
export function pickPassivoRowsForTargetName<T extends PassivoFundoRow>(
  rows: T[],
  targetName: string,
  minScore = 0.55,
): T[] {
  if (!targetName.trim() || rows.length === 0) return [];

  const strict = filterRowsByFundName(rows, targetName);
  if (strict.length > 0) return strict;

  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const label = String(r.fundo ?? "").trim();
    if (!label) continue;
    const list = groups.get(label) ?? [];
    list.push(r);
    groups.set(label, list);
  }

  let bestLabel = "";
  let bestScore = 0;
  for (const label of groups.keys()) {
    const score = scorePassivoNameMatch(label, targetName);
    if (score > bestScore) {
      bestScore = score;
      bestLabel = label;
    }
  }

  if (bestLabel && bestScore >= minScore) return groups.get(bestLabel)!;
  return [];
}

/** Resolve passivo para o mapa — tenta vários nomes candidatos + fuzzy. */
export function resolvePassivoRowsForMapa(
  rows: PassivoFundoRow[],
  opts: {
    cnpj?: string | null;
    isin?: string | null;
    fundName?: string | null;
    fundNameCandidates?: string[];
    asOfDate?: string | null;
  },
): PassivoFundoRow[] {
  const names = [...new Set(
    [opts.fundName, ...(opts.fundNameCandidates ?? [])]
      .map((n) => String(n ?? "").trim())
      .filter(Boolean),
  )];

  for (const name of names) {
    const out = resolvePassivoRowsForFundDetail(rows, {
      cnpj: opts.cnpj,
      isin: opts.isin,
      fundName: name,
      asOfDate: opts.asOfDate,
    });
    if (out.length > 0) return out;
  }

  for (const name of names) {
    const picked = pickPassivoRowsForTargetName(rows, name);
    if (picked.length > 0) {
      const label = String(picked[0].fundo ?? name).trim();
      return resolvePassivoRowsForFundDetail(picked, {
        cnpj: picked[0].fundo_cnpj ?? opts.cnpj,
        fundName: label || name,
        isin: opts.isin ?? picked[0].fundo_isin,
        asOfDate: opts.asOfDate,
      });
    }
  }

  return [];
}

/** Filtra subclasse + dedupe — mesma regra da aba Passivo Fundos ("Mais recente por fundo"). */
export function resolvePassivoRowsForFundDetail(
  rows: PassivoFundoRow[],
  opts: { cnpj?: string | null; isin?: string | null; fundName?: string | null; asOfDate?: string | null },
): PassivoFundoRow[] {
  const filtered = filterPassivoRowsForSubclasse(rows, opts);
  if (filtered.length === 0) return [];
  return dedupePassivoForView(filtered, opts.asOfDate ? { asOfDate: opts.asOfDate } : undefined);
}

/**
 * Uma linha por fundo (CNPJ + nome, sem administradora):
 * 1) escolhe a fonte preferida (Posição Cotas > BTG > ITAU > Finvest)
 * 2) FINVEST manual e FINVEST.API formam uma única fonte e usam a data mais recente
 *
 * Importante: Finvest via API nunca substitui BTG/ITAU/Posição Cotas na tela.
 */
export function dedupePassivoForView(
  rows: PassivoFundoRow[],
  opts?: { asOfDate?: string | null },
): PassivoFundoRow[] {
  if (rows.length === 0) return [];

  const asOf = String(opts?.asOfDate ?? "")
    .replace(/\D/g, "")
    .slice(0, 8);
  const working =
    asOf.length === 8
      ? rows.filter((r) => {
          const d = String(r.data_posicao ?? "").replace(/\D/g, "").slice(0, 8);
          return d && d <= asOf;
        })
      : rows;
  if (working.length === 0) return [];

  const viewKeyOf = buildPassivoViewKeyResolver(working);
  const keys = [...new Set(working.map((r) => viewKeyOf(r)))];
  const result: PassivoFundoRow[] = [];

  for (const key of keys) {
    const keyRows = working.filter((r) => viewKeyOf(r) === key);
    const byAdmin = new Map<string, PassivoFundoRow[]>();
    for (const r of keyRows) {
      const admin = passivoAdminSourceGroup(String(r.administradora ?? ""));
      if (!byAdmin.has(admin)) byAdmin.set(admin, []);
      byAdmin.get(admin)!.push(r);
    }

    const rankedAdmins = [...byAdmin.entries()]
      .map(([admin, adminRows]) => {
        const latestDate = adminRows.reduce((max, r) => {
          const d = String(r.data_posicao ?? "").replace(/\D/g, "").slice(0, 8);
          return d > max ? d : max;
        }, "");
        const atLatest = adminRows.filter(
          (r) => String(r.data_posicao ?? "").replace(/\D/g, "").slice(0, 8) === latestDate,
        );
        return { admin, atLatest, rank: passivoAdminSourcePriority(admin) };
      })
      .sort((a, b) => a.rank - b.rank);

    if (rankedAdmins.length > 0) {
      result.push(...rankedAdmins[0].atLatest);
    }
  }

  return collapseSameNameAdminSnapshots(collapseSameNomePreferredSource(result));
}

/**
 * Mesmo nome normalizado em fontes distintas → mantém só a administradora preferida
 * (Posição Cotas > BTG > ITAU > FINVEST > FINVEST.API). Evita duplicata Finvest antiga
 * quando já existe passivo mais confiável para o fundo.
 */
export function collapseSameNomePreferredSource(rows: PassivoFundoRow[]): PassivoFundoRow[] {
  if (rows.length === 0) return [];

  const bestRankByNome = new Map<string, number>();
  for (const r of rows) {
    const nomeFold = getPassivoNomeFold(r);
    if (!nomeFold) continue;
    const rank = passivoAdminSourcePriority(String(r.administradora ?? ''));
    const cur = bestRankByNome.get(nomeFold);
    if (cur === undefined || rank < cur) bestRankByNome.set(nomeFold, rank);
  }

  return rows.filter((r) => {
    const nomeFold = getPassivoNomeFold(r);
    if (!nomeFold) return true;
    const best = bestRankByNome.get(nomeFold);
    if (best === undefined) return true;
    return passivoAdminSourcePriority(String(r.administradora ?? '')) === best;
  });
}

/**
 * Mesmo fundo + mesma administradora com CNPJs divergentes (import antigo errado) →
 * mantém só o snapshot mais recente; empate prefere linha com CNPJ preenchido.
 * Não une CP/LP legítimos: nomes normalizados distintos permanecem separados.
 */
export function collapseSameNameAdminSnapshots(rows: PassivoFundoRow[]): PassivoFundoRow[] {
  if (rows.length === 0) return [];

  type BestSnap = { date: string; cnpj: string | null };
  const bestByGroup = new Map<string, BestSnap>();

  for (const r of rows) {
    const nomeFold = getPassivoNomeFold(r);
    const admin = String(r.administradora ?? "").trim();
    if (!nomeFold || !admin) continue;
    const gk = `${nomeFold}\0${admin}`;
    const date = String(r.data_posicao ?? "").replace(/\D/g, "").slice(0, 8);
    const cnpj = normalizeCnpj14(r.fundo_cnpj);
    const cur = bestByGroup.get(gk);
    if (!cur) {
      bestByGroup.set(gk, { date, cnpj });
      continue;
    }
    const curHasCnpj = !!cur.cnpj;
    const newHasCnpj = !!cnpj;
    if (date > cur.date || (date === cur.date && newHasCnpj && !curHasCnpj)) {
      bestByGroup.set(gk, { date, cnpj: newHasCnpj ? cnpj : cur.cnpj });
    }
  }

  return rows.filter((r) => {
    const nomeFold = getPassivoNomeFold(r);
    const admin = String(r.administradora ?? "").trim();
    const best = bestByGroup.get(`${nomeFold}\0${admin}`);
    if (!best) return true;
    const date = String(r.data_posicao ?? "").replace(/\D/g, "").slice(0, 8);
    if (date !== best.date) return false;
    const cnpj = normalizeCnpj14(r.fundo_cnpj);
    if (best.cnpj && cnpj && cnpj !== best.cnpj) return false;
    if (best.cnpj && !cnpj) return false;
    return true;
  });
}
