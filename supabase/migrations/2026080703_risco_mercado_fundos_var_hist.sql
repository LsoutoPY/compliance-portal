-- VaR Histórico 95% (21d) na aba Fundos simplificada
-- 5º percentil empírico dos retornos rolling 21d — mesma convenção de fundos_metricas_mercado

ALTER TABLE public.risco_mercado_fundos_diario
  ADD COLUMN IF NOT EXISTS var_95_hist_pct  NUMERIC,
  ADD COLUMN IF NOT EXISTS var_95_hist_rs   NUMERIC,
  ADD COLUMN IF NOT EXISTS n_obs_21d        INTEGER;

COMMENT ON COLUMN public.risco_mercado_fundos_diario.var_95_hist_pct IS
  'VaR Histórico 95% horizonte 21d: 5º percentil dos retornos rolling 21d (negativo = perda). '
  'Mesma convenção do módulo legado (×100 para exibição). Mínimo 100 janelas 21d.';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.var_95_hist_rs IS
  'VaR Histórico 95% em R$ (PL × var_95_hist_pct / 100).';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.n_obs_21d IS
  'Nº de janelas rolling 21d usadas no VaR Histórico nesta data.';
