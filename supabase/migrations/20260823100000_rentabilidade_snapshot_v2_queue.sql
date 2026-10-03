-- Fila granular: uma classe CNPJ + ISIN em uma data por item.
-- O limite de CPU da Edge Function e respeitado porque cada worker calcula
-- somente um item da fila.

CREATE TABLE IF NOT EXISTS public.rentabilidade_snapshot_reprocess_item_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_referencia date NOT NULL,
  fundo_cnpj text NOT NULL,
  fundo_isin text NOT NULL,
  fundo_nome text NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'error')),
  priority smallint NOT NULL DEFAULT 100,
  attempts integer NOT NULL DEFAULT 0,
  requested_source text NOT NULL DEFAULT 'xml_import',
  last_error text NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (data_referencia, fundo_cnpj, fundo_isin)
);

CREATE INDEX IF NOT EXISTS idx_rent_snap_v2_queue_claim
  ON public.rentabilidade_snapshot_reprocess_item_v2 (status, priority, requested_at);

ALTER TABLE public.rentabilidade_snapshot_reprocess_item_v2 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rent_snap_v2_queue_select_auth" ON public.rentabilidade_snapshot_reprocess_item_v2;
CREATE POLICY "rent_snap_v2_queue_select_auth"
  ON public.rentabilidade_snapshot_reprocess_item_v2 FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE OR REPLACE FUNCTION public.enqueue_rentabilidade_snapshot_reprocess_v2(
  p_data_referencia date,
  p_fundo_cnpj text,
  p_fundo_isin text,
  p_fundo_nome text DEFAULT NULL,
  p_source text DEFAULT 'xml_import',
  p_priority smallint DEFAULT 100
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  IF p_data_referencia IS NULL OR COALESCE(regexp_replace(p_fundo_cnpj, '\D', '', 'g'), '') = '' OR COALESCE(trim(p_fundo_isin), '') = '' THEN
    RAISE EXCEPTION 'data_referencia, fundo_cnpj e fundo_isin sao obrigatorios';
  END IF;
  INSERT INTO public.rentabilidade_snapshot_reprocess_item_v2 (
    data_referencia, fundo_cnpj, fundo_isin, fundo_nome, status, priority, requested_source,
    requested_at, updated_at, started_at, finished_at, last_error
  ) VALUES (
    p_data_referencia, regexp_replace(p_fundo_cnpj, '\D', '', 'g'), upper(trim(p_fundo_isin)), nullif(trim(p_fundo_nome), ''),
    'pending', COALESCE(p_priority, 100), COALESCE(nullif(trim(p_source), ''), 'xml_import'), now(), now(), NULL, NULL, NULL
  ) ON CONFLICT (data_referencia, fundo_cnpj, fundo_isin) DO UPDATE SET
    fundo_nome = COALESCE(EXCLUDED.fundo_nome, public.rentabilidade_snapshot_reprocess_item_v2.fundo_nome),
    status = 'pending', priority = LEAST(EXCLUDED.priority, public.rentabilidade_snapshot_reprocess_item_v2.priority),
    requested_source = EXCLUDED.requested_source, requested_at = now(), updated_at = now(),
    started_at = NULL, finished_at = NULL, last_error = NULL
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_rentabilidade_snapshot_reprocess_v2()
RETURNS TABLE (
  id uuid, data_referencia date, fundo_cnpj text, fundo_isin text, fundo_nome text, attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT q.id FROM public.rentabilidade_snapshot_reprocess_item_v2 q
    WHERE q.status = 'pending'
    ORDER BY q.priority ASC, q.requested_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE public.rentabilidade_snapshot_reprocess_item_v2 q
    SET status = 'running', attempts = attempts + 1, started_at = now(), updated_at = now()
    FROM candidate c WHERE q.id = c.id
    RETURNING q.*
  ) SELECT c.id, c.data_referencia, c.fundo_cnpj, c.fundo_isin, c.fundo_nome, c.attempts FROM claimed c;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_rentabilidade_snapshot_reprocess_v2(
  p_id uuid,
  p_success boolean,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.rentabilidade_snapshot_reprocess_item_v2
  SET status = CASE WHEN p_success THEN 'done' WHEN attempts < 3 THEN 'pending' ELSE 'error' END,
      last_error = CASE WHEN p_success THEN NULL ELSE left(COALESCE(p_error, 'Erro sem detalhe'), 1000) END,
      finished_at = CASE WHEN p_success THEN now() ELSE NULL END,
      updated_at = now()
  WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_rentabilidade_snapshot_v2_worker_job(
  p_function_url text,
  p_service_role text,
  p_timeout_ms int DEFAULT 60000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN PERFORM cron.unschedule('rentabilidade-snapshot-v2-worker'); EXCEPTION WHEN OTHERS THEN NULL; END;
  PERFORM cron.schedule(
    'rentabilidade-snapshot-v2-worker', '* * * * *',
    format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', 'Bearer ' || %L, 'Content-Type', 'application/json'),
        body := '{}'::jsonb,
        timeout_milliseconds := %s
      );
    $cmd$, p_function_url, p_service_role, p_timeout_ms)
  );
  RETURN jsonb_build_object('scheduled', 'rentabilidade-snapshot-v2-worker', 'cron_utc', '* * * * *');
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_rentabilidade_snapshot_reprocess_v2(date, text, text, text, text, smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_rentabilidade_snapshot_reprocess_v2() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_rentabilidade_snapshot_reprocess_v2(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_rentabilidade_snapshot_v2_worker_job(text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_rentabilidade_snapshot_reprocess_v2(date, text, text, text, text, smallint) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_rentabilidade_snapshot_reprocess_v2() TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_rentabilidade_snapshot_reprocess_v2(uuid, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_rentabilidade_snapshot_v2_worker_job(text, text, int) TO service_role;

NOTIFY pgrst, 'reload schema';
