-- Controle de Taxas: performance — RPC universo monitorado, índice conferência diária,
-- cnpj_admin no cache de última posição.

-- ── 1. cnpj_admin no cache (grupo H / administrador offshore) ────────────────

ALTER TABLE public.fund_last_updates_cache
  ADD COLUMN IF NOT EXISTS cnpj_admin text;

COMMENT ON COLUMN public.fund_last_updates_cache.cnpj_admin IS
  'CNPJ do administrador (fundo_cnpjadm) na última posição importada.';

CREATE OR REPLACE FUNCTION public.upsert_fund_last_update_cache(p_fundo_cnpj text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
BEGIN
  IF p_fundo_cnpj IS NULL OR btrim(p_fundo_cnpj) = '' THEN
    RETURN;
  END IF;

  SELECT DISTINCT ON (p.fundo_cnpj)
    COALESCE(p.nome_fundo, p.fundo_nome) AS nome_fundo,
    p.fundo_cnpj                         AS cnpj_fundo,
    p.fundo_dtposicao                    AS dt_posicao,
    p.fundo_nomeadm                      AS administrador,
    p.fundo_nomegestor                   AS gestor_nome,
    p.fundo_cnpjgestor                   AS cnpj_gestor,
    p.fundo_cnpjadm                      AS cnpj_admin
  INTO v_row
  FROM public.posicao_carteira p
  WHERE p.fundo_cnpj = p_fundo_cnpj
  ORDER BY p.fundo_cnpj, p.fundo_dtposicao DESC;

  IF NOT FOUND THEN
    DELETE FROM public.fund_last_updates_cache WHERE cnpj_fundo = p_fundo_cnpj;
    RETURN;
  END IF;

  INSERT INTO public.fund_last_updates_cache (
    cnpj_fundo, nome_fundo, dt_posicao, administrador, gestor_nome, cnpj_gestor, cnpj_admin, refreshed_at
  ) VALUES (
    v_row.cnpj_fundo, v_row.nome_fundo, v_row.dt_posicao, v_row.administrador,
    v_row.gestor_nome, v_row.cnpj_gestor, v_row.cnpj_admin, now()
  )
  ON CONFLICT (cnpj_fundo) DO UPDATE SET
    nome_fundo    = EXCLUDED.nome_fundo,
    dt_posicao    = EXCLUDED.dt_posicao,
    administrador = EXCLUDED.administrador,
    gestor_nome   = EXCLUDED.gestor_nome,
    cnpj_gestor   = EXCLUDED.cnpj_gestor,
    cnpj_admin    = EXCLUDED.cnpj_admin,
    refreshed_at  = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_fund_last_updates_cache()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  TRUNCATE public.fund_last_updates_cache;

  INSERT INTO public.fund_last_updates_cache (
    cnpj_fundo, nome_fundo, dt_posicao, administrador, gestor_nome, cnpj_gestor, cnpj_admin, refreshed_at
  )
  SELECT DISTINCT ON (p.fundo_cnpj)
    p.fundo_cnpj,
    COALESCE(p.nome_fundo, p.fundo_nome),
    p.fundo_dtposicao,
    p.fundo_nomeadm,
    p.fundo_nomegestor,
    p.fundo_cnpjgestor,
    p.fundo_cnpjadm,
    now()
  FROM public.posicao_carteira p
  WHERE p.fundo_cnpj IS NOT NULL
  ORDER BY p.fundo_cnpj, p.fundo_dtposicao DESC;

  SELECT count(*) INTO v_count FROM public.fund_last_updates_cache;
  RETURN v_count;
END;
$$;

-- Repopula cnpj_admin nas linhas existentes
SELECT public.refresh_fund_last_updates_cache();

-- ── 2. RPC: universo de CNPJs monitorados (via cache, sem scan completo) ─────

CREATE OR REPLACE FUNCTION public.get_universo_cnpjs_monitorados()
RETURNS TABLE (fundo_cnpj text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.user_is_active() THEN
    RETURN;
  END IF;

  -- Sem gestores cadastrados: retorna vazio (frontend interpreta como sem filtro)
  IF NOT EXISTS (SELECT 1 FROM public.gestores_monitorados WHERE ativo = true) THEN
    RETURN;
  END IF;

  -- Gestor na allowlist (última posição por fundo)
  RETURN QUERY
  SELECT DISTINCT public.normalize_cnpj_digits(c.cnpj_fundo)
  FROM public.fund_last_updates_cache c
  WHERE public.is_gestor_monitorado(c.cnpj_gestor);

  -- Administradores grupo H quando Hieron está monitorado (offshore/BNY etc.)
  IF EXISTS (
    SELECT 1
    FROM public.gestores_monitorados g
    WHERE g.ativo = true
      AND g.nome ~* 'hieron'
  ) THEN
    RETURN QUERY
    SELECT DISTINCT public.normalize_cnpj_digits(c.cnpj_fundo)
    FROM public.fund_last_updates_cache c
    INNER JOIN public.mapa_fundos_grupos m
      ON m.tipo = 'admin'
     AND m.grupo = 'H'
     AND m.ativo = true
     AND public.normalize_cnpj_digits(m.cnpj) = public.normalize_cnpj_digits(c.cnpj_admin)
    WHERE c.cnpj_admin IS NOT NULL
      AND btrim(c.cnpj_admin) <> '';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_universo_cnpjs_monitorados() TO authenticated;

COMMENT ON FUNCTION public.get_universo_cnpjs_monitorados() IS
  'CNPJs distintos de fundos monitorados. Base: fund_last_updates_cache (1 linha/fundo). Substitui scan completo de posicao_carteira no frontend.';

-- ── 3. Índice para vw_conferencia_taxas_diaria (section = caixa, PL por dia) ─

CREATE INDEX IF NOT EXISTS idx_posicao_carteira_section_fundo_dt
  ON public.posicao_carteira (section, fundo_cnpj, fundo_dtposicao)
  WHERE section = 'caixa'
    AND fundo_patliq IS NOT NULL
    AND fundo_patliq > 0;

COMMENT ON INDEX public.idx_posicao_carteira_section_fundo_dt IS
  'Acelera vw_conferencia_taxas_diaria: DISTINCT ON + LAG por fundo em section=caixa.';
