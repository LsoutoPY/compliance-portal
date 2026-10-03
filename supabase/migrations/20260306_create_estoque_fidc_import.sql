-- Migration: Create estoque_fidc import tables
-- Description: Estrutura para importação do Estoque FIDC extraído do Frontis.
-- Tabelas: controle de importação (importacoes_estoque_fidc),
--          staging raw (estoque_fidc_raw),
--          normalizada final (estoque_fidc).
-- Foco: importação, padronização, armazenamento, log e rastreabilidade.
-- Não agrega dados, não calcula indicadores. Histórico mensal preservado.

-- =====================================================================
-- TABELA 1: Controle de importações
-- =====================================================================
CREATE TABLE IF NOT EXISTS importacoes_estoque_fidc (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by     UUID,
  file_name       TEXT        NOT NULL,
  file_type       TEXT        NOT NULL DEFAULT 'csv',
  source_system   TEXT        NOT NULL DEFAULT 'frontis',
  status          TEXT        NOT NULL DEFAULT 'pending',
  reference_date  DATE,
  fund_document   TEXT,
  fund_name       TEXT,
  total_rows      INTEGER     NOT NULL DEFAULT 0,
  imported_rows   INTEGER     NOT NULL DEFAULT 0,
  rejected_rows   INTEGER     NOT NULL DEFAULT 0,
  error_message   TEXT,
  metadata        JSONB,

  CONSTRAINT importacoes_estoque_fidc_status_check CHECK (
    status IN ('pending', 'processing', 'success', 'error', 'partial_success')
  )
);

CREATE INDEX IF NOT EXISTS idx_importacoes_estoque_fidc_status
  ON importacoes_estoque_fidc(status);
CREATE INDEX IF NOT EXISTS idx_importacoes_estoque_fidc_fund_document
  ON importacoes_estoque_fidc(fund_document);
CREATE INDEX IF NOT EXISTS idx_importacoes_estoque_fidc_reference_date
  ON importacoes_estoque_fidc(reference_date);
CREATE INDEX IF NOT EXISTS idx_importacoes_estoque_fidc_created_at
  ON importacoes_estoque_fidc(created_at DESC);

ALTER TABLE importacoes_estoque_fidc ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on importacoes_estoque_fidc"
  ON importacoes_estoque_fidc
  FOR ALL
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE importacoes_estoque_fidc IS
  'Controle de cada importação do Estoque FIDC extraído do Frontis. Um registro por upload.';

-- =====================================================================
-- TABELA 2: Staging raw (payload bruto linha a linha)
-- =====================================================================
CREATE TABLE IF NOT EXISTS estoque_fidc_raw (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id    UUID        NOT NULL REFERENCES importacoes_estoque_fidc(id) ON DELETE CASCADE,
  row_number   INTEGER     NOT NULL,
  raw_payload  JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_estoque_fidc_raw_import_id
  ON estoque_fidc_raw(import_id);

ALTER TABLE estoque_fidc_raw ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on estoque_fidc_raw"
  ON estoque_fidc_raw
  FOR ALL
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE estoque_fidc_raw IS
  'Staging bruto: uma linha por registro do CSV original, preservado para rastreabilidade e reprocessamento.';

-- =====================================================================
-- TABELA 3: Estoque FIDC normalizado
-- Todas as 48 colunas do CSV do Frontis, tipadas adequadamente.
-- Sem agregação, sem cálculo de indicadores nesta etapa.
-- =====================================================================
CREATE TABLE IF NOT EXISTS estoque_fidc (
  id                       UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id                UUID           NOT NULL REFERENCES importacoes_estoque_fidc(id) ON DELETE CASCADE,
  source_system            TEXT           NOT NULL DEFAULT 'frontis',

  -- Identificação do fundo e partes
  nome_fundo               TEXT,
  doc_fundo                TEXT,
  nome_originador          TEXT,
  doc_originador           TEXT,
  nome_cedente             TEXT,
  doc_cedente              TEXT,
  nome_sacado              TEXT,
  doc_sacado               TEXT,

  -- Tipo e valores
  tipo_recebivel           TEXT,
  valor_nominal            NUMERIC(18,2),
  valor_presente           NUMERIC(18,2),
  valor_aquisicao          NUMERIC(18,2),
  valor_pdd                NUMERIC(18,2),

  -- Datas
  data_vencimento_ajustada DATE,
  data_emissao             DATE,
  data_aquisicao           DATE,

  -- Identificadores do documento
  nu_documento             TEXT,
  seu_numero               TEXT,

  -- Taxas e prazos
  tx_recebivel             NUMERIC(18,8),
  prazo                    INTEGER,
  prazo_atual              INTEGER,

  -- Status e classificação
  situacao_recebivel       TEXT,
  faixa_pdd                TEXT,

  -- Datas adicionais
  data_vencimento_original DATE,
  taxa_cessao              NUMERIC(18,8),
  coobrigacao              TEXT,
  data_fundo               DATE,
  data_referencia          DATE,

  -- Encargos
  mora                     NUMERIC(18,2),
  multa                    NUMERIC(18,2),
  taxa_juros_vencidos      NUMERIC(18,8),
  data_carencia            DATE,
  taxa_juros_indexador     NUMERIC(18,8),
  tp_juros                 TEXT,
  defasagem                TEXT,

  -- Campos adicionais do Frontis
  nome                     TEXT,
  valor_nominal_iof        NUMERIC(18,2),

  -- Dados de cheque
  nu_banco_cheque          TEXT,
  nu_agencia_cheque        TEXT,
  nu_conta_cheque          TEXT,
  cmc7_cheque              TEXT,

  -- Codigos e chaves
  codigo_origem            TEXT,
  codigo_finalidade        TEXT,
  id_registro              TEXT,

  -- PDD geral
  faixa_pdd_geral          TEXT,
  tipo_pdd_geral           TEXT,
  valor_pdd_geral          NUMERIC(18,2),

  -- NF-e
  chave_nfe                TEXT,

  -- Controle
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para consulta eficiente
CREATE INDEX IF NOT EXISTS idx_estoque_fidc_import_id
  ON estoque_fidc(import_id);
CREATE INDEX IF NOT EXISTS idx_estoque_fidc_data_referencia
  ON estoque_fidc(data_referencia);
CREATE INDEX IF NOT EXISTS idx_estoque_fidc_doc_fundo
  ON estoque_fidc(doc_fundo);
CREATE INDEX IF NOT EXISTS idx_estoque_fidc_seu_numero
  ON estoque_fidc(seu_numero) WHERE seu_numero IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_estoque_fidc_nu_documento
  ON estoque_fidc(nu_documento) WHERE nu_documento IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_estoque_fidc_doc_sacado
  ON estoque_fidc(doc_sacado) WHERE doc_sacado IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_estoque_fidc_doc_cedente
  ON estoque_fidc(doc_cedente) WHERE doc_cedente IS NOT NULL;
-- Índice composto para consulta do módulo de crédito/liquidez
CREATE INDEX IF NOT EXISTS idx_estoque_fidc_fundo_data
  ON estoque_fidc(doc_fundo, data_referencia);

ALTER TABLE estoque_fidc ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on estoque_fidc"
  ON estoque_fidc
  FOR ALL
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE estoque_fidc IS
  'Estoque de recebíveis FIDC normalizado. Uma linha por recebível por importação. '
  'Preserva histórico mensal. Pronto para consumo pelos módulos de crédito e liquidez.';
COMMENT ON COLUMN estoque_fidc.import_id IS 'Referência à importação-mãe para rastreabilidade completa.';
COMMENT ON COLUMN estoque_fidc.data_referencia IS 'Data-base do estoque (DATA_REFERENCIA do Frontis). Usar para filtrar por competência.';
COMMENT ON COLUMN estoque_fidc.seu_numero IS 'Chave lógica preferencial para identificação do recebível.';
