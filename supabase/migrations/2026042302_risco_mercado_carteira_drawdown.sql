-- ============================================================
-- Risco de Mercado — métricas adicionais para carteiras
-- ============================================================
-- Adiciona drawdown e pior retorno 21d a controle_cotas_metricas
-- Essas colunas são preenchidas pelo edge function
-- recalculate-controle-cotas-metricas (a partir desta migration).
--
-- Também cria a view vw_risco_mercado_carteiras que entrega a
-- linha mais recente por cliente, já enriquecida com cod_cli e
-- grupo via JOIN com carteiras.
-- ============================================================

-- 1. Novas colunas em controle_cotas_metricas ─────────────────

ALTER TABLE controle_cotas_metricas
  ADD COLUMN IF NOT EXISTS drawdown_atual_pct    NUMERIC,
  ADD COLUMN IF NOT EXISTS drawdown_max_252d_pct NUMERIC,
  ADD COLUMN IF NOT EXISTS pior_21d_pct          NUMERIC;

COMMENT ON COLUMN controle_cotas_metricas.drawdown_atual_pct IS
  'Drawdown da carteira em relação ao pico máximo dos últimos 252 dias úteis: (pico - cota) / pico × 100. Positivo = abaixo do pico.';

COMMENT ON COLUMN controle_cotas_metricas.drawdown_max_252d_pct IS
  'Pior drawdown observado nos últimos 252 dias úteis (máximo do drawdown pico-a-ponto): calculado com running-max corrido. Positivo.';

COMMENT ON COLUMN controle_cotas_metricas.pior_21d_pct IS
  'Pior retorno simples de 21 dias úteis observado na janela dos últimos 252 pontos: min(retorno_ate_21d_simples) × 100. Negativo = perda.';

-- 2. View: última métrica por carteira ────────────────────────

CREATE OR REPLACE VIEW vw_risco_mercado_carteiras AS
SELECT DISTINCT ON (ccm.cliente)
  ccm.cliente,
  ccm.data_posicao,
  -- VaR mensal EWMA 95 %
  ccm.var_mes_95,
  -- Drawdown
  ccm.drawdown_atual_pct,
  ccm.drawdown_max_252d_pct,
  -- Pior 21d
  ccm.pior_21d_pct,
  -- Retorno corrente 21d simples (informativo)
  ccm.retorno_ate_21d_simples,
  -- Volatilidade
  ccm.desvio_padrao_janela,
  -- Alerta 3σ
  ccm.alerta_3sigma,
  -- Link com módulo de stress
  c.cod_cli,
  c.grupo
FROM controle_cotas_metricas ccm
LEFT JOIN carteiras c
  ON c.nome = ccm.cliente
  OR c.cod_cli::text = ccm.cliente
ORDER BY ccm.cliente, ccm.data_posicao DESC;

COMMENT ON VIEW vw_risco_mercado_carteiras IS
  'Última linha de controle_cotas_metricas por cliente, enriquecida com cod_cli e grupo via JOIN com carteiras. Usada pelo edge function buscar-risco-mercado-v2.';
