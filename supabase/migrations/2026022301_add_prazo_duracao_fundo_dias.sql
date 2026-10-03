-- Adiciona prazo de duração para fundos fechados no cardápio de ativos
ALTER TABLE public.fundos_caracteristicas
ADD COLUMN IF NOT EXISTS prazo_duracao_fundo_dias INTEGER;

ALTER TABLE public.fundos_caracteristicas
ADD CONSTRAINT fundos_caracteristicas_prazo_duracao_fundo_dias_check
CHECK (prazo_duracao_fundo_dias IS NULL OR prazo_duracao_fundo_dias >= 0);

COMMENT ON COLUMN public.fundos_caracteristicas.prazo_duracao_fundo_dias
IS 'Prazo de duração do fundo em dias (usado para fundos fechados).';
