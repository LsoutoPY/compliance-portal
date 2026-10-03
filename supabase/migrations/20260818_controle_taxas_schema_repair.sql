-- Reparo idempotente: colunas referenciadas pelas views de Controle de Taxas.
-- Execute se o frontend retornar 500 (coluna/view desatualizada).

ALTER TABLE public.fundos_taxas
  ADD COLUMN IF NOT EXISTS tg_fixo_mensal    numeric,
  ADD COLUMN IF NOT EXISTS ta_fixo_mensal    numeric,
  ADD COLUMN IF NOT EXISTS tc_fixo_mensal    numeric,
  ADD COLUMN IF NOT EXISTS tcons_fixo_mensal numeric,
  ADD COLUMN IF NOT EXISTS gross_up_ativo    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ta_gross_up_pis    numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ta_gross_up_cofins numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ta_gross_up_iss    numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tg_gross_up_pis    numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tg_gross_up_cofins numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tg_gross_up_iss    numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tc_gross_up_pis    numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tc_gross_up_cofins numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tc_gross_up_iss    numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tcons_gross_up_pis    numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tcons_gross_up_cofins numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tcons_gross_up_iss    numeric DEFAULT 0;

COMMENT ON COLUMN public.fundos_taxas.ta_fixo_mensal IS
  'Taxa fixa mensal R$ (prioridade sobre % e mínimo).';
