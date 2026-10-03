-- Renomeia vértices D+180 → D+252 e D+365 → D+378 na tabela fidc_informe_mensal_import.
-- D+252 absorve o que era D+180 (buckets a5+a6). D+365 renomeado para D+378 (apenas identificador).

ALTER TABLE fidc_informe_mensal_import
  RENAME COLUMN vertice_d180 TO vertice_d252;

ALTER TABLE fidc_informe_mensal_import
  RENAME COLUMN vertice_d365 TO vertice_d378;

COMMENT ON COLUMN fidc_informe_mensal_import.vertice_d252 IS 'D+252 = a5 + a6 (121-180 dias)';
COMMENT ON COLUMN fidc_informe_mensal_import.vertice_d378 IS 'D+378 = a7 (181-360 dias)';
