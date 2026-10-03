-- ============================================================================
-- Módulo Elegibilidade Cessões FIDC — suporte a Recompras
-- Adiciona tipo_operacao em cessao_resultado_analitico,
-- torna elegivel/enquadra nullable (recompras gravam null),
-- e adiciona contadores de recompra em cessao_importacoes.
-- ============================================================================

ALTER TABLE cessao_resultado_analitico
  ADD COLUMN IF NOT EXISTS tipo_operacao TEXT NOT NULL DEFAULT 'AQUISICAO'
    CHECK (tipo_operacao IN ('AQUISICAO', 'RECOMPRA'));

-- Recompras não passam pelo motor de elegibilidade, portanto elegivel/enquadra
-- são null para essas linhas. Remover o NOT NULL constraint existente.
ALTER TABLE cessao_resultado_analitico
  ALTER COLUMN elegivel DROP NOT NULL,
  ALTER COLUMN enquadra DROP NOT NULL;

ALTER TABLE cessao_importacoes
  ADD COLUMN IF NOT EXISTS total_recompras INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vp_recompras    NUMERIC(18,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_cessao_resultado_tipo_op
  ON cessao_resultado_analitico (import_id, tipo_operacao);
