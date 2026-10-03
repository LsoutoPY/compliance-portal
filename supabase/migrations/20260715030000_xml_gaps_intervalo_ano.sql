-- ============================================================
-- Atualiza RPCs de gaps de XML: intervalo explícito (desde janeiro)
-- Substitui p_janela_dias por p_data_inicio + p_data_fim (YYYYMMDD).
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_xml_gaps_por_referencia(
  p_data_inicio text,
  p_data_fim    text
)
RETURNS TABLE (
  fundo_cnpj            text,
  fundo_isin            text,
  nome_fundo            text,
  data_faltante         text,
  total_fundos_universo integer
)
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  WITH params AS (
    SELECT
      LEAST(p_data_inicio, p_data_fim) AS data_inicio,
      GREATEST(p_data_inicio, p_data_fim) AS data_fim
  ),

  presenca AS (
    SELECT DISTINCT
      p.fundo_cnpj,
      COALESCE(p.fundo_isin, '')                            AS fundo_isin,
      p.fundo_dtposicao                                     AS dt,
      COALESCE(p.nome_fundo, p.fundo_nome, p.fundo_cnpj)    AS nome_fundo
    FROM public.posicao_carteira p
    CROSS JOIN params par
    WHERE p.fundo_dtposicao >= par.data_inicio
      AND p.fundo_dtposicao <= par.data_fim
      AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
      AND p.fundo_cnpj IS NOT NULL
      AND p.section IN ('caixa', 'despesas', 'header')
  ),

  fundos_universo AS (
    SELECT
      fundo_cnpj,
      fundo_isin,
      MAX(nome_fundo) AS nome_fundo
    FROM presenca
    GROUP BY fundo_cnpj, fundo_isin
  ),

  calendario AS (
    SELECT to_char(d::date, 'YYYYMMDD') AS dt
    FROM params par,
    generate_series(
      to_date(par.data_inicio, 'YYYYMMDD'),
      to_date(par.data_fim, 'YYYYMMDD'),
      INTERVAL '1 day'
    ) AS d
    WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 5
  ),

  dias_esperados AS (
    SELECT c.dt
    FROM calendario c
    WHERE EXISTS (SELECT 1 FROM presenca pr WHERE pr.dt = c.dt)
  ),

  universo_count AS (
    SELECT COUNT(*)::integer AS n FROM fundos_universo
  )

  SELECT
    f.fundo_cnpj,
    f.fundo_isin,
    f.nome_fundo,
    de.dt AS data_faltante,
    uc.n AS total_fundos_universo
  FROM fundos_universo f
  CROSS JOIN dias_esperados de
  CROSS JOIN universo_count uc
  LEFT JOIN presenca pr
    ON pr.fundo_cnpj = f.fundo_cnpj
   AND pr.fundo_isin = f.fundo_isin
   AND pr.dt         = de.dt
  WHERE pr.fundo_cnpj IS NULL
  ORDER BY de.dt DESC, f.nome_fundo, f.fundo_cnpj, f.fundo_isin
$$;

COMMENT ON FUNCTION public.get_xml_gaps_por_referencia(text, text) IS
  'Gaps de XML para fundos monitorados no intervalo p_data_inicio..p_data_fim (YYYYMMDD). '
  'Universo = fundos monitorados com ≥1 XML na janela. '
  'Dias esperados = Seg–Sex com ≥1 XML de qualquer fundo.';

CREATE OR REPLACE FUNCTION public.get_xml_universo_count(
  p_data_inicio text,
  p_data_fim    text
)
RETURNS integer
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  WITH params AS (
    SELECT
      LEAST(p_data_inicio, p_data_fim) AS data_inicio,
      GREATEST(p_data_inicio, p_data_fim) AS data_fim
  )
  SELECT COUNT(*)::integer
  FROM (
    SELECT DISTINCT p.fundo_cnpj, COALESCE(p.fundo_isin, '') AS fundo_isin
    FROM public.posicao_carteira p
    CROSS JOIN params par
    WHERE p.fundo_dtposicao >= par.data_inicio
      AND p.fundo_dtposicao <= par.data_fim
      AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
      AND p.fundo_cnpj IS NOT NULL
      AND p.section IN ('caixa', 'despesas', 'header')
  ) u
$$;

COMMENT ON FUNCTION public.get_xml_universo_count(text, text) IS
  'Conta fundos monitorados com ≥1 XML no intervalo p_data_inicio..p_data_fim.';
