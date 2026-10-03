/**
 * Rebuild incremental de rentabilidade por fundo/classe e data.
 *
 * Diferente do envio antigo, esta funcao nao carrega 400/560 dias de cada
 * ativo. Ela descobre quatro datas-base do fundo e le somente essas cinco
 * posicoes: atual, dia anterior, fechamento do mes, fechamento do ano e 12M.
 *
 * O resultado e persistido e pode ser sobrescrito com seguranca quando um XML
 * da mesma classe/data for reimportado.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { CDI_CACHE_SOURCE, resolveCdiSnapshot, type CdiSnapshot } from "./cdiSnapshot.ts";
import {
  calcMetricasVsCDI,
  dedupSnapshots,
  fetchCdiRange,
  isFundoFidc,
  isoToYyyymmdd,
  mapPosicaoToSnapshot,
  subtractDaysIso,
  type PosicaoCarteiraHeaderRow,
  type SnapshotFundo,
} from "../send-rentabilidade-report-auto/calc.ts";
import {
  agregarAtivosPorChave,
  cnpjTemClasseUnica,
  expandAtivoKeyAliases,
  isRowFromSelectedClasse,
  isVarPuPlausivel,
  mapPosicaoToAtivo,
  type PosicaoAtivo,
  type PosicaoCarteiraRow,
  SECTIONS_ATIVOS_RENTABILIDADE,
} from "../send-rentabilidade-report-auto/ativosCalc.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CALC_VERSION = "rentabilidade_snapshot_v2";

const HEADER_SELECT =
  "fundo_cnpj, fundo_isin, fundo_dtposicao, fundo_valorcota, fundo_patliq, fundo_valorativos, fundo_quantidade, nome_fundo, fundo_nome, fundo_nomeadm, section";
const ATIVO_SELECT =
  "fundo_cnpj, fundo_isin, fundo_dtposicao, fundo_nome, nome_fundo, section, cnpjfundo, cnpjemissor, cnpjpart, cnpjemp, qtdisponivel, puposicao, isin, codativo, nomecomercial, matricula, logradouro, numero, valor_padrao, valorcontabil, dtemissao, dtvencimento";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RequestBody {
  fundo_cnpj?: string;
  fundo_isin?: string | null;
  fundo_nome?: string | null;
  data_referencia?: string;
  origem?: string;
  dry_run?: boolean;
}

interface ReferenceDates {
  atual: string;
  dia: string | null;
  mes: string | null;
  ano: string | null;
  dozeMeses: string | null;
}

interface AssetSnapshotPayload {
  fundo_isin: string | null;
  ativo_key: string;
  section: string;
  ativo_cnpjfundo: string | null;
  ativo_isin: string | null;
  cnpj_ativo: string | null;
  isin_ativo: string | null;
  nome_ativo: string | null;
  nome_exibicao: string;
  quantidade: number | null;
  pu_posicao: number | null;
  valor_mercado: number | null;
  perc_pl_pct: number | null;
  retorno_dia_pct: number | null;
  retorno_mes_pct: number | null;
  retorno_ano_pct: number | null;
  retorno_12m_pct: number | null;
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
  base_dia_data: string | null;
  base_mes_data: string | null;
  base_ano_data: string | null;
  base_12m_data: string | null;
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isIsoDate(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function normalizeIsin(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized || null;
}

function selectClassRows<T extends PosicaoCarteiraHeaderRow | PosicaoCarteiraRow>(
  rows: T[],
  fundoCnpj: string,
  fundoIsin: string | null,
  fundoNome: string | null,
): T[] {
  const classeUnica = cnpjTemClasseUnica(rows as PosicaoCarteiraRow[], fundoCnpj);
  return rows.filter((row) =>
    isRowFromSelectedClasse(row as PosicaoCarteiraRow, fundoIsin, fundoNome, classeUnica),
  );
}

function snapshotFromRows(rows: PosicaoCarteiraHeaderRow[]): SnapshotFundo | null {
  const snapshots = dedupSnapshots(
    rows.map(mapPosicaoToSnapshot).filter((row): row is SnapshotFundo => row != null),
  );
  return snapshots.sort((a, b) => b.data_posicao.localeCompare(a.data_posicao))[0] ?? null;
}

async function fetchHeaderAt(
  supabase: SupabaseClient,
  fundoCnpj: string,
  yyyymmdd: string,
): Promise<PosicaoCarteiraHeaderRow[]> {
  const { data, error } = await supabase
    .from("posicao_carteira")
    .select(HEADER_SELECT)
    .eq("fundo_cnpj", fundoCnpj)
    .eq("fundo_dtposicao", yyyymmdd)
    .in("section", ["caixa", "despesas"])
    .limit(500);
  if (error) throw new Error(`Falha ao buscar cabecalho em ${yyyymmdd}: ${error.message}`);
  return (data ?? []) as PosicaoCarteiraHeaderRow[];
}

async function fetchLatestHeaderBefore(
  supabase: SupabaseClient,
  fundoCnpj: string,
  beforeYyyymmdd: string,
): Promise<PosicaoCarteiraHeaderRow[]> {
  const { data, error } = await supabase
    .from("posicao_carteira")
    .select(HEADER_SELECT)
    .eq("fundo_cnpj", fundoCnpj)
    .lt("fundo_dtposicao", beforeYyyymmdd)
    .in("section", ["caixa", "despesas"])
    .order("fundo_dtposicao", { ascending: false })
    .limit(500);
  if (error) throw new Error(`Falha ao buscar base anterior: ${error.message}`);
  return (data ?? []) as PosicaoCarteiraHeaderRow[];
}

async function fetch12mCandidates(
  supabase: SupabaseClient,
  fundoCnpj: string,
  dataReferencia: string,
): Promise<PosicaoCarteiraHeaderRow[]> {
  const target = new Date(`${dataReferencia}T12:00:00`);
  target.setFullYear(target.getFullYear() - 1);
  const targetIso = target.toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("posicao_carteira")
    .select(HEADER_SELECT)
    .eq("fundo_cnpj", fundoCnpj)
    .gte("fundo_dtposicao", isoToYyyymmdd(subtractDaysIso(targetIso, 30)))
    .lte("fundo_dtposicao", isoToYyyymmdd(subtractDaysIso(targetIso, -30)))
    .in("section", ["caixa", "despesas"])
    .order("fundo_dtposicao", { ascending: true })
    .limit(1000);
  if (error) throw new Error(`Falha ao buscar base 12M: ${error.message}`);
  return (data ?? []) as PosicaoCarteiraHeaderRow[];
}

function closestSnapshotTo12m(
  rows: PosicaoCarteiraHeaderRow[],
  dataReferencia: string,
): SnapshotFundo | null {
  const target = new Date(`${dataReferencia}T12:00:00`);
  target.setFullYear(target.getFullYear() - 1);
  const targetMs = target.getTime();
  let winner: SnapshotFundo | null = null;
  let shortestDistance = Number.POSITIVE_INFINITY;
  for (const snapshot of dedupSnapshots(
    rows.map(mapPosicaoToSnapshot).filter((row): row is SnapshotFundo => row != null),
  )) {
    const distance = Math.abs(new Date(`${snapshot.data_posicao}T12:00:00`).getTime() - targetMs);
    if (distance < shortestDistance) {
      winner = snapshot;
      shortestDistance = distance;
    }
  }
  return winner;
}

async function resolveFundReferences(
  supabase: SupabaseClient,
  fundoCnpj: string,
  fundoIsin: string | null,
  fundoNome: string | null,
  dataReferencia: string,
): Promise<{ serie: SnapshotFundo[]; datas: ReferenceDates }> {
  const dataAtual = isoToYyyymmdd(dataReferencia);
  const inicioMes = `${dataReferencia.slice(0, 7)}-01`;
  const inicioAno = `${dataReferencia.slice(0, 4)}-01-01`;
  const [currentRows, dayRows, monthRows, yearRows, twelveMonthRows] = await Promise.all([
    fetchHeaderAt(supabase, fundoCnpj, dataAtual),
    fetchLatestHeaderBefore(supabase, fundoCnpj, dataAtual),
    fetchLatestHeaderBefore(supabase, fundoCnpj, isoToYyyymmdd(inicioMes)),
    fetchLatestHeaderBefore(supabase, fundoCnpj, isoToYyyymmdd(inicioAno)),
    fetch12mCandidates(supabase, fundoCnpj, dataReferencia),
  ]);

  const selectedRows = [currentRows, dayRows, monthRows, yearRows, twelveMonthRows].map((rows) =>
    selectClassRows(rows, fundoCnpj, fundoIsin, fundoNome),
  );
  const current = snapshotFromRows(selectedRows[0]);
  if (!current || current.data_posicao !== dataReferencia) {
    throw new Error(`Nao ha cota valida para ${fundoCnpj} em ${dataReferencia}`);
  }
  const day = snapshotFromRows(selectedRows[1]);
  const month = snapshotFromRows(selectedRows[2]);
  const year = snapshotFromRows(selectedRows[3]);
  const twelveMonths = closestSnapshotTo12m(selectedRows[4], dataReferencia);
  const serie = dedupSnapshots([current, day, month, year, twelveMonths].filter(
    (row): row is SnapshotFundo => row != null,
  ));

  return {
    serie,
    datas: {
      atual: current.data_posicao,
      dia: day?.data_posicao ?? null,
      mes: month?.data_posicao ?? null,
      ano: year?.data_posicao ?? null,
      dozeMeses: twelveMonths?.data_posicao ?? null,
    },
  };
}

async function fetchAssetRowsForDates(
  supabase: SupabaseClient,
  fundoCnpj: string,
  dates: string[],
): Promise<PosicaoCarteiraRow[]> {
  const yyyymmdd = [...new Set(dates.map(isoToYyyymmdd))];
  const { data, error } = await supabase
    .from("posicao_carteira")
    .select(ATIVO_SELECT)
    .eq("fundo_cnpj", fundoCnpj)
    .in("fundo_dtposicao", yyyymmdd)
    .in("section", [...SECTIONS_ATIVOS_RENTABILIDADE])
    .limit(20000);
  if (error) throw new Error(`Falha ao buscar posicoes dos ativos: ${error.message}`);
  return (data ?? []) as PosicaoCarteiraRow[];
}

function aggregateAssetsByDate(
  rows: PosicaoCarteiraRow[],
  fundoCnpj: string,
  fundoIsin: string | null,
  fundoNome: string | null,
): Map<string, Map<string, PosicaoAtivo>> {
  const scoped = selectClassRows(rows, fundoCnpj, fundoIsin, fundoNome);
  const byDate = new Map<string, PosicaoAtivo[]>();
  for (const row of scoped) {
    const asset = mapPosicaoToAtivo(row);
    if (!asset) continue;
    const list = byDate.get(asset.data_posicao) ?? [];
    list.push(asset);
    byDate.set(asset.data_posicao, list);
  }
  const result = new Map<string, Map<string, PosicaoAtivo>>();
  for (const [date, assets] of byDate) {
    result.set(date, new Map(agregarAtivosPorChave(assets).map((asset) => [asset.ativo_key, asset])));
  }
  return result;
}

function findAssetReference(
  assets: Map<string, PosicaoAtivo> | undefined,
  current: PosicaoAtivo,
): PosicaoAtivo | null {
  if (!assets) return null;
  for (const key of expandAtivoKeyAliases(current.ativo_key, current.isin_ativo)) {
    const match = assets.get(key);
    if (match) return match;
  }
  return null;
}

function calcReturn(current: number | null, base: number | null): number | null {
  if (current == null || base == null || base === 0) return null;
  return (current / base - 1) * 100;
}

async function getCdiSnapshot(
  supabase: SupabaseClient,
  dataReferencia: string,
): Promise<CdiSnapshot> {
  const { data: cached, error: cachedError } = await supabase
    .from("rentabilidade_snapshot_cdi")
    .select("cdi_dia_pct, cdi_mes_pct, cdi_ano_pct, cdi_12m_pct, source, calculated_at")
    .eq("data_posicao", dataReferencia)
    .maybeSingle();
  if (cachedError) throw new Error(`Falha ao consultar cache CDI: ${cachedError.message}`);
  return resolveCdiSnapshot(
    dataReferencia,
    cached,
    () => fetchCdiRange(subtractDaysIso(dataReferencia, 400), dataReferencia),
    async (snapshot) => {
      const { error: writeError } = await supabase.from("rentabilidade_snapshot_cdi").upsert({
        data_posicao: dataReferencia,
        cdi_dia_pct: snapshot.dia,
        cdi_mes_pct: snapshot.mes,
        cdi_ano_pct: snapshot.ano,
        cdi_12m_pct: snapshot.dozeMeses,
        source: CDI_CACHE_SOURCE,
        calculated_at: new Date().toISOString(),
      }, { onConflict: "data_posicao" });
      if (writeError) throw new Error(`Falha ao persistir cache CDI: ${writeError.message}`);
    },
  );
}

function makeAssetSnapshots(
  currentAssets: Map<string, PosicaoAtivo>,
  byDate: Map<string, Map<string, PosicaoAtivo>>,
  dates: ReferenceDates,
  fundoIsin: string | null,
  plFundo: number,
  cdi: CdiSnapshot,
): AssetSnapshotPayload[] {
  const dayAssets = dates.dia ? byDate.get(dates.dia) : undefined;
  const monthAssets = dates.mes ? byDate.get(dates.mes) : undefined;
  const yearAssets = dates.ano ? byDate.get(dates.ano) : undefined;
  const twelveMonthAssets = dates.dozeMeses ? byDate.get(dates.dozeMeses) : undefined;

  return [...currentAssets.values()].map((asset) => {
    const day = findAssetReference(dayAssets, asset);
    const month = findAssetReference(monthAssets, asset);
    const year = findAssetReference(yearAssets, asset);
    const twelveMonths = findAssetReference(twelveMonthAssets, asset);
    const retornoDia = calcReturn(asset.pu_posicao, day?.pu_posicao ?? null);
    const retornoMes = calcReturn(asset.pu_posicao, month?.pu_posicao ?? null);
    const retornoAno = calcReturn(asset.pu_posicao, year?.pu_posicao ?? null);
    const retorno12m = calcReturn(asset.pu_posicao, twelveMonths?.pu_posicao ?? null);
    const vsDia = isVarPuPlausivel(retornoDia)
      ? calcMetricasVsCDI(retornoDia, cdi.dia, 252)
      : { pct_cdi: null, cdi_plus_pct: null, cdi_plus_aa_pct: null };
    const vsMes = calcMetricasVsCDI(retornoMes, cdi.mes, 12);
    const vsAno = calcMetricasVsCDI(retornoAno, cdi.ano, 1);
    const vs12m = calcMetricasVsCDI(retorno12m, cdi.dozeMeses, 1);
    const quantidade = asset.qt_disponivel;
    const pu = asset.pu_posicao;
    const valorMercado = quantidade != null && pu != null ? quantidade * pu : null;

    return {
      fundo_isin: fundoIsin,
      ativo_key: asset.ativo_key,
      section: asset.section,
      ativo_cnpjfundo: asset.section === "cotas" ? asset.cnpj_ativo?.replace(/\D/g, "") || null : null,
      ativo_isin: asset.section === "cotas" ? asset.isin_ativo ?? null : null,
      cnpj_ativo: asset.cnpj_ativo,
      isin_ativo: asset.isin_ativo,
      nome_ativo: asset.nome_ativo ?? null,
      nome_exibicao: asset.nome_exibicao,
      quantidade,
      pu_posicao: pu,
      valor_mercado: valorMercado,
      perc_pl_pct: valorMercado != null && plFundo > 0 ? (valorMercado / plFundo) * 100 : null,
      retorno_dia_pct: retornoDia,
      retorno_mes_pct: retornoMes,
      retorno_ano_pct: retornoAno,
      retorno_12m_pct: retorno12m,
      pct_cdi: vsDia.pct_cdi,
      cdi_plus_dia_pct: vsDia.cdi_plus_pct,
      cdi_plus_aa_pct: vsDia.cdi_plus_aa_pct,
      pct_cdi_mes: vsMes.pct_cdi,
      cdi_plus_mes_pct: vsMes.cdi_plus_pct,
      cdi_plus_aa_mes_pct: vsMes.cdi_plus_aa_pct,
      pct_cdi_ano: vsAno.pct_cdi,
      cdi_plus_ano_pct: vsAno.cdi_plus_pct,
      cdi_plus_aa_ano_pct: vsAno.cdi_plus_aa_pct,
      pct_cdi_12m: vs12m.pct_cdi,
      cdi_plus_12m_pct: vs12m.cdi_plus_pct,
      cdi_plus_aa_12m_pct: vs12m.cdi_plus_aa_pct,
      is_fidc: isFundoFidc(asset.nome_exibicao),
      base_dia_data: day?.data_posicao ?? null,
      base_mes_data: month?.data_posicao ?? null,
      base_ano_data: year?.data_posicao ?? null,
      base_12m_data: twelveMonths?.data_posicao ?? null,
    };
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Metodo nao permitido" }, 405);

  try {
    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const fundoCnpj = body.fundo_cnpj?.replace(/\D/g, "") ?? "";
    const dataReferencia = body.data_referencia?.trim();
    const fundoIsin = normalizeIsin(body.fundo_isin);
    const fundoNome = body.fundo_nome?.trim() || null;
    if (!fundoCnpj || !fundoIsin || !isIsoDate(dataReferencia)) {
      return jsonResponse({
        error: "fundo_cnpj, fundo_isin e data_referencia (YYYY-MM-DD) sao obrigatorios",
      }, 422);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const authHeader = req.headers.get("Authorization");
    const isServiceRole = authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
    if (!isServiceRole) {
      if (!authHeader) return jsonResponse({ error: "Nao autorizado" }, 401);
      const { data: authData, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
      if (authError || !authData.user) return jsonResponse({ error: "Nao autorizado" }, 401);
    }

    const { serie, datas } = await resolveFundReferences(
      supabase,
      fundoCnpj,
      fundoIsin,
      fundoNome,
      dataReferencia,
    );
    const fundoKey = fundoIsin ? `${fundoCnpj}|ISIN:${fundoIsin}` : fundoCnpj;
    const atual = serie.find((snapshot) => snapshot.data_posicao === datas.atual);
    if (!atual) throw new Error(`Nao foi possivel localizar a cota atual do fundo ${fundoCnpj}`);
    const findReference = (date: string | null): SnapshotFundo | null =>
      date ? serie.find((snapshot) => snapshot.data_posicao === date) ?? null : null;
    const baseDia = findReference(datas.dia);
    const baseMes = findReference(datas.mes);
    const baseAno = findReference(datas.ano);
    const base12m = findReference(datas.dozeMeses);
    const retornoDiaFundo = calcReturn(atual.valor_cota, baseDia?.valor_cota ?? null);
    const retornoMesFundo = calcReturn(atual.valor_cota, baseMes?.valor_cota ?? null);
    const retornoAnoFundo = calcReturn(atual.valor_cota, baseAno?.valor_cota ?? null);
    const retorno12mFundo = calcReturn(atual.valor_cota, base12m?.valor_cota ?? null);
    const cdi = await getCdiSnapshot(supabase, dataReferencia);
    const vsCdiDiaFundo = calcMetricasVsCDI(retornoDiaFundo, cdi.dia, 252);
    const vsCdiMesFundo = calcMetricasVsCDI(retornoMesFundo, cdi.mes, 12);
    const vsCdiAnoFundo = calcMetricasVsCDI(retornoAnoFundo, cdi.ano, 1);
    const vsCdi12mFundo = calcMetricasVsCDI(retorno12mFundo, cdi.dozeMeses, 1);
    const assetDates = [datas.atual, datas.dia, datas.mes, datas.ano, datas.dozeMeses].filter(
      (date): date is string => date != null,
    );
    const rawAssetRows = await fetchAssetRowsForDates(supabase, fundoCnpj, assetDates);
    const assetsByDate = aggregateAssetsByDate(rawAssetRows, fundoCnpj, fundoIsin, fundoNome);
    const currentAssets = assetsByDate.get(datas.atual) ?? new Map<string, PosicaoAtivo>();
    const assetSnapshots = makeAssetSnapshots(currentAssets, assetsByDate, datas, fundoIsin, atual.pl, cdi);

    if (body.dry_run) {
      return jsonResponse({
        success: true,
        dry_run: true,
        fundo_key: fundoKey,
        data_referencia: dataReferencia,
        datas_base: datas,
        qtd_ativos: assetSnapshots.length,
        rentabilidade_fundo: {
          retorno_dia_pct: retornoDiaFundo,
          retorno_mes_pct: retornoMesFundo,
          retorno_ano_pct: retornoAnoFundo,
          retorno_12m_pct: retorno12mFundo,
        },
      });
    }

    const { error: fundError } = await supabase.from("rentabilidade_snapshot_fundo").upsert({
      data_posicao: dataReferencia,
      fundo_key: fundoKey,
      fundo_cnpj: atual.fundo_cnpj,
      fundo_isin: atual.fundo_isin,
      nome_fundo: atual.nome_fundo,
      valor_cota: atual.valor_cota,
      pl: atual.pl,
      quantidade: atual.quantidade,
      retorno_dia_pct: retornoDiaFundo,
      retorno_mes_pct: retornoMesFundo,
      retorno_ano_pct: retornoAnoFundo,
      retorno_12m_pct: retorno12mFundo,
      cdi_dia_pct: cdi.dia,
      cdi_mes_pct: cdi.mes,
      cdi_ano_pct: cdi.ano,
      cdi_12m_pct: cdi.dozeMeses,
      pct_cdi: vsCdiDiaFundo.pct_cdi,
      cdi_plus_dia_pct: vsCdiDiaFundo.cdi_plus_pct,
      cdi_plus_aa_pct: vsCdiDiaFundo.cdi_plus_aa_pct,
      pct_cdi_mes: vsCdiMesFundo.pct_cdi,
      cdi_plus_mes_pct: vsCdiMesFundo.cdi_plus_pct,
      cdi_plus_aa_mes_pct: vsCdiMesFundo.cdi_plus_aa_pct,
      pct_cdi_ano: vsCdiAnoFundo.pct_cdi,
      cdi_plus_ano_pct: vsCdiAnoFundo.cdi_plus_pct,
      cdi_plus_aa_ano_pct: vsCdiAnoFundo.cdi_plus_aa_pct,
      pct_cdi_12m: vsCdi12mFundo.pct_cdi,
      cdi_plus_12m_pct: vsCdi12mFundo.cdi_plus_pct,
      cdi_plus_aa_12m_pct: vsCdi12mFundo.cdi_plus_aa_pct,
      is_fidc: isFundoFidc(atual.nome_fundo),
      administrador: atual.administrador,
      calc_version: CALC_VERSION,
      snapshot_updated_at: new Date().toISOString(),
    }, { onConflict: "data_posicao,fundo_key" });
    if (fundError) throw new Error(`Falha ao gravar snapshot do fundo: ${fundError.message}`);

    const { data: assetCount, error: assetError } = await supabase.rpc(
      "replace_rentabilidade_snapshot_ativos_v2",
      {
        p_data_posicao: dataReferencia,
        p_fundo_key: fundoKey,
        p_fundo_cnpj: fundoCnpj,
        p_rows: assetSnapshots,
        p_calc_version: CALC_VERSION,
      },
    );
    if (assetError) throw new Error(`Falha ao gravar snapshots dos ativos: ${assetError.message}`);

    return jsonResponse({
      success: true,
      fundo_key: fundoKey,
      data_referencia: dataReferencia,
      datas_base: datas,
      qtd_ativos: Number(assetCount ?? 0),
      origem: body.origem?.trim() || "manual",
      calc_version: CALC_VERSION,
      rentabilidade_fundo: {
        retorno_dia_pct: retornoDiaFundo,
        retorno_mes_pct: retornoMesFundo,
        retorno_ano_pct: retornoAnoFundo,
        retorno_12m_pct: retorno12mFundo,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[rebuild-rentabilidade-snapshot-v2]", message);
    return jsonResponse({ error: message }, 500);
  }
});
