-- Associação regra↔fundo por subclasse (CNPJ + ISIN).
-- fundo_isin = '' → regra vale para todas as subclasses do CNPJ (comportamento legado).

ALTER TABLE public.fundo_regras
  ADD COLUMN IF NOT EXISTS fundo_isin TEXT NOT NULL DEFAULT '';

-- Migra registros existentes explicitamente (DEFAULT já cobre, mas documenta intenção)
UPDATE public.fundo_regras SET fundo_isin = '' WHERE fundo_isin IS NULL;

ALTER TABLE public.fundo_regras
  DROP CONSTRAINT IF EXISTS fundo_regras_fundo_cnpj_regra_id_key;

ALTER TABLE public.fundo_regras
  ADD CONSTRAINT fundo_regras_fundo_cnpj_fundo_isin_regra_id_key
  UNIQUE (fundo_cnpj, fundo_isin, regra_id);

COMMENT ON COLUMN public.fundo_regras.fundo_isin IS
  'ISIN da subclasse. String vazia = regra aplicável a todas as subclasses do CNPJ.';
