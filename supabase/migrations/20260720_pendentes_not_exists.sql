-- Otimização v2: NOT EXISTS (sem CTE materializando todos os calculados)
-- Corrige statement timeout no botão "Contar" e no encadeamento de lotes
-- Nota: SET LOCAL statement_timeout exige VOLATILE; mantemos STABLE + NOT EXISTS

CREATE OR REPLACE FUNCTION public.get_pares_pendentes_enquadramento_lote(
  p_data_inicio text,
  p_data_fim    text,
  p_limit       int DEFAULT 5
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
  WHERE p.fundo_dtposicao >= p_data_inicio
    AND p.fundo_dtposicao <= p_data_fim
    AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
    AND p.fundo_cnpj IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.enquadramento_resultado er
      WHERE er.fundo_dtposicao = p.fundo_dtposicao
        AND public.normalize_cnpj_digits(er.fundo_cnpj) = public.normalize_cnpj_digits(p.fundo_cnpj)
        AND COALESCE(er.fundo_isin, '') = COALESCE(p.fundo_isin, '')
    )
  GROUP BY p.fundo_cnpj, COALESCE(p.fundo_isin, ''), p.fundo_dtposicao
  ORDER BY p.fundo_dtposicao ASC, p.fundo_cnpj, COALESCE(p.fundo_isin, '')
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 5), 50));
END;
$$;

CREATE OR REPLACE FUNCTION public.get_pares_pendentes_liquidez_lote(
  p_data_inicio text,
  p_data_fim    text,
  p_limit       int DEFAULT 5
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
  WHERE p.fundo_dtposicao >= p_data_inicio
    AND p.fundo_dtposicao <= p_data_fim
    AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
    AND p.fundo_cnpj IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.liquidez_monitoramento_risco lmr
      WHERE lmr.dt_posicao = p.fundo_dtposicao
        AND public.normalize_cnpj_digits(lmr.fundo_cnpj) = public.normalize_cnpj_digits(p.fundo_cnpj)
        AND lmr.status <> 'pendente'
    )
  GROUP BY p.fundo_cnpj, COALESCE(p.fundo_isin, ''), p.fundo_dtposicao
  ORDER BY p.fundo_dtposicao ASC, p.fundo_cnpj, COALESCE(p.fundo_isin, '')
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 5), 50));
END;
$$;

CREATE OR REPLACE FUNCTION public.count_pares_pendentes_enquadramento(
  p_data_inicio text,
  p_data_fim    text
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.user_is_active() THEN
    RETURN 0;
  END IF;

  SELECT count(*)::bigint INTO v_count
  FROM (
    SELECT 1
    FROM public.posicao_carteira p
    WHERE p.fundo_dtposicao >= p_data_inicio
      AND p.fundo_dtposicao <= p_data_fim
      AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
      AND p.fundo_cnpj IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.enquadramento_resultado er
        WHERE er.fundo_dtposicao = p.fundo_dtposicao
          AND public.normalize_cnpj_digits(er.fundo_cnpj) = public.normalize_cnpj_digits(p.fundo_cnpj)
          AND COALESCE(er.fundo_isin, '') = COALESCE(p.fundo_isin, '')
      )
    GROUP BY p.fundo_cnpj, COALESCE(p.fundo_isin, ''), p.fundo_dtposicao
  ) pending;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.count_pares_pendentes_liquidez(
  p_data_inicio text,
  p_data_fim    text
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.user_is_active() THEN
    RETURN 0;
  END IF;

  SELECT count(*)::bigint INTO v_count
  FROM (
    SELECT 1
    FROM public.posicao_carteira p
    WHERE p.fundo_dtposicao >= p_data_inicio
      AND p.fundo_dtposicao <= p_data_fim
      AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
      AND p.fundo_cnpj IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.liquidez_monitoramento_risco lmr
        WHERE lmr.dt_posicao = p.fundo_dtposicao
          AND public.normalize_cnpj_digits(lmr.fundo_cnpj) = public.normalize_cnpj_digits(p.fundo_cnpj)
          AND lmr.status <> 'pendente'
      )
    GROUP BY p.fundo_cnpj, COALESCE(p.fundo_isin, ''), p.fundo_dtposicao
  ) pending;

  RETURN v_count;
END;
$$;

-- Lista completa (UI legado) — mesma lógica NOT EXISTS
CREATE OR REPLACE FUNCTION public.get_pares_pendentes_enquadramento(
  p_data_inicio text,
  p_data_fim    text
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
  WHERE p.fundo_dtposicao >= p_data_inicio
    AND p.fundo_dtposicao <= p_data_fim
    AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
    AND p.fundo_cnpj IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.enquadramento_resultado er
      WHERE er.fundo_dtposicao = p.fundo_dtposicao
        AND public.normalize_cnpj_digits(er.fundo_cnpj) = public.normalize_cnpj_digits(p.fundo_cnpj)
        AND COALESCE(er.fundo_isin, '') = COALESCE(p.fundo_isin, '')
    )
  GROUP BY p.fundo_cnpj, COALESCE(p.fundo_isin, ''), p.fundo_dtposicao
  ORDER BY p.fundo_dtposicao ASC, p.fundo_cnpj, COALESCE(p.fundo_isin, '');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_pares_pendentes_liquidez(
  p_data_inicio text,
  p_data_fim    text
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
  WHERE p.fundo_dtposicao >= p_data_inicio
    AND p.fundo_dtposicao <= p_data_fim
    AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
    AND p.fundo_cnpj IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.liquidez_monitoramento_risco lmr
      WHERE lmr.dt_posicao = p.fundo_dtposicao
        AND public.normalize_cnpj_digits(lmr.fundo_cnpj) = public.normalize_cnpj_digits(p.fundo_cnpj)
        AND lmr.status <> 'pendente'
    )
  GROUP BY p.fundo_cnpj, COALESCE(p.fundo_isin, ''), p.fundo_dtposicao
  ORDER BY p.fundo_dtposicao ASC, p.fundo_cnpj, COALESCE(p.fundo_isin, '');
END;
$$;

NOTIFY pgrst, 'reload schema';
