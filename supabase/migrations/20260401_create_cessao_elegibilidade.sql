-- ============================================================================
-- Módulo Elegibilidade Cessões FIDC
-- 3 tabelas: regras, importações e resultado analítico
-- ============================================================================

-- 1. Regras de elegibilidade parametrizáveis por fundo
CREATE TABLE IF NOT EXISTS cessao_regras_elegibilidade (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fundo_cnpj TEXT NOT NULL,
  fundo_nome TEXT,
  regra_codigo TEXT NOT NULL,
  regra_descricao TEXT NOT NULL,
  tipo_validacao TEXT NOT NULL CHECK (tipo_validacao IN (
    'prazo', 'concentracao', 'taxa', 'valor', 'inadimplencia', 'vencimento', 'coobrigacao'
  )),
  campo_csv TEXT,
  operador TEXT NOT NULL DEFAULT '<=' CHECK (operador IN ('<=', '>=', '<', '>', '==', '!=')),
  valor_limite NUMERIC NOT NULL,
  unidade TEXT CHECK (unidade IN ('dias', 'percentual_pl', 'percentual_cdi', 'reais')),
  ativo BOOLEAN NOT NULL DEFAULT true,
  origem TEXT NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual', 'gemini')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(fundo_cnpj, regra_codigo)
);

CREATE INDEX IF NOT EXISTS idx_cessao_regras_fundo ON cessao_regras_elegibilidade (fundo_cnpj);
CREATE INDEX IF NOT EXISTS idx_cessao_regras_ativo ON cessao_regras_elegibilidade (fundo_cnpj, ativo);

ALTER TABLE cessao_regras_elegibilidade ENABLE ROW LEVEL SECURITY;
CREATE POLICY cessao_regras_elegibilidade_policy ON cessao_regras_elegibilidade
  FOR ALL USING (true) WITH CHECK (true);

-- 2. Importações de cessão (rastreamento)
CREATE TABLE IF NOT EXISTS cessao_importacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fundo_cnpj TEXT NOT NULL,
  fundo_nome TEXT,
  data_cessao DATE NOT NULL,
  filename TEXT,
  total_dcs INTEGER NOT NULL DEFAULT 0,
  elegiveis INTEGER NOT NULL DEFAULT 0,
  inelegiveis INTEGER NOT NULL DEFAULT 0,
  enquadram INTEGER NOT NULL DEFAULT 0,
  desenquadram INTEGER NOT NULL DEFAULT 0,
  vp_total_proposto NUMERIC(18,2),
  vp_elegiveis NUMERIC(18,2),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'success', 'error')),
  carteira_snapshot JSONB,
  proforma_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cessao_importacoes_fundo ON cessao_importacoes (fundo_cnpj);
CREATE INDEX IF NOT EXISTS idx_cessao_importacoes_data ON cessao_importacoes (data_cessao DESC);
CREATE INDEX IF NOT EXISTS idx_cessao_importacoes_created ON cessao_importacoes (created_at DESC);

ALTER TABLE cessao_importacoes ENABLE ROW LEVEL SECURITY;
CREATE POLICY cessao_importacoes_policy ON cessao_importacoes
  FOR ALL USING (true) WITH CHECK (true);

-- 3. Resultado analítico por DC
CREATE TABLE IF NOT EXISTS cessao_resultado_analitico (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL REFERENCES cessao_importacoes(id) ON DELETE CASCADE,
  nm_fundo TEXT,
  cnpj_fundo TEXT,
  nm_cedente TEXT,
  cpf_cnpj_cedente TEXT,
  nm_sacado TEXT,
  nu_cpf_cnpj_sacado TEXT,
  nm_tipo_recebivel TEXT,
  ds_seu_numero TEXT,
  ds_nu_documento TEXT,
  vl_pago NUMERIC(18,2),
  vl_nominal NUMERIC(18,2),
  prazo INTEGER,
  tx_juro NUMERIC(18,8),
  tx_cessao NUMERIC(18,8),
  dt_vencimento DATE,
  dt_entrada DATE,
  chave_nfe TEXT,
  elegivel BOOLEAN NOT NULL DEFAULT false,
  enquadra BOOLEAN NOT NULL DEFAULT false,
  motivos_rejeicao JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cessao_resultado_import ON cessao_resultado_analitico (import_id);
CREATE INDEX IF NOT EXISTS idx_cessao_resultado_elegivel ON cessao_resultado_analitico (import_id, elegivel);
CREATE INDEX IF NOT EXISTS idx_cessao_resultado_sacado ON cessao_resultado_analitico (nu_cpf_cnpj_sacado);

ALTER TABLE cessao_resultado_analitico ENABLE ROW LEVEL SECURITY;
CREATE POLICY cessao_resultado_analitico_policy ON cessao_resultado_analitico
  FOR ALL USING (true) WITH CHECK (true);
