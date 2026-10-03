-- Regra 6.2(f): substituição/recompra única por título (duplicata, CCB ou Nota Comercial)
-- Após aplicar, associe ao fundo via Regras Relacionais (fundo_regras).

INSERT INTO public.regras_compliance (codigo, descricao, parametros)
VALUES (
  'CESSAO_SUBST_UNICA',
  'Substituição/recompra de DC somente pode ocorrer uma única vez, exclusivamente por duplicata, CCB ou Nota Comercial, com o título substituído previamente descontado (regulamento item 6.2(f))',
  jsonb_build_object(
    'tipo_regra',            'CESSAO_CONDICAO',
    'campo',                 'substituicao_unica',
    'modo',                  'individual',
    'tipos_permitidos',      jsonb_build_array('duplicata', 'ccb', 'nota comercial', 'cce'),
    'filtro_tipo_recebivel', jsonb_build_array()
  )
)
ON CONFLICT (codigo) DO UPDATE
  SET descricao  = EXCLUDED.descricao,
      parametros = EXCLUDED.parametros;
