-- Adiciona campo de despesa operacional mensal para análise de cobertura em fundos fechados
ALTER TABLE public.fundos_caracteristicas
ADD COLUMN IF NOT EXISTS despesa_operacional_mensal NUMERIC;

COMMENT ON COLUMN public.fundos_caracteristicas.despesa_operacional_mensal
IS 'Despesa operacional mensal estimada (R$). Usada para calcular meses de cobertura de caixa em fundos fechados.';
