-- Categoria fidc-estrutura: subordinação multiclasse (PL Classe)

ALTER TABLE public.enquadramento_resultado
  DROP CONSTRAINT IF EXISTS enquadramento_resultado_regra_categoria_check;

ALTER TABLE public.enquadramento_resultado
  ADD CONSTRAINT enquadramento_resultado_regra_categoria_check
  CHECK (
    regra_categoria IN (
      'pl',
      'concentration',
      'liquidity',
      'classe',
      'relacional',
      'relational',
      'fidc-concentracao',
      'fidc-estrutura',
      'tributario',
      'tributario-art4',
      'tributario-art4-fidc'
    )
  );
