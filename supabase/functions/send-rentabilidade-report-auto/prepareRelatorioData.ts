/**
 * Helpers de preparação de ativos — porte Deno de `src/lib/prepareRentabilidadeRelatorioData.ts`.
 */

import type { RentabilidadeAtivoRow } from "./ativosCalc.ts";
import type { AtivoRelatorio } from "./relatorioHTML_v2.ts";

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

export function sortAtivosRelatorio(ativos: AtivoRelatorio[]): AtivoRelatorio[] {
  return [...ativos].sort((a, b) => {
    if (a.vlMercado != null && b.vlMercado != null) {
      return b.vlMercado - a.vlMercado;
    }
    return (b.percPL ?? 0) - (a.percPL ?? 0);
  });
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
