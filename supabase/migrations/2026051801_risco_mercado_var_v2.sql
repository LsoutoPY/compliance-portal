-- ============================================================
-- RISCO DE MERCADO V2 — VaR Paramétrico, MC t-Student, B-VaR
-- ============================================================
-- Motivação:
--   Complementa o VaR Histórico existente (var_95_21d) com:
--     • VaR Paramétrico Normal
--     • VaR Monte Carlo t-Student univariado
--     • VaR MC Multivariado (cópula t) — "VaR Diversificado"
--     • B-VaR (excesso vs benchmark)
--   Todos com horizonte de 21 dias úteis, nível 95%.
--   Calculados offline pelo script calcular_var_completo.py.
--
--   Tabelas novas:
--     var_historico_carteira  → série temporal de VaR por carteira
--     var_limites             → limites de VaR por carteira
--     benchmark_cotas         → série histórica de benchmarks
-- ============================================================

-- ── 1. Colunas novas em betas_por_cnpj ──────────────────────

ALTER TABLE betas_por_cnpj
  ADD COLUMN IF NOT EXISTS var_95_param     NUMERIC,
  ADD COLUMN IF NOT EXISTS var_99_param     NUMERIC,
  ADD COLUMN IF NOT EXISTS cvar_95_param    NUMERIC,
  ADD COLUMN IF NOT EXISTS var_95_mc_t      NUMERIC,
  ADD COLUMN IF NOT EXISTS var_99_mc_t      NUMERIC,
  ADD COLUMN IF NOT EXISTS cvar_95_mc_t     NUMERIC,
  ADD COLUMN IF NOT EXISTS var_95_diversif  NUMERIC,
  ADD COLUMN IF NOT EXISTS cvar_95_diversif NUMERIC,
  ADD COLUMN IF NOT EXISTS bvar_95          NUMERIC,
  ADD COLUMN IF NOT EXISTS benchmark_cod    TEXT,
  ADD COLUMN IF NOT EXISTS rho_benchmark    NUMERIC,
  ADD COLUMN IF NOT EXISTS tracking_error   NUMERIC,
  ADD COLUMN IF NOT EXISTS mu_diario        NUMERIC,
  ADD COLUMN IF NOT EXISTS sigma_diario     NUMERIC,
  ADD COLUMN IF NOT EXISTS df_t             NUMERIC,
  ADD COLUMN IF NOT EXISTS calculado_em     TIMESTAMPTZ DEFAULT now();

COMMENT ON COLUMN betas_por_cnpj.var_95_param IS
  'VaR Paramétrico Normal 95% horizonte 21d (decimal, negativo=perda). Calculado por calcular_var_completo.py.';
COMMENT ON COLUMN betas_por_cnpj.cvar_95_param IS
  'CVaR Paramétrico 95%: Expected Shortfall analítico Normal.';
COMMENT ON COLUMN betas_por_cnpj.var_95_mc_t IS
  'VaR Monte Carlo t-Student univariado 95% horizonte 21d. Graus de liberdade estimados por MLE.';
COMMENT ON COLUMN betas_por_cnpj.cvar_95_mc_t IS
  'CVaR MC t-Student 95%: média empírica da cauda simulada.';
COMMENT ON COLUMN betas_por_cnpj.var_95_diversif IS
  'VaR MC Multivariado (cópula t) 95% — preserva correlações entre ativos da carteira. NULL até script rodar.';
COMMENT ON COLUMN betas_por_cnpj.bvar_95 IS
  'B-VaR 95%: VaR do excesso retorno fundo − benchmark (decimal, negativo=perda relativa).';
COMMENT ON COLUMN betas_por_cnpj.rho_benchmark IS
  'Correlação histórica retornos diários fundo × benchmark (Pearson).';
COMMENT ON COLUMN betas_por_cnpj.tracking_error IS
  'Tracking error anualizado: desvio-padrão do excesso de retorno × √252.';
COMMENT ON COLUMN betas_por_cnpj.mu_diario IS
  'Retorno médio diário logarítmico estimado sobre a janela de cálculo.';
COMMENT ON COLUMN betas_por_cnpj.sigma_diario IS
  'Volatilidade diária (desvio-padrão log-retorno) sobre a janela de cálculo.';
COMMENT ON COLUMN betas_por_cnpj.df_t IS
  'Graus de liberdade da distribuição t-Student ajustada por MLE aos retornos diários.';
COMMENT ON COLUMN betas_por_cnpj.calculado_em IS
  'Timestamp do último cálculo de VaR V2 para este CNPJ.';

-- ── 2. Tabela var_historico_carteira ────────────────────────

CREATE TABLE IF NOT EXISTS var_historico_carteira (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  cod_cli         INTEGER     NOT NULL,
  data_ref        DATE        NOT NULL,
  var_95_hist     NUMERIC,
  var_95_param    NUMERIC,
  var_95_mc_t     NUMERIC,
  var_95_diversif NUMERIC,
  pl_total        NUMERIC,
  created_at      TIMESTAMPTZ DEFAULT now() NOT NULL,
  UNIQUE (cod_cli, data_ref)
);

CREATE INDEX IF NOT EXISTS idx_var_hist_cart_cod_data
  ON var_historico_carteira (cod_cli, data_ref DESC);

COMMENT ON TABLE var_historico_carteira IS
  'Série temporal de VaR consolidado por carteira (cod_cli). Populada pelo script calcular_var_completo.py.';
COMMENT ON COLUMN var_historico_carteira.var_95_hist IS
  'VaR Histórico 95% ponderado aditivo da carteira nesta data (decimal, negativo=perda).';
COMMENT ON COLUMN var_historico_carteira.var_95_diversif IS
  'VaR MC Multivariado 95% da carteira — inclui diversificação entre fundos.';

-- ── 3. Tabela var_limites ───────────────────────────────────

CREATE TABLE IF NOT EXISTS var_limites (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  cod_cli     INTEGER     NOT NULL UNIQUE,
  limite_95   NUMERIC     NOT NULL DEFAULT 0.05,
  limite_99   NUMERIC     NOT NULL DEFAULT 0.08,
  ativo       BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL
);

COMMENT ON TABLE var_limites IS
  'Limites de VaR (decimal) por carteira. Breach: |VaR 95%| > limite_95. Usado para alertas no módulo de risco de mercado.';
COMMENT ON COLUMN var_limites.limite_95 IS
  'Limite máximo de |VaR 95%| em decimal (ex: 0.05 = 5%). Carteira em breach se ultrapassar.';

-- ── 4. Tabela benchmark_cotas ───────────────────────────────

CREATE TABLE IF NOT EXISTS benchmark_cotas (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  cod         TEXT        NOT NULL,
  data_ref    DATE        NOT NULL,
  valor       NUMERIC     NOT NULL,
  log_retorno NUMERIC,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  UNIQUE (cod, data_ref)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_cotas_cod_data
  ON benchmark_cotas (cod, data_ref DESC);

COMMENT ON TABLE benchmark_cotas IS
  'Série histórica de benchmarks (CDI, IBOV, IMA-B, SMLL, etc.). Populada offline. Usada no cálculo de B-VaR.';
COMMENT ON COLUMN benchmark_cotas.cod IS
  'Código do benchmark: CDI, IBOV, IMA-B, IMA-B5, IMA-B5+, SMLL, SP500, DOLAR.';

-- ── 5. Row Level Security ───────────────────────────────────

ALTER TABLE var_historico_carteira  ENABLE ROW LEVEL SECURITY;
ALTER TABLE var_limites             ENABLE ROW LEVEL SECURITY;
ALTER TABLE benchmark_cotas         ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'var_historico_carteira' AND policyname = 'read_all'
  ) THEN
    CREATE POLICY "read_all" ON var_historico_carteira FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'var_limites' AND policyname = 'read_all'
  ) THEN
    CREATE POLICY "read_all" ON var_limites FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'benchmark_cotas' AND policyname = 'read_all'
  ) THEN
    CREATE POLICY "read_all" ON benchmark_cotas FOR SELECT USING (true);
  END IF;
END $$;

-- ── 6. Atualizar vw_risco_mercado_fundos ────────────────────
--    CREATE OR REPLACE VIEW não permite mudar ordem de colunas existentes.
--    Usamos DROP + CREATE para adicionar as novas colunas V2 ao final,
--    mantendo as existentes na mesma ordem.

DROP VIEW IF EXISTS vw_risco_mercado_fundos CASCADE;

CREATE VIEW vw_risco_mercado_fundos AS
SELECT
  -- ── colunas existentes (ordem preservada) ──
  pd.cod_cli,
  pd.data_posicao,
  pd.nom_atv,
  pd.nom_estr,
  pd.cnpj,
  pd.cnpj_status,
  pd.sld_lqd,
  bc.var_95_21d,
  bc.var_99_21d,
  bc.pior_21d_pct,
  bc.qualidade       AS beta_qualidade,
  bc.r2              AS beta_r2,
  bc.n_obs           AS beta_n_obs,
  bc.n_obs_21d,
  bc.b_cdi,
  bc.b_ibov,
  bc.b_dolar,
  bc.b_sp500,
  bc.b_imab,
  bc.b_imab5,
  bc.b_imab5p,
  -- ── colunas adicionadas na migration 20260426 ──
  bc.cvar_95_21d,
  bc.cvar_99_21d,
  -- ── colunas V2 novas (NULL até calcular_var_completo.py rodar) ──
  bc.var_95_param,
  bc.var_99_param,
  bc.cvar_95_param,
  bc.var_95_mc_t,
  bc.var_99_mc_t,
  bc.cvar_95_mc_t,
  bc.var_95_diversif,
  bc.cvar_95_diversif,
  bc.bvar_95,
  bc.benchmark_cod,
  bc.rho_benchmark,
  bc.tracking_error,
  bc.mu_diario,
  bc.sigma_diario,
  bc.df_t,
  bc.calculado_em
FROM posicao_diaria pd
LEFT JOIN betas_por_cnpj bc
  ON bc.cnpj = pd.cnpj
 AND pd.cnpj_status IN ('OK', 'DUPLICADO_14D')
WHERE pd.sld_lqd > 0;

COMMENT ON VIEW vw_risco_mercado_fundos IS
  'Posições diárias enriquecidas com betas e VaR por CNPJ. V2 inclui VaR Paramétrico, MC t-Student e B-VaR.';
