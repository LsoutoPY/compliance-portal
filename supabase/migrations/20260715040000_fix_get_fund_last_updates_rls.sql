-- get_fund_last_updates: SECURITY DEFINER para leitura agregada com checagem de acesso.
-- Após 20260715_user_profiles_access_control, a RPC rodava como invoker e o RLS em
-- posicao_carteira podia retornar vazio no client autenticado mesmo com user_is_active.

DROP FUNCTION IF EXISTS public.get_fund_last_updates();

CREATE OR REPLACE FUNCTION public.get_fund_last_updates()
RETURNS TABLE (
  nome_fundo text,
  cnpj_fundo text,
  dt_posicao text,
  administrador text,
  gestor_nome text,
  cnpj_gestor text,
  is_monitorado boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.user_is_active() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (p.fundo_cnpj)
    COALESCE(p.nome_fundo, p.fundo_nome) AS nome_fundo,
    p.fundo_cnpj AS cnpj_fundo,
    p.fundo_dtposicao AS dt_posicao,
    p.fundo_nomeadm AS administrador,
    p.fundo_nomegestor AS gestor_nome,
    p.fundo_cnpjgestor AS cnpj_gestor,
    public.is_gestor_monitorado(p.fundo_cnpjgestor) AS is_monitorado
  FROM public.posicao_carteira p
  WHERE p.fundo_cnpj IS NOT NULL
  ORDER BY p.fundo_cnpj, p.fundo_dtposicao DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_fund_last_updates() TO authenticated;

COMMENT ON FUNCTION public.get_fund_last_updates() IS
  'Última dt_posicao por fundo (Dashboard de XMLs). SECURITY DEFINER + user_is_active().';
