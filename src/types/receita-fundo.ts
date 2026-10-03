/** Thresholds da regra PL_MIN (rules-pl / README) */
export const PL_MINIMO = 1_000_000
export const PL_ALERTA = 1_200_000
export const CONCENTRACAO_TOP5_ALERTA = 55

export type ReceitaFundoTrend = {
  fundo_cnpj: string
  fundo_nome: string
  gestor: string
  segmento: string
  receita_atual: number
  variacao_mom: number
  /** últimos 6 meses, ordem cronológica */
  serie: number[]
}

export type ReceitaKpis = {
  receitaTotalMes: number
  variacaoMomTotal: number
  receitaMediaPorFundo: number
  fundosAtivos: number
  concentracaoTop5: number
  fundosAbaixoPlMinimo: number
}

export type SegmentoReceitaResumo = {
  segmentoKey: string
  label: string
  receita: number
  pct: number
  fill: string
  qtdFundos: number
}

export type PlLimiteFundo = {
  fundo_cnpj: string
  fundo_nome: string
  pl_atual: number
  pl_minimo: number
  pl_alerta: number
}
