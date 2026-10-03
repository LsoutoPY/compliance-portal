-- Garante inferência de ON CONFLICT para import-fundos-caracteristicas (.upsert onConflict: codigo_anbima).
--
-- O índice único parcial (WHERE codigo_anbima IS NOT NULL) da migração 20260512100002 pode não ser
-- escolhido pelo PostgREST ao montar INSERT ... ON CONFLICT (codigo_anbima), gerando:
-- "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--
-- Índice UNIQUE na coluna inteira: no PostgreSQL, várias linhas com codigo_anbima NULL não violam
-- UNIQUE (NULL é tratado como distinto em comparações de unicidade).

DROP INDEX IF EXISTS public.fundos_caracteristicas_codigo_anbima_key;

CREATE UNIQUE INDEX fundos_caracteristicas_codigo_anbima_key
  ON public.fundos_caracteristicas (codigo_anbima);

COMMENT ON INDEX public.fundos_caracteristicas_codigo_anbima_key
IS 'Chave para upsert da importação ANBIMA (codigo_anbima). Vários NULL permitidos.';
