-- Status: N/A (fundo da própria gestora, sem exigência de ata formal)
-- Anexo da ata em Storage

ALTER TABLE ativos_credito DROP CONSTRAINT IF EXISTS ativos_credito_status_check;
ALTER TABLE ativos_credito ADD CONSTRAINT ativos_credito_status_check
  CHECK (status IN ('ATIVO', 'EM_ANALISE', 'SUSPENSO', 'ENCERRADO', 'NAO_APLICAVEL'));

ALTER TABLE ativos_credito ADD COLUMN IF NOT EXISTS ata_documento_storage_path TEXT;

COMMENT ON COLUMN ativos_credito.ata_documento_storage_path IS 'Caminho no bucket gestao-credito-atas (ex.: atas/uuid/arquivo.pdf)';

-- Bucket para PDFs/imagens da ata (privado; acesso via signed URL no app)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'gestao-credito-atas',
  'gestao-credito-atas',
  false,
  52428800,
  ARRAY[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "gestao_credito_atas_select" ON storage.objects;
DROP POLICY IF EXISTS "gestao_credito_atas_insert" ON storage.objects;
DROP POLICY IF EXISTS "gestao_credito_atas_update" ON storage.objects;
DROP POLICY IF EXISTS "gestao_credito_atas_delete" ON storage.objects;

CREATE POLICY "gestao_credito_atas_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'gestao-credito-atas');

CREATE POLICY "gestao_credito_atas_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'gestao-credito-atas');

CREATE POLICY "gestao_credito_atas_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'gestao-credito-atas');

CREATE POLICY "gestao_credito_atas_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'gestao-credito-atas');