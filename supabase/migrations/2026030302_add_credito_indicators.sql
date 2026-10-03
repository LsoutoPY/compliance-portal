-- Add PL and new risk indicators to credito_estoque_indicadores
ALTER TABLE credito_estoque_indicadores
ADD COLUMN IF NOT EXISTS pl NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS pdd_sobre_pl NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS pdd_sobre_over90 NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS impacto_stress_pl NUMERIC DEFAULT 0;

-- Add concentration percentage to bucket summary
ALTER TABLE credito_estoque_resumo_bucket
ADD COLUMN IF NOT EXISTS percentual_carteira NUMERIC DEFAULT 0;
