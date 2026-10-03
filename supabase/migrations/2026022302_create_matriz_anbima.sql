-- Migration: Create matriz_anbima table
-- Description: Stores ANBIMA liquidity risk reference parameters (probability/average redemptions per group)
-- Used to compare fund liability behavior with market benchmarks
-- Data updated monthly from ANBIMA website

CREATE TABLE IF NOT EXISTS matriz_anbima (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data_ref DATE NOT NULL,
  periodo TEXT NOT NULL,
  classe TEXT NOT NULL,
  segmento_investidor TEXT NOT NULL,
  tipo_metodologia TEXT NOT NULL,
  metrica TEXT NOT NULL,
  prazo INTEGER NOT NULL,
  valor NUMERIC NOT NULL,
  criado_em TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT matriz_anbima_unique UNIQUE (periodo, classe, segmento_investidor, tipo_metodologia, metrica, prazo)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_matriz_anbima_periodo ON matriz_anbima(periodo);
CREATE INDEX IF NOT EXISTS idx_matriz_anbima_classe ON matriz_anbima(classe);
CREATE INDEX IF NOT EXISTS idx_matriz_anbima_segmento ON matriz_anbima(segmento_investidor);
CREATE INDEX IF NOT EXISTS idx_matriz_anbima_prazo ON matriz_anbima(prazo);
CREATE INDEX IF NOT EXISTS idx_matriz_anbima_data_ref ON matriz_anbima(data_ref);

-- Enable RLS
ALTER TABLE matriz_anbima ENABLE ROW LEVEL SECURITY;

-- Policy to allow all operations (adjust as needed for your auth setup)
CREATE POLICY "Allow all operations on matriz_anbima"
  ON matriz_anbima
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Comments
COMMENT ON TABLE matriz_anbima IS 'ANBIMA liquidity risk reference matrix - probability/average redemptions per class/segment/period';
COMMENT ON COLUMN matriz_anbima.data_ref IS 'Reference date (YYYY-MM-DD)';
COMMENT ON COLUMN matriz_anbima.periodo IS 'Period string (e.g. 12/2025)';
COMMENT ON COLUMN matriz_anbima.classe IS 'Fund class (Cambial, Multimercados, Renda Fixa, RF DI, Renda Fixa Crédito, Ações)';
COMMENT ON COLUMN matriz_anbima.segmento_investidor IS 'Investor segment (PJ, VAREJO, PRIVATE, EFPC, INSTITUCIONAIS, OUTROS)';
COMMENT ON COLUMN matriz_anbima.tipo_metodologia IS 'Methodology type (Resgate Dados Consolidados, Captação Líquida Dados Consolidados)';
COMMENT ON COLUMN matriz_anbima.metrica IS 'Metric type (EWMA_94, EWMA_97, media_simples)';
COMMENT ON COLUMN matriz_anbima.prazo IS 'Horizon in business days (1, 2, 3, 4, 5, 10, 21, 42, 63, 126)';
COMMENT ON COLUMN matriz_anbima.valor IS 'Probability/average value (0-1)';
