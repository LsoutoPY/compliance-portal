-- Uma importação anterior à V2 pode deixar a fila como pending mesmo depois de
-- o snapshot correspondente já ter sido persistido. Finaliza somente itens cuja
-- versão persistida é posterior (ou igual) ao pedido de processamento.

CREATE OR REPLACE FUNCTION public.finalize_rentabilidade_snapshot_v2_queue_from_snapshot(
  p_data_referencia date DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer := 0;
BEGIN
  UPDATE public.rentabilidade_snapshot_reprocess_item_v2 q
  SET
    status = 'done',
    updated_at = now(),
    finished_at = coalesce(q.finished_at, now()),
    last_error = NULL
  FROM public.rentabilidade_snapshot_fundo s
  WHERE q.data_referencia = coalesce(p_data_referencia, q.data_referencia)
    AND q.status IN ('pending', 'running')
    AND s.data_posicao = q.data_referencia::text
    AND s.fundo_key = q.fundo_cnpj || '|ISIN:' || q.fundo_isin
    AND s.calc_version = 'rentabilidade_snapshot_v2'
    AND s.snapshot_updated_at >= q.requested_at;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_rentabilidade_snapshot_v2_queue_from_snapshot(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_rentabilidade_snapshot_v2_queue_from_snapshot(date) TO service_role;

COMMENT ON FUNCTION public.finalize_rentabilidade_snapshot_v2_queue_from_snapshot(date) IS
  'Fecha itens pendentes cuja versão V2 já foi persistida após o pedido. Não envia e-mail.';

NOTIFY pgrst, 'reload schema';
