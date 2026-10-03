-- Governança do snapshot de rentabilidade:
-- 1) versionamento de cálculo
-- 2) fila de reprocessamento para datas impactadas por import tardio
-- 3) log de jobs para monitoramento operacional

ALTER TABLE public.rentabilidade_snapshot_fundo
  ADD COLUMN IF NOT EXISTS calc_version text NOT NULL DEFAULT 'rentabilidade_v1';

ALTER TABLE public.rentabilidade_snapshot_status
  ADD COLUMN IF NOT EXISTS calc_version text NULL,
  ADD COLUMN IF NOT EXISTS last_job_id uuid NULL;

CREATE TABLE IF NOT EXISTS public.rentabilidade_snapshot_reprocess_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_referencia text NOT NULL UNIQUE CHECK (data_referencia ~ '^\d{4}-\d{2}-\d{2}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'error')),
  requested_source text NOT NULL DEFAULT 'xml_import',
  requested_by uuid NULL,
  priority smallint NOT NULL DEFAULT 100,
  attempts integer NOT NULL DEFAULT 0,
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_rent_snap_queue_status_prio
  ON public.rentabilidade_snapshot_reprocess_queue (status, priority, updated_at);

CREATE TABLE IF NOT EXISTS public.rentabilidade_snapshot_job_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_referencia text NOT NULL CHECK (data_referencia ~ '^\d{4}-\d{2}-\d{2}$'),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'error')),
  source text NOT NULL DEFAULT 'ui_refresh',
  calc_version text NOT NULL DEFAULT 'rentabilidade_v1',
  rows_persisted integer NULL,
  error_message text NULL,
  requested_by uuid NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_rent_snap_job_started
  ON public.rentabilidade_snapshot_job_log (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_rent_snap_job_data
  ON public.rentabilidade_snapshot_job_log (data_referencia, started_at DESC);

COMMENT ON TABLE public.rentabilidade_snapshot_reprocess_queue IS
  'Fila de datas para reprocessamento de snapshot da rentabilidade.';
COMMENT ON TABLE public.rentabilidade_snapshot_job_log IS
  'Log de execução de jobs de rebuild do snapshot de rentabilidade.';

ALTER TABLE public.rentabilidade_snapshot_reprocess_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rentabilidade_snapshot_job_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rent_snap_queue_select_auth" ON public.rentabilidade_snapshot_reprocess_queue;
CREATE POLICY "rent_snap_queue_select_auth"
  ON public.rentabilidade_snapshot_reprocess_queue
  FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "rent_snap_job_select_auth" ON public.rentabilidade_snapshot_job_log;
CREATE POLICY "rent_snap_job_select_auth"
  ON public.rentabilidade_snapshot_job_log
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE OR REPLACE FUNCTION public.enqueue_rentabilidade_snapshot_reprocess(
  p_data_referencia text,
  p_source text DEFAULT 'xml_import',
  p_priority smallint DEFAULT 100
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_data_referencia IS NULL OR p_data_referencia !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'p_data_referencia inválida: %', p_data_referencia;
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.user_is_active() THEN
    RAISE EXCEPTION 'Usuário inativo';
  END IF;

  INSERT INTO public.rentabilidade_snapshot_reprocess_queue (
    data_referencia,
    status,
    requested_source,
    requested_by,
    priority,
    attempts,
    last_error,
    updated_at,
    started_at,
    finished_at
  )
  VALUES (
    p_data_referencia,
    'pending',
    COALESCE(NULLIF(trim(p_source), ''), 'xml_import'),
    auth.uid(),
    COALESCE(p_priority, 100),
    0,
    NULL,
    now(),
    NULL,
    NULL
  )
  ON CONFLICT (data_referencia) DO UPDATE
  SET
    status = 'pending',
    requested_source = EXCLUDED.requested_source,
    requested_by = auth.uid(),
    priority = LEAST(EXCLUDED.priority, public.rentabilidade_snapshot_reprocess_queue.priority),
    last_error = NULL,
    updated_at = now(),
    started_at = NULL,
    finished_at = NULL
  RETURNING id INTO v_id;

  PERFORM public.mark_rentabilidade_snapshot_stale(
    p_data_referencia,
    COALESCE(NULLIF(trim(p_source), ''), 'xml_import')
  );

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_rentabilidade_snapshot_job(
  p_data_referencia text,
  p_source text DEFAULT 'ui_refresh',
  p_calc_version text DEFAULT 'rentabilidade_v1',
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id uuid;
BEGIN
  IF p_data_referencia IS NULL OR p_data_referencia !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'p_data_referencia inválida: %', p_data_referencia;
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.user_is_active() THEN
    RAISE EXCEPTION 'Usuário inativo';
  END IF;

  INSERT INTO public.rentabilidade_snapshot_reprocess_queue (
    data_referencia,
    status,
    requested_source,
    requested_by,
    updated_at,
    started_at,
    finished_at
  )
  VALUES (
    p_data_referencia,
    'running',
    COALESCE(NULLIF(trim(p_source), ''), 'ui_refresh'),
    auth.uid(),
    now(),
    now(),
    NULL
  )
  ON CONFLICT (data_referencia) DO UPDATE
  SET
    status = 'running',
    attempts = public.rentabilidade_snapshot_reprocess_queue.attempts + 1,
    requested_source = COALESCE(NULLIF(trim(p_source), ''), 'ui_refresh'),
    requested_by = auth.uid(),
    updated_at = now(),
    started_at = now(),
    finished_at = NULL,
    last_error = NULL;

  INSERT INTO public.rentabilidade_snapshot_job_log (
    data_referencia,
    status,
    source,
    calc_version,
    requested_by,
    metadata
  )
  VALUES (
    p_data_referencia,
    'running',
    COALESCE(NULLIF(trim(p_source), ''), 'ui_refresh'),
    COALESCE(NULLIF(trim(p_calc_version), ''), 'rentabilidade_v1'),
    auth.uid(),
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_job_id;

  INSERT INTO public.rentabilidade_snapshot_status (
    data_referencia,
    is_stale,
    stale_reason,
    updated_at,
    last_job_id
  )
  VALUES (
    p_data_referencia,
    true,
    'rebuild_running',
    now(),
    v_job_id
  )
  ON CONFLICT (data_referencia) DO UPDATE
  SET
    is_stale = true,
    stale_reason = 'rebuild_running',
    updated_at = now(),
    last_job_id = v_job_id;

  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_rentabilidade_snapshot_job(
  p_job_id uuid,
  p_status text,
  p_rows_persisted integer DEFAULT NULL,
  p_error_message text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.rentabilidade_snapshot_job_log%ROWTYPE;
  v_done_status text;
BEGIN
  IF p_job_id IS NULL THEN
    RETURN;
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.user_is_active() THEN
    RETURN;
  END IF;

  SELECT * INTO v_job
  FROM public.rentabilidade_snapshot_job_log
  WHERE id = p_job_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_done_status := CASE WHEN lower(COALESCE(p_status, '')) = 'success' THEN 'success' ELSE 'error' END;

  UPDATE public.rentabilidade_snapshot_job_log
  SET
    status = v_done_status,
    rows_persisted = p_rows_persisted,
    error_message = CASE WHEN v_done_status = 'error' THEN p_error_message ELSE NULL END,
    finished_at = now()
  WHERE id = p_job_id;

  IF v_done_status = 'success' THEN
    UPDATE public.rentabilidade_snapshot_reprocess_queue
    SET
      status = 'done',
      updated_at = now(),
      finished_at = now(),
      last_error = NULL
    WHERE data_referencia = v_job.data_referencia;

    UPDATE public.rentabilidade_snapshot_status
    SET
      is_stale = false,
      stale_reason = NULL,
      updated_at = now(),
      last_rebuild_at = now(),
      last_rebuild_by = auth.uid(),
      last_rebuild_source = v_job.source,
      calc_version = v_job.calc_version,
      last_job_id = v_job.id
    WHERE data_referencia = v_job.data_referencia;
  ELSE
    UPDATE public.rentabilidade_snapshot_reprocess_queue
    SET
      status = 'error',
      updated_at = now(),
      finished_at = now(),
      last_error = COALESCE(p_error_message, 'erro desconhecido')
    WHERE data_referencia = v_job.data_referencia;

    UPDATE public.rentabilidade_snapshot_status
    SET
      is_stale = true,
      stale_reason = 'rebuild_error',
      updated_at = now(),
      last_job_id = v_job.id
    WHERE data_referencia = v_job.data_referencia;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.upsert_rentabilidade_snapshot_fundos(text, jsonb, text);

CREATE OR REPLACE FUNCTION public.upsert_rentabilidade_snapshot_fundos(
  p_data_referencia text,
  p_rows jsonb,
  p_source text DEFAULT 'manual',
  p_calc_version text DEFAULT 'rentabilidade_v1'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF p_data_referencia IS NULL OR p_data_referencia !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'p_data_referencia inválida: %', p_data_referencia;
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.user_is_active() THEN
    RAISE EXCEPTION 'Usuário inativo';
  END IF;

  DELETE FROM public.rentabilidade_snapshot_fundo
  WHERE data_posicao = p_data_referencia;

  INSERT INTO public.rentabilidade_snapshot_fundo (
    data_posicao,
    fundo_key,
    fundo_cnpj,
    fundo_isin,
    nome_fundo,
    valor_cota,
    pl,
    quantidade,
    retorno_dia_pct,
    retorno_acum_pct,
    retorno_mes_pct,
    retorno_ano_pct,
    retorno_sem_pct,
    retorno_12m_pct,
    cdi_dia_pct,
    cdi_mes_pct,
    cdi_ano_pct,
    pct_cdi,
    cdi_plus_dia_pct,
    cdi_plus_aa_pct,
    pct_cdi_mes,
    cdi_plus_mes_pct,
    cdi_plus_aa_mes_pct,
    pct_cdi_ano,
    cdi_plus_ano_pct,
    cdi_plus_aa_ano_pct,
    cdi_12m_pct,
    pct_cdi_12m,
    cdi_plus_12m_pct,
    cdi_plus_aa_12m_pct,
    is_fidc,
    administrador,
    calc_version,
    snapshot_created_at,
    snapshot_updated_at
  )
  SELECT
    p_data_referencia,
    r.fundo_key,
    r.fundo_cnpj,
    NULLIF(r.fundo_isin, ''),
    r.nome_fundo,
    r.valor_cota,
    r.pl,
    r.quantidade,
    r.retorno_dia_pct,
    r.retorno_acum_pct,
    r.retorno_mes_pct,
    r.retorno_ano_pct,
    r.retorno_sem_pct,
    r.retorno_12m_pct,
    r.cdi_dia_pct,
    r.cdi_mes_pct,
    r.cdi_ano_pct,
    r.pct_cdi,
    r.cdi_plus_dia_pct,
    r.cdi_plus_aa_pct,
    r.pct_cdi_mes,
    r.cdi_plus_mes_pct,
    r.cdi_plus_aa_mes_pct,
    r.pct_cdi_ano,
    r.cdi_plus_ano_pct,
    r.cdi_plus_aa_ano_pct,
    r.cdi_12m_pct,
    r.pct_cdi_12m,
    r.cdi_plus_12m_pct,
    r.cdi_plus_aa_12m_pct,
    COALESCE(r.is_fidc, false),
    r.administrador,
    COALESCE(NULLIF(trim(p_calc_version), ''), 'rentabilidade_v1'),
    now(),
    now()
  FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb)) AS r(
    fundo_key text,
    fundo_cnpj text,
    fundo_isin text,
    nome_fundo text,
    valor_cota numeric,
    pl numeric,
    quantidade numeric,
    retorno_dia_pct numeric,
    retorno_acum_pct numeric,
    retorno_mes_pct numeric,
    retorno_ano_pct numeric,
    retorno_sem_pct numeric,
    retorno_12m_pct numeric,
    cdi_dia_pct numeric,
    cdi_mes_pct numeric,
    cdi_ano_pct numeric,
    pct_cdi numeric,
    cdi_plus_dia_pct numeric,
    cdi_plus_aa_pct numeric,
    pct_cdi_mes numeric,
    cdi_plus_mes_pct numeric,
    cdi_plus_aa_mes_pct numeric,
    pct_cdi_ano numeric,
    cdi_plus_ano_pct numeric,
    cdi_plus_aa_ano_pct numeric,
    cdi_12m_pct numeric,
    pct_cdi_12m numeric,
    cdi_plus_12m_pct numeric,
    cdi_plus_aa_12m_pct numeric,
    is_fidc boolean,
    administrador text
  )
  WHERE r.fundo_key IS NOT NULL
    AND r.fundo_cnpj IS NOT NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.rentabilidade_snapshot_status (
    data_referencia,
    is_stale,
    stale_reason,
    updated_at,
    last_rebuild_at,
    last_rebuild_by,
    last_rebuild_source,
    calc_version
  )
  VALUES (
    p_data_referencia,
    false,
    NULL,
    now(),
    now(),
    auth.uid(),
    COALESCE(NULLIF(trim(p_source), ''), 'manual'),
    COALESCE(NULLIF(trim(p_calc_version), ''), 'rentabilidade_v1')
  )
  ON CONFLICT (data_referencia) DO UPDATE
  SET
    is_stale = false,
    stale_reason = NULL,
    updated_at = now(),
    last_rebuild_at = now(),
    last_rebuild_by = auth.uid(),
    last_rebuild_source = COALESCE(NULLIF(trim(p_source), ''), 'manual'),
    calc_version = COALESCE(NULLIF(trim(p_calc_version), ''), 'rentabilidade_v1');

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_rentabilidade_snapshot_reprocess(text, text, smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_rentabilidade_snapshot_job(text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_rentabilidade_snapshot_job(uuid, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_rentabilidade_snapshot_fundos(text, jsonb, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.enqueue_rentabilidade_snapshot_reprocess(text, text, smallint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_rentabilidade_snapshot_job(text, text, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finish_rentabilidade_snapshot_job(uuid, text, integer, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_rentabilidade_snapshot_fundos(text, jsonb, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
