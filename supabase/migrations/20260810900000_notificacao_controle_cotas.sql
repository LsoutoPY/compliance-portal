-- Notificações por e-mail — Alertas 3σ do Controle Cotas

-- ── Ampliar tipos de destinatário ─────────────────────────────────────────────

ALTER TABLE public.email_destinatarios
  DROP CONSTRAINT IF EXISTS email_destinatarios_tipo_check;

ALTER TABLE public.email_destinatarios
  ADD CONSTRAINT email_destinatarios_tipo_check
    CHECK (tipo IN ('rentabilidade', 'desenquadramento', 'liquidez', 'controle_cotas'));

COMMENT ON COLUMN public.email_destinatarios.tipo IS
  'Tipo de notificação: rentabilidade | desenquadramento | liquidez | controle_cotas';

-- ── Log de envios de alerta Controle Cotas ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.envios_notificacao_controle_cotas (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  data_referencia     TEXT        NOT NULL,
  qtd_alertas         INT         NOT NULL DEFAULT 0,
  qtd_carteiras       INT         NOT NULL DEFAULT 0,
  carteiras_em_alerta TEXT[]      NOT NULL DEFAULT '{}',
  destinatarios       TEXT[]      NOT NULL DEFAULT '{}',
  origem              TEXT        NOT NULL DEFAULT 'manual' CHECK (origem IN ('auto', 'manual')),
  enviado_por         UUID        REFERENCES auth.users(id),
  email_id            TEXT,
  status              TEXT        NOT NULL DEFAULT 'enviado'
                        CHECK (status IN ('enviado', 'erro', 'sem_alertas')),
  erro_mensagem       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.envios_notificacao_controle_cotas IS
  'Histórico de envios de alerta 3σ do Controle Cotas por e-mail.';
COMMENT ON COLUMN public.envios_notificacao_controle_cotas.data_referencia IS
  'Data de referência dos alertas (YYYY-MM-DD — controle_cotas_metricas.data_posicao)';
COMMENT ON COLUMN public.envios_notificacao_controle_cotas.carteiras_em_alerta IS
  'Carteiras em alerta 3σ na data — chave de deduplicação dos envios automáticos';

CREATE INDEX IF NOT EXISTS idx_envios_notif_cc_data
  ON public.envios_notificacao_controle_cotas (data_referencia DESC);

CREATE INDEX IF NOT EXISTS idx_envios_notif_cc_origem_data
  ON public.envios_notificacao_controle_cotas (data_referencia, origem, created_at DESC);

ALTER TABLE public.envios_notificacao_controle_cotas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "envios_notif_cc_select"
  ON public.envios_notificacao_controle_cotas FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "envios_notif_cc_insert"
  ON public.envios_notificacao_controle_cotas FOR INSERT
  WITH CHECK (auth.role() IN ('authenticated', 'service_role'));

CREATE POLICY "envios_notif_cc_service_role"
  ON public.envios_notificacao_controle_cotas FOR ALL
  USING (auth.role() = 'service_role');
