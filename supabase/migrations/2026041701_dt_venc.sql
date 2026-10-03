-- Adicionar data de vencimento na posição diária
-- Permite selecionar o sub-índice IMA-B correto por duration real do ativo
-- (IMA-B 5 = vencimento até 5 anos, IMA-B 5+ = acima de 5 anos)
ALTER TABLE posicao_diaria ADD COLUMN IF NOT EXISTS dt_venc DATE;
