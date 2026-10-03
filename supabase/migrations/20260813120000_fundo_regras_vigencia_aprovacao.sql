-- ============================================================================
-- Vínculos fundo × regra: vigência, aprovação de importações em lote e histórico
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.fundo_regras_importacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  arquivo_nome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'concluido'
    CHECK (status IN ('processando', 'concluido', 'erro')),
  total_linhas INT NOT NULL DEFAULT 0,
  linhas_aceitas INT NOT NULL DEFAULT 0,
  linhas_rejeitadas INT NOT NULL DEFAULT 0,
  avisos JSONB NOT NULL DEFAULT '[]'::jsonb,
  arquivo_storage_path TEXT,
  criado_por UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_fundo_regras_import_created
  ON public.fundo_regras_importacoes (created_at DESC);

COMMENT ON TABLE public.fundo_regras_importacoes IS
  'Histórico de importações em lote de vínculos fundo × regra (planilha XLSX).';

ALTER TABLE public.fundo_regras
  ADD COLUMN IF NOT EXISTS status_aprovacao TEXT NOT NULL DEFAULT 'ativo'
    CHECK (status_aprovacao IN ('ativo', 'pendente', 'rejeitado')),
  ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'manual'
    CHECK (origem IN ('manual', 'importacao')),
  ADD COLUMN IF NOT EXISTS dt_inicio_vigencia DATE,
  ADD COLUMN IF NOT EXISTS dt_fim_vigencia DATE,
  ADD COLUMN IF NOT EXISTS import_id UUID REFERENCES public.fundo_regras_importacoes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS aprovado_por UUID,
  ADD COLUMN IF NOT EXISTS aprovado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejeitado_por UUID,
  ADD COLUMN IF NOT EXISTS rejeitado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS motivo_rejeicao TEXT;

COMMENT ON COLUMN public.fundo_regras.status_aprovacao IS
  'ativo = considerado no enquadramento; pendente = aguardando autorização (importação); rejeitado = descartado.';
COMMENT ON COLUMN public.fundo_regras.origem IS
  'manual = Nova Associação na UI (ativo imediato); importacao = planilha (pendente até aprovação).';

CREATE INDEX IF NOT EXISTS idx_fundo_regras_status_aprovacao
  ON public.fundo_regras (status_aprovacao)
  WHERE status_aprovacao = 'pendente';

CREATE INDEX IF NOT EXISTS idx_fundo_regras_import_id
  ON public.fundo_regras (import_id)
  WHERE import_id IS NOT NULL;

ALTER TABLE public.fundo_regras_importacoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fundo_regras_importacoes_policy ON public.fundo_regras_importacoes;
CREATE POLICY fundo_regras_importacoes_policy ON public.fundo_regras_importacoes
  FOR ALL USING (true) WITH CHECK (true);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'fundo-regras-imports',
  'fundo-regras-imports',
  false,
  10485760,
  ARRAY[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel'
  ]
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "fundo_regras_imports_select" ON storage.objects;
DROP POLICY IF EXISTS "fundo_regras_imports_insert" ON storage.objects;

CREATE POLICY "fundo_regras_imports_select"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'fundo-regras-imports');

CREATE POLICY "fundo_regras_imports_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'fundo-regras-imports');
