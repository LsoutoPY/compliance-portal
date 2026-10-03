-- ============================================================
-- Migration: Gaps de XML por data de referência (fundos monitorados)
-- Lógica direta:
--   1. Universo = fundos monitorados com pelo menos 1 XML na janela
--   2. Calendário = dias úteis (Seg–Sex) entre [data_fim − janela, data_fim]
--   3. Dia esperado = dia útil em que ao menos 1 fundo monitorado tem XML
--      (evita falsos positivos em feriados sem negociação)
--   4. Gap = fundo do universo sem header/caixa/despesas naquele dia
--
-- Não altera get_xml_gaps() — a tela de importação continua usando a RPC antiga.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_xml_gaps_por_referencia(
  p_data_fim    text,
  p_janela_dias integer DEFAULT 90
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
      p_data_fim AS data_fim,
      to_char(
        to_date(p_data_fim, 'YYYYMMDD') - (GREATEST(p_janela_dias, 1) || ' days')::interval,
        'YYYYMMDD'
      ) AS data_inicio
  ),

  -- Presença real: 1 linha por (fundo, isin, data)
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

  -- Fundos monitorados com atividade na janela
  fundos_universo AS (
    SELECT
      fundo_cnpj,
      fundo_isin,
      MAX(nome_fundo) AS nome_fundo
    FROM presenca
    GROUP BY fundo_cnpj, fundo_isin
  ),

  -- Dias úteis (Seg–Sex) na janela
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

  -- Dia esperado: dia útil com pelo menos 1 fundo com XML
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

COMMENT ON FUNCTION public.get_xml_gaps_por_referencia IS
  'Gaps de XML para fundos monitorados até p_data_fim (YYYYMMDD). '
  'Cruza universo ativo na janela com dias úteis que tiveram negociação (≥1 XML). '
  'p_janela_dias default 90. Usado no Dashboard de enquadramento.';

-- Retorna contagem do universo mesmo quando não há gaps (para o Dashboard).
CREATE OR REPLACE FUNCTION public.get_xml_universo_count(
  p_data_fim    text,
  p_janela_dias integer DEFAULT 90
)
RETURNS integer
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  WITH params AS (
    SELECT
      p_data_fim AS data_fim,
      to_char(
        to_date(p_data_fim, 'YYYYMMDD') - (GREATEST(p_janela_dias, 1) || ' days')::interval,
        'YYYYMMDD'
      ) AS data_inicio
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

COMMENT ON FUNCTION public.get_xml_universo_count IS
  'Conta fundos monitorados com pelo menos 1 XML na janela até p_data_fim.';
