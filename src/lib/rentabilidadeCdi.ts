import {
  calcCdiAcumulado12M,
  calcCdiAcumuladoAno,
  calcCdiAcumuladoMes,
  calcMetricasVsCDI,
} from "@/hooks/useRentabilidadeCalc";
import type { RentabilidadeFundoRow } from "@/hooks/useRentabilidadeData";

/** Reaplica o benchmark atual sem alterar cotas, retornos ou a versão do snapshot. */
export function atualizarComparativosCdi(
  fundo: RentabilidadeFundoRow,
  cdiDict: Record<string, number>,
): RentabilidadeFundoRow {
  const dataRef = fundo.data_posicao;
  // Sem taxa na data da posição, o acumulado pode estar defasado (ex.: D-1).
  // Não substituímos uma taxa ausente pela anterior nem por zero.
  const temTaxa = Number.isFinite(cdiDict[dataRef]);
  const dia = temTaxa ? cdiDict[dataRef] * 100 : null;
  const mes = temTaxa ? calcCdiAcumuladoMes(cdiDict, dataRef) : null;
  const ano = temTaxa ? calcCdiAcumuladoAno(cdiDict, dataRef) : null;
  const dozeMeses = temTaxa ? calcCdiAcumulado12M(cdiDict, dataRef) : null;
  const vsDia = calcMetricasVsCDI(fundo.retorno_dia_pct, dia, 252);
  const vsMes = calcMetricasVsCDI(fundo.retorno_mes_pct, mes, 12);
  const vsAno = calcMetricasVsCDI(fundo.retorno_ano_pct, ano, 1);
  const vs12m = calcMetricasVsCDI(fundo.retorno_12m_pct, dozeMeses, 1);
  return {
    ...fundo,
    cdi_dia_pct: dia,
    cdi_mes_pct: mes,
    cdi_ano_pct: ano,
    cdi_12m_pct: dozeMeses,
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
  };
}
