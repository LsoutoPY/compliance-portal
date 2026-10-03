-- Importação automática de XMLs BTG e Finvest via pg_cron.
-- Singleton id=1 — editável via /configuracoes/monitoramento.
-- Reaproveita public.brt_hora_para_cron_utc() (20260716_monitoramento_cron_config.sql).

CREATE TABLE IF NOT EXISTS public.xml_import_cron_config (
  id                          int         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  btg_cron_horarios           jsonb       NOT NULL DEFAULT '[
    {"id":"xml-import-btg-manha","label":"BTG Manhã","ativo":true,"hora":7,"minuto":30},
    {"id":"xml-import-btg-tarde","label":"BTG Tarde","ativo":true,"hora":17,"minuto":30}
  ]'::jsonb,
  finvest_cron_horarios       jsonb       NOT NULL DEFAULT '[
    {"id":"xml-import-finvest-manha","label":"Finvest Manhã","ativo":true,"hora":8,"minuto":0},
    {"id":"xml-import-finvest-tarde","label":"Finvest Tarde","ativo":true,"hora":18,"minuto":0}
  ]'::jsonb,
  dias_calendario_retroativos smallint    NOT NULL DEFAULT 3 CHECK (dias_calendario_retroativos BETWEEN 1 AND 30),
  apenas_faltantes            boolean     NOT NULL DEFAULT true,
  dias_semana                 smallint[]  NOT NULL DEFAULT ARRAY[1,2,3,4,5],
  timeout_ms                  int         NOT NULL DEFAULT 180000 CHECK (timeout_ms BETWEEN 5000 AND 300000),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.xml_import_cron_config IS
  'Configuração da importação automática de XMLs BTG e Finvest. Horários em BRT (UTC-3).';
COMMENT ON COLUMN public.xml_import_cron_config.btg_cron_horarios IS
  'Agendamentos BTG: [{id, label, ativo, hora, minuto}] — horários em BRT.';
COMMENT ON COLUMN public.xml_import_cron_config.finvest_cron_horarios IS
  'Agendamentos Finvest: [{id, label, ativo, hora, minuto}] — horários em BRT.';
COMMENT ON COLUMN public.xml_import_cron_config.dias_calendario_retroativos IS
  'Quantidade de dias de calendário retroativos a importar (data final = ontem). Ex.: 3 = ontem, anteontem e D-3.';

INSERT INTO public.xml_import_cron_config (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.xml_import_cron_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "xml_import_cron_config_select" ON public.xml_import_cron_config;
DROP POLICY IF EXISTS "xml_import_cron_config_update" ON public.xml_import_cron_config;

CREATE POLICY "xml_import_cron_config_select"
  ON public.xml_import_cron_config FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "xml_import_cron_config_update"
  ON public.xml_import_cron_config FOR UPDATE
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- Log de execuções (cron e "Importar agora" do painel)
CREATE TABLE IF NOT EXISTS public.xml_import_log (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fonte             text        NOT NULL
                    CHECK (fonte IN ('btg', 'finvest')),
  origem            text        NOT NULL DEFAULT 'auto'
                    CHECK (origem IN ('auto', 'manual')),
  status            text        NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'success', 'error')),
  data_inicial      text,
  data_final        text,
  success_files     int,
  error_files       int,
  skipped           int,
  total_records     int,
  mensagem          text,
  erro_mensagem     text,
  inicio            timestamptz NOT NULL DEFAULT now(),
  fim               timestamptz
);

COMMENT ON TABLE public.xml_import_log IS
  'Histórico de importações automáticas/manuais de XML BTG e Finvest.';

CREATE INDEX IF NOT EXISTS idx_xml_import_log_inicio
  ON public.xml_import_log (inicio DESC);

ALTER TABLE public.xml_import_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "xml_import_log_select" ON public.xml_import_log;
CREATE POLICY "xml_import_log_select"
  ON public.xml_import_log FOR SELECT
  USING (auth.role() = 'authenticated');

-- Status dos jobs pg_cron de importação de XML
CREATE OR REPLACE FUNCTION public.get_xml_import_cron_status()
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
  WHERE j.jobname LIKE 'xml-import-btg-%'
     OR j.jobname LIKE 'xml-import-finvest-%'
  ORDER BY j.jobname;
$$;

REVOKE ALL ON FUNCTION public.get_xml_import_cron_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_xml_import_cron_status() TO authenticated, service_role;

-- Aplica/recria jobs pg_cron a partir de btg_cron_horarios + finvest_cron_horarios
CREATE OR REPLACE FUNCTION public.apply_xml_import_cron_jobs(
  p_function_url   text,
  p_service_role   text,
  p_timeout_ms     int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cfg           public.xml_import_cron_config%ROWTYPE;
  v_horario     jsonb;
  v_id          text;
  v_cron        text;
  v_fonte       text;
  v_body        text;
  v_scheduled   jsonb := '[]'::jsonb;
  v_horarios    jsonb;
BEGIN
  SELECT * INTO cfg FROM public.xml_import_cron_config WHERE id = 1;

  FOR v_id IN
    SELECT j.jobname::text FROM cron.job j
    WHERE j.jobname LIKE 'xml-import-btg-%'
       OR j.jobname LIKE 'xml-import-finvest-%'
  LOOP
    BEGIN PERFORM cron.unschedule(v_id); EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;

  FOR v_fonte, v_horarios IN
    SELECT * FROM (VALUES
      ('btg', COALESCE(cfg.btg_cron_horarios, '[]'::jsonb)),
      ('finvest', COALESCE(cfg.finvest_cron_horarios, '[]'::jsonb))
    ) AS t(fonte, horarios)
  LOOP
    FOR v_horario IN SELECT * FROM jsonb_array_elements(v_horarios)
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
        v_body := jsonb_build_object('origem', 'auto', 'fonte', v_fonte)::text;
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
          'fonte', v_fonte,
          'label', v_horario->>'label',
          'cron_utc', v_cron
        );
      END IF;
    END LOOP;
  END LOOP;

  UPDATE public.xml_import_cron_config SET updated_at = now() WHERE id = 1;

  RETURN jsonb_build_object('scheduled', v_scheduled);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_xml_import_cron_jobs(text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_xml_import_cron_jobs(text, text, int) TO service_role;
