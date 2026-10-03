-- Fix definitivo do timeout em "Processar pendentes": as RPCs anteriores ainda
-- escaneavam o intervalo inteiro (mesmo com LIMIT, o Postgres precisa materializar/
-- ordenar o GROUP BY inteiro antes de aplicar o LIMIT). A partir daqui, o batch
-- processa data por data (equality scan, sempre rápido e indexado), e o cursor de
-- progresso (qual data já foi totalmente processada) fica salvo em
-- monitoramento_job_log.detalhes.pendentes_cursor.

-- RPC: pendentes de enquadramento para UMA data exata (equality scan — rápido)
CREATE OR REPLACE FUNCTION public.get_pares_pendentes_enquadramento_data(
  p_data text
)
RETURNS TABLE (
  fundo_cnpj      text,
  fundo_isin      text,
  fundo_dtposicao text,
  nome_fundo      text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.user_is_active() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    p.fundo_cnpj,
    COALESCE(p.fundo_isin, '')                    AS fundo_isin,
    p.fundo_dtposicao,
    MAX(COALESCE(p.nome_fundo, p.fundo_nome, '')) AS nome_fundo
  FROM public.posicao_carteira p
  WHERE p.fundo_dtposicao = p_data
    AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
    AND p.fundo_cnpj IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.enquadramento_resultado er
      WHERE er.fundo_dtposicao = p_data
        AND public.normalize_cnpj_digits(er.fundo_cnpj) = public.normalize_cnpj_digits(p.fundo_cnpj)
        AND COALESCE(er.fundo_isin, '') = COALESCE(p.fundo_isin, '')
    )
  GROUP BY p.fundo_cnpj, COALESCE(p.fundo_isin, ''), p.fundo_dtposicao
  ORDER BY p.fundo_cnpj, COALESCE(p.fundo_isin, '');
END;
$$;

-- RPC: pendentes de liquidez para UMA data exata
CREATE OR REPLACE FUNCTION public.get_pares_pendentes_liquidez_data(
  p_data text
)
RETURNS TABLE (
  fundo_cnpj       text,
  fundo_isin       text,
  fundo_dtposicao  text,
  nome_fundo       text,
  nivel1_categoria text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.user_is_active() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    p.fundo_cnpj,
    COALESCE(p.fundo_isin, '')                    AS fundo_isin,
    p.fundo_dtposicao,
    MAX(COALESCE(p.nome_fundo, p.fundo_nome, '')) AS nome_fundo,
    COALESCE(MAX(fc.nivel1_categoria), '')         AS nivel1_categoria
  FROM public.posicao_carteira p
  LEFT JOIN LATERAL (
    SELECT fc2.nivel1_categoria
    FROM public.fundos_caracteristicas fc2
    WHERE public.normalize_cnpj_digits(COALESCE(fc2.cnpj_fundo, fc2.cnpj_classe))
        = public.normalize_cnpj_digits(p.fundo_cnpj)
      AND fc2.nivel1_categoria IS NOT NULL
    LIMIT 1
  ) fc ON true
  WHERE p.fundo_dtposicao = p_data
    AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
    AND p.fundo_cnpj IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.liquidez_monitoramento_risco lmr
      WHERE lmr.dt_posicao = p_data
        AND public.normalize_cnpj_digits(lmr.fundo_cnpj) = public.normalize_cnpj_digits(p.fundo_cnpj)
        AND lmr.status <> 'pendente'
    )
  GROUP BY p.fundo_cnpj, COALESCE(p.fundo_isin, ''), p.fundo_dtposicao
  ORDER BY p.fundo_cnpj, COALESCE(p.fundo_isin, '');
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pares_pendentes_enquadramento_data(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pares_pendentes_liquidez_data(text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
