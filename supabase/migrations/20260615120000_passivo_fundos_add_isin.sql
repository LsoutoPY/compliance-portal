-- Adiciona ISIN da subclasse em passivo_fundos (par CNPJ + ISIN, alinhado à carteira)

ALTER TABLE passivo_fundos
  ADD COLUMN IF NOT EXISTS fundo_isin TEXT;

CREATE INDEX IF NOT EXISTS idx_passivo_fundos_fundo_isin
  ON passivo_fundos (fundo_isin)
  WHERE fundo_isin IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_passivo_fundos_cnpj_isin
  ON passivo_fundos (fundo_cnpj, fundo_isin)
  WHERE fundo_cnpj IS NOT NULL;

COMMENT ON COLUMN passivo_fundos.fundo_isin IS 'ISIN da subclasse/cota — resolvido via fundos_caracteristicas ou posicao_carteira na importação';
