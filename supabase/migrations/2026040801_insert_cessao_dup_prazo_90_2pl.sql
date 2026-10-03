-- Regra: Duplicatas com prazo > 90 dias não podem superar 2% do PL da Classe
-- campo: exposicao_prazo_acima | modo: proforma | dias_referencia: 90 | limite: 2% PL
-- Após aplicar esta migration, vincule a regra ao fundo desejado via tela de Regras (Configurações).

INSERT INTO public.regras_compliance (codigo, descricao, parametros)
VALUES (
  'CESSAO_DUP_PRAZO_90_2PL',
  'Duplicatas com prazo > 90 dias não podem superar 2% do PL da Classe',
  jsonb_build_object(
    'tipo_regra',            'CESSAO_CONDICAO',
    'campo',                 'exposicao_prazo_acima',
    'modo',                  'proforma',
    'operador',              '<=',
    'valor_limite',          2,
    'unidade',               'percentual_pl',
    'dias_referencia',       90,
    'filtro_tipo_recebivel', jsonb_build_array('Duplicata'),
    'descricao_livre',       'Duplicatas com prazo > 90 dias não podem superar 2% do PL da Classe'
  )
)
ON CONFLICT (codigo) DO UPDATE
  SET descricao  = EXCLUDED.descricao,
      parametros = EXCLUDED.parametros;
