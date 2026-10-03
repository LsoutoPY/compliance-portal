-- Bugfixes: matriz de crédito (taxa, write-off, prazo, composição)
-- Aplicar após 20260813_credito_matriz_views.sql
--
-- Nota: não alteramos a assinatura de credito_is_writeoff(text) para evitar
-- DROP CASCADE nas views dependentes. Write-off por aging >180d é inline na base.

-- ============================================================
-- Write-off por situação (baixado/perda) — assinatura inalterada
-- ============================================================
CREATE OR REPLACE FUNCTION credito_is_writeoff(p_situacao TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_situacao IS NULL THEN FALSE
    ELSE LOWER(p_situacao) SIMILAR TO '%(baixad|perda|prejuizo|write.?off)%'
  END;
$$;

COMMENT ON FUNCTION credito_is_writeoff(TEXT) IS
  'Write-off por situacao_recebivel (baixado/perda/prejuizo). Aging >180d é tratado na view base.';

-- Recria base: is_writeoff = atraso > 180d OU situacao baixada/perda
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
  e.data_emissao,
  COALESCE(e.tx_recebivel, e.taxa_cessao) AS taxa_recebivel_efetiva,
  e.tx_recebivel,
  e.taxa_cessao,
  e.prazo_atual,
  e.prazo,
  credito_faixa_prazo_cumulativa(b.dias_atraso) AS faixa_prazo,
  credito_faixa_prazo_ordem(b.dias_atraso) AS faixa_prazo_ordem,
  (
    COALESCE(b.dias_atraso, 0) > 180
    OR credito_is_writeoff(b.situacao_recebivel)
  ) AS is_writeoff,
  (b.data_vencimento_base - b.data_referencia) AS dias_ate_vencimento,
  UPPER(TRIM(COALESCE(b.situacao_recebivel, ''))) AS situacao_norm
FROM vw_estoque_fidc_base b
JOIN estoque_fidc e ON e.id = b.id;

-- ============================================================
-- Visão Geral: buckets mutuamente exclusivos para composição
-- Adimplente | Vencido ≤90d | Vencido 91-180d | Write-off >180d
-- (DROP necessário: novas colunas vp_comp_* alteram ordem/nomes)
-- ============================================================
DROP VIEW IF EXISTS vw_credito_matriz_visao_geral;

CREATE VIEW vw_credito_matriz_visao_geral AS
SELECT
  b.doc_fundo,
  b.data_referencia,
  MAX(b.nome_fundo) AS nome_fundo,
  SUM(b.valor_base) AS vp_total,
  SUM(b.valor_pdd_atual) AS pdd_total,
  -- Adimplente (dias_atraso <= 0)
  SUM(CASE WHEN COALESCE(b.dias_atraso, 0) <= 0 THEN b.valor_base ELSE 0 END) AS vp_a_vencer,
  COUNT(DISTINCT CASE WHEN COALESCE(b.dias_atraso, 0) <= 0 THEN b.chave_ativo END) AS qtd_a_vencer,
  -- Vencido total (exclui write-off >180 para KPI legado)
  SUM(CASE WHEN b.dias_atraso > 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_vencido,
  COUNT(DISTINCT CASE WHEN b.dias_atraso > 0 AND NOT b.is_writeoff THEN b.chave_ativo END) AS qtd_vencido,
  -- Composição mutuamente exclusiva (soma = 100% do VP)
  SUM(CASE WHEN COALESCE(b.dias_atraso, 0) <= 0 THEN b.valor_base ELSE 0 END) AS vp_comp_adimplente,
  SUM(CASE WHEN b.dias_atraso BETWEEN 1 AND 90 THEN b.valor_base ELSE 0 END) AS vp_comp_vencido_ate_90,
  SUM(CASE WHEN b.dias_atraso BETWEEN 91 AND 180 THEN b.valor_base ELSE 0 END) AS vp_comp_vencido_91_180,
  SUM(CASE WHEN b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_writeoff,
  COUNT(DISTINCT CASE WHEN b.is_writeoff THEN b.chave_ativo END) AS qtd_writeoff,
  -- Over90 (informativo, não usar na barra empilhada)
  SUM(CASE WHEN COALESCE(b.dias_atraso, 0) > 90 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_over90,
  -- Projeção de vencimentos
  SUM(CASE WHEN b.dias_ate_vencimento BETWEEN 0 AND 7 THEN b.valor_base ELSE 0 END) AS vp_vence_esta_semana,
  SUM(CASE WHEN b.dias_ate_vencimento BETWEEN 8 AND 30 THEN b.valor_base ELSE 0 END) AS vp_vence_este_mes,
  SUM(CASE WHEN b.dias_ate_vencimento BETWEEN 31 AND 60 THEN b.valor_base ELSE 0 END) AS vp_vence_proximo_mes,
  SUM(CASE WHEN b.dias_ate_vencimento BETWEEN 61 AND 90 THEN b.valor_base ELSE 0 END) AS vp_vence_3_meses,
  SUM(CASE WHEN b.dias_ate_vencimento BETWEEN 91 AND 180 THEN b.valor_base ELSE 0 END) AS vp_vence_6_meses,
  COUNT(DISTINCT CASE WHEN b.dias_ate_vencimento BETWEEN 0 AND 7 THEN b.chave_ativo END) AS qtd_vence_esta_semana,
  COUNT(DISTINCT CASE WHEN b.dias_ate_vencimento BETWEEN 8 AND 30 THEN b.chave_ativo END) AS qtd_vence_este_mes,
  COUNT(DISTINCT CASE WHEN b.dias_ate_vencimento BETWEEN 31 AND 60 THEN b.chave_ativo END) AS qtd_vence_proximo_mes,
  COUNT(DISTINCT CASE WHEN b.dias_ate_vencimento BETWEEN 61 AND 90 THEN b.chave_ativo END) AS qtd_vence_3_meses,
  COUNT(DISTINCT CASE WHEN b.dias_ate_vencimento BETWEEN 91 AND 180 THEN b.chave_ativo END) AS qtd_vence_6_meses,
  ROUND(SUM(CASE WHEN b.dias_atraso > 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END)
    / NULLIF(SUM(b.valor_base), 0), 6) AS pct_vencido,
  ROUND(SUM(CASE WHEN COALESCE(b.dias_atraso, 0) > 90 THEN b.valor_base ELSE 0 END)
    / NULLIF(SUM(b.valor_base), 0), 6) AS pct_over90,
  ROUND(SUM(b.valor_pdd_atual) / NULLIF(SUM(b.valor_base), 0), 6) AS pct_pdd_carteira
FROM vw_credito_matriz_base b
WHERE NOT b.nao_classificavel
GROUP BY b.doc_fundo, b.data_referencia;

-- ============================================================
-- Safras métricas: prazo médio só A VENCER; taxa anualizada corrigida
-- (DROP necessário: remove coluna prazo_medio_pagamento_dias)
-- ============================================================
DROP VIEW IF EXISTS vw_credito_safras_emissao_metricas;

CREATE VIEW vw_credito_safras_emissao_metricas AS
SELECT
  b.doc_fundo,
  b.data_referencia,
  MAX(b.nome_fundo) AS nome_fundo,
  COUNT(DISTINCT b.chave_ativo) AS qtd_titulos_total,
  SUM(b.valor_base) AS vp_total,
  -- Prazo médio de recebimento: só títulos A VENCER, dias até vencimento ponderado por VP
  CASE WHEN SUM(CASE WHEN b.situacao_norm = 'A VENCER' THEN b.valor_base ELSE 0 END) > 0 THEN
    ROUND(
      SUM(CASE WHEN b.situacao_norm = 'A VENCER'
            THEN GREATEST(b.dias_ate_vencimento, 0) * b.valor_base ELSE 0 END)
      / NULLIF(SUM(CASE WHEN b.situacao_norm = 'A VENCER' THEN b.valor_base ELSE 0 END), 0),
    1)
  ELSE NULL END AS prazo_medio_recebimento_dias,
  -- Taxa média mensal (pontos percentuais, ex.: 0,2442 = 0,2442% a.m.)
  CASE WHEN SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END) > 0 THEN
    ROUND(
      SUM(COALESCE(b.taxa_recebivel_efetiva, 0) * b.valor_base)
      / NULLIF(SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END), 0),
      8
    )
  ELSE NULL END AS taxa_media_mensal,
  -- Taxa anualizada composta em pontos percentuais (ex.: 2,97 = 2,97% a.a.)
  CASE
    WHEN SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END) > 0
    THEN ROUND(
      (POWER(
        1.0 + (
          SUM(COALESCE(b.taxa_recebivel_efetiva, 0) * b.valor_base)
          / NULLIF(SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END), 0)
        ) / 100.0,
        12
      ) - 1.0) * 100.0,
      8
    )
    ELSE NULL
  END AS taxa_media_anualizada
FROM vw_credito_matriz_base b
WHERE b.data_emissao IS NOT NULL
GROUP BY b.doc_fundo, b.data_referencia;

COMMENT ON VIEW vw_credito_safras_emissao_metricas IS
  'Cards Safra: prazo médio (A VENCER), taxa mensal/anualizada em pontos percentuais.';
