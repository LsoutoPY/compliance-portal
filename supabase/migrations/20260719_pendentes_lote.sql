-- Otimização: buscar apenas N pendentes por lote (evita statement timeout no encadeamento)
-- + índices auxiliares + count sem materializar todas as linhas

CREATE INDEX IF NOT EXISTS idx_posicao_carteira_dt_gestor_cnpj
  ON public.posicao_carteira (fundo_dtposicao, fundo_cnpjgestor)
  WHERE fundo_cnpj IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_enquadramento_resultado_dt_cnpj
  ON public.enquadramento_resultado (fundo_dtposicao, fundo_cnpj, fundo_isin);

CREATE INDEX IF NOT EXISTS idx_liquidez_monitoramento_dt_cnpj
  ON public.liquidez_monitoramento_risco (dt_posicao, fundo_cnpj);

-- ── Enquadramento: próximo lote de pendentes ────────────────────────────────
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
  WITH pares_com_posicao AS (
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
    GROUP BY p.fundo_cnpj, COALESCE(p.fundo_isin, ''), p.fundo_dtposicao
  ),
  pares_calculados AS (
    SELECT DISTINCT
      public.normalize_cnpj_digits(er.fundo_cnpj) AS cnpj_norm,
      COALESCE(er.fundo_isin, '')                 AS calc_isin,
      er.fundo_dtposicao                          AS calc_dtposicao
    FROM public.enquadramento_resultado er
    WHERE er.fundo_dtposicao >= p_data_inicio
      AND er.fundo_dtposicao <= p_data_fim
  )
  SELECT
    pos.fundo_cnpj,
    pos.fundo_isin,
    pos.fundo_dtposicao,
    pos.nome_fundo
  FROM pares_com_posicao pos
  LEFT JOIN pares_calculados calc
    ON calc.cnpj_norm = public.normalize_cnpj_digits(pos.fundo_cnpj)
   AND calc.calc_isin = pos.fundo_isin
   AND calc.calc_dtposicao = pos.fundo_dtposicao
  WHERE calc.cnpj_norm IS NULL
  ORDER BY pos.fundo_dtposicao ASC, pos.fundo_cnpj, pos.fundo_isin
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 5), 50));
END;
$$;

-- ── Liquidez: próximo lote de pendentes ─────────────────────────────────────
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
  WITH pares_com_posicao AS (
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
    GROUP BY p.fundo_cnpj, COALESCE(p.fundo_isin, ''), p.fundo_dtposicao
  ),
  nivel1 AS (
    SELECT
      COALESCE(fc.cnpj_fundo, fc.cnpj_classe) AS cnpj_ref,
      MAX(fc.nivel1_categoria)                AS nivel1_categoria
    FROM public.fundos_caracteristicas fc
    WHERE fc.nivel1_categoria IS NOT NULL
    GROUP BY COALESCE(fc.cnpj_fundo, fc.cnpj_classe)
  ),
  pares_calculados AS (
    SELECT
      public.normalize_cnpj_digits(lmr.fundo_cnpj) AS cnpj_norm,
      lmr.dt_posicao
    FROM public.liquidez_monitoramento_risco lmr
    WHERE lmr.dt_posicao >= p_data_inicio
      AND lmr.dt_posicao <= p_data_fim
      AND lmr.status <> 'pendente'
  )
  SELECT
    pos.fundo_cnpj,
    pos.fundo_isin,
    pos.fundo_dtposicao,
    pos.nome_fundo,
    COALESCE(n.nivel1_categoria, '') AS nivel1_categoria
  FROM pares_com_posicao pos
  LEFT JOIN nivel1 n
    ON public.normalize_cnpj_digits(n.cnpj_ref) = public.normalize_cnpj_digits(pos.fundo_cnpj)
  LEFT JOIN pares_calculados calc
    ON calc.cnpj_norm = public.normalize_cnpj_digits(pos.fundo_cnpj)
   AND calc.dt_posicao = pos.fundo_dtposicao
  WHERE calc.cnpj_norm IS NULL
  ORDER BY pos.fundo_dtposicao ASC, pos.fundo_cnpj, pos.fundo_isin
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 5), 50));
END;
$$;

-- ── Count otimizado (subquery, sem materializar get_pares_* inteiro) ────────
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
    WITH pares_com_posicao AS (
      SELECT
        p.fundo_cnpj,
        COALESCE(p.fundo_isin, '') AS fundo_isin,
        p.fundo_dtposicao
      FROM public.posicao_carteira p
      WHERE p.fundo_dtposicao >= p_data_inicio
        AND p.fundo_dtposicao <= p_data_fim
        AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
        AND p.fundo_cnpj IS NOT NULL
      GROUP BY p.fundo_cnpj, COALESCE(p.fundo_isin, ''), p.fundo_dtposicao
    ),
    pares_calculados AS (
      SELECT DISTINCT
        public.normalize_cnpj_digits(er.fundo_cnpj) AS cnpj_norm,
        COALESCE(er.fundo_isin, '')                 AS calc_isin,
        er.fundo_dtposicao                          AS calc_dtposicao
      FROM public.enquadramento_resultado er
      WHERE er.fundo_dtposicao >= p_data_inicio
        AND er.fundo_dtposicao <= p_data_fim
    )
    SELECT 1
    FROM pares_com_posicao pos
    LEFT JOIN pares_calculados calc
      ON calc.cnpj_norm = public.normalize_cnpj_digits(pos.fundo_cnpj)
     AND calc.calc_isin = pos.fundo_isin
     AND calc.calc_dtposicao = pos.fundo_dtposicao
    WHERE calc.cnpj_norm IS NULL
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
    WITH pares_com_posicao AS (
      SELECT
        p.fundo_cnpj,
        COALESCE(p.fundo_isin, '') AS fundo_isin,
        p.fundo_dtposicao
      FROM public.posicao_carteira p
      WHERE p.fundo_dtposicao >= p_data_inicio
        AND p.fundo_dtposicao <= p_data_fim
        AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
        AND p.fundo_cnpj IS NOT NULL
      GROUP BY p.fundo_cnpj, COALESCE(p.fundo_isin, ''), p.fundo_dtposicao
    ),
    nivel1 AS (
      SELECT
        COALESCE(fc.cnpj_fundo, fc.cnpj_classe) AS cnpj_ref,
        MAX(fc.nivel1_categoria)                AS nivel1_categoria
      FROM public.fundos_caracteristicas fc
      WHERE fc.nivel1_categoria IS NOT NULL
      GROUP BY COALESCE(fc.cnpj_fundo, fc.cnpj_classe)
    ),
    pares_calculados AS (
      SELECT
        public.normalize_cnpj_digits(lmr.fundo_cnpj) AS cnpj_norm,
        lmr.dt_posicao
      FROM public.liquidez_monitoramento_risco lmr
      WHERE lmr.dt_posicao >= p_data_inicio
        AND lmr.dt_posicao <= p_data_fim
        AND lmr.status <> 'pendente'
    )
    SELECT 1
    FROM pares_com_posicao pos
    LEFT JOIN pares_calculados calc
      ON calc.cnpj_norm = public.normalize_cnpj_digits(pos.fundo_cnpj)
     AND calc.dt_posicao = pos.fundo_dtposicao
    WHERE calc.cnpj_norm IS NULL
  ) pending;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pares_pendentes_enquadramento_lote(text, text, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pares_pendentes_liquidez_lote(text, text, int) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
