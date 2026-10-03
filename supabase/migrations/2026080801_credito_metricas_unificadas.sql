-- Migration: Crédito — buckets canônicos unificados + métricas P1/P2
-- Taxonomia única visível ao usuário:
--   Adimplente | 1-30 | 31-60 | 61-90 | 91-180 | 180+
-- Over90 = (91-180 + 180+) / carteira (sempre)

-- ============================================================
-- Funções auxiliares
-- ============================================================
CREATE OR REPLACE FUNCTION credito_bucket_canonico(p_dias_atraso INTEGER)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_dias_atraso IS NULL THEN NULL
    WHEN p_dias_atraso <= 0 THEN 'Adimplente'
    WHEN p_dias_atraso <= 30 THEN '1-30'
    WHEN p_dias_atraso <= 60 THEN '31-60'
    WHEN p_dias_atraso <= 90 THEN '61-90'
    WHEN p_dias_atraso <= 180 THEN '91-180'
    ELSE '180+'
  END;
$$;

CREATE OR REPLACE FUNCTION credito_bucket_ordem(p_dias_atraso INTEGER)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_dias_atraso IS NULL THEN NULL
    WHEN p_dias_atraso <= 0 THEN 0
    WHEN p_dias_atraso <= 30 THEN 1
    WHEN p_dias_atraso <= 60 THEN 2
    WHEN p_dias_atraso <= 90 THEN 3
    WHEN p_dias_atraso <= 180 THEN 4
    ELSE 5
  END;
$$;

COMMENT ON FUNCTION credito_bucket_canonico IS
  'Bucket canônico único do módulo de crédito (taxonomia visível ao usuário).';
COMMENT ON FUNCTION credito_bucket_ordem IS
  'Ordem 0-5 do bucket canônico (0=Adimplente, 5=180+).';

-- ============================================================
-- Colunas novas em credito_estoque_indicadores
-- ============================================================
ALTER TABLE credito_estoque_indicadores
  ADD COLUMN IF NOT EXISTS coverage_npl NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS aderencia_pdd NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delta_over90 NUMERIC,
  ADD COLUMN IF NOT EXISTS delta_over180 NUMERIC;

COMMENT ON COLUMN credito_estoque_indicadores.coverage_npl IS
  'PDD total / exposição Over90 (91-180 + 180+). Visão de risco.';
COMMENT ON COLUMN credito_estoque_indicadores.aderencia_pdd IS
  'PDD atual / PDD modelo. Aderência à política interna de provisão.';
COMMENT ON COLUMN credito_estoque_indicadores.delta_over90 IS
  'Variação de Over90 vs data anterior calculada (pontos percentuais decimais).';
COMMENT ON COLUMN credito_estoque_indicadores.delta_over180 IS
  'Variação de Over180 vs data anterior calculada.';

-- ============================================================
-- Score parametrizado + regras de alerta
-- ============================================================
CREATE TABLE IF NOT EXISTS credito_score_parametros (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_fundo TEXT,
  indicador TEXT NOT NULL,
  peso NUMERIC NOT NULL DEFAULT 0 CHECK (peso >= 0 AND peso <= 1),
  peso_maximo NUMERIC,
  valor_referencia NUMERIC,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (doc_fundo, indicador)
);

CREATE TABLE IF NOT EXISTS credito_alertas_regras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo TEXT NOT NULL CHECK (tipo IN ('limite', 'tendencia', 'salto')),
  indicador TEXT NOT NULL,
  janela_meses INTEGER NOT NULL DEFAULT 1 CHECK (janela_meses >= 1),
  limiar NUMERIC NOT NULL,
  severidade TEXT NOT NULL DEFAULT 'alerta' CHECK (severidade IN ('info', 'alerta', 'critico')),
  descricao TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE credito_score_parametros ENABLE ROW LEVEL SECURITY;
ALTER TABLE credito_alertas_regras ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all on credito_score_parametros"
  ON credito_score_parametros FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on credito_alertas_regras"
  ON credito_alertas_regras FOR ALL USING (true) WITH CHECK (true);

-- Pesos default globais (doc_fundo NULL)
INSERT INTO credito_score_parametros (doc_fundo, indicador, peso, valor_referencia)
VALUES
  (NULL, 'over90', 0.20, 0.05),
  (NULL, 'over180', 0.15, 0.03),
  (NULL, 'coverage_npl', 0.20, 1.0),
  (NULL, 'aderencia_pdd', 0.15, 1.0),
  (NULL, 'delta_over90', 0.15, 0),
  (NULL, 'gap_relativo', 0.10, 0.10),
  (NULL, 'concentracao_over90', 0.05, 0.50)
ON CONFLICT (doc_fundo, indicador) DO NOTHING;

INSERT INTO credito_alertas_regras (tipo, indicador, janela_meses, limiar, severidade, descricao)
VALUES
  ('salto', 'over90', 1, 0.02, 'alerta', 'Over90 aumentou mais de 2 p.p. vs mês anterior'),
  ('salto', 'over180', 1, 0.015, 'alerta', 'Over180 aumentou mais de 1,5 p.p. vs mês anterior'),
  ('limite', 'coverage_npl', 1, 0.80, 'critico', 'Coverage NPL abaixo de 80%'),
  ('limite', 'aderencia_pdd', 1, 0.90, 'alerta', 'Aderência da PDD abaixo de 90% do modelo'),
  ('limite', 'gap_relativo', 1, 0.10, 'alerta', 'Gap de PDD acima de 10% do PDD modelo'),
  ('tendencia', 'over90', 3, 0, 'alerta', 'Over90 crescente por 3 meses consecutivos'),
  ('tendencia', 'over180', 3, 0, 'alerta', 'Over180 crescente por 3 meses consecutivos'),
  ('limite', 'concentracao_top1_over90', 1, 0.50, 'critico', 'Mais de 50% do Over90 concentrado em um cedente');

-- ============================================================
-- Recria views analíticas com buckets canônicos
-- ============================================================
DROP VIEW IF EXISTS vw_credito_alertas_risco CASCADE;
DROP VIEW IF EXISTS vw_credito_score_fundo CASCADE;
DROP VIEW IF EXISTS vw_credito_concentracao_over90 CASCADE;
DROP VIEW IF EXISTS vw_credito_indice_melhoria_faixa CASCADE;
DROP VIEW IF EXISTS vw_credito_indicadores_tendencia CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_alertas_qualidade CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_resumo_gerencial CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_roll_rate_media_3m CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_roll_rate CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_matriz_migracao CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_migracao_detalhada CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_por_faixa CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_consolidado CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_base CASCADE;

CREATE OR REPLACE VIEW vw_estoque_fidc_base AS
WITH latest_imports AS (
  SELECT DISTINCT ON (fund_document, reference_date)
    id AS import_id
  FROM importacoes_estoque_fidc
  WHERE status IN ('success', 'partial_success')
  ORDER BY fund_document, reference_date, created_at DESC
),
filtered AS (
  SELECT ef.*
  FROM estoque_fidc ef
  INNER JOIN latest_imports li ON ef.import_id = li.import_id
),
with_vencimento AS (
  SELECT
    *,
    COALESCE(data_vencimento_ajustada, data_vencimento_original) AS data_vencimento_base,
    (data_vencimento_ajustada IS NULL AND data_vencimento_original IS NULL) AS nao_classificavel
  FROM filtered
),
with_chave AS (
  SELECT
    *,
    CASE
      WHEN seu_numero IS NOT NULL AND TRIM(seu_numero) <> '' THEN seu_numero
      WHEN nu_documento IS NOT NULL AND TRIM(nu_documento) <> '' THEN nu_documento
      ELSE CONCAT(
        COALESCE(doc_fundo, ''), '|',
        COALESCE(doc_sacado, ''), '|',
        COALESCE(nu_documento, ''), '|',
        COALESCE(data_vencimento_base::TEXT, 'sem_vcto'), '|',
        COALESCE(valor_nominal::TEXT, '0')
      )
    END AS chave_ativo,
    CASE
      WHEN (seu_numero IS NOT NULL AND TRIM(seu_numero) <> '')
        OR (nu_documento IS NOT NULL AND TRIM(nu_documento) <> '')
      THEN TRUE ELSE FALSE
    END AS chave_confiavel,
    CASE
      WHEN nao_classificavel THEN NULL
      ELSE (data_referencia - data_vencimento_base)
    END AS dias_atraso
  FROM with_vencimento
)
SELECT
  id,
  import_id,
  data_referencia,
  doc_fundo,
  nome_fundo,
  doc_sacado,
  nome_sacado,
  doc_cedente,
  nome_cedente,
  tipo_recebivel,
  data_aquisicao,
  COALESCE(valor_presente, valor_nominal, 0) AS valor_base,
  COALESCE(valor_pdd_geral, valor_pdd, 0) AS valor_pdd_atual,
  data_vencimento_base,
  chave_ativo,
  chave_confiavel,
  nao_classificavel,
  dias_atraso,
  credito_bucket_canonico(dias_atraso) AS bucket_canonico,
  credito_bucket_ordem(dias_atraso) AS bucket_ordem,
  -- Compatibilidade: faixa_calculada = bucket_ordem, faixa_descricao = bucket canônico
  credito_bucket_ordem(dias_atraso) AS faixa_calculada,
  credito_bucket_canonico(dias_atraso) AS faixa_descricao,
  situacao_recebivel,
  seu_numero,
  nu_documento,
  valor_nominal,
  valor_presente,
  valor_pdd
FROM with_chave;

CREATE OR REPLACE VIEW vw_estoque_fidc_consolidado AS
SELECT
  data_referencia,
  doc_fundo,
  MAX(nome_fundo) AS nome_fundo,
  chave_ativo,
  BOOL_AND(chave_confiavel) AS chave_confiavel,
  SUM(valor_base) AS valor_base,
  MAX(bucket_ordem) AS bucket_ordem,
  MAX(bucket_canonico) AS bucket_canonico,
  MAX(faixa_calculada) AS faixa_calculada,
  COUNT(*) AS num_registros,
  COUNT(*) > 1 AS foi_consolidado,
  BOOL_OR(nao_classificavel) AS nao_classificavel
FROM vw_estoque_fidc_base
WHERE bucket_ordem IS NOT NULL
GROUP BY data_referencia, doc_fundo, chave_ativo;

CREATE OR REPLACE VIEW vw_estoque_fidc_por_faixa AS
WITH totais AS (
  SELECT doc_fundo, data_referencia, SUM(valor_base) AS total_fundo
  FROM vw_estoque_fidc_consolidado
  GROUP BY doc_fundo, data_referencia
)
SELECT
  c.data_referencia,
  c.doc_fundo,
  MAX(c.nome_fundo) AS nome_fundo,
  c.bucket_ordem AS faixa_calculada,
  c.bucket_canonico AS faixa_descricao,
  c.bucket_ordem,
  c.bucket_canonico,
  COUNT(DISTINCT c.chave_ativo) AS quantidade_ativos,
  SUM(c.valor_base) AS valor_total,
  ROUND(SUM(c.valor_base) * 100.0 / NULLIF(t.total_fundo, 0), 4) AS percentual_estoque
FROM vw_estoque_fidc_consolidado c
JOIN totais t ON t.doc_fundo = c.doc_fundo AND t.data_referencia = c.data_referencia
GROUP BY c.data_referencia, c.doc_fundo, c.bucket_ordem, c.bucket_canonico, t.total_fundo
ORDER BY c.data_referencia DESC, c.doc_fundo, c.bucket_ordem;

CREATE OR REPLACE VIEW vw_estoque_fidc_migracao_detalhada AS
WITH fund_dates AS (
  SELECT DISTINCT doc_fundo, data_referencia FROM vw_estoque_fidc_consolidado
),
consecutive_pairs AS (
  SELECT d1.doc_fundo, d1.data_referencia AS mes_origem, MIN(d2.data_referencia) AS mes_destino
  FROM fund_dates d1
  JOIN fund_dates d2 ON d1.doc_fundo = d2.doc_fundo AND d2.data_referencia > d1.data_referencia
  GROUP BY d1.doc_fundo, d1.data_referencia
),
m1_view AS (
  SELECT
    cp.mes_origem, cp.mes_destino, m1.doc_fundo, m1.nome_fundo, m1.chave_ativo,
    m1.bucket_ordem AS faixa_origem, m2.bucket_ordem AS faixa_destino,
    m1.bucket_canonico AS bucket_origem, m2.bucket_canonico AS bucket_destino,
    m1.valor_base AS valor_origem, m2.valor_base AS valor_destino,
    m1.chave_confiavel
  FROM consecutive_pairs cp
  JOIN vw_estoque_fidc_consolidado m1
    ON m1.doc_fundo = cp.doc_fundo AND m1.data_referencia = cp.mes_origem
  LEFT JOIN vw_estoque_fidc_consolidado m2
    ON m2.doc_fundo = cp.doc_fundo AND m2.data_referencia = cp.mes_destino AND m2.chave_ativo = m1.chave_ativo
),
m2_new AS (
  SELECT
    cp.mes_origem, cp.mes_destino, m2.doc_fundo, m2.nome_fundo, m2.chave_ativo,
    NULL::INTEGER AS faixa_origem, m2.bucket_ordem AS faixa_destino,
    NULL::TEXT AS bucket_origem, m2.bucket_canonico AS bucket_destino,
    0::NUMERIC AS valor_origem, m2.valor_base AS valor_destino, m2.chave_confiavel
  FROM consecutive_pairs cp
  JOIN vw_estoque_fidc_consolidado m2
    ON m2.doc_fundo = cp.doc_fundo AND m2.data_referencia = cp.mes_destino
  LEFT JOIN vw_estoque_fidc_consolidado m1
    ON m1.doc_fundo = cp.doc_fundo AND m1.data_referencia = cp.mes_origem AND m1.chave_ativo = m2.chave_ativo
  WHERE m1.chave_ativo IS NULL
)
SELECT
  mes_origem, mes_destino, doc_fundo, nome_fundo, chave_ativo,
  faixa_origem, faixa_destino, bucket_origem, bucket_destino,
  valor_origem, valor_destino,
  CASE
    WHEN faixa_origem IS NULL OR faixa_destino IS NULL THEN NULL
    ELSE faixa_destino - faixa_origem
  END AS delta_faixa,
  CASE
    WHEN faixa_origem IS NULL THEN 'entrou_na_base'
    WHEN faixa_destino IS NULL THEN 'saiu_da_base'
    WHEN faixa_destino = faixa_origem THEN 'permaneceu'
    WHEN faixa_destino < faixa_origem THEN 'curou'
    WHEN faixa_origem < 5 AND faixa_destino = 5 THEN 'entrou_em_perda'
    WHEN faixa_destino > faixa_origem THEN 'piorou'
    ELSE 'sem_movimento_identificado'
  END AS classificacao_movimento,
  CASE
    WHEN faixa_origem IS NULL OR faixa_destino IS NULL THEN NULL
    WHEN faixa_destino < faixa_origem THEN 'melhoria_faixa'
    WHEN faixa_destino > faixa_origem THEN 'piora_faixa'
    WHEN faixa_destino = faixa_origem AND faixa_origem >= 1 THEN 'permaneceu_em_atraso'
    ELSE 'outro'
  END AS subtipo_movimento
FROM m1_view
UNION ALL
SELECT
  mes_origem, mes_destino, doc_fundo, nome_fundo, chave_ativo,
  faixa_origem, faixa_destino, bucket_origem, bucket_destino,
  valor_origem, valor_destino, NULL, 'entrou_na_base', 'outro'
FROM m2_new;

CREATE OR REPLACE VIEW vw_estoque_fidc_matriz_migracao AS
SELECT
  mes_origem, mes_destino, doc_fundo, MAX(nome_fundo) AS nome_fundo,
  faixa_origem, faixa_destino,
  MAX(bucket_origem) AS bucket_origem,
  MAX(bucket_destino) AS bucket_destino,
  COUNT(DISTINCT chave_ativo) AS quantidade_ativos,
  SUM(valor_origem) AS valor_migrado
FROM vw_estoque_fidc_migracao_detalhada
WHERE faixa_origem IS NOT NULL AND faixa_destino IS NOT NULL
GROUP BY mes_origem, mes_destino, doc_fundo, faixa_origem, faixa_destino;

CREATE OR REPLACE VIEW vw_estoque_fidc_roll_rate AS
SELECT
  m.mes_origem, m.mes_destino, m.doc_fundo, MAX(m.nome_fundo) AS nome_fundo,
  m.faixa_origem,
  CONCAT(COALESCE(m.bucket_origem, '?'), ' → ', COALESCE(
    (SELECT bucket_canonico FROM vw_estoque_fidc_base b WHERE b.bucket_ordem = m.faixa_origem + 1 LIMIT 1),
    'próxima faixa'
  )) AS migracao,
  m.bucket_origem,
  COUNT(DISTINCT m.chave_ativo) AS qtd_ativos_origem,
  COUNT(DISTINCT CASE WHEN m.faixa_destino = m.faixa_origem + 1 THEN m.chave_ativo END) AS qtd_ativos_migrados,
  SUM(m.valor_origem) AS valor_origem_total,
  SUM(CASE WHEN m.faixa_destino = m.faixa_origem + 1 THEN m.valor_origem ELSE 0 END) AS valor_migrado_para_faixa_seguinte,
  ROUND(
    SUM(CASE WHEN m.faixa_destino = m.faixa_origem + 1 THEN m.valor_origem ELSE 0 END)
    / NULLIF(SUM(m.valor_origem), 0), 6
  ) AS roll_rate
FROM vw_estoque_fidc_migracao_detalhada m
WHERE m.faixa_origem IS NOT NULL AND m.faixa_destino IS NOT NULL AND m.faixa_origem < 5
GROUP BY m.mes_origem, m.mes_destino, m.doc_fundo, m.faixa_origem, m.bucket_origem;

CREATE OR REPLACE VIEW vw_estoque_fidc_roll_rate_media_3m AS
WITH roll_ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY doc_fundo, faixa_origem ORDER BY mes_origem DESC) AS rn
  FROM vw_estoque_fidc_roll_rate WHERE roll_rate IS NOT NULL
)
SELECT
  doc_fundo, MAX(nome_fundo) AS nome_fundo, faixa_origem, MAX(migracao) AS migracao,
  MAX(bucket_origem) AS bucket_origem,
  ROUND(AVG(roll_rate), 6) AS media_3m,
  COUNT(*) AS meses_utilizados,
  MIN(mes_origem) AS mes_mais_antigo, MAX(mes_origem) AS mes_mais_recente,
  COUNT(*) < 3 AS media_incompleta
FROM roll_ranked WHERE rn <= 3
GROUP BY doc_fundo, faixa_origem;

CREATE OR REPLACE VIEW vw_estoque_fidc_resumo_gerencial AS
WITH ultima_ref AS (
  SELECT doc_fundo, MAX(data_referencia) AS ultima_data FROM vw_estoque_fidc_consolidado GROUP BY doc_fundo
),
estoque_atual AS (
  SELECT
    c.doc_fundo, MAX(c.nome_fundo) AS nome_fundo, c.data_referencia,
    SUM(c.valor_base) AS carteira_total,
    SUM(CASE WHEN c.bucket_ordem = 0 THEN c.valor_base ELSE 0 END) AS valor_adimplente,
    SUM(CASE WHEN c.bucket_ordem = 1 THEN c.valor_base ELSE 0 END) AS valor_1_30,
    SUM(CASE WHEN c.bucket_ordem = 2 THEN c.valor_base ELSE 0 END) AS valor_31_60,
    SUM(CASE WHEN c.bucket_ordem = 3 THEN c.valor_base ELSE 0 END) AS valor_61_90,
    SUM(CASE WHEN c.bucket_ordem = 4 THEN c.valor_base ELSE 0 END) AS valor_91_180,
    SUM(CASE WHEN c.bucket_ordem = 5 THEN c.valor_base ELSE 0 END) AS valor_180_mais,
    SUM(CASE WHEN c.bucket_ordem >= 1 THEN c.valor_base ELSE 0 END) AS total_em_atraso,
    SUM(CASE WHEN c.bucket_ordem >= 4 THEN c.valor_base ELSE 0 END) AS total_over90,
    SUM(CASE WHEN c.bucket_ordem = 5 THEN c.valor_base ELSE 0 END) AS total_over180,
    COUNT(DISTINCT c.chave_ativo) AS qtd_ativos_total,
    COUNT(DISTINCT CASE WHEN c.bucket_ordem >= 1 THEN c.chave_ativo END) AS qtd_ativos_em_atraso
  FROM vw_estoque_fidc_consolidado c
  JOIN ultima_ref ur ON ur.doc_fundo = c.doc_fundo AND ur.ultima_data = c.data_referencia
  GROUP BY c.doc_fundo, c.data_referencia
),
ultima_migracao_ref AS (
  SELECT doc_fundo, MAX(mes_destino) AS ultima_competencia FROM vw_estoque_fidc_migracao_detalhada GROUP BY doc_fundo
),
ultima_migracao AS (
  SELECT m.doc_fundo,
    COUNT(DISTINCT CASE WHEN m.classificacao_movimento = 'piorou' THEN m.chave_ativo END) AS qtd_piorou,
    COUNT(DISTINCT CASE WHEN m.classificacao_movimento = 'curou' THEN m.chave_ativo END) AS qtd_curou,
    COUNT(DISTINCT CASE WHEN m.classificacao_movimento = 'entrou_em_perda' THEN m.chave_ativo END) AS qtd_entrou_em_perda,
    COUNT(DISTINCT CASE WHEN m.subtipo_movimento = 'permaneceu_em_atraso' THEN m.chave_ativo END) AS qtd_permaneceu_em_atraso,
    COUNT(DISTINCT CASE WHEN m.faixa_origem = 0 AND m.faixa_destino >= 1 THEN m.chave_ativo END) AS qtd_entrou_em_atraso,
    SUM(CASE WHEN m.faixa_origem = 0 AND m.faixa_destino >= 1 THEN m.valor_origem ELSE 0 END) AS valor_entrou_em_atraso
  FROM vw_estoque_fidc_migracao_detalhada m
  JOIN ultima_migracao_ref umr ON umr.doc_fundo = m.doc_fundo AND umr.ultima_competencia = m.mes_destino
  GROUP BY m.doc_fundo
)
SELECT ea.*,
  ROUND(ea.total_em_atraso / NULLIF(ea.carteira_total, 0), 6) AS pct_em_atraso,
  ROUND(ea.total_over90 / NULLIF(ea.carteira_total, 0), 6) AS pct_over90,
  ROUND(ea.total_over180 / NULLIF(ea.carteira_total, 0), 6) AS pct_over180,
  ROUND(ea.total_over180 / NULLIF(ea.carteira_total, 0), 6) AS pct_perda,
  COALESCE(um.qtd_piorou, 0) AS qtd_piorou_ultimo_mes,
  COALESCE(um.qtd_curou, 0) AS qtd_curou_ultimo_mes,
  COALESCE(um.qtd_permaneceu_em_atraso, 0) AS qtd_permaneceu_em_atraso_ultimo_mes,
  COALESCE(um.qtd_entrou_em_perda, 0) AS qtd_entrou_em_perda_ultimo_mes,
  COALESCE(um.qtd_entrou_em_atraso, 0) AS qtd_entrou_em_atraso_ultimo_mes,
  COALESCE(um.valor_entrou_em_atraso, 0) AS valor_entrou_em_atraso_ultimo_mes,
  CASE
    WHEN (COALESCE(um.qtd_curou, 0) + COALESCE(um.qtd_permaneceu_em_atraso, 0) + COALESCE(um.qtd_piorou, 0)) = 0 THEN NULL
    ELSE ROUND(
      COALESCE(um.qtd_curou, 0)::NUMERIC
      / NULLIF(COALESCE(um.qtd_curou, 0) + COALESCE(um.qtd_permaneceu_em_atraso, 0) + COALESCE(um.qtd_piorou, 0), 0),
      6
    )
  END AS indice_melhoria_faixa
FROM estoque_atual ea
LEFT JOIN ultima_migracao um ON um.doc_fundo = ea.doc_fundo;

CREATE OR REPLACE VIEW vw_estoque_fidc_alertas_qualidade AS
SELECT 'sem_chave_confiavel'::TEXT AS tipo_alerta, data_referencia, doc_fundo,
  MAX(nome_fundo) AS nome_fundo, import_id::TEXT AS referencia, COUNT(*)::BIGINT AS quantidade,
  CONCAT('Registros com chave composta: ', COUNT(*))::TEXT AS descricao
FROM vw_estoque_fidc_base WHERE NOT chave_confiavel
GROUP BY data_referencia, doc_fundo, import_id
UNION ALL
SELECT 'sem_vencimento'::TEXT, data_referencia, doc_fundo, MAX(nome_fundo), import_id::TEXT,
  COUNT(*)::BIGINT, CONCAT('Sem vencimento: ', COUNT(*))::TEXT
FROM vw_estoque_fidc_base WHERE nao_classificavel
GROUP BY data_referencia, doc_fundo, import_id
UNION ALL
SELECT 'historico_insuficiente'::TEXT, MAX(data_referencia), doc_fundo, MAX(nome_fundo),
  COUNT(DISTINCT data_referencia)::TEXT, COUNT(DISTINCT data_referencia)::BIGINT,
  CASE COUNT(DISTINCT data_referencia)
    WHEN 1 THEN 'Apenas 1 mês. Roll rate indisponível.'
    WHEN 2 THEN '2 meses. Média 3m incompleta.'
    ELSE CONCAT(COUNT(DISTINCT data_referencia), ' meses disponíveis.')
  END::TEXT
FROM vw_estoque_fidc_consolidado GROUP BY doc_fundo HAVING COUNT(DISTINCT data_referencia) < 3;

-- Índice de melhoria de faixa por par de meses
CREATE OR REPLACE VIEW vw_credito_indice_melhoria_faixa AS
SELECT
  mes_origem, mes_destino, doc_fundo, MAX(nome_fundo) AS nome_fundo,
  COUNT(DISTINCT CASE WHEN classificacao_movimento = 'curou' THEN chave_ativo END) AS qtd_curou,
  COUNT(DISTINCT CASE WHEN subtipo_movimento = 'permaneceu_em_atraso' THEN chave_ativo END) AS qtd_permaneceu_em_atraso,
  COUNT(DISTINCT CASE WHEN classificacao_movimento = 'piorou' THEN chave_ativo END) AS qtd_piorou,
  CASE
    WHEN COUNT(DISTINCT CASE WHEN classificacao_movimento IN ('curou','piorou') OR subtipo_movimento = 'permaneceu_em_atraso' THEN chave_ativo END) = 0 THEN NULL
    ELSE ROUND(
      COUNT(DISTINCT CASE WHEN classificacao_movimento = 'curou' THEN chave_ativo END)::NUMERIC
      / NULLIF(
        COUNT(DISTINCT CASE WHEN classificacao_movimento = 'curou' THEN chave_ativo END)
        + COUNT(DISTINCT CASE WHEN subtipo_movimento = 'permaneceu_em_atraso' THEN chave_ativo END)
        + COUNT(DISTINCT CASE WHEN classificacao_movimento = 'piorou' THEN chave_ativo END),
        0
      ), 6
    )
  END AS indice_melhoria_faixa
FROM vw_estoque_fidc_migracao_detalhada
WHERE faixa_origem IS NOT NULL AND faixa_origem >= 1
GROUP BY mes_origem, mes_destino, doc_fundo;

-- Tendência Δ Over90 / Over180 a partir de indicadores calculados
CREATE OR REPLACE VIEW vw_credito_indicadores_tendencia AS
WITH ranked AS (
  SELECT
    i.*,
    LAG(over90) OVER (PARTITION BY doc_fundo, nome_fundo ORDER BY data_referencia) AS over90_anterior,
    LAG(over180) OVER (PARTITION BY doc_fundo, nome_fundo ORDER BY data_referencia) AS over180_anterior,
    LAG(data_referencia) OVER (PARTITION BY doc_fundo, nome_fundo ORDER BY data_referencia) AS data_anterior
  FROM credito_estoque_indicadores i
  WHERE nome_fundo <> 'CONSOLIDADO'
)
SELECT
  doc_fundo, nome_fundo, data_referencia, data_anterior,
  over90, over180, over90_anterior, over180_anterior,
  over90 - over90_anterior AS delta_over90,
  over180 - over180_anterior AS delta_over180
FROM ranked;

-- Concentração da inadimplência (Over90) por cedente e sacado
CREATE OR REPLACE VIEW vw_credito_concentracao_over90 AS
WITH over90_base AS (
  SELECT
    b.data_referencia, b.doc_fundo, b.nome_fundo,
    b.doc_cedente, b.nome_cedente, b.doc_sacado, b.nome_sacado,
    b.valor_base
  FROM vw_estoque_fidc_base b
  WHERE b.bucket_ordem >= 4
),
totais AS (
  SELECT data_referencia, doc_fundo, SUM(valor_base) AS total_over90
  FROM over90_base GROUP BY data_referencia, doc_fundo
)
SELECT 'cedente'::TEXT AS tipo_parte, o.data_referencia, o.doc_fundo, MAX(o.nome_fundo) AS nome_fundo,
  o.doc_cedente AS doc_parte, MAX(o.nome_cedente) AS nome_parte,
  SUM(o.valor_base) AS exposicao_over90,
  ROUND(SUM(o.valor_base) / NULLIF(t.total_over90, 0), 6) AS pct_do_over90,
  RANK() OVER (PARTITION BY o.data_referencia, o.doc_fundo ORDER BY SUM(o.valor_base) DESC) AS ranking
FROM over90_base o
JOIN totais t ON t.data_referencia = o.data_referencia AND t.doc_fundo = o.doc_fundo
WHERE o.doc_cedente IS NOT NULL AND TRIM(o.doc_cedente) <> ''
GROUP BY o.data_referencia, o.doc_fundo, o.doc_cedente, t.total_over90
UNION ALL
SELECT 'sacado'::TEXT, o.data_referencia, o.doc_fundo, MAX(o.nome_fundo),
  o.doc_sacado, MAX(o.nome_sacado), SUM(o.valor_base),
  ROUND(SUM(o.valor_base) / NULLIF(t.total_over90, 0), 6),
  RANK() OVER (PARTITION BY o.data_referencia, o.doc_fundo ORDER BY SUM(o.valor_base) DESC)
FROM over90_base o
JOIN totais t ON t.data_referencia = o.data_referencia AND t.doc_fundo = o.doc_fundo
WHERE o.doc_sacado IS NOT NULL AND TRIM(o.doc_sacado) <> ''
GROUP BY o.data_referencia, o.doc_fundo, o.doc_sacado, t.total_over90;

-- Alertas de risco (limite + tendência + salto)
CREATE OR REPLACE VIEW vw_credito_alertas_risco AS
WITH ultimo AS (
  SELECT DISTINCT ON (doc_fundo, nome_fundo)
    i.*, t.delta_over90 AS delta_over90_calc, t.delta_over180 AS delta_over180_calc
  FROM credito_estoque_indicadores i
  LEFT JOIN vw_credito_indicadores_tendencia t
    ON t.doc_fundo IS NOT DISTINCT FROM i.doc_fundo
   AND t.nome_fundo = i.nome_fundo
   AND t.data_referencia = i.data_referencia
  WHERE i.nome_fundo <> 'CONSOLIDADO'
  ORDER BY i.doc_fundo, i.nome_fundo, i.data_referencia DESC
),
conc_top1 AS (
  SELECT data_referencia, doc_fundo, MAX(pct_do_over90) AS pct_top1_cedente
  FROM vw_credito_concentracao_over90
  WHERE tipo_parte = 'cedente' AND ranking = 1
  GROUP BY data_referencia, doc_fundo
),
tendencia_over90 AS (
  SELECT doc_fundo, nome_fundo,
    BOOL_AND(delta_over90 > 0) AS over90_crescente_3m
  FROM (
    SELECT doc_fundo, nome_fundo, delta_over90,
      ROW_NUMBER() OVER (PARTITION BY doc_fundo, nome_fundo ORDER BY data_referencia DESC) AS rn
    FROM vw_credito_indicadores_tendencia WHERE delta_over90 IS NOT NULL
  ) x WHERE rn <= 3 GROUP BY doc_fundo, nome_fundo HAVING COUNT(*) = 3
)
SELECT u.doc_fundo, u.nome_fundo, u.data_referencia,
  'salto'::TEXT AS tipo_alerta, 'over90'::TEXT AS indicador, 'alerta'::TEXT AS severidade,
  CONCAT('Over90 subiu ', ROUND(COALESCE(u.delta_over90, u.delta_over90_calc, 0) * 100, 2), ' p.p.') AS mensagem
FROM ultimo u WHERE COALESCE(u.delta_over90, u.delta_over90_calc, 0) > 0.02
UNION ALL
SELECT u.doc_fundo, u.nome_fundo, u.data_referencia,
  'limite', 'coverage_npl', 'critico',
  CONCAT('Coverage NPL ', ROUND(COALESCE(u.coverage_npl, u.pdd_sobre_over90, 0) * 100, 1), '%')
FROM ultimo u WHERE COALESCE(u.coverage_npl, u.pdd_sobre_over90, 0) < 0.80 AND COALESCE(u.coverage_npl, u.pdd_sobre_over90, 0) > 0
UNION ALL
SELECT u.doc_fundo, u.nome_fundo, u.data_referencia,
  'limite', 'aderencia_pdd', 'alerta',
  CONCAT('Aderência PDD ', ROUND(COALESCE(u.aderencia_pdd, 0) * 100, 1), '%')
FROM ultimo u WHERE u.pdd_modelo_total > 0 AND COALESCE(u.aderencia_pdd, 0) < 0.90
UNION ALL
SELECT u.doc_fundo, u.nome_fundo, u.data_referencia,
  'limite', 'gap_relativo', 'alerta',
  CONCAT('Gap ', ROUND((u.gap_total / NULLIF(u.pdd_modelo_total, 0)) * 100, 1), '% do modelo')
FROM ultimo u WHERE u.pdd_modelo_total > 0 AND (u.gap_total / u.pdd_modelo_total) > 0.10
UNION ALL
SELECT u.doc_fundo, u.nome_fundo, u.data_referencia,
  'tendencia', 'over90', 'alerta', 'Over90 crescente por 3 meses consecutivos'
FROM ultimo u
JOIN tendencia_over90 t ON t.doc_fundo IS NOT DISTINCT FROM u.doc_fundo AND t.nome_fundo = u.nome_fundo
UNION ALL
SELECT u.doc_fundo, u.nome_fundo, u.data_referencia,
  'limite', 'concentracao_top1_over90', 'critico',
  CONCAT('Top cedente concentra ', ROUND(c.pct_top1_cedente * 100, 1), '% do Over90')
FROM ultimo u
JOIN conc_top1 c ON c.doc_fundo = u.doc_fundo AND c.data_referencia = u.data_referencia
WHERE c.pct_top1_cedente > 0.50;

-- Score composto parametrizado (0-100)
CREATE OR REPLACE VIEW vw_credito_score_fundo AS
WITH params AS (
  SELECT indicador, peso, valor_referencia
  FROM credito_score_parametros WHERE doc_fundo IS NULL AND ativo
),
ultimo AS (
  SELECT DISTINCT ON (doc_fundo, nome_fundo) *
  FROM credito_estoque_indicadores WHERE nome_fundo <> 'CONSOLIDADO'
  ORDER BY doc_fundo, nome_fundo, data_referencia DESC
),
conc AS (
  SELECT doc_fundo, data_referencia, MAX(pct_do_over90) AS pct_top1
  FROM vw_credito_concentracao_over90 WHERE tipo_parte = 'cedente' AND ranking = 1
  GROUP BY doc_fundo, data_referencia
),
metricas AS (
  SELECT u.doc_fundo, u.nome_fundo, u.data_referencia, u.over90, u.over180,
    COALESCE(u.coverage_npl, u.pdd_sobre_over90, 0) AS coverage_npl,
    COALESCE(u.aderencia_pdd, CASE WHEN u.pdd_modelo_total > 0 THEN u.pdd_atual_total / u.pdd_modelo_total ELSE 0 END) AS aderencia_pdd,
    COALESCE(u.delta_over90, 0) AS delta_over90,
    CASE WHEN u.pdd_modelo_total > 0 THEN u.gap_total / u.pdd_modelo_total ELSE 0 END AS gap_relativo,
    COALESCE(c.pct_top1, 0) AS concentracao_over90
  FROM ultimo u
  LEFT JOIN conc c ON c.doc_fundo = u.doc_fundo AND c.data_referencia = u.data_referencia
),
componentes AS (
  SELECT m.*,
    GREATEST(0, LEAST(1, 1 - (m.over90 / NULLIF(COALESCE((SELECT valor_referencia FROM params WHERE indicador = 'over90'), 0.15), 0)))) AS c_over90,
    GREATEST(0, LEAST(1, m.coverage_npl / NULLIF(COALESCE((SELECT valor_referencia FROM params WHERE indicador = 'coverage_npl'), 1), 0))) AS c_cov_npl,
    GREATEST(0, LEAST(1, m.aderencia_pdd / NULLIF(COALESCE((SELECT valor_referencia FROM params WHERE indicador = 'aderencia_pdd'), 1), 0))) AS c_aderencia,
    GREATEST(0, LEAST(1, 1 - ABS(m.delta_over90) / 0.05)) AS c_delta,
    GREATEST(0, LEAST(1, 1 - GREATEST(m.gap_relativo, 0) / 0.20)) AS c_gap,
    GREATEST(0, LEAST(1, 1 - m.concentracao_over90 / 0.70)) AS c_conc,
    COALESCE((SELECT peso FROM params WHERE indicador = 'over90'), 0.20) AS w_over90,
    COALESCE((SELECT peso FROM params WHERE indicador = 'coverage_npl'), 0.20) AS w_cov_npl,
    COALESCE((SELECT peso FROM params WHERE indicador = 'aderencia_pdd'), 0.15) AS w_aderencia,
    COALESCE((SELECT peso FROM params WHERE indicador = 'delta_over90'), 0.15) AS w_delta,
    COALESCE((SELECT peso FROM params WHERE indicador = 'gap_relativo'), 0.10) AS w_gap,
    COALESCE((SELECT peso FROM params WHERE indicador = 'concentracao_over90'), 0.05) AS w_conc
  FROM metricas m
),
final AS (
  SELECT *, (w_over90 * c_over90 + w_cov_npl * c_cov_npl + w_aderencia * c_aderencia
    + w_delta * c_delta + w_gap * c_gap + w_conc * c_conc)
    / NULLIF(w_over90 + w_cov_npl + w_aderencia + w_delta + w_gap + w_conc, 0) * 100 AS score_qualidade
  FROM componentes
)
SELECT doc_fundo, nome_fundo, data_referencia, over90, over180, coverage_npl, aderencia_pdd,
  delta_over90, gap_relativo, concentracao_over90, ROUND(score_qualidade, 1) AS score_qualidade,
  CASE WHEN score_qualidade >= 90 THEN 'Excelente' WHEN score_qualidade >= 75 THEN 'Bom'
       WHEN score_qualidade >= 60 THEN 'Atencao' ELSE 'Critico' END AS faixa_score
FROM final;

COMMENT ON VIEW vw_estoque_fidc_por_faixa IS
  'Distribuição por bucket canônico único (Adimplente … 180+).';
COMMENT ON VIEW vw_credito_concentracao_over90 IS
  'Concentração da inadimplência Over90 por cedente e sacado.';
COMMENT ON VIEW vw_credito_alertas_risco IS
  'Alertas proativos de risco (limite, salto e tendência).';
COMMENT ON VIEW vw_credito_score_fundo IS
  'Score composto 0-100 com pesos em credito_score_parametros.';
