/**
 * Funções puras de cálculo de rentabilidade (fundos e ativos).
 * Sem side effects — apenas números primitivos ou arrays tipados.
 */

import { resolveNomeFromLookupMap } from "@/lib/mapaAtivosNome";

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface SnapshotFundo {
  fundo_cnpj: string;
  fundo_isin: string | null;
  data_posicao: string; // YYYY-MM-DD
  valor_cota: number;
  pl: number;
  valor_ativos: number | null;
  quantidade: number | null;
  nome_fundo: string | null;
  administrador: string | null;
}

export interface PosicaoAtivo {
  fundo_cnpj: string;
  data_posicao: string;
  /** Chave estável para agregação e histórico de PU (varia por section). */
  ativo_key: string;
  section: string;
  cnpj_ativo: string | null;
  isin_ativo: string | null;
  nome_ativo?: string | null;
  nome_exibicao: string;
  qt_disponivel: number | null;
  pu_posicao: number | null;
}

/** Sections com PU/valor para drill-down de rentabilidade de ativos. */
export const SECTIONS_ATIVOS_RENTABILIDADE = [
  "cotas",
  "titpublico",
  "titprivado",
  "acoes",
  "participacoes",
  "imoveis",
] as const;

export interface PosicaoCarteiraRow {
  fundo_cnpj: string;
  fundo_isin?: string | null;
  fundo_dtposicao: string;
  fundo_valorcota: number | null;
  fundo_patliq: number | null;
  fundo_valorativos: number | null;
  fundo_quantidade: number | null;
  nome_fundo?: string | null;
  fundo_nome?: string | null;
  fundo_nomeadm?: string | null;
  fundo_cnpjadm?: string | null;
  fundo_nomegestor?: string | null;
  fundo_cnpjgestor?: string | null;
  section?: string;
  cnpjfundo?: string | null;
  cnpjemissor?: string | null;
  cnpjpart?: string | null;
  cnpjemp?: string | null;
  qtdisponivel?: number | null;
  puposicao?: number | null;
  isin?: string | null;
  codativo?: string | null;
  nomecomercial?: string | null;
  matricula?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  valor_padrao?: number | null;
  valorcontabil?: number | null;
  dtemissao?: string | null;
  dtvencimento?: string | null;
  ativos?: {
    cnpj?: string | null;
    isin?: string | null;
    tipo_ativo?: string | null;
    nome_frontend?: string | null;
    descricao?: string | null;
  } | null;
}

/** ISIN mascarado no XML ANBIMA (ex.: BR**********) — não identifica classe. */
export function isIsinMascarado(isin: string | null | undefined): boolean {
  const s = isin?.trim();
  if (!s) return true;
  return s.includes("*");
}

/** ISIN utilizável para chave de agregação / match (alinha com import-xml). */
export function isinUtilizavel(isin: string | null | undefined): string | null {
  const s = isin?.trim().toUpperCase();
  if (!s || isIsinMascarado(s)) return null;
  return s;
}

export function cnpjFromCotasAtivoKey(ativoKey: string): string | null {
  const m = /^cotas:cnpj:(\d+)/i.exec(ativoKey);
  return m?.[1] ?? null;
}

/** Mesma posição na data (qtd e PU) — tolerância para arredondamento XML. */
export function posicoesAtivoEquivalentes(
  a: Pick<PosicaoAtivo, "qt_disponivel" | "pu_posicao">,
  b: Pick<PosicaoAtivo, "qt_disponivel" | "pu_posicao">,
): boolean {
  const qtA = a.qt_disponivel ?? 0;
  const qtB = b.qt_disponivel ?? 0;
  const puA = a.pu_posicao ?? 0;
  const puB = b.pu_posicao ?? 0;
  if (Math.abs(qtA - qtB) > 1e-4) return false;
  if (qtA === 0 && qtB === 0) return true;
  return Math.abs(puA - puB) <= Math.max(1e-8, Math.abs(puA) * 1e-9);
}

function fundirPosicoesAtivo(grupo: PosicaoAtivo[]): PosicaoAtivo {
  let qtAcum = 0;
  let puPond = 0;
  let preferido = grupo[0];
  for (const a of grupo) {
    const qt = a.qt_disponivel ?? 0;
    const pu = a.pu_posicao ?? 0;
    qtAcum += qt;
    puPond += pu * qt;
    if (isinUtilizavel(a.isin_ativo) && !isinUtilizavel(preferido.isin_ativo)) {
      preferido = a;
    }
  }
  return {
    ...preferido,
    qt_disponivel: qtAcum,
    pu_posicao: qtAcum > 0 ? puPond / qtAcum : preferido.pu_posicao,
    ativo_key: isinUtilizavel(preferido.isin_ativo)
      ? `cotas:cnpj:${preferido.cnpj_ativo?.replace(/\D/g, "")}:isin:${isinUtilizavel(preferido.isin_ativo)}`
      : `cotas:cnpj:${preferido.cnpj_ativo?.replace(/\D/g, "")}`,
  };
}

/**
 * Remove duplicata de cotas com mesmo CNPJ na mesma data (reimport XML com ISIN
 * preenchido vs mascarado). Mantém ISIN real; descarta mascarado se qtd/PU iguais.
 */
export function deduplicarCotasPorCnpj(ativos: PosicaoAtivo[]): PosicaoAtivo[] {
  const outros: PosicaoAtivo[] = [];
  const porCnpj = new Map<string, PosicaoAtivo[]>();

  for (const a of ativos) {
    if (a.section !== "cotas") {
      outros.push(a);
      continue;
    }
    const cnpj = a.cnpj_ativo?.replace(/\D/g, "");
    if (!cnpj) {
      outros.push(a);
      continue;
    }
    const list = porCnpj.get(cnpj) ?? [];
    list.push(a);
    porCnpj.set(cnpj, list);
  }

  const cotasOut: PosicaoAtivo[] = [];
  for (const grupo of porCnpj.values()) {
    if (grupo.length === 1) {
      cotasOut.push(grupo[0]);
      continue;
    }

    const comIsinReal = grupo.filter((a) => isinUtilizavel(a.isin_ativo));
    if (comIsinReal.length === 0) {
      cotasOut.push(fundirPosicoesAtivo(grupo));
      continue;
    }

    const mantidos: PosicaoAtivo[] = [];
    for (const real of comIsinReal) {
      const jaTem = mantidos.some(
        (m) =>
          isinUtilizavel(m.isin_ativo) === isinUtilizavel(real.isin_ativo) &&
          posicoesAtivoEquivalentes(m, real),
      );
      if (!jaTem) mantidos.push(real);
    }

    for (const legado of grupo) {
      if (isinUtilizavel(legado.isin_ativo)) continue;
      const dup = mantidos.some((m) => posicoesAtivoEquivalentes(m, legado));
      if (!dup) mantidos.push(legado);
    }

    cotasOut.push(...mantidos);
  }

  return [...outros, ...cotasOut];
}

/**
 * Histórico PU: deduplica reimports preservando classes distintas.
 *
 * - Entradas com ISIN real: chave = (cnpj, isin, data) → cada classe mantém
 *   sua própria série histórica sem colapsar com a outra (ex.: SR vs JR).
 * - Entradas sem ISIN ou com ISIN mascarado: chave = (cnpj, data) →
 *   deduplica reimports do mesmo fundo, promove ao ISIN real quando aparece.
 */
export function consolidarHistoricoPuCotas<
  T extends {
    ativo_key: string;
    data_posicao: string;
    pu_posicao: number;
    qt: number;
  },
>(rows: T[]): T[] {
  const outros: T[] = [];
  const map = new Map<string, T>();

  const scoreKey = (r: T) => {
    const isinPart = /:isin:([^:]+)$/i.exec(r.ativo_key)?.[1];
    if (!isinPart) return 0;
    return isIsinMascarado(isinPart) ? 1 : 2;
  };

  for (const r of rows) {
    if (!r.ativo_key.startsWith("cotas:")) {
      outros.push(r);
      continue;
    }
    const cnpj = cnpjFromCotasAtivoKey(r.ativo_key);
    if (!cnpj) {
      outros.push(r);
      continue;
    }

    const isinMatch = /:isin:([^:]+)$/i.exec(r.ativo_key);
    const isinPart = isinMatch?.[1] ?? null;
    const temIsinReal = isinPart != null && !isIsinMascarado(isinPart);

    // Quando tem ISIN real, inclui o ISIN na chave para preservar cada classe
    // (ex.: SR e JR com mesmo CNPJ mas ISINs distintos não se sobrepõem).
    // Quando não tem ISIN ou é mascarado, usa apenas cnpj|data para deduplicar
    // reimports e promover ao ISIN real quando ele aparecer.
    const k = temIsinReal
      ? `${cnpj}|${isinPart}|${r.data_posicao}`
      : `${cnpj}||${r.data_posicao}`;

    const existente = map.get(k);
    if (!existente || scoreKey(r) > scoreKey(existente)) {
      map.set(k, r);
    }
  }

  return [...outros, ...map.values()];
}

/** Identificador único do ativo dentro do fundo (independe de CNPJ). */
export function getAtivoKeyFromRow(row: PosicaoCarteiraRow): string {
  const section = (row.section || "cotas").toLowerCase();
  switch (section) {
    case "cotas": {
      const cnpj = row.cnpjfundo?.replace(/\D/g, "");
      const isin = isinUtilizavel(row.isin);
      /**
       * Classes de um mesmo fundo podem compartilhar CNPJ e diferir apenas por ISIN.
       * Quando ambos existem, a chave precisa combinar CNPJ+ISIN para evitar colisão.
       * ISIN mascarado (BR**********) não entra na chave — alinha com import-xml.
       */
      if (cnpj && isin) return `cotas:cnpj:${cnpj}:isin:${isin}`;
      if (cnpj) return `cotas:cnpj:${cnpj}`;
      const isinBruto = row.isin?.trim().toUpperCase();
      if (isinBruto) return `cotas:isin:${isinBruto}`;
      return `cotas:unk:${row.codativo?.trim() || "?"}`;
    }
    case "acoes":
      return `acoes:${row.codativo?.trim() || ""}:${row.isin?.trim() || ""}`;
    case "titpublico":
    case "titprivado":
    case "termorf":
      return [
        section,
        row.isin?.trim() || "",
        row.codativo?.trim() || "",
        row.cnpjemissor?.replace(/\D/g, "") || "",
        row.dtemissao || "",
        row.dtvencimento || "",
      ].join("|");
    case "participacoes": {
      const cnpj =
        row.cnpjpart?.replace(/\D/g, "") ||
        row.cnpjemissor?.replace(/\D/g, "") ||
        "";
      return `participacoes:${cnpj}:${row.nomecomercial?.trim() || ""}`;
    }
    case "imoveis": {
      const mat = row.matricula?.trim() || "";
      const addr = [row.logradouro, row.numero].filter(Boolean).join(",");
      return `imoveis:${mat}:${addr}:${row.nomecomercial?.trim() || ""}`;
    }
    default:
      return `${section}:${row.isin?.trim() || row.codativo?.trim() || row.cnpjfundo || "?"}`;
  }
}

/**
 * Chaves alternativas para buscar histórico de PU do mesmo ativo.
 * XMLs antigos geravam `cotas:cnpj:X`; com ISIN no cadastro passa a `cotas:cnpj:X:isin:Y`.
 */
export function expandAtivoKeyAliases(
  ativoKey: string,
  isinAtivo?: string | null,
): string[] {
  const keys = new Set<string>([ativoKey]);

  const cnpjIsin = /^cotas:cnpj:(\d+):isin:([A-Z0-9*]+)$/i.exec(ativoKey);
  if (cnpjIsin) {
    keys.add(`cotas:cnpj:${cnpjIsin[1]}`);
    if (!isIsinMascarado(cnpjIsin[2])) {
      keys.add(`cotas:isin:${cnpjIsin[2]}`);
    }
  }

  const cnpjOnly = /^cotas:cnpj:(\d+)$/i.exec(ativoKey);
  if (cnpjOnly) {
    const isin = isinAtivo?.trim().toUpperCase();
    if (isin) keys.add(`cotas:cnpj:${cnpjOnly[1]}:isin:${isin}`);
  }

  const isinOnly = /^cotas:isin:([A-Z0-9]+)$/i.exec(ativoKey);
  if (isinOnly) {
    keys.add(`cotas:isin:${isinOnly[1]}`);
  }

  return [...keys];
}

/** Resolve quantidade, PU e valor de mercado conforme a section. */
export function resolvePuQtFromRow(row: PosicaoCarteiraRow): {
  qt: number | null;
  pu: number | null;
  vlMercado: number | null;
} {
  const qt = row.qtdisponivel ?? null;
  const pu = row.puposicao ?? null;

  if (pu != null && qt != null && qt > 0) {
    return { qt, pu, vlMercado: qt * pu };
  }
  if (pu != null) {
    const q = qt ?? 1;
    return { qt: q, pu, vlMercado: q * pu };
  }

  const section = (row.section || "").toLowerCase();
  const vl = row.valor_padrao ?? row.valorcontabil ?? null;

  if (section === "imoveis" && vl != null && vl > 0) {
    return { qt: 1, pu: vl, vlMercado: vl };
  }
  if (vl != null && qt != null && qt > 0) {
    return { qt, pu: vl / qt, vlMercado: vl };
  }
  if (vl != null) {
    return { qt: 1, pu: vl, vlMercado: vl };
  }

  return { qt, pu, vlMercado: null };
}

// ─── Conversão de datas ──────────────────────────────────────────────────────

export function yyyymmddToIso(dt: string): string {
  if (!dt || dt.length !== 8) return dt;
  return `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
}

export function isoToYyyymmdd(iso: string): string {
  return iso.replace(/-/g, "");
}

/** Fundos sem XML há mais de N dias (corridos) antes da data de referência ficam fora do universo. */
export const DIAS_INATIVO_RENTABILIDADE_XML = 10;

/** Dias corridos entre a última posição importada e a data de referência. */
export function diasDesdeUltimaPosicaoXml(
  dataRefIso: string,
  ultimaDataIso: string,
): number {
  const ref = new Date(`${dataRefIso}T12:00:00`);
  const ult = new Date(`${ultimaDataIso}T12:00:00`);
  return Math.round((ref.getTime() - ult.getTime()) / 86_400_000);
}

export function isFundoAtivoRentabilidadeXml(
  dataRefIso: string,
  ultimaDataIso: string,
): boolean {
  return (
    diasDesdeUltimaPosicaoXml(dataRefIso, ultimaDataIso) <=
    DIAS_INATIVO_RENTABILIDADE_XML
  );
}

// ─── Mapeamento posicao_carteira → tipos de domínio ─────────────────────────

export function mapPosicaoToSnapshot(row: PosicaoCarteiraRow): SnapshotFundo | null {
  if (
    row.fundo_cnpj == null ||
    row.fundo_dtposicao == null ||
    row.fundo_valorcota == null ||
    row.fundo_valorcota <= 0
  ) {
    return null;
  }
  return {
    fundo_cnpj: row.fundo_cnpj,
    fundo_isin: row.fundo_isin?.trim().toUpperCase() || null,
    data_posicao: yyyymmddToIso(row.fundo_dtposicao),
    valor_cota: row.fundo_valorcota,
    pl: row.fundo_patliq ?? row.fundo_valorativos ?? 0,
    valor_ativos: row.fundo_valorativos,
    quantidade: row.fundo_quantidade,
    nome_fundo: row.nome_fundo ?? row.fundo_nome ?? null,
    administrador: row.fundo_nomeadm?.trim() || null,
  };
}

function normalizeNomeFundo(nome: string | null | undefined): string {
  return (nome ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

type FundoIsinAliasMap = Map<string, string>;

/** Detecta JR/SR ou subclasses distintas no mesmo dia (não é migração de ISIN). */
function hasSameDateIsinOverlap(
  snapshots: SnapshotFundo[],
  cnpj: string,
  nomeNorm: string,
  isinCandidates: Set<string>,
): boolean {
  const byDate = new Map<string, Set<string>>();
  for (const s of snapshots) {
    if (s.fundo_cnpj !== cnpj) continue;
    if (normalizeNomeFundo(s.nome_fundo) !== nomeNorm) continue;
    const isin = s.fundo_isin?.trim().toUpperCase();
    if (!isin || !isinCandidates.has(isin)) continue;
    const set = byDate.get(s.data_posicao) ?? new Set<string>();
    set.add(isin);
    byDate.set(s.data_posicao, set);
  }
  for (const set of byDate.values()) {
    if (set.size > 1) return true;
  }
  return false;
}

/** ISIN canônico = o da posição mais recente (troca de ISIN entre importações). */
function pickLatestIsinForNome(
  snapshots: SnapshotFundo[],
  cnpj: string,
  nomeNorm: string,
  isinCandidates: Set<string>,
): string | null {
  const relevant = snapshots.filter(
    (s) =>
      s.fundo_cnpj === cnpj &&
      normalizeNomeFundo(s.nome_fundo) === nomeNorm &&
      s.fundo_isin &&
      isinCandidates.has(s.fundo_isin.trim().toUpperCase()),
  );
  if (relevant.length === 0) return null;
  relevant.sort((a, b) => a.data_posicao.localeCompare(b.data_posicao));
  return relevant[relevant.length - 1].fundo_isin!.trim().toUpperCase();
}

export function buildFundoIsinAliasMap(
  snapshots: SnapshotFundo[],
): FundoIsinAliasMap {
  const byNome = new Map<string, Set<string>>();
  const byCnpj = new Map<string, Set<string>>();

  for (const s of snapshots) {
    const isin = s.fundo_isin?.trim().toUpperCase();
    if (!isin) continue;

    // Rastreia ISINs únicos por CNPJ (para fundos de classe única).
    const cnpjSet = byCnpj.get(s.fundo_cnpj) ?? new Set<string>();
    cnpjSet.add(isin);
    byCnpj.set(s.fundo_cnpj, cnpjSet);

    const nomeNorm = normalizeNomeFundo(s.nome_fundo);
    if (!nomeNorm) continue;
    const key = `${s.fundo_cnpj}|NOME:${nomeNorm}`;
    const set = byNome.get(key) ?? new Set<string>();
    set.add(isin);
    byNome.set(key, set);
  }

  const aliases = new Map<string, string>();

  for (const [key, set] of byNome) {
    if (set.size === 1) {
      aliases.set(key, [...set][0]);
      continue;
    }
    const pipeIdx = key.indexOf("|NOME:");
    const cnpj = key.slice(0, pipeIdx);
    const nomeNorm = key.slice(pipeIdx + 6);
    // Vários ISINs no mesmo dia = subclasses distintas — não unificar.
    if (hasSameDateIsinOverlap(snapshots, cnpj, nomeNorm, set)) continue;
    const canonical = pickLatestIsinForNome(snapshots, cnpj, nomeNorm, set);
    if (canonical) aliases.set(key, canonical);
  }

  // Alias por CNPJ: cobre variações de nome em fundos de classe única.
  // Só cria quando o CNPJ tem exatamente 1 ISIN — CNPJs com 2 ISINs (JR/SR)
  // ficam de fora, evitando mistura de classes.
  for (const [cnpj, isinSet] of byCnpj) {
    if (isinSet.size === 1) {
      aliases.set(`${cnpj}|CNPJ_UNICO`, [...isinSet][0]);
    }
  }

  return aliases;
}

/** Chave estável de classe/fundo: CNPJ + ISIN (fallback para CNPJ puro). */
export function getFundoGroupKey(
  fundoCnpj: string,
  fundoIsin: string | null | undefined,
  nomeFundo: string | null | undefined,
  isinAliases?: Map<string, string>,
): string {
  const isin = fundoIsin?.trim().toUpperCase();
  const nomeNorm = normalizeNomeFundo(nomeFundo);
  const nomeKey = `${fundoCnpj}|NOME:${nomeNorm || "SEM_NOME"}`;

  // 1. Alias por nome (histórico sem ISIN ou migração de ISIN).
  const aliasIsinNome = isinAliases?.get(nomeKey);
  if (aliasIsinNome) return `${fundoCnpj}|ISIN:${aliasIsinNome}`;

  if (isin) return `${fundoCnpj}|ISIN:${isin}`;

  // 2. Alias por CNPJ único: cobre variações de nome em fundos de classe única.
  //    CNPJs com 2+ ISINs (ex.: JR/SR) não têm essa chave → sem risco de mistura.
  const aliasIsinCnpj = isinAliases?.get(`${fundoCnpj}|CNPJ_UNICO`);
  if (aliasIsinCnpj) return `${fundoCnpj}|ISIN:${aliasIsinCnpj}`;

  // 3. Fallback: agrupa por CNPJ puro (sem nome) para evitar duplicatas quando
  //    o fundo muda de nome/administrador ao longo do ano. Isso garante que fundos
  //    com mesmo CNPJ sejam sempre agrupados, independente de variações de nome.
  return fundoCnpj;
}

function getSnapshotGroupKey(
  s: SnapshotFundo,
  isinAliases?: FundoIsinAliasMap,
): string {
  return getFundoGroupKey(s.fundo_cnpj, s.fundo_isin, s.nome_fundo, isinAliases);
}

/** Filtra snapshots da mesma classe (CNPJ+ISIN, com alias para histórico sem ISIN). */
export function filterSnapshotsForClasse(
  snapshots: SnapshotFundo[],
  fundoCnpj: string,
  fundoIsin: string | null | undefined,
  nomeFundo: string | null | undefined,
): SnapshotFundo[] {
  const aliases = buildFundoIsinAliasMap(snapshots);
  const targetKey = getFundoGroupKey(
    fundoCnpj,
    fundoIsin,
    nomeFundo,
    aliases,
  );
  return snapshots.filter(
    (s) =>
      getFundoGroupKey(s.fundo_cnpj, s.fundo_isin, s.nome_fundo, aliases) ===
      targetKey,
  );
}

/** Nome do join FK só é confiável quando o ISIN da posição bate com o do cadastro. */
export function ativoJoinNomeConfiavel(
  rowIsin: string | null,
  ativoJoin: PosicaoCarteiraRow["ativos"],
): string | null {
  if (!ativoJoin) return null;
  const nome = ativoJoin.nome_frontend?.trim() || ativoJoin.descricao?.trim() || null;
  if (!nome) return null;

  const joinIsin = isinUtilizavel(ativoJoin.isin);
  if (rowIsin && (!joinIsin || joinIsin !== rowIsin)) return null;

  return nome;
}

/** Resolve nome de exibição de uma linha de posicao_carteira (Composição da Carteira, rentabilidade, etc.). */
export function resolveNomeExibicaoFromPosicao(
  row: PosicaoCarteiraRow,
  nomesMap: Record<string, string> | Map<string, string> = {},
): string | null {
  const section = (row.section || "cotas").toLowerCase();
  const ativoJoin = row.ativos;

  const cnpjAtivo =
    section === "cotas"
      ? row.cnpjfundo ?? null
      : section === "participacoes"
        ? row.cnpjpart || row.cnpjemissor || null
        : row.cnpjemissor || row.cnpjemp || row.cnpjfundo || null;

  const isinKey = isinUtilizavel(row.isin);
  const joinNome = ativoJoinNomeConfiavel(isinKey, ativoJoin);

  let nomeExibicao: string | null = null;

  if (section === "imoveis") {
    nomeExibicao =
      joinNome ||
      row.nomecomercial?.trim() ||
      (row.logradouro
        ? `${row.logradouro}${row.numero ? `, ${row.numero}` : ""}`
        : null);
  } else if (section === "participacoes") {
    if (!ativoJoin?.tipo_ativo || ativoJoin.tipo_ativo === "PARTICIPACAO") {
      nomeExibicao = joinNome || row.nomecomercial?.trim() || null;
    }
  } else if (
    section === "titpublico" ||
    section === "titprivado" ||
    section === "termorf" ||
    section === "acoes"
  ) {
    nomeExibicao = joinNome || row.codativo?.trim() || row.isin?.trim() || null;
  }

  if (!nomeExibicao) {
    nomeExibicao = resolveNomeFromLookupMap(cnpjAtivo, row.isin, nomesMap) || joinNome;
  }

  return nomeExibicao;
}

export function mapPosicaoToAtivo(
  row: PosicaoCarteiraRow,
  nomesMap: Record<string, string> = {},
): PosicaoAtivo | null {
  if (row.fundo_cnpj == null || row.fundo_dtposicao == null) return null;

  const section = (row.section || "cotas").toLowerCase();
  const cnpjAtivo =
    section === "cotas"
      ? row.cnpjfundo ?? null
      : section === "participacoes"
        ? row.cnpjpart || row.cnpjemissor || null
        : row.cnpjemissor || row.cnpjemp || row.cnpjfundo || null;

  const isinKey = isinUtilizavel(row.isin);
  let nomeExibicao = resolveNomeExibicaoFromPosicao(row, nomesMap);
  if (!nomeExibicao) {
    nomeExibicao = cnpjAtivo ? fmtCnpj(cnpjAtivo) : row.isin ?? row.codativo ?? "—";
  }

  const { qt, pu } = resolvePuQtFromRow(row);
  if (pu == null) return null;

  return {
    fundo_cnpj: row.fundo_cnpj,
    data_posicao: yyyymmddToIso(row.fundo_dtposicao),
    ativo_key: getAtivoKeyFromRow(row),
    section,
    cnpj_ativo: cnpjAtivo,
    isin_ativo: isinKey,
    nome_ativo: row.isin ?? cnpjAtivo ?? row.codativo,
    nome_exibicao: nomeExibicao,
    qt_disponivel: qt,
    pu_posicao: pu,
  };
}

export function isFundoFidc(nome: string | null | undefined): boolean {
  if (!nome) return false;
  return nome.toUpperCase().includes("FIDC");
}

// ─── Helpers de snapshot ─────────────────────────────────────────────────────

export function encontrarSnapshotExato(
  snapshots: SnapshotFundo[],
  dataRef: string,
): SnapshotFundo | null {
  return snapshots.find((s) => s.data_posicao === dataRef) ?? null;
}

export function encontrarSnapshotMaisProximo(
  snapshots: SnapshotFundo[],
  alvo: Date,
  janelaMaxDias = 30,
): SnapshotFundo | null {
  const alvoMs = alvo.getTime();
  let melhor: SnapshotFundo | null = null;
  let menorDiff = Infinity;

  for (const s of snapshots) {
    const diff = Math.abs(new Date(s.data_posicao + "T12:00:00").getTime() - alvoMs);
    const diffDias = diff / (1000 * 60 * 60 * 24);
    if (diffDias <= janelaMaxDias && diffDias < menorDiff) {
      menorDiff = diffDias;
      melhor = s;
    }
  }
  return melhor;
}

/** Último snapshot disponível antes de dataRef (ignora calendário — cobre feriados). */
export function encontrarDiaUtilAnterior(
  snapshots: SnapshotFundo[],
  dataRef: string,
): SnapshotFundo | null {
  const sorted = [...snapshots]
    .filter((s) => s.data_posicao < dataRef)
    .sort((a, b) => b.data_posicao.localeCompare(a.data_posicao));
  return sorted[0] ?? null;
}

/** Remove duplicatas de snapshot por (grupo_fundo, data_posicao), mantendo o último da série. */
export function dedupSnapshots(snapshots: SnapshotFundo[]): SnapshotFundo[] {
  const map = new Map<string, SnapshotFundo>();
  const isinAliases = buildFundoIsinAliasMap(snapshots);
  for (const s of snapshots) {
    map.set(`${getSnapshotGroupKey(s, isinAliases)}_${s.data_posicao}`, s);
  }
  return [...map.values()].sort((a, b) =>
    a.data_posicao.localeCompare(b.data_posicao),
  );
}

export interface FundoXmlCoverageRow {
  fundo_key: string;
  nome_fundo: string;
  cnpj_fundo: string;
  fundo_isin: string | null;
  /** Última posição importada na janela até dataRef (YYYY-MM-DD). */
  ultima_data_iso: string;
  administrador: string;
}


/**
 * Cobertura XML na dataRef — agrupa por fundo_key (CNPJ+ISIN com aliases).
 * Alinhado com `agruparSnapshotsPorFundo` para evitar duplicatas quando o fundo
 * muda de nome comercial mas mantém o mesmo CNPJ/ISIN.
 *
 * - Universo: classes distintas com pelo menos 1 snapshot em [dataRef−janelaDias, dataRef]
 * - Importados: classes com snapshot exato em dataRef
 * - Faltantes: classes no universo sem snapshot em dataRef
 */
export function computeRentabilidadeXmlCoverage(
  snapshots: SnapshotFundo[],
  dataRefIso: string,
  janelaDias = DIAS_INATIVO_RENTABILIDADE_XML,
): {
  total: number;
  importados: number;
  faltantes: FundoXmlCoverageRow[];
} {
  const janelaMinIso = subtractDaysIso(dataRefIso, janelaDias);
  const isinAliases = buildFundoIsinAliasMap(snapshots);

  // Agrupa snapshots ≤ dataRef por fundo_key, dedup por (fundoKey + data).
  const byFundo = new Map<string, Map<string, SnapshotFundo>>();
  for (const s of snapshots) {
    if (s.data_posicao > dataRefIso) continue;
    const fk = getSnapshotGroupKey(s, isinAliases);
    const byDate = byFundo.get(fk) ?? new Map<string, SnapshotFundo>();
    byDate.set(s.data_posicao, s); // último registro por data vence
    byFundo.set(fk, byDate);
  }

  const universo: FundoXmlCoverageRow[] = [];
  const faltantes: FundoXmlCoverageRow[] = [];

  for (const [nk, byDate] of byFundo) {
    const sorted = [...byDate.values()].sort((a, b) =>
      a.data_posicao.localeCompare(b.data_posicao),
    );

    // Entra no universo apenas se tem atividade na janela de N dias.
    const naJanela = sorted.filter(
      (s) => s.data_posicao >= janelaMinIso && s.data_posicao <= dataRefIso,
    );
    if (naJanela.length === 0) continue;

    const ultima = naJanela[naJanela.length - 1];
    const row: FundoXmlCoverageRow = {
      fundo_key: nk,
      nome_fundo: ultima.nome_fundo ?? "",
      cnpj_fundo: ultima.fundo_cnpj,
      fundo_isin: ultima.fundo_isin,
      ultima_data_iso: ultima.data_posicao,
      administrador: ultima.administrador ?? "",
    };

    universo.push(row);

    if (!byDate.has(dataRefIso)) faltantes.push(row);
  }

  faltantes.sort((a, b) =>
    (a.nome_fundo || "").localeCompare(b.nome_fundo || "", "pt-BR"),
  );

  return {
    total: universo.length,
    importados: universo.length - faltantes.length,
    faltantes,
  };
}

/** Agrupa snapshots por grupo de classe/fundo (CNPJ+ISIN com fallback por nome). */
export function agruparSnapshotsPorFundo(
  snapshots: SnapshotFundo[],
): Map<string, SnapshotFundo[]> {
  const map = new Map<string, SnapshotFundo[]>();
  const isinAliases = buildFundoIsinAliasMap(snapshots);
  for (const s of snapshots) {
    const groupKey = getSnapshotGroupKey(s, isinAliases);
    const list = map.get(groupKey) ?? [];
    list.push(s);
    map.set(groupKey, list);
  }
  for (const [, list] of map) {
    list.sort((a, b) => a.data_posicao.localeCompare(b.data_posicao));
  }
  return map;
}

// ─── Cálculos de retorno ─────────────────────────────────────────────────────

export function calcRetornoDia(
  cotaHoje: number,
  cotaOntem: number | null,
): number | null {
  if (cotaOntem === null || cotaOntem === 0) return null;
  return (cotaHoje / cotaOntem - 1) * 100;
}

export function calcRetornoAcum(cotaD: number, cotaBase: number): number | null {
  if (cotaBase === 0) return null;
  return (cotaD / cotaBase - 1) * 100;
}

export function calcRetornoMes(
  snapshots: SnapshotFundo[],
  dataRef: string,
): number | null {
  const inicioMes = `${dataRef.slice(0, 7)}-01`;
  const base = [...snapshots]
    .filter((s) => s.data_posicao < inicioMes)
    .sort((a, b) => b.data_posicao.localeCompare(a.data_posicao))[0];
  const cotaHoje = encontrarSnapshotExato(snapshots, dataRef);
  if (!base || !cotaHoje) return null;
  return calcRetornoAcum(cotaHoje.valor_cota, base.valor_cota);
}

/** Retorno no ano civil (base = último snapshot antes de 01/jan do ano de dataRef). */
export function calcRetornoAno(
  snapshots: SnapshotFundo[],
  dataRef: string,
): number | null {
  const inicioAno = `${dataRef.slice(0, 4)}-01-01`;
  const base = [...snapshots]
    .filter((s) => s.data_posicao < inicioAno)
    .sort((a, b) => b.data_posicao.localeCompare(a.data_posicao))[0];
  const cotaHoje = encontrarSnapshotExato(snapshots, dataRef);
  if (!base || !cotaHoje) return null;
  return calcRetornoAcum(cotaHoje.valor_cota, base.valor_cota);
}

export function calcRetornoSemestral(
  snapshots: SnapshotFundo[],
  dataRef: string,
): number | null {
  const alvo = new Date(dataRef + "T12:00:00");
  alvo.setMonth(alvo.getMonth() - 6);
  const base = encontrarSnapshotMaisProximo(snapshots, alvo);
  const cotaHoje = encontrarSnapshotExato(snapshots, dataRef);
  if (!base || !cotaHoje) return null;
  return calcRetornoAcum(cotaHoje.valor_cota, base.valor_cota);
}

export function calcRetorno12M(
  snapshots: SnapshotFundo[],
  dataRef: string,
): number | null {
  const alvo = new Date(dataRef + "T12:00:00");
  alvo.setFullYear(alvo.getFullYear() - 1);
  const base = encontrarSnapshotMaisProximo(snapshots, alvo);
  const cotaHoje = encontrarSnapshotExato(snapshots, dataRef);
  if (!base || !cotaHoje) return null;
  return calcRetornoAcum(cotaHoje.valor_cota, base.valor_cota);
}

/** Queda acima deste limite (%/dia) destaca o fundo na grade de rentabilidade. */
export const RETORNO_DIA_QUEDA_DESTAQUE_PCT = -1;

/** Alta a partir deste limite (%/dia) destaca o fundo na grade de rentabilidade. */
export const RETORNO_DIA_ALTA_DESTAQUE_PCT = 2;

export type RetornoDiaDestaque = "queda" | "alta";

/** Retorna o tipo de destaque do retorno do dia, ou null se dentro da faixa normal. */
export function getRetornoDiaDestaque(
  retornoDiaPct: number | null,
): RetornoDiaDestaque | null {
  if (retornoDiaPct == null) return null;
  if (retornoDiaPct < RETORNO_DIA_QUEDA_DESTAQUE_PCT) return "queda";
  if (retornoDiaPct >= RETORNO_DIA_ALTA_DESTAQUE_PCT) return "alta";
  return null;
}

// ─── Benchmark CDI ───────────────────────────────────────────────────────────

/** retornoDiaPct e cdiDiaPct em percentual (ex: 0.0534 = 0,0534%/dia). */
export function calcPctCDI(
  retornoDiaPct: number,
  cdiDiaPct: number,
): number | null {
  if (cdiDiaPct === 0) return null;
  return (retornoDiaPct / cdiDiaPct) * 100;
}

/** CDI+ dia — capitalização composta. Entradas em percentual. */
export function calcCDIPlusDia(
  retornoDiaPct: number,
  cdiDiaPct: number,
): number | null {
  const rf = retornoDiaPct / 100;
  const cdi = cdiDiaPct / 100;
  if (1 + cdi === 0) return null;
  return ((1 + rf) / (1 + cdi) - 1) * 100;
}

export function calcCDIPlusAA(cdiPlusDiaPct: number): number {
  return ((1 + cdiPlusDiaPct / 100) ** 252 - 1) * 100;
}

/** Anualiza CDI+ mensal com 12 meses. */
export function calcCDIPlusAAMes(cdiPlusMesPct: number): number {
  return ((1 + cdiPlusMesPct / 100) ** 12 - 1) * 100;
}

export interface MetricasVsCDI {
  pct_cdi: number | null;
  cdi_plus_pct: number | null;
  cdi_plus_aa_pct: number | null;
}

/** Calcula % do CDI, CDI+ e CDI+ a.a. para um retorno vs benchmark CDI. */
export function calcMetricasVsCDI(
  retornoPct: number | null,
  cdiBenchPct: number | null,
  duAnual = 252,
): MetricasVsCDI {
  if (retornoPct == null || cdiBenchPct == null) {
    return { pct_cdi: null, cdi_plus_pct: null, cdi_plus_aa_pct: null };
  }
  const cdi_plus_pct = calcCDIPlusDia(retornoPct, cdiBenchPct);
  return {
    pct_cdi: calcPctCDI(retornoPct, cdiBenchPct),
    cdi_plus_pct,
    cdi_plus_aa_pct:
      cdi_plus_pct != null
        ? ((1 + cdi_plus_pct / 100) ** duAnual - 1) * 100
        : null,
  };
}

/** CDI acumulado no mês corrente até dataRef (composto, em %). */
export function calcCdiAcumuladoMes(
  cdiDict: Record<string, number>,
  dataRef: string,
): number | null {
  const mesPrefix = dataRef.slice(0, 7);
  let acum = 1;
  let n = 0;
  for (const [data, taxaDecimal] of Object.entries(cdiDict)) {
    if (data.startsWith(mesPrefix) && data <= dataRef) {
      acum *= 1 + taxaDecimal;
      n++;
    }
  }
  if (n === 0) return null;
  return (acum - 1) * 100;
}

/** CDI acumulado no ano civil até dataRef (composto, em %). */
export function calcCdiAcumuladoAno(
  cdiDict: Record<string, number>,
  dataRef: string,
): number | null {
  const anoPrefix = dataRef.slice(0, 4);
  let acum = 1;
  let n = 0;
  for (const [data, taxaDecimal] of Object.entries(cdiDict)) {
    if (data.startsWith(anoPrefix) && data <= dataRef) {
      acum *= 1 + taxaDecimal;
      n++;
    }
  }
  if (n === 0) return null;
  return (acum - 1) * 100;
}

/** CDI acumulado nos últimos 12 meses até dataRef (composto, em %). */
export function calcCdiAcumulado12M(
  cdiDict: Record<string, number>,
  dataRef: string,
): number | null {
  const alvo = new Date(dataRef + "T12:00:00");
  alvo.setFullYear(alvo.getFullYear() - 1);
  const dataInicio = alvo.toISOString().slice(0, 10);

  let acum = 1;
  let n = 0;
  for (const [data, taxaDecimal] of Object.entries(cdiDict)) {
    if (data > dataInicio && data <= dataRef) {
      acum *= 1 + taxaDecimal;
      n++;
    }
  }
  if (n === 0) return null;
  return (acum - 1) * 100;
}

/** Último ponto da série dentro da janela de dias do alvo. */
export function encontrarPontoSerieMaisProximo<T extends { data_posicao: string }>(
  serie: T[],
  alvo: Date,
  janelaMaxDias = 30,
): T | null {
  const alvoMs = alvo.getTime();
  let melhor: T | null = null;
  let menorDiff = Infinity;

  for (const s of serie) {
    const diff = Math.abs(
      new Date(s.data_posicao + "T12:00:00").getTime() - alvoMs,
    );
    const diffDias = diff / (1000 * 60 * 60 * 24);
    if (diffDias <= janelaMaxDias && diffDias < menorDiff) {
      menorDiff = diffDias;
      melhor = s;
    }
  }
  return melhor;
}

/** Variação do PU no mês (base = último snapshot antes do dia 1). */
export function calcVarPUMes(
  posicoesDoAtivo: Array<{
    data_posicao: string;
    pu_posicao: number;
    qt?: number;
  }>,
  dataRef: string,
): number | null {
  const inicioMes = `${dataRef.slice(0, 7)}-01`;
  const serie = dedupSeriePuPorData(posicoesDoAtivo);
  const base = [...serie]
    .filter((p) => p.data_posicao < inicioMes)
    .sort((a, b) => b.data_posicao.localeCompare(a.data_posicao))[0];
  const hoje = serie.find((p) => p.data_posicao === dataRef);
  if (!base || !hoje || base.pu_posicao === 0) return null;
  return calcVarPU(hoje.pu_posicao, base.pu_posicao);
}

/** Variação do PU no ano civil (base = último PU antes de 01/jan). */
export function calcVarPUAno(
  posicoesDoAtivo: Array<{
    data_posicao: string;
    pu_posicao: number;
    qt?: number;
  }>,
  dataRef: string,
): number | null {
  const inicioAno = `${dataRef.slice(0, 4)}-01-01`;
  const serie = dedupSeriePuPorData(posicoesDoAtivo);
  const base = [...serie]
    .filter((p) => p.data_posicao < inicioAno)
    .sort((a, b) => b.data_posicao.localeCompare(a.data_posicao))[0];
  const hoje = serie.find((p) => p.data_posicao === dataRef);
  if (!base || !hoje || base.pu_posicao === 0) return null;
  return calcVarPU(hoje.pu_posicao, base.pu_posicao);
}

/** Variação do PU em 12 meses (base = PU mais próximo de dataRef − 12M, janela 30 dias). */
export function calcVarPU12M(
  posicoesDoAtivo: Array<{
    data_posicao: string;
    pu_posicao: number;
    qt?: number;
  }>,
  dataRef: string,
): number | null {
  const serie = dedupSeriePuPorData(posicoesDoAtivo);
  const alvo = new Date(dataRef + "T12:00:00");
  alvo.setFullYear(alvo.getFullYear() - 1);
  const base = encontrarPontoSerieMaisProximo(serie, alvo);
  const hoje = serie.find((p) => p.data_posicao === dataRef);
  if (!base || !hoje || base.pu_posicao === 0) return null;
  return calcVarPU(hoje.pu_posicao, base.pu_posicao);
}

// ─── Ativos ──────────────────────────────────────────────────────────────────

export function calcPercPL(
  qtDisponivel: number,
  puPosicao: number,
  plFundo: number,
): number | null {
  if (plFundo === 0) return null;
  const vlMercado = qtDisponivel * puPosicao;
  return (vlMercado / plFundo) * 100;
}

export function calcVarPU(
  puHoje: number,
  puOntem: number | null,
): number | null {
  if (puOntem === null || puOntem === 0) return null;
  return (puHoje / puOntem - 1) * 100;
}

/** Limite plausível de variação diária de PU (%/dia) — acima disso, vs CDI fica inválido. */
export const VAR_PU_MAX_PLAUSIVEL = 3;

export function isVarPuPlausivel(varPu: number | null): boolean {
  if (varPu === null) return false;
  return Math.abs(varPu) <= VAR_PU_MAX_PLAUSIVEL;
}

/**
 * Consolida múltiplas linhas do mesmo ativo na mesma data (PU médio ponderado por qtd).
 */
export function dedupSeriePuPorData(
  rows: Array<{
    data_posicao: string;
    pu_posicao: number;
    qt?: number;
  }>,
): Array<{ data_posicao: string; pu_posicao: number }> {
  const byDate = new Map<string, { puSum: number; qtSum: number }>();

  for (const r of rows) {
    if (r.pu_posicao <= 0) continue;
    const qt = r.qt && r.qt > 0 ? r.qt : 1;
    const cur = byDate.get(r.data_posicao) ?? { puSum: 0, qtSum: 0 };
    cur.puSum += r.pu_posicao * qt;
    cur.qtSum += qt;
    byDate.set(r.data_posicao, cur);
  }

  return [...byDate.entries()]
    .map(([data_posicao, { puSum, qtSum }]) => ({
      data_posicao,
      pu_posicao: qtSum > 0 ? puSum / qtSum : 0,
    }))
    .filter((x) => x.pu_posicao > 0)
    .sort((a, b) => a.data_posicao.localeCompare(b.data_posicao));
}

/** Variação diária do PU usando apenas a série deste ativo (deduplicada por data). */
export function calcVarPUAtivo(
  posicoesDoAtivo: Array<{
    data_posicao: string;
    pu_posicao: number;
    qt?: number;
  }>,
  dataRef: string,
): number | null {
  const serie = dedupSeriePuPorData(posicoesDoAtivo);
  const hoje = serie.find((p) => p.data_posicao === dataRef);
  const ontem = [...serie]
    .filter((p) => p.data_posicao < dataRef)
    .sort((a, b) => b.data_posicao.localeCompare(a.data_posicao))[0];
  if (!hoje || !ontem || ontem.pu_posicao === 0) return null;
  return calcVarPU(hoje.pu_posicao, ontem.pu_posicao);
}

/** Converte CDI decimal (ex: 0.000534) para percentual do dia (ex: 0.0534). */
export function cdiDecimalToPct(cdiDecimal: number): number {
  return cdiDecimal * 100;
}

/** Subtrai N dias corridos de uma data ISO. */
export function subtractDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ─── Formatadores ────────────────────────────────────────────────────────────

export const fmtPct = (v: number | null, casas = 4): string => {
  if (v === null) return "—";
  const s = v.toFixed(casas).replace(".", ",");
  return v >= 0 ? `+${s}%` : `${s}%`;
};

export const fmtBRL = (v: number | null): string => {
  if (v === null) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(v);
};

export const fmtCota = (v: number | null, casas = 8): string => {
  if (v === null) return "—";
  return v.toLocaleString("pt-BR", {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  });
};

export const fmtCDIPlusAA = (v: number | null): string => {
  if (v === null) return "—";
  const s = v.toFixed(2).replace(".", ",");
  return v >= 0 ? `CDI +${s}% a.a.` : `CDI ${s}% a.a.`;
};

/** CDI+ diário — uso em tabela de ativos (não anualizar var. de 1 dia). */
export const fmtCDIPlusDia = (v: number | null): string => {
  if (v === null) return "—";
  const s = v.toFixed(4).replace(".", ",");
  return v >= 0 ? `CDI +${s}%/dia` : `CDI ${s}%/dia`;
};

/** Texto explicativo para tooltip da coluna vs CDI. */
export function buildVsCDITooltipLines(
  retornoPct: number | null,
  cdiBenchPct: number | null,
  cdiPlusPct: number | null,
  pctCdi: number | null,
  retornoLabel = "Retorno do dia",
  cdiLabel = "CDI do dia",
  duAnual = 252,
): string[] {
  if (retornoPct == null || cdiBenchPct == null) return [];

  const lines = [
    `${retornoLabel}: ${fmtPct(retornoPct)}`,
    `${cdiLabel}: ${fmtPct(cdiBenchPct)}`,
    `% do CDI = ${retornoLabel} ÷ ${cdiLabel} × 100 = ${fmtPctCDI(pctCdi)}`,
  ];

  if (cdiPlusPct != null) {
    const aa =
      duAnual === 12
        ? calcCDIPlusAAMes(cdiPlusPct)
        : calcCDIPlusAA(cdiPlusPct);
    lines.push(
      `CDI+ = (1 + Rf) ÷ (1 + CDI) − 1 = ${fmtPct(cdiPlusPct, 4)}`,
      `CDI+ a.a. = (1 + CDI+)^${duAnual} − 1 = ${fmtCDIPlusAA(aa)}`,
    );
  }

  return lines;
}

export const fmtPctCDI = (v: number | null): string => {
  if (v === null) return "—";
  const s = v.toFixed(2).replace(".", ",");
  return `${s}% do CDI`;
};

export const fmtData = (iso: string): string => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

export const fmtCnpj = (cnpj: string): string => {
  const clean = cnpj.replace(/\D/g, "");
  if (clean.length !== 14) return cnpj;
  return clean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
};
