-- Parâmetros editáveis via Regras de Compliance (tipo_regra + denominador Art. 5º)

UPDATE public.regras_compliance
SET parametros = parametros || '{
  "tipo_regra": "tributario_fiq_art5",
  "denominador_carteira_elegivel": false,
  "tipos_excluidos_denominador": ["FII"]
}'::jsonb
WHERE codigo = 'TRIB_FIQ_LP_90'
  AND (parametros->>'tipo_regra') IS NULL;

UPDATE public.regras_compliance
SET parametros = parametros || '{
  "tipo_regra": "tributario_prazo_medio_art4",
  "variante": "fim"
}'::jsonb
WHERE codigo = 'TRIB_FIM_LP_365'
  AND (parametros->>'tipo_regra') IS NULL;

UPDATE public.regras_compliance
SET parametros = parametros || '{
  "tipo_regra": "tributario_prazo_medio_art4",
  "variante": "fidc"
}'::jsonb
WHERE codigo = 'TRIB_FIDC_LP_365'
  AND (parametros->>'tipo_regra') IS NULL;
