// ── Snapshot "atual" de cada fundo (via vw_risco_mercado_fundos_diario_atual) ──

export interface FundoRiscoSimplificado {
  cnpj:                string;
  nome_fundo:          string | null;
  data_ref:            string;   // 'YYYY-MM-DD'

  pl:                  number | null;
  cota:                number | null;
  delta_cota_pct:      number | null;   // decimal, ex: 0.001 = 0,1%
  cdi_valor:           number | null;
  delta_cdi_pct:       number | null;
  relacao_cota_cdi:    number | null;
  status_cota_cdi:     'ok' | 'atencao' | 'sem_dados';

  var_param_dia_pct:   number | null;   // Z_95 × |Δcota| × 100 (magnitude positiva, ilustrativo)

  sigma_diario_pct:    number | null;   // % (100 × decimal)

  // ── OFICIAL V3 — magnitude POSITIVA de perda, horizonte explícito no nome ──
  var_95_param_1d_pct:   number | null;   // VaR Paramétrico 95% — 1 dia útil = 1,645 × sigma_diario
  var_95_param_1d_rs:    number | null;   // idem, em R$ (PL × pct/100)
  var_95_hist_21d_pct:   number | null;   // VaR Histórico 95% — 21d = max(0, -P5(ret_21d)); nunca < 0
  var_95_hist_21d_rs:    number | null;   // idem, em R$

  /** @deprecated usar var_95_param_1d_pct */
  var_95_param_pct:    number | null;
  /** @deprecated usar var_95_param_1d_rs */
  var_95_param_rs:     number | null;
  /** @deprecated usar var_95_hist_21d_pct */
  var_95_hist_pct:     number | null;
  /** @deprecated usar var_95_hist_21d_rs */
  var_95_hist_rs:      number | null;

  n_obs_21d:           number | null;   // nº de JANELAS 21d usadas no percentil (não dias!)
  drawdown_atual_pct:  number | null;   // positivo
  drawdown_max_pct:    number | null;   // positivo
  n_obs:               number | null;   // nº de retornos diários usados em sigma/VaR Param 1d
  qualidade_serie_status: 'ok' | 'suspeita' | 'sem_dados' | null;
  serie_suspeita:         boolean | null;
  serie_alertas:          string[] | null;
  serie_extremos_1d:      number | null;
  serie_extremos_21d:     number | null;
  serie_maior_gap_dias:   number | null;
  serie_hist_baixo:       boolean | null;
  serie_quebra_detectada: boolean | null;
  serie_troca_cnpj:       boolean | null;
  fonte_cota:          'xml' | 'hibrido_manual_xml' | null;
}

// ── Série diária de um fundo (para drill-down) ───────────────

export interface FundoRiscoSimplificadoDia {
  cnpj:                string;
  data_ref:            string;

  pl:                  number | null;
  cota:                number | null;
  delta_cota_pct:      number | null;
  cdi_valor:           number | null;
  delta_cdi_pct:       number | null;
  relacao_cota_cdi:    number | null;
  status_cota_cdi:     'ok' | 'atencao' | 'sem_dados';

  var_param_dia_pct:   number | null;
  var_95_param_1d_pct: number | null;
  var_95_hist_21d_pct: number | null;
  /** @deprecated compat legado */
  var_95_param_pct:    number | null;
  /** @deprecated compat legado */
  var_95_hist_pct:     number | null;
}

// ── Log de execuções ─────────────────────────────────────────

export interface RiscoMercadoFundosCalcLog {
  id:                  string;
  origem:              'cron' | 'manual';
  status:              'running' | 'success' | 'error';
  fundos_processados:  number | null;
  fundos_com_erro:     number | null;
  mensagem:            string | null;
  erro_mensagem:       string | null;
  iniciado_em:         string;
  concluido_em:        string | null;
}
