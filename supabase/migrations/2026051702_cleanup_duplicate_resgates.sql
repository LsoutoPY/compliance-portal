-- Remove registros duplicados originados de importações antigas onde o cotista
-- foi preenchido com o nome do distribuidor (colD) em vez do investidor real (colA).
--
-- Padrão da duplicata:
--   - Registro ANTIGO: cotista = nome do distribuidor, contato IS NULL
--   - Registro NOVO  : cotista = nome real do investidor, contato = nome do distribuidor
--
-- A remoção mantém sempre o registro mais recente (com contato preenchido).

WITH duplicados AS (
  SELECT r.id
  FROM resgates_movimentacoes r
  WHERE r.contato IS NULL
    AND EXISTS (
      SELECT 1
      FROM resgates_movimentacoes r2
      WHERE r2.fundo         = r.fundo
        AND r2.data_impacto  = r.data_impacto
        AND r2.valor         = r.valor
        AND r2.tipo_movimento = r.tipo_movimento
        AND r2.contato IS NOT NULL
        AND r2.id <> r.id
    )
)
DELETE FROM resgates_movimentacoes
WHERE id IN (SELECT id FROM duplicados);
