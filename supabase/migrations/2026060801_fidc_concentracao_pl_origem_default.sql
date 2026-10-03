-- Atualiza defaults das regras de concentração FIDC:
-- origem_pl → pl_mes_anterior_posicao (PL do fechamento operacional do mês anterior)
-- usar_abatimento_pdd → true quando ausente ou explicitamente false (exceto se já true)

UPDATE public.regras_compliance
SET parametros = jsonb_set(
  COALESCE(parametros, '{}'::jsonb),
  '{origem_pl}',
  '"pl_mes_anterior_posicao"'::jsonb,
  true
)
WHERE parametros->>'tipo_regra' IN (
  'CONCENTRACAO_DEVEDOR',
  'CONCENTRACAO_CEDENTE',
  'CONCENTRACAO_SEM_COOBRIGACAO'
)
AND (
  parametros->>'origem_pl' IS NULL
  OR parametros->>'origem_pl' IN ('pl_atual_xml', 'pl_mes_anterior_informe_mensal')
);

UPDATE public.regras_compliance
SET parametros = jsonb_set(
  COALESCE(parametros, '{}'::jsonb),
  '{usar_abatimento_pdd}',
  'true'::jsonb,
  true
)
WHERE parametros->>'tipo_regra' IN (
  'CONCENTRACAO_DEVEDOR',
  'CONCENTRACAO_CEDENTE',
  'CONCENTRACAO_SEM_COOBRIGACAO'
)
AND (
  parametros->>'usar_abatimento_pdd' IS NULL
  OR (parametros->>'usar_abatimento_pdd')::boolean IS FALSE
);
