-- Manuais institucionais: arquivos privados, disponíveis somente por URL
-- assinada para usuários autenticados no sistema.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'manuais',
  'manuais',
  false,
  15728640,
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "manuais_authenticated_select" ON storage.objects;

CREATE POLICY "manuais_authenticated_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'manuais');
