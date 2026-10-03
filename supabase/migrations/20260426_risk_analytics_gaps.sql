-- ============================================================
-- RISCO: CVaR, n_obs_21d efetivo, metadatas de MDD (pico, vale, recuperação)
-- ============================================================
-- Populado por scripts/atualizar-betas-por-cnpj.py (cálculo offline).
-- ============================================================

-- betas_por_cnpj -----------------------------------------------------------
ALTER TABLE betas_por_cnpj
  ADD COLUMN IF NOT EXISTS cvar_95_21d  NUMERIC,
  ADD COLUMN IF NOT EXISTS cvar_99_21d  NUMERIC,
  ADD COLUMN IF NOT EXISTS n_obs_21d_eff INTEGER,
  ADD COLUMN IF NOT EXISTS mdd_pico_data          DATE,
  ADD COLUMN IF NOT EXISTS mdd_vale_data         DATE,
  ADD COLUMN IF NOT EXISTS mdd_recuperacao_data  DATE,
  ADD COLUMN IF NOT EXISTS mdd_duracao_dias      INTEGER;

COMMENT ON COLUMN betas_por_cnpj.cvar_95_21d IS
  'Expected Shortfall 95% (CVaR) horizonte 21d: média dos retornos 21d <= VaR 95% (5º percentil). Decimal, negativo = perda.';

COMMENT ON COLUMN betas_por_cnpj.cvar_99_21d IS
  'CVaR 99%: média da cauda além do VaR 99% (1º percentil), retornos 21d.';

COMMENT ON COLUMN betas_por_cnpj.n_obs_21d_eff IS
  'Aprox. nº de janelas 21d quase independentes: max(1, round(n_obs_21d/21)) — a série de pct_change(21) tem janelas sobrepostas.';

COMMENT ON COLUMN betas_por_cnpj.mdd_pico_data IS
  'Data do pico (máx. cota) no subperíodo [:data do vale do MDD] — últimos 252 pontos da série.';

COMMENT ON COLUMN betas_por_cnpj.mdd_vale_data IS
  'Data do vale do pior drawdown (%) na janela (mesmo cálculo que drawdown_max_252d_pct).';

COMMENT ON COLUMN betas_por_cnpj.mdd_recuperacao_data IS
  'Primeira data após o vale em que o drawdown (%) frente ao pico móvel < 0,0001% (cota de volta ao pico móvel), ou NULL se não ocorre na amostra.';

COMMENT ON COLUMN betas_por_cnpj.mdd_duracao_dias IS
  'Dias corridos do pico do MDD ao vale (duração do drawdown).';

-- fundos_metricas_mercado --------------------------------------------------
ALTER TABLE fundos_metricas_mercado
  ADD COLUMN IF NOT EXISTS cvar_95_21d  NUMERIC,
  ADD COLUMN IF NOT EXISTS cvar_99_21d  NUMERIC,
  ADD COLUMN IF NOT EXISTS n_obs_21d_eff INTEGER,
  ADD COLUMN IF NOT EXISTS mdd_pico_data          DATE,
  ADD COLUMN IF NOT EXISTS mdd_vale_data         DATE,
  ADD COLUMN IF NOT EXISTS mdd_recuperacao_data  DATE,
  ADD COLUMN IF NOT EXISTS mdd_duracao_dias      INTEGER;

COMMENT ON COLUMN fundos_metricas_mercado.cvar_95_21d IS
  'Expected Shortfall 95%: média da cauda (ret_21d <= VaR 95%). Alinhado a betas_por_cnpj.';

COMMENT ON COLUMN fundos_metricas_mercado.cvar_99_21d IS
  'CVaR 99%: média dos ret_21d <= VaR 99%.';

COMMENT ON COLUMN fundos_metricas_mercado.n_obs_21d_eff IS
  'Janelas 21d aprox. independentes: max(1, round(n_obs_21d/21)).';

COMMENT ON COLUMN fundos_metricas_mercado.mdd_pico_data IS
  'Data do pico do episódio de pior drawdown (252 últimos pontos CVM).';

COMMENT ON COLUMN fundos_metricas_mercado.mdd_vale_data IS
  'Data do vale (pior ponto) do MDD.';

COMMENT ON COLUMN fundos_metricas_mercado.mdd_recuperacao_data IS
  'Primeira data após o vale com drawdown frente a HWM ~0% (recuperação). NULL se a série termina ainda abaixo do pico.';

COMMENT ON COLUMN fundos_metricas_mercado.mdd_duracao_dias IS
  'Dias corridos entre pico e vale do MDD.';
