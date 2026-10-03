-- Regra automática: fundos com indicação de "NP" (Não Padronizado) no nome passam a ter Tipo do Fundo = "FIDC NP"
-- Justificativa: FIDCs Não Padronizados precisam ser identificados para regras de compliance
-- Critério: nome contém "NP", " NP ", "NÃO PADRONIZADO" (evita falsos positivos como "COMPANHIA" via padrão " NP ")
UPDATE public.fundos_caracteristicas
SET nivel1_categoria = 'FIDC NP'
WHERE (
    UPPER(COALESCE(nome_comercial, '')) LIKE '% NP %'
    OR UPPER(COALESCE(nome_comercial, '')) LIKE '% NP'
    OR UPPER(COALESCE(nome_comercial, '')) LIKE 'NP %'
    OR UPPER(COALESCE(nome_comercial, '')) LIKE '%NÃO PADRONIZADO%'
    OR UPPER(COALESCE(nome_comercial, '')) LIKE '%NAO PADRONIZADO%'
  )
  AND (nivel1_categoria = 'FIDC' OR nivel1_categoria IS NULL);
