-- Complementa a migração 20260213_auto_fidc_np_por_nome.sql
-- Reclassifica FIC FIDCs cujo nome indica crédito não-padronizado ("NP") para "FIDC NP"
-- A migração anterior só cobria nivel1_categoria = 'FIDC' OR NULL.
-- Fundos como "FICFIDC OPORT NP SÊNIOR" têm nivel1_categoria = 'FIC FIDC' e não foram atualizados.
UPDATE public.fundos_caracteristicas
SET nivel1_categoria = 'FIDC NP'
WHERE (
    UPPER(COALESCE(nome_comercial, '')) LIKE '% NP %'
    OR UPPER(COALESCE(nome_comercial, '')) LIKE '% NP'
    OR UPPER(COALESCE(nome_comercial, '')) LIKE 'NP %'
    OR UPPER(COALESCE(nome_comercial, '')) LIKE '%NÃO PADRONIZADO%'
    OR UPPER(COALESCE(nome_comercial, '')) LIKE '%NAO PADRONIZADO%'
    OR UPPER(COALESCE(nome_comercial, '')) LIKE '%NÃO-PADRONIZADO%'
    OR UPPER(COALESCE(nome_comercial, '')) LIKE '%NAO-PADRONIZADO%'
  )
  AND nivel1_categoria IN ('FIC FIDC', 'FIC');
