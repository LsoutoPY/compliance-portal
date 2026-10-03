-- ============================================================================
-- Cadastro de partes (cedente/sacado) aprovadas em comitê da consultoria
-- Versionamento por import — nunca UPDATE destrutivo nas linhas vigentes
-- ============================================================================

CREATE TABLE IF NOT EXISTS cadastro_partes_importacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fundo_cnpj TEXT NOT NULL,
  filename TEXT,
  data_base DATE,
  consultoria TEXT,
  total_linhas INT DEFAULT 0,
  aceitas INT DEFAULT 0,
  rejeitadas INT DEFAULT 0,
  avisos JSONB NOT NULL DEFAULT '[]'::jsonb,
  arquivo_storage_path TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cadastro_partes_import_fundo
  ON cadastro_partes_importacoes (fundo_cnpj, created_at DESC);

COMMENT ON TABLE cadastro_partes_importacoes IS
  'Histórico de importações da planilha de cadastro de cedentes/sacados aprovados em comitê.';

CREATE TABLE IF NOT EXISTS fidc_cadastro_partes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fundo_cnpj TEXT NOT NULL,
  fundo_isin TEXT NOT NULL DEFAULT '',
  tipo_parte TEXT NOT NULL CHECK (tipo_parte IN ('cedente', 'sacado')),
  doc_cnpj_cpf TEXT NOT NULL,
  nome TEXT,
  escopo_limite TEXT NOT NULL DEFAULT 'individual'
    CHECK (escopo_limite IN ('individual', 'grupo')),
  grupo_chave TEXT,
  limite_operacao NUMERIC(18, 2),
  dt_analise DATE,
  dt_validade DATE,
  numero_ata TEXT,
  consultoria TEXT,
  status TEXT NOT NULL DEFAULT 'ativo'
    CHECK (status IN ('ativo', 'suspenso', 'encerrado')),
  observacoes TEXT,
  vigente BOOLEAN NOT NULL DEFAULT true,
  import_id UUID REFERENCES cadastro_partes_importacoes(id) ON DELETE SET NULL,
  substituido_por UUID REFERENCES fidc_cadastro_partes(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cadastro_partes_vigente
  ON fidc_cadastro_partes (fundo_cnpj, fundo_isin, tipo_parte, doc_cnpj_cpf)
  WHERE vigente;

CREATE INDEX IF NOT EXISTS ix_cadastro_partes_fundo
  ON fidc_cadastro_partes (fundo_cnpj)
  WHERE vigente;

CREATE INDEX IF NOT EXISTS ix_cadastro_partes_validade
  ON fidc_cadastro_partes (dt_validade)
  WHERE vigente;

CREATE INDEX IF NOT EXISTS ix_cadastro_partes_grupo
  ON fidc_cadastro_partes (fundo_cnpj, grupo_chave)
  WHERE vigente AND escopo_limite = 'grupo';

COMMENT ON TABLE fidc_cadastro_partes IS
  'Cadastro vigente de cedentes/sacados com limite de comitê (R$) e validade. Versionado por import.';

COMMENT ON COLUMN fidc_cadastro_partes.escopo_limite IS
  'individual: limite por CNPJ; grupo: limite compartilhado entre CNPJs do mesmo grupo_chave.';

ALTER TABLE cadastro_partes_importacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fidc_cadastro_partes ENABLE ROW LEVEL SECURITY;

CREATE POLICY cadastro_partes_importacoes_policy ON cadastro_partes_importacoes
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY fidc_cadastro_partes_policy ON fidc_cadastro_partes
  FOR ALL USING (true) WITH CHECK (true);

-- Bucket para planilhas originais
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'cadastro-partes-imports',
  'cadastro-partes-imports',
  false,
  10485760,
  ARRAY['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "cadastro_partes_imports_select" ON storage.objects;
DROP POLICY IF EXISTS "cadastro_partes_imports_insert" ON storage.objects;
DROP POLICY IF EXISTS "cadastro_partes_imports_update" ON storage.objects;
DROP POLICY IF EXISTS "cadastro_partes_imports_delete" ON storage.objects;

CREATE POLICY "cadastro_partes_imports_select"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'cadastro-partes-imports');

CREATE POLICY "cadastro_partes_imports_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'cadastro-partes-imports');

CREATE POLICY "cadastro_partes_imports_update"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'cadastro-partes-imports');

CREATE POLICY "cadastro_partes_imports_delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'cadastro-partes-imports');
