-- ============================================================
-- vw_posicao_enriquecida
--
-- View de enriquecimento que une posicao_carteira (XML) com
-- posicao_consolidada (Finvest CSV), adicionando colunas de
-- classificação analítica sem alterar nenhum campo existente.
--
-- Técnica: LATERAL JOIN com LIMIT 1 para garantir que cada linha
-- de posicao_carteira produz EXATAMENTE uma linha no resultado.
-- Não há risco de multiplicação de linhas (cartesian product).
--
-- Mapeamento de chaves:
--   posicao_carteira.fundo_cnpj     = 14 dígitos  (ex: 58580017000145)
--   posicao_consolidada.fundo_cnpj  =  8 dígitos  (ex: 58580017)
--   → LEFT(pc.fundo_cnpj, 8) = pcons.fundo_cnpj
--
--   posicao_carteira.fundo_dtposicao = TEXT YYYYMMDD  (ex: 20260316)
--   posicao_consolidada.data_posicao = DATE           (ex: 2026-03-16)
--   → TO_DATE(pc.fundo_dtposicao, 'YYYYMMDD') = pcons.data_posicao
--
--   posicao_carteira.section        = XML section  (ex: 'imoveis')
--   posicao_consolidada.secao_xml   = mesmo valor  (ex: 'imoveis')
--
-- Novas colunas (prefixo enr_):
--   enr_macro_categoria    → GrpN1 nome   (ex: ATIVO, PASSIVO)
--   enr_subcategoria       → GrpN2 nome   (ex: IMÓVEIS, COTAS DE FUNDO)
--   enr_categoria_detalhada→ GrpN3 nome   (ex: Imóveis, Cotas Fundo RF Referenciado)
--   enr_nivel_granularidade→ analitico | agregado | generico
--   enr_status_consolidacao→ ok | refinado_csv | flag_revisao | somente_csv | somente_xml
--   enr_descricao_original → texto livre da fonte de origem
--   enr_tem_csv            → BOOLEAN true quando há dado CSV correspondente
--
-- Consumidores planejados:
--   - LiquidezFundDetailContent.tsx  (display enriquecido na Composição da Carteira)
--
-- NÃO altera: rules-classe, check-enquadramento, calculo-risco-liquidez,
--   sync-ativos-carteira, import-xml, import-passivo-fundos e demais.
-- ============================================================

DROP VIEW IF EXISTS vw_posicao_enriquecida;

CREATE OR REPLACE VIEW vw_posicao_enriquecida AS
SELECT
  pc.*,
  -- Colunas de enriquecimento Finvest CSV (NULL quando não há dado CSV)
  pcons.macro_categoria       AS enr_macro_categoria,
  pcons.subcategoria          AS enr_subcategoria,
  pcons.categoria_detalhada   AS enr_categoria_detalhada,
  pcons.nivel_granularidade   AS enr_nivel_granularidade,
  pcons.status_consolidacao   AS enr_status_consolidacao,
  pcons.descricao_original    AS enr_descricao_original,
  (pcons.id IS NOT NULL)      AS enr_tem_csv

FROM posicao_carteira pc

-- LATERAL com LIMIT 1: busca a classificação CSV mais analítica
-- disponível para a seção deste ativo. Um único resultado por linha.
LEFT JOIN LATERAL (
  SELECT
    id,
    macro_categoria,
    subcategoria,
    categoria_detalhada,
    nivel_granularidade,
    status_consolidacao,
    descricao_original
  FROM posicao_consolidada pcons_inner
  WHERE
    -- Chave de CNPJ: 8 primeiros dígitos do CNPJ XML = CNPJ parcial do CSV
    pcons_inner.fundo_cnpj = LEFT(pc.fundo_cnpj, 8)
    -- Chave de data: converte YYYYMMDD → DATE
    AND pc.fundo_dtposicao IS NOT NULL
    AND pcons_inner.data_posicao = TO_DATE(pc.fundo_dtposicao, 'YYYYMMDD')
    -- Chave de seção: mesma seção econômica
    AND pcons_inner.secao_xml = pc.section
    -- Ignora itens somente_csv aqui (eles não têm contraparte XML para enriquecer)
    AND pcons_inner.status_consolidacao != 'somente_csv'
  ORDER BY
    -- Prefere o item com maior granularidade analítica
    CASE pcons_inner.nivel_granularidade
      WHEN 'analitico' THEN 1
      WHEN 'agregado'  THEN 2
      ELSE 3
    END
  LIMIT 1
) pcons ON true;

COMMENT ON VIEW vw_posicao_enriquecida IS
  'posicao_carteira (XML) enriquecida com classificação analítica da Finvest CSV. '
  'Todas as colunas originais de posicao_carteira são preservadas sem modificação. '
  'Novas colunas prefixadas com enr_ são NULL quando não há dado CSV disponível. '
  'Use esta view apenas para EXIBIÇÃO — as regras de enquadramento e cálculo de risco '
  'devem continuar usando posicao_carteira diretamente para garantir estabilidade.';

GRANT SELECT ON vw_posicao_enriquecida TO anon, authenticated, service_role;
