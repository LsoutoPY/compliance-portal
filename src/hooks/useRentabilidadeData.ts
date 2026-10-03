import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  buildNomeMapFromAtivos,
  buildNomeMapFromFundos,
  nomeMapToRecord,
} from "@/lib/mapaAtivosNome";
import { supabase } from "@/integrations/supabase/client";
import { normalizeCnpjDigits, fetchParesMonitorados, type ParFundoMonitorado } from "@/lib/fundosMonitorados";
import { fetchPosicaoAvailableDates } from "@/lib/posicaoAvailableDates";
import { useCDI, fetchCdiRange } from "@/hooks/useCDI";
import { atualizarComparativosCdi } from "@/lib/rentabilidadeCdi";
import {
  agruparSnapshotsPorFundo,
  computeRentabilidadeXmlCoverage,
  type FundoXmlCoverageRow,
  calcCdiAcumulado12M,
  calcCdiAcumuladoAno,
  calcCdiAcumuladoMes,
  calcMetricasVsCDI,
  calcPercPL,
  calcRetorno12M,
  calcRetornoAcum,
  calcRetornoAno,
  calcRetornoDia,
  calcRetornoMes,
  calcRetornoSemestral,
  calcVarPU12M,
  calcVarPUAno,
  calcVarPUAtivo,
  calcVarPUMes,
  cdiDecimalToPct,
  dedupSnapshots,
  filterSnapshotsForClasse,
  encontrarDiaUtilAnterior,
  encontrarSnapshotExato,
  isoToYyyymmdd,
  isFundoFidc,
  isVarPuPlausivel,
  isinUtilizavel,
  mapPosicaoToAtivo,
  mapPosicaoToSnapshot,
  getAtivoKeyFromRow,
  expandAtivoKeyAliases,
  resolvePuQtFromRow,
  deduplicarCotasPorCnpj,
  consolidarHistoricoPuCotas,
  SECTIONS_ATIVOS_RENTABILIDADE,
  subtractDaysIso,
  yyyymmddToIso,
  type PosicaoAtivo,
  type PosicaoCarteiraRow,
  type SnapshotFundo,
} from "@/hooks/useRentabilidadeCalc";

/** ~560 dias corridos para cobrir Ret. 12M (~400 DU) */
const HISTORICO_DIAS = 560;
const RENTABILIDADE_SNAPSHOT_CALC_VERSION = "rentabilidade_v1_2026-08-03";

/** Retorna Set de CNPJs (14 dígitos) de gestoras ativas monitoradas. Vazio = sem filtro. */
async function fetchGestoresSet(): Promise<Set<string>> {
  const { data } = await (supabase as any)
    .from("gestores_monitorados")
    .select("cnpj_gestor")
    .eq("ativo", true);
  if (!data?.length) return new Set();
  return new Set((data as Array<{ cnpj_gestor: string }>).map((g) => g.cnpj_gestor));
}
/** Histórico extra para aliases ISIN na cobertura XML (alinha com a grade). */
const COBERTURA_ALIAS_DIAS = 60;
const PAGE_SIZE = 1000;

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
  retorno_acum_pct: number | null;
  retorno_mes_pct: number | null;
  retorno_ano_pct: number | null;
  retorno_sem_pct: number | null;
  retorno_12m_pct: number | null;
  cdi_dia_pct: number | null;
  cdi_mes_pct: number | null;
  cdi_ano_pct: number | null;
  pct_cdi: number | null;
  cdi_plus_dia_pct: number | null;
  cdi_plus_aa_pct: number | null;
  pct_cdi_mes: number | null;
  cdi_plus_mes_pct: number | null;
  cdi_plus_aa_mes_pct: number | null;
  pct_cdi_ano: number | null;
  cdi_plus_ano_pct: number | null;
  cdi_plus_aa_ano_pct: number | null;
  cdi_12m_pct: number | null;
  pct_cdi_12m: number | null;
  cdi_plus_12m_pct: number | null;
  cdi_plus_aa_12m_pct: number | null;
  is_fidc: boolean;
  administrador: string | null;
}

export interface RentabilidadeAtivoRow {
  ativo_key: string;
  section: string;
  cnpj_ativo: string | null;
  isin_ativo: string | null;
  nome_ativo: string | null;
  nome_exibicao: string;
  qt_disponivel: number | null;
  pu_posicao: number | null;
  vl_mercado: number | null;
  perc_pl_pct: number | null;
  var_pu_pct: number | null;
  var_pu_mes_pct: number | null;
  var_pu_ano_pct: number | null;
  var_pu_12m_pct: number | null;
  pct_cdi: number | null;
  cdi_plus_dia_pct: number | null;
  cdi_plus_aa_pct: number | null;
  pct_cdi_mes: number | null;
  cdi_plus_mes_pct: number | null;
  cdi_plus_aa_mes_pct: number | null;
  pct_cdi_ano: number | null;
  cdi_plus_ano_pct: number | null;
  cdi_plus_aa_ano_pct: number | null;
  pct_cdi_12m: number | null;
  cdi_plus_12m_pct: number | null;
  cdi_plus_aa_12m_pct: number | null;
  is_fidc: boolean;
}

interface RentabilidadeSnapshotStatusRow {
  data_referencia: string;
  is_stale: boolean;
  stale_reason: string | null;
  updated_at: string;
  last_rebuild_at: string | null;
  last_rebuild_by: string | null;
  last_rebuild_source: string | null;
  calc_version: string | null;
  last_job_id: string | null;
}

interface RentabilidadeSnapshotDbRow {
  data_posicao: string;
  fundo_key: string;
  fundo_cnpj: string;
  fundo_isin: string | null;
  nome_fundo: string | null;
  valor_cota: number | null;
  pl: number | null;
  quantidade: number | null;
  retorno_dia_pct: number | null;
  retorno_acum_pct: number | null;
  retorno_mes_pct: number | null;
  retorno_ano_pct: number | null;
  retorno_sem_pct: number | null;
  retorno_12m_pct: number | null;
  cdi_dia_pct: number | null;
  cdi_mes_pct: number | null;
  cdi_ano_pct: number | null;
  pct_cdi: number | null;
  cdi_plus_dia_pct: number | null;
  cdi_plus_aa_pct: number | null;
  pct_cdi_mes: number | null;
  cdi_plus_mes_pct: number | null;
  cdi_plus_aa_mes_pct: number | null;
  pct_cdi_ano: number | null;
  cdi_plus_ano_pct: number | null;
  cdi_plus_aa_ano_pct: number | null;
  cdi_12m_pct: number | null;
  pct_cdi_12m: number | null;
  cdi_plus_12m_pct: number | null;
  cdi_plus_aa_12m_pct: number | null;
  is_fidc: boolean | null;
  administrador: string | null;
  calc_version: string | null;
}

function isMissingSnapshotInfraError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  const message = (error as { message?: string })?.message?.toLowerCase?.() ?? "";
  return code === "42P01" || code === "42883" || message.includes("does not exist");
}

async function fetchSnapshotsPaginado(
  dataMinYyyymmdd: string,
  dataMaxYyyymmdd: string,
  gestoresSet?: Set<string>,
): Promise<PosicaoCarteiraRow[]> {
  let all: PosicaoCarteiraRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("posicao_carteira")
      .select(
        "fundo_cnpj, fundo_isin, nome_fundo, fundo_nome, fundo_nomeadm, fundo_cnpjgestor, fundo_dtposicao, fundo_valorcota, fundo_patliq, fundo_valorativos, fundo_quantidade, section",
      )
      .in("section", ["caixa", "despesas"])
      .gte("fundo_dtposicao", dataMinYyyymmdd)
      .lte("fundo_dtposicao", dataMaxYyyymmdd)
      .order("fundo_dtposicao", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    if (!data?.length) break;

    all = all.concat(data as PosicaoCarteiraRow[]);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  // Filtra por gestor monitorado quando a allowlist está populada
  if (gestoresSet && gestoresSet.size > 0) {
    all = all.filter((r) => {
      const gestor = normalizeCnpjDigits((r as any).fundo_cnpjgestor);
      return gestor ? gestoresSet.has(gestor) : false;
    });
  }

  return all;
}

function rowsToSnapshots(rows: PosicaoCarteiraRow[]): SnapshotFundo[] {
  const mapped = rows
    .map(mapPosicaoToSnapshot)
    .filter((s): s is SnapshotFundo => s != null);
  return dedupSnapshots(mapped);
}

/** Resolve nomes via fundos_caracteristicas (cadastro ANBIMA). */
async function fetchNomesFundos(
  cnpjs: string[],
  isins: string[] = [],
): Promise<Record<string, string>> {
  const unique = [...new Set(cnpjs.map((c) => c.replace(/\D/g, "")).filter(Boolean))];
  const isinsUnique = [...new Set(isins.map((i) => i.trim().toUpperCase()).filter(Boolean))];
  if (unique.length === 0 && isinsUnique.length === 0) return {};

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
    console.warn("[useRentabilidadeData] Erro ao buscar nomes ANBIMA:", error.message);
    return {};
  }

  return nomeMapToRecord(
    buildNomeMapFromFundos(
      (data ?? []) as Array<{
        cnpj_classe: string | null;
        cnpj_fundo: string | null;
        nome_comercial: string | null;
        isin: string | null;
      }>,
    ),
  );
}

/** Resolve nomes via ativos (nome_frontend editável; fallback descricao do XML). */
async function fetchNomesAtivosFrontend(
  cnpjs: string[],
  isins: string[],
): Promise<Record<string, string>> {
  const cnpjsUnique = [...new Set(cnpjs.map((c) => c.replace(/\D/g, "")).filter(Boolean))];
  const isinsUnique = [...new Set(isins.map((i) => i.trim().toUpperCase()).filter(Boolean))];
  if (cnpjsUnique.length === 0 && isinsUnique.length === 0) return {};

  const filters: string[] = [];
  if (cnpjsUnique.length) filters.push(`cnpj.in.(${cnpjsUnique.join(",")})`);
  if (isinsUnique.length) filters.push(`isin.in.(${isinsUnique.join(",")})`);

  const { data, error } = await supabase
    .from("ativos")
    .select("cnpj, isin, nome_frontend, descricao")
    .or(filters.join(","));

  if (error) {
    console.warn("[useRentabilidadeData] Erro ao buscar nomes frontend:", error.message);
    return {};
  }

  return nomeMapToRecord(
    buildNomeMapFromAtivos(
      (data ?? []) as Array<{
        cnpj: string | null;
        isin: string | null;
        nome_frontend: string | null;
        descricao: string | null;
      }>,
    ),
  );
}

/** Prioridade: nome_frontend/descricao (ativos) > nome_comercial (ANBIMA). */
function mergeNomesAtivos(
  anbima: Record<string, string>,
  frontend: Record<string, string>,
): Record<string, string> {
  return { ...anbima, ...frontend };
}

function normalizeNomeFundo(nome: string | null | undefined): string {
  return (nome ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** CNPJ com no máximo 1 ISIN distinto no lote → fundo de classe única (ex.: FII, FIDC simples). */
function cnpjTemClasseUnica(
  rows: PosicaoCarteiraRow[],
  fundoCnpj: string,
): boolean {
  const isins = new Set<string>();
  for (const r of rows) {
    if (r.fundo_cnpj !== fundoCnpj) continue;
    const isin = r.fundo_isin?.trim().toUpperCase();
    if (isin) isins.add(isin);
  }
  return isins.size <= 1;
}

function isRowFromSelectedClasse(
  row: PosicaoCarteiraRow,
  fundoIsin: string | null,
  fundoNome: string | null,
  classeUnica = false,
): boolean {
  const rowIsin = row.fundo_isin?.trim().toUpperCase() ?? null;
  const selectedIsin = fundoIsin?.trim().toUpperCase() ?? null;
  const rowNome = normalizeNomeFundo(row.nome_fundo ?? row.fundo_nome ?? null);
  const selectedNome = normalizeNomeFundo(fundoNome);

  if (selectedIsin) {
    if (rowIsin === selectedIsin) return true;
    // titpublico/titprivado costumam vir com fundo_isin null no XML.
    // Só inclui quando o CNPJ tem uma única classe (evita misturar JR/SR).
    if (!rowIsin && classeUnica) return true;
    return false;
  }

  if (selectedNome) return rowNome === selectedNome;

  return true;
}

function calcularMetricasFundo(
  fundoKey: string,
  serie: SnapshotFundo[],
  dataRef: string,
  cdiDict: Record<string, number>,
): RentabilidadeFundoRow | null {
  const serieLimpa = dedupSnapshots(serie);
  const hoje = encontrarSnapshotExato(serieLimpa, dataRef);
  if (!hoje) return null;

  const ontem = encontrarDiaUtilAnterior(serieLimpa, dataRef);
  const cotaBase = serieLimpa[0]?.valor_cota ?? null;

  const retornoDia = calcRetornoDia(
    hoje.valor_cota,
    ontem?.valor_cota ?? null,
  );
  const retornoAcum =
    cotaBase != null ? calcRetornoAcum(hoje.valor_cota, cotaBase) : null;
  const retornoMes = calcRetornoMes(serieLimpa, dataRef);
  const retornoAno = calcRetornoAno(serieLimpa, dataRef);
  const retornoSem = calcRetornoSemestral(serieLimpa, dataRef);
  const retorno12m = calcRetorno12M(serieLimpa, dataRef);

  const cdiDecimal = cdiDict[dataRef] ?? null;
  const cdiDiaPct = cdiDecimal != null ? cdiDecimalToPct(cdiDecimal) : null;
  const cdiMesPct = calcCdiAcumuladoMes(cdiDict, dataRef);
  const cdiAnoPct = calcCdiAcumuladoAno(cdiDict, dataRef);

  const fidc = isFundoFidc(hoje.nome_fundo);

  const cdi12mPct = calcCdiAcumulado12M(cdiDict, dataRef);
  const vsCdiDia = calcMetricasVsCDI(retornoDia, cdiDiaPct, 252);
  const vsCdiMes = calcMetricasVsCDI(retornoMes, cdiMesPct, 12);
  const vsCdiAno = calcMetricasVsCDI(retornoAno, cdiAnoPct, 1);
  const vsCdi12m = calcMetricasVsCDI(retorno12m, cdi12mPct, 1);

  return atualizarComparativosCdi({
    fundo_key: fundoKey,
    fundo_cnpj: hoje.fundo_cnpj,
    fundo_isin: hoje.fundo_isin,
    nome_fundo: hoje.nome_fundo,
    data_posicao: dataRef,
    valor_cota: hoje.valor_cota,
    pl: hoje.pl,
    quantidade: hoje.quantidade,
    retorno_dia_pct: retornoDia,
    retorno_acum_pct: retornoAcum,
    retorno_mes_pct: retornoMes,
    retorno_ano_pct: retornoAno,
    retorno_sem_pct: retornoSem,
    retorno_12m_pct: retorno12m,
    cdi_dia_pct: cdiDiaPct,
    cdi_mes_pct: cdiMesPct,
    cdi_ano_pct: cdiAnoPct,
    pct_cdi: vsCdiDia.pct_cdi,
    cdi_plus_dia_pct: vsCdiDia.cdi_plus_pct,
    cdi_plus_aa_pct: vsCdiDia.cdi_plus_aa_pct,
    pct_cdi_mes: vsCdiMes.pct_cdi,
    cdi_plus_mes_pct: vsCdiMes.cdi_plus_pct,
    cdi_plus_aa_mes_pct: vsCdiMes.cdi_plus_aa_pct,
    pct_cdi_ano: vsCdiAno.pct_cdi,
    cdi_plus_ano_pct: vsCdiAno.cdi_plus_pct,
    cdi_plus_aa_ano_pct: vsCdiAno.cdi_plus_aa_pct,
    cdi_12m_pct: cdi12mPct,
    pct_cdi_12m: vsCdi12m.pct_cdi,
    cdi_plus_12m_pct: vsCdi12m.cdi_plus_pct,
    cdi_plus_aa_12m_pct: vsCdi12m.cdi_plus_aa_pct,
    is_fidc: fidc,
    administrador: hoje.administrador,
  }, cdiDict);
}

function mapSnapshotDbRowsToFundos(rows: RentabilidadeSnapshotDbRow[]): RentabilidadeFundoRow[] {
  const fundos = rows.map((r) => ({
    fundo_key: r.fundo_key,
    fundo_cnpj: r.fundo_cnpj,
    fundo_isin: r.fundo_isin,
    nome_fundo: r.nome_fundo,
    data_posicao: r.data_posicao,
    valor_cota: r.valor_cota ?? 0,
    pl: r.pl ?? 0,
    quantidade: r.quantidade,
    retorno_dia_pct: r.retorno_dia_pct,
    retorno_acum_pct: r.retorno_acum_pct,
    retorno_mes_pct: r.retorno_mes_pct,
    retorno_ano_pct: r.retorno_ano_pct,
    retorno_sem_pct: r.retorno_sem_pct,
    retorno_12m_pct: r.retorno_12m_pct,
    cdi_dia_pct: r.cdi_dia_pct,
    cdi_mes_pct: r.cdi_mes_pct,
    cdi_ano_pct: r.cdi_ano_pct,
    pct_cdi: r.pct_cdi,
    cdi_plus_dia_pct: r.cdi_plus_dia_pct,
    cdi_plus_aa_pct: r.cdi_plus_aa_pct,
    pct_cdi_mes: r.pct_cdi_mes,
    cdi_plus_mes_pct: r.cdi_plus_mes_pct,
    cdi_plus_aa_mes_pct: r.cdi_plus_aa_mes_pct,
    pct_cdi_ano: r.pct_cdi_ano,
    cdi_plus_ano_pct: r.cdi_plus_ano_pct,
    cdi_plus_aa_ano_pct: r.cdi_plus_aa_ano_pct,
    cdi_12m_pct: r.cdi_12m_pct,
    pct_cdi_12m: r.pct_cdi_12m,
    cdi_plus_12m_pct: r.cdi_plus_12m_pct,
    cdi_plus_aa_12m_pct: r.cdi_plus_aa_12m_pct,
    is_fidc: !!r.is_fidc,
    administrador: r.administrador,
  }));

  fundos.sort((a, b) =>
    (a.nome_fundo ?? a.fundo_cnpj).localeCompare(
      b.nome_fundo ?? b.fundo_cnpj,
      "pt-BR",
    ),
  );
  return fundos;
}

async function fetchPersistedSnapshotFundos(dataRef: string): Promise<{
  fundos: RentabilidadeFundoRow[];
  status: RentabilidadeSnapshotStatusRow | null;
}> {
  const [{ data: snapshotRows, error: snapshotError }, { data: statusRows, error: statusError }] =
    await Promise.all([
      (supabase as any)
        .from("rentabilidade_snapshot_fundo")
        .select("*")
        .eq("data_posicao", dataRef),
      (supabase as any)
        .from("rentabilidade_snapshot_status")
        .select("*")
        .eq("data_referencia", dataRef)
        .limit(1),
    ]);

  if (snapshotError || statusError) {
    const firstErr = snapshotError ?? statusError;
    if (isMissingSnapshotInfraError(firstErr)) {
      return { fundos: [], status: null };
    }
    throw firstErr;
  }

  const fundos = mapSnapshotDbRowsToFundos((snapshotRows ?? []) as RentabilidadeSnapshotDbRow[]);
  const status = ((statusRows ?? [])[0] ?? null) as RentabilidadeSnapshotStatusRow | null;

  return { fundos, status };
}

async function computeFundosOnDemand(
  dataRef: string,
  dataMinYyyymmdd: string,
  dataMaxYyyymmdd: string,
  cdiDictInput?: Record<string, number>,
): Promise<{ fundos: RentabilidadeFundoRow[]; snapshots: SnapshotFundo[] }> {
  const [gestoresSet, rows, cdiDict] = await Promise.all([
    fetchGestoresSet(),
    fetchSnapshotsPaginado(dataMinYyyymmdd, dataMaxYyyymmdd),
    cdiDictInput ? Promise.resolve(cdiDictInput) : fetchCdiRange(yyyymmddToIso(dataMinYyyymmdd), dataRef),
  ]);

  const filteredRows = gestoresSet.size > 0
    ? rows.filter((r) => {
        const gestor = normalizeCnpjDigits((r as any).fundo_cnpjgestor);
        return gestor ? gestoresSet.has(gestor) : false;
      })
    : rows;

  const snapshots = rowsToSnapshots(filteredRows);
  const porFundo = agruparSnapshotsPorFundo(snapshots);
  const fundos: RentabilidadeFundoRow[] = [];

  for (const [fundoKey, serie] of porFundo) {
    const row = calcularMetricasFundo(fundoKey, serie, dataRef, cdiDict);
    if (row) fundos.push(row);
  }

  fundos.sort((a, b) =>
    (a.nome_fundo ?? a.fundo_cnpj).localeCompare(
      b.nome_fundo ?? b.fundo_cnpj,
      "pt-BR",
    ),
  );

  return { fundos, snapshots };
}

async function persistRentabilidadeSnapshotFundos(
  dataRef: string,
  fundos: RentabilidadeFundoRow[],
): Promise<number> {
  const payload = fundos.map((f) => ({
    fundo_key: f.fundo_key,
    fundo_cnpj: f.fundo_cnpj,
    fundo_isin: f.fundo_isin,
    nome_fundo: f.nome_fundo,
    valor_cota: f.valor_cota,
    pl: f.pl,
    quantidade: f.quantidade,
    retorno_dia_pct: f.retorno_dia_pct,
    retorno_acum_pct: f.retorno_acum_pct,
    retorno_mes_pct: f.retorno_mes_pct,
    retorno_ano_pct: f.retorno_ano_pct,
    retorno_sem_pct: f.retorno_sem_pct,
    retorno_12m_pct: f.retorno_12m_pct,
    cdi_dia_pct: f.cdi_dia_pct,
    cdi_mes_pct: f.cdi_mes_pct,
    cdi_ano_pct: f.cdi_ano_pct,
    pct_cdi: f.pct_cdi,
    cdi_plus_dia_pct: f.cdi_plus_dia_pct,
    cdi_plus_aa_pct: f.cdi_plus_aa_pct,
    pct_cdi_mes: f.pct_cdi_mes,
    cdi_plus_mes_pct: f.cdi_plus_mes_pct,
    cdi_plus_aa_mes_pct: f.cdi_plus_aa_mes_pct,
    pct_cdi_ano: f.pct_cdi_ano,
    cdi_plus_ano_pct: f.cdi_plus_ano_pct,
    cdi_plus_aa_ano_pct: f.cdi_plus_aa_ano_pct,
    cdi_12m_pct: f.cdi_12m_pct,
    pct_cdi_12m: f.pct_cdi_12m,
    cdi_plus_12m_pct: f.cdi_plus_12m_pct,
    cdi_plus_aa_12m_pct: f.cdi_plus_aa_12m_pct,
    is_fidc: f.is_fidc,
    administrador: f.administrador,
  }));

  const { data, error } = await (supabase as any).rpc("upsert_rentabilidade_snapshot_fundos", {
    p_data_referencia: dataRef,
    p_rows: payload,
    p_source: "ui_refresh",
    p_calc_version: RENTABILIDADE_SNAPSHOT_CALC_VERSION,
  });
  if (error) {
    if (isMissingSnapshotInfraError(error)) return 0;
    throw error;
  }
  return Number(data ?? 0);
}

async function startSnapshotJob(
  dataRef: string,
  metadata: Record<string, unknown>,
): Promise<string | null> {
  const { data, error } = await (supabase as any).rpc("start_rentabilidade_snapshot_job", {
    p_data_referencia: dataRef,
    p_source: "ui_refresh",
    p_calc_version: RENTABILIDADE_SNAPSHOT_CALC_VERSION,
    p_metadata: metadata,
  });
  if (error) {
    if (isMissingSnapshotInfraError(error)) return null;
    throw error;
  }
  return data ? String(data) : null;
}

async function finishSnapshotJob(
  jobId: string | null,
  status: "success" | "error",
  rowsPersisted: number | null,
  errorMessage: string | null,
): Promise<void> {
  if (!jobId) return;
  const { error } = await (supabase as any).rpc("finish_rentabilidade_snapshot_job", {
    p_job_id: jobId,
    p_status: status,
    p_rows_persisted: rowsPersisted,
    p_error_message: errorMessage,
  });
  if (error && !isMissingSnapshotInfraError(error)) {
    throw error;
  }
}

export function useRentabilidadeDatas() {
  return useQuery({
    queryKey: ["rentabilidade-datas"],
    queryFn: async () => {
      const dates = await fetchPosicaoAvailableDates();
      return dates.map(yyyymmddToIso);
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useRentabilidadeFundos(dataRef: string | null) {
  const dataMin = dataRef ? subtractDaysIso(dataRef, HISTORICO_DIAS) : null;
  const dataMinYyyymmdd = dataMin ? isoToYyyymmdd(dataMin) : null;
  const dataMaxYyyymmdd = dataRef ? isoToYyyymmdd(dataRef) : null;

  const { cdiDict, isLoading: cdiLoading, error: cdiError, refetch: refetchCdi } = useCDI(
    dataMin ?? "",
    dataRef ?? "",
  );

  const snapshotCacheQuery = useQuery({
    queryKey: ["rentabilidade-snapshot-cache", dataRef],
    queryFn: () => fetchPersistedSnapshotFundos(dataRef!),
    enabled: !!dataRef,
    staleTime: 60 * 1000,
  });

  const hasPersistedRows = (snapshotCacheQuery.data?.fundos.length ?? 0) > 0;

  const snapshotsQuery = useQuery({
    queryKey: ["rentabilidade-snapshots", dataMinYyyymmdd, dataMaxYyyymmdd],
    queryFn: async () => {
      const [gestoresSet, rows] = await Promise.all([
        fetchGestoresSet(),
        fetchSnapshotsPaginado(dataMinYyyymmdd!, dataMaxYyyymmdd!),
      ]);
      const filteredRows = gestoresSet.size > 0
        ? rows.filter((r) => {
            const gestor = normalizeCnpjDigits((r as any).fundo_cnpjgestor);
            return gestor ? gestoresSet.has(gestor) : false;
          })
        : rows;
      return rowsToSnapshots(filteredRows);
    },
    enabled: !!dataRef && !!dataMinYyyymmdd && !!dataMaxYyyymmdd
      && snapshotCacheQuery.isSuccess && !hasPersistedRows,
    staleTime: 5 * 60 * 1000,
  });

  const snapshots = hasPersistedRows ? [] : (snapshotsQuery.data ?? []);
  const porFundo = hasPersistedRows
    ? new Map<string, SnapshotFundo[]>()
    : agruparSnapshotsPorFundo(snapshots);
  const fundosCalculados: RentabilidadeFundoRow[] = [];

  if (dataRef && !hasPersistedRows) {
    for (const [fundoKey, serie] of porFundo) {
      const row = calcularMetricasFundo(fundoKey, serie, dataRef, cdiDict);
      if (row) fundosCalculados.push(row);
    }
    fundosCalculados.sort((a, b) =>
      (a.nome_fundo ?? a.fundo_cnpj).localeCompare(
        b.nome_fundo ?? b.fundo_cnpj,
        "pt-BR",
      ),
    );
  }

  const fundosBase = hasPersistedRows
    ? (snapshotCacheQuery.data?.fundos ?? [])
    : fundosCalculados;
  const fundos = useMemo(
    () => fundosBase.map((fundo) => atualizarComparativosCdi(fundo, cdiDict)),
    [fundosBase, cdiDict],
  );

  return {
    fundos,
    /** Snapshots brutos (560 dias) — use para computar cobertura XML com a mesma janela da grade. */
    snapshots,
    source: hasPersistedRows ? "snapshot" : "on_demand",
    cdiDisponivel: !!dataRef && Number.isFinite(cdiDict[dataRef]),
    snapshotStatus: snapshotCacheQuery.data?.status ?? null,
    isLoading: snapshotCacheQuery.isLoading || (!hasPersistedRows && snapshotsQuery.isLoading) || cdiLoading,
    error: snapshotCacheQuery.error ?? (!hasPersistedRows ? snapshotsQuery.error : null) ?? cdiError,
    refetch: async () => {
      if (!dataRef) return null;
      const [cdiResult, cacheResult] = await Promise.all([
        refetchCdi(),
        snapshotCacheQuery.refetch(),
      ]);
      if (cdiResult.error) return cdiResult;
      if (cacheResult.error || cacheResult.data?.fundos.length) return cacheResult;
      // A leitura manual ignora `enabled`: só buscar o histórico quando necessário.
      return snapshotsQuery.refetch();
    },
    rebuildSnapshot: async () => {
      if (!dataRef || !dataMin || !dataMinYyyymmdd || !dataMaxYyyymmdd) {
        return { persistedCount: 0, totalFundos: 0 };
      }
      let jobId: string | null = null;
      try {
        jobId = await startSnapshotJob(dataRef, {
          trigger: "ui_refresh",
          data_min: dataMin,
          data_max: dataRef,
        });
        const cdiFresh = await fetchCdiRange(dataMin, dataRef);
        const live = await computeFundosOnDemand(
          dataRef,
          dataMinYyyymmdd,
          dataMaxYyyymmdd,
          cdiFresh,
        );
        const persistedCount = await persistRentabilidadeSnapshotFundos(
          dataRef,
          live.fundos,
        );
        await finishSnapshotJob(jobId, "success", persistedCount, null);
        await snapshotCacheQuery.refetch();
        return { persistedCount, totalFundos: live.fundos.length };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await finishSnapshotJob(jobId, "error", null, msg);
        throw error;
      }
    },
  };
}

/**
 * Retorna todos os fundos que possuem snapshot na dataMax (ou na última data
 * disponível ≤ dataMax se não houver na dataMax exata). Busca histórico de 560
 * dias para calcular métricas. Usado na aba "Resumo Fundos" do Excel.
 * 
 * IMPORTANTE: Agrupa APENAS por CNPJ (ignora ISIN e nome) para evitar duplicatas
 * quando um fundo muda de nome/administrador. Cada CNPJ aparece apenas 1 vez
 * com os dados da sua última posição disponível.
 */
export async function fetchRentabilidadeFundosUltimaData(
  dataMax: string,
): Promise<RentabilidadeFundoRow[]> {
  const dataMin = subtractDaysIso(dataMax, HISTORICO_DIAS);
  const dataMinYyyymmdd = isoToYyyymmdd(dataMin);
  const dataMaxYyyymmdd = isoToYyyymmdd(dataMax);

  const [gestoresSet, rows, cdiDict] = await Promise.all([
    fetchGestoresSet(),
    fetchSnapshotsPaginado(dataMinYyyymmdd, dataMaxYyyymmdd),
    fetchCdiRange(dataMin, dataMax),
  ]);

  const filteredRows = gestoresSet.size > 0
    ? rows.filter((r) => {
        const gestor = normalizeCnpjDigits((r as any).fundo_cnpjgestor);
        return gestor ? gestoresSet.has(gestor) : false;
      })
    : rows;
  const snapshots = rowsToSnapshots(filteredRows);
  
  // Agrupa APENAS por CNPJ (sem ISIN, sem nome) para aba Resumo Fundos
  // Isso garante que fundos que mudaram de nome/admin apareçam apenas 1 vez
  const porCnpj = new Map<string, SnapshotFundo[]>();
  for (const s of snapshots) {
    const list = porCnpj.get(s.fundo_cnpj) ?? [];
    list.push(s);
    porCnpj.set(s.fundo_cnpj, list);
  }
  
  // Ordena cada série por data
  for (const [, list] of porCnpj) {
    list.sort((a, b) => a.data_posicao.localeCompare(b.data_posicao));
  }
  
  const fundos: RentabilidadeFundoRow[] = [];

  for (const [cnpj, serie] of porCnpj) {
    // Filtra apenas snapshots até dataMax e pega o mais recente
    const snapshotsAteDataMax = serie.filter(s => s.data_posicao <= dataMax);
    if (snapshotsAteDataMax.length === 0) continue;
    
    const ultimaData = snapshotsAteDataMax[snapshotsAteDataMax.length - 1].data_posicao;
    
    // Usa CNPJ como chave para calcular métricas
    const row = calcularMetricasFundo(cnpj, serie, ultimaData, cdiDict);
    if (row) fundos.push(row);
  }

  fundos.sort((a, b) => (b.pl ?? 0) - (a.pl ?? 0));
  return fundos;
}

/**
 * Consolida fundos já calculados na data de referência em uma linha por CNPJ.
 * Quando há classes distintas (JR/SR) no mesmo dia, mantém a de maior PL.
 * Usado na aba "Resumo Fundos" do Excel — alinhado à data selecionada na tela.
 */
export function consolidateFundosPorCnpj(
  fundos: RentabilidadeFundoRow[],
): RentabilidadeFundoRow[] {
  const porCnpj = new Map<string, RentabilidadeFundoRow>();
  for (const f of fundos) {
    const existing = porCnpj.get(f.fundo_cnpj);
    if (!existing || (f.pl ?? 0) > (existing.pl ?? 0)) {
      porCnpj.set(f.fundo_cnpj, f);
    }
  }
  const result = [...porCnpj.values()];
  result.sort((a, b) => (b.pl ?? 0) - (a.pl ?? 0));
  return result;
}

async function fetchAtivosFundo(
  fundoCnpj: string,
  fundoIsin: string | null,
  fundoNome: string | null,
  dataRef: string,
): Promise<PosicaoAtivo[]> {
  const dt = isoToYyyymmdd(dataRef);
  const { data, error } = await supabase
    .from("posicao_carteira")
    .select(
      "fundo_cnpj, fundo_isin, fundo_dtposicao, fundo_nome, nome_fundo, section, cnpjfundo, cnpjemissor, cnpjpart, cnpjemp, qtdisponivel, puposicao, isin, codativo, nomecomercial, matricula, logradouro, numero, valor_padrao, valorcontabil, dtemissao, dtvencimento, ativos(cnpj, isin, tipo_ativo, nome_frontend, descricao)",
    )
    .eq("fundo_cnpj", fundoCnpj)
    .eq("fundo_dtposicao", dt)
    .in("section", [...SECTIONS_ATIVOS_RENTABILIDADE]);

  if (error) throw error;

  const rows = (data ?? []) as PosicaoCarteiraRow[];
  const classeUnica = cnpjTemClasseUnica(rows, fundoCnpj);
  const rowsClasse = rows.filter((r) =>
    isRowFromSelectedClasse(r, fundoIsin, fundoNome, classeUnica),
  );
  // Fallback para "todos do CNPJ" só quando a classe não tem ISIN.
  // Se tem ISIN (ex.: SR/JR), jamais mistura com outras classes.
  const scopedRows =
    rowsClasse.length > 0 || fundoIsin
      ? rowsClasse
      : rows;

  const cnpjsAtivos = scopedRows
    .flatMap((r) => {
      const section = (r.section || "").toLowerCase();
      if (section === "cotas") return [r.cnpjfundo?.replace(/\D/g, "")];
      if (section === "participacoes") {
        return [r.cnpjpart?.replace(/\D/g, ""), r.cnpjemissor?.replace(/\D/g, "")];
      }
      return [r.cnpjemissor?.replace(/\D/g, ""), r.cnpjemp?.replace(/\D/g, "")];
    })
    .filter(Boolean) as string[];
  const isinsAtivos = scopedRows
    .map((r) => isinUtilizavel(r.isin))
    .filter(Boolean) as string[];

  const [nomesAnbima, nomesFrontend] = await Promise.all([
    fetchNomesFundos(cnpjsAtivos, isinsAtivos),
    fetchNomesAtivosFrontend(cnpjsAtivos, isinsAtivos),
  ]);
  const nomesMap = mergeNomesAtivos(nomesAnbima, nomesFrontend);

  return scopedRows
    .map((r) => mapPosicaoToAtivo(r, nomesMap))
    .filter((a): a is PosicaoAtivo => a != null);
}

/** Agrega linhas duplicadas do mesmo ativo (soma qtd, PU médio ponderado). */
function agregarAtivosPorChave(ativos: PosicaoAtivo[]): PosicaoAtivo[] {
  const map = new Map<
    string,
    PosicaoAtivo & { _qtAcum: number; _puPonderado: number }
  >();

  for (const a of ativos) {
    const key = a.ativo_key;
    const qt = a.qt_disponivel ?? 0;
    const pu = a.pu_posicao ?? 0;
    const existente = map.get(key);

    if (!existente) {
      map.set(key, {
        ...a,
        _qtAcum: qt,
        _puPonderado: pu * qt,
      });
      continue;
    }

    existente._qtAcum += qt;
    existente._puPonderado += pu * qt;
    existente.qt_disponivel = existente._qtAcum;
    existente.pu_posicao =
      existente._qtAcum > 0
        ? existente._puPonderado / existente._qtAcum
        : existente.pu_posicao;
  }

  const agregados = [...map.values()].map(({ _qtAcum, _puPonderado, ...a }) => a);
  return deduplicarCotasPorCnpj(agregados);
}

async function fetchAtivosFundoAgregados(
  fundoCnpj: string,
  fundoIsin: string | null,
  fundoNome: string | null,
  dataRef: string,
): Promise<PosicaoAtivo[]> {
  const ativos = await fetchAtivosFundo(
    fundoCnpj,
    fundoIsin,
    fundoNome,
    dataRef,
  );
  return agregarAtivosPorChave(ativos);
}

export async function fetchHistoricoPuFundos(
  fundoCnpj: string,
  fundoIsin: string | null,
  fundoNome: string | null,
  dataMax: string,
): Promise<
  Array<{
    ativo_key: string;
    data_posicao: string;
    pu_posicao: number;
    qt: number;
  }>
> {
  const dataMin = subtractDaysIso(dataMax, HISTORICO_DIAS);
  const dataMinYyyymmdd = isoToYyyymmdd(dataMin);
  const dataMaxYyyymmdd = isoToYyyymmdd(dataMax);
  const selectCols =
    "fundo_cnpj, fundo_isin, nome_fundo, fundo_nome, fundo_dtposicao, section, cnpjfundo, cnpjemissor, cnpjpart, cnpjemp, isin, codativo, nomecomercial, matricula, logradouro, numero, dtemissao, dtvencimento, puposicao, qtdisponivel, valor_padrao, valorcontabil";

  let all: PosicaoCarteiraRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("posicao_carteira")
      .select(selectCols)
      .eq("fundo_cnpj", fundoCnpj)
      .in("section", [...SECTIONS_ATIVOS_RENTABILIDADE])
      .gte("fundo_dtposicao", dataMinYyyymmdd)
      .lte("fundo_dtposicao", dataMaxYyyymmdd)
      .order("fundo_dtposicao", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    if (!data?.length) break;

    all = all.concat(data as PosicaoCarteiraRow[]);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  const classeUnica = cnpjTemClasseUnica(all, fundoCnpj);
  const scopedAll = all.filter((r) =>
    isRowFromSelectedClasse(r, fundoIsin, fundoNome, classeUnica),
  );
  // Fallback para "todos do CNPJ" só quando a classe não tem ISIN.
  const source =
    scopedAll.length > 0 || fundoIsin
      ? scopedAll
      : all;

  const historico = source
    .map((r) => {
      const row = r as PosicaoCarteiraRow;
      const { pu, qt } = resolvePuQtFromRow(row);
      if (pu == null || pu <= 0) return null;
      return {
        ativo_key: getAtivoKeyFromRow(row),
        data_posicao: yyyymmddToIso(row.fundo_dtposicao),
        pu_posicao: pu,
        qt: qt ?? 1,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  return consolidarHistoricoPuCotas(historico);
}

/** Histórico de cota do fundo (gráfico detalhe), com alias de ISIN no lote. */
export async function fetchSnapshotsFundoClasse(
  fundoCnpj: string,
  fundoIsin: string | null,
  fundoNome: string | null,
  dataMax: string,
): Promise<Array<{ data_posicao: string; valor_cota: number }>> {
  const dataMin = subtractDaysIso(dataMax, HISTORICO_DIAS);
  const { data, error } = await supabase
    .from("posicao_carteira")
    .select(
      "fundo_cnpj, fundo_isin, nome_fundo, fundo_nome, fundo_dtposicao, fundo_valorcota, fundo_patliq, fundo_valorativos, fundo_quantidade, section",
    )
    .eq("fundo_cnpj", fundoCnpj)
    .in("section", ["caixa", "despesas"])
    .gte("fundo_dtposicao", isoToYyyymmdd(dataMin))
    .lte("fundo_dtposicao", isoToYyyymmdd(dataMax))
    .not("fundo_valorcota", "is", null)
    .order("fundo_dtposicao", { ascending: true });

  if (error) throw error;

  const snapshots = ((data ?? []) as PosicaoCarteiraRow[])
    .map(mapPosicaoToSnapshot)
    .filter((s): s is SnapshotFundo => s != null);

  const filtered = filterSnapshotsForClasse(
    snapshots,
    fundoCnpj,
    fundoIsin,
    fundoNome,
  );

  const porData = new Map<string, number>();
  for (const s of filtered) {
    porData.set(s.data_posicao, s.valor_cota);
  }

  return Array.from(porData.entries())
    .map(([data_posicao, valor_cota]) => ({ data_posicao, valor_cota }))
    .sort((a, b) => a.data_posicao.localeCompare(b.data_posicao));
}

/** Busca ativos de um fundo com métricas calculadas (uso fora de hooks React). */
export async function fetchRentabilidadeAtivosForFundo(
  fundoCnpj: string,
  fundoIsin: string | null,
  fundoNome: string | null,
  dataRef: string,
  plFundo: number | null,
  cdiDict: Record<string, number>,
): Promise<RentabilidadeAtivoRow[]> {
  const [ativos, historicoPu] = await Promise.all([
    fetchAtivosFundoAgregados(
      fundoCnpj,
      fundoIsin,
      fundoNome,
      dataRef,
    ),
    fetchHistoricoPuFundos(
      fundoCnpj,
      fundoIsin,
      fundoNome,
      dataRef,
    ),
  ]);

  const cdiDiaPct =
    cdiDict[dataRef] != null ? cdiDecimalToPct(cdiDict[dataRef]) : null;
  const cdiMesPct = cdiDiaPct != null ? calcCdiAcumuladoMes(cdiDict, dataRef) : null;
  const cdiAnoPct = cdiDiaPct != null ? calcCdiAcumuladoAno(cdiDict, dataRef) : null;
  const cdi12mPct = cdiDiaPct != null ? calcCdiAcumulado12M(cdiDict, dataRef) : null;

  const rows: RentabilidadeAtivoRow[] = [];

  for (const ativo of ativos) {
    const qt = ativo.qt_disponivel ?? 0;
    const pu = ativo.pu_posicao ?? 0;
    const vlMercado = qt * pu;
    const percPl =
      plFundo && plFundo > 0 ? calcPercPL(qt, pu, plFundo) : null;

    const ativoKey = ativo.ativo_key;
    const keyAliases = new Set(
      expandAtivoKeyAliases(ativoKey, ativo.isin_ativo),
    );
    const serieAtivo = historicoPu
      .filter((p) => keyAliases.has(p.ativo_key))
      .map((p) => ({
        data_posicao: p.data_posicao,
        pu_posicao: p.pu_posicao,
        qt: p.qt,
      }));
    const varPu = calcVarPUAtivo(serieAtivo, dataRef);
    const varPuMes = calcVarPUMes(serieAtivo, dataRef);
    const varPuAno = calcVarPUAno(serieAtivo, dataRef);
    const varPu12m = calcVarPU12M(serieAtivo, dataRef);

    const vsCdiDia =
      varPu != null && isVarPuPlausivel(varPu)
        ? calcMetricasVsCDI(varPu, cdiDiaPct, 252)
        : { pct_cdi: null, cdi_plus_pct: null, cdi_plus_aa_pct: null };
    const vsCdiMes = calcMetricasVsCDI(varPuMes, cdiMesPct, 12);
    const vsCdiAno = calcMetricasVsCDI(varPuAno, cdiAnoPct, 1);
    const vsCdi12m = calcMetricasVsCDI(varPu12m, cdi12mPct, 1);

    const fidcAtivo = isFundoFidc(ativo.nome_exibicao);

    rows.push({
      ativo_key: ativo.ativo_key,
      section: ativo.section,
      cnpj_ativo: ativo.cnpj_ativo,
      isin_ativo: ativo.isin_ativo ?? null,
      nome_ativo: ativo.nome_ativo ?? null,
      nome_exibicao: ativo.nome_exibicao,
      qt_disponivel: ativo.qt_disponivel,
      pu_posicao: ativo.pu_posicao,
      vl_mercado: vlMercado > 0 ? vlMercado : null,
      perc_pl_pct: percPl,
      var_pu_pct: varPu,
      var_pu_mes_pct: varPuMes,
      var_pu_ano_pct: varPuAno,
      var_pu_12m_pct: varPu12m,
      pct_cdi: vsCdiDia.pct_cdi,
      cdi_plus_dia_pct: vsCdiDia.cdi_plus_pct,
      cdi_plus_aa_pct: vsCdiDia.cdi_plus_aa_pct,
      pct_cdi_mes: vsCdiMes.pct_cdi,
      cdi_plus_mes_pct: vsCdiMes.cdi_plus_pct,
      cdi_plus_aa_mes_pct: vsCdiMes.cdi_plus_aa_pct,
      pct_cdi_ano: vsCdiAno.pct_cdi,
      cdi_plus_ano_pct: vsCdiAno.cdi_plus_pct,
      cdi_plus_aa_ano_pct: vsCdiAno.cdi_plus_aa_pct,
      pct_cdi_12m: vsCdi12m.pct_cdi,
      cdi_plus_12m_pct: vsCdi12m.cdi_plus_pct,
      cdi_plus_aa_12m_pct: vsCdi12m.cdi_plus_aa_pct,
      is_fidc: fidcAtivo,
    });
  }

  rows.sort((a, b) => (b.perc_pl_pct ?? 0) - (a.perc_pl_pct ?? 0));
  return rows;
}

export type FundoUniversoXmlRow = FundoXmlCoverageRow;

const HEADER_SNAPSHOT_SELECT =
  "fundo_cnpj, fundo_isin, nome_fundo, fundo_nome, fundo_nomeadm, fundo_cnpjgestor, fundo_dtposicao, fundo_valorcota, fundo_patliq, fundo_valorativos, fundo_quantidade, section";

/** Header XML (caixa/despesas) no intervalo [dataMin, dataMax] (YYYYMMDD). */
async function fetchHeaderRowsNoIntervalo(
  dataMinYyyymmdd: string,
  dataMaxYyyymmdd: string,
): Promise<PosicaoCarteiraRow[]> {
  let all: PosicaoCarteiraRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("posicao_carteira")
      .select(HEADER_SNAPSHOT_SELECT)
      .gte("fundo_dtposicao", dataMinYyyymmdd)
      .lte("fundo_dtposicao", dataMaxYyyymmdd)
      .in("section", ["caixa", "despesas"])
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    if (!data?.length) break;

    all = all.concat(data as PosicaoCarteiraRow[]);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return all;
}

/** Remove faltantes que já têm posição importada (RPC alinhada ao Enquadramento). */
function reconcileFaltantesComPares(
  faltantes: FundoXmlCoverageRow[],
  pares: ParFundoMonitorado[],
): FundoXmlCoverageRow[] {
  const normNome = (nome: string | null | undefined) =>
    (nome ?? "")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();

  return faltantes.filter((f) => {
    const cnpjNorm = normalizeCnpjDigits(f.cnpj_fundo);
    const nomeFal = normNome(f.nome_fundo);
    const isinFal = (f.fundo_isin ?? "").trim().toUpperCase();

    const importado = pares.some((p) => {
      if (normalizeCnpjDigits(p.fundo_cnpj) !== cnpjNorm) return false;
      const isinPar = (p.fundo_isin ?? "").trim().toUpperCase();
      if (isinPar && isinFal && isinPar === isinFal) return true;
      return nomeFal !== "" && normNome(p.nome_fundo) === nomeFal;
    });
    return !importado;
  });
}

/** Cobertura de XML na data: janela [dataRef−10d, dataRef], chaves com alias ISIN unificado. */
export function useFundosXmlCoverage(dataRef: string | null) {
  const dataMinAliasIso = dataRef
    ? subtractDaysIso(dataRef, COBERTURA_ALIAS_DIAS)
    : null;
  const dataMinAliasYyyymmdd = dataMinAliasIso
    ? isoToYyyymmdd(dataMinAliasIso)
    : null;
  const dataMaxYyyymmdd = dataRef ? isoToYyyymmdd(dataRef) : null;

  const query = useQuery({
    queryKey: ["fundos-xml-coverage", dataRef],
    queryFn: async () => {
      const [gestoresSet, rows] = await Promise.all([
        fetchGestoresSet(),
        fetchHeaderRowsNoIntervalo(dataMinAliasYyyymmdd!, dataMaxYyyymmdd!),
      ]);
      const filteredRows =
        gestoresSet.size > 0
          ? rows.filter((r) => {
              const gestor = normalizeCnpjDigits((r as PosicaoCarteiraRow).fundo_cnpjgestor);
              return gestor ? gestoresSet.has(gestor) : false;
            })
          : rows;
      const snapshots = rowsToSnapshots(filteredRows);
      const coverage = computeRentabilidadeXmlCoverage(snapshots, dataRef!);
      const pares = await fetchParesMonitorados(isoToYyyymmdd(dataRef!));
      const faltantes = reconcileFaltantesComPares(coverage.faltantes, pares);
      return {
        total: coverage.total,
        importados: coverage.total - faltantes.length,
        faltantes,
      };
    },
    enabled: !!dataRef && !!dataMinAliasYyyymmdd && !!dataMaxYyyymmdd,
    staleTime: 5 * 60 * 1000,
  });

  return {
    total: query.data?.total ?? 0,
    importados: query.data?.importados ?? 0,
    faltantes: query.data?.faltantes ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

/** @deprecated Use `useFundosXmlCoverage`. */
export const useRentabilidadeXmlCoverage = useFundosXmlCoverage;

export function useRentabilidadeAtivos(
  fundoCnpj: string | null,
  fundoIsin: string | null,
  fundoNome: string | null,
  dataRef: string | null,
  plFundo: number | null,
  cdiDict: Record<string, number>,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "rentabilidade-ativos",
      fundoCnpj,
      fundoIsin,
      fundoNome,
      dataRef,
    ],
    queryFn: () =>
      fetchRentabilidadeAtivosForFundo(
        fundoCnpj!,
        fundoIsin,
        fundoNome,
        dataRef!,
        plFundo,
        cdiDict,
      ),
    enabled: enabled && !!fundoCnpj && !!dataRef && plFundo != null,
    staleTime: 5 * 60 * 1000,
  });
}
