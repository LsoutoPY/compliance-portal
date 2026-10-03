-- Cache persistido de rentabilidade por fundo/data (snapshot).
-- Objetivo: leitura rápida no módulo, mantendo compatibilidade com o cálculo on-demand.

CREATE TABLE IF NOT EXISTS public.rentabilidade_snapshot_fundo (
  data_posicao text NOT NULL CHECK (data_posicao ~ '^\d{4}-\d{2}-\d{2}$'),
  fundo_key text NOT NULL,
  fundo_cnpj text NOT NULL,
  fundo_isin text NULL,
  nome_fundo text NULL,
  valor_cota numeric NULL,
  pl numeric NULL,
  quantidade numeric NULL,
  retorno_dia_pct numeric NULL,
  retorno_acum_pct numeric NULL,
  retorno_mes_pct numeric NULL,
  retorno_ano_pct numeric NULL,
  retorno_sem_pct numeric NULL,
  retorno_12m_pct numeric NULL,
  cdi_dia_pct numeric NULL,
  cdi_mes_pct numeric NULL,
  cdi_ano_pct numeric NULL,
  pct_cdi numeric NULL,
  cdi_plus_dia_pct numeric NULL,
  cdi_plus_aa_pct numeric NULL,
  pct_cdi_mes numeric NULL,
  cdi_plus_mes_pct numeric NULL,
  cdi_plus_aa_mes_pct numeric NULL,
  pct_cdi_ano numeric NULL,
  cdi_plus_ano_pct numeric NULL,
  cdi_plus_aa_ano_pct numeric NULL,
  cdi_12m_pct numeric NULL,
  pct_cdi_12m numeric NULL,
  cdi_plus_12m_pct numeric NULL,
  cdi_plus_aa_12m_pct numeric NULL,
  is_fidc boolean NOT NULL DEFAULT false,
  administrador text NULL,
  snapshot_created_at timestamptz NOT NULL DEFAULT now(),
  snapshot_updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (data_posicao, fundo_key)
);

CREATE INDEX IF NOT EXISTS idx_rent_snap_fundo_data ON public.rentabilidade_snapshot_fundo (fundo_cnpj, data_posicao);
CREATE INDEX IF NOT EXISTS idx_rent_snap_data ON public.rentabilidade_snapshot_fundo (data_posicao);

COMMENT ON TABLE public.rentabilidade_snapshot_fundo IS
  'Snapshot persistido da rentabilidade por fundo/data para acelerar leitura e exportações.';

CREATE TABLE IF NOT EXISTS public.rentabilidade_snapshot_status (
  data_referencia text PRIMARY KEY CHECK (data_referencia ~ '^\d{4}-\d{2}-\d{2}$'),
  is_stale boolean NOT NULL DEFAULT false,
  stale_reason text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_rebuild_at timestamptz NULL,
  last_rebuild_by uuid NULL,
  last_rebuild_source text NOT NULL DEFAULT 'manual'
);

COMMENT ON TABLE public.rentabilidade_snapshot_status IS
  'Status de atualização dos snapshots de rentabilidade por data de referência.';

ALTER TABLE public.rentabilidade_snapshot_fundo ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rentabilidade_snapshot_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rent_snap_select_auth" ON public.rentabilidade_snapshot_fundo;
CREATE POLICY "rent_snap_select_auth"
  ON public.rentabilidade_snapshot_fundo
  FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "rent_snap_status_select_auth" ON public.rentabilidade_snapshot_status;
CREATE POLICY "rent_snap_status_select_auth"
  ON public.rentabilidade_snapshot_status
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE OR REPLACE FUNCTION public.upsert_rentabilidade_snapshot_fundos(
  p_data_referencia text,
  p_rows jsonb,
  p_source text DEFAULT 'manual'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF p_data_referencia IS NULL OR p_data_referencia !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'p_data_referencia inválida: %', p_data_referencia;
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.user_is_active() THEN
    RAISE EXCEPTION 'Usuário inativo';
  END IF;

  DELETE FROM public.rentabilidade_snapshot_fundo
  WHERE data_posicao = p_data_referencia;

  INSERT INTO public.rentabilidade_snapshot_fundo (
    data_posicao,
    fundo_key,
    fundo_cnpj,
    fundo_isin,
    nome_fundo,
    valor_cota,
    pl,
    quantidade,
    retorno_dia_pct,
    retorno_acum_pct,
    retorno_mes_pct,
    retorno_ano_pct,
    retorno_sem_pct,
    retorno_12m_pct,
    cdi_dia_pct,
    cdi_mes_pct,
    cdi_ano_pct,
    pct_cdi,
    cdi_plus_dia_pct,
    cdi_plus_aa_pct,
    pct_cdi_mes,
    cdi_plus_mes_pct,
    cdi_plus_aa_mes_pct,
    pct_cdi_ano,
    cdi_plus_ano_pct,
    cdi_plus_aa_ano_pct,
    cdi_12m_pct,
    pct_cdi_12m,
    cdi_plus_12m_pct,
    cdi_plus_aa_12m_pct,
    is_fidc,
    administrador,
    snapshot_created_at,
    snapshot_updated_at
  )
  SELECT
    p_data_referencia,
    r.fundo_key,
    r.fundo_cnpj,
    NULLIF(r.fundo_isin, ''),
    r.nome_fundo,
    r.valor_cota,
    r.pl,
    r.quantidade,
    r.retorno_dia_pct,
    r.retorno_acum_pct,
    r.retorno_mes_pct,
    r.retorno_ano_pct,
    r.retorno_sem_pct,
    r.retorno_12m_pct,
    r.cdi_dia_pct,
    r.cdi_mes_pct,
    r.cdi_ano_pct,
    r.pct_cdi,
    r.cdi_plus_dia_pct,
    r.cdi_plus_aa_pct,
    r.pct_cdi_mes,
    r.cdi_plus_mes_pct,
    r.cdi_plus_aa_mes_pct,
    r.pct_cdi_ano,
    r.cdi_plus_ano_pct,
    r.cdi_plus_aa_ano_pct,
    r.cdi_12m_pct,
    r.pct_cdi_12m,
    r.cdi_plus_12m_pct,
    r.cdi_plus_aa_12m_pct,
    COALESCE(r.is_fidc, false),
    r.administrador,
    now(),
    now()
  FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb)) AS r(
    fundo_key text,
    fundo_cnpj text,
    fundo_isin text,
    nome_fundo text,
    valor_cota numeric,
    pl numeric,
    quantidade numeric,
    retorno_dia_pct numeric,
    retorno_acum_pct numeric,
    retorno_mes_pct numeric,
    retorno_ano_pct numeric,
    retorno_sem_pct numeric,
    retorno_12m_pct numeric,
    cdi_dia_pct numeric,
    cdi_mes_pct numeric,
    cdi_ano_pct numeric,
    pct_cdi numeric,
    cdi_plus_dia_pct numeric,
    cdi_plus_aa_pct numeric,
    pct_cdi_mes numeric,
    cdi_plus_mes_pct numeric,
    cdi_plus_aa_mes_pct numeric,
    pct_cdi_ano numeric,
    cdi_plus_ano_pct numeric,
    cdi_plus_aa_ano_pct numeric,
    cdi_12m_pct numeric,
    pct_cdi_12m numeric,
    cdi_plus_12m_pct numeric,
    cdi_plus_aa_12m_pct numeric,
    is_fidc boolean,
    administrador text
  )
  WHERE r.fundo_key IS NOT NULL
    AND r.fundo_cnpj IS NOT NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.rentabilidade_snapshot_status (
    data_referencia,
    is_stale,
    stale_reason,
    updated_at,
    last_rebuild_at,
    last_rebuild_by,
    last_rebuild_source
  )
  VALUES (
    p_data_referencia,
    false,
    NULL,
    now(),
    now(),
    auth.uid(),
    COALESCE(NULLIF(trim(p_source), ''), 'manual')
  )
  ON CONFLICT (data_referencia) DO UPDATE
  SET
    is_stale = false,
    stale_reason = NULL,
    updated_at = now(),
    last_rebuild_at = now(),
    last_rebuild_by = auth.uid(),
    last_rebuild_source = COALESCE(NULLIF(trim(p_source), ''), 'manual');

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_rentabilidade_snapshot_stale(
  p_data_referencia text,
  p_reason text DEFAULT 'xml_import'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_data_referencia IS NULL OR p_data_referencia !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN;
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.user_is_active() THEN
    RETURN;
  END IF;

  INSERT INTO public.rentabilidade_snapshot_status (
    data_referencia,
    is_stale,
    stale_reason,
    updated_at
  )
  VALUES (
    p_data_referencia,
    true,
    COALESCE(NULLIF(trim(p_reason), ''), 'xml_import'),
    now()
  )
  ON CONFLICT (data_referencia) DO UPDATE
  SET
    is_stale = true,
    stale_reason = COALESCE(NULLIF(trim(EXCLUDED.stale_reason), ''), public.rentabilidade_snapshot_status.stale_reason),
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_rentabilidade_snapshot_fundos(text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_rentabilidade_snapshot_stale(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.upsert_rentabilidade_snapshot_fundos(text, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_rentabilidade_snapshot_stale(text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
