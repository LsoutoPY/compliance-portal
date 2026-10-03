-- Adiciona 'Subclasse' como valor permitido na coluna estrutura de fundos_caracteristicas.
-- Contexto: a planilha ANBIMA pós-resolução 175 inclui registros com estrutura = 'Subclasse'
-- para FIDCs e outros fundos com múltiplas subclasses sob o mesmo CNPJ.

-- Remove a constraint existente de estrutura (se houver qualquer nome)
DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  WHERE t.relname = 'fundos_caracteristicas'
    AND c.contype = 'c'
    AND (c.conname ILIKE '%estrutura%' OR pg_get_constraintdef(c.oid) ILIKE '%estrutura%');

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.fundos_caracteristicas DROP CONSTRAINT %I', v_constraint);
    RAISE NOTICE 'Constraint % removida.', v_constraint;
  ELSE
    RAISE NOTICE 'Nenhuma constraint de estrutura encontrada.';
  END IF;
END $$;

-- Adiciona constraint atualizada com 'Subclasse'
ALTER TABLE public.fundos_caracteristicas
  ADD CONSTRAINT fundos_caracteristicas_estrutura_check
  CHECK (estrutura IS NULL OR estrutura IN ('Classe', 'Fundo', 'Subclasse'));

COMMENT ON COLUMN public.fundos_caracteristicas.estrutura
IS 'Estrutura do fundo: Fundo (pre-175), Classe (nível classe pós-175), Subclasse (cota de subclasse pós-175).';
