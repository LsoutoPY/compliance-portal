-- Art. 4º IN RFB 1585 — TRIB_FIDC_LP_365 (prazo médio WAM para FIDC puro via estoque_fidc)

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
      'tributario',
      'tributario-art4',
      'tributario-art4-fidc'
    )
  );

INSERT INTO public.regras_compliance (codigo, descricao, parametros)
VALUES (
  'TRIB_FIDC_LP_365',
  'FIDC: prazo médio tributário > 365 dias (IN RFB 1585/2015 Art. 4º — estoque de recebíveis)',
  '{
    "norma": "IN RFB 1585/2015 Art. 4º",
    "limite_dias": 365,
    "prazo_caixa": 1,
    "prazo_compromissada": 1,
    "fonte_recebiveis": "estoque_fidc",
    "valor_recebivel": "valor_presente",
    "prazo_base": "dias_corridos"
  }'::jsonb
) ON CONFLICT (codigo) DO NOTHING;
