-- Fix constraint name mismatch and allow all currently used categories
ALTER TABLE public.enquadramento_resultado
  DROP CONSTRAINT IF EXISTS enquadramento_resultado_regra_categoria_check;

ALTER TABLE public.enquadramento_resultado
  DROP CONSTRAINT IF EXISTS enquadramento_resultado_categoria_check;

ALTER TABLE public.enquadramento_resultado
  ADD CONSTRAINT enquadramento_resultado_regra_categoria_check
  CHECK (
    regra_categoria IN (
      'pl',
      'concentration',
      'liquidity',
      'classe',
      'relacional',
      'relational'
    )
  );
