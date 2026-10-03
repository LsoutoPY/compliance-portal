-- Reparo: recria vw_fundos_com_receita (dedup + gross-up + dados operacionais)
-- e restaura arquitetura de cache (live + wrapper) quando 20260817 já foi aplicado.
--
-- Use ESTE script no SQL Editor se 20260727/20260729 falharem com:
--   "cannot drop view vw_fundos_com_receita because vw_conferencia_taxas_mes_live depends on it"
--
-- Não reexecute 20260727 ou 20260729 isoladamente após 20260817.

-- ── 1. Drop na ordem correta de dependências ─────────────────────────────────

DROP VIEW IF EXISTS public.vw_conferencia_taxas_mes;
DROP VIEW IF EXISTS public.vw_conferencia_taxas_mes_live;
DROP VIEW IF EXISTS public.vw_pl_por_instituicao;
DROP VIEW IF EXISTS public.vw_fundos_com_receita;

-- ── 2. vw_fundos_com_receita (20260729) ──────────────────────────────────────

CREATE OR REPLACE VIEW public.vw_fundos_com_receita AS
WITH fc_por_cnpj AS (
  SELECT DISTINCT ON (cnpj_classe)
    cnpj_classe,
    nome_comercial,
    administrador,
    gestor_principal,
    codigo_anbima,
    categoria_anbima,
    tipo_anbima
  FROM public.fundos_caracteristicas
  WHERE cnpj_classe IS NOT NULL AND cnpj_classe <> ''
  ORDER BY
    cnpj_classe,
    CASE coalesce(estrutura, '')
      WHEN 'Classe' THEN 1
      WHEN 'Fundo' THEN 2
      WHEN 'Subclasse' THEN 3
      ELSE 4
    END,
    codigo_anbima NULLS LAST
),
ultima_pos AS (
  SELECT DISTINCT ON (fundo_cnpj)
    fundo_cnpj, fundo_patliq, nome_fundo, fundo_nomeadm, fundo_cnpjadm,
    fundo_nomegestor, fundo_cnpjgestor, fundo_dtposicao
  FROM public.posicao_carteira
  WHERE section = 'caixa' AND fundo_patliq IS NOT NULL AND fundo_patliq > 0
  ORDER BY fundo_cnpj, fundo_dtposicao DESC
),
gestor_atual AS (
  SELECT DISTINCT ON (fundo_cnpj) fundo_cnpj, fundo_cnpjgestor, fundo_nomegestor
  FROM public.posicao_carteira
  WHERE fundo_cnpjgestor IS NOT NULL AND fundo_cnpjgestor <> ''
  ORDER BY fundo_cnpj, fundo_dtposicao DESC
),
passivo_latest AS (
  SELECT DISTINCT ON (fundo_cnpj) fundo_cnpj, data_posicao
  FROM public.passivo_fundos
  WHERE fundo_cnpj IS NOT NULL AND fundo_cnpj <> ''
  ORDER BY fundo_cnpj, data_posicao DESC
),
cotistas_passivo AS (
  SELECT p.fundo_cnpj,
         count(DISTINCT p.cotista)::integer AS qtd_cotistas_passivo,
         max(p.data_posicao) AS data_passivo_atual
  FROM public.passivo_fundos p
  INNER JOIN passivo_latest pl ON pl.fundo_cnpj = p.fundo_cnpj AND pl.data_posicao = p.data_posicao
  GROUP BY p.fundo_cnpj
),
pl_dez_pos AS (
  SELECT DISTINCT ON (fundo_cnpj) fundo_cnpj, fundo_patliq AS pl_dez_posicao, fundo_dtposicao AS data_pl_dez
  FROM public.posicao_carteira
  WHERE section = 'caixa' AND fundo_patliq IS NOT NULL AND fundo_patliq > 0
    AND substring(fundo_dtposicao, 5, 2) = '12'
  ORDER BY fundo_cnpj, fundo_dtposicao DESC
)
SELECT
  ft.id, ft.fundo_cnpj, ft.codigo, ft.responsabilidade, ft.tipo_fundo, ft.exercicio_social,
  ft.pl_dez, ft.pl_jan, ft.qtd_cotistas, ft.forma_condominio, ft.publico_alvo,
  ft.tg_percentual, ft.tg_minimo_mensal, ft.tg_fixo_mensal,
  ft.ta_percentual, ft.ta_minimo_mensal, ft.ta_fixo_mensal,
  ft.tc_percentual, ft.tc_minimo_mensal, ft.tc_fixo_mensal,
  ft.tcons_percentual, ft.tcons_minimo_mensal, ft.tcons_fixo_mensal,
  ft.gross_up_ativo,
  ft.ta_gross_up_pis, ft.ta_gross_up_cofins, ft.ta_gross_up_iss,
  ft.tg_gross_up_pis, ft.tg_gross_up_cofins, ft.tg_gross_up_iss,
  ft.tc_gross_up_pis, ft.tc_gross_up_cofins, ft.tc_gross_up_iss,
  ft.tcons_gross_up_pis, ft.tcons_gross_up_cofins, ft.tcons_gross_up_iss,
  ft.segmento, ft.ativo, ft.created_at, ft.updated_at,
  coalesce(up.fundo_patliq, ft.pl_jan) AS pl_atual,
  up.fundo_dtposicao AS data_posicao_atual,
  pd.pl_dez_posicao, pd.data_pl_dez,
  cp.qtd_cotistas_passivo, cp.data_passivo_atual,
  coalesce(up.nome_fundo, fc.nome_comercial, ft.fundo_cnpj) AS denominacao_social,
  coalesce(up.fundo_nomeadm, fc.administrador) AS administrador,
  coalesce(up.fundo_cnpjadm, ''::text) AS cnpj_administrador,
  coalesce(up.fundo_nomegestor, ga.fundo_nomegestor, fc.gestor_principal) AS gestor,
  coalesce(ga.fundo_cnpjgestor, up.fundo_cnpjgestor, ''::text) AS cnpj_gestor,
  fc.codigo_anbima, fc.categoria_anbima, fc.tipo_anbima AS classificacao_anbima,
  CASE
    WHEN ft.tg_minimo_mensal IS NULL OR ft.tg_minimo_mensal = 0 THEN ft.tg_percentual
    WHEN (ft.tg_percentual * coalesce(up.fundo_patliq, ft.pl_jan) / 12) > ft.tg_minimo_mensal THEN ft.tg_percentual
    ELSE (ft.tg_minimo_mensal * 12 / nullif(coalesce(up.fundo_patliq, ft.pl_jan), 0))
  END AS tg_efetiva,
  CASE
    WHEN ft.segmento = 'prospeccao' THEN NULL
    WHEN coalesce(ft.tg_fixo_mensal, 0) > 0 THEN ft.tg_fixo_mensal
    WHEN ft.tg_percentual = 0 AND (ft.tg_minimo_mensal IS NULL OR ft.tg_minimo_mensal = 0) THEN NULL
    WHEN coalesce(up.fundo_patliq, ft.pl_jan) = 0 THEN NULL
    ELSE greatest(ft.tg_percentual * coalesce(up.fundo_patliq, ft.pl_jan) / 12, coalesce(ft.tg_minimo_mensal, 0))
  END AS receita_mensal,
  CASE
    WHEN coalesce(ft.ta_fixo_mensal, 0) > 0 THEN ft.ta_fixo_mensal
    WHEN (ft.ta_percentual = 0 OR ft.ta_percentual IS NULL)
      AND (ft.ta_minimo_mensal IS NULL OR ft.ta_minimo_mensal = 0) THEN NULL
    WHEN coalesce(up.fundo_patliq, ft.pl_jan) = 0 THEN NULL
    ELSE greatest(coalesce(ft.ta_percentual, 0) * coalesce(up.fundo_patliq, ft.pl_jan) / 12, coalesce(ft.ta_minimo_mensal, 0))
  END AS ta_receita_mensal,
  CASE
    WHEN coalesce(ft.tc_fixo_mensal, 0) > 0 THEN ft.tc_fixo_mensal
    WHEN (ft.tc_percentual = 0 OR ft.tc_percentual IS NULL)
      AND (ft.tc_minimo_mensal IS NULL OR ft.tc_minimo_mensal = 0) THEN NULL
    WHEN coalesce(up.fundo_patliq, ft.pl_jan) = 0 THEN NULL
    ELSE greatest(coalesce(ft.tc_percentual, 0) * coalesce(up.fundo_patliq, ft.pl_jan) / 12, coalesce(ft.tc_minimo_mensal, 0))
  END AS tc_receita_mensal,
  CASE
    WHEN coalesce(ft.tcons_fixo_mensal, 0) > 0 THEN ft.tcons_fixo_mensal
    WHEN (ft.tcons_percentual = 0 OR ft.tcons_percentual IS NULL)
      AND (ft.tcons_minimo_mensal IS NULL OR ft.tcons_minimo_mensal = 0) THEN NULL
    WHEN coalesce(up.fundo_patliq, ft.pl_jan) = 0 THEN NULL
    ELSE greatest(coalesce(ft.tcons_percentual, 0) * coalesce(up.fundo_patliq, ft.pl_jan) / 12, coalesce(ft.tcons_minimo_mensal, 0))
  END AS tcons_receita_mensal,
  CASE
    WHEN ft.tg_minimo_mensal IS NOT NULL AND ft.tg_minimo_mensal > 0
      AND coalesce(up.fundo_patliq, ft.pl_jan) > 0
      AND coalesce(ft.tg_fixo_mensal, 0) = 0
      AND (ft.tg_percentual * coalesce(up.fundo_patliq, ft.pl_jan) / 12) < ft.tg_minimo_mensal
    THEN true ELSE false
  END AS no_minimo
FROM public.fundos_taxas ft
LEFT JOIN fc_por_cnpj fc ON fc.cnpj_classe = ft.fundo_cnpj
LEFT JOIN ultima_pos up ON up.fundo_cnpj = ft.fundo_cnpj
LEFT JOIN gestor_atual ga ON ga.fundo_cnpj = ft.fundo_cnpj
LEFT JOIN cotistas_passivo cp ON cp.fundo_cnpj = ft.fundo_cnpj
LEFT JOIN pl_dez_pos pd ON pd.fundo_cnpj = ft.fundo_cnpj
WHERE ft.ativo = true;

GRANT SELECT ON public.vw_fundos_com_receita TO anon, authenticated, service_role;

-- ── 3. vw_pl_por_instituicao (20260727) ──────────────────────────────────────

CREATE OR REPLACE VIEW public.vw_pl_por_instituicao AS
WITH fc_por_cnpj AS (
  SELECT DISTINCT ON (cnpj_classe)
    cnpj_classe,
    administrador
  FROM public.fundos_caracteristicas
  WHERE cnpj_classe IS NOT NULL AND cnpj_classe <> ''
  ORDER BY
    cnpj_classe,
    CASE coalesce(estrutura, '')
      WHEN 'Classe' THEN 1
      WHEN 'Fundo' THEN 2
      WHEN 'Subclasse' THEN 3
      ELSE 4
    END,
    codigo_anbima NULLS LAST
),
ultima_pos AS (
  SELECT DISTINCT ON (fundo_cnpj) fundo_cnpj, fundo_patliq, fundo_nomeadm, fundo_cnpjadm, fundo_dtposicao
  FROM public.posicao_carteira
  WHERE section = 'caixa' AND fundo_patliq IS NOT NULL AND fundo_patliq > 0
  ORDER BY fundo_cnpj, fundo_dtposicao DESC
)
SELECT
  coalesce(up.fundo_nomeadm, fc.administrador, 'Não identificado') AS administrador,
  coalesce(up.fundo_cnpjadm, '') AS cnpj_administrador,
  max(up.fundo_dtposicao) AS data_referencia,
  count(ft.id)::integer AS qtd_fundos,
  sum(coalesce(up.fundo_patliq, ft.pl_jan)) AS pl_total,
  sum(CASE
    WHEN ft.segmento IN ('prospeccao', 'alocacao') THEN 0
    WHEN coalesce(ft.tg_fixo_mensal, 0) > 0 THEN ft.tg_fixo_mensal
    WHEN ft.tg_percentual = 0 AND (ft.tg_minimo_mensal IS NULL OR ft.tg_minimo_mensal = 0) THEN 0
    WHEN coalesce(up.fundo_patliq, ft.pl_jan) = 0 THEN 0
    ELSE greatest(ft.tg_percentual * coalesce(up.fundo_patliq, ft.pl_jan) / 12, coalesce(ft.tg_minimo_mensal, 0))
  END) AS receita_tg_total,
  sum(CASE
    WHEN coalesce(ft.ta_fixo_mensal, 0) > 0 THEN ft.ta_fixo_mensal
    WHEN (ft.ta_percentual = 0 OR ft.ta_percentual IS NULL)
      AND (ft.ta_minimo_mensal IS NULL OR ft.ta_minimo_mensal = 0) THEN 0
    WHEN coalesce(up.fundo_patliq, ft.pl_jan) = 0 THEN 0
    ELSE greatest(coalesce(ft.ta_percentual, 0) * coalesce(up.fundo_patliq, ft.pl_jan) / 12, coalesce(ft.ta_minimo_mensal, 0))
  END) AS receita_ta_total,
  sum(CASE
    WHEN ft.segmento IN ('prospeccao') THEN 0
    WHEN coalesce(ft.tc_fixo_mensal, 0) > 0 THEN ft.tc_fixo_mensal
    WHEN (ft.tc_percentual = 0 OR ft.tc_percentual IS NULL)
      AND (ft.tc_minimo_mensal IS NULL OR ft.tc_minimo_mensal = 0) THEN 0
    WHEN coalesce(up.fundo_patliq, ft.pl_jan) = 0 THEN 0
    ELSE greatest(coalesce(ft.tc_percentual, 0) * coalesce(up.fundo_patliq, ft.pl_jan) / 12, coalesce(ft.tc_minimo_mensal, 0))
  END) AS receita_tc_total
FROM public.fundos_taxas ft
LEFT JOIN fc_por_cnpj fc ON fc.cnpj_classe = ft.fundo_cnpj
LEFT JOIN ultima_pos up ON up.fundo_cnpj = ft.fundo_cnpj
WHERE ft.ativo = true
GROUP BY coalesce(up.fundo_nomeadm, fc.administrador, 'Não identificado'), coalesce(up.fundo_cnpjadm, '')
ORDER BY pl_total DESC NULLS LAST;

GRANT SELECT ON public.vw_pl_por_instituicao TO anon, authenticated, service_role;

-- ── 4. View live + wrapper cache (20260817) ──────────────────────────────────

CREATE OR REPLACE VIEW public.vw_conferencia_taxas_mes_live AS
SELECT
  d.fundo_cnpj,
  to_char(d.data_ref, 'YYYY-MM') AS mes_ref,
  coalesce(fc.denominacao_social, d.fundo_cnpj) AS denominacao_social,
  fc.administrador,
  fc.gestor,
  ft.segmento,
  ft.tipo_fundo,
  ft.ta_percentual,
  ft.ta_minimo_mensal,
  ft.ta_fixo_mensal,
  ft.tg_percentual,
  ft.tg_minimo_mensal,
  ft.tg_fixo_mensal,
  ft.tc_percentual,
  ft.tc_minimo_mensal,
  ft.tc_fixo_mensal,
  ft.tcons_percentual,
  ft.tcons_minimo_mensal,
  ft.tcons_fixo_mensal,
  ft.gross_up_ativo,
  ft.ta_gross_up_pis,
  ft.ta_gross_up_cofins,
  ft.ta_gross_up_iss,
  ft.tg_gross_up_pis,
  ft.tg_gross_up_cofins,
  ft.tg_gross_up_iss,
  ft.tc_gross_up_pis,
  ft.tc_gross_up_cofins,
  ft.tc_gross_up_iss,
  ft.tcons_gross_up_pis,
  ft.tcons_gross_up_cofins,
  ft.tcons_gross_up_iss,
  (coalesce(ft.ta_fixo_mensal, 0) > 0 OR ft.ta_percentual > 0 OR coalesce(ft.ta_minimo_mensal, 0) > 0) AS tem_ta,
  (coalesce(ft.tg_fixo_mensal, 0) > 0 OR ft.tg_percentual > 0 OR coalesce(ft.tg_minimo_mensal, 0) > 0) AS tem_tg,
  (coalesce(ft.tc_fixo_mensal, 0) > 0 OR ft.tc_percentual > 0 OR coalesce(ft.tc_minimo_mensal, 0) > 0) AS tem_tc,
  (coalesce(ft.tcons_fixo_mensal, 0) > 0 OR ft.tcons_percentual > 0 OR coalesce(ft.tcons_minimo_mensal, 0) > 0) AS tem_tcons,
  round(sum(d.ta_efetivo_dia), 2) AS ta_mensal,
  round(sum(d.tg_efetivo_dia), 2) AS tg_mensal,
  round(sum(d.tc_efetivo_dia), 2) AS tc_mensal,
  round(sum(d.tcons_efetivo_dia), 2) AS tcons_mensal,
  round(sum(d.ta_efetivo_dia + d.tg_efetivo_dia + d.tc_efetivo_dia + d.tcons_efetivo_dia), 2) AS total_mensal,
  (array_agg(d.pl_dia ORDER BY d.data_ref DESC))[1] AS pl_ultimo,
  count(d.data_ref) AS qtd_dias_uteis
FROM public.vw_conferencia_taxas_diaria d
JOIN public.fundos_taxas ft ON ft.fundo_cnpj = d.fundo_cnpj
LEFT JOIN public.vw_fundos_com_receita fc ON fc.fundo_cnpj = d.fundo_cnpj
GROUP BY
  d.fundo_cnpj,
  mes_ref,
  fc.denominacao_social,
  fc.administrador,
  fc.gestor,
  ft.segmento,
  ft.tipo_fundo,
  ft.ta_percentual,
  ft.ta_minimo_mensal,
  ft.ta_fixo_mensal,
  ft.tg_percentual,
  ft.tg_minimo_mensal,
  ft.tg_fixo_mensal,
  ft.tc_percentual,
  ft.tc_minimo_mensal,
  ft.tc_fixo_mensal,
  ft.tcons_percentual,
  ft.tcons_minimo_mensal,
  ft.tcons_fixo_mensal,
  ft.gross_up_ativo,
  ft.ta_gross_up_pis,
  ft.ta_gross_up_cofins,
  ft.ta_gross_up_iss,
  ft.tg_gross_up_pis,
  ft.tg_gross_up_cofins,
  ft.tg_gross_up_iss,
  ft.tc_gross_up_pis,
  ft.tc_gross_up_cofins,
  ft.tc_gross_up_iss,
  ft.tcons_gross_up_pis,
  ft.tcons_gross_up_cofins,
  ft.tcons_gross_up_iss;

GRANT SELECT ON public.vw_conferencia_taxas_mes_live TO service_role;

CREATE OR REPLACE VIEW public.vw_conferencia_taxas_mes AS
SELECT
  fundo_cnpj,
  mes_ref,
  denominacao_social,
  administrador,
  gestor,
  segmento,
  tipo_fundo,
  ta_percentual,
  ta_minimo_mensal,
  ta_fixo_mensal,
  tg_percentual,
  tg_minimo_mensal,
  tg_fixo_mensal,
  tc_percentual,
  tc_minimo_mensal,
  tc_fixo_mensal,
  tcons_percentual,
  tcons_minimo_mensal,
  tcons_fixo_mensal,
  gross_up_ativo,
  ta_gross_up_pis,
  ta_gross_up_cofins,
  ta_gross_up_iss,
  tg_gross_up_pis,
  tg_gross_up_cofins,
  tg_gross_up_iss,
  tc_gross_up_pis,
  tc_gross_up_cofins,
  tc_gross_up_iss,
  tcons_gross_up_pis,
  tcons_gross_up_cofins,
  tcons_gross_up_iss,
  tem_ta,
  tem_tg,
  tem_tc,
  tem_tcons,
  ta_mensal,
  tg_mensal,
  tc_mensal,
  tcons_mensal,
  total_mensal,
  pl_ultimo,
  qtd_dias_uteis
FROM public.conferencia_taxas_mes_cache;

GRANT SELECT ON public.vw_conferencia_taxas_mes TO anon, authenticated, service_role;

-- ── 5. Repopula cache ────────────────────────────────────────────────────────

SELECT public.refresh_conferencia_taxas_mes_cache();
