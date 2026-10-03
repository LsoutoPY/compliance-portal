-- Migration: Add fundo_isin discriminator to enquadramento_resultado
-- Description: Allows subclasses of the same CNPJ (e.g. JR/SR FIDCs) to be stored
--              and processed independently. Funds without subclass differentiation
--              use fundo_isin = '' (empty string), preserving backward compatibility.

ALTER TABLE enquadramento_resultado
  ADD COLUMN IF NOT EXISTS fundo_isin TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN enquadramento_resultado.fundo_isin IS 'ISIN da subclasse do fundo. Vazio para fundos sem diferenciação por subclasse.';

-- Drop old unique index (only 3 columns)
DROP INDEX IF EXISTS idx_enquadramento_resultado_unique;

-- New unique index includes fundo_isin so JR and SR can coexist
CREATE UNIQUE INDEX idx_enquadramento_resultado_unique
  ON enquadramento_resultado(fundo_cnpj, fundo_isin, fundo_dtposicao, regra_codigo);
