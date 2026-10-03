-- Corrige ambiguidade entre a coluna de retorno `attempts` e a coluna da fila
-- dentro do UPDATE. Sem o prefixo, o Postgres rejeita o claim do worker.

CREATE OR REPLACE FUNCTION public.claim_rentabilidade_snapshot_reprocess_v2()
RETURNS TABLE (
  id uuid, data_referencia date, fundo_cnpj text, fundo_isin text, fundo_nome text, attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT q.id
    FROM public.rentabilidade_snapshot_reprocess_item_v2 q
    WHERE q.status = 'pending'
    ORDER BY q.priority ASC, q.requested_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE public.rentabilidade_snapshot_reprocess_item_v2 q
    SET status = 'running',
        attempts = q.attempts + 1,
        started_at = now(),
        updated_at = now()
    FROM candidate c
    WHERE q.id = c.id
    RETURNING q.*
  )
  SELECT c.id, c.data_referencia, c.fundo_cnpj, c.fundo_isin, c.fundo_nome, c.attempts
  FROM claimed c;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_rentabilidade_snapshot_reprocess_v2() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_rentabilidade_snapshot_reprocess_v2() TO service_role;

NOTIFY pgrst, 'reload schema';
