-- Horários dinâmicos (JSON) + processamento retroativo (últimas N datas com XML)

ALTER TABLE public.monitoramento_cron_config
  ADD COLUMN IF NOT EXISTS dias_retroativos smallint NOT NULL DEFAULT 1
    CHECK (dias_retroativos BETWEEN 1 AND 30),
  ADD COLUMN IF NOT EXISTS cron_horarios jsonb;

COMMENT ON COLUMN public.monitoramento_cron_config.dias_retroativos IS
  'No modo diário: quantas datas distintas (com XML) processar, da mais recente para trás.';
COMMENT ON COLUMN public.monitoramento_cron_config.cron_horarios IS
  'Lista de agendamentos: [{id, label, ativo, hora, minuto}] — horários em BRT.';

-- Migra colunas fixas meio-dia/tarde para JSON (mantém colunas antigas por compatibilidade)
UPDATE public.monitoramento_cron_config
SET cron_horarios = jsonb_build_array(
  jsonb_build_object(
    'id', 'monitoramento-meio-dia',
    'label', 'Meio-dia',
    'ativo', cron_meio_dia_ativo,
    'hora', cron_meio_dia_hora,
    'minuto', cron_meio_dia_minuto
  ),
  jsonb_build_object(
    'id', 'monitoramento-tarde',
    'label', 'Tarde',
    'ativo', cron_tarde_ativo,
    'hora', cron_tarde_hora,
    'minuto', cron_tarde_minuto
  )
)
WHERE cron_horarios IS NULL;

ALTER TABLE public.monitoramento_cron_config
  ALTER COLUMN cron_horarios SET DEFAULT '[
    {"id":"monitoramento-meio-dia","label":"Meio-dia","ativo":true,"hora":12,"minuto":0},
    {"id":"monitoramento-tarde","label":"Tarde","ativo":true,"hora":18,"minuto":30}
  ]'::jsonb;

UPDATE public.monitoramento_cron_config
SET cron_horarios = '[
  {"id":"monitoramento-meio-dia","label":"Meio-dia","ativo":true,"hora":12,"minuto":0},
  {"id":"monitoramento-tarde","label":"Tarde","ativo":true,"hora":18,"minuto":30}
]'::jsonb
WHERE cron_horarios IS NULL;

ALTER TABLE public.monitoramento_cron_config
  ALTER COLUMN cron_horarios SET NOT NULL;

-- Últimas N datas distintas com posição de carteira
CREATE OR REPLACE FUNCTION public.get_ultimas_datas_posicao(p_limit int DEFAULT 1)
RETURNS TABLE (fundo_dtposicao text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT pc.fundo_dtposicao::text
  FROM public.posicao_carteira pc
  WHERE pc.fundo_dtposicao IS NOT NULL
  ORDER BY pc.fundo_dtposicao DESC
  LIMIT GREATEST(1, LEAST(p_limit, 30));
$$;

REVOKE ALL ON FUNCTION public.get_ultimas_datas_posicao(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_ultimas_datas_posicao(int) TO authenticated, service_role;

-- Status: todos os jobs monitoramento-*
CREATE OR REPLACE FUNCTION public.get_monitoramento_cron_status()
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
  WHERE j.jobname LIKE 'monitoramento-%'
  ORDER BY j.jobname;
$$;

-- Aplica jobs a partir de cron_horarios (JSON)
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
  v_horario     jsonb;
  v_id          text;
  v_cron        text;
  v_body        text;
  v_scheduled   jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO cfg FROM public.monitoramento_cron_config WHERE id = 1;
  v_body := p_body_json::text;

  -- Remove todos os jobs monitoramento-* existentes
  FOR v_id IN
    SELECT j.jobname::text FROM cron.job j WHERE j.jobname LIKE 'monitoramento-%'
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

  UPDATE public.monitoramento_cron_config SET updated_at = now() WHERE id = 1;

  RETURN jsonb_build_object('scheduled', v_scheduled);
END;
$$;
