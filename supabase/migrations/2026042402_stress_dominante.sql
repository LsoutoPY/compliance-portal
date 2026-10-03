-- ============================================================
-- Fator Dominante — colunas em resultado_stress
-- ============================================================
-- perda_pct_dominante / perda_abs_dominante armazenam a perda
-- calculada usando apenas o fator com maior |impacto| por ativo.
-- Usado no toggle "Fator dominante" vs "Decomposição" no Painel
-- e na Auditoria de stress testing.
-- ============================================================

ALTER TABLE resultado_stress
  ADD COLUMN IF NOT EXISTS perda_abs_dominante NUMERIC,
  ADD COLUMN IF NOT EXISTS perda_pct_dominante NUMERIC;
