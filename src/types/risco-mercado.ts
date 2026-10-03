// Tipos para o módulo de Risco de Mercado V2

export type MetodoVar = 'historico' | 'parametrico' | 'mc_t' | 'diversificado'

export type StatusRisco = 'ok' | 'alerta' | 'breach' | 'sem_dados'

// Ponto da série histórica de VaR por carteira
export interface VarSeriePoint {
  cod_cli: number
  data_ref: string
  var_95_hist: number | null
  var_95_param: number | null
  var_95_mc_t: number | null
  var_95_diversif: number | null
}

// Fundo individual dentro do detalhe de carteira (posicao_diaria × betas_por_cnpj)
export interface FundoDetalheCarteira {
  nom_atv: string
  nom_estr: string | null
  cnpj: string | null
  sld_lqd: number
  pct_pl: number
  var_95_hist_pct: number | null
  var_95_param_pct: number | null
  var_95_mc_t_pct: number | null
  bvar_95_pct: number | null
  qualidade: string | null
  r2: number | null
  n_obs: number | null
  benchmark_cod: string | null
  rho_benchmark: number | null
  tracking_error: number | null
  df_t: number | null
}

// Carteira — campos originais (V1) mantidos
export interface CarteiraRiscoV2 {
  cliente: string
  cod_cli: number | null
  grupo: string | null
  data_posicao: string | null
  var_mes_95_pct: number | null
  drawdown_atual_pct: number | null
  drawdown_max_252d_pct: number | null
  pior_21d_pct: number | null
  retorno_21d_atual_pct: number | null
  vol_diaria_pct: number | null
  alerta_3sigma: boolean
  stress_pior_pct: number | null
}

// Carteira — campos novos V2
export interface CarteiraRiscoExtendida extends CarteiraRiscoV2 {
  pl_total: number | null
  cobertura_cnpj_pct: number
  // VaR por método (ponderado aditivo, % do PL)
  var_95_hist_pct: number | null
  var_95_param_pct: number | null
  var_95_mc_t_pct: number | null
  var_95_diversif_pct: number | null
  bvar_95_pct: number | null
  // Valores em R$
  var_95_hist_rs: number | null
  var_95_diversif_rs: number | null
  // Benefício de diversificação
  beneficio_diversif_rs: number | null
  beneficio_diversif_pct: number | null
  // Limites e status
  limite_95: number | null       // em %, ex: 5
  pct_uso_limite: number | null  // em %, ex: 80
  status: StatusRisco
  // Dados de apoio
  serie_var: VarSeriePoint[]
  fundos_detalhe: FundoDetalheCarteira[]
}

// Fundo individual — campos originais (V1) mantidos
export interface FundoRiscoV2 {
  cnpj: string
  nome_fundo: string | null
  ultima_posicao: string | null
  qualidade: string | null
  var_95_21d_pct: number | null
  var_99_21d_pct: number | null
  pior_21d_pct: number | null
  drawdown_atual_pct: number | null
  drawdown_max_252d_pct: number | null
  n_obs_21d: number | null
  data_base_calculo: string | null
  sem_metricas: boolean
}

// Fundo individual — campos novos V2
export interface FundoRiscoExtendido extends FundoRiscoV2 {
  var_95_param_pct: number | null
  var_95_mc_t_pct: number | null
  bvar_95_pct: number | null
  benchmark_cod: string | null
  rho_benchmark: number | null
  tracking_error: number | null
  df_t: number | null
  fonte_cota: string | null
}

// Summary global retornado pela edge function
export interface RiscoMercadoSummary {
  total_carteiras: number
  pl_total: number
  var_95_aditivo_rs: number
  var_95_diversif_rs: number | null
  beneficio_diversif_rs: number | null
  beneficio_diversif_pct: number | null
  cobertura_media_pct: number
  carteiras_ok: number
  carteiras_alerta: number
  carteiras_breach: number
  pior_carteira_var_pct: number | null
  data_posicao_risco: string | null
}

// Shape completo da resposta da edge function V2
export interface RiscoV2Response {
  success: boolean
  total_carteiras: number
  total_fundos: number
  carteiras: CarteiraRiscoExtendida[]
  fundos: FundoRiscoExtendido[]
  summary: RiscoMercadoSummary
}

// Relatório consolidado por fundo gerido (posicao_carteira × betas)
export interface LinhaConsolidada {
  fundo_cnpj: string
  nome_fundo: string
  pl: number
  exposicao: number
  var_param_pct: number | null
  etl_param_rs: number | null
  var_hist_pct: number | null
  etl_hist_rs: number | null
  stress: Record<string, number | null>
  stress_contratado: number | null
  consumo_pct: number | null
}

export interface RiscoConsolidadoSummary {
  total_fundos: number
  pl_total: number
  exposicao_total: number
  fundos_com_var: number
}

export interface RiscoConsolidadoResponse {
  success: boolean
  data_base: string
  cenarios: string[]
  linhas: LinhaConsolidada[]
  summary: RiscoConsolidadoSummary
}
