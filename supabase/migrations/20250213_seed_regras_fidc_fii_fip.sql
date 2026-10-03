-- Seed regras de limite % PL por categoria (FIDC, FII, FIP)
INSERT INTO public.regras_compliance (codigo, descricao, parametros)
VALUES
  (
    'LIMITE_FIDC_40',
    'Fundo pode ter no máximo 40% do PL em cotas de FIDC',
    '{"tipo_regra": "percentual_pl_por_categoria", "nivel1_categoria": "FIDC", "limite": 0.40}'::jsonb
  ),
  (
    'LIMITE_FII_40',
    'Fundo pode ter no máximo 40% do PL em fundos do imobiliário (FII)',
    '{"tipo_regra": "percentual_pl_por_categoria", "nivel1_categoria": "FII", "limite": 0.40}'::jsonb
  ),
  (
    'LIMITE_FIP_30',
    'Fundo pode ter no máximo 30% do PL em cota de FIP',
    '{"tipo_regra": "percentual_pl_por_categoria", "nivel1_categoria": "FIP", "limite": 0.30}'::jsonb
  )
ON CONFLICT (codigo) DO NOTHING;
