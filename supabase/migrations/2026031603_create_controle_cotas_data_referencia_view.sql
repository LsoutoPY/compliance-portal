-- ============================================================
-- Migration: View de status da data de referencia do Controle Cotas
-- Objetivo: centralizar no banco a disponibilidade da referencia
--           e o status das metricas por data.
-- ============================================================

DROP VIEW IF EXISTS vw_controle_cotas_data_referencia_status;

CREATE OR REPLACE VIEW vw_controle_cotas_data_referencia_status AS
WITH serie_por_data AS (
  SELECT
    data_posicao,
    COUNT(DISTINCT cliente) AS clientes_serie
  FROM controle_cotas_serie
  GROUP BY data_posicao
),
metricas_por_data AS (
  SELECT
    data_posicao,
    COUNT(DISTINCT cliente) AS clientes_metricas
  FROM controle_cotas_metricas
  GROUP BY data_posicao
)
SELECT
  s.data_posicao,
  s.clientes_serie,
  COALESCE(m.clientes_metricas, 0) AS clientes_metricas,
  CASE
    WHEN COALESCE(m.clientes_metricas, 0) = 0 THEN 'sem_metricas'
    WHEN COALESCE(m.clientes_metricas, 0) < s.clientes_serie THEN 'parcial'
    ELSE 'completa'
  END::TEXT AS status
FROM serie_por_data s
LEFT JOIN metricas_por_data m
  ON m.data_posicao = s.data_posicao
ORDER BY s.data_posicao DESC;

COMMENT ON VIEW vw_controle_cotas_data_referencia_status IS
  'Status por data de referencia do Controle Cotas. '
  'Fonte oficial da data = controle_cotas_serie. '
  'Status derivado da cobertura em controle_cotas_metricas: completa, parcial ou sem_metricas.';

GRANT SELECT ON vw_controle_cotas_data_referencia_status TO anon, authenticated, service_role;
