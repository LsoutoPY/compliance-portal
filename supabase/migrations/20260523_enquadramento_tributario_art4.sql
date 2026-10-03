-- Art. 4º IN RFB 1585 — TRIB_FIM_LP_365 (prazo médio WAM para FIM misto)

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
      'tributario-art4'
    )
  );

INSERT INTO public.regras_compliance (codigo, descricao, parametros)
VALUES (
  'TRIB_FIM_LP_365',
  'FIM: prazo médio tributário > 365 dias (IN RFB 1585/2015 Art. 4º)',
  '{
    "norma": "IN RFB 1585/2015 Art. 4º",
    "limite_dias": 365,
    "prazo_cota_lp": 366,
    "prazo_cota_cp": 1,
    "prazo_compromissada": 1
  }'::jsonb
) ON CONFLICT (codigo) DO NOTHING;
