-- =====================================================
-- Mapa de Ativos: inclui direitos FIDC e provisões
--
-- Provisões são identificadas pela descrição ANBIMA para que relatórios e
-- exportações exibam o nome do lançamento, não apenas o codprov técnico.
-- =====================================================

CREATE OR REPLACE VIEW public.vw_mapa_ativos_fundos AS
SELECT
  p.fundo_cnpj,
  COALESCE(p.nome_fundo, p.fundo_nome) AS fundo_nome,
  p.fundo_dtposicao,
  p.fundo_patliq,
  p.fundo_nomeadm AS administrador,
  p.fundo_nomegestor AS gestor,

  p.section AS ativo_tipo,

  CASE
    WHEN p.section = 'cotas' THEN
      CASE
        WHEN p.cnpjfundo IS NOT NULL
          AND p.isin IS NOT NULL
          AND TRIM(p.isin) <> ''
          AND POSITION('*' IN TRIM(p.isin)) = 0
        THEN 'cotas:cnpj:' || REGEXP_REPLACE(p.cnpjfundo, '\D', '', 'g')
             || ':isin:' || UPPER(TRIM(p.isin))
        WHEN p.cnpjfundo IS NOT NULL
        THEN 'cotas:cnpj:' || REGEXP_REPLACE(p.cnpjfundo, '\D', '', 'g')
        WHEN p.isin IS NOT NULL AND TRIM(p.isin) <> ''
        THEN 'cotas:isin:' || UPPER(TRIM(p.isin))
        ELSE 'cotas:unk:' || COALESCE(NULLIF(TRIM(p.codativo), ''), '?')
      END
    WHEN p.section IN ('titpublico', 'titprivado') THEN
      p.section || '|' || COALESCE(TRIM(p.isin), '') || '|' || COALESCE(TRIM(p.codativo), '') || '|'
      || COALESCE(REGEXP_REPLACE(p.cnpjemissor, '\D', '', 'g'), '') || '|'
      || COALESCE(p.dtemissao, '') || '|' || COALESCE(p.dtvencimento, '')
    WHEN p.section = 'caixa' THEN
      'caixa:' || COALESCE(TRIM(p.isininstituicao), '?')
    WHEN p.section = 'participacoes' THEN
      'participacoes:' || COALESCE(REGEXP_REPLACE(p.cnpjpart, '\D', '', 'g'), '')
      || ':' || COALESCE(TRIM(p.nomecomercial), '')
    WHEN p.section = 'imoveis' THEN
      'imoveis:' || COALESCE(TRIM(p.matricula), '') || ':'
      || COALESCE(NULLIF(TRIM(BOTH FROM CONCAT_WS(',', NULLIF(TRIM(p.logradouro), ''), NULLIF(TRIM(p.numero), ''))), ''), '')
      || ':' || COALESCE(TRIM(p.nomecomercial), '')
    WHEN p.section = 'acoes' THEN
      'acoes:' || COALESCE(TRIM(p.codativo), '') || ':' || COALESCE(TRIM(p.isin), '')
    WHEN p.section = 'fidc' THEN
      'fidc:' || COALESCE(REGEXP_REPLACE(p.cnpjemissor, '\D', '', 'g'), '') || ':'
      || COALESCE(REGEXP_REPLACE(p.cnpjfundo, '\D', '', 'g'), '') || ':'
      || COALESCE(UPPER(NULLIF(TRIM(p.isin), '')), '') || ':'
      || COALESCE(NULLIF(TRIM(p.codativo), ''), p.natural_key)
    WHEN p.section = 'provisao' THEN
      'provisao:codprov:' || COALESCE(NULLIF(TRIM(p.codprov), ''), 'sem-codigo')
      || ':credeb:' || COALESCE(NULLIF(TRIM(p.credeb), ''), 'na')
    ELSE NULL
  END AS ativo_identificador,

  CASE WHEN p.section = 'imoveis' THEN p.nomecomercial ELSE NULL END AS ativo_nome_imovel,

  p.isin AS ativo_isin,
  p.cnpjemissor AS ativo_cnpj_emissor,
  p.cnpjfundo AS ativo_cnpj_fundo,
  CASE WHEN p.section = 'provisao' THEN p.codprov ELSE p.codativo END AS ativo_codigo,

  CASE
    WHEN p.section IN ('cotas', 'titpublico', 'titprivado', 'participacoes', 'acoes') THEN p.qtdisponivel
    ELSE NULL
  END AS quantidade,
  CASE
    WHEN p.section IN ('cotas', 'titpublico', 'titprivado', 'participacoes', 'acoes') THEN p.puposicao
    ELSE NULL
  END AS preco_unitario,
  -- Provisões seguem a mesma convenção da Carteira: débito reduz a posição
  -- (despesa/a pagar) e crédito aumenta a posição (receita/a receber).
  CASE
    WHEN p.section = 'provisao' AND UPPER(TRIM(COALESCE(p.credeb, ''))) = 'D' AND p.valor_padrao IS NOT NULL
      THEN -ABS(p.valor_padrao)
    WHEN p.section = 'provisao' AND UPPER(TRIM(COALESCE(p.credeb, ''))) = 'C' AND p.valor_padrao IS NOT NULL
      THEN ABS(p.valor_padrao)
    WHEN p.section = 'imoveis' THEN p.valorcontabil
    ELSE p.valor_padrao
  END AS valor_financeiro,
  CASE
    WHEN p.fundo_patliq > 0
      AND (CASE
        WHEN p.section = 'provisao' AND UPPER(TRIM(COALESCE(p.credeb, ''))) = 'D' AND p.valor_padrao IS NOT NULL THEN -ABS(p.valor_padrao)
        WHEN p.section = 'provisao' AND UPPER(TRIM(COALESCE(p.credeb, ''))) = 'C' AND p.valor_padrao IS NOT NULL THEN ABS(p.valor_padrao)
        WHEN p.section = 'imoveis' THEN p.valorcontabil
        ELSE p.valor_padrao
      END) IS NOT NULL
    THEN ((CASE
      WHEN p.section = 'provisao' AND UPPER(TRIM(COALESCE(p.credeb, ''))) = 'D' AND p.valor_padrao IS NOT NULL THEN -ABS(p.valor_padrao)
      WHEN p.section = 'provisao' AND UPPER(TRIM(COALESCE(p.credeb, ''))) = 'C' AND p.valor_padrao IS NOT NULL THEN ABS(p.valor_padrao)
      WHEN p.section = 'imoveis' THEN p.valorcontabil
      ELSE p.valor_padrao
    END) / p.fundo_patliq) * 100
    ELSE NULL
  END AS percentual_pl,
  CASE WHEN p.section IN ('titpublico', 'titprivado') THEN p.dtvencimento ELSE NULL END AS data_vencimento,
  CASE WHEN p.section IN ('titpublico', 'titprivado') THEN p.indexador ELSE NULL END AS indexador,
  p.arquivo_nome,
  p.natural_key,
  p.id AS posicao_id,

  -- Campo pronto para apresentação e Excel: usa descrição, nunca o código.
  CASE
    WHEN p.section = 'provisao' THEN COALESCE(NULLIF(TRIM(a.descricao), ''), 'Provisão sem classificação')
    WHEN p.section = 'fidc' THEN COALESCE(
      NULLIF(TRIM(p.nomecomercial), ''),
      NULLIF(TRIM(p.codativo), ''),
      NULLIF(TRIM(p.cnpjemissor), ''),
      NULLIF(TRIM(p.cnpjfundo), ''),
      'Direito creditório FIDC'
    )
    ELSE NULL
  END AS ativo_nome
FROM public.posicao_carteira p
LEFT JOIN public.anbima_cod_lancamento a
  ON p.section = 'provisao'
 AND a.cod_lancamento = p.codprov
WHERE p.section IN (
  'cotas', 'titpublico', 'titprivado', 'caixa', 'participacoes', 'imoveis', 'acoes', 'fidc', 'provisao'
)
  AND p.fundo_cnpj IS NOT NULL
  AND (
    (p.section = 'cotas' AND p.cnpjfundo IS NOT NULL)
    OR (p.section IN ('titpublico', 'titprivado') AND (p.isin IS NOT NULL OR p.cnpjemissor IS NOT NULL OR p.codativo IS NOT NULL))
    OR (p.section = 'caixa' AND p.isininstituicao IS NOT NULL)
    OR (p.section = 'participacoes' AND p.cnpjpart IS NOT NULL)
    OR (p.section = 'imoveis' AND p.matricula IS NOT NULL)
    OR (p.section = 'acoes' AND p.isin IS NOT NULL)
    OR (p.section = 'fidc')
    OR (p.section = 'provisao')
  );

COMMENT ON VIEW public.vw_mapa_ativos_fundos IS
'Mapa consolidado de ativos x fundos, incluindo direitos creditórios FIDC e provisões. Provisões expõem a descrição ANBIMA em ativo_nome e preservam codprov apenas em ativo_codigo.';
