-- Tabela unificada para ingestão do Informe Mensal FIDC (CVM)
-- Fonte: https://dados.cvm.gov.br/dataset/fidc-doc-inf_mensal
-- Escopo de carga atual:
--   - inf_mensal_fidc_tab_V*   (buckets com aquisicao substancial)
--   - inf_mensal_fidc_tab_VI*  (buckets sem aquisicao substancial)
--   - inf_mensal_fidc_tab_IV* Parte A (PL na coluna E)

CREATE TABLE IF NOT EXISTS fidc_informe_mensal_import (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competencia_yyyymm TEXT NOT NULL,
  ano_referencia INTEGER NOT NULL,
  mes_referencia INTEGER NOT NULL,
  dt_comptc DATE,
  origem_tabela TEXT NOT NULL, -- TAB_V | TAB_VI | TAB_IV_PARTE_A
  bucket_tipo TEXT, -- com_aquisicao_substancial | sem_aquisicao_substancial
  arquivo_origem TEXT NOT NULL,
  linha_arquivo INTEGER NOT NULL,
  cnpj_fundo_classe TEXT,
  cnpj_fundo TEXT,
  cnpj_classe TEXT,
  denom_social TEXT,
  pl NUMERIC, -- preenchido para TAB_IV_PARTE_A (coluna E)
  valor_bucket NUMERIC, -- opcional para TAB_V/TAB_VI quando detectavel
  bucket_label TEXT, -- opcional para TAB_V/TAB_VI quando detectavel
  dados JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fidc_inf_mensal_comp ON fidc_informe_mensal_import (competencia_yyyymm);
CREATE INDEX IF NOT EXISTS idx_fidc_inf_mensal_origem ON fidc_informe_mensal_import (origem_tabela);
CREATE INDEX IF NOT EXISTS idx_fidc_inf_mensal_cnpj_fc ON fidc_informe_mensal_import (cnpj_fundo_classe);
CREATE INDEX IF NOT EXISTS idx_fidc_inf_mensal_dt ON fidc_informe_mensal_import (dt_comptc DESC);

COMMENT ON TABLE fidc_informe_mensal_import IS 'Carga unificada do Informe Mensal FIDC (TAB_V, TAB_VI e TAB_IV Parte A) para consumo interno.';
