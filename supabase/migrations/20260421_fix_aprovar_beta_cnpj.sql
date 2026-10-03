-- ============================================================
-- Ajustes em aprovar_beta_cnpj
-- ============================================================
-- Motivação:
--   A função original retornava void, o que dificultava detectar
--   no frontend quando a aprovação não afetou nenhuma linha
--   (ex.: CNPJ digitado errado). Agora retorna o registro
--   atualizado, permitindo optimistic updates no cache do
--   React Query e feedback preciso em caso de falha.
--
--   Também passamos a rodar como SECURITY DEFINER para garantir
--   que o UPDATE não seja bloqueado por futuras policies RLS
--   adicionadas à tabela betas_por_cnpj.
-- ============================================================

DROP FUNCTION IF EXISTS aprovar_beta_cnpj(TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION aprovar_beta_cnpj(
  p_cnpj         TEXT,
  p_qualidade    TEXT,
  p_aprovado_por TEXT DEFAULT NULL,
  p_observacao   TEXT DEFAULT NULL
)
RETURNS SETOF betas_por_cnpj
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE betas_por_cnpj
     SET qualidade     = p_qualidade,
         aprovado_por  = COALESCE(p_aprovado_por, aprovado_por),
         aprovado_em   = NOW(),
         observacao    = COALESCE(p_observacao, observacao),
         atualizado_em = NOW()
   WHERE cnpj = p_cnpj
   RETURNING *;
$$;

GRANT EXECUTE ON FUNCTION aprovar_beta_cnpj(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
