-- Expande tabela unificada do Informe Mensal FIDC
-- para armazenar buckets A1..A10 e agregações por vértice.

ALTER TABLE IF EXISTS fidc_informe_mensal_import
  ADD COLUMN IF NOT EXISTS bucket_a1 NUMERIC,
  ADD COLUMN IF NOT EXISTS bucket_a2 NUMERIC,
  ADD COLUMN IF NOT EXISTS bucket_a3 NUMERIC,
  ADD COLUMN IF NOT EXISTS bucket_a4 NUMERIC,
  ADD COLUMN IF NOT EXISTS bucket_a5 NUMERIC,
  ADD COLUMN IF NOT EXISTS bucket_a6 NUMERIC,
  ADD COLUMN IF NOT EXISTS bucket_a7 NUMERIC,
  ADD COLUMN IF NOT EXISTS bucket_a8 NUMERIC,
  ADD COLUMN IF NOT EXISTS bucket_a9 NUMERIC,
  ADD COLUMN IF NOT EXISTS bucket_a10 NUMERIC,
  ADD COLUMN IF NOT EXISTS vertice_d42 NUMERIC,
  ADD COLUMN IF NOT EXISTS vertice_d63 NUMERIC,
  ADD COLUMN IF NOT EXISTS vertice_d126 NUMERIC,
  ADD COLUMN IF NOT EXISTS vertice_d180 NUMERIC,
  ADD COLUMN IF NOT EXISTS vertice_d365 NUMERIC,
  ADD COLUMN IF NOT EXISTS vertice_maior_365 NUMERIC,
  ADD COLUMN IF NOT EXISTS total_a_prazo NUMERIC,
  ADD COLUMN IF NOT EXISTS total_b_inad NUMERIC,
  ADD COLUMN IF NOT EXISTS total_c_antecipado NUMERIC;

COMMENT ON COLUMN fidc_informe_mensal_import.bucket_a1 IS 'Até 30 dias';
COMMENT ON COLUMN fidc_informe_mensal_import.bucket_a2 IS '31 a 60 dias';
COMMENT ON COLUMN fidc_informe_mensal_import.bucket_a3 IS '61 a 90 dias';
COMMENT ON COLUMN fidc_informe_mensal_import.bucket_a4 IS '91 a 120 dias';
COMMENT ON COLUMN fidc_informe_mensal_import.bucket_a5 IS '121 a 150 dias';
COMMENT ON COLUMN fidc_informe_mensal_import.bucket_a6 IS '151 a 180 dias';
COMMENT ON COLUMN fidc_informe_mensal_import.bucket_a7 IS '181 a 360 dias';
COMMENT ON COLUMN fidc_informe_mensal_import.bucket_a8 IS '361 a 720 dias';
COMMENT ON COLUMN fidc_informe_mensal_import.bucket_a9 IS '721 a 1080 dias';
COMMENT ON COLUMN fidc_informe_mensal_import.bucket_a10 IS 'Acima de 1080 dias';
COMMENT ON COLUMN fidc_informe_mensal_import.vertice_d42 IS 'D+42 = a1 (até 30 dias)';
COMMENT ON COLUMN fidc_informe_mensal_import.vertice_d63 IS 'D+63 = a2 (31-60 dias)';
COMMENT ON COLUMN fidc_informe_mensal_import.vertice_d126 IS 'D+126 = a3 + a4 (61-120 dias)';
COMMENT ON COLUMN fidc_informe_mensal_import.vertice_d180 IS 'D+180 = a5 + a6 (121-180 dias)';
COMMENT ON COLUMN fidc_informe_mensal_import.vertice_d365 IS 'D+365 = a7 (181-360 dias)';
COMMENT ON COLUMN fidc_informe_mensal_import.vertice_maior_365 IS '>D+365 = a8+a9+a10 (acima de 360 dias)';
