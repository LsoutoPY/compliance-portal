-- Mantém snapshots V2 quando a tela legada recalcula o snapshot V1.
--
-- A tabela rentabilidade_snapshot_fundo tem uma única linha por
-- (data_posicao, fundo_key). Portanto, o refresh V1 não pode apagar/regravar
-- uma classe que já possui snapshot V2: isso faria o relatório automático
-- deixar de encontrá-la (ele filtra calc_version = rentabilidade_snapshot_v2).

CREATE OR REPLACE FUNCTION public.upsert_rentabilidade_snapshot_fundos(
  p_data_referencia text,
  p_rows jsonb,
  p_source text DEFAULT 'manual',
  p_calc_version text DEFAULT 'rentabilidade_v1'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_calc_version text := COALESCE(NULLIF(trim(p_calc_version), ''), 'rentabilidade_v1');
BEGIN
  IF p_data_referencia IS NULL OR p_data_referencia !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'p_data_referencia inválida: %', p_data_referencia;
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.user_is_active() THEN
    RAISE EXCEPTION 'Usuário inativo';
  END IF;

  -- V2 é a fonte do relatório automático e não pode ser removido por um
  -- refresh V1 iniciado na tela principal.
  DELETE FROM public.rentabilidade_snapshot_fundo
  WHERE data_posicao = p_data_referencia
    AND calc_version IS DISTINCT FROM 'rentabilidade_snapshot_v2';

  INSERT INTO public.rentabilidade_snapshot_fundo (
    data_posicao, fundo_key, fundo_cnpj, fundo_isin, nome_fundo,
    valor_cota, pl, quantidade, retorno_dia_pct, retorno_acum_pct,
    retorno_mes_pct, retorno_ano_pct, retorno_sem_pct, retorno_12m_pct,
    cdi_dia_pct, cdi_mes_pct, cdi_ano_pct, pct_cdi, cdi_plus_dia_pct,
    cdi_plus_aa_pct, pct_cdi_mes, cdi_plus_mes_pct, cdi_plus_aa_mes_pct,
    pct_cdi_ano, cdi_plus_ano_pct, cdi_plus_aa_ano_pct, cdi_12m_pct,
    pct_cdi_12m, cdi_plus_12m_pct, cdi_plus_aa_12m_pct, is_fidc,
    administrador, calc_version, snapshot_created_at, snapshot_updated_at
  )
  SELECT
    p_data_referencia, r.fundo_key, r.fundo_cnpj, NULLIF(r.fundo_isin, ''),
    r.nome_fundo, r.valor_cota, r.pl, r.quantidade, r.retorno_dia_pct,
    r.retorno_acum_pct, r.retorno_mes_pct, r.retorno_ano_pct,
    r.retorno_sem_pct, r.retorno_12m_pct, r.cdi_dia_pct, r.cdi_mes_pct,
    r.cdi_ano_pct, r.pct_cdi, r.cdi_plus_dia_pct, r.cdi_plus_aa_pct,
    r.pct_cdi_mes, r.cdi_plus_mes_pct, r.cdi_plus_aa_mes_pct,
    r.pct_cdi_ano, r.cdi_plus_ano_pct, r.cdi_plus_aa_ano_pct,
    r.cdi_12m_pct, r.pct_cdi_12m, r.cdi_plus_12m_pct,
    r.cdi_plus_aa_12m_pct, COALESCE(r.is_fidc, false), r.administrador,
    v_calc_version, now(), now()
  FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb)) AS r(
    fundo_key text, fundo_cnpj text, fundo_isin text, nome_fundo text,
    valor_cota numeric, pl numeric, quantidade numeric,
    retorno_dia_pct numeric, retorno_acum_pct numeric, retorno_mes_pct numeric,
    retorno_ano_pct numeric, retorno_sem_pct numeric, retorno_12m_pct numeric,
    cdi_dia_pct numeric, cdi_mes_pct numeric, cdi_ano_pct numeric,
    pct_cdi numeric, cdi_plus_dia_pct numeric, cdi_plus_aa_pct numeric,
    pct_cdi_mes numeric, cdi_plus_mes_pct numeric, cdi_plus_aa_mes_pct numeric,
    pct_cdi_ano numeric, cdi_plus_ano_pct numeric, cdi_plus_aa_ano_pct numeric,
    cdi_12m_pct numeric, pct_cdi_12m numeric, cdi_plus_12m_pct numeric,
    cdi_plus_aa_12m_pct numeric, is_fidc boolean, administrador text
  )
  WHERE r.fundo_key IS NOT NULL
    AND r.fundo_cnpj IS NOT NULL
    -- Como V1 e V2 compartilham a chave primária, a classe V2 permanece
    -- somente na versão V2; o refresh V1 continua válido para as demais.
    AND NOT EXISTS (
      SELECT 1
      FROM public.rentabilidade_snapshot_fundo v2
      WHERE v2.data_posicao = p_data_referencia
        AND v2.fundo_key = r.fundo_key
        AND v2.calc_version = 'rentabilidade_snapshot_v2'
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.rentabilidade_snapshot_status (
    data_referencia, is_stale, stale_reason, updated_at, last_rebuild_at,
    last_rebuild_by, last_rebuild_source, calc_version
  )
  VALUES (
    p_data_referencia, false, NULL, now(), now(), auth.uid(),
    COALESCE(NULLIF(trim(p_source), ''), 'manual'), v_calc_version
  )
  ON CONFLICT (data_referencia) DO UPDATE SET
    is_stale = false,
    stale_reason = NULL,
    updated_at = now(),
    last_rebuild_at = now(),
    last_rebuild_by = auth.uid(),
    last_rebuild_source = COALESCE(NULLIF(trim(p_source), ''), 'manual'),
    calc_version = CASE
      WHEN public.rentabilidade_snapshot_status.calc_version = 'rentabilidade_snapshot_v2'
        THEN public.rentabilidade_snapshot_status.calc_version
      ELSE EXCLUDED.calc_version
    END;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_rentabilidade_snapshot_fundos(text, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_rentabilidade_snapshot_fundos(text, jsonb, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.upsert_rentabilidade_snapshot_fundos(text, jsonb, text, text) IS
  'Recalcula o snapshot legado V1 sem apagar classes já persistidas na versão V2.';

NOTIFY pgrst, 'reload schema';
