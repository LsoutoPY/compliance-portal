-- ============================================================================
-- Reestruturação módulo elegibilidade v3: tipo genérico CESSAO_CONDICAO
-- - Drop cessao_regras_elegibilidade (migra para regras_compliance + fundo_regras)
-- - Converte regras CESSAO_* fixas → CESSAO_CONDICAO genérica
-- - Mantém cessao_importacoes e cessao_resultado_analitico
-- ============================================================================

DROP TABLE IF EXISTS cessao_regras_elegibilidade CASCADE;

-- Migrar regras existentes do formato fixo para o formato genérico
UPDATE regras_compliance SET parametros = jsonb_build_object(
  'tipo_regra', 'CESSAO_CONDICAO',
  'campo', 'vencimento',
  'modo', 'individual',
  'operador', '<=',
  'unidade', 'dias'
) WHERE parametros->>'tipo_regra' = 'CESSAO_DC_VENCIDO';

UPDATE regras_compliance SET parametros = jsonb_build_object(
  'tipo_regra', 'CESSAO_CONDICAO',
  'campo', 'prazo',
  'modo', 'individual',
  'operador', '<=',
  'valor_limite', (parametros->>'dias_max')::numeric,
  'unidade', 'dias'
) WHERE parametros->>'tipo_regra' = 'CESSAO_PRAZO_MAX';

UPDATE regras_compliance SET parametros = jsonb_build_object(
  'tipo_regra', 'CESSAO_CONDICAO',
  'campo', 'taxa_cessao',
  'modo', 'individual',
  'operador', '>=',
  'valor_limite', (parametros->>'percentual_cdi_min')::numeric,
  'unidade', 'percentual_cdi',
  'cdi_vigente_aa', (parametros->>'cdi_vigente_aa')::numeric
) WHERE parametros->>'tipo_regra' = 'CESSAO_TAXA_MIN';

UPDATE regras_compliance SET parametros = jsonb_build_object(
  'tipo_regra', 'CESSAO_CONDICAO',
  'campo', 'inadimplencia_cedente',
  'modo', 'individual',
  'operador', '<=',
  'valor_limite', (parametros->>'dias_max_atraso')::numeric,
  'unidade', 'dias'
) WHERE parametros->>'tipo_regra' = 'CESSAO_INADIMPLENCIA_CEDENTE';

UPDATE regras_compliance SET parametros = jsonb_build_object(
  'tipo_regra', 'CESSAO_CONDICAO',
  'campo', 'exposicao_prazo_acima',
  'modo', 'individual',
  'operador', '<=',
  'valor_limite', ((parametros->>'limite_max')::numeric * 100),
  'unidade', 'percentual_pl',
  'dias_referencia', (parametros->>'dias_max_vencido')::numeric
) WHERE parametros->>'tipo_regra' = 'CESSAO_DUP_VENCIDA';
