-- Migration: Create controle_cotas tables
-- Description: Tabelas para controle diário de cotas por cliente
-- Inclui raw import, série histórica normalizada e métricas estatísticas de risco

-- ─────────────────────────────────────────────────────────────────────────────
-- Tabela 1: controle_cotas_import_raw
-- Armazena cada linha exatamente como importada do relatório "Consulta Cotas Carteira por Data"
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS controle_cotas_import_raw (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data_posicao          DATE NOT NULL,
  codigo_smart          TEXT,
  cliente               TEXT,
  movimento             NUMERIC,
  patrimonio_bruto      NUMERIC,
  valor_cota            NUMERIC,
  quantidade_cotas      NUMERIC,
  patrimonio_pos_taxas  NUMERIC,
  rentabilidade_dia_pct NUMERIC,
  tx_fixa_diaria        NUMERIC,
  tx_fixa_acumulada     NUMERIC,
  tx_gestao_diaria      NUMERIC,
  tx_gestao_acumulada   NUMERIC,
  perf_fee_diaria       NUMERIC,
  perf_fee_estoque      NUMERIC,
  perf_fee_a_pagar      NUMERIC,
  modalidade            TEXT,
  arquivo_origem        TEXT,
  imported_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ccraw_data_posicao  ON controle_cotas_import_raw(data_posicao);
CREATE INDEX IF NOT EXISTS idx_ccraw_cliente        ON controle_cotas_import_raw(cliente);
CREATE INDEX IF NOT EXISTS idx_ccraw_codigo_smart   ON controle_cotas_import_raw(codigo_smart);

ALTER TABLE controle_cotas_import_raw ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on controle_cotas_import_raw"
  ON controle_cotas_import_raw
  FOR ALL
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE controle_cotas_import_raw IS
  'Dados brutos importados do relatório "Consulta Cotas Carteira por Data" — uma linha por registro do arquivo';

-- ─────────────────────────────────────────────────────────────────────────────
-- Tabela 2: controle_cotas_serie
-- Série histórica normalizada: uma linha por cliente + data_posicao
-- Reimportação da mesma data/cliente faz upsert (sem duplicar)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS controle_cotas_serie (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente               TEXT NOT NULL,
  codigo_smart          TEXT,
  data_posicao          DATE NOT NULL,
  valor_cota            NUMERIC,
  patrimonio_bruto      NUMERIC,
  quantidade_cotas      NUMERIC,
  rentabilidade_dia_pct NUMERIC,
  modalidade            TEXT,
  arquivo_origem        TEXT,
  imported_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (cliente, data_posicao)
);

CREATE INDEX IF NOT EXISTS idx_ccserie_cliente       ON controle_cotas_serie(cliente);
CREATE INDEX IF NOT EXISTS idx_ccserie_data_posicao  ON controle_cotas_serie(data_posicao);
CREATE INDEX IF NOT EXISTS idx_ccserie_codigo_smart  ON controle_cotas_serie(codigo_smart);

ALTER TABLE controle_cotas_serie ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on controle_cotas_serie"
  ON controle_cotas_serie
  FOR ALL
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE controle_cotas_serie IS
  'Série histórica normalizada de cotas por cliente — uma linha por (cliente, data_posicao), base para cálculo de métricas';
COMMENT ON COLUMN controle_cotas_serie.valor_cota IS
  'Valor da cota na data_posicao; usado como base para retornos logarítmicos';

-- ─────────────────────────────────────────────────────────────────────────────
-- Tabela 3: controle_cotas_metricas
-- Métricas estatísticas e de risco calculadas por cliente + data
-- Recalculada automaticamente a cada importação para os clientes impactados
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS controle_cotas_metricas (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente                TEXT NOT NULL,
  data_posicao           DATE NOT NULL,
  -- Retorno logarítmico diário: ln(cota_t / cota_{t-1})
  retorno_ln_1d          NUMERIC,
  -- Estatísticas da janela de 20 retornos
  retorno_medio_janela   NUMERIC,
  desvio_padrao_janela   NUMERIC,
  qtd_obs_janela         INTEGER,
  -- Retorno acumulado 21 dias úteis
  retorno_21d_ln         NUMERIC,
  retorno_21d_simples    NUMERIC,
  -- Alerta: |retorno_atual - media| > 3 * desvio
  alerta_3sigma          BOOLEAN,
  -- Volatilidade EWMA: sqrt(0.94*sigma_{t-1}^2 + 0.06*r_t^2)
  ewma_vol               NUMERIC,
  -- VaR mensal 95%: media + ewma_vol * sqrt(21) * z_95
  var_mes_95             NUMERIC,
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (cliente, data_posicao)
);

CREATE INDEX IF NOT EXISTS idx_ccmet_cliente       ON controle_cotas_metricas(cliente);
CREATE INDEX IF NOT EXISTS idx_ccmet_data_posicao  ON controle_cotas_metricas(data_posicao);
CREATE INDEX IF NOT EXISTS idx_ccmet_alerta        ON controle_cotas_metricas(alerta_3sigma) WHERE alerta_3sigma = TRUE;

ALTER TABLE controle_cotas_metricas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on controle_cotas_metricas"
  ON controle_cotas_metricas
  FOR ALL
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE controle_cotas_metricas IS
  'Métricas estatísticas e de risco calculadas por (cliente, data_posicao) — janela 20 retornos, EWMA e VaR 95% mensal';
COMMENT ON COLUMN controle_cotas_metricas.ewma_vol IS
  'Volatilidade EWMA com fator de decaimento λ=0.94 (RiskMetrics)';
COMMENT ON COLUMN controle_cotas_metricas.var_mes_95 IS
  'Value at Risk mensal 95% = media + ewma_vol * sqrt(21) * (-1.64485...) — expresso como retorno logarítmico';
COMMENT ON COLUMN controle_cotas_metricas.alerta_3sigma IS
  'TRUE quando |retorno_ln_1d - retorno_medio_janela| > 3 * desvio_padrao_janela';
