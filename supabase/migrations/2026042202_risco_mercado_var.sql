-- ============================================================
-- RISCO DE MERCADO — VaR Histórico por CNPJ
-- ============================================================
-- Motivação:
--   O cálculo de stress (choques sobre cenários) e o VaR Histórico
--   são complementares:
--     • Stress    → pergunta "e se X chocar Y%?" (cenário determinístico)
--     • VaR 95%   → pergunta "qual a perda máxima em 95% dos dias?"
--                   (distribuição histórica de retornos 21d)
--
--   Adicionamos var_95_21d e var_99_21d em betas_por_cnpj (calculados
--   offline pelo script Python) e criamos uma view de apoio para o
--   Edge Function buscar-risco-mercado.
-- ============================================================

-- 1. Colunas de VaR em betas_por_cnpj ----------------------------
ALTER TABLE betas_por_cnpj
  ADD COLUMN IF NOT EXISTS var_95_21d  NUMERIC,   -- 5º percentil retornos 21d (decimal, negativo = perda)
  ADD COLUMN IF NOT EXISTS var_99_21d  NUMERIC,   -- 1º percentil retornos 21d (decimal, negativo = perda)
  ADD COLUMN IF NOT EXISTS n_obs_21d   INTEGER;   -- nº de observações 21d usadas no cálculo

COMMENT ON COLUMN betas_por_cnpj.var_95_21d IS
  'VaR Histórico 95% horizonte 21d úteis: 5º percentil da série de retornos 21d. Negativo = perda. Calculado pelo script atualizar-betas-por-cnpj.py.';
COMMENT ON COLUMN betas_por_cnpj.var_99_21d IS
  'VaR Histórico 99% horizonte 21d úteis: 1º percentil. Requer n_obs_21d >= 200 para ser calculado.';
COMMENT ON COLUMN betas_por_cnpj.n_obs_21d IS
  'Nº de janelas de 21 dias úteis disponíveis na série histórica para o cálculo de VaR.';

-- 2. View: risco de mercado por posição de fundo ------------------
--    Une posicao_diaria com betas_por_cnpj para facilitar
--    o Edge Function sem joins complexos no Postgres.
CREATE OR REPLACE VIEW vw_risco_mercado_fundos AS
SELECT
  pd.cod_cli,
  pd.data_posicao,
  pd.nom_atv,
  pd.nom_estr,
  pd.cnpj,
  pd.cnpj_status,
  pd.sld_lqd,
  -- betas e VaR (NULL quando CNPJ não mapeado ou sem histórico)
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
  bc.b_imab5p
FROM posicao_diaria pd
LEFT JOIN betas_por_cnpj bc
  ON bc.cnpj = pd.cnpj
 AND pd.cnpj_status IN ('OK', 'DUPLICADO_14D')
WHERE pd.sld_lqd > 0;
