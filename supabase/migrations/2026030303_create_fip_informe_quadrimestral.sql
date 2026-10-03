-- Tabela para armazenar dados do Informe Quadrimestral FIP (CVM)
-- Fonte: https://dados.cvm.gov.br/dataset/fip-doc-inf_quadrimestral

CREATE TABLE IF NOT EXISTS fip_informe_quadrimestral (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj_fundo_classe TEXT NOT NULL,
  dt_comptc DATE NOT NULL,
  vl_cap_subscr NUMERIC NOT NULL DEFAULT 0,
  denom_social TEXT,
  ano_referencia INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(cnpj_fundo_classe, dt_comptc)
);

CREATE INDEX IF NOT EXISTS idx_fip_informe_cnpj ON fip_informe_quadrimestral(cnpj_fundo_classe);
CREATE INDEX IF NOT EXISTS idx_fip_informe_dt ON fip_informe_quadrimestral(dt_comptc DESC);
CREATE INDEX IF NOT EXISTS idx_fip_informe_cnpj_dt ON fip_informe_quadrimestral(cnpj_fundo_classe, dt_comptc DESC);

COMMENT ON TABLE fip_informe_quadrimestral IS 'Dados do Informe Quadrimestral FIP da CVM - capital subscrito por fundo e data de competência';
