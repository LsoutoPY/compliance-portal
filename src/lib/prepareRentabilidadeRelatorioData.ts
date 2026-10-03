/**
 * Helper para preparar dados dos ativos para o relatório de rentabilidade
 */

import type { RentabilidadeAtivoRow } from "@/hooks/useRentabilidadeData";
import type { AtivoRelatorio } from "./generateRentabilidadeRelatorioHTML_v2";
import { supabase } from "@/integrations/supabase/client";

/**
 * Converte dados de ativos do hook para formato do relatório
 */
export function convertAtivoToRelatorio(
  ativo: RentabilidadeAtivoRow,
): AtivoRelatorio {
  let status: AtivoRelatorio["status"] = "nm";

  const cdiPlusAA = ativo.cdi_plus_aa_pct ?? ativo.cdi_plus_aa_12m_pct;
  if (cdiPlusAA != null) {
    if (cdiPlusAA < -1) {
      status = "abaixo";
    } else if (cdiPlusAA > 3) {
      status = "acima";
    } else {
      status = "ok";
    }
  }

  const isDetrator =
    (ativo.var_pu_mes_pct != null && ativo.var_pu_mes_pct < -2) ||
    (ativo.var_pu_12m_pct != null && ativo.var_pu_12m_pct < -5);

  return {
    nome: ativo.nome_exibicao || ativo.nome_ativo || ativo.cnpj_ativo || "—",
    cnpj: ativo.cnpj_ativo,
    qtd: ativo.qt_disponivel,
    pu: ativo.pu_posicao,
    vlMercado: ativo.vl_mercado,
    percPL: ativo.perc_pl_pct ?? 0,
    varDia: ativo.var_pu_pct,
    vsCdiDia: ativo.pct_cdi,
    cdiPlusAaDia: ativo.cdi_plus_aa_pct ?? null,
    varMes: ativo.var_pu_mes_pct,
    vsCdiMes: ativo.pct_cdi_mes,
    cdiPlusAaMes: ativo.cdi_plus_aa_mes_pct ?? null,
    varAno: ativo.var_pu_ano_pct,
    vsCdiAno: ativo.pct_cdi_ano,
    cdiPlusAaAno: ativo.cdi_plus_aa_ano_pct ?? null,
    var12M: ativo.var_pu_12m_pct,
    vsCdi12M: ativo.pct_cdi_12m,
    cdiPlusAa12m: ativo.cdi_plus_aa_12m_pct ?? null,
    status,
    isDetrator,
  };
}

/**
 * Ordena ativos por maior valor de mercado (% PL como desempate) — mesma regra do Excel.
 */
export function sortAtivosRelatorio(ativos: AtivoRelatorio[]): AtivoRelatorio[] {
  return [...ativos].sort((a, b) => {
    if (a.vlMercado != null && b.vlMercado != null) {
      return b.vlMercado - a.vlMercado;
    }
    return (b.percPL ?? 0) - (a.percPL ?? 0);
  });
}

/** Busca siglas curtas da tabela nomes_fundos (CNPJ → sigla). */
export async function fetchSiglasNomesFundos(
  cnpjs: string[],
): Promise<Record<string, string>> {
  const unique = [
    ...new Set(cnpjs.map((c) => c.replace(/\D/g, "")).filter(Boolean)),
  ];
  if (unique.length === 0) return {};

  try {
    const { data, error } = await supabase
      .from("nomes_fundos" as never)
      .select("cnpj, sigla")
      .in("cnpj", unique);

    if (error || !data?.length) return {};

    const map: Record<string, string> = {};
    for (const row of data as { cnpj: string; sigla: string | null }[]) {
      const key = row.cnpj?.replace(/\D/g, "") ?? "";
      const sigla = row.sigla?.trim();
      if (key && sigla) map[key] = sigla;
    }
    return map;
  } catch {
    return {};
  }
}

export function collectCnpjsAtivos(
  ativosMap: Map<string, AtivoRelatorio[]>,
): string[] {
  const cnpjs: string[] = [];
  for (const ativos of ativosMap.values()) {
    for (const a of ativos) {
      if (a.cnpj) cnpjs.push(a.cnpj);
    }
  }
  return cnpjs;
}
