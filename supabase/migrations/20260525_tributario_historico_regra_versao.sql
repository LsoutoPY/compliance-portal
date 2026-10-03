-- TRIB_FIQ_LP_90 — metadados de auditabilidade no histórico MM-10d (SMA 10 posições)
ALTER TABLE public.enquadramento_tributario_historico
  ADD COLUMN IF NOT EXISTS regra_versao text;

COMMENT ON COLUMN public.enquadramento_tributario_historico.regra_versao IS
  'Versão da metodologia MM-10d aplicada (ex.: sma10-v2 = média aritmética das últimas 10 posições).';
