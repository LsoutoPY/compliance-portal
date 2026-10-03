-- ============================================================
-- Risco de Mercado — Aba Fundos Simplificada
-- Filosofia: VaR Paramétrico diário, volatilidade, drawdown,
--            relação cota vs CDI. Sem Monte Carlo, sem betas.
-- Populada pela edge function calcular-risco-mercado-fundos.
-- ============================================================

-- ── 1. Tabela principal ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.risco_mercado_fundos_diario (
  cnpj                  TEXT        NOT NULL,
  nome_fundo            TEXT,
  data_ref              DATE        NOT NULL,

  -- Dados do dia
  pl                    NUMERIC,    -- PL do fundo nessa data (fundo_patliq)
  cota                  NUMERIC,    -- Valor da cota nessa data (fundo_valorcota)
  delta_cota_pct        NUMERIC,    -- Retorno diário da cota (decimal, ex: 0.001 = 0,1%)
  cdi_valor             NUMERIC,    -- historico_mercado.cdi_acum nessa data
  delta_cdi_pct         NUMERIC,    -- Retorno diário do CDI (decimal)
  relacao_cota_cdi      NUMERIC,    -- |delta_cota_pct| / |delta_cdi_pct|; null se CDI=0
  status_cota_cdi       TEXT        CHECK (status_cota_cdi IN ('ok', 'atencao', 'sem_dados')),

  -- Série para o gráfico "VaR paramétrico diário"
  -- Fórmula: -1.65 × |delta_cota_pct| × 100 (% negativo)
  var_param_dia_pct     NUMERIC,

  -- Agregados "as-of" esta data, janela trailing até 252 obs (mín 20)
  sigma_diario_pct      NUMERIC,    -- Desvio-padrão dos ret diários (% decimal × 100)
  var_95_param_pct      NUMERIC,    -- -1.65 × sigma_diario_pct (negativo = perda)
  var_95_param_rs       NUMERIC,    -- PL × var_95_param_pct / 100 (negativo)
  drawdown_atual_pct    NUMERIC,    -- (pico - cota) / pico × 100 (positivo)
  drawdown_max_pct      NUMERIC,    -- Maior drawdown na janela (positivo)
  n_obs                 INTEGER,    -- Nº de observações usadas no cálculo
  fonte_cota            TEXT,       -- 'xml' | 'hibrido_manual_xml'

  PRIMARY KEY (cnpj, data_ref)
);

COMMENT ON TABLE public.risco_mercado_fundos_diario IS
  'Métricas diárias simplificadas de risco de mercado por CNPJ de fundo. '
  'Populada pela edge function calcular-risco-mercado-fundos (cron diário 19h BRT). '
  'Fonte: posicao_carteira (XML) + rentabilidade_fundos (historico_manual).';

COMMENT ON COLUMN public.risco_mercado_fundos_diario.var_95_param_pct IS
  'VaR Paramétrico 95% como % do PL (negativo = perda). Fórmula: -1.65 × sigma_diario_pct. '
  'Convenção idêntica ao restante do módulo (decimal negativo × 100).';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.drawdown_atual_pct IS
  'Magnitude positiva, igual à convenção de fundos_metricas_mercado.drawdown_atual_pct.';
COMMENT ON COLUMN public.risco_mercado_fundos_diario.relacao_cota_cdi IS
  'Alerta quando > 20 — mesmo gatilho do relatório mensal manual CVPAR.';

CREATE INDEX IF NOT EXISTS idx_rmfd_cnpj_data
  ON public.risco_mercado_fundos_diario (cnpj, data_ref DESC);

CREATE INDEX IF NOT EXISTS idx_rmfd_data_ref
  ON public.risco_mercado_fundos_diario (data_ref DESC);

-- ── 2. View: snapshot mais recente por fundo ────────────────

CREATE OR REPLACE VIEW public.vw_risco_mercado_fundos_diario_atual AS
SELECT DISTINCT ON (cnpj) *
FROM public.risco_mercado_fundos_diario
ORDER BY cnpj, data_ref DESC;

COMMENT ON VIEW public.vw_risco_mercado_fundos_diario_atual IS
  'Última linha de risco_mercado_fundos_diario por CNPJ. '
  'Usada pelo frontend para montar a tabela principal da aba Fundos simplificada.';

-- ── 3. Tabela de log de execuções ───────────────────────────

CREATE TABLE IF NOT EXISTS public.risco_mercado_fundos_calc_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  origem              TEXT        NOT NULL DEFAULT 'cron'
                      CHECK (origem IN ('cron', 'manual')),
  status              TEXT        NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'success', 'error')),
  fundos_processados  INTEGER,
  fundos_com_erro     INTEGER,
  mensagem            TEXT,
  erro_mensagem       TEXT,
  iniciado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em        TIMESTAMPTZ
);

COMMENT ON TABLE public.risco_mercado_fundos_calc_log IS
  'Log de execuções da edge function calcular-risco-mercado-fundos. '
  'Cada linha = 1 run (cron automático ou botão Recalcular).';

CREATE INDEX IF NOT EXISTS idx_rmf_calc_log_inicio
  ON public.risco_mercado_fundos_calc_log (iniciado_em DESC);

-- ── 4. RLS ──────────────────────────────────────────────────

ALTER TABLE public.risco_mercado_fundos_diario  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risco_mercado_fundos_calc_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rmfd_select" ON public.risco_mercado_fundos_diario;
CREATE POLICY "rmfd_select"
  ON public.risco_mercado_fundos_diario FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "rmfd_insert_service" ON public.risco_mercado_fundos_diario;
CREATE POLICY "rmfd_insert_service"
  ON public.risco_mercado_fundos_diario FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "rmf_log_select" ON public.risco_mercado_fundos_calc_log;
CREATE POLICY "rmf_log_select"
  ON public.risco_mercado_fundos_calc_log FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "rmf_log_service" ON public.risco_mercado_fundos_calc_log;
CREATE POLICY "rmf_log_service"
  ON public.risco_mercado_fundos_calc_log FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── 5. RPC para registrar o pg_cron ─────────────────────────
-- Chamada uma vez após deploy via:
--   supabase functions invoke calcular-risco-mercado-fundos \
--     --body '{"action":"setup_cron"}'
--
-- Cron fixo: 19h00 BRT = 22h00 UTC, dias úteis seg-sex.
-- Ajuste aqui se quiser outro horário, depois rode setup_cron novamente.

CREATE OR REPLACE FUNCTION public.setup_risco_mercado_fundos_cron(
  p_function_url TEXT,
  p_service_role TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_name TEXT := 'calcular-risco-mercado-fundos-diario';
  v_cron     TEXT := '0 22 * * 1,2,3,4,5';   -- 22 UTC = 19h BRT, seg-sex
  v_body     TEXT := '{"action":"run","origem":"cron"}';
BEGIN
  -- Remove job anterior se existir
  BEGIN
    PERFORM cron.unschedule(v_job_name);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  PERFORM cron.schedule(
    v_job_name,
    v_cron,
    format($cmd$
      SELECT net.http_post(
        url     := %L,
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || %L,
          'Content-Type',  'application/json'
        ),
        body    := %L::jsonb,
        timeout_milliseconds := 180000
      );
    $cmd$, p_function_url, p_service_role, v_body)
  );

  RETURN jsonb_build_object(
    'job_name', v_job_name,
    'cron_utc', v_cron,
    'function_url', p_function_url
  );
END;
$$;

COMMENT ON FUNCTION public.setup_risco_mercado_fundos_cron(TEXT, TEXT) IS
  'Registra (ou recria) o job pg_cron da edge function calcular-risco-mercado-fundos. '
  'Cron fixo: 22h UTC (19h BRT) dias úteis. '
  'Chamada pela própria edge function quando action=setup_cron.';

REVOKE ALL ON FUNCTION public.setup_risco_mercado_fundos_cron(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.setup_risco_mercado_fundos_cron(TEXT, TEXT)
  TO service_role;
