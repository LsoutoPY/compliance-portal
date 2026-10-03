-- Conferência de Taxas: cache materializado de vw_conferencia_taxas_mes.
-- Leituras via vw_conferencia_taxas_mes (wrapper); refresh on-demand no import XML e cadastro.

-- ── 1. View live (cálculo pesado — só usada no refresh) ─────────────────────

DROP VIEW IF EXISTS public.vw_conferencia_taxas_mes;

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

COMMENT ON VIEW public.vw_conferencia_taxas_mes_live IS
  'Apuração mensal on-the-fly. Usada apenas por refresh_conferencia_taxas_mes_cache().';

GRANT SELECT ON public.vw_conferencia_taxas_mes_live TO service_role;

-- ── 2. Tabela cache ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.conferencia_taxas_mes_cache (
  fundo_cnpj           text        NOT NULL,
  mes_ref              text        NOT NULL CHECK (mes_ref ~ '^\d{4}-\d{2}$'),
  denominacao_social   text        NOT NULL,
  administrador        text,
  gestor               text,
  segmento             text        NOT NULL,
  tipo_fundo           text        NOT NULL,
  ta_percentual        numeric     NOT NULL DEFAULT 0,
  ta_minimo_mensal     numeric,
  ta_fixo_mensal       numeric,
  tg_percentual        numeric     NOT NULL DEFAULT 0,
  tg_minimo_mensal     numeric,
  tg_fixo_mensal       numeric,
  tc_percentual        numeric     NOT NULL DEFAULT 0,
  tc_minimo_mensal     numeric,
  tc_fixo_mensal       numeric,
  tcons_percentual     numeric     NOT NULL DEFAULT 0,
  tcons_minimo_mensal  numeric,
  tcons_fixo_mensal    numeric,
  gross_up_ativo       boolean     NOT NULL DEFAULT false,
  ta_gross_up_pis      numeric,
  ta_gross_up_cofins   numeric,
  ta_gross_up_iss      numeric,
  tg_gross_up_pis      numeric,
  tg_gross_up_cofins   numeric,
  tg_gross_up_iss      numeric,
  tc_gross_up_pis      numeric,
  tc_gross_up_cofins   numeric,
  tc_gross_up_iss      numeric,
  tcons_gross_up_pis   numeric,
  tcons_gross_up_cofins numeric,
  tcons_gross_up_iss   numeric,
  tem_ta               boolean     NOT NULL DEFAULT false,
  tem_tg               boolean     NOT NULL DEFAULT false,
  tem_tc               boolean     NOT NULL DEFAULT false,
  tem_tcons            boolean     NOT NULL DEFAULT false,
  ta_mensal            numeric     NOT NULL DEFAULT 0,
  tg_mensal            numeric     NOT NULL DEFAULT 0,
  tc_mensal            numeric     NOT NULL DEFAULT 0,
  tcons_mensal         numeric     NOT NULL DEFAULT 0,
  total_mensal         numeric     NOT NULL DEFAULT 0,
  pl_ultimo            numeric,
  qtd_dias_uteis       bigint      NOT NULL DEFAULT 0,
  refreshed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fundo_cnpj, mes_ref)
);

CREATE INDEX IF NOT EXISTS idx_conferencia_taxas_mes_cache_mes_ref
  ON public.conferencia_taxas_mes_cache (mes_ref);

COMMENT ON TABLE public.conferencia_taxas_mes_cache IS
  'Snapshot de apuração mensal de taxas. Populado por refresh_conferencia_taxas_mes_cache().';

ALTER TABLE public.conferencia_taxas_mes_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conferencia_taxas_mes_cache_select_auth" ON public.conferencia_taxas_mes_cache;
CREATE POLICY "conferencia_taxas_mes_cache_select_auth"
  ON public.conferencia_taxas_mes_cache
  FOR SELECT
  TO authenticated
  USING (public.user_is_active());

-- ── 3. Refresh (full ou incremental por fundo/mês) ────────────────────────────

CREATE OR REPLACE FUNCTION public.refresh_conferencia_taxas_mes_cache(
  p_fundo_cnpj text DEFAULT NULL,
  p_mes_ref text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  IF p_fundo_cnpj IS NULL THEN
    TRUNCATE public.conferencia_taxas_mes_cache;

    INSERT INTO public.conferencia_taxas_mes_cache (
      fundo_cnpj, mes_ref, denominacao_social, administrador, gestor, segmento, tipo_fundo,
      ta_percentual, ta_minimo_mensal, ta_fixo_mensal,
      tg_percentual, tg_minimo_mensal, tg_fixo_mensal,
      tc_percentual, tc_minimo_mensal, tc_fixo_mensal,
      tcons_percentual, tcons_minimo_mensal, tcons_fixo_mensal,
      gross_up_ativo,
      ta_gross_up_pis, ta_gross_up_cofins, ta_gross_up_iss,
      tg_gross_up_pis, tg_gross_up_cofins, tg_gross_up_iss,
      tc_gross_up_pis, tc_gross_up_cofins, tc_gross_up_iss,
      tcons_gross_up_pis, tcons_gross_up_cofins, tcons_gross_up_iss,
      tem_ta, tem_tg, tem_tc, tem_tcons,
      ta_mensal, tg_mensal, tc_mensal, tcons_mensal, total_mensal,
      pl_ultimo, qtd_dias_uteis, refreshed_at
    )
    SELECT
      live.fundo_cnpj, live.mes_ref, live.denominacao_social, live.administrador, live.gestor,
      live.segmento, live.tipo_fundo,
      live.ta_percentual, live.ta_minimo_mensal, live.ta_fixo_mensal,
      live.tg_percentual, live.tg_minimo_mensal, live.tg_fixo_mensal,
      live.tc_percentual, live.tc_minimo_mensal, live.tc_fixo_mensal,
      live.tcons_percentual, live.tcons_minimo_mensal, live.tcons_fixo_mensal,
      live.gross_up_ativo,
      live.ta_gross_up_pis, live.ta_gross_up_cofins, live.ta_gross_up_iss,
      live.tg_gross_up_pis, live.tg_gross_up_cofins, live.tg_gross_up_iss,
      live.tc_gross_up_pis, live.tc_gross_up_cofins, live.tc_gross_up_iss,
      live.tcons_gross_up_pis, live.tcons_gross_up_cofins, live.tcons_gross_up_iss,
      live.tem_ta, live.tem_tg, live.tem_tc, live.tem_tcons,
      live.ta_mensal, live.tg_mensal, live.tc_mensal, live.tcons_mensal, live.total_mensal,
      live.pl_ultimo, live.qtd_dias_uteis, now()
    FROM public.vw_conferencia_taxas_mes_live live;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
  END IF;

  DELETE FROM public.conferencia_taxas_mes_cache c
  WHERE c.fundo_cnpj = p_fundo_cnpj
    AND (p_mes_ref IS NULL OR c.mes_ref = p_mes_ref);

  INSERT INTO public.conferencia_taxas_mes_cache (
    fundo_cnpj, mes_ref, denominacao_social, administrador, gestor, segmento, tipo_fundo,
    ta_percentual, ta_minimo_mensal, ta_fixo_mensal,
    tg_percentual, tg_minimo_mensal, tg_fixo_mensal,
    tc_percentual, tc_minimo_mensal, tc_fixo_mensal,
    tcons_percentual, tcons_minimo_mensal, tcons_fixo_mensal,
    gross_up_ativo,
    ta_gross_up_pis, ta_gross_up_cofins, ta_gross_up_iss,
    tg_gross_up_pis, tg_gross_up_cofins, tg_gross_up_iss,
    tc_gross_up_pis, tc_gross_up_cofins, tc_gross_up_iss,
    tcons_gross_up_pis, tcons_gross_up_cofins, tcons_gross_up_iss,
    tem_ta, tem_tg, tem_tc, tem_tcons,
    ta_mensal, tg_mensal, tc_mensal, tcons_mensal, total_mensal,
    pl_ultimo, qtd_dias_uteis, refreshed_at
  )
  SELECT
    live.fundo_cnpj, live.mes_ref, live.denominacao_social, live.administrador, live.gestor,
    live.segmento, live.tipo_fundo,
    live.ta_percentual, live.ta_minimo_mensal, live.ta_fixo_mensal,
    live.tg_percentual, live.tg_minimo_mensal, live.tg_fixo_mensal,
    live.tc_percentual, live.tc_minimo_mensal, live.tc_fixo_mensal,
    live.tcons_percentual, live.tcons_minimo_mensal, live.tcons_fixo_mensal,
    live.gross_up_ativo,
    live.ta_gross_up_pis, live.ta_gross_up_cofins, live.ta_gross_up_iss,
    live.tg_gross_up_pis, live.tg_gross_up_cofins, live.tg_gross_up_iss,
    live.tc_gross_up_pis, live.tc_gross_up_cofins, live.tc_gross_up_iss,
    live.tcons_gross_up_pis, live.tcons_gross_up_cofins, live.tcons_gross_up_iss,
    live.tem_ta, live.tem_tg, live.tem_tc, live.tem_tcons,
    live.ta_mensal, live.tg_mensal, live.tc_mensal, live.tcons_mensal, live.total_mensal,
    live.pl_ultimo, live.qtd_dias_uteis, now()
  FROM public.vw_conferencia_taxas_mes_live live
  WHERE live.fundo_cnpj = p_fundo_cnpj
    AND (p_mes_ref IS NULL OR live.mes_ref = p_mes_ref);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_conferencia_taxas_mes_cache(text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.refresh_conferencia_taxas_mes_cache(text, text) IS
  'Rebuild do cache de conferência. Sem args = full refresh. Com p_fundo_cnpj (+ p_mes_ref opcional) = incremental.';

-- Popula cache na aplicação da migration (pode demorar)
SELECT public.refresh_conferencia_taxas_mes_cache();

-- ── 4. View pública (leitura rápida — compatível com frontend existente) ─────

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

COMMENT ON VIEW public.vw_conferencia_taxas_mes IS
  'Apuração mensal de taxas (cache). Atualizado via refresh_conferencia_taxas_mes_cache().';

GRANT SELECT ON public.vw_conferencia_taxas_mes TO anon, authenticated, service_role;
