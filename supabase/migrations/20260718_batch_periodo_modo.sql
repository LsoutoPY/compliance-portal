-- Permite modo "periodo" no log de jobs (UI Rodar Verificação por Período)

ALTER TABLE public.monitoramento_job_log
  DROP CONSTRAINT IF EXISTS monitoramento_job_log_modo_check;

ALTER TABLE public.monitoramento_job_log
  ADD CONSTRAINT monitoramento_job_log_modo_check
  CHECK (modo IN ('diario', 'pendentes', 'periodo'));

COMMENT ON TABLE public.monitoramento_job_log IS
  'Registro de execuções dos jobs de monitoramento (cron diário, pendentes e verificação por período).';
