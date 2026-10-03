-- Corrige descricao de fundos com múltiplas classes: usa nome_comercial ANBIMA por ISIN.
UPDATE public.ativos a
SET descricao = fc.nome_comercial
FROM public.fundos_caracteristicas fc
WHERE a.tipo_ativo = 'FUNDO'
  AND a.isin IS NOT NULL
  AND a.isin <> ''
  AND a.isin NOT LIKE '%*%'
  AND LENGTH(a.isin) = 12
  AND fc.isin = a.isin
  AND fc.nome_comercial IS NOT NULL
  AND TRIM(fc.nome_comercial) <> ''
  AND (
    fc.cnpj_classe = a.cnpj
    OR fc.cnpj_fundo = a.cnpj
    OR a.cnpj IS NULL
  )
  AND COALESCE(TRIM(a.descricao), '') <> TRIM(fc.nome_comercial);
