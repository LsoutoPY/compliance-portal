-- Orquestração V2 do envio automático de rentabilidade.
--
-- A fila calcula uma classe por execução; os três jobs abaixo apenas aumentam
-- a vazão. Eles nunca calculam a mesma classe graças ao FOR UPDATE SKIP LOCKED
-- de claim_rentabilidade_snapshot_reprocess_v2().

CREATE OR REPLACE FUNCTION public.apply_rentabilidade_snapshot_v2_worker_job(
  p_function_url text,
  p_service_role text,
  p_timeout_ms int DEFAULT 60000,
  p_worker_slots int DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slot int;
  v_slots int := greatest(1, least(coalesce(p_worker_slots, 3), 6));
  v_jobname text;
  v_jobs jsonb := '[]'::jsonb;
BEGIN
  -- Remove o worker antigo e todos os slots previamente criados.
  FOR v_jobname IN
    SELECT jobname::text
    FROM cron.job
    WHERE jobname = 'rentabilidade-snapshot-v2-worker'
       OR jobname LIKE 'rentabilidade-snapshot-v2-worker-%'
  LOOP
    BEGIN
      PERFORM cron.unschedule(v_jobname);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;

  FOR v_slot IN 1..v_slots LOOP
    v_jobname := format('rentabilidade-snapshot-v2-worker-%s', v_slot);
    PERFORM cron.schedule(
      v_jobname,
      '* * * * *',
      format($cmd$
        SELECT net.http_post(
          url := %L,
          headers := jsonb_build_object('Authorization', 'Bearer ' || %L, 'Content-Type', 'application/json'),
          body := '{}'::jsonb,
          timeout_milliseconds := %s
        );
      $cmd$, p_function_url, p_service_role, p_timeout_ms)
    );
    v_jobs := v_jobs || jsonb_build_object('id', v_jobname, 'cron_utc', '* * * * *');
  END LOOP;

  RETURN jsonb_build_object('scheduled', v_jobs, 'worker_slots', v_slots);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_rentabilidade_snapshot_v2_worker_job(text, text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_rentabilidade_snapshot_v2_worker_job(text, text, int, int) TO service_role;

-- Cobertura leve, executada no Postgres: universo de classes que tiveram XML
-- nos últimos 10 dias e não estão inativas. O cron de e-mail não precisa mais
-- carregar o histórico de posição para descobrir fundos sem XML.
CREATE OR REPLACE FUNCTION public.get_rentabilidade_xml_coverage_v2(
  p_data_referencia date,
  p_janela_dias int DEFAULT 10
)
RETURNS TABLE (
  fundo_cnpj text,
  fundo_isin text,
  nome_fundo text,
  ultima_data_iso date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH headers AS (
    SELECT
      regexp_replace(coalesce(p.fundo_cnpj, ''), '\D', '', 'g') AS fundo_cnpj,
      upper(trim(coalesce(p.fundo_isin, ''))) AS fundo_isin,
      coalesce(nullif(trim(p.nome_fundo), ''), nullif(trim(p.fundo_nome), ''), p.fundo_cnpj) AS nome_fundo,
      to_date(p.fundo_dtposicao, 'YYYYMMDD') AS data_posicao
    FROM public.posicao_carteira p
    WHERE p.fundo_dtposicao BETWEEN to_char(p_data_referencia - greatest(0, coalesce(p_janela_dias, 10)), 'YYYYMMDD')
                               AND to_char(p_data_referencia, 'YYYYMMDD')
      AND p.section IN ('caixa', 'despesas')
      AND coalesce(p.fundo_valorcota, 0) > 0
      AND public.is_gestor_monitorado(p.fundo_cnpjgestor)
  ),
  classes AS (
    SELECT DISTINCT ON (fundo_cnpj, fundo_isin)
      fundo_cnpj,
      fundo_isin,
      nome_fundo,
      data_posicao
    FROM headers
    WHERE fundo_cnpj <> ''
    ORDER BY fundo_cnpj, fundo_isin, data_posicao DESC, nome_fundo
  )
  SELECT fundo_cnpj, nullif(fundo_isin, ''), nome_fundo, data_posicao
  FROM classes
  ORDER BY nome_fundo, fundo_cnpj, fundo_isin;
$$;

REVOKE ALL ON FUNCTION public.get_rentabilidade_xml_coverage_v2(date, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_rentabilidade_xml_coverage_v2(date, int) TO service_role;

COMMENT ON FUNCTION public.get_rentabilidade_xml_coverage_v2(date, int) IS
  'Universo recente de classes para o banner de XML faltante do relatório V2; cálculo executado no Postgres.';

NOTIFY pgrst, 'reload schema';
