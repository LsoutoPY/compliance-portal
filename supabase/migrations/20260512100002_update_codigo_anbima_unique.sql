-- Troca a chave única de cnpj_classe para codigo_anbima em fundos_caracteristicas.
-- Contexto: na planilha ANBIMA pós-175, múltiplas subclasses de um mesmo FIDC
-- compartilham o mesmo cnpj_classe E cnpj_fundo. O identificador único real é o
-- codigo_anbima (ex: C0000638234, S0000651771). Registros sem codigo_anbima
-- (inseridos manualmente pelo sistema) continuam permitidos pois o unique index
-- usa WHERE codigo_anbima IS NOT NULL.

-- 1. Remove unique constraint em cnpj_classe se existir
DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  WHERE t.relname = 'fundos_caracteristicas'
    AND c.contype = 'u'
    AND pg_get_constraintdef(c.oid) ILIKE '%cnpj_classe%';

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.fundos_caracteristicas DROP CONSTRAINT %I', v_constraint);
    RAISE NOTICE 'Unique constraint % removida de cnpj_classe.', v_constraint;
  ELSE
    RAISE NOTICE 'Nenhuma unique constraint em cnpj_classe encontrada.';
  END IF;
END $$;

-- 2. Remove unique index em cnpj_classe se existir separadamente
DROP INDEX IF EXISTS public.fundos_caracteristicas_cnpj_classe_key;
DROP INDEX IF EXISTS public.fundos_caracteristicas_cnpj_classe_unique;

-- 3. Adiciona unique index parcial em codigo_anbima (apenas para registros com código)
--    NULLs são excluídos: o sistema pode inserir registros sem codigo_anbima livremente.
CREATE UNIQUE INDEX IF NOT EXISTS fundos_caracteristicas_codigo_anbima_key
  ON public.fundos_caracteristicas (codigo_anbima)
  WHERE codigo_anbima IS NOT NULL;

COMMENT ON INDEX public.fundos_caracteristicas_codigo_anbima_key
IS 'Garante que não há dois registros ANBIMA com o mesmo codigo_anbima. Registros sem código (manuais) são permitidos múltiplos.';
