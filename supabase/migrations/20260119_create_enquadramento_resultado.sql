-- Migration: Create enquadramento_resultado table
-- Description: Stores results of fund compliance rule checks

CREATE TABLE IF NOT EXISTS enquadramento_resultado (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fundo_cnpj TEXT NOT NULL,
  fundo_dtposicao TEXT NOT NULL,
  regra_categoria TEXT NOT NULL,
  regra_codigo TEXT NOT NULL,
  regra_descricao TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'alerta', 'violacao')),
  valor_atual NUMERIC,
  valor_limite NUMERIC,
  detalhes JSONB,
  verificado_em TIMESTAMPTZ DEFAULT NOW(),
  
  -- Constraints
  CONSTRAINT enquadramento_resultado_categoria_check 
    CHECK (regra_categoria IN ('pl', 'concentration', 'liquidity'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_enquadramento_resultado_fundo 
  ON enquadramento_resultado(fundo_cnpj);

CREATE INDEX IF NOT EXISTS idx_enquadramento_resultado_data 
  ON enquadramento_resultado(fundo_dtposicao);

CREATE INDEX IF NOT EXISTS idx_enquadramento_resultado_status 
  ON enquadramento_resultado(status);

CREATE INDEX IF NOT EXISTS idx_enquadramento_resultado_fundo_data 
  ON enquadramento_resultado(fundo_cnpj, fundo_dtposicao);

-- Unique constraint to prevent duplicate checks for same fund/date/rule
CREATE UNIQUE INDEX IF NOT EXISTS idx_enquadramento_resultado_unique 
  ON enquadramento_resultado(fundo_cnpj, fundo_dtposicao, regra_codigo);

-- Enable RLS
ALTER TABLE enquadramento_resultado ENABLE ROW LEVEL SECURITY;

-- Policy to allow all operations (adjust as needed for your auth setup)
CREATE POLICY "Allow all operations on enquadramento_resultado" 
  ON enquadramento_resultado 
  FOR ALL 
  USING (true) 
  WITH CHECK (true);

-- Comments
COMMENT ON TABLE enquadramento_resultado IS 'Stores results of fund compliance rule checks';
COMMENT ON COLUMN enquadramento_resultado.fundo_cnpj IS 'CNPJ of the fund (14 digits, no formatting)';
COMMENT ON COLUMN enquadramento_resultado.fundo_dtposicao IS 'Position date in YYYYMMDD format';
COMMENT ON COLUMN enquadramento_resultado.regra_categoria IS 'Rule category: pl, concentration, liquidity';
COMMENT ON COLUMN enquadramento_resultado.regra_codigo IS 'Unique rule code (e.g., PL_MIN, CONC_EMISSOR_10)';
COMMENT ON COLUMN enquadramento_resultado.status IS 'Result status: ok, alerta, violacao';
COMMENT ON COLUMN enquadramento_resultado.valor_atual IS 'Current value found during check';
COMMENT ON COLUMN enquadramento_resultado.valor_limite IS 'Limit value defined by the rule';
COMMENT ON COLUMN enquadramento_resultado.detalhes IS 'Additional details in JSON format';
