-- ============================================================
-- Migration: Credit Roll Rate Analytical Views
-- Base: tabela estoque_fidc (importação Frontis)
-- Referência metodológica: Manual Finvest
-- ============================================================
--
-- IMPORTANTE: Estas views geram INSUMOS analíticos.
-- NÃO calculam PDD final, NÃO aplicam provisão automática,
-- NÃO substituem deliberação de comitê.
--
-- Faixas de atraso (Manual Finvest):
--   F0: 0 a 15 dias  (negativos → F0, escolha conservadora)
--   F1: 16 a 30 dias
--   F2: 31 a 60 dias
--   F3: 61 a 90 dias
--   F4: 91 a 120 dias
--   F5: 121 a 150 dias
--   F6: 151 a 180 dias
--   F7: > 180 dias (perda)
--
-- Base monetária: valor_presente (conservador)
-- LIMITAÇÃO: sem campo VNA separado; sem flag de pagamento variável
--            confiável → usar valor_presente para todos os ativos.
--
-- Chave do ativo (hierarquia conservadora):
--   1) seu_numero  (preferencial)
--   2) nu_documento  (fallback)
--   3) chave composta: doc_fundo|doc_sacado|nu_documento|data_vcto|valor_nominal
--
-- De-duplicação por mês: antes da comparação, consolida
--   (doc_fundo, data_referencia, chave_ativo) → MAX(faixa), SUM(valor)
-- ============================================================

-- Drop em ordem reversa de dependência para recriação limpa
DROP VIEW IF EXISTS vw_estoque_fidc_alertas_qualidade  CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_resumo_gerencial   CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_roll_rate_media_3m CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_roll_rate          CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_matriz_migracao    CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_migracao_detalhada CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_por_faixa          CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_consolidado        CASCADE;
DROP VIEW IF EXISTS vw_estoque_fidc_base               CASCADE;

-- ============================================================
-- VIEW 1: vw_estoque_fidc_base
-- Camada base padronizada. Uma linha por registro de estoque_fidc.
-- Filtra para o import mais recente de sucesso por fundo+data.
-- ============================================================
CREATE OR REPLACE VIEW vw_estoque_fidc_base AS
WITH latest_imports AS (
  -- Por fundo+data: apenas o import mais recente com status de sucesso.
  -- Evita dupla contagem em caso de re-importação do mesmo período.
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
      WHEN seu_numero  IS NOT NULL AND TRIM(seu_numero)  <> '' THEN seu_numero
      WHEN nu_documento IS NOT NULL AND TRIM(nu_documento) <> '' THEN nu_documento
      ELSE CONCAT(
        COALESCE(doc_fundo,    ''), '|',
        COALESCE(doc_sacado,   ''), '|',
        COALESCE(nu_documento, ''), '|',
        COALESCE(data_vencimento_base::TEXT, 'sem_vcto'), '|',
        COALESCE(valor_nominal::TEXT, '0')
      )
    END AS chave_ativo,
    CASE
      WHEN seu_numero  IS NOT NULL AND TRIM(seu_numero)  <> '' THEN 'seu_numero'
      WHEN nu_documento IS NOT NULL AND TRIM(nu_documento) <> '' THEN 'nu_documento'
      ELSE 'composta'
    END AS tipo_chave,
    CASE
      WHEN (seu_numero  IS NOT NULL AND TRIM(seu_numero)  <> '')
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
  -- Valor base: valor_presente por padrão (Manual Finvest)
  -- LIMITAÇÃO: sem VNA separado; usar VP para todos os tipos de ativo
  COALESCE(valor_presente, valor_nominal, 0) AS valor_base,
  data_vencimento_base,
  data_vencimento_ajustada,
  data_vencimento_original,
  chave_ativo,
  tipo_chave,
  chave_confiavel,
  nao_classificavel,
  dias_atraso,
  -- Faixa calculada (Manual Finvest)
  -- Conservador: dias negativos (vencimento futuro) → F0
  CASE
    WHEN dias_atraso IS NULL THEN NULL
    WHEN dias_atraso <= 15   THEN 0  -- F0: 0-15 dias (inclui negativos)
    WHEN dias_atraso <= 30   THEN 1  -- F1: 16-30 dias
    WHEN dias_atraso <= 60   THEN 2  -- F2: 31-60 dias
    WHEN dias_atraso <= 90   THEN 3  -- F3: 61-90 dias
    WHEN dias_atraso <= 120  THEN 4  -- F4: 91-120 dias
    WHEN dias_atraso <= 150  THEN 5  -- F5: 121-150 dias
    WHEN dias_atraso <= 180  THEN 6  -- F6: 151-180 dias
    ELSE                     7       -- F7: >180 dias (perda)
  END AS faixa_calculada,
  faixa_pdd      AS faixa_pdd_original,
  faixa_pdd_geral AS faixa_pdd_geral_original,
  situacao_recebivel,
  seu_numero,
  nu_documento,
  valor_nominal,
  valor_presente,
  valor_pdd
FROM with_chave;

COMMENT ON VIEW vw_estoque_fidc_base IS
  'Base padronizada do estoque FIDC. Uma linha por registro importado. '
  'Inclui chave_ativo calculada, faixa_calculada (Finvest) e flags de qualidade. '
  'Filtrada para o import mais recente com sucesso por fundo+data.';

-- ============================================================
-- VIEW 2: vw_estoque_fidc_consolidado
-- Consolida duplicidades por (doc_fundo, data_referencia, chave_ativo).
-- Regra conservadora: SUM(valor_base), MAX(faixa_calculada) = pior faixa.
-- Exclui registros não classificáveis (sem data de vencimento).
-- ============================================================
CREATE OR REPLACE VIEW vw_estoque_fidc_consolidado AS
SELECT
  data_referencia,
  doc_fundo,
  MAX(nome_fundo)            AS nome_fundo,
  chave_ativo,
  MAX(tipo_chave)            AS tipo_chave,
  BOOL_AND(chave_confiavel)  AS chave_confiavel,
  SUM(valor_base)            AS valor_base,
  MAX(faixa_calculada)       AS faixa_calculada,   -- pior faixa (conservador)
  COUNT(*)                   AS num_registros,
  COUNT(*) > 1               AS foi_consolidado,
  BOOL_OR(nao_classificavel) AS nao_classificavel
FROM vw_estoque_fidc_base
WHERE faixa_calculada IS NOT NULL
GROUP BY data_referencia, doc_fundo, chave_ativo;

COMMENT ON VIEW vw_estoque_fidc_consolidado IS
  'Estoque deduplificado: uma linha por (doc_fundo, data_referencia, chave_ativo). '
  'Usa pior faixa (conservador) e soma de valor em caso de duplicidade. '
  'Registros não classificáveis (sem vencimento) são excluídos.';

-- ============================================================
-- VIEW 3: vw_estoque_fidc_por_faixa
-- Distribuição do estoque por faixa e por mês.
-- Inclui percentual sobre o total do fundo na data.
-- ============================================================
CREATE OR REPLACE VIEW vw_estoque_fidc_por_faixa AS
WITH totais AS (
  SELECT
    doc_fundo,
    data_referencia,
    SUM(valor_base) AS total_fundo
  FROM vw_estoque_fidc_consolidado
  GROUP BY doc_fundo, data_referencia
)
SELECT
  c.data_referencia,
  c.doc_fundo,
  MAX(c.nome_fundo)                            AS nome_fundo,
  c.faixa_calculada,
  CASE c.faixa_calculada
    WHEN 0 THEN 'F0 (0-15 dias)'
    WHEN 1 THEN 'F1 (16-30 dias)'
    WHEN 2 THEN 'F2 (31-60 dias)'
    WHEN 3 THEN 'F3 (61-90 dias)'
    WHEN 4 THEN 'F4 (91-120 dias)'
    WHEN 5 THEN 'F5 (121-150 dias)'
    WHEN 6 THEN 'F6 (151-180 dias)'
    WHEN 7 THEN 'F7 (>180 dias - Perda)'
    ELSE 'N/A'
  END                                          AS faixa_descricao,
  COUNT(DISTINCT c.chave_ativo)                AS quantidade_ativos,
  SUM(c.valor_base)                            AS valor_total,
  ROUND(
    SUM(c.valor_base) * 100.0 / NULLIF(t.total_fundo, 0),
    4
  )                                            AS percentual_estoque
FROM vw_estoque_fidc_consolidado c
JOIN totais t
  ON t.doc_fundo = c.doc_fundo
 AND t.data_referencia = c.data_referencia
GROUP BY c.data_referencia, c.doc_fundo, c.faixa_calculada, t.total_fundo
ORDER BY c.data_referencia DESC, c.doc_fundo, c.faixa_calculada;

COMMENT ON VIEW vw_estoque_fidc_por_faixa IS
  'Estoque agregado por faixa Finvest, por fundo e por mês. '
  'Inclui percentual sobre o total do fundo na data de referência.';

-- ============================================================
-- VIEW 4: vw_estoque_fidc_migracao_detalhada
-- Migração individual de cada ativo entre meses consecutivos.
-- "Consecutivo" = próxima data disponível na base (sem assumir periodicidade).
-- Captura todos os 6 movimentos: permaneceu, curou, piorou,
-- entrou_em_perda, saiu_da_base, entrou_na_base.
-- ============================================================
CREATE OR REPLACE VIEW vw_estoque_fidc_migracao_detalhada AS
WITH fund_dates AS (
  SELECT DISTINCT doc_fundo, data_referencia
  FROM vw_estoque_fidc_consolidado
),
consecutive_pairs AS (
  -- Para cada fundo+data: encontra a PRÓXIMA data disponível.
  -- Conservador: não assume periodicidade mensal fixa.
  SELECT
    d1.doc_fundo,
    d1.data_referencia AS mes_origem,
    MIN(d2.data_referencia) AS mes_destino
  FROM fund_dates d1
  JOIN fund_dates d2
    ON d1.doc_fundo = d2.doc_fundo
   AND d2.data_referencia > d1.data_referencia
  GROUP BY d1.doc_fundo, d1.data_referencia
),
-- Perspectiva M1: ativos no mês origem + join (LEFT) para mês destino
m1_view AS (
  SELECT
    cp.mes_origem,
    cp.mes_destino,
    m1.doc_fundo,
    m1.nome_fundo,
    m1.chave_ativo,
    m1.tipo_chave,
    m1.chave_confiavel,
    m1.faixa_calculada             AS faixa_origem,
    m2.faixa_calculada             AS faixa_destino,
    m1.valor_base                  AS valor_origem,
    m2.valor_base                  AS valor_destino,
    m1.num_registros               AS num_registros_origem,
    COALESCE(m2.num_registros, 0)  AS num_registros_destino,
    m1.foi_consolidado             AS consolidado_origem
  FROM consecutive_pairs cp
  JOIN vw_estoque_fidc_consolidado m1
    ON m1.doc_fundo      = cp.doc_fundo
   AND m1.data_referencia = cp.mes_origem
  LEFT JOIN vw_estoque_fidc_consolidado m2
    ON m2.doc_fundo      = cp.doc_fundo
   AND m2.data_referencia = cp.mes_destino
   AND m2.chave_ativo    = m1.chave_ativo
),
-- Ativos novos: presentes em M2 mas ausentes em M1 (entrou_na_base)
m2_new AS (
  SELECT
    cp.mes_origem,
    cp.mes_destino,
    m2.doc_fundo,
    m2.nome_fundo,
    m2.chave_ativo,
    m2.tipo_chave,
    m2.chave_confiavel,
    NULL::INTEGER     AS faixa_origem,
    m2.faixa_calculada AS faixa_destino,
    0::NUMERIC         AS valor_origem,
    m2.valor_base      AS valor_destino,
    0                  AS num_registros_origem,
    m2.num_registros   AS num_registros_destino,
    FALSE              AS consolidado_origem
  FROM consecutive_pairs cp
  JOIN vw_estoque_fidc_consolidado m2
    ON m2.doc_fundo      = cp.doc_fundo
   AND m2.data_referencia = cp.mes_destino
  LEFT JOIN vw_estoque_fidc_consolidado m1
    ON m1.doc_fundo      = cp.doc_fundo
   AND m1.data_referencia = cp.mes_origem
   AND m1.chave_ativo    = m2.chave_ativo
  WHERE m1.chave_ativo IS NULL  -- não estava em M1
)
SELECT
  mes_origem,
  mes_destino,
  doc_fundo,
  nome_fundo,
  chave_ativo,
  tipo_chave,
  chave_confiavel,
  faixa_origem,
  faixa_destino,
  valor_origem,
  valor_destino,
  num_registros_origem,
  num_registros_destino,
  consolidado_origem,
  CASE
    WHEN faixa_origem IS NULL OR faixa_destino IS NULL THEN NULL
    ELSE faixa_destino - faixa_origem
  END AS delta_faixa,
  -- Classificação do movimento (6 categorias)
  CASE
    WHEN faixa_origem IS NULL                       THEN 'entrou_na_base'
    WHEN faixa_destino IS NULL                      THEN 'saiu_da_base'
    WHEN faixa_destino = faixa_origem               THEN 'permaneceu'
    WHEN faixa_destino < faixa_origem               THEN 'curou'
    WHEN faixa_origem < 7 AND faixa_destino = 7     THEN 'entrou_em_perda'
    WHEN faixa_destino > faixa_origem               THEN 'piorou'
    ELSE 'sem_movimento_identificado'
  END AS classificacao_movimento
FROM m1_view
UNION ALL
SELECT
  mes_origem,
  mes_destino,
  doc_fundo,
  nome_fundo,
  chave_ativo,
  tipo_chave,
  chave_confiavel,
  faixa_origem,
  faixa_destino,
  valor_origem,
  valor_destino,
  num_registros_origem,
  num_registros_destino,
  consolidado_origem,
  NULL AS delta_faixa,
  'entrou_na_base'::TEXT AS classificacao_movimento
FROM m2_new;

COMMENT ON VIEW vw_estoque_fidc_migracao_detalhada IS
  'Migração individual por ativo entre pares de meses consecutivos. '
  'Cobre todos os 6 movimentos: permaneceu, curou, piorou, entrou_em_perda, '
  'saiu_da_base, entrou_na_base. Inclui ativos sem par (saiu/entrou na base). '
  'Para roll rate, usar apenas ativos presentes nos dois meses '
  '(excluir saiu_da_base e entrou_na_base).';

-- ============================================================
-- VIEW 5: vw_estoque_fidc_matriz_migracao
-- Matriz agregada: quantidade e valor por origem x destino de faixa.
-- Exclui entradas/saídas da base (foco na comparação entre meses).
-- ============================================================
CREATE OR REPLACE VIEW vw_estoque_fidc_matriz_migracao AS
SELECT
  mes_origem,
  mes_destino,
  doc_fundo,
  MAX(nome_fundo)             AS nome_fundo,
  faixa_origem,
  faixa_destino,
  COUNT(DISTINCT chave_ativo) AS quantidade_ativos,
  SUM(valor_origem)           AS valor_migrado
FROM vw_estoque_fidc_migracao_detalhada
WHERE faixa_origem  IS NOT NULL
  AND faixa_destino IS NOT NULL
GROUP BY mes_origem, mes_destino, doc_fundo, faixa_origem, faixa_destino
ORDER BY mes_origem, mes_destino, doc_fundo, faixa_origem, faixa_destino;

COMMENT ON VIEW vw_estoque_fidc_matriz_migracao IS
  'Matriz de migração agregada: linhas = faixa origem, colunas = faixa destino. '
  'Permite visualização tipo heatmap da migração entre faixas por mês.';

-- ============================================================
-- VIEW 6: vw_estoque_fidc_roll_rate
-- Roll rate por par de meses consecutivos, por fundo e faixa.
--
-- Fórmula (Manual Finvest):
--   roll_rate_FN→FN+1 =
--     valor dos ativos que estavam em FN no mês origem
--     e foram para FN+1 no mês destino
--     /
--     valor total dos ativos em FN no mês origem
--
-- Numerador: apenas migração exata N→N+1 (não inclui curas, permanências).
-- Denominador: todos os ativos em FN que aparecem nos dois meses.
-- Divisão segura com NULLIF(denominador, 0).
-- ============================================================
CREATE OR REPLACE VIEW vw_estoque_fidc_roll_rate AS
SELECT
  m.mes_origem,
  m.mes_destino,
  m.doc_fundo,
  MAX(m.nome_fundo)                                                                       AS nome_fundo,
  m.faixa_origem,
  CONCAT('F', m.faixa_origem, '→F', m.faixa_origem + 1)                                  AS migracao,
  COUNT(DISTINCT m.chave_ativo)                                                           AS qtd_ativos_origem,
  COUNT(DISTINCT CASE WHEN m.faixa_destino = m.faixa_origem + 1 THEN m.chave_ativo END)  AS qtd_ativos_migrados,
  SUM(m.valor_origem)                                                                     AS valor_origem_total,
  SUM(CASE WHEN m.faixa_destino = m.faixa_origem + 1 THEN m.valor_origem ELSE 0 END)     AS valor_migrado_para_faixa_seguinte,
  ROUND(
    SUM(CASE WHEN m.faixa_destino = m.faixa_origem + 1 THEN m.valor_origem ELSE 0 END)
    / NULLIF(SUM(m.valor_origem), 0),
    6
  )                                                                                       AS roll_rate
FROM vw_estoque_fidc_migracao_detalhada m
WHERE m.faixa_origem  IS NOT NULL
  AND m.faixa_destino IS NOT NULL
  AND m.faixa_origem  < 7  -- F7 já é perda; não há faixa seguinte
GROUP BY m.mes_origem, m.mes_destino, m.doc_fundo, m.faixa_origem
ORDER BY m.mes_origem, m.mes_destino, m.doc_fundo, m.faixa_origem;

COMMENT ON VIEW vw_estoque_fidc_roll_rate IS
  'Roll rate por par de meses e faixa de origem. '
  'Fórmula Finvest: valor migrado FN→FN+1 / valor total em FN no mês origem. '
  'Numerador inclui SOMENTE migração exata N→N+1. '
  'Curas, permanências e entradas/saídas da base NÃO entram no numerador. '
  'Divisão segura: roll_rate = NULL quando denominador = 0.';

-- ============================================================
-- VIEW 7: vw_estoque_fidc_roll_rate_media_3m
-- Média simples dos últimos 3 meses de roll rate disponíveis.
-- Sinaliza quando há menos de 3 observações (não preenche artificialmente).
-- ============================================================
CREATE OR REPLACE VIEW vw_estoque_fidc_roll_rate_media_3m AS
WITH roll_ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY doc_fundo, faixa_origem
      ORDER BY mes_origem DESC
    ) AS rn
  FROM vw_estoque_fidc_roll_rate
  WHERE roll_rate IS NOT NULL
)
SELECT
  doc_fundo,
  MAX(nome_fundo)                                   AS nome_fundo,
  faixa_origem,
  CONCAT('F', faixa_origem, '→F', faixa_origem + 1) AS migracao,
  ROUND(AVG(roll_rate), 6)                           AS media_3m,
  COUNT(*)                                           AS meses_utilizados,
  MIN(mes_origem)                                    AS mes_mais_antigo,
  MAX(mes_origem)                                    AS mes_mais_recente,
  COUNT(*) < 3                                       AS media_incompleta
FROM roll_ranked
WHERE rn <= 3
GROUP BY doc_fundo, faixa_origem
ORDER BY doc_fundo, faixa_origem;

COMMENT ON VIEW vw_estoque_fidc_roll_rate_media_3m IS
  'Média simples dos últimos 3 meses de roll rate (Manual Finvest). '
  'media_incompleta = TRUE quando há menos de 3 observações disponíveis. '
  'NÃO preenche artificialmente meses ausentes.';

-- ============================================================
-- VIEW 8: vw_estoque_fidc_resumo_gerencial
-- Camada de resumo executivo por fundo, pronta para o frontend.
-- Inclui distribuição atual por faixa, Over90, perda e
-- variações do último par de meses.
-- ============================================================
CREATE OR REPLACE VIEW vw_estoque_fidc_resumo_gerencial AS
WITH ultima_ref AS (
  SELECT doc_fundo, MAX(data_referencia) AS ultima_data
  FROM vw_estoque_fidc_consolidado
  GROUP BY doc_fundo
),
estoque_atual AS (
  SELECT
    c.doc_fundo,
    MAX(c.nome_fundo)                                                          AS nome_fundo,
    c.data_referencia,
    SUM(c.valor_base)                                                          AS carteira_total,
    SUM(CASE WHEN c.faixa_calculada = 0 THEN c.valor_base ELSE 0 END)         AS valor_f0,
    SUM(CASE WHEN c.faixa_calculada = 1 THEN c.valor_base ELSE 0 END)         AS valor_f1,
    SUM(CASE WHEN c.faixa_calculada = 2 THEN c.valor_base ELSE 0 END)         AS valor_f2,
    SUM(CASE WHEN c.faixa_calculada = 3 THEN c.valor_base ELSE 0 END)         AS valor_f3,
    SUM(CASE WHEN c.faixa_calculada = 4 THEN c.valor_base ELSE 0 END)         AS valor_f4,
    SUM(CASE WHEN c.faixa_calculada = 5 THEN c.valor_base ELSE 0 END)         AS valor_f5,
    SUM(CASE WHEN c.faixa_calculada = 6 THEN c.valor_base ELSE 0 END)         AS valor_f6,
    SUM(CASE WHEN c.faixa_calculada = 7 THEN c.valor_base ELSE 0 END)         AS valor_f7,
    SUM(CASE WHEN c.faixa_calculada >= 1 THEN c.valor_base ELSE 0 END)        AS total_em_atraso,
    SUM(CASE WHEN c.faixa_calculada >= 3 THEN c.valor_base ELSE 0 END)        AS total_over90,
    SUM(CASE WHEN c.faixa_calculada = 7  THEN c.valor_base ELSE 0 END)        AS total_perda,
    COUNT(DISTINCT c.chave_ativo)                                              AS qtd_ativos_total,
    COUNT(DISTINCT CASE WHEN c.faixa_calculada >= 1 THEN c.chave_ativo END)   AS qtd_ativos_em_atraso,
    COUNT(DISTINCT CASE WHEN c.faixa_calculada = 7  THEN c.chave_ativo END)   AS qtd_ativos_perda
  FROM vw_estoque_fidc_consolidado c
  JOIN ultima_ref ur
    ON ur.doc_fundo = c.doc_fundo
   AND ur.ultima_data = c.data_referencia
  GROUP BY c.doc_fundo, c.data_referencia
),
ultima_migracao_ref AS (
  SELECT doc_fundo, MAX(mes_destino) AS ultima_competencia
  FROM vw_estoque_fidc_migracao_detalhada
  GROUP BY doc_fundo
),
ultima_migracao AS (
  SELECT
    m.doc_fundo,
    COUNT(DISTINCT CASE WHEN m.classificacao_movimento = 'piorou'
      THEN m.chave_ativo END)                                                  AS qtd_piorou,
    COUNT(DISTINCT CASE WHEN m.classificacao_movimento = 'curou'
      THEN m.chave_ativo END)                                                  AS qtd_curou,
    COUNT(DISTINCT CASE WHEN m.classificacao_movimento = 'entrou_em_perda'
      THEN m.chave_ativo END)                                                  AS qtd_entrou_em_perda,
    SUM(CASE WHEN m.classificacao_movimento = 'entrou_em_perda'
      THEN m.valor_origem ELSE 0 END)                                          AS valor_entrou_em_perda,
    COUNT(DISTINCT CASE WHEN m.faixa_origem = 0 AND m.faixa_destino >= 1
      THEN m.chave_ativo END)                                                  AS qtd_entrou_em_atraso,
    SUM(CASE WHEN m.faixa_origem = 0 AND m.faixa_destino >= 1
      THEN m.valor_origem ELSE 0 END)                                          AS valor_entrou_em_atraso
  FROM vw_estoque_fidc_migracao_detalhada m
  JOIN ultima_migracao_ref umr
    ON umr.doc_fundo = m.doc_fundo
   AND umr.ultima_competencia = m.mes_destino
  GROUP BY m.doc_fundo
)
SELECT
  ea.*,
  ROUND(ea.total_em_atraso / NULLIF(ea.carteira_total, 0) * 100, 4) AS pct_em_atraso,
  ROUND(ea.total_over90   / NULLIF(ea.carteira_total, 0) * 100, 4) AS pct_over90,
  ROUND(ea.total_perda    / NULLIF(ea.carteira_total, 0) * 100, 4) AS pct_perda,
  COALESCE(um.qtd_piorou,                  0)  AS qtd_piorou_ultimo_mes,
  COALESCE(um.qtd_curou,                   0)  AS qtd_curou_ultimo_mes,
  COALESCE(um.qtd_entrou_em_perda,         0)  AS qtd_entrou_em_perda_ultimo_mes,
  COALESCE(um.valor_entrou_em_perda,       0)  AS valor_entrou_em_perda_ultimo_mes,
  COALESCE(um.qtd_entrou_em_atraso,        0)  AS qtd_entrou_em_atraso_ultimo_mes,
  COALESCE(um.valor_entrou_em_atraso,      0)  AS valor_entrou_em_atraso_ultimo_mes
FROM estoque_atual ea
LEFT JOIN ultima_migracao um ON um.doc_fundo = ea.doc_fundo;

COMMENT ON VIEW vw_estoque_fidc_resumo_gerencial IS
  'Resumo executivo por fundo: carteira total, distribuição por faixa, '
  'Over90, perda e variações do último par de meses disponível. '
  'Pronto para consumo pelo frontend do módulo de crédito.';

-- ============================================================
-- VIEW 9: vw_estoque_fidc_alertas_qualidade
-- Log de alertas de qualidade da base importada.
-- Tipos: sem_chave_confiavel, sem_vencimento, duplicidade_chave_mes,
--        historico_insuficiente.
-- ============================================================
CREATE OR REPLACE VIEW vw_estoque_fidc_alertas_qualidade AS

-- 1. Registros com chave composta (sem SEU_NUMERO e NU_DOCUMENTO)
SELECT
  'sem_chave_confiavel'::TEXT                                     AS tipo_alerta,
  data_referencia,
  doc_fundo,
  MAX(nome_fundo)                                                  AS nome_fundo,
  import_id::TEXT                                                  AS referencia,
  COUNT(*)::BIGINT                                                 AS quantidade,
  CONCAT('Registros com chave composta: ', COUNT(*),
         ' (sem SEU_NUMERO e NU_DOCUMENTO)')::TEXT                 AS descricao
FROM vw_estoque_fidc_base
WHERE NOT chave_confiavel
GROUP BY data_referencia, doc_fundo, import_id

UNION ALL

-- 2. Registros não classificáveis (sem data de vencimento)
SELECT
  'sem_vencimento'::TEXT,
  data_referencia,
  doc_fundo,
  MAX(nome_fundo),
  import_id::TEXT,
  COUNT(*)::BIGINT,
  CONCAT('Registros sem data de vencimento (excluídos do roll rate): ',
         COUNT(*))::TEXT
FROM vw_estoque_fidc_base
WHERE nao_classificavel
GROUP BY data_referencia, doc_fundo, import_id

UNION ALL

-- 3. Duplicidade da mesma chave no mesmo mês (antes da consolidação)
SELECT
  'duplicidade_chave_mes'::TEXT,
  data_referencia,
  doc_fundo,
  MAX(nome_fundo),
  LEFT(chave_ativo, 50),
  COUNT(*)::BIGINT,
  CONCAT('Chave "', LEFT(chave_ativo, 30), '..." aparece ',
         COUNT(*), ' vezes no mesmo mês. '
         'Consolidado: soma de valor, pior faixa.')::TEXT
FROM vw_estoque_fidc_base
WHERE NOT nao_classificavel
GROUP BY data_referencia, doc_fundo, chave_ativo
HAVING COUNT(*) > 1

UNION ALL

-- 4. Meses com histórico insuficiente para roll rate 3m
SELECT
  'historico_insuficiente'::TEXT,
  MAX(data_referencia),
  doc_fundo,
  MAX(nome_fundo),
  COUNT(DISTINCT data_referencia)::TEXT,
  COUNT(DISTINCT data_referencia)::BIGINT,
  CASE COUNT(DISTINCT data_referencia)
    WHEN 1 THEN 'Apenas 1 mês disponível. Roll rate e média 3m não calculáveis.'
    WHEN 2 THEN '2 meses disponíveis. Média 3m usa apenas 1 par. Roll rate com 1 período.'
    ELSE CONCAT(COUNT(DISTINCT data_referencia), ' meses disponíveis.')
  END::TEXT
FROM vw_estoque_fidc_consolidado
GROUP BY doc_fundo
HAVING COUNT(DISTINCT data_referencia) < 3;

COMMENT ON VIEW vw_estoque_fidc_alertas_qualidade IS
  'Alertas de qualidade da base de estoque FIDC. '
  'Tipos: sem_chave_confiavel, sem_vencimento, duplicidade_chave_mes, '
  'historico_insuficiente. Usar para auditoria e documentação de limitações.';
