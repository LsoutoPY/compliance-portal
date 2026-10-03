-- Separar impactos combinados em campos individuais para maior transparência
-- imp_imab_base = impacto só do IMA-B total (b_imab × delta_imab)
-- imp_imab5_val = impacto só do IMA-B 5 (b_imab5 × delta_imab5)
-- imp_imab5p_val = impacto só do IMA-B 5+ (b_imab5p × delta_imab5p)
-- imp_dolar = impacto só do Dólar PTAX (b_dolar × delta_dolar)
-- imp_sp500 = impacto só do S&P 500 (b_sp500 × delta_sp500)

ALTER TABLE resultado_auditoria
  ADD COLUMN IF NOT EXISTS imp_imab_base   NUMERIC,
  ADD COLUMN IF NOT EXISTS imp_imab5_val   NUMERIC,
  ADD COLUMN IF NOT EXISTS imp_imab5p_val  NUMERIC,
  ADD COLUMN IF NOT EXISTS imp_dolar       NUMERIC,
  ADD COLUMN IF NOT EXISTS imp_sp500       NUMERIC;
