-- Portal CVPAR ainda não tem login. As RPCs de monitoramento do Frame
-- (get_pares_fundo_monitorado etc.) retornavam vazio porque user_is_active()
-- é false quando auth.uid() é nulo. Sem gestores_monitorados, is_gestor_monitorado
-- também excluía todos os fundos importados.

CREATE OR REPLACE FUNCTION public.user_is_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN true
    ELSE COALESCE(
      (SELECT is_active FROM public.user_profiles WHERE id = auth.uid()),
      false
    )
  END;
$$;

COMMENT ON FUNCTION public.user_is_active() IS
  'Usuário autenticado ativo no perfil. No portal aberto (anon, sem login) retorna true.';

GRANT EXECUTE ON FUNCTION public.user_is_active() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.is_gestor_monitorado(cnpj_gestor_raw text)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT
    NOT EXISTS (
      SELECT 1 FROM public.gestores_monitorados WHERE ativo = true
    )
    OR EXISTS (
      SELECT 1 FROM public.gestores_monitorados
      WHERE ativo = true
        AND cnpj_gestor = public.normalize_cnpj_digits(cnpj_gestor_raw)
    );
$$;

COMMENT ON FUNCTION public.is_gestor_monitorado IS
  'True se o CNPJ está na allowlist ativa. Se a allowlist estiver vazia, todos os gestores passam (portal recém-configurado).';
