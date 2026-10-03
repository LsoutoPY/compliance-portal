-- Cotistas do Informe Mensal FIDC (inf_mensal_fidc_tab_X_1).
-- Uma linha por subclasse/série; a matriz soma TAB_X_NR_COTST por CNPJ.

ALTER TABLE IF EXISTS public.fidc_informe_mensal_import
  ADD COLUMN IF NOT EXISTS numero_cotistas integer;

COMMENT ON COLUMN public.fidc_informe_mensal_import.numero_cotistas IS
  'Número de cotistas da subclasse/série (TAB_X_1.TAB_X_NR_COTST). Nulo nas demais origens.';

COMMENT ON TABLE public.fidc_informe_mensal_import IS
  'Carga unificada do Informe Mensal FIDC (TAB_V, TAB_VI, TAB_IV Parte A e TAB_X_1 cotistas).';
