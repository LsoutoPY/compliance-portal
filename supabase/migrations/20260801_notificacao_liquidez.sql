-- Notificações por e-mail — módulo de Risco de Liquidez

-- ── Ampliar tipos de destinatário ─────────────────────────────────────────────

ALTER TABLE public.email_destinatarios
  DROP CONSTRAINT IF EXISTS email_destinatarios_tipo_check;

ALTER TABLE public.email_destinatarios
  ADD CONSTRAINT email_destinatarios_tipo_check
  CHECK (tipo IN ('rentabilidade', 'desenquadramento', 'liquidez'));

COMMENT ON COLUMN public.email_destinatarios.tipo IS
  'Tipo de notificação: rentabilidade | desenquadramento | liquidez';

-- ── Log de envios de notificação de liquidez ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.envios_notificacao_liquidez (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  data_referencia  TEXT        NOT NULL,
  qtd_violacoes    INT         NOT NULL DEFAULT 0,
  qtd_fundos       INT         NOT NULL DEFAULT 0,
  destinatarios    TEXT[]      NOT NULL DEFAULT '{}',
  origem           TEXT        NOT NULL DEFAULT 'manual' CHECK (origem IN ('auto', 'manual')),
  enviado_por      UUID        REFERENCES auth.users(id),
  email_id         TEXT,
  status           TEXT        NOT NULL DEFAULT 'enviado' CHECK (status IN ('enviado', 'erro', 'sem_violacoes')),
  erro_mensagem    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.envios_notificacao_liquidez IS
  'Histórico de envios de notificação de risco de liquidez por e-mail.';
COMMENT ON COLUMN public.envios_notificacao_liquidez.data_referencia IS
  'Data de referência dos cálculos (dt_posicao YYYYMMDD)';
COMMENT ON COLUMN public.envios_notificacao_liquidez.qtd_violacoes IS
  'Quantidade de fundos em Hard Limit (status=violacao)';
COMMENT ON COLUMN public.envios_notificacao_liquidez.qtd_fundos IS
  'Quantidade total de fundos com alerta (Hard ou Soft Limit)';

CREATE UNIQUE INDEX IF NOT EXISTS envios_notif_liq_auto_unq
  ON public.envios_notificacao_liquidez (data_referencia)
  WHERE origem = 'auto';

CREATE INDEX IF NOT EXISTS idx_envios_notif_liq_data
  ON public.envios_notificacao_liquidez (data_referencia DESC);

ALTER TABLE public.envios_notificacao_liquidez ENABLE ROW LEVEL SECURITY;

CREATE POLICY "envios_notif_liq_select"
  ON public.envios_notificacao_liquidez FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "envios_notif_liq_insert"
  ON public.envios_notificacao_liquidez FOR INSERT
  WITH CHECK (auth.role() IN ('authenticated', 'service_role'));

CREATE POLICY "envios_notif_liq_service_role"
  ON public.envios_notificacao_liquidez FOR ALL
  USING (auth.role() = 'service_role');
