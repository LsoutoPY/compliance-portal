-- Dashboard de XMLs: cache de última posição por fundo.
-- Evita timeout (57014) ao escanear posicao_carteira inteira a cada request.

CREATE TABLE IF NOT EXISTS public.fund_last_updates_cache (
  cnpj_fundo    text        PRIMARY KEY,
  nome_fundo    text,
  dt_posicao    text        NOT NULL,
  administrador text,
  gestor_nome   text,
  cnpj_gestor   text,
  refreshed_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fund_last_updates_cache IS
  'Última dt_posicao por fundo (1 linha/fundo). Alimentado no import XML e via refresh_fund_last_updates_cache().';

CREATE INDEX IF NOT EXISTS idx_posicao_carteira_fundo_dt_desc
  ON public.posicao_carteira (fundo_cnpj, fundo_dtposicao DESC)
  WHERE fundo_cnpj IS NOT NULL;

ALTER TABLE public.fund_last_updates_cache ENABLE ROW LEVEL SECURITY;

-- ── Upsert incremental (1 fundo) — chamado após import XML ───────────────────
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
    p.fundo_cnpjgestor                   AS cnpj_gestor
  INTO v_row
  FROM public.posicao_carteira p
  WHERE p.fundo_cnpj = p_fundo_cnpj
  ORDER BY p.fundo_cnpj, p.fundo_dtposicao DESC;

  IF NOT FOUND THEN
    DELETE FROM public.fund_last_updates_cache WHERE cnpj_fundo = p_fundo_cnpj;
    RETURN;
  END IF;

  INSERT INTO public.fund_last_updates_cache (
    cnpj_fundo, nome_fundo, dt_posicao, administrador, gestor_nome, cnpj_gestor, refreshed_at
  ) VALUES (
    v_row.cnpj_fundo, v_row.nome_fundo, v_row.dt_posicao, v_row.administrador,
    v_row.gestor_nome, v_row.cnpj_gestor, now()
  )
  ON CONFLICT (cnpj_fundo) DO UPDATE SET
    nome_fundo    = EXCLUDED.nome_fundo,
    dt_posicao    = EXCLUDED.dt_posicao,
    administrador = EXCLUDED.administrador,
    gestor_nome   = EXCLUDED.gestor_nome,
    cnpj_gestor   = EXCLUDED.cnpj_gestor,
    refreshed_at  = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_fund_last_update_cache(text) TO service_role;

-- ── Rebuild completo (deploy / manutenção) ───────────────────────────────────
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
    cnpj_fundo, nome_fundo, dt_posicao, administrador, gestor_nome, cnpj_gestor, refreshed_at
  )
  SELECT DISTINCT ON (p.fundo_cnpj)
    p.fundo_cnpj,
    COALESCE(p.nome_fundo, p.fundo_nome),
    p.fundo_dtposicao,
    p.fundo_nomeadm,
    p.fundo_nomegestor,
    p.fundo_cnpjgestor,
    now()
  FROM public.posicao_carteira p
  WHERE p.fundo_cnpj IS NOT NULL
  ORDER BY p.fundo_cnpj, p.fundo_dtposicao DESC;

  SELECT count(*) INTO v_count FROM public.fund_last_updates_cache;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_fund_last_updates_cache() TO service_role;

-- Popula cache na aplicação da migration
SELECT public.refresh_fund_last_updates_cache();

-- ── RPC do dashboard: lê do cache (rápido) ───────────────────────────────────
DROP FUNCTION IF EXISTS public.get_fund_last_updates();

CREATE OR REPLACE FUNCTION public.get_fund_last_updates()
RETURNS TABLE (
  nome_fundo    text,
  cnpj_fundo    text,
  dt_posicao    text,
  administrador text,
  gestor_nome   text,
  cnpj_gestor   text,
  is_monitorado boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.user_is_active() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    c.nome_fundo,
    c.cnpj_fundo,
    c.dt_posicao,
    c.administrador,
    c.gestor_nome,
    c.cnpj_gestor,
    public.is_gestor_monitorado(c.cnpj_gestor) AS is_monitorado
  FROM public.fund_last_updates_cache c
  ORDER BY c.nome_fundo NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_fund_last_updates() TO authenticated;

COMMENT ON FUNCTION public.get_fund_last_updates() IS
  'Última dt_posicao por fundo (Dashboard de XMLs). Lê fund_last_updates_cache.';

-- ── View auxiliar: usa cache em vez de scan completo ─────────────────────────
CREATE OR REPLACE VIEW public.vw_fundos_sem_gestor_monitorado AS
SELECT
  c.cnpj_fundo  AS fundo_cnpj,
  ''::text      AS fundo_isin,
  c.nome_fundo,
  c.gestor_nome,
  c.cnpj_gestor,
  c.dt_posicao  AS ultima_dtposicao
FROM public.fund_last_updates_cache c
WHERE NOT public.is_gestor_monitorado(c.cnpj_gestor)
ORDER BY c.dt_posicao DESC, c.nome_fundo;

COMMENT ON VIEW public.vw_fundos_sem_gestor_monitorado IS
  'Fundos cujo gestor não está na allowlist. Base: fund_last_updates_cache.';
