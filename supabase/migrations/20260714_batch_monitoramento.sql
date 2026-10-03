-- ============================================================
-- Migration: Batch Monitoramento — RPCs de pendentes, tabela de log e pg_cron
-- Cria a infraestrutura server-side para:
--   1. Detectar pares (fundo, data) com posição mas sem cálculo
--   2. Logar execuções do job de monitoramento automático
--   3. Agendar verificação às 12h e 18:30 BRT via pg_cron
-- ============================================================

-- ── 1. Tabela de log dos jobs de monitoramento ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.monitoramento_job_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  modo          text        NOT NULL CHECK (modo IN ('diario', 'pendentes')),
  status        text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'error')),
  inicio        timestamptz NOT NULL DEFAULT now(),
  fim           timestamptz NULL,
  data_inicio   text        NULL,  -- YYYYMMDD
  data_fim      text        NULL,  -- YYYYMMDD
  total_pares   integer     NOT NULL DEFAULT 0,
  processados   integer     NOT NULL DEFAULT 0,
  erros         integer     NOT NULL DEFAULT 0,
  detalhes      jsonb       NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.monitoramento_job_log IS
  'Registro de execuções dos jobs de monitoramento automático (cron diário e reprocesso de pendentes).';

CREATE INDEX IF NOT EXISTS idx_mjl_status  ON public.monitoramento_job_log (status);
CREATE INDEX IF NOT EXISTS idx_mjl_inicio  ON public.monitoramento_job_log (inicio DESC);
CREATE INDEX IF NOT EXISTS idx_mjl_modo    ON public.monitoramento_job_log (modo);

ALTER TABLE public.monitoramento_job_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mjl_select"         ON public.monitoramento_job_log;
DROP POLICY IF EXISTS "mjl_insert_update"  ON public.monitoramento_job_log;

CREATE POLICY "mjl_select"
  ON public.monitoramento_job_log FOR SELECT USING (true);

CREATE POLICY "mjl_insert_update"
  ON public.monitoramento_job_log FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- ── 2. RPC: pares monitorados com POSIÇÃO mas SEM enquadramento calculado ──
-- Retorna (fundo_cnpj, fundo_isin, fundo_dtposicao) no intervalo onde
-- existe linha em posicao_carteira (gestor monitorado) mas NENHUM resultado
-- em enquadramento_resultado para aquele trio.
-- Ordem: data ASC (obrigatório para tributário MM-10d).
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
LANGUAGE sql
STABLE PARALLEL SAFE
AS $$
  WITH pares_com_posicao AS (
    SELECT
      p.fundo_cnpj,
      COALESCE(p.fundo_isin, '')                            AS fundo_isin,
      p.fundo_dtposicao,
      MAX(COALESCE(p.nome_fundo, p.fundo_nome, ''))         AS nome_fundo
    FROM public.posicao_carteira p
    WHERE p.fundo_dtposicao >= p_data_inicio
      AND p.fundo_dtposicao <= p_data_fim
      AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
      AND p.fundo_cnpj IS NOT NULL
    GROUP BY p.fundo_cnpj, COALESCE(p.fundo_isin, ''), p.fundo_dtposicao
  ),
  pares_calculados AS (
    SELECT DISTINCT fundo_cnpj, fundo_isin, fundo_dtposicao
    FROM public.enquadramento_resultado
    WHERE fundo_dtposicao >= p_data_inicio
      AND fundo_dtposicao <= p_data_fim
  )
  SELECT
    pos.fundo_cnpj,
    pos.fundo_isin,
    pos.fundo_dtposicao,
    pos.nome_fundo
  FROM pares_com_posicao pos
  LEFT JOIN pares_calculados calc
    ON calc.fundo_cnpj    = pos.fundo_cnpj
   AND calc.fundo_isin    = pos.fundo_isin
   AND calc.fundo_dtposicao = pos.fundo_dtposicao
  WHERE calc.fundo_cnpj IS NULL
  ORDER BY pos.fundo_dtposicao ASC, pos.fundo_cnpj, pos.fundo_isin
$$;

COMMENT ON FUNCTION public.get_pares_pendentes_enquadramento IS
  'Retorna pares (fundo_cnpj, fundo_isin, fundo_dtposicao) monitorados com posição mas sem resultado em enquadramento_resultado. Intervalo: p_data_inicio..p_data_fim (YYYYMMDD). Ordem cronológica ASC (necessária para regras tributárias MM-10d).';

-- ── 3. RPC: pares monitorados com POSIÇÃO mas SEM liquidez calculada ────────
-- Retorna (fundo_cnpj, fundo_dtposicao) onde existe posição mas não há
-- registro em liquidez_monitoramento_risco ou status = 'pendente'.
CREATE OR REPLACE FUNCTION public.get_pares_pendentes_liquidez(
  p_data_inicio text,
  p_data_fim    text
)
RETURNS TABLE (
  fundo_cnpj      text,
  fundo_isin      text,
  fundo_dtposicao text,
  nome_fundo      text,
  nivel1_categoria text
)
LANGUAGE sql
STABLE PARALLEL SAFE
AS $$
  WITH pares_com_posicao AS (
    SELECT
      p.fundo_cnpj,
      COALESCE(p.fundo_isin, '')                            AS fundo_isin,
      p.fundo_dtposicao,
      MAX(COALESCE(p.nome_fundo, p.fundo_nome, ''))         AS nome_fundo
    FROM public.posicao_carteira p
    WHERE p.fundo_dtposicao >= p_data_inicio
      AND p.fundo_dtposicao <= p_data_fim
      AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
      AND p.fundo_cnpj IS NOT NULL
    GROUP BY p.fundo_cnpj, COALESCE(p.fundo_isin, ''), p.fundo_dtposicao
  ),
  nivel1 AS (
    -- Categoria do fundo para inferir classe ANBIMA (prefere cnpj_fundo, fallback cnpj_classe)
    SELECT
      COALESCE(fc.cnpj_fundo, fc.cnpj_classe)  AS fundo_cnpj,
      MAX(fc.nivel1_categoria)                  AS nivel1_categoria
    FROM public.fundos_caracteristicas fc
    WHERE fc.nivel1_categoria IS NOT NULL
    GROUP BY COALESCE(fc.cnpj_fundo, fc.cnpj_classe)
  ),
  pares_calculados AS (
    SELECT fundo_cnpj, dt_posicao
    FROM public.liquidez_monitoramento_risco
    WHERE dt_posicao >= p_data_inicio
      AND dt_posicao <= p_data_fim
      AND status <> 'pendente'
  )
  SELECT
    pos.fundo_cnpj,
    pos.fundo_isin,
    pos.fundo_dtposicao,
    pos.nome_fundo,
    COALESCE(n.nivel1_categoria, '')  AS nivel1_categoria
  FROM pares_com_posicao pos
  LEFT JOIN nivel1 n
    ON public.normalize_cnpj_digits(n.fundo_cnpj) = public.normalize_cnpj_digits(pos.fundo_cnpj)
  LEFT JOIN pares_calculados calc
    ON public.normalize_cnpj_digits(calc.fundo_cnpj) = public.normalize_cnpj_digits(pos.fundo_cnpj)
   AND calc.dt_posicao = pos.fundo_dtposicao
  WHERE calc.fundo_cnpj IS NULL
  ORDER BY pos.fundo_dtposicao ASC, pos.fundo_cnpj, pos.fundo_isin
$$;

COMMENT ON FUNCTION public.get_pares_pendentes_liquidez IS
  'Retorna pares monitorados com posição mas sem cálculo de liquidez concluído (sem registro em liquidez_monitoramento_risco ou status=pendente). Inclui nivel1_categoria para inferir classe ANBIMA. Ordem cronológica ASC.';

-- ── 4. pg_cron — jobs de monitoramento automático ─────────────────────────
-- IMPORTANTE: antes de executar este bloco você deve:
--   a) Habilitar pg_cron no Supabase Dashboard → Database → Extensions
--   b) Habilitar pg_net no Supabase Dashboard → Database → Extensions
--   c) Substituir <PROJECT_URL> pela URL do seu projeto Supabase
--      ex: https://abcdefghijkl.supabase.co
--   d) Substituir <SERVICE_ROLE_KEY> pela chave service_role do seu projeto
--      (Dashboard → Settings → API → service_role secret)
--      Dica: use Vault do Supabase para não expor a chave em texto puro.
--
-- Horários em UTC (BRT = UTC-3, sem horário de verão no Brasil):
--   12:00 BRT = 15:00 UTC  → cron '0 15 * * 1-5'
--   18:30 BRT = 21:30 UTC  → cron '30 21 * * 1-5'

-- Descomente as linhas abaixo após configurar as extensões e substituir os placeholders:

/*
SELECT cron.schedule(
  'monitoramento-meio-dia',
  '0 15 * * 1-5',
  $$
  SELECT net.http_post(
    url     := 'https://<PROJECT_URL>/functions/v1/batch-monitoramento',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
      'Content-Type',  'application/json'
    ),
    body    := '{"mode":"diario","modos":["enquadramento","liquidez"]}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'monitoramento-tarde',
  '30 21 * * 1-5',
  $$
  SELECT net.http_post(
    url     := 'https://<PROJECT_URL>/functions/v1/batch-monitoramento',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
      'Content-Type',  'application/json'
    ),
    body    := '{"mode":"diario","modos":["enquadramento","liquidez"]}'::jsonb
  );
  $$
);
*/

-- Para listar os jobs cadastrados: SELECT * FROM cron.job;
-- Para remover um job: SELECT cron.unschedule('monitoramento-meio-dia');
