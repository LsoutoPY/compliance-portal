-- ============================================================
-- Alinha Integridade de XML (Enquadramento) com Rentabilidade:
--   - Presença = section caixa/despesas com fundo_valorcota > 0
--   - Universo por dia = fundos com ≥1 snapshot válido em [dia−N, dia]
--   - p_janela_dias default 10 (DIAS_INATIVO_RENTABILIDADE_XML)
-- ============================================================

DROP FUNCTION IF EXISTS public.get_xml_gaps_por_referencia(text, text);
DROP FUNCTION IF EXISTS public.get_xml_gaps_por_referencia(text, text, integer);
DROP FUNCTION IF EXISTS public.get_xml_universo_count(text, text);
DROP FUNCTION IF EXISTS public.get_xml_universo_count(text, text, integer);

CREATE OR REPLACE FUNCTION public.get_xml_gaps_por_referencia(
  p_data_inicio text,
  p_data_fim    text,
  p_janela_dias integer DEFAULT 10
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
      GREATEST(p_data_inicio, p_data_fim) AS data_fim,
      GREATEST(p_janela_dias, 1) AS janela_dias
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
      AND p.section IN ('caixa', 'despesas')
      AND p.fundo_valorcota IS NOT NULL
      AND p.fundo_valorcota > 0
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

  fundos_esperados_dia AS (
    SELECT
      de.dt AS data_faltante,
      pr.fundo_cnpj,
      pr.fundo_isin,
      MAX(pr.nome_fundo) AS nome_fundo
    FROM dias_esperados de
    CROSS JOIN params par
    JOIN presenca pr
      ON pr.dt >= to_char(
           to_date(de.dt, 'YYYYMMDD') - (par.janela_dias || ' days')::interval,
           'YYYYMMDD'
         )
     AND pr.dt <= de.dt
    GROUP BY de.dt, pr.fundo_cnpj, pr.fundo_isin
  ),

  universo_count AS (
    SELECT COUNT(*)::integer AS n
    FROM (
      SELECT DISTINCT pr.fundo_cnpj, pr.fundo_isin
      FROM presenca pr
      CROSS JOIN params par
      WHERE pr.dt >= to_char(
              to_date(par.data_fim, 'YYYYMMDD') - (par.janela_dias || ' days')::interval,
              'YYYYMMDD'
            )
        AND pr.dt <= par.data_fim
    ) u
  )

  SELECT
    fe.fundo_cnpj,
    fe.fundo_isin,
    fe.nome_fundo,
    fe.data_faltante,
    uc.n AS total_fundos_universo
  FROM fundos_esperados_dia fe
  CROSS JOIN universo_count uc
  LEFT JOIN presenca pr
    ON pr.fundo_cnpj = fe.fundo_cnpj
   AND pr.fundo_isin = fe.fundo_isin
   AND pr.dt         = fe.data_faltante
  WHERE pr.fundo_cnpj IS NULL
  ORDER BY fe.data_faltante DESC, fe.nome_fundo, fe.fundo_cnpj, fe.fundo_isin
$$;

COMMENT ON FUNCTION public.get_xml_gaps_por_referencia(text, text, integer) IS
  'Gaps de XML para fundos monitorados no intervalo p_data_inicio..p_data_fim (YYYYMMDD). '
  'Alinhado com Rentabilidade: presença = caixa/despesas com fundo_valorcota > 0; '
  'universo por dia = classes com ≥1 snapshot válido em [dia−p_janela_dias, dia] (default 10). '
  'Dias esperados = Seg–Sex com ≥1 snapshot válido de qualquer fundo.';

CREATE OR REPLACE FUNCTION public.get_xml_universo_count(
  p_data_inicio text,
  p_data_fim    text,
  p_janela_dias integer DEFAULT 10
)
RETURNS integer
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  WITH params AS (
    SELECT
      LEAST(p_data_inicio, p_data_fim) AS data_inicio,
      GREATEST(p_data_inicio, p_data_fim) AS data_fim,
      GREATEST(p_janela_dias, 1) AS janela_dias
  )
  SELECT COUNT(*)::integer
  FROM (
    SELECT DISTINCT p.fundo_cnpj, COALESCE(p.fundo_isin, '') AS fundo_isin
    FROM public.posicao_carteira p
    CROSS JOIN params par
    WHERE p.fundo_dtposicao >= to_char(
            to_date(par.data_fim, 'YYYYMMDD') - (par.janela_dias || ' days')::interval,
            'YYYYMMDD'
          )
      AND p.fundo_dtposicao <= par.data_fim
      AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
      AND p.fundo_cnpj IS NOT NULL
      AND p.section IN ('caixa', 'despesas')
      AND p.fundo_valorcota IS NOT NULL
      AND p.fundo_valorcota > 0
  ) u
$$;

COMMENT ON FUNCTION public.get_xml_universo_count(text, text, integer) IS
  'Conta fundos monitorados ativos na data fim: ≥1 snapshot válido (cota > 0) nos últimos p_janela_dias (default 10).';
