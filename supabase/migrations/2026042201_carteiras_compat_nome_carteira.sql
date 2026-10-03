-- Compatibilidade entre ambientes/código legado:
-- alguns consumidores ainda consultam `carteiras.carteira`,
-- enquanto o schema atual usa `carteiras.nome`.
--
-- Esta coluna gerada mantém os dois contratos funcionando
-- sem duplicar fonte de verdade.

ALTER TABLE public.carteiras
ADD COLUMN IF NOT EXISTS carteira TEXT GENERATED ALWAYS AS (nome) STORED;
