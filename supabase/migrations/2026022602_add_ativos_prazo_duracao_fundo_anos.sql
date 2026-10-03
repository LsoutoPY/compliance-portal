ALTER TABLE public.ativos
ADD COLUMN IF NOT EXISTS prazo_duracao_fundo_anos integer;

ALTER TABLE public.ativos
DROP CONSTRAINT IF EXISTS ativos_prazo_duracao_fundo_anos_check;

ALTER TABLE public.ativos
ADD CONSTRAINT ativos_prazo_duracao_fundo_anos_check
CHECK (
  prazo_duracao_fundo_anos IS NULL
  OR prazo_duracao_fundo_anos >= 0
);

COMMENT ON COLUMN public.ativos.prazo_duracao_fundo_anos IS
'Prazo manual de duracao para fundos fechados em anos. Usado para calcular dias uteis restantes a partir da data_inicio_atividade de referencia.';
