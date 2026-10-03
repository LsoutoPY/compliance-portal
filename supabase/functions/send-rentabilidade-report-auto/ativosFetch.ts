/**
 * Fetch de ativos com métricas — porte Deno de `src/hooks/useRentabilidadeData.ts`
 * (fetchRentabilidadeAtivosForFundo e dependências).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import {
  buildNomeMapFromAtivos,
  buildNomeMapFromFundos,
  nomeMapToRecord,
} from "./mapaAtivosNome.ts";
import {
  calcCdiAcumulado12M,
  calcCdiAcumuladoAno,
  calcCdiAcumuladoMes,
  calcMetricasVsCDI,
  cdiDecimalToPct,
  isFundoFidc,
  isinUtilizavel,
  isoToYyyymmdd,
  subtractDaysIso,
  yyyymmddToIso,
} from "./calc.ts";
import {
  agregarAtivosPorChave,
  calcPercPL,
  calcVarPU12M,
  calcVarPUAno,
  calcVarPUAtivo,
  calcVarPUMes,
  cnpjTemClasseUnica,
  consolidarHistoricoPuCotas,
  expandAtivoKeyAliases,
  getAtivoKeyFromRow,
  isRowFromSelectedClasse,
  isVarPuPlausivel,
  mapPosicaoToAtivo,
  resolvePuQtFromRow,
  SECTIONS_ATIVOS_RENTABILIDADE,
  type PosicaoAtivo,
  type PosicaoCarteiraRow,
  type RentabilidadeAtivoRow,
} from "./ativosCalc.ts";

const HISTORICO_DIAS = 560;
const PAGE_SIZE = 1000;

async function fetchNomesFundos(
  supabase: SupabaseClient,
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
    .from("fundos_caracteristicas")
    .select("cnpj_classe, cnpj_fundo, nome_comercial, isin")
    .or(filters.join(","));

  if (error) {
    console.warn("[ativosFetch] Erro ao buscar nomes ANBIMA:", error.message);
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

async function fetchNomesAtivosFrontend(
  supabase: SupabaseClient,
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
    console.warn("[ativosFetch] Erro ao buscar nomes frontend:", error.message);
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

function mergeNomesAtivos(
  anbima: Record<string, string>,
  frontend: Record<string, string>,
): Record<string, string> {
  return { ...anbima, ...frontend };
}

async function fetchAtivosFundo(
  supabase: SupabaseClient,
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
    fetchNomesFundos(supabase, cnpjsAtivos, isinsAtivos),
    fetchNomesAtivosFrontend(supabase, cnpjsAtivos, isinsAtivos),
  ]);
  const nomesMap = mergeNomesAtivos(nomesAnbima, nomesFrontend);

  return scopedRows
    .map((r) => mapPosicaoToAtivo(r, nomesMap))
    .filter((a): a is PosicaoAtivo => a != null);
}

async function fetchAtivosFundoAgregados(
  supabase: SupabaseClient,
  fundoCnpj: string,
  fundoIsin: string | null,
  fundoNome: string | null,
  dataRef: string,
): Promise<PosicaoAtivo[]> {
  const ativos = await fetchAtivosFundo(supabase, fundoCnpj, fundoIsin, fundoNome, dataRef);
  return agregarAtivosPorChave(ativos);
}

async function fetchHistoricoPuFundos(
  supabase: SupabaseClient,
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
  const source =
    scopedAll.length > 0 || fundoIsin
      ? scopedAll
      : all;

  const historico = source
    .map((r) => {
      const { pu, qt } = resolvePuQtFromRow(r);
      if (pu == null || pu <= 0) return null;
      return {
        ativo_key: getAtivoKeyFromRow(r),
        data_posicao: yyyymmddToIso(r.fundo_dtposicao),
        pu_posicao: pu,
        qt: qt ?? 1,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  return consolidarHistoricoPuCotas(historico);
}

/** Busca ativos de um fundo com métricas calculadas. */
export async function fetchRentabilidadeAtivosForFundo(
  supabase: SupabaseClient,
  fundoCnpj: string,
  fundoIsin: string | null,
  fundoNome: string | null,
  dataRef: string,
  plFundo: number | null,
  cdiDict: Record<string, number>,
): Promise<RentabilidadeAtivoRow[]> {
  const [ativos, historicoPu] = await Promise.all([
    fetchAtivosFundoAgregados(supabase, fundoCnpj, fundoIsin, fundoNome, dataRef),
    fetchHistoricoPuFundos(supabase, fundoCnpj, fundoIsin, fundoNome, dataRef),
  ]);

  const cdiDiaPct =
    cdiDict[dataRef] != null ? cdiDecimalToPct(cdiDict[dataRef]) : null;
  const cdiMesPct = calcCdiAcumuladoMes(cdiDict, dataRef);
  const cdiAnoPct = calcCdiAcumuladoAno(cdiDict, dataRef);
  const cdi12mPct = calcCdiAcumulado12M(cdiDict, dataRef);

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
