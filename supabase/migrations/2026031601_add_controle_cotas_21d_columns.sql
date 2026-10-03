-- ============================================================
-- Migration: Campos de apoio para retorno ate 21d no Controle Cotas
-- Objetivo: diferenciar retorno 21d completo de retorno parcial
--           quando ainda nao ha historico suficiente.
-- ============================================================

ALTER TABLE controle_cotas_metricas
  ADD COLUMN IF NOT EXISTS retorno_ate_21d_simples NUMERIC,
  ADD COLUMN IF NOT EXISTS qtd_obs_21d INTEGER,
  ADD COLUMN IF NOT EXISTS janela_21d_completa BOOLEAN;

COMMENT ON COLUMN controle_cotas_metricas.retorno_ate_21d_simples IS
  'Retorno simples acumulado usando a janela disponivel de ate 21 periodos: (cota_atual / cota_base_disponivel) - 1.';

COMMENT ON COLUMN controle_cotas_metricas.qtd_obs_21d IS
  'Quantidade de retornos efetivamente usados na janela de ate 21 periodos.';

COMMENT ON COLUMN controle_cotas_metricas.janela_21d_completa IS
  'TRUE quando a metrica de 21d usa a janela completa de 21 periodos; FALSE quando a janela ainda eh parcial.';
