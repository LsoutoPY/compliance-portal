-- Allow new rule categories introduced after initial schema
ALTER TABLE public.enquadramento_resultado
  DROP CONSTRAINT IF EXISTS enquadramento_resultado_categoria_check;

ALTER TABLE public.enquadramento_resultado
  ADD CONSTRAINT enquadramento_resultado_categoria_check
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
