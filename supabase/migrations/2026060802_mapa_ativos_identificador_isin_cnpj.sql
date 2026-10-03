-- =====================================================
-- Migration: Mapa de Ativos — identificador por ISIN + CNPJ
-- Alinha vw_mapa_ativos_fundos com getAtivoKeyFromRow (rentabilidade)
-- Date: 2026-06-08
-- =====================================================

DROP VIEW IF EXISTS vw_mapa_ativos_fundos;

CREATE VIEW vw_mapa_ativos_fundos AS
SELECT
  fundo_cnpj,
  COALESCE(nome_fundo, fundo_nome) AS fundo_nome,
  fundo_dtposicao,
  fundo_patliq,
  fundo_nomeadm    AS administrador,
  fundo_nomegestor AS gestor,

  section AS ativo_tipo,

  -- Identificador único alinhado com getAtivoKeyFromRow (useRentabilidadeCalc.ts)
  CASE
    WHEN section = 'cotas' THEN
      CASE
        WHEN cnpjfundo IS NOT NULL
          AND isin IS NOT NULL
          AND TRIM(isin) <> ''
          AND POSITION('*' IN TRIM(isin)) = 0
        THEN 'cotas:cnpj:' || REGEXP_REPLACE(cnpjfundo, '\D', '', 'g')
             || ':isin:' || UPPER(TRIM(isin))
        WHEN cnpjfundo IS NOT NULL
        THEN 'cotas:cnpj:' || REGEXP_REPLACE(cnpjfundo, '\D', '', 'g')
        WHEN isin IS NOT NULL AND TRIM(isin) <> ''
        THEN 'cotas:isin:' || UPPER(TRIM(isin))
        ELSE 'cotas:unk:' || COALESCE(NULLIF(TRIM(codativo), ''), '?')
      END

    WHEN section IN ('titpublico', 'titprivado') THEN
      section || '|' || COALESCE(TRIM(isin), '') || '|' || COALESCE(TRIM(codativo), '') || '|'
      || COALESCE(REGEXP_REPLACE(cnpjemissor, '\D', '', 'g'), '') || '|'
      || COALESCE(dtemissao, '') || '|' || COALESCE(dtvencimento, '')

    WHEN section = 'caixa' THEN
      'caixa:' || COALESCE(TRIM(isininstituicao), '?')

    WHEN section = 'participacoes' THEN
      'participacoes:' || COALESCE(REGEXP_REPLACE(cnpjpart, '\D', '', 'g'), '')
      || ':' || COALESCE(TRIM(nomecomercial), '')

    WHEN section = 'imoveis' THEN
      'imoveis:' || COALESCE(TRIM(matricula), '') || ':'
      || COALESCE(
        NULLIF(TRIM(BOTH FROM CONCAT_WS(',', NULLIF(TRIM(logradouro), ''), NULLIF(TRIM(numero), ''))), ''),
        ''
      ) || ':' || COALESCE(TRIM(nomecomercial), '')

    WHEN section = 'acoes' THEN
      'acoes:' || COALESCE(TRIM(codativo), '') || ':' || COALESCE(TRIM(isin), '')

    ELSE NULL
  END AS ativo_identificador,

  CASE
    WHEN section = 'imoveis' THEN nomecomercial
    ELSE NULL
  END AS ativo_nome_imovel,

  isin AS ativo_isin,
  cnpjemissor AS ativo_cnpj_emissor,
  cnpjfundo AS ativo_cnpj_fundo,
  codativo AS ativo_codigo,

  CASE
    WHEN section IN ('cotas', 'titpublico', 'titprivado', 'participacoes', 'acoes') THEN qtdisponivel
    ELSE NULL
  END AS quantidade,

  CASE
    WHEN section IN ('cotas', 'titpublico', 'titprivado', 'participacoes', 'acoes') THEN puposicao
    ELSE NULL
  END AS preco_unitario,

  CASE
    WHEN section = 'imoveis' THEN valorcontabil
    ELSE valor_padrao
  END AS valor_financeiro,

  CASE
    WHEN fundo_patliq > 0 AND (
      CASE WHEN section = 'imoveis' THEN valorcontabil ELSE valor_padrao END
    ) IS NOT NULL
    THEN (
      CASE WHEN section = 'imoveis' THEN valorcontabil ELSE valor_padrao END
      / fundo_patliq
    ) * 100
    ELSE NULL
  END AS percentual_pl,

  CASE
    WHEN section IN ('titpublico', 'titprivado') THEN dtvencimento
    ELSE NULL
  END AS data_vencimento,

  CASE
    WHEN section IN ('titpublico', 'titprivado') THEN indexador
    ELSE NULL
  END AS indexador,

  arquivo_nome,
  natural_key,
  id AS posicao_id

FROM posicao_carteira
WHERE
  section IN ('cotas', 'titpublico', 'titprivado', 'caixa', 'participacoes', 'imoveis', 'acoes')
  AND fundo_cnpj IS NOT NULL
  AND (
    (section = 'cotas'         AND cnpjfundo IS NOT NULL) OR
    (section IN ('titpublico', 'titprivado') AND (isin IS NOT NULL OR cnpjemissor IS NOT NULL OR codativo IS NOT NULL)) OR
    (section = 'caixa'         AND isininstituicao IS NOT NULL) OR
    (section = 'participacoes' AND cnpjpart IS NOT NULL) OR
    (section = 'imoveis'       AND matricula IS NOT NULL) OR
    (section = 'acoes'         AND isin IS NOT NULL)
  );

COMMENT ON VIEW vw_mapa_ativos_fundos IS
'View consolidada de ativos x fundos. Identificador alinhado com getAtivoKeyFromRow (ISIN+CNPJ para cotas; ISIN|CNPJ|codativo para títulos).';
