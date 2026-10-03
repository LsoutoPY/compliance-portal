-- Migration: Create resgates_movimentacoes table
-- Description: Histórico de movimentações (resgates) importado de planilhas passivo.relatório.movimentações
-- Usado para análise de liquidez e integração com calculo-risco-liquidez (resgates_por_vertice)

CREATE TABLE IF NOT EXISTS resgates_movimentacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fonte TEXT NOT NULL DEFAULT 'passivo_movimentacoes',
  fundo TEXT NOT NULL,
  fundo_cnpj TEXT,
  cotista TEXT NOT NULL,
  valor NUMERIC NOT NULL,
  data_impacto DATE NOT NULL,
  data_operacao DATE,
  data_boleta DATE,
  tipo_movimento TEXT,
  dias_ate_pagamento INTEGER,
  vertice INTEGER,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resgates_movimentacoes_fundo ON resgates_movimentacoes(fundo);
CREATE INDEX IF NOT EXISTS idx_resgates_movimentacoes_fundo_cnpj ON resgates_movimentacoes(fundo_cnpj);
CREATE INDEX IF NOT EXISTS idx_resgates_movimentacoes_data_impacto ON resgates_movimentacoes(data_impacto);
CREATE INDEX IF NOT EXISTS idx_resgates_movimentacoes_vertice ON resgates_movimentacoes(vertice);

ALTER TABLE resgates_movimentacoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on resgates_movimentacoes"
  ON resgates_movimentacoes
  FOR ALL
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE resgates_movimentacoes IS 'Histórico de resgates/movimentações importado de planilhas passivo.relatório.movimentações';
COMMENT ON COLUMN resgates_movimentacoes.fonte IS 'Origem do arquivo: passivo_movimentacoes, BTG, etc.';
COMMENT ON COLUMN resgates_movimentacoes.dias_ate_pagamento IS 'Dias úteis entre data de referência e data impacto (null se < 0)';
COMMENT ON COLUMN resgates_movimentacoes.vertice IS 'Vértice ANBIMA (1, 2, 3, 4, 5, 10, 21, 42, 63, 122, 126, 180, 365, 504, 720, 1260)';
