-- Migration: Create credito_estoque tables
-- Description: Storage for Frontis "Estoque" import, aging buckets and PDD indicators.

CREATE TABLE IF NOT EXISTS credito_estoque_recebiveis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL,
  nome_fundo TEXT,
  doc_fundo TEXT,
  data_referencia DATE NOT NULL,
  data_vencimento_ajustada DATE,
  situacao_recebivel TEXT,
  valor_presente NUMERIC NOT NULL DEFAULT 0,
  valor_pdd_atual NUMERIC NOT NULL DEFAULT 0,
  faixa_pdd_arquivo TEXT,
  dias_atraso INTEGER NOT NULL DEFAULT 0,
  bucket_atraso TEXT NOT NULL,
  source_filename TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT credito_estoque_recebiveis_valor_presente_non_negative CHECK (valor_presente >= 0),
  CONSTRAINT credito_estoque_recebiveis_valor_pdd_non_negative CHECK (valor_pdd_atual >= 0),
  CONSTRAINT credito_estoque_recebiveis_dias_atraso_non_negative CHECK (dias_atraso >= 0),
  CONSTRAINT credito_estoque_recebiveis_bucket_check CHECK (
    bucket_atraso IN ('Adimplente', '1-30', '31-60', '61-90', '91-180', '180+')
  )
);

CREATE INDEX IF NOT EXISTS idx_credito_estoque_recebiveis_import
  ON credito_estoque_recebiveis(import_id);
CREATE INDEX IF NOT EXISTS idx_credito_estoque_recebiveis_fundo_data
  ON credito_estoque_recebiveis(doc_fundo, data_referencia);
CREATE INDEX IF NOT EXISTS idx_credito_estoque_recebiveis_bucket
  ON credito_estoque_recebiveis(bucket_atraso);

ALTER TABLE credito_estoque_recebiveis ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on credito_estoque_recebiveis"
  ON credito_estoque_recebiveis
  FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE TABLE IF NOT EXISTS credito_estoque_resumo_bucket (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL,
  nome_fundo TEXT NOT NULL,
  doc_fundo TEXT,
  data_referencia DATE NOT NULL,
  bucket_atraso TEXT NOT NULL,
  exposicao NUMERIC NOT NULL DEFAULT 0,
  pdd_atual NUMERIC NOT NULL DEFAULT 0,
  pdd_modelo NUMERIC NOT NULL DEFAULT 0,
  gap NUMERIC NOT NULL DEFAULT 0,
  cobertura NUMERIC NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT credito_estoque_resumo_bucket_exposicao_non_negative CHECK (exposicao >= 0),
  CONSTRAINT credito_estoque_resumo_bucket_pdd_atual_non_negative CHECK (pdd_atual >= 0),
  CONSTRAINT credito_estoque_resumo_bucket_pdd_modelo_non_negative CHECK (pdd_modelo >= 0),
  CONSTRAINT credito_estoque_resumo_bucket_bucket_check CHECK (
    bucket_atraso IN ('Adimplente', '1-30', '31-60', '61-90', '91-180', '180+')
  ),
  CONSTRAINT credito_estoque_resumo_bucket_unique UNIQUE (import_id, nome_fundo, data_referencia, bucket_atraso)
);

CREATE INDEX IF NOT EXISTS idx_credito_estoque_resumo_bucket_import
  ON credito_estoque_resumo_bucket(import_id);
CREATE INDEX IF NOT EXISTS idx_credito_estoque_resumo_bucket_fundo_data
  ON credito_estoque_resumo_bucket(doc_fundo, data_referencia);

ALTER TABLE credito_estoque_resumo_bucket ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on credito_estoque_resumo_bucket"
  ON credito_estoque_resumo_bucket
  FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE TABLE IF NOT EXISTS credito_estoque_indicadores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL,
  nome_fundo TEXT NOT NULL,
  doc_fundo TEXT,
  data_referencia DATE NOT NULL,
  carteira_total NUMERIC NOT NULL DEFAULT 0,
  over90 NUMERIC NOT NULL DEFAULT 0,
  over180 NUMERIC NOT NULL DEFAULT 0,
  coverage_vencidos NUMERIC NOT NULL DEFAULT 0,
  gap_total NUMERIC NOT NULL DEFAULT 0,
  pdd_atual_total NUMERIC NOT NULL DEFAULT 0,
  pdd_modelo_total NUMERIC NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT credito_estoque_indicadores_carteira_total_non_negative CHECK (carteira_total >= 0),
  CONSTRAINT credito_estoque_indicadores_unique UNIQUE (import_id, nome_fundo, data_referencia)
);

CREATE INDEX IF NOT EXISTS idx_credito_estoque_indicadores_import
  ON credito_estoque_indicadores(import_id);
CREATE INDEX IF NOT EXISTS idx_credito_estoque_indicadores_fundo_data
  ON credito_estoque_indicadores(doc_fundo, data_referencia);

ALTER TABLE credito_estoque_indicadores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on credito_estoque_indicadores"
  ON credito_estoque_indicadores
  FOR ALL
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE credito_estoque_recebiveis IS 'Receivables imported from Frontis Estoque report, normalized for credit risk analysis.';
COMMENT ON TABLE credito_estoque_resumo_bucket IS 'Aging summary per fund and delay bucket with current/model PDD and gap.';
COMMENT ON TABLE credito_estoque_indicadores IS 'Credit risk indicators per fund (Over90, Over180, coverage and total gap).';
