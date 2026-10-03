-- =====================================================
-- Migration: View de datas com posição importada
-- Descrição: Retorna 1 linha por data (fundo_dtposicao)
--            com XML importado. Substitui queries no
--            frontend com limit(10000) em linhas de
--            posicao_carteira, que omitiam datas antigas
--            quando há muitos fundos.
-- Date: 2026-05-20
-- =====================================================

CREATE OR REPLACE VIEW vw_posicao_datas_disponiveis AS
SELECT fundo_dtposicao
FROM posicao_carteira
WHERE fundo_dtposicao IS NOT NULL
  AND section IN ('caixa', 'despesas')
GROUP BY fundo_dtposicao;

COMMENT ON VIEW vw_posicao_datas_disponiveis IS
'Datas distintas com posição XML importada (proxy: seção caixa ou despesas).
Usada pelos seletores de data do Enquadramento, Dashboard e Liquidez.';
