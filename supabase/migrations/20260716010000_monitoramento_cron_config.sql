-- Configuração do cron de monitoramento (enquadramento + liquidez)
-- Singleton id=1 — editável via frontend (Configurações → Monitoramento automático)

create extension if not exists pg_cron;
create extension if not exists pg_net;

CREATE TABLE IF NOT EXISTS public.monitoramento_cron_config (
  id                    int         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cron_meio_dia_ativo   boolean     NOT NULL DEFAULT true,
  cron_meio_dia_hora    smallint    NOT NULL DEFAULT 12 CHECK (cron_meio_dia_hora BETWEEN 0 AND 23),
  cron_meio_dia_minuto  smallint    NOT NULL DEFAULT 0  CHECK (cron_meio_dia_minuto BETWEEN 0 AND 59),
  cron_tarde_ativo      boolean     NOT NULL DEFAULT true,
  cron_tarde_hora       smallint    NOT NULL DEFAULT 18 CHECK (cron_tarde_hora BETWEEN 0 AND 23),
  cron_tarde_minuto     smallint    NOT NULL DEFAULT 30 CHECK (cron_tarde_minuto BETWEEN 0 AND 59),
  modos                 text[]      NOT NULL DEFAULT ARRAY['enquadramento', 'liquidez'],
  batch_limit           int         NOT NULL DEFAULT 5 CHECK (batch_limit BETWEEN 1 AND 20),
  auto_continue         boolean     NOT NULL DEFAULT true,
  timeout_ms            int         NOT NULL DEFAULT 120000 CHECK (timeout_ms BETWEEN 5000 AND 300000),
  dias_semana           smallint[]  NOT NULL DEFAULT ARRAY[1,2,3,4,5],
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.monitoramento_cron_config IS
  'Configuração do agendamento automático de enquadramento/liquidez. Horários em BRT (UTC-3).';

INSERT INTO public.monitoramento_cron_config (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.monitoramento_cron_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "monitoramento_cron_config_select" ON public.monitoramento_cron_config;
DROP POLICY IF EXISTS "monitoramento_cron_config_update" ON public.monitoramento_cron_config;

CREATE POLICY "monitoramento_cron_config_select"
  ON public.monitoramento_cron_config FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "monitoramento_cron_config_update"
  ON public.monitoramento_cron_config FOR UPDATE
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- Converte hora/minuto BRT → expressão cron UTC (BRT = UTC-3, sem horário de verão)
CREATE OR REPLACE FUNCTION public.brt_hora_para_cron_utc(
  p_hora_brt   int,
  p_minuto_brt int,
  p_dias       int[] DEFAULT ARRAY[1,2,3,4,5]
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_total_min int;
  v_utc_h     int;
  v_utc_m     int;
  v_dow       text;
BEGIN
  v_total_min := (p_hora_brt * 60 + p_minuto_brt) + (3 * 60); -- +3h para UTC
  v_utc_h := (v_total_min / 60) % 24;
  v_utc_m := v_total_min % 60;
  v_dow := array_to_string(p_dias, ',');
  RETURN format('%s %s * * %s', v_utc_m, v_utc_h, v_dow);
END;
$$;

-- Status dos jobs pg_cron (somente leitura)
CREATE OR REPLACE FUNCTION public.get_monitoramento_cron_status()
RETURNS TABLE (
  jobname   text,
  schedule  text,
  active    boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT j.jobname::text, j.schedule::text, j.active
  FROM cron.job j
  WHERE j.jobname IN ('monitoramento-meio-dia', 'monitoramento-tarde')
  ORDER BY j.jobname;
END;
$$;

-- Aplica/recria jobs pg_cron com base na config + URL/chave passadas pela edge function
CREATE OR REPLACE FUNCTION public.apply_monitoramento_cron_jobs(
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
  cfg           public.monitoramento_cron_config%ROWTYPE;
  v_cron_meio   text;
  v_cron_tarde  text;
  v_body        text;
BEGIN
  SELECT * INTO cfg FROM public.monitoramento_cron_config WHERE id = 1;

  -- Remove jobs anteriores (ignora se não existirem)
  BEGIN PERFORM cron.unschedule('monitoramento-meio-dia'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM cron.unschedule('monitoramento-tarde'); EXCEPTION WHEN OTHERS THEN NULL; END;

  v_body := p_body_json::text;

  IF cfg.cron_meio_dia_ativo THEN
    v_cron_meio := public.brt_hora_para_cron_utc(
      cfg.cron_meio_dia_hora, cfg.cron_meio_dia_minuto, cfg.dias_semana
    );
    PERFORM cron.schedule(
      'monitoramento-meio-dia',
      v_cron_meio,
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
  END IF;

  IF cfg.cron_tarde_ativo THEN
    v_cron_tarde := public.brt_hora_para_cron_utc(
      cfg.cron_tarde_hora, cfg.cron_tarde_minuto, cfg.dias_semana
    );
    PERFORM cron.schedule(
      'monitoramento-tarde',
      v_cron_tarde,
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
  END IF;

  UPDATE public.monitoramento_cron_config SET updated_at = now() WHERE id = 1;

  RETURN jsonb_build_object(
    'meio_dia_ativo', cfg.cron_meio_dia_ativo,
    'tarde_ativo', cfg.cron_tarde_ativo,
    'cron_meio_dia_utc', v_cron_meio,
    'cron_tarde_utc', v_cron_tarde
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_monitoramento_cron_jobs(text, text, jsonb, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_monitoramento_cron_jobs(text, text, jsonb, int) TO service_role;

REVOKE ALL ON FUNCTION public.get_monitoramento_cron_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_monitoramento_cron_status() TO authenticated, service_role;
