-- Sistema de notificações por e-mail
-- Tabela de destinatários cadastrados por tipo de notificação
-- Tabela de log de envios de notificação de desenquadramento

-- ── Destinatários ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_destinatarios (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo       TEXT        NOT NULL CHECK (tipo IN ('rentabilidade', 'desenquadramento')),
  email      TEXT        NOT NULL,
  nome       TEXT,
  ativo      BOOLEAN     NOT NULL DEFAULT true,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tipo, email)
);

COMMENT ON TABLE  public.email_destinatarios IS 'Cadastro de destinatários de e-mail por tipo de notificação (rentabilidade, desenquadramento).';
COMMENT ON COLUMN public.email_destinatarios.tipo  IS 'Tipo de notificação: rentabilidade | desenquadramento';
COMMENT ON COLUMN public.email_destinatarios.ativo IS 'Se false, o destinatário é ignorado nos envios automáticos e manuais';

ALTER TABLE public.email_destinatarios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "email_destinatarios_select"
  ON public.email_destinatarios FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "email_destinatarios_insert"
  ON public.email_destinatarios FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "email_destinatarios_update"
  ON public.email_destinatarios FOR UPDATE
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "email_destinatarios_delete"
  ON public.email_destinatarios FOR DELETE
  USING (auth.role() = 'authenticated');

-- service_role pode operar sem restrição (usado pela edge function)
CREATE POLICY "email_destinatarios_service_role"
  ON public.email_destinatarios FOR ALL
  USING (auth.role() = 'service_role');

-- ── Log de envios de notificação de desenquadramento ─────────────────────────

CREATE TABLE IF NOT EXISTS public.envios_notificacao_desenquadramento (
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

COMMENT ON TABLE  public.envios_notificacao_desenquadramento IS 'Histórico de envios de notificação de desenquadramento por e-mail.';
COMMENT ON COLUMN public.envios_notificacao_desenquadramento.data_referencia IS 'Data de referência das violações (fundo_dtposicao YYYYMMDD)';
COMMENT ON COLUMN public.envios_notificacao_desenquadramento.origem          IS 'auto = disparado pelo cron/batch; manual = disparado pelo usuário';
COMMENT ON COLUMN public.envios_notificacao_desenquadramento.status          IS 'enviado | erro | sem_violacoes';

-- Evita disparo automático duplicado para a mesma data
CREATE UNIQUE INDEX IF NOT EXISTS envios_notif_desenq_auto_unq
  ON public.envios_notificacao_desenquadramento (data_referencia)
  WHERE origem = 'auto';

CREATE INDEX IF NOT EXISTS idx_envios_notif_desenq_data
  ON public.envios_notificacao_desenquadramento (data_referencia DESC);

ALTER TABLE public.envios_notificacao_desenquadramento ENABLE ROW LEVEL SECURITY;

CREATE POLICY "envios_notif_desenq_select"
  ON public.envios_notificacao_desenquadramento FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "envios_notif_desenq_insert"
  ON public.envios_notificacao_desenquadramento FOR INSERT
  WITH CHECK (auth.role() IN ('authenticated', 'service_role'));

CREATE POLICY "envios_notif_desenq_service_role"
  ON public.envios_notificacao_desenquadramento FOR ALL
  USING (auth.role() = 'service_role');
