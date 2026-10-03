-- ============================================================
-- Risco de Mercado — tabela consolidada por fundo (CNPJ)
-- ============================================================
-- fundos_metricas_mercado é a tabela de leitura do módulo de
-- risco de mercado para a visão "Fundos". Ela é populada
-- exclusivamente pelo script offline:
--   scripts/atualizar-betas-por-cnpj.py
--
-- Separa conceitualmente as métricas de risco de mercado do
-- catálogo completo de betas (betas_por_cnpj), facilitando
-- leitura, cache e versionamento independente.
-- ============================================================

CREATE TABLE IF NOT EXISTS fundos_metricas_mercado (
  cnpj                  TEXT        PRIMARY KEY,
  nome_fundo            TEXT,
  -- VaR Histórico 21d (percentil empírico da série CVM)
  var_95_21d            NUMERIC,    -- 5º percentil retornos 21d  (decimal, neg = perda)
  var_99_21d            NUMERIC,    -- 1º percentil retornos 21d
  -- Pior janela de 21d observada na série histórica
  pior_21d_pct          NUMERIC,    -- em % (negativo = perda)
  -- Drawdown calculado sobre os últimos 252 pontos da série CVM
  drawdown_atual_pct    NUMERIC,    -- (pico - cota_atual) / pico × 100  (positivo)
  drawdown_max_252d_pct NUMERIC,    -- pior drawdown corrido dos últimos 252d (positivo)
  -- Observações
  n_obs_21d             INTEGER,    -- nº de janelas 21d usadas no VaR
  data_base_calculo     DATE,       -- data da última cota usada no cálculo
  -- Qualidade da regressão beta (usado como proxy de confiança do fundo)
  qualidade             TEXT,       -- USAR | REVISAR | FALLBACK
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE fundos_metricas_mercado IS
  'Métricas de risco de mercado por CNPJ de fundo. Populada pelo script atualizar-betas-por-cnpj.py. Usada pelo edge function buscar-risco-mercado-v2.';

COMMENT ON COLUMN fundos_metricas_mercado.var_95_21d IS
  'VaR Histórico 95% horizonte 21d: 5º percentil empírico da série de retornos 21d da CVM. Decimal negativo = perda. Requer n_obs_21d >= 100.';

COMMENT ON COLUMN fundos_metricas_mercado.drawdown_atual_pct IS
  'Drawdown atual em relação ao pico dos últimos 252 pontos da série CVM. Positivo = abaixo do pico.';

ALTER TABLE fundos_metricas_mercado ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all on fundos_metricas_mercado"
  ON fundos_metricas_mercado FOR ALL
  USING (true) WITH CHECK (true);

-- View auxiliar: une exposição atual (posicao_diaria) com métricas do fundo
-- e faz fallback para betas_por_cnpj quando fundos_metricas_mercado está vazio.
CREATE OR REPLACE VIEW vw_risco_mercado_fundos_v2 AS
SELECT
  COALESCE(fmm.cnpj, bc.cnpj)              AS cnpj,
  COALESCE(fmm.nome_fundo, bc.nome_fundo)  AS nome_fundo,
  COALESCE(fmm.var_95_21d, bc.var_95_21d)  AS var_95_21d,
  COALESCE(fmm.var_99_21d, bc.var_99_21d)  AS var_99_21d,
  COALESCE(fmm.pior_21d_pct, bc.pior_21d_pct) AS pior_21d_pct,
  fmm.drawdown_atual_pct,
  fmm.drawdown_max_252d_pct,
  COALESCE(fmm.n_obs_21d, bc.n_obs_21d)    AS n_obs_21d,
  fmm.data_base_calculo,
  COALESCE(fmm.qualidade, bc.qualidade)    AS qualidade
FROM betas_por_cnpj bc
FULL OUTER JOIN fundos_metricas_mercado fmm USING (cnpj);

COMMENT ON VIEW vw_risco_mercado_fundos_v2 IS
  'Métricas de risco por CNPJ: usa fundos_metricas_mercado quando disponível, fallback para betas_por_cnpj.';
