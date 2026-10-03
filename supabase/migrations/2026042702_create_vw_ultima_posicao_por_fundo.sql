-- =====================================================
-- Migration: View de última posição disponível por fundo
-- Descrição: Retorna 1 linha por fundo com a data mais
--            recente disponível em posicao_carteira.
--            Substitui a lógica de limit(100000) no frontend,
--            garantindo que TODOS os fundos sejam incluídos
--            no Mapa de Ativos independente da antiguidade do XML.
-- Date: 2026-04-27
-- =====================================================

CREATE OR REPLACE VIEW vw_ultima_posicao_por_fundo AS
SELECT
  fundo_cnpj,
  MAX(fundo_dtposicao) AS ultima_data
FROM posicao_carteira
WHERE fundo_cnpj IS NOT NULL
GROUP BY fundo_cnpj;

COMMENT ON VIEW vw_ultima_posicao_por_fundo IS
'Uma linha por fundo com a data de posição mais recente disponível.
Usada pelo Mapa de Ativos para identificar o fallback de fundos
sem XML na data de referência selecionada.';
