-- Performance de Safras (P3) — cohorts por data_aquisicao + curvas de maturidade (MOB)

CREATE OR REPLACE VIEW vw_credito_safras_ativos AS
WITH base AS (
  SELECT
    b.data_referencia,
    b.doc_fundo,
    b.nome_fundo,
    b.chave_ativo,
    MIN(b.data_aquisicao) AS data_aquisicao,
    SUM(b.valor_base) AS valor_base,
    MAX(b.bucket_ordem) AS bucket_ordem,
    MAX(b.bucket_canonico) AS bucket_canonico
  FROM vw_estoque_fidc_base b
  WHERE b.data_aquisicao IS NOT NULL
    AND b.bucket_ordem IS NOT NULL
  GROUP BY b.data_referencia, b.doc_fundo, b.nome_fundo, b.chave_ativo
)
SELECT
  data_referencia,
  doc_fundo,
  nome_fundo,
  chave_ativo,
  data_aquisicao,
  DATE_TRUNC('month', data_aquisicao)::DATE AS safra,
  TO_CHAR(data_aquisicao, 'YYYY-MM') AS safra_label,
  (
    (EXTRACT(YEAR FROM data_referencia)::INT * 12 + EXTRACT(MONTH FROM data_referencia)::INT)
    - (EXTRACT(YEAR FROM data_aquisicao)::INT * 12 + EXTRACT(MONTH FROM data_aquisicao)::INT)
  ) AS mob_meses,
  valor_base,
  bucket_ordem,
  bucket_canonico
FROM base
WHERE (
  (EXTRACT(YEAR FROM data_referencia)::INT * 12 + EXTRACT(MONTH FROM data_referencia)::INT)
  - (EXTRACT(YEAR FROM data_aquisicao)::INT * 12 + EXTRACT(MONTH FROM data_aquisicao)::INT)
) >= 0;

-- Resumo por safra em cada data_referencia (snapshot)
CREATE OR REPLACE VIEW vw_credito_safras_resumo AS
SELECT
  doc_fundo,
  MAX(nome_fundo) AS nome_fundo,
  data_referencia,
  safra,
  safra_label,
  MAX(mob_meses) AS mob_max,
  ROUND(AVG(mob_meses)::NUMERIC, 1) AS mob_medio,
  COUNT(DISTINCT chave_ativo) AS qtd_ativos,
  SUM(valor_base) AS exposicao,
  SUM(CASE WHEN bucket_ordem >= 1 THEN valor_base ELSE 0 END) AS exposicao_atraso,
  SUM(CASE WHEN bucket_ordem >= 4 THEN valor_base ELSE 0 END) AS exposicao_over90,
  SUM(CASE WHEN bucket_ordem = 5 THEN valor_base ELSE 0 END) AS exposicao_over180,
  ROUND(SUM(CASE WHEN bucket_ordem >= 1 THEN valor_base ELSE 0 END) / NULLIF(SUM(valor_base), 0), 6) AS pct_atraso,
  ROUND(SUM(CASE WHEN bucket_ordem >= 4 THEN valor_base ELSE 0 END) / NULLIF(SUM(valor_base), 0), 6) AS pct_over90,
  ROUND(SUM(CASE WHEN bucket_ordem = 5 THEN valor_base ELSE 0 END) / NULLIF(SUM(valor_base), 0), 6) AS pct_over180
FROM vw_credito_safras_ativos
GROUP BY doc_fundo, data_referencia, safra, safra_label;

-- Curva de maturidade: Over90 por MOB (meses na carteira) para cada safra
CREATE OR REPLACE VIEW vw_credito_safras_curva AS
SELECT
  doc_fundo,
  MAX(nome_fundo) AS nome_fundo,
  safra_label,
  mob_meses,
  COUNT(DISTINCT chave_ativo) AS qtd_ativos,
  SUM(valor_base) AS exposicao,
  SUM(CASE WHEN bucket_ordem >= 4 THEN valor_base ELSE 0 END) AS exposicao_over90,
  ROUND(
    SUM(CASE WHEN bucket_ordem >= 4 THEN valor_base ELSE 0 END) / NULLIF(SUM(valor_base), 0),
    6
  ) AS pct_over90,
  ROUND(
    SUM(CASE WHEN bucket_ordem >= 1 THEN valor_base ELSE 0 END) / NULLIF(SUM(valor_base), 0),
    6
  ) AS pct_atraso
FROM vw_credito_safras_ativos
GROUP BY doc_fundo, safra_label, mob_meses
HAVING SUM(valor_base) > 0;

-- Distribuição por bucket canônico dentro de cada safra (snapshot)
CREATE OR REPLACE VIEW vw_credito_safras_por_bucket AS
WITH totais AS (
  SELECT doc_fundo, data_referencia, safra_label, SUM(valor_base) AS total_safra
  FROM vw_credito_safras_ativos
  GROUP BY doc_fundo, data_referencia, safra_label
)
SELECT
  a.doc_fundo,
  MAX(a.nome_fundo) AS nome_fundo,
  a.data_referencia,
  a.safra_label,
  a.bucket_canonico,
  a.bucket_ordem,
  COUNT(DISTINCT a.chave_ativo) AS qtd_ativos,
  SUM(a.valor_base) AS exposicao,
  ROUND(SUM(a.valor_base) * 100.0 / NULLIF(t.total_safra, 0), 4) AS pct_safra
FROM vw_credito_safras_ativos a
JOIN totais t
  ON t.doc_fundo = a.doc_fundo
 AND t.data_referencia = a.data_referencia
 AND t.safra_label = a.safra_label
GROUP BY a.doc_fundo, a.data_referencia, a.safra_label, a.bucket_canonico, a.bucket_ordem, t.total_safra;

-- Volume originado (exposição na safra com MOB = 0)
CREATE OR REPLACE VIEW vw_credito_safras_volume_origem AS
SELECT
  doc_fundo,
  MAX(nome_fundo) AS nome_fundo,
  safra_label,
  MIN(data_referencia) AS primeira_observacao,
  SUM(valor_base) AS volume_originado,
  COUNT(DISTINCT chave_ativo) AS qtd_ativos_originados
FROM vw_credito_safras_ativos
WHERE mob_meses = 0
GROUP BY doc_fundo, safra_label;

COMMENT ON VIEW vw_credito_safras_resumo IS
  'Performance por safra (mês de aquisição) em cada data_referencia. Over90 = buckets 91-180 + 180+.';
COMMENT ON VIEW vw_credito_safras_curva IS
  'Curva de maturidade: pct Over90 por MOB (meses na carteira) para cada safra.';
COMMENT ON VIEW vw_credito_safras_por_bucket IS
  'Distribuição bucket canônico dentro de cada safra (snapshot).';
