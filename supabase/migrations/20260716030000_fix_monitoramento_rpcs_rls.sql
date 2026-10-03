-- RPCs de monitoramento: SECURITY DEFINER + user_is_active (mesmo padrão de get_fund_last_updates)

CREATE OR REPLACE FUNCTION public.get_ultimas_datas_posicao(p_limit int DEFAULT 1)
RETURNS TABLE (fundo_dtposicao text)
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
  SELECT DISTINCT pc.fundo_dtposicao::text
  FROM public.posicao_carteira pc
  WHERE pc.fundo_dtposicao IS NOT NULL
  ORDER BY pc.fundo_dtposicao DESC
  LIMIT GREATEST(1, LEAST(p_limit, 30));
END;
$$;

CREATE OR REPLACE FUNCTION public.get_pares_fundo_monitorado(p_dtposicao text)
RETURNS TABLE (
  fundo_cnpj      text,
  fundo_isin      text,
  nome_fundo      text,
  gestor_nome     text,
  cnpj_gestor     text,
  fundo_patliq    numeric
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
  SELECT
    p.fundo_cnpj,
    coalesce(p.fundo_isin, '')::text,
    max(coalesce(p.nome_fundo, p.fundo_nome, ''))::text,
    max(p.fundo_nomegestor)::text,
    max(p.fundo_cnpjgestor)::text,
    max(p.fundo_patliq)
  FROM public.posicao_carteira p
  WHERE p.fundo_dtposicao = p_dtposicao
    AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
  GROUP BY p.fundo_cnpj, coalesce(p.fundo_isin, '')
  ORDER BY max(coalesce(p.nome_fundo, p.fundo_nome, ''));
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_ultimas_datas_posicao(int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pares_fundo_monitorado(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_ultimas_datas_posicao(int) IS
  'Últimas N datas distintas em posicao_carteira. SECURITY DEFINER + user_is_active().';

COMMENT ON FUNCTION public.get_pares_fundo_monitorado(text) IS
  'Pares monitorados por data. SECURITY DEFINER + user_is_active().';
