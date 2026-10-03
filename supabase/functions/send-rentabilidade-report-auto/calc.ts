/**
 * Motor de cálculo de rentabilidade (nível fundo) — porte Deno de
 * `src/hooks/useRentabilidadeCalc.ts` + `src/hooks/useRentabilidadeData.ts`
 * (apenas o subconjunto usado pelo envio automático: sem drill-down de ativos).
 *
 * Mantém as mesmas fórmulas do módulo de Rentabilidade (frontend) — qualquer
 * alteração de metodologia deve ser replicada nos dois lados.
 * Edge functions são autocontidas: não há import cruzado com o frontend.
 */

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface SnapshotFundo {
  fundo_cnpj: string;
  fundo_isin: string | null;
  data_posicao: string; // YYYY-MM-DD
  valor_cota: number;
  pl: number;
  quantidade: number | null;
  nome_fundo: string | null;
  administrador: string | null;
}

export interface PosicaoCarteiraHeaderRow {
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
  fundo_cnpjgestor?: string | null;
  section?: string;
}

export interface RentabilidadeFundoRow {
  fundo_key: string;
  fundo_cnpj: string;
  fundo_isin: string | null;
  nome_fundo: string | null;
  data_posicao: string;
  valor_cota: number;
  pl: number;
  quantidade: number | null;
  retorno_dia_pct: number | null;
  retorno_mes_pct: number | null;
  retorno_ano_pct: number | null;
  retorno_12m_pct: number | null;
  cdi_dia_pct: number | null;
  pct_cdi: number | null;
  cdi_plus_aa_pct: number | null;
  pct_cdi_mes: number | null;
  cdi_plus_aa_mes_pct: number | null;
  pct_cdi_ano: number | null;
  cdi_plus_aa_ano_pct: number | null;
  pct_cdi_12m: number | null;
  cdi_plus_aa_12m_pct: number | null;
  administrador: string | null;
}

export interface FundoXmlCoverageRow {
  fundo_key: string;
  nome_fundo: string;
  cnpj_fundo: string;
  fundo_isin: string | null;
  ultima_data_iso: string;
  administrador: string;
}

// ─── Datas ───────────────────────────────────────────────────────────────────

export function yyyymmddToIso(dt: string): string {
  if (!dt || dt.length !== 8) return dt;
  return `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
}

export function isoToYyyymmdd(iso: string): string {
  return iso.replace(/-/g, "");
}

export function subtractDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Data de hoje em BRT no formato YYYY-MM-DD (independe do fuso do servidor da edge function). */
export function todayIsoBRT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

// ─── ISIN / agrupamento de fundo (CNPJ+ISIN com alias) ──────────────────────

export function isIsinMascarado(isin: string | null | undefined): boolean {
  const s = isin?.trim();
  if (!s) return true;
  return s.includes("*");
}

export function isinUtilizavel(isin: string | null | undefined): string | null {
  const s = isin?.trim().toUpperCase();
  if (!s || isIsinMascarado(s)) return null;
  return s;
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

function buildFundoIsinAliasMap(snapshots: SnapshotFundo[]): FundoIsinAliasMap {
  const byNome = new Map<string, Set<string>>();
  const byCnpj = new Map<string, Set<string>>();

  for (const s of snapshots) {
    const isin = s.fundo_isin?.trim().toUpperCase();
    if (!isin) continue;

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
    if (hasSameDateIsinOverlap(snapshots, cnpj, nomeNorm, set)) continue;
    const canonical = pickLatestIsinForNome(snapshots, cnpj, nomeNorm, set);
    if (canonical) aliases.set(key, canonical);
  }

  for (const [cnpj, isinSet] of byCnpj) {
    if (isinSet.size === 1) {
      aliases.set(`${cnpj}|CNPJ_UNICO`, [...isinSet][0]);
    }
  }

  return aliases;
}

function getFundoGroupKey(
  fundoCnpj: string,
  fundoIsin: string | null | undefined,
  nomeFundo: string | null | undefined,
  isinAliases?: Map<string, string>,
): string {
  const isin = fundoIsin?.trim().toUpperCase();
  const nomeNorm = normalizeNomeFundo(nomeFundo);
  const nomeKey = `${fundoCnpj}|NOME:${nomeNorm || "SEM_NOME"}`;

  const aliasIsinNome = isinAliases?.get(nomeKey);
  if (aliasIsinNome) return `${fundoCnpj}|ISIN:${aliasIsinNome}`;

  if (isin) return `${fundoCnpj}|ISIN:${isin}`;

  const aliasIsinCnpj = isinAliases?.get(`${fundoCnpj}|CNPJ_UNICO`);
  if (aliasIsinCnpj) return `${fundoCnpj}|ISIN:${aliasIsinCnpj}`;

  return fundoCnpj;
}

function getSnapshotGroupKey(s: SnapshotFundo, isinAliases?: FundoIsinAliasMap): string {
  return getFundoGroupKey(s.fundo_cnpj, s.fundo_isin, s.nome_fundo, isinAliases);
}

// ─── Mapeamento posicao_carteira → snapshot ─────────────────────────────────

export function mapPosicaoToSnapshot(row: PosicaoCarteiraHeaderRow): SnapshotFundo | null {
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
    quantidade: row.fundo_quantidade,
    nome_fundo: row.nome_fundo ?? row.fundo_nome ?? null,
    administrador: row.fundo_nomeadm?.trim() || null,
  };
}

/** Remove duplicatas de snapshot por (grupo_fundo, data_posicao), mantendo o último da série. */
export function dedupSnapshots(snapshots: SnapshotFundo[]): SnapshotFundo[] {
  const map = new Map<string, SnapshotFundo>();
  const isinAliases = buildFundoIsinAliasMap(snapshots);
  for (const s of snapshots) {
    map.set(`${getSnapshotGroupKey(s, isinAliases)}_${s.data_posicao}`, s);
  }
  return [...map.values()].sort((a, b) => a.data_posicao.localeCompare(b.data_posicao));
}

/** Agrupa snapshots por grupo de classe/fundo (CNPJ+ISIN com fallback por nome). */
export function agruparSnapshotsPorFundo(snapshots: SnapshotFundo[]): Map<string, SnapshotFundo[]> {
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

// ─── Helpers de snapshot ─────────────────────────────────────────────────────

function encontrarSnapshotExato(snapshots: SnapshotFundo[], dataRef: string): SnapshotFundo | null {
  return snapshots.find((s) => s.data_posicao === dataRef) ?? null;
}

function encontrarSnapshotMaisProximo(
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

function encontrarDiaUtilAnterior(snapshots: SnapshotFundo[], dataRef: string): SnapshotFundo | null {
  const sorted = [...snapshots]
    .filter((s) => s.data_posicao < dataRef)
    .sort((a, b) => b.data_posicao.localeCompare(a.data_posicao));
  return sorted[0] ?? null;
}

// ─── Cobertura XML (fundos faltantes) ───────────────────────────────────────

/** Fundos sem XML há mais de N dias (corridos) antes da data de referência ficam fora do universo. */
export const DIAS_INATIVO_RENTABILIDADE_XML = 10;

export function computeRentabilidadeXmlCoverage(
  snapshots: SnapshotFundo[],
  dataRefIso: string,
  janelaDias = DIAS_INATIVO_RENTABILIDADE_XML,
): { total: number; importados: number; faltantes: FundoXmlCoverageRow[] } {
  const janelaMinIso = subtractDaysIso(dataRefIso, janelaDias);
  const isinAliases = buildFundoIsinAliasMap(snapshots);

  const byFundo = new Map<string, Map<string, SnapshotFundo>>();
  for (const s of snapshots) {
    if (s.data_posicao > dataRefIso) continue;
    const fk = getSnapshotGroupKey(s, isinAliases);
    const byDate = byFundo.get(fk) ?? new Map<string, SnapshotFundo>();
    byDate.set(s.data_posicao, s);
    byFundo.set(fk, byDate);
  }

  const universo: FundoXmlCoverageRow[] = [];
  const faltantes: FundoXmlCoverageRow[] = [];

  for (const [nk, byDate] of byFundo) {
    const sorted = [...byDate.values()].sort((a, b) => a.data_posicao.localeCompare(b.data_posicao));
    const naJanela = sorted.filter((s) => s.data_posicao >= janelaMinIso && s.data_posicao <= dataRefIso);
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

  faltantes.sort((a, b) => (a.nome_fundo || "").localeCompare(b.nome_fundo || "", "pt-BR"));

  return { total: universo.length, importados: universo.length - faltantes.length, faltantes };
}

/** Remove faltantes que já têm posição importada (RPC alinhada ao Enquadramento). */
export function reconcileFaltantesComPares(
  faltantes: FundoXmlCoverageRow[],
  pares: Array<{ fundo_cnpj: string; fundo_isin: string; nome_fundo: string }>,
  normalizeCnpjDigits: (cnpj: string | null | undefined) => string,
): FundoXmlCoverageRow[] {
  return faltantes.filter((f) => {
    const cnpjNorm = normalizeCnpjDigits(f.cnpj_fundo);
    const nomeFal = normalizeNomeFundo(f.nome_fundo);
    const isinFal = (f.fundo_isin ?? "").trim().toUpperCase();

    const importado = pares.some((p) => {
      if (normalizeCnpjDigits(p.fundo_cnpj) !== cnpjNorm) return false;
      const isinPar = (p.fundo_isin ?? "").trim().toUpperCase();
      if (isinPar && isinFal && isinPar === isinFal) return true;
      return nomeFal !== "" && normalizeNomeFundo(p.nome_fundo) === nomeFal;
    });
    return !importado;
  });
}

// ─── Cálculos de retorno ─────────────────────────────────────────────────────

function calcRetornoDia(cotaHoje: number, cotaOntem: number | null): number | null {
  if (cotaOntem === null || cotaOntem === 0) return null;
  return (cotaHoje / cotaOntem - 1) * 100;
}

function calcRetornoAcum(cotaD: number, cotaBase: number): number | null {
  if (cotaBase === 0) return null;
  return (cotaD / cotaBase - 1) * 100;
}

function calcRetornoMes(snapshots: SnapshotFundo[], dataRef: string): number | null {
  const inicioMes = `${dataRef.slice(0, 7)}-01`;
  const base = [...snapshots]
    .filter((s) => s.data_posicao < inicioMes)
    .sort((a, b) => b.data_posicao.localeCompare(a.data_posicao))[0];
  const cotaHoje = encontrarSnapshotExato(snapshots, dataRef);
  if (!base || !cotaHoje) return null;
  return calcRetornoAcum(cotaHoje.valor_cota, base.valor_cota);
}

function calcRetornoAno(snapshots: SnapshotFundo[], dataRef: string): number | null {
  const inicioAno = `${dataRef.slice(0, 4)}-01-01`;
  const base = [...snapshots]
    .filter((s) => s.data_posicao < inicioAno)
    .sort((a, b) => b.data_posicao.localeCompare(a.data_posicao))[0];
  const cotaHoje = encontrarSnapshotExato(snapshots, dataRef);
  if (!base || !cotaHoje) return null;
  return calcRetornoAcum(cotaHoje.valor_cota, base.valor_cota);
}

function calcRetorno12M(snapshots: SnapshotFundo[], dataRef: string): number | null {
  const alvo = new Date(dataRef + "T12:00:00");
  alvo.setFullYear(alvo.getFullYear() - 1);
  const base = encontrarSnapshotMaisProximo(snapshots, alvo);
  const cotaHoje = encontrarSnapshotExato(snapshots, dataRef);
  if (!base || !cotaHoje) return null;
  return calcRetornoAcum(cotaHoje.valor_cota, base.valor_cota);
}

// ─── Benchmark CDI ───────────────────────────────────────────────────────────

function calcPctCDI(retornoDiaPct: number, cdiDiaPct: number): number | null {
  if (cdiDiaPct === 0) return null;
  return (retornoDiaPct / cdiDiaPct) * 100;
}

function calcCDIPlusDia(retornoDiaPct: number, cdiDiaPct: number): number | null {
  const rf = retornoDiaPct / 100;
  const cdi = cdiDiaPct / 100;
  if (1 + cdi === 0) return null;
  return ((1 + rf) / (1 + cdi) - 1) * 100;
}

export interface MetricasVsCDI {
  pct_cdi: number | null;
  cdi_plus_pct: number | null;
  cdi_plus_aa_pct: number | null;
}

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
    cdi_plus_aa_pct: cdi_plus_pct != null ? ((1 + cdi_plus_pct / 100) ** duAnual - 1) * 100 : null,
  };
}

export function isFundoFidc(nome: string | null | undefined): boolean {
  if (!nome) return false;
  return nome.toUpperCase().includes("FIDC");
}

export function calcCdiAcumuladoMes(cdiDict: Record<string, number>, dataRef: string): number | null {
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

export function calcCdiAcumuladoAno(cdiDict: Record<string, number>, dataRef: string): number | null {
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

export function calcCdiAcumulado12M(cdiDict: Record<string, number>, dataRef: string): number | null {
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

export function cdiDecimalToPct(cdiDecimal: number): number {
  return cdiDecimal * 100;
}

// ─── Agregação final: métricas de um fundo na data de referência ───────────

export function calcularMetricasFundo(
  fundoKey: string,
  serie: SnapshotFundo[],
  dataRef: string,
  cdiDict: Record<string, number>,
): RentabilidadeFundoRow | null {
  const serieLimpa = dedupSnapshots(serie);
  const hoje = encontrarSnapshotExato(serieLimpa, dataRef);
  if (!hoje) return null;

  const ontem = encontrarDiaUtilAnterior(serieLimpa, dataRef);

  const retornoDia = calcRetornoDia(hoje.valor_cota, ontem?.valor_cota ?? null);
  const retornoMes = calcRetornoMes(serieLimpa, dataRef);
  const retornoAno = calcRetornoAno(serieLimpa, dataRef);
  const retorno12m = calcRetorno12M(serieLimpa, dataRef);

  const cdiDecimal = cdiDict[dataRef] ?? null;
  const cdiDiaPct = cdiDecimal != null ? cdiDecimalToPct(cdiDecimal) : null;
  const cdiMesPct = calcCdiAcumuladoMes(cdiDict, dataRef);
  const cdiAnoPct = calcCdiAcumuladoAno(cdiDict, dataRef);
  const cdi12mPct = calcCdiAcumulado12M(cdiDict, dataRef);

  const vsCdiDia = calcMetricasVsCDI(retornoDia, cdiDiaPct, 252);
  const vsCdiMes = calcMetricasVsCDI(retornoMes, cdiMesPct, 12);
  const vsCdiAno = calcMetricasVsCDI(retornoAno, cdiAnoPct, 1);
  const vsCdi12m = calcMetricasVsCDI(retorno12m, cdi12mPct, 1);

  return {
    fundo_key: fundoKey,
    fundo_cnpj: hoje.fundo_cnpj,
    fundo_isin: hoje.fundo_isin,
    nome_fundo: hoje.nome_fundo,
    data_posicao: dataRef,
    valor_cota: hoje.valor_cota,
    pl: hoje.pl,
    quantidade: hoje.quantidade,
    retorno_dia_pct: retornoDia,
    retorno_mes_pct: retornoMes,
    retorno_ano_pct: retornoAno,
    retorno_12m_pct: retorno12m,
    cdi_dia_pct: cdiDiaPct,
    pct_cdi: vsCdiDia.pct_cdi,
    cdi_plus_aa_pct: vsCdiDia.cdi_plus_aa_pct,
    pct_cdi_mes: vsCdiMes.pct_cdi,
    cdi_plus_aa_mes_pct: vsCdiMes.cdi_plus_aa_pct,
    pct_cdi_ano: vsCdiAno.pct_cdi,
    cdi_plus_aa_ano_pct: vsCdiAno.cdi_plus_aa_pct,
    pct_cdi_12m: vsCdi12m.pct_cdi,
    cdi_plus_aa_12m_pct: vsCdi12m.cdi_plus_aa_pct,
    administrador: hoje.administrador,
  };
}

// ─── CDI (BCB SGS) ───────────────────────────────────────────────────────────

function isoToBcbDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function bcbDateToIso(bcb: string): string {
  const [d, m, y] = bcb.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

export async function fetchCdiRange(dataInicio: string, dataFim: string): Promise<Record<string, number>> {
  const url =
    `https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados` +
    `?formato=json&dataInicial=${isoToBcbDate(dataInicio)}&dataFinal=${isoToBcbDate(dataFim)}`;

  console.log(`[fetchCdiRange] Buscando CDI: ${url}`);
  const resp = await fetch(url);
  console.log(`[fetchCdiRange] Status: ${resp.status}, Content-Type: ${resp.headers.get("content-type")}`);
  
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[fetchCdiRange] Erro BCB (${resp.status}): ${body.slice(0, 500)}`);
    throw new Error(`BCB SGS retornou HTTP ${resp.status}`);
  }

  const contentType = resp.headers.get("content-type") || "";
  const body = await resp.text();
  
  if (!contentType.includes("application/json") && body.startsWith("<?xml")) {
    console.error(`[fetchCdiRange] BCB retornou XML: ${body.slice(0, 500)}`);
    throw new Error("BCB SGS retornou XML (rate limit ou erro de API). Aguarde e tente novamente.");
  }

  let json: Array<{ data: string; valor: string }>;
  try {
    json = JSON.parse(body);
  } catch (err) {
    console.error(`[fetchCdiRange] Erro ao parsear JSON: ${body.slice(0, 500)}`);
    throw new Error(`BCB SGS retornou resposta inválida: ${(err as Error).message}`);
  }

  const dict: Record<string, number> = {};
  for (const item of json) {
    const taxa = parseFloat(item.valor.replace(",", "."));
    if (!isNaN(taxa)) dict[bcbDateToIso(item.data)] = taxa / 100;
  }
  
  console.log(`[fetchCdiRange] CDI carregado: ${Object.keys(dict).length} dias`);
  return dict;
}

// ─── CNPJ ────────────────────────────────────────────────────────────────────

export function normalizeCnpjDigits(cnpj: string | null | undefined): string {
  if (!cnpj) return "";
  const digits = cnpj.replace(/\D/g, "");
  return digits.padStart(14, "0");
}

// ─── Fundos exclusivos (Condominiais vs Exclusivos) ─────────────────────────
// Porte Deno de `src/lib/fundosExclusivosRentabilidade.ts` — manter sincronizado.

const FUNDOS_EXCLUSIVOS = new Set(
  [
    "FMA QI FIF MULTIMERCADO CP - RESP LIMITADA",
    "GATI QI FIF MULTIMERCADO CP RESP LIMITADA",
    "JUBIA QI FIF MULTIMERCADO CP RESP LIMITADA",
    "GUILE QI FIF MULTIMERCADO CREDITO PRIVADO",
    "FICFIF QI RM95",
    "PHISIQ QI GRAND SLAM FIF M CP RESP LIMITADA",
    "RMF QI FIF MULTIMERCADO RESP LIMITADA",
    "FICFIDC BIAJU",
    "CARPE DIEM BR QI FIM CP",
    "PORTFOLIO 173 FIF MULT CP - RESP LIMITADA",
    "TAMBAU QI FIM CP",
    "MMCP QI FIF MULTIMERCADO CP RESP LIMITADA",
    "GAPE QI FIF MULTIMERCADO CP RESP LIMITADA",
    "NEVERGIVEUP QI FIF MULTI CP RESP LIMITADA",
  ].map(normalizeNomeFundo),
);

const FUNDOS_NAO_EXCLUSIVOS = new Set(["RWM CP PREV FIC FIM"].map(normalizeNomeFundo));

export function isFundoExclusivoRentabilidade(nome: string | null | undefined): boolean {
  const norm = normalizeNomeFundo(nome);
  if (!norm) return false;
  if (FUNDOS_NAO_EXCLUSIVOS.has(norm)) return false;
  if (FUNDOS_EXCLUSIVOS.has(norm)) return true;
  for (const ref of FUNDOS_EXCLUSIVOS) {
    if (norm.includes(ref)) return true;
  }
  return false;
}
