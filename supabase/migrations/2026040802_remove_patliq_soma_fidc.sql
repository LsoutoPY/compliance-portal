-- Remove a flag patliq_soma_fidc de fundos_caracteristicas.
-- O import-xml passou a calcular o PL diretamente via:
--   fundo_patliq = fundo_valorativos - fundo_valorpagar
-- A flag condicional deixou de ser necessária.

ALTER TABLE public.fundos_caracteristicas
DROP COLUMN IF EXISTS patliq_soma_fidc;
