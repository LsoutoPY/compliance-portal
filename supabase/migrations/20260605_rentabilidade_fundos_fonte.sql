-- ============================================================
-- Adiciona coluna `fonte` em rentabilidade_fundos
-- para rastreabilidade de dados manuais vs CVM vs XML
-- ============================================================

ALTER TABLE rentabilidade_fundos
  ADD COLUMN IF NOT EXISTS fonte TEXT DEFAULT 'cvm_inf_diario';

COMMENT ON COLUMN rentabilidade_fundos.fonte IS
  'Origem dos dados: cvm_inf_diario | xml_posicao_carteira | historico_manual';

CREATE INDEX IF NOT EXISTS idx_rentabilidade_fonte
  ON rentabilidade_fundos(fonte);

-- Preenche registros existentes que ficaram NULL pelo DEFAULT
UPDATE rentabilidade_fundos
SET fonte = 'cvm_inf_diario'
WHERE fonte IS NULL;
