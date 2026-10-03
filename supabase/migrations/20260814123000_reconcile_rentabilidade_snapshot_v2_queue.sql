-- Reconcilia XMLs já existentes com os snapshots V2.
-- Esta função só adiciona classes à fila de cálculo; ela não chama SMTP nem
-- altera os logs de envio de relatório.

CREATE OR REPLACE FUNCTION public.reconcile_rentabilidade_snapshot_v2_queue(
  p_data_referencia date DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_data_referencia date;
  v_inserted integer := 0;
BEGIN
  v_data_referencia := p_data_referencia;
  IF v_data_referencia IS NULL THEN
    SELECT max(to_date(pc.fundo_dtposicao::text, 'YYYYMMDD'))
    INTO v_data_referencia
    FROM public.posicao_carteira pc
    WHERE pc.fundo_dtposicao::text ~ '^\d{8}$';
  END IF;

  IF v_data_referencia IS NULL THEN
    RETURN 0;
  END IF;

  WITH pares_xml AS (
    SELECT
      regexp_replace(pc.fundo_cnpj, '\D', '', 'g') AS fundo_cnpj,
      upper(trim(pc.fundo_isin)) AS fundo_isin,
      max(coalesce(nullif(trim(pc.nome_fundo), ''), nullif(trim(pc.fundo_nome), ''))) AS fundo_nome
    FROM public.posicao_carteira pc
    WHERE pc.fundo_dtposicao::text = to_char(v_data_referencia, 'YYYYMMDD')
      AND pc.section IN ('caixa', 'despesas')
      AND coalesce(trim(pc.fundo_isin), '') <> ''
    GROUP BY regexp_replace(pc.fundo_cnpj, '\D', '', 'g'), upper(trim(pc.fundo_isin))
  ),
  faltantes AS (
    SELECT p.*
    FROM pares_xml p
    LEFT JOIN public.rentabilidade_snapshot_fundo s
      ON s.data_posicao = v_data_referencia::text
      AND s.fundo_key = p.fundo_cnpj || '|ISIN:' || p.fundo_isin
      AND s.calc_version = 'rentabilidade_snapshot_v2'
    LEFT JOIN public.rentabilidade_snapshot_reprocess_item_v2 q
      ON q.data_referencia = v_data_referencia
      AND q.fundo_cnpj = p.fundo_cnpj
      AND q.fundo_isin = p.fundo_isin
      AND q.status IN ('pending', 'running')
    WHERE s.fundo_key IS NULL
      AND q.id IS NULL
    ORDER BY p.fundo_nome NULLS LAST, p.fundo_cnpj, p.fundo_isin
    LIMIT greatest(1, least(coalesce(p_limit, 100), 500))
  )
  INSERT INTO public.rentabilidade_snapshot_reprocess_item_v2 (
    data_referencia, fundo_cnpj, fundo_isin, fundo_nome, status, priority,
    requested_source, requested_at, updated_at, started_at, finished_at, last_error
  )
  SELECT
    v_data_referencia, fundo_cnpj, fundo_isin, fundo_nome, 'pending', 50,
    'snapshot_reconcile_v2', now(), now(), NULL, NULL, NULL
  FROM faltantes
  ON CONFLICT (data_referencia, fundo_cnpj, fundo_isin) DO UPDATE SET
    fundo_nome = coalesce(EXCLUDED.fundo_nome, public.rentabilidade_snapshot_reprocess_item_v2.fundo_nome),
    status = 'pending',
    priority = least(EXCLUDED.priority, public.rentabilidade_snapshot_reprocess_item_v2.priority),
    requested_source = EXCLUDED.requested_source,
    requested_at = now(), updated_at = now(), started_at = NULL, finished_at = NULL, last_error = NULL;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_rentabilidade_snapshot_v2_queue(date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_rentabilidade_snapshot_v2_queue(date, integer) TO service_role;

COMMENT ON FUNCTION public.reconcile_rentabilidade_snapshot_v2_queue(date, integer) IS
  'Enfileira classes com XML e sem snapshot V2. Não envia e-mail.';

NOTIFY pgrst, 'reload schema';
