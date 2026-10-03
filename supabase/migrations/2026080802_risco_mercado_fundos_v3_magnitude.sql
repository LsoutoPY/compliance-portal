-- ============================================================
-- Risco de Mercado — Padronização V3 (FIC/FIDC): metodologia única
-- ============================================================
-- Contexto: até esta migration, var_95_hist_pct armazenava o quantil bruto
-- do 5º percentil dos retornos 21d (podendo ser POSITIVO), e var_95_param_pct
-- usava z=1,65 com sinal negativo. A partir de agora a convenção OFICIAL é
-- MAGNITUDE POSITIVA DE PERDA para as duas métricas, com horizonte explícito
-- no nome do campo:
--
--   var_95_param_1d_pct  = Z_95 × sigma_diario                  (Z_95 = 1,645)
--   var_95_hist_21d_pct  = max(0, -percentil_5(retornos_21d))   (nunca negativo)
--
-- Os campos legados (var_95_param_pct/rs, var_95_hist_pct/rs) são mantidos e
-- continuam populados pela edge function com os MESMOS valores (mesma
-- convenção positiva), apenas para não quebrar consumidores existentes.
-- Considerar @deprecated — não usar em novos consumidores.
-- ============================================================

ALTER TABLE public.risco_mercado_fundos_diario
  ADD COLUMN IF NOT EXISTS var_95_param_1d_pct  NUMERIC,
  ADD COLUMN IF NOT EXISTS var_95_param_1d_rs   NUMERIC,
  ADD COLUMN IF NOT EXISTS var_95_hist_21d_pct  NUMERIC,
  ADD COLUMN IF NOT EXISTS var_95_hist_21d_rs   NUMERIC;

-- CHECK apenas nas colunas novas (não retroagir sobre linhas antigas com
-- convenção anterior nos campos legados, que podem ter valores negativos).
ALTER TABLE public.risco_mercado_fundos_diario
  DROP CONSTRAINT IF EXISTS risco_mercado_fundos_diario_var_param_1d_nonneg,
  ADD CONSTRAINT risco_mercado_fundos_diario_var_param_1d_nonneg
    CHECK (var_95_param_1d_pct IS NULL OR var_95_param_1d_pct >= 0);

ALTER TABLE public.risco_mercado_fundos_diario
  DROP CONSTRAINT IF EXISTS risco_mercado_fundos_diario_var_hist_21d_nonneg,
  ADD CONSTRAINT risco_mercado_fundos_diario_var_hist_21d_nonneg
    CHECK (var_95_hist_21d_pct IS NULL OR var_95_hist_21d_pct >= 0);

COMMENT ON COLUMN public.risco_mercado_fundos_diario.var_95_param_1d_pct IS
  'OFICIAL V3. VaR Paramétrico 95% horizonte 1 DIA ÚTIL = Z_95 × sigma_diario, Z_95=1,645. '
  'Convenção: magnitude POSITIVA de perda (ex.: 0,13 = 0,13% de perda potencial). '
  'Sem média, sem raiz de 21, sem horizonte 21d. Requer >= 20 retornos diários (min_obs_sigma).';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.var_95_param_1d_rs IS
  'VaR Paramétrico 95% 1d em R$ (PL × var_95_param_1d_pct / 100). Magnitude positiva.';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.var_95_hist_21d_pct IS
  'OFICIAL V3. VaR Histórico 95% horizonte 21 DIAS ÚTEIS = max(0, -percentil_5(retornos_21d)). '
  'Convenção: magnitude POSITIVA de perda; NUNCA negativo (se o percentil 5% dos retornos '
  '21d for positivo, o VaR é 0). Requer >= 100 janelas rolling 21d (n_obs_21d).';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.var_95_hist_21d_rs IS
  'VaR Histórico 95% 21d em R$ (PL × var_95_hist_21d_pct / 100). Magnitude positiva; nunca negativo.';

COMMENT ON COLUMN public.risco_mercado_fundos_diario.var_95_param_pct IS
  '@deprecated — usar var_95_param_1d_pct. Mantido por compatibilidade; a partir desta '
  'migration passa a receber o MESMO valor (magnitude positiva, Z_95=1,645, horizonte 1d). '
  'Linhas gravadas ANTES desta migration podem conter valores negativos (Z=1,65).';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.var_95_param_rs IS
  '@deprecated — usar var_95_param_1d_rs. Mesma ressalva de linhas históricas pré-migration.';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.var_95_hist_pct IS
  '@deprecated — usar var_95_hist_21d_pct. Mantido por compatibilidade; a partir desta '
  'migration passa a receber o MESMO valor (magnitude positiva, nunca negativo). Linhas '
  'gravadas ANTES desta migration podem conter o quantil BRUTO (podendo ser positivo ou '
  'negativo, sem inversão de sinal) — não confiar em valores históricos para auditoria.';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.var_95_hist_rs IS
  '@deprecated — usar var_95_hist_21d_rs. Mesma ressalva de linhas históricas pré-migration.';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.n_obs_21d IS
  'Número de JANELAS rolling de 21 dias efetivamente utilizadas no cálculo do percentil do '
  'VaR Histórico 21d (não é número de dias/observações de cota!). Para N janelas são '
  'necessários N + 21 retornos diários = N + 22 observações de cota/preço.';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.n_obs IS
  'Número de RETORNOS DIÁRIOS usados na janela de sigma / VaR Paramétrico 1d (máximo 252).';

-- ============================================================
-- IMPORTANTE: CREATE VIEW ... SELECT * "congela" a lista de colunas no
-- momento da criação. Como acabamos de ALTER TABLE ADD COLUMN acima, a
-- view vw_risco_mercado_fundos_diario_atual (criada em 20260806) NÃO
-- passa a expor as colunas novas automaticamente — é preciso recriá-la
-- explicitamente sempre que a tabela base ganhar colunas.
-- ============================================================

CREATE OR REPLACE VIEW public.vw_risco_mercado_fundos_diario_atual AS
SELECT DISTINCT ON (cnpj) *
FROM public.risco_mercado_fundos_diario
ORDER BY cnpj, data_ref DESC;

COMMENT ON VIEW public.vw_risco_mercado_fundos_diario_atual IS
  'Última linha de risco_mercado_fundos_diario por CNPJ. '
  'Usada pelo frontend para montar a tabela principal da aba Fundos simplificada. '
  'Recriar (CREATE OR REPLACE VIEW ... SELECT *) sempre que novas colunas forem '
  'adicionadas à tabela base — SELECT * não propaga automaticamente.';
