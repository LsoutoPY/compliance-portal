-- VaR assimétrico (Non-Central t) — piloto para fundos com skewness negativa
-- 4º método indicativo; não substitui var_95_21d nem var_95_mc_t

ALTER TABLE betas_por_cnpj
  ADD COLUMN IF NOT EXISTS var_95_asm           NUMERIC,
  ADD COLUMN IF NOT EXISTS var_99_asm           NUMERIC,
  ADD COLUMN IF NOT EXISTS cvar_95_asm          NUMERIC,
  ADD COLUMN IF NOT EXISTS df_asm              NUMERIC,
  ADD COLUMN IF NOT EXISTS nc_asm              NUMERIC,
  ADD COLUMN IF NOT EXISTS skewness_ret        NUMERIC,
  ADD COLUMN IF NOT EXISTS kurtosis_ret        NUMERIC,
  ADD COLUMN IF NOT EXISTS qualidade_ajuste_asm TEXT;

COMMENT ON COLUMN betas_por_cnpj.var_95_asm IS
  'VaR 95% piloto com t-Student assimétrica (NCT), horizonte 21d. '
  'Preenchido apenas quando skewness_ret < 0. Método indicativo — preferir var_95_21d.';

COMMENT ON COLUMN betas_por_cnpj.nc_asm IS
  'Non-centrality da NCT. Negativo = cauda esquerda mais pesada (típico crédito).';

COMMENT ON COLUMN betas_por_cnpj.qualidade_ajuste_asm IS
  'Qualidade do ajuste NCT (KS in-sample): bom | aceitavel | fraco. '
  'Quando fraco, usar var_95_21d como referência principal.';
