-- =====================================================
-- Migration: Função para detectar gaps de XML por fundo
-- Descrição: Retorna fundos que não possuem XML em dias
--            úteis dentro da janela de análise.
--
-- LÓGICA DE DIA ÚTIL (calendar-first):
--   1. Gera todos os dias de semana (Seg–Sex) da janela via
--      generate_series — independente de haver dado ou não.
--   2. Um dia de semana é considerado "dia de mercado" se:
--      a) Possui dado de pelo menos 1 fundo  ← dia normal
--      b) OU está entre dois dias que possuem dado (gap total):
--         existe ao menos 1 data com dado nos 5 dias anteriores
--         E ao menos 1 data com dado nos 5 dias posteriores.
--   3. Para cada dia de mercado × fundo ativo: se a presença
--      real está ausente → gap reportado.
--
-- Isso detecta tanto:
--   - 1 fundo faltando enquanto outros estão presentes
--   - TODOS os fundos faltando num dia útil (lote não importado)
--
-- Feriados nacionais: se TODOS os fundos faltam num feriado,
-- ele também será listado. O usuário pode ignorar datas óbvias
-- (ex: Carnaval, Tiradentes) ou cruzar com um calendário externo
-- numa versão futura.
--
-- Janela de análise: últimos 45 dias corridos.
-- Date: 2026-04-28 (rev 2 — calendar-first)
-- =====================================================

CREATE OR REPLACE FUNCTION get_xml_gaps()
RETURNS TABLE (
  fundo_cnpj    text,
  nome_fundo    text,
  data_faltante text
)
LANGUAGE sql
STABLE
AS $$
  WITH
  -- ── 1. Presença real: 1 linha por (fundo, data) ─────────────────────
  presenca AS (
    SELECT DISTINCT
      fundo_cnpj,
      fundo_dtposicao,
      COALESCE(nome_fundo, fundo_nome, fundo_cnpj) AS nome_fundo
    FROM posicao_carteira
    WHERE section = 'header'
      AND fundo_cnpj IS NOT NULL
      AND fundo_dtposicao >= to_char(CURRENT_DATE - INTERVAL '45 days', 'YYYYMMDD')
  ),

  -- ── 2. Fundos ativos na janela ───────────────────────────────────────
  fundos_ativos AS (
    SELECT DISTINCT fundo_cnpj, nome_fundo FROM presenca
  ),

  -- ── 3. Datas que possuem dado de algum fundo ────────────────────────
  datas_com_dado AS (
    SELECT DISTINCT fundo_dtposicao FROM presenca
  ),

  -- ── 4. Calendário: todos os dias úteis (Seg–Sex) da janela ──────────
  --    Exclui hoje (dados do dia corrente podem estar em processamento)
  calendario AS (
    SELECT to_char(d::date, 'YYYYMMDD') AS fundo_dtposicao
    FROM generate_series(
      CURRENT_DATE - INTERVAL '45 days',
      CURRENT_DATE - INTERVAL '1 day',
      INTERVAL '1 day'
    ) AS d
    WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 5   -- 1=Seg … 5=Sex
  ),

  -- ── 5. Dias de mercado = dias úteis que provadamente tiveram negociação
  --    Critério A: o dia em si tem dado (ao menos 1 fundo presente)
  --    Critério B: é um gap total — sandwichado entre dias com dado
  --                (≤5 dias corridos antes  E  ≤5 dias corridos depois)
  dias_mercado AS (
    SELECT c.fundo_dtposicao
    FROM calendario c
    WHERE
      -- A: há dado neste dia
      c.fundo_dtposicao IN (SELECT fundo_dtposicao FROM datas_com_dado)
      OR
      -- B: gap total — há dado próximo antes e depois
      (
        EXISTS (
          SELECT 1 FROM datas_com_dado d
          WHERE d.fundo_dtposicao < c.fundo_dtposicao
            AND to_date(d.fundo_dtposicao, 'YYYYMMDD')
                >= to_date(c.fundo_dtposicao, 'YYYYMMDD') - 5
        )
        AND EXISTS (
          SELECT 1 FROM datas_com_dado d
          WHERE d.fundo_dtposicao > c.fundo_dtposicao
            AND to_date(d.fundo_dtposicao, 'YYYYMMDD')
                <= to_date(c.fundo_dtposicao, 'YYYYMMDD') + 5
        )
      )
  )

  -- ── 6. Gaps: fundo ativo × dia de mercado sem presença real ─────────
  SELECT
    f.fundo_cnpj,
    f.nome_fundo,
    dm.fundo_dtposicao AS data_faltante
  FROM fundos_ativos f
  CROSS JOIN dias_mercado dm
  LEFT JOIN presenca p
    ON p.fundo_cnpj = f.fundo_cnpj
   AND p.fundo_dtposicao = dm.fundo_dtposicao
  WHERE p.fundo_cnpj IS NULL
  ORDER BY dm.fundo_dtposicao DESC, f.fundo_cnpj
$$;

COMMENT ON FUNCTION get_xml_gaps() IS
'Detecta gaps de XML usando calendário real (generate_series).
Detecta tanto fundos individualmente ausentes quanto dias onde
todo o lote não foi importado. Janela: últimos 45 dias (Seg-Sex).
Rev 2: substitui lógica baseada em presença (quebrava com gap total)
por lógica calendar-first com critério de sandwiche ±5 dias.';
