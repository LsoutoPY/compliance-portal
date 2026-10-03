-- Migration: Add descricao column to caixa_fluxo_financeiro
-- Captura o campo "Descrição" da planilha CaixaFluxoFinanceiro, que contém o nome
-- do fundo investido resgatado no formato "Resgate de cotas do fundo <NOME>".
-- Usado para match com ativos da posicao_carteira (section='cotas') e dedução do vértice de origem.

ALTER TABLE caixa_fluxo_financeiro
  ADD COLUMN IF NOT EXISTS descricao TEXT;

COMMENT ON COLUMN caixa_fluxo_financeiro.descricao IS
  'Descrição da movimentação conforme planilha. Para "Resgate de portfólio investido", '
  'contém o nome do fundo no formato "Resgate de cotas do fundo <NOME>". '
  'Usado para match com posicao_carteira (section=cotas) e dedução do vértice de origem.';
