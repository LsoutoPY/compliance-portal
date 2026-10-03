-- Adiciona flag para fundos onde o fundo_patliq do header XML não inclui
-- os recebíveis da seção <FIDC>. Quando true, o import-xml somará
-- automaticamente o valorfinanceiro da seção FIDC ao fundo_patliq.
ALTER TABLE public.fundos_caracteristicas
ADD COLUMN IF NOT EXISTS patliq_soma_fidc boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.fundos_caracteristicas.patliq_soma_fidc
IS 'true = o fundo_patliq do header XML NÃO inclui os recebíveis da seção FIDC; o import-xml somará automaticamente ao valor do header.';
