-- ============================================================
-- Risco de Mercado Fundos — Qualidade da Série (alertas automáticos)
-- ============================================================
-- Objetivo: separar "cálculo matemático do VaR" de "confiabilidade econômica
-- da série de cotas". Esta camada marca automaticamente séries suspeitas.
--
-- Regras principais (suspeita quando qualquer uma ocorrer):
-- - drawdown > 50%
-- - evento extremo de retorno diário (> 50%) observado e filtrado
-- - evento extremo de retorno 21d (> 50%) observado e filtrado
-- - possível quebra de série (gap elevado entre observações)
-- - série híbrida manual+XML (proxy de troca de CNPJ/estrutura)
-- - histórico insuficiente
-- ============================================================

ALTER TABLE public.risco_mercado_fundos_diario
  ADD COLUMN IF NOT EXISTS qualidade_serie_status  TEXT,
  ADD COLUMN IF NOT EXISTS serie_suspeita          BOOLEAN,
  ADD COLUMN IF NOT EXISTS serie_alertas           TEXT[],
  ADD COLUMN IF NOT EXISTS serie_extremos_1d       INTEGER,
  ADD COLUMN IF NOT EXISTS serie_extremos_21d      INTEGER,
  ADD COLUMN IF NOT EXISTS serie_maior_gap_dias    INTEGER,
  ADD COLUMN IF NOT EXISTS serie_hist_baixo        BOOLEAN,
  ADD COLUMN IF NOT EXISTS serie_quebra_detectada  BOOLEAN,
  ADD COLUMN IF NOT EXISTS serie_troca_cnpj        BOOLEAN;

ALTER TABLE public.risco_mercado_fundos_diario
  DROP CONSTRAINT IF EXISTS risco_mercado_fundos_diario_qualidade_serie_status_chk,
  ADD CONSTRAINT risco_mercado_fundos_diario_qualidade_serie_status_chk
  CHECK (qualidade_serie_status IS NULL OR qualidade_serie_status IN ('ok', 'suspeita', 'sem_dados'));

COMMENT ON COLUMN public.risco_mercado_fundos_diario.qualidade_serie_status IS
  'Qualidade econômica da série de cotas: ok | suspeita | sem_dados.';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.serie_suspeita IS
  'TRUE quando qualquer gatilho de série suspeita é acionado.';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.serie_alertas IS
  'Lista de códigos dos gatilhos acionados (ex.: dd_gt_50, ret_1d_extremo, ret_21d_extremo, quebra_serie, troca_cnpj, historico_baixo).';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.serie_extremos_1d IS
  'Quantidade de retornos diários extremos (|ret| > 50%) detectados no histórico observado.';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.serie_extremos_21d IS
  'Quantidade de retornos rolling 21d extremos (|ret_21d| > 50%) detectados no histórico observado.';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.serie_maior_gap_dias IS
  'Maior gap em dias corridos entre observações consecutivas de cota no histórico observado.';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.serie_hist_baixo IS
  'TRUE quando n_obs (diário) ou n_obs_21d (janelas) está abaixo do mínimo para robustez.';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.serie_quebra_detectada IS
  'TRUE quando foi detectado gap elevado sugerindo possível quebra de série.';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.serie_troca_cnpj IS
  'TRUE quando há proxy de troca de CNPJ/estrutura (ex.: série híbrida manual+XML).';

-- Recria view para propagar novas colunas (SELECT * em view não se atualiza sozinho)
CREATE OR REPLACE VIEW public.vw_risco_mercado_fundos_diario_atual AS
SELECT DISTINCT ON (cnpj) *
FROM public.risco_mercado_fundos_diario
ORDER BY cnpj, data_ref DESC;
