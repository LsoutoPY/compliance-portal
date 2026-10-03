-- Complementa a matriz de crédito com dados do fundo/classe e enquadramento.
-- Taxas de cessão são armazenadas em pontos percentuais (ex.: 0,1019 = 0,1019% a.m.).

-- Normaliza documentos para cruzar estoque FIDC, rentabilidade e enquadramento.
CREATE OR REPLACE FUNCTION public.credito_normalize_documento(p_documento text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(regexp_replace(COALESCE(p_documento, ''), '[^0-9]', '', 'g'), '');
$$;

-- Corrige a cobertura da média ponderada: títulos sem taxa não entram no denominador.
-- A anualização converte pontos percentuais para decimal antes da capitalização.
CREATE OR REPLACE VIEW public.vw_credito_safras_emissao_resumo AS
WITH base AS (
  SELECT
    b.doc_fundo,
    b.data_referencia,
    MAX(b.nome_fundo) AS nome_fundo,
    DATE_TRUNC('month', b.data_emissao)::date AS safra_emissao,
    TO_CHAR(b.data_emissao, 'YYYY-MM') AS safra_label,
    COUNT(DISTINCT b.chave_ativo) AS qtd_titulos,
    SUM(b.valor_nominal) AS vn_total,
    SUM(b.valor_base) AS vp_total,
    CASE WHEN SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END) > 0 THEN
      ROUND(
        SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.taxa_recebivel_efetiva * b.valor_base ELSE 0 END)
        / NULLIF(SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END), 0),
        8
      )
    ELSE NULL END AS taxa_media_cessao,
    ROUND(SUM(CASE WHEN b.dias_atraso > 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END)
      / NULLIF(SUM(b.valor_base), 0), 6) AS pct_vencido_cohort,
    ROUND(SUM(CASE WHEN b.is_writeoff THEN b.valor_base ELSE 0 END)
      / NULLIF(SUM(b.valor_base), 0), 6) AS pct_writeoff_cohort,
    SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END) AS vp_com_taxa
  FROM public.vw_credito_matriz_base b
  WHERE b.data_emissao IS NOT NULL
  GROUP BY b.doc_fundo, b.data_referencia, DATE_TRUNC('month', b.data_emissao)::date, TO_CHAR(b.data_emissao, 'YYYY-MM')
)
SELECT * FROM base;

CREATE OR REPLACE VIEW public.vw_credito_safras_emissao_metricas AS
WITH base AS (
  SELECT
    b.doc_fundo,
    b.data_referencia,
    MAX(b.nome_fundo) AS nome_fundo,
    COUNT(DISTINCT b.chave_ativo) AS qtd_titulos_total,
    SUM(b.valor_base) AS vp_total,
    CASE WHEN SUM(b.valor_base) > 0 THEN
      ROUND(SUM(COALESCE(b.prazo_atual, b.prazo, 0) * b.valor_base) / NULLIF(SUM(b.valor_base), 0), 1)
    ELSE NULL END AS prazo_medio_recebimento_dias,
    CASE WHEN SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END) > 0 THEN
      SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.taxa_recebivel_efetiva * b.valor_base ELSE 0 END)
      / NULLIF(SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END), 0)
    ELSE NULL END AS taxa_media_mensal_raw,
    SUM(CASE WHEN b.taxa_recebivel_efetiva IS NOT NULL THEN b.valor_base ELSE 0 END) AS vp_com_taxa
  FROM public.vw_credito_matriz_base b
  WHERE b.data_emissao IS NOT NULL
  GROUP BY b.doc_fundo, b.data_referencia
)
SELECT
  doc_fundo,
  data_referencia,
  nome_fundo,
  qtd_titulos_total,
  vp_total,
  prazo_medio_recebimento_dias,
  ROUND(taxa_media_mensal_raw, 8) AS taxa_media_mensal,
  CASE WHEN taxa_media_mensal_raw IS NOT NULL THEN
    ROUND((POWER(1.0 + taxa_media_mensal_raw / 100.0, 12) - 1.0) * 100.0, 8)
  ELSE NULL END AS taxa_media_anualizada,
  vp_com_taxa
FROM base;

CREATE OR REPLACE VIEW public.vw_credito_safras_emissao_serie AS
SELECT
  doc_fundo, data_referencia, nome_fundo, safra_emissao, safra_label,
  qtd_titulos, vn_total, vp_total, taxa_media_cessao,
  pct_vencido_cohort, pct_writeoff_cohort,
  CASE
    WHEN pct_vencido_cohort >= 0.10 THEN 'critico'
    WHEN pct_vencido_cohort >= 0.05 THEN 'atencao'
    ELSE 'ok'
  END AS status_cohort,
  vp_com_taxa
FROM public.vw_credito_safras_emissao_resumo;

-- Expõe o bucket acima de seis meses explicitamente; não o infere a partir do atraso.
CREATE OR REPLACE VIEW public.vw_credito_matriz_visao_geral AS
SELECT
  b.doc_fundo,
  b.data_referencia,
  MAX(b.nome_fundo) AS nome_fundo,
  SUM(b.valor_base) AS vp_total,
  SUM(b.valor_pdd_atual) AS pdd_total,
  SUM(CASE WHEN b.dias_atraso <= 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_a_vencer,
  COUNT(DISTINCT CASE WHEN b.dias_atraso <= 0 AND NOT b.is_writeoff THEN b.chave_ativo END) AS qtd_a_vencer,
  SUM(CASE WHEN b.dias_atraso > 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_vencido,
  COUNT(DISTINCT CASE WHEN b.dias_atraso > 0 AND NOT b.is_writeoff THEN b.chave_ativo END) AS qtd_vencido,
  SUM(CASE WHEN b.dias_atraso <= 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_comp_adimplente,
  SUM(CASE WHEN b.dias_atraso BETWEEN 1 AND 90 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_comp_vencido_ate_90,
  SUM(CASE WHEN b.dias_atraso BETWEEN 91 AND 180 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_comp_vencido_91_180,
  SUM(CASE WHEN b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_writeoff,
  COUNT(DISTINCT CASE WHEN b.is_writeoff THEN b.chave_ativo END) AS qtd_writeoff,
  SUM(CASE WHEN b.bucket_ordem >= 4 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) AS vp_over90,
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
  ROUND(SUM(CASE WHEN b.dias_atraso > 0 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) / NULLIF(SUM(b.valor_base), 0), 6) AS pct_vencido,
  ROUND(SUM(CASE WHEN b.bucket_ordem >= 4 AND NOT b.is_writeoff THEN b.valor_base ELSE 0 END) / NULLIF(SUM(b.valor_base), 0), 6) AS pct_over90,
  ROUND(SUM(b.valor_pdd_atual) / NULLIF(SUM(b.valor_base), 0), 6) AS pct_pdd_carteira,
  SUM(CASE WHEN b.dias_ate_vencimento > 180 THEN b.valor_base ELSE 0 END) AS vp_vence_acima_6_meses,
  COUNT(DISTINCT CASE WHEN b.dias_ate_vencimento > 180 THEN b.chave_ativo END) AS qtd_vence_acima_6_meses
FROM public.vw_credito_matriz_base b
WHERE NOT b.nao_classificavel
GROUP BY b.doc_fundo, b.data_referencia;

-- PL e rentabilidade consolidada das classes associadas ao fundo na mesma data-base.
CREATE OR REPLACE VIEW public.vw_credito_matriz_fundo_resumo AS
WITH credito AS (
  SELECT doc_fundo, data_referencia, MAX(nome_fundo) AS nome_fundo
  FROM public.vw_credito_matriz_visao_geral
  GROUP BY doc_fundo, data_referencia
), classes AS (
  SELECT
    public.credito_normalize_documento(r.fundo_cnpj) AS doc_fundo,
    r.data_posicao::date AS data_referencia,
    COUNT(*) AS qtd_classes,
    SUM(COALESCE(r.pl, 0)) AS pl_total,
    CASE WHEN COUNT(*) = 1 THEN MAX(r.retorno_dia_pct) END AS rentabilidade_dia_pct,
    CASE WHEN COUNT(*) = 1 THEN MAX(r.retorno_mes_pct) END AS rentabilidade_mes_pct,
    CASE WHEN COUNT(*) = 1 THEN MAX(r.retorno_ano_pct) END AS rentabilidade_ano_pct,
    CASE WHEN COUNT(*) = 1 THEN MAX(r.retorno_12m_pct) END AS rentabilidade_12m_pct
  FROM public.rentabilidade_snapshot_fundo r
  WHERE COALESCE(r.pl, 0) > 0
  GROUP BY public.credito_normalize_documento(r.fundo_cnpj), r.data_posicao
)
SELECT
  c.doc_fundo,
  c.data_referencia,
  c.nome_fundo,
  COALESCE(cl.qtd_classes, 0) AS qtd_classes,
  cl.pl_total,
  cl.rentabilidade_dia_pct,
  cl.rentabilidade_mes_pct,
  cl.rentabilidade_ano_pct,
  cl.rentabilidade_12m_pct
FROM credito c
LEFT JOIN classes cl
  ON cl.doc_fundo = public.credito_normalize_documento(c.doc_fundo)
 AND cl.data_referencia = c.data_referencia;

-- Concentração da carteira por cedente e sacado, com leitura também contra o PL.
CREATE OR REPLACE VIEW public.vw_credito_matriz_concentracao_parte AS
WITH partes AS (
  SELECT 'cedente'::text AS tipo_parte, b.doc_fundo, b.data_referencia, b.nome_fundo,
    b.doc_cedente AS doc_parte, b.nome_cedente AS nome_parte, b.valor_base
  FROM public.vw_credito_matriz_base b
  WHERE NOT b.nao_classificavel AND NULLIF(TRIM(b.doc_cedente), '') IS NOT NULL
  UNION ALL
  SELECT 'sacado'::text, b.doc_fundo, b.data_referencia, b.nome_fundo,
    b.doc_sacado, b.nome_sacado, b.valor_base
  FROM public.vw_credito_matriz_base b
  WHERE NOT b.nao_classificavel AND NULLIF(TRIM(b.doc_sacado), '') IS NOT NULL
), totais AS (
  SELECT doc_fundo, data_referencia, SUM(valor_base) AS vp_total
  FROM public.vw_credito_matriz_base
  WHERE NOT nao_classificavel
  GROUP BY doc_fundo, data_referencia
), agrupado AS (
  SELECT p.tipo_parte, p.doc_fundo, p.data_referencia, MAX(p.nome_fundo) AS nome_fundo,
    p.doc_parte, MAX(p.nome_parte) AS nome_parte, SUM(p.valor_base) AS vp_parte
  FROM partes p
  GROUP BY p.tipo_parte, p.doc_fundo, p.data_referencia, p.doc_parte
)
SELECT
  a.tipo_parte, a.doc_fundo, a.data_referencia, a.nome_fundo, a.doc_parte, a.nome_parte,
  a.vp_parte, t.vp_total,
  ROUND(a.vp_parte / NULLIF(t.vp_total, 0), 6) AS pct_carteira,
  ROUND(a.vp_parte / NULLIF(f.pl_total, 0), 6) AS pct_pl,
  RANK() OVER (PARTITION BY a.tipo_parte, a.doc_fundo, a.data_referencia ORDER BY a.vp_parte DESC) AS ranking
FROM agrupado a
JOIN totais t ON t.doc_fundo = a.doc_fundo AND t.data_referencia = a.data_referencia
LEFT JOIN public.vw_credito_matriz_fundo_resumo f
  ON f.doc_fundo = a.doc_fundo AND f.data_referencia = a.data_referencia;

-- Resultado oficial das regras de enquadramento calculadas para a data-base.
CREATE OR REPLACE VIEW public.vw_credito_matriz_enquadramento AS
SELECT
  public.credito_normalize_documento(e.fundo_cnpj) AS doc_fundo,
  to_date(e.fundo_dtposicao, 'YYYYMMDD')::text AS data_referencia,
  e.regra_categoria,
  e.regra_codigo,
  e.regra_descricao,
  e.status,
  e.valor_atual,
  e.valor_limite,
  e.detalhes,
  e.verificado_em
FROM public.enquadramento_resultado e
WHERE e.fundo_dtposicao ~ '^[0-9]{8}$';

GRANT SELECT ON public.vw_credito_matriz_fundo_resumo,
  public.vw_credito_matriz_concentracao_parte,
  public.vw_credito_matriz_enquadramento TO authenticated, service_role;

COMMENT ON VIEW public.vw_credito_matriz_fundo_resumo IS
  'PL total das classes do fundo e rentabilidade da cota somente quando há uma classe na seleção; nunca consolida retornos por PL.';
COMMENT ON VIEW public.vw_credito_matriz_concentracao_parte IS
  'Concentração de VP da carteira por cedente e sacado, com percentuais da carteira e do PL.';
