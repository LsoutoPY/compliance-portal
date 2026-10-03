-- Migration: Create caixa_fluxo_financeiro table
-- Description: Armazena movimentações de fluxo financeiro importadas da planilha
--   CaixaFluxoFinanceiro (administrador). Usado para monitoramento de descasamento
--   operacional: resgates de portfólio investido confirmados vs resgates de cotistas.

CREATE TABLE IF NOT EXISTS caixa_fluxo_financeiro (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fundo_cnpj       TEXT        NOT NULL,
  fundo            TEXT,
  subtipo          TEXT        NOT NULL,
  financeiro       NUMERIC     NOT NULL,
  data_liquidacao  DATE        NOT NULL,
  arquivo_origem   TEXT,
  criado_em        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_caixa_fluxo_fundo_cnpj
  ON caixa_fluxo_financeiro(fundo_cnpj);

CREATE INDEX IF NOT EXISTS idx_caixa_fluxo_data_liquidacao
  ON caixa_fluxo_financeiro(data_liquidacao);

CREATE INDEX IF NOT EXISTS idx_caixa_fluxo_fundo_arquivo
  ON caixa_fluxo_financeiro(fundo_cnpj, arquivo_origem);

ALTER TABLE caixa_fluxo_financeiro ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on caixa_fluxo_financeiro"
  ON caixa_fluxo_financeiro
  FOR ALL
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE caixa_fluxo_financeiro IS
  'Movimentações de fluxo financeiro importadas da planilha CaixaFluxoFinanceiro do administrador. '
  'Filtradas pelo subtipo "Resgate de portfólio investido" para monitoramento de descasamento operacional.';

COMMENT ON COLUMN caixa_fluxo_financeiro.fundo_cnpj IS
  'CNPJ do fundo analisador (informado pelo usuário no upload).';

COMMENT ON COLUMN caixa_fluxo_financeiro.subtipo IS
  'Subtipo da movimentação conforme planilha (ex: "Resgate de portfólio investido").';

COMMENT ON COLUMN caixa_fluxo_financeiro.financeiro IS
  'Delta financeiro do movimento em R$ (coluna "Financeiro" da planilha). '
  'Valor pontual — o saldo acumulado é reconstruído em runtime.';

COMMENT ON COLUMN caixa_fluxo_financeiro.data_liquidacao IS
  'Data de liquidação convertida do serial Excel com correção de fuso UTC. '
  'Usada para calcular o vértice ANBIMA em runtime.';

COMMENT ON COLUMN caixa_fluxo_financeiro.arquivo_origem IS
  'Nome do arquivo XLS de origem. Usado para controle de reimport '
  '(delete+insert por fundo_cnpj + arquivo_origem).';
