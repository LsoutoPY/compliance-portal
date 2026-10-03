-- Evita o envio automático de relatórios parciais com cobertura insuficiente.
-- O envio manual permanece livre para casos excepcionais.

ALTER TABLE public.rentabilidade_cron_config
  ADD COLUMN IF NOT EXISTS min_fundos_parcial integer NOT NULL DEFAULT 25
  CHECK (min_fundos_parcial BETWEEN 1 AND 1000);

UPDATE public.rentabilidade_cron_config
SET min_fundos_parcial = 25
WHERE id = 1 AND min_fundos_parcial IS NULL;

COMMENT ON COLUMN public.rentabilidade_cron_config.min_fundos_parcial IS
  'Quantidade mínima de classes com snapshot V2 para enviar automaticamente um relatório parcial. Relatório completo ignora este limite; envio manual também.';
