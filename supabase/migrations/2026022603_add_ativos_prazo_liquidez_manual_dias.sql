ALTER TABLE public.ativos
ADD COLUMN prazo_liquidez_manual_dias integer;

ALTER TABLE public.ativos
ADD CONSTRAINT ativos_prazo_liquidez_manual_dias_check
CHECK (
  prazo_liquidez_manual_dias IS NULL
  OR prazo_liquidez_manual_dias >= 0
);

COMMENT ON COLUMN public.ativos.prazo_liquidez_manual_dias IS
'Prazo manual de liquidez em dias, usado como override local para calculos internos. Nao altera referencia ANBIMA.';
