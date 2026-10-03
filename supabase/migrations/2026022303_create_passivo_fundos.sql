-- Migration: Create passivo_fundos table
-- Description: Unified table for fund liability (cotista) data from multiple sources:
--   - FINVEST WM, FINVEST Growth (CSV)
--   - BTG (CSV)
--   - Posição Cotas (XLSX posicao_cotas_fundo_*.xlsx)
-- Used for concentration analysis (Top 5 cotistas) in Liquidez module

CREATE TABLE IF NOT EXISTS passivo_fundos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  administradora TEXT NOT NULL,
  fundo TEXT NOT NULL,
  fundo_cnpj TEXT,
  cotista TEXT NOT NULL,
  valor NUMERIC NOT NULL,
  data_posicao TEXT NOT NULL,
  criado_em TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT passivo_fundos_valor_positive CHECK (valor > 0)
);

-- Unique constraint: one row per (administradora, fundo, cotista, data_posicao)
-- When re-importing same source/date, we replace (upsert by deleting + inserting)
CREATE UNIQUE INDEX IF NOT EXISTS idx_passivo_fundos_unique
  ON passivo_fundos (administradora, fundo, cotista, data_posicao);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_passivo_fundos_fundo ON passivo_fundos(fundo);
CREATE INDEX IF NOT EXISTS idx_passivo_fundos_fundo_cnpj ON passivo_fundos(fundo_cnpj);
CREATE INDEX IF NOT EXISTS idx_passivo_fundos_data_posicao ON passivo_fundos(data_posicao);
CREATE INDEX IF NOT EXISTS idx_passivo_fundos_administradora ON passivo_fundos(administradora);

-- Enable RLS
ALTER TABLE passivo_fundos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on passivo_fundos"
  ON passivo_fundos
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Comments
COMMENT ON TABLE passivo_fundos IS 'Unified fund liability (cotista) data from FINVEST, BTG, Posição Cotas and other sources';
COMMENT ON COLUMN passivo_fundos.administradora IS 'Source: FINVEST, Finvest.Growth, BTG, Posição Cotas';
COMMENT ON COLUMN passivo_fundos.fundo IS 'Fund name as in source file';
COMMENT ON COLUMN passivo_fundos.fundo_cnpj IS 'Fund CNPJ (14 digits) - optional, can be matched later';
COMMENT ON COLUMN passivo_fundos.cotista IS 'Investor/cotista name';
COMMENT ON COLUMN passivo_fundos.valor IS 'Position value (BRL)';
COMMENT ON COLUMN passivo_fundos.data_posicao IS 'Position date YYYYMMDD';
