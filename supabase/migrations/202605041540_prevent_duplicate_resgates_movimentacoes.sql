-- Torna tipo_movimento determinístico para chave única
UPDATE resgates_movimentacoes
SET tipo_movimento = ''
WHERE tipo_movimento IS NULL;

ALTER TABLE resgates_movimentacoes
  ALTER COLUMN tipo_movimento SET DEFAULT '',
  ALTER COLUMN tipo_movimento SET NOT NULL;

-- Remove possíveis duplicidades remanescentes antes de criar a proteção
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY fundo, cotista, data_impacto, valor, tipo_movimento
      ORDER BY criado_em ASC, id ASC
    ) AS rn
  FROM resgates_movimentacoes
)
DELETE FROM resgates_movimentacoes r
USING ranked x
WHERE r.id = x.id
  AND x.rn > 1;

-- Proteção anti-duplicidade para imports futuros
CREATE UNIQUE INDEX IF NOT EXISTS ux_resgates_movimentacoes_dedup
  ON resgates_movimentacoes (fundo, cotista, data_impacto, valor, tipo_movimento);
