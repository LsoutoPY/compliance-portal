/**
 * Leitura do resultado V2 para os canais de relatorio.
 *
 * Aqui nunca se consulta historico de posicao nem CDI: esses dados ja foram
 * resolvidos pelo worker incremental e persistidos nos snapshots.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import type { RentabilidadeFundoRow } from "./calc.ts";
import type { AtivoRelatorio } from "./relatorioHTML_v2.ts";
import { buildNomeMapFromAtivos, resolveNomeFromLookupMap } from "./mapaAtivosNome.ts";

const SNAPSHOT_V2 = "rentabilidade_snapshot_v2";

const asNumber = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};

interface SnapshotAtivoRow {
  fundo_key: string;
  section: string;
  cnpj_ativo: string | null;
  isin_ativo: string | null;
  ativo_cnpjfundo: string | null;
  ativo_isin: string | null;
  nome_ativo: string | null;
  nome_exibicao: string;
  quantidade: unknown;
  pu_posicao: unknown;
  valor_mercado: unknown;
  perc_pl_pct: unknown;
  retorno_dia_pct: unknown;
  retorno_mes_pct: unknown;
  retorno_ano_pct: unknown;
  retorno_12m_pct: unknown;
  pct_cdi: unknown;
  cdi_plus_aa_pct: unknown;
  pct_cdi_mes: unknown;
  cdi_plus_aa_mes_pct: unknown;
  pct_cdi_ano: unknown;
  cdi_plus_aa_ano_pct: unknown;
  pct_cdi_12m: unknown;
  cdi_plus_aa_12m_pct: unknown;
}

function snapshotAtivoToRelatorio(row: SnapshotAtivoRow, nomeCardapio: string | null): AtivoRelatorio {
  const cdiPlusAa12m = asNumber(row.cdi_plus_aa_12m_pct);
  let status: AtivoRelatorio["status"] = "nm";
  if (cdiPlusAa12m != null) {
    status = cdiPlusAa12m < -1 ? "abaixo" : cdiPlusAa12m > 3 ? "acima" : "ok";
  }
  const varMes = asNumber(row.retorno_mes_pct);
  const var12M = asNumber(row.retorno_12m_pct);
  return {
    nome: nomeCardapio || row.nome_exibicao || row.nome_ativo || row.cnpj_ativo || "—",
    cnpj: row.cnpj_ativo,
    qtd: asNumber(row.quantidade),
    pu: asNumber(row.pu_posicao),
    vlMercado: asNumber(row.valor_mercado),
    percPL: asNumber(row.perc_pl_pct) ?? 0,
    varDia: asNumber(row.retorno_dia_pct),
    vsCdiDia: asNumber(row.pct_cdi),
    cdiPlusAaDia: asNumber(row.cdi_plus_aa_pct),
    varMes,
    vsCdiMes: asNumber(row.pct_cdi_mes),
    cdiPlusAaMes: asNumber(row.cdi_plus_aa_mes_pct),
    varAno: asNumber(row.retorno_ano_pct),
    vsCdiAno: asNumber(row.pct_cdi_ano),
    cdiPlusAaAno: asNumber(row.cdi_plus_aa_ano_pct),
    var12M,
    vsCdi12M: asNumber(row.pct_cdi_12m),
    cdiPlusAa12m,
    status,
    isDetrator: (varMes != null && varMes < -2) || (var12M != null && var12M < -5),
  };
}

function sortAtivos(ativos: AtivoRelatorio[]): AtivoRelatorio[] {
  return ativos.sort((a, b) => (b.vlMercado ?? 0) - (a.vlMercado ?? 0));
}

/** Retorna somente classes cujo calculo V2 e todos os ativos ja estao persistidos. */
export async function fetchSnapshotReportData(
  supabase: SupabaseClient,
  dataReferencia: string,
): Promise<{ fundos: RentabilidadeFundoRow[]; ativosMap: Map<string, AtivoRelatorio[]> }> {
  const [{ data: fundosData, error: fundosError }, { data: ativosData, error: ativosError }] = await Promise.all([
    supabase
      .from("rentabilidade_snapshot_fundo")
      .select("fundo_key, fundo_cnpj, fundo_isin, nome_fundo, data_posicao, valor_cota, pl, quantidade, retorno_dia_pct, retorno_acum_pct, retorno_mes_pct, retorno_ano_pct, retorno_sem_pct, retorno_12m_pct, cdi_dia_pct, cdi_mes_pct, cdi_ano_pct, pct_cdi, cdi_plus_dia_pct, cdi_plus_aa_pct, pct_cdi_mes, cdi_plus_mes_pct, cdi_plus_aa_mes_pct, pct_cdi_ano, cdi_plus_ano_pct, cdi_plus_aa_ano_pct, cdi_12m_pct, pct_cdi_12m, cdi_plus_12m_pct, cdi_plus_aa_12m_pct, is_fidc, administrador")
      .eq("data_posicao", dataReferencia)
      .eq("calc_version", SNAPSHOT_V2),
    supabase
      .from("rentabilidade_snapshot_ativo")
      .select("fundo_key, section, ativo_cnpjfundo, ativo_isin, cnpj_ativo, isin_ativo, nome_ativo, nome_exibicao, quantidade, pu_posicao, valor_mercado, perc_pl_pct, retorno_dia_pct, retorno_mes_pct, retorno_ano_pct, retorno_12m_pct, pct_cdi, cdi_plus_aa_pct, pct_cdi_mes, cdi_plus_aa_mes_pct, pct_cdi_ano, cdi_plus_aa_ano_pct, pct_cdi_12m, cdi_plus_aa_12m_pct")
      .eq("data_posicao", dataReferencia)
      .eq("calc_version", SNAPSHOT_V2),
  ]);
  if (fundosError) throw new Error(`Falha ao ler snapshots V2 dos fundos: ${fundosError.message}`);
  if (ativosError) throw new Error(`Falha ao ler snapshots V2 dos ativos: ${ativosError.message}`);

  const snapshotAtivos = (ativosData ?? []) as SnapshotAtivoRow[];
  const cnpjs = [...new Set(snapshotAtivos.map((row) => row.ativo_cnpjfundo ?? row.cnpj_ativo).filter((value): value is string => Boolean(value)))];
  const isins = [...new Set(snapshotAtivos.map((row) => row.ativo_isin ?? row.isin_ativo).filter((value): value is string => Boolean(value)))];
  const filters: string[] = [];
  if (cnpjs.length) filters.push(`cnpj.in.(${cnpjs.map((value) => value.replace(/\D/g, "")).filter(Boolean).join(",")})`);
  if (isins.length) filters.push(`isin.in.(${isins.map((value) => value.trim().toUpperCase()).filter(Boolean).join(",")})`);
  const nomeMap = new Map<string, string>();
  if (filters.length) {
    const { data: nomesData, error: nomesError } = await supabase
      .from("ativos")
      .select("cnpj, isin, nome_frontend, descricao")
      .or(filters.join(","));
    if (nomesError) console.warn(`[snapshotReportData] Falha ao ler nomes do cardapio: ${nomesError.message}`);
    else for (const [key, value] of buildNomeMapFromAtivos((nomesData ?? []) as Array<{ cnpj: string | null; isin: string | null; nome_frontend: string | null; descricao: string | null }>)) nomeMap.set(key, value);
  }

  const ativosMap = new Map<string, AtivoRelatorio[]>();
  for (const row of snapshotAtivos) {
    const ativos = ativosMap.get(row.fundo_key) ?? [];
    ativos.push(snapshotAtivoToRelatorio(
      row,
      resolveNomeFromLookupMap(row.ativo_cnpjfundo ?? row.cnpj_ativo, row.ativo_isin ?? row.isin_ativo, nomeMap),
    ));
    ativosMap.set(row.fundo_key, ativos);
  }
  for (const ativos of ativosMap.values()) sortAtivos(ativos);

  // Fundo sem composicao de ativos continua sendo fundo do relatorio: cota,
  // PL e rentabilidade sao validos. Eventuais exclusoes sao configuradas
  // explicitamente pela lista persistida, nunca inferidas pela ausencia de ativo.
  const fundos = ((fundosData ?? []) as unknown as RentabilidadeFundoRow[])
    .sort((a, b) => (a.nome_fundo ?? a.fundo_cnpj).localeCompare(b.nome_fundo ?? b.fundo_cnpj, "pt-BR"));
  return { fundos, ativosMap };
}
