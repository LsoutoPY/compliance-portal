-- Notificações de liquidez: um e-mail por fundo e tipo de limite (soft / hard)

ALTER TABLE public.envios_notificacao_liquidez
  ADD COLUMN IF NOT EXISTS fundo_cnpj TEXT,
  ADD COLUMN IF NOT EXISTS tipo_limite TEXT
    CHECK (tipo_limite IS NULL OR tipo_limite IN ('soft', 'hard'));

COMMENT ON COLUMN public.envios_notificacao_liquidez.fundo_cnpj IS
  'CNPJ do fundo notificado (14 dígitos). Um registro por fundo + tipo de limite.';
COMMENT ON COLUMN public.envios_notificacao_liquidez.tipo_limite IS
  'Tipo de alerta enviado: soft (Soft Limit) ou hard (Hard Limit).';

DROP INDEX IF EXISTS envios_notif_liq_auto_unq;

CREATE UNIQUE INDEX IF NOT EXISTS envios_notif_liq_auto_fundo_unq
  ON public.envios_notificacao_liquidez (data_referencia, fundo_cnpj, tipo_limite)
  WHERE origem = 'auto'
    AND fundo_cnpj IS NOT NULL
    AND tipo_limite IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_envios_notif_liq_fundo
  ON public.envios_notificacao_liquidez (fundo_cnpj, data_referencia DESC);
