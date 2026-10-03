-- Migration: Matriz Unificada de Monitoramento de Crédito
-- Views e funções auxiliares para a tela CreditoMatriz.tsx
-- Depende de: vw_estoque_fidc_base (20260808_credito_metricas_unificadas.sql)

-- ============================================================
-- Funções auxiliares
-- ============================================================

-- Classifica atraso em faixas cumulativas de 10 buckets (para tabela matriz)
CREATE OR REPLACE FUNCTION credito_faixa_prazo_cumulativa(p_dias_atraso INTEGER)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_dias_atraso IS NULL THEN NULL
    WHEN p_dias_atraso <= 0   THEN 'Adimplente'
    WHEN p_dias_atraso <= 30  THEN 'Até 30 dias'
    WHEN p_dias_atraso <= 60  THEN 'Até 60 dias'
    WHEN p_dias_atraso <= 90  THEN 'Até 90 dias'
    WHEN p_dias_atraso <= 120 THEN 'Até 120 dias'
    WHEN p_dias_atraso <= 150 THEN 'Até 150 dias'
    WHEN p_dias_atraso <= 180 THEN 'Até 180 dias'
    WHEN p_dias_atraso <= 360 THEN 'Até 360 dias'
    WHEN p_dias_atraso <= 720 THEN 'Até 720 dias'
    WHEN p_dias_atraso <= 1080 THEN 'Até 1080 dias'
    ELSE 'Acima de 1080 dias'
  END;
$$;

-- Ordem da faixa para ordenação (0 = Adimplente)
CREATE OR REPLACE FUNCTION credito_faixa_prazo_ordem(p_dias_atraso INTEGER)
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_dias_atraso IS NULL THEN -1
    WHEN p_dias_atraso <= 0   THEN 0
    WHEN p_dias_atraso <= 30  THEN 1
    WHEN p_dias_atraso <= 60  THEN 2
    WHEN p_dias_atraso <= 90  THEN 3
    WHEN p_dias_atraso <= 120 THEN 4
    WHEN p_dias_atraso <= 150 THEN 5
    WHEN p_dias_atraso <= 180 THEN 6
    WHEN p_dias_atraso <= 360 THEN 7
    WHEN p_dias_atraso <= 720 THEN 8
    WHEN p_dias_atraso <= 1080 THEN 9
    ELSE 10
  END;
$$;

-- Classifica dias até vencimento em faixas de projeção (itens a vencer)
-- p_dias_ate_vencimento = data_vencimento_base - data_referencia (positivo = futuro)
CREATE OR REPLACE FUNCTION credito_faixa_vencimento(p_dias_ate_vencimento INTEGER)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_dias_ate_vencimento IS NULL THEN NULL
    WHEN p_dias_ate_vencimento < 0    THEN NULL  -- já vencido, não é projeção
    WHEN p_dias_ate_vencimento <= 7   THEN 'Esta semana'
    WHEN p_dias_ate_vencimento <= 30  THEN 'Este mês'
    WHEN p_dias_ate_vencimento <= 60  THEN 'Próximo mês'
    WHEN p_dias_ate_vencimento <= 90  THEN 'Até 3 meses'
    WHEN p_dias_ate_vencimento <= 180 THEN 'Até 6 meses'
    ELSE 'Acima de 6 meses'
  END;
$$;

CREATE OR REPLACE FUNCTION credito_faixa_vencimento_ordem(p_dias_ate_vencimento INTEGER)
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_dias_ate_vencimento IS NULL OR p_dias_ate_vencimento < 0 THEN -1
    WHEN p_dias_ate_vencimento <= 7   THEN 0
    WHEN p_dias_ate_vencimento <= 30  THEN 1
    WHEN p_dias_ate_vencimento <= 60  THEN 2
    WHEN p_dias_ate_vencimento <= 90  THEN 3
    WHEN p_dias_ate_vencimento <= 180 THEN 4
    ELSE 5
  END;
$$;

-- Detecta write-off baseado em situacao_recebivel
-- Critérios: baixado/perda/prejuizo (mais restritivo que BAD_SITUATIONS frontend)
-- Nota: não usa unaccent() para evitar dependência da extensão.
-- Os termos de write-off não têm acentos relevantes.
CREATE OR REPLACE FUNCTION credito_is_writeoff(p_situacao TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_situacao IS NULL THEN FALSE
    ELSE (
      LOWER(p_situacao) SIMILAR TO '%(baixad|perda|prejuizo|write.?off)%'
    )
  END;
$$;

COMMENT ON FUNCTION credito_faixa_prazo_cumulativa IS
  'Faixa de atraso em 11 buckets cumulativos para a tabela Matriz (Atraso & PDD).';
COMMENT ON FUNCTION credito_faixa_prazo_ordem IS
  'Ordem 0-10 da faixa cumulativa (-1 para nao_classificavel).';
COMMENT ON FUNCTION credito_faixa_vencimento IS
  'Faixa de projeção de vencimento (Esta semana → Acima de 6 meses).';
COMMENT ON FUNCTION credito_is_writeoff IS
  'TRUE se situacao_recebivel indica write-off (baixado/perda/prejuizo).';

-- ============================================================
-- Base estendida com campos extras para as views matriz
-- Inclui: data_emissao, tx_recebivel, taxa_cessao, prazo_atual, prazo
-- e as novas colunas calculadas (faixa_prazo, is_writeoff)
-- ============================================================
CREATE OR REPLACE VIEW vw_credito_matriz_base AS
SELECT
  b.id,
  b.import_id,
  b.data_referencia,
  b.doc_fundo,
  b.nome_fundo,
  b.doc_cedente,
  b.nome_cedente,
  b.doc_sacado,
  b.nome_sacado,
  b.tipo_recebivel,
  b.data_aquisicao,
  b.data_vencimento_base,
  b.chave_ativo,
  b.valor_base,
  b.valor_pdd_atual,
  b.dias_atraso,
  b.bucket_canonico,
  b.bucket_ordem,
  b.situacao_recebivel,
  b.valor_nominal,
  b.valor_presente,
  b.nao_classificavel,
  -- campos extras do estoque_fidc
  e.data_emissao,
  COALESCE(e.tx_recebivel, e.taxa_cessao) AS taxa_recebivel_efetiva,
  e.tx_recebivel,
  e.taxa_cessao,
  e.prazo_atual,
  e.prazo,
  -- colunas calculadas adicionais
  credito_faixa_prazo_cumulativa(b.dias_atraso) AS faixa_prazo,
  credito_faixa_prazo_ordem(b.dias_atraso) AS faixa_prazo_ordem,
  credito_is_writeoff(b.situacao_recebivel) AS is_writeoff,
  -- dias até vencimento (positivo = a vencer, negativo = vencido)
  (b.data_vencimento_base - b.data_referencia) AS dias_ate_vencimento
FROM vw_estoque_fidc_base b
JOIN estoque_fidc e ON e.id = b.id;

COMMENT ON VIEW vw_credito_matriz_base IS
  'Base estendida de estoque_fidc com campos de emissão, taxas e classificações da matriz.';

-- ============================================================
-- View: Tabela Atraso & PDD — faixas cumulativas
-- Colunas: VP Adimplente / VP Inadimplente / VP PDD por faixa
-- ============================================================
CREATE OR REPLACE VIEW vw_credito_matriz_prazo AS
WITH totais AS (
  SELECT
    doc_fundo,
    data_referencia,
    SUM(valor_base) AS vp_total,
    SUM(valor_pdd_atual) AS pdd_total,
    COUNT(DISTINCT CASE WHEN NOT is_writeoff THEN chave_ativo END) AS qtd_total
  FROM vw_credito_matriz_base
  WHERE NOT nao_classificavel
  GROUP BY doc_fundo, data_referencia
)
SELECT
  b.doc_fundo,
  b.data_referencia,
  MAX(b.nome_fundo) AS nome_fundo,
  b.faixa_prazo,
  b.faixa_prazo_ordem,
  -- VP Adimplente (dias_atraso <= 0 e não write-off)
  SUM(CASE WHEN b.faixa_prazo_ordem = 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_adimplente,
  COUNT(DISTINCT CASE WHEN b.faixa_prazo_ordem = 0 AND NOT b.is_writeoff THEN b.chave_ativo END) AS qtd_adimplente,
  -- VP Inadimplente (dias_atraso > 0 e não write-off)
  SUM(CASE WHEN b.faixa_prazo_ordem > 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_inadimplente,
  COUNT(DISTINCT CASE WHEN b.faixa_prazo_ordem > 0 AND NOT b.is_writeoff THEN b.chave_ativo END) AS qtd_inadimplente,
  -- VP PDD (todos com PDD > 0)
  SUM(b.valor_pdd_atual) AS vp_pdd,
  -- VP Write-off
  SUM(CASE WHEN b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_writeoff,
  COUNT(DISTINCT CASE WHEN b.is_writeoff THEN b.chave_ativo END) AS qtd_writeoff,
  -- Totais do fundo para cálculo de %
  t.vp_total,
  t.pdd_total,
  t.qtd_total,
  -- Percentuais
  ROUND(SUM(CASE WHEN b.faixa_prazo_ordem = 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END)
    / NULLIF(t.vp_total, 0), 6) AS pct_adimplente,
  ROUND(SUM(CASE WHEN b.faixa_prazo_ordem > 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END)
    / NULLIF(t.vp_total, 0), 6) AS pct_inadimplente,
  ROUND(SUM(b.valor_pdd_atual) / NULLIF(t.vp_total, 0), 6) AS pct_pdd
FROM vw_credito_matriz_base b
JOIN totais t ON t.doc_fundo = b.doc_fundo AND t.data_referencia = b.data_referencia
WHERE b.faixa_prazo IS NOT NULL
GROUP BY b.doc_fundo, b.data_referencia, b.faixa_prazo, b.faixa_prazo_ordem,
  t.vp_total, t.pdd_total, t.qtd_total;

COMMENT ON VIEW vw_credito_matriz_prazo IS
  'Tabela Atraso & PDD: VP Adimplente/Inadimplente/PDD por faixa cumulativa de prazo.';

-- ============================================================
-- View: Cobertura de PDD por faixa (painel Gráfico/Tabela)
-- ============================================================
CREATE OR REPLACE VIEW vw_credito_matriz_cobertura_pdd AS
SELECT
  doc_fundo,
  data_referencia,
  MAX(nome_fundo) AS nome_fundo,
  faixa_prazo,
  faixa_prazo_ordem,
  SUM(valor_base) AS vp_total_faixa,
  SUM(valor_pdd_atual) AS vp_pdd_faixa,
  ROUND(SUM(valor_pdd_atual) / NULLIF(SUM(valor_base), 0), 6) AS cobertura_pdd
FROM vw_credito_matriz_base
WHERE faixa_prazo IS NOT NULL AND NOT nao_classificavel
GROUP BY doc_fundo, data_referencia, faixa_prazo, faixa_prazo_ordem;

COMMENT ON VIEW vw_credito_matriz_cobertura_pdd IS
  'Cobertura PDD (PDD/VP) por faixa cumulativa — base do painel Gráfico/Tabela na aba Atraso & PDD.';

-- ============================================================
-- View: Visão Geral — KPIs consolidados + projeção de vencimentos
-- ============================================================
CREATE OR REPLACE VIEW vw_credito_matriz_visao_geral AS
SELECT
  b.doc_fundo,
  b.data_referencia,
  MAX(b.nome_fundo) AS nome_fundo,
  -- VP total
  SUM(b.valor_base) AS vp_total,
  SUM(b.valor_pdd_atual) AS pdd_total,
  -- Adimplentes
  SUM(CASE WHEN b.dias_atraso <= 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_a_vencer,
  COUNT(DISTINCT CASE WHEN b.dias_atraso <= 0 AND NOT b.is_writeoff THEN b.chave_ativo END) AS qtd_a_vencer,
  -- Vencidos (atraso > 0, não write-off)
  SUM(CASE WHEN b.dias_atraso > 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_vencido,
  COUNT(DISTINCT CASE WHEN b.dias_atraso > 0 AND NOT b.is_writeoff THEN b.chave_ativo END) AS qtd_vencido,
  -- Write-off
  SUM(CASE WHEN b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_writeoff,
  COUNT(DISTINCT CASE WHEN b.is_writeoff THEN b.chave_ativo END) AS qtd_writeoff,
  -- Over90 (bucket_ordem >= 4)
  SUM(CASE WHEN b.bucket_ordem >= 4 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_over90,
  -- Projeção de vencimentos (itens a vencer, agrupados por faixa futura)
  SUM(CASE WHEN b.dias_ate_vencimento BETWEEN 0 AND 7 THEN b.valor_base ELSE 0 END) AS vp_vence_esta_semana,
  SUM(CASE WHEN b.dias_ate_vencimento BETWEEN 8 AND 30 THEN b.valor_base ELSE 0 END) AS vp_vence_este_mes,
  SUM(CASE WHEN b.dias_ate_vencimento BETWEEN 31 AND 60 THEN b.valor_base ELSE 0 END) AS vp_vence_proximo_mes,
  SUM(CASE WHEN b.dias_ate_vencimento BETWEEN 61 AND 90 THEN b.valor_base ELSE 0 END) AS vp_vence_3_meses,
  SUM(CASE WHEN b.dias_ate_vencimento BETWEEN 91 AND 180 THEN b.valor_base ELSE 0 END) AS vp_vence_6_meses,
  -- Totais de qtd por projeção
  COUNT(DISTINCT CASE WHEN b.dias_ate_vencimento BETWEEN 0 AND 7 THEN b.chave_ativo END) AS qtd_vence_esta_semana,
  COUNT(DISTINCT CASE WHEN b.dias_ate_vencimento BETWEEN 8 AND 30 THEN b.chave_ativo END) AS qtd_vence_este_mes,
  COUNT(DISTINCT CASE WHEN b.dias_ate_vencimento BETWEEN 31 AND 60 THEN b.chave_ativo END) AS qtd_vence_proximo_mes,
  COUNT(DISTINCT CASE WHEN b.dias_ate_vencimento BETWEEN 61 AND 90 THEN b.chave_ativo END) AS qtd_vence_3_meses,
  COUNT(DISTINCT CASE WHEN b.dias_ate_vencimento BETWEEN 91 AND 180 THEN b.chave_ativo END) AS qtd_vence_6_meses,
  -- Percentuais
  ROUND(SUM(CASE WHEN b.dias_atraso > 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END)
    / NULLIF(SUM(b.valor_base), 0), 6) AS pct_vencido,
  ROUND(SUM(CASE WHEN b.bucket_ordem >= 4 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END)
    / NULLIF(SUM(b.valor_base), 0), 6) AS pct_over90,
  ROUND(SUM(b.valor_pdd_atual) / NULLIF(SUM(b.valor_base), 0), 6) AS pct_pdd_carteira
FROM vw_credito_matriz_base b
WHERE NOT b.nao_classificavel
GROUP BY b.doc_fundo, b.data_referencia;

COMMENT ON VIEW vw_credito_matriz_visao_geral IS
  'KPIs da aba Visão Geral: VP total, adimplente, vencido, PDD, write-off e projeção de vencimentos.';

-- ============================================================
-- View: Concentração de VP por cedente (top N)
-- ============================================================
CREATE OR REPLACE VIEW vw_credito_concentracao_cedente AS
WITH totais AS (
  SELECT doc_fundo, data_referencia, SUM(valor_base) AS vp_total
  FROM vw_credito_matriz_base
  WHERE NOT nao_classificavel
  GROUP BY doc_fundo, data_referencia
)
SELECT
  b.doc_fundo,
  b.data_referencia,
  MAX(b.nome_fundo) AS nome_fundo,
  b.doc_cedente,
  MAX(b.nome_cedente) AS nome_cedente,
  SUM(b.valor_base) AS vp_cedente,
  t.vp_total,
  ROUND(SUM(b.valor_base) / NULLIF(t.vp_total, 0), 6) AS pct_vp_total,
  RANK() OVER (
    PARTITION BY b.doc_fundo, b.data_referencia
    ORDER BY SUM(b.valor_base) DESC
  ) AS ranking
FROM vw_credito_matriz_base b
JOIN totais t ON t.doc_fundo = b.doc_fundo AND t.data_referencia = b.data_referencia
WHERE b.doc_cedente IS NOT NULL AND TRIM(b.doc_cedente) <> '' AND NOT b.nao_classificavel
GROUP BY b.doc_fundo, b.data_referencia, b.doc_cedente, t.vp_total;

COMMENT ON VIEW vw_credito_concentracao_cedente IS
  'Concentração de VP por cedente com ranking e % do total — aba Visão Geral (top 5).';

-- ============================================================
-- View: Safras por DATA_EMISSAO — resumo por cohort
-- ============================================================
CREATE OR REPLACE VIEW vw_credito_safras_emissao_resumo AS
WITH base AS (
  SELECT
    b.doc_fundo,
    b.data_referencia,
    MAX(b.nome_fundo) AS nome_fundo,
    DATE_TRUNC('month', b.data_emissao)::DATE AS safra_emissao,
    TO_CHAR(b.data_emissao, 'YYYY-MM') AS safra_label,
    COUNT(DISTINCT b.chave_ativo) AS qtd_titulos,
    SUM(b.valor_nominal) AS vn_total,
    SUM(b.valor_base) AS vp_total,
    -- taxa média de cessão ponderada por VP
    CASE WHEN SUM(b.valor_base) > 0 THEN
      ROUND(SUM(COALESCE(b.taxa_recebivel_efetiva, 0) * b.valor_base) / NULLIF(SUM(b.valor_base), 0), 8)
    ELSE NULL END AS taxa_media_cessao,
    -- % vencidos no cohort (por situacao_recebivel)
    ROUND(
      SUM(CASE WHEN b.dias_atraso > 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END)
      / NULLIF(SUM(b.valor_base), 0), 6
    ) AS pct_vencido_cohort,
    -- write-off no cohort
    ROUND(
      SUM(CASE WHEN b.is_writeoff THEN b.valor_base ELSE 0 END)
      / NULLIF(SUM(b.valor_base), 0), 6
    ) AS pct_writeoff_cohort
  FROM vw_credito_matriz_base b
  WHERE b.data_emissao IS NOT NULL
  GROUP BY b.doc_fundo, b.data_referencia, DATE_TRUNC('month', b.data_emissao)::DATE, TO_CHAR(b.data_emissao, 'YYYY-MM')
)
SELECT * FROM base;

COMMENT ON VIEW vw_credito_safras_emissao_resumo IS
  'Cohort por mês de emissão (DATA_EMISSAO): qtd, VN, VP, taxa média, % vencido.';

-- ============================================================
-- View: Safras por DATA_EMISSAO — métricas de prazo/taxa (cards)
-- ============================================================
CREATE OR REPLACE VIEW vw_credito_safras_emissao_metricas AS
SELECT
  b.doc_fundo,
  b.data_referencia,
  MAX(b.nome_fundo) AS nome_fundo,
  COUNT(DISTINCT b.chave_ativo) AS qtd_titulos_total,
  SUM(b.valor_base) AS vp_total,
  -- Prazo médio ponderado de recebimento (prazo_atual em dias, ponderado por VP)
  CASE WHEN SUM(b.valor_base) > 0 THEN
    ROUND(SUM(COALESCE(b.prazo_atual, b.prazo, 0) * b.valor_base) / NULLIF(SUM(b.valor_base), 0), 1)
  ELSE NULL END AS prazo_medio_recebimento_dias,
  -- Prazo médio original (prazo, ponderado por VP)
  CASE WHEN SUM(b.valor_base) > 0 THEN
    ROUND(SUM(COALESCE(b.prazo, 0) * b.valor_base) / NULLIF(SUM(b.valor_base), 0), 1)
  ELSE NULL END AS prazo_medio_pagamento_dias,
  -- Taxa média de cessão ponderada por VP
  CASE WHEN SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END) > 0 THEN
    ROUND(
      SUM(COALESCE(b.taxa_recebivel_efetiva, 0) * b.valor_base)
      / NULLIF(SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END), 0),
      8
    )
  ELSE NULL END AS taxa_media_mensal,
  -- Taxa anualizada: ((1 + taxa_media_mensal)^12 - 1), apenas quando taxa é mensal
  CASE
    WHEN SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END) > 0
    AND  SUM(COALESCE(b.taxa_recebivel_efetiva, 0) * b.valor_base)
           / NULLIF(SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END), 0) > 0
    THEN ROUND(
      POWER(1.0 + (SUM(COALESCE(b.taxa_recebivel_efetiva, 0) * b.valor_base)
                   / NULLIF(SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END), 0)), 12)
      - 1.0, 8
    )
    ELSE NULL
  END AS taxa_media_anualizada
FROM vw_credito_matriz_base b
WHERE b.data_emissao IS NOT NULL
GROUP BY b.doc_fundo, b.data_referencia;

COMMENT ON VIEW vw_credito_safras_emissao_metricas IS
  'Cards da aba Safra: prazo médio de recebimento e pagamento, taxa média mensal e anualizada.';

-- ============================================================
-- View de leitura da série por safra para o LineChart de taxa
-- ============================================================
CREATE OR REPLACE VIEW vw_credito_safras_emissao_serie AS
SELECT
  doc_fundo,
  data_referencia,
  nome_fundo,
  safra_emissao,
  safra_label,
  qtd_titulos,
  vn_total,
  vp_total,
  taxa_media_cessao,
  pct_vencido_cohort,
  pct_writeoff_cohort,
  CASE
    WHEN pct_vencido_cohort >= 0.10 THEN 'critico'
    WHEN pct_vencido_cohort >= 0.05 THEN 'atencao'
    ELSE 'ok'
  END AS status_cohort
FROM vw_credito_safras_emissao_resumo;

COMMENT ON VIEW vw_credito_safras_emissao_serie IS
  'Série de safras por emissão com status para a tabela vintage.';
