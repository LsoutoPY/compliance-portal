-- Migration: Adiciona codigo_clt e contato à tabela resgates_movimentacoes
-- codigo_clt: vincula ao cadastro mestre (passivo_cotista_de_para) via De-Para
-- contato:    coluna D da planilha de movimentações (distribuidor/intermediário, ex: "QUADRANTE.XP")

ALTER TABLE resgates_movimentacoes
  ADD COLUMN IF NOT EXISTS codigo_clt  INTEGER,
  ADD COLUMN IF NOT EXISTS contato     TEXT;

CREATE INDEX IF NOT EXISTS idx_resgates_movimentacoes_codigo_clt ON resgates_movimentacoes(codigo_clt);

COMMENT ON COLUMN resgates_movimentacoes.codigo_clt IS 'Código do cliente resolvido via De-Para (passivo_cotista_de_para.codigo_cliente)';
COMMENT ON COLUMN resgates_movimentacoes.contato     IS 'Campo Contato da planilha de movimentações (col D) — distribuidor/intermediário, ex: QUADRANTE.XP';
