import { supabase } from "@/integrations/supabase/client";
import type { RentabilidadeFundoRow } from "@/hooks/useRentabilidadeData";
import type { AtivoRelatorio } from "@/lib/generateRentabilidadeRelatorioHTML_v2";
import { buildNomeMapFromAtivos, resolveNomeFromLookupMap } from "@/lib/mapaAtivosNome";

const SNAPSHOT_V2 = "rentabilidade_snapshot_v2";
const asNumber = (value: unknown) => {
  const number = Number(value);
  return value == null || value === "" || !Number.isFinite(number) ? null : number;
};

export async function fetchRentabilidadeRelatorioV2(dataReferencia: string): Promise<{
  fundos: RentabilidadeFundoRow[];
  ativosMap: Map<string, AtivoRelatorio[]>;
}> {
  const [{ data: fundosData, error: fundosError }, { data: ativosData, error: ativosError }] = await Promise.all([
    // A tabela V2 e criada por migration; o tipo gerado do cliente ainda nao a conhece.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("rentabilidade_snapshot_fundo").select("*")
      .eq("data_posicao", dataReferencia).eq("calc_version", SNAPSHOT_V2),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("rentabilidade_snapshot_ativo").select("*")
      .eq("data_posicao", dataReferencia).eq("calc_version", SNAPSHOT_V2),
  ]);
  if (fundosError) throw fundosError;
  if (ativosError) throw ativosError;

  const snapshotAtivos = ativosData ?? [];
  const cnpjs = [...new Set(snapshotAtivos.map((row: { ativo_cnpjfundo?: string | null; cnpj_ativo?: string | null }) => row.ativo_cnpjfundo ?? row.cnpj_ativo).filter(Boolean))] as string[];
  const isins = [...new Set(snapshotAtivos.map((row: { ativo_isin?: string | null; isin_ativo?: string | null }) => row.ativo_isin ?? row.isin_ativo).filter(Boolean))] as string[];
  const filters = [
    cnpjs.length ? `cnpj.in.(${cnpjs.map((value) => value.replace(/\D/g, "")).join(",")})` : null,
    isins.length ? `isin.in.(${isins.map((value) => value.trim().toUpperCase()).join(",")})` : null,
  ].filter(Boolean);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: nomesData } = filters.length ? await (supabase as any).from("ativos").select("cnpj, isin, nome_frontend, descricao").or(filters.join(",")) : { data: [] };
  const nomesCardapio = buildNomeMapFromAtivos(nomesData ?? []);

  const ativosMap = new Map<string, AtivoRelatorio[]>();
  for (const row of snapshotAtivos) {
    const varMes = asNumber(row.retorno_mes_pct);
    const var12M = asNumber(row.retorno_12m_pct);
    const cdiPlusAa12m = asNumber(row.cdi_plus_aa_12m_pct);
    const status: AtivoRelatorio["status"] = cdiPlusAa12m == null
      ? "nm"
      : cdiPlusAa12m < -1 ? "abaixo" : cdiPlusAa12m > 3 ? "acima" : "ok";
    const ativos = ativosMap.get(row.fundo_key) ?? [];
    ativos.push({
      nome: resolveNomeFromLookupMap(row.ativo_cnpjfundo ?? row.cnpj_ativo, row.ativo_isin ?? row.isin_ativo, nomesCardapio)
        || row.nome_exibicao || row.nome_ativo || row.cnpj_ativo || "—",
      cnpj: row.cnpj_ativo,
      qtd: asNumber(row.quantidade), pu: asNumber(row.pu_posicao), vlMercado: asNumber(row.valor_mercado),
      percPL: asNumber(row.perc_pl_pct) ?? 0,
      varDia: asNumber(row.retorno_dia_pct), vsCdiDia: asNumber(row.pct_cdi), cdiPlusAaDia: asNumber(row.cdi_plus_aa_pct),
      varMes, vsCdiMes: asNumber(row.pct_cdi_mes), cdiPlusAaMes: asNumber(row.cdi_plus_aa_mes_pct),
      varAno: asNumber(row.retorno_ano_pct), vsCdiAno: asNumber(row.pct_cdi_ano), cdiPlusAaAno: asNumber(row.cdi_plus_aa_ano_pct),
      var12M, vsCdi12M: asNumber(row.pct_cdi_12m), cdiPlusAa12m: cdiPlusAa12m,
      status, isDetrator: (varMes != null && varMes < -2) || (var12M != null && var12M < -5),
    });
    ativosMap.set(row.fundo_key, ativos);
  }
  for (const ativos of ativosMap.values()) ativos.sort((a, b) => (b.vlMercado ?? 0) - (a.vlMercado ?? 0));
  // A falta de ativos nao invalida a rentabilidade do fundo. A exclusao e uma
  // decisao operacional explicita, salva na lista de ignorados.
  const fundos = (fundosData as RentabilidadeFundoRow[] ?? [])
    .sort((a, b) => (a.nome_fundo ?? a.fundo_cnpj).localeCompare(b.nome_fundo ?? b.fundo_cnpj, "pt-BR"));
  return { fundos, ativosMap };
}
