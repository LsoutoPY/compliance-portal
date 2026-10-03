-- Adiciona 'fidc-concentracao' ao CHECK constraint de regra_categoria em enquadramento_resultado
-- Esta categoria é utilizada pelas regras de concentração de direitos creditórios de FIDC:
-- CONCENTRACAO_DEVEDOR, CONCENTRACAO_CEDENTE, CONCENTRACAO_SEM_COOBRIGACAO

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
      'fidc-concentracao'
    )
  );
