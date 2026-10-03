-- Configuração do cron de envio automático do Relatório de Rentabilidade.
-- Singleton id=1 — editável via frontend (Configurações → Notificações).
-- Reaproveita public.brt_hora_para_cron_utc(), criada em 20260716_monitoramento_cron_config.sql.

CREATE TABLE IF NOT EXISTS public.rentabilidade_cron_config (
  id             int         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cron_horarios  jsonb       NOT NULL DEFAULT '[
    {"id":"rentabilidade-manha","label":"Manhã","ativo":true,"hora":10,"minuto":0},
    {"id":"rentabilidade-noite","label":"Noite","ativo":true,"hora":19,"minuto":0}
  ]'::jsonb,
  dias_semana    smallint[]  NOT NULL DEFAULT ARRAY[1,2,3,4,5],
  timeout_ms     int         NOT NULL DEFAULT 120000 CHECK (timeout_ms BETWEEN 5000 AND 300000),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.rentabilidade_cron_config IS
  'Configuração do envio automático do Relatório de Rentabilidade. Horários em BRT (UTC-3).';
COMMENT ON COLUMN public.rentabilidade_cron_config.cron_horarios IS
  'Lista de agendamentos: [{id, label, ativo, hora, minuto}] — horários em BRT. Padrão: 10h e 19h.';

INSERT INTO public.rentabilidade_cron_config (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.rentabilidade_cron_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rentabilidade_cron_config_select" ON public.rentabilidade_cron_config;
DROP POLICY IF EXISTS "rentabilidade_cron_config_update" ON public.rentabilidade_cron_config;

CREATE POLICY "rentabilidade_cron_config_select"
  ON public.rentabilidade_cron_config FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "rentabilidade_cron_config_update"
  ON public.rentabilidade_cron_config FOR UPDATE
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- Status dos jobs pg_cron do relatório de rentabilidade (somente leitura)
CREATE OR REPLACE FUNCTION public.get_rentabilidade_cron_status()
RETURNS TABLE (
  jobname   text,
  schedule  text,
  active    boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.jobname::text, j.schedule::text, j.active
  FROM cron.job j
  WHERE j.jobname LIKE 'rentabilidade-%'
  ORDER BY j.jobname;
$$;

REVOKE ALL ON FUNCTION public.get_rentabilidade_cron_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_rentabilidade_cron_status() TO authenticated, service_role;

-- Aplica/recria jobs pg_cron a partir de cron_horarios (JSON)
CREATE OR REPLACE FUNCTION public.apply_rentabilidade_cron_jobs(
  p_function_url   text,
  p_service_role   text,
  p_body_json      jsonb,
  p_timeout_ms     int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cfg           public.rentabilidade_cron_config%ROWTYPE;
  v_horario     jsonb;
  v_id          text;
  v_cron        text;
  v_body        text;
  v_scheduled   jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO cfg FROM public.rentabilidade_cron_config WHERE id = 1;
  v_body := p_body_json::text;

  -- Remove todos os jobs rentabilidade-* existentes
  FOR v_id IN
    SELECT j.jobname::text FROM cron.job j WHERE j.jobname LIKE 'rentabilidade-%'
  LOOP
    BEGIN PERFORM cron.unschedule(v_id); EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;

  FOR v_horario IN SELECT * FROM jsonb_array_elements(COALESCE(cfg.cron_horarios, '[]'::jsonb))
  LOOP
    IF COALESCE((v_horario->>'ativo')::boolean, false) THEN
      v_id := v_horario->>'id';
      IF v_id IS NULL OR v_id = '' THEN
        CONTINUE;
      END IF;
      v_cron := public.brt_hora_para_cron_utc(
        (v_horario->>'hora')::int,
        (v_horario->>'minuto')::int,
        cfg.dias_semana
      );
      PERFORM cron.schedule(
        v_id,
        v_cron,
        format($cmd$
          SELECT net.http_post(
            url := %L,
            headers := jsonb_build_object(
              'Authorization', 'Bearer ' || %L,
              'Content-Type', 'application/json'
            ),
            body := %L::jsonb,
            timeout_milliseconds := %s
          );
        $cmd$, p_function_url, p_service_role, v_body, p_timeout_ms)
      );
      v_scheduled := v_scheduled || jsonb_build_object(
        'id', v_id,
        'label', v_horario->>'label',
        'cron_utc', v_cron
      );
    END IF;
  END LOOP;

  UPDATE public.rentabilidade_cron_config SET updated_at = now() WHERE id = 1;

  RETURN jsonb_build_object('scheduled', v_scheduled);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_rentabilidade_cron_jobs(text, text, jsonb, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_rentabilidade_cron_jobs(text, text, jsonb, int) TO service_role;
