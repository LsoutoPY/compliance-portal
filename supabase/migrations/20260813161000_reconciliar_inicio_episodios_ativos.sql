-- Corrige a primeira carga limitada do Monitoramento: para episódios ativos,
-- procura somente a série da própria regra e retroage o início até o primeiro
-- alerta/violação posterior ao último status OK. Não altera ID, plano ou comunicações.

CREATE OR REPLACE FUNCTION public.reconciliar_inicios_episodios_ativos_risco(
  p_limite integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ep public.risco_episodios%ROWTYPE;
  v_inicio date;
  v_dias integer;
  v_total integer := 0;
  v_atualizados integer := 0;
  v_sem_fonte integer := 0;
BEGIN
  IF auth.role() NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'Acesso não autorizado';
  END IF;

  FOR v_ep IN
    SELECT *
    FROM public.risco_episodios
    WHERE data_regularizacao IS NULL
      AND source_table IN ('enquadramento_resultado', 'liquidez_monitoramento_risco')
    ORDER BY data_inicio, id
    LIMIT greatest(1, least(coalesce(p_limite, 500), 5000))
    FOR UPDATE
  LOOP
    v_total := v_total + 1;
    v_inicio := NULL;
    v_dias := NULL;

    IF v_ep.source_table = 'enquadramento_resultado' THEN
      WITH serie AS (
        SELECT to_date(e.fundo_dtposicao, 'YYYYMMDD') AS data_ref,
          CASE WHEN e.status = 'alerta' THEN 'atencao' ELSE e.status END AS status
        FROM public.enquadramento_resultado e
        WHERE regexp_replace(e.fundo_cnpj, '\D', '', 'g') = v_ep.fundo_cnpj
          AND upper(trim(coalesce(e.fundo_isin, ''))) = v_ep.fundo_isin
          AND e.regra_codigo = v_ep.source_key
          AND e.fundo_dtposicao ~ '^[0-9]{8}$'
          AND to_date(e.fundo_dtposicao, 'YYYYMMDD') <= v_ep.data_ultima_evidencia
      ), ultimo_ok AS (
        SELECT max(data_ref) AS data_ref FROM serie WHERE status = 'ok'
      ), episodio AS (
        SELECT data_ref FROM serie
        WHERE status IN ('atencao', 'violacao')
          AND data_ref > coalesce((SELECT data_ref FROM ultimo_ok), '-infinity'::date)
      )
      SELECT min(data_ref), count(*)::integer INTO v_inicio, v_dias FROM episodio;
    ELSE
      WITH serie AS (
        SELECT to_date(l.dt_posicao, 'YYYYMMDD') AS data_ref,
          CASE
            WHEN l.is_fundo_fechado THEN coalesce(l.status_cobertura, 'pendente')
            ELSE coalesce(l.status, 'pendente')
          END AS status
        FROM public.liquidez_monitoramento_risco l
        WHERE regexp_replace(l.fundo_cnpj, '\D', '', 'g') = v_ep.fundo_cnpj
          AND l.dt_posicao ~ '^[0-9]{8}$'
          AND to_date(l.dt_posicao, 'YYYYMMDD') <= v_ep.data_ultima_evidencia
          AND ((v_ep.source_key = 'LIQUIDEZ_COBERTURA' AND l.is_fundo_fechado)
            OR (v_ep.source_key = 'LIQUIDEZ_RESGATE' AND NOT l.is_fundo_fechado))
      ), ultimo_ok AS (
        SELECT max(data_ref) AS data_ref FROM serie WHERE status = 'ok'
      ), episodio AS (
        SELECT data_ref FROM serie
        WHERE status IN ('alerta', 'violacao')
          AND data_ref > coalesce((SELECT data_ref FROM ultimo_ok), '-infinity'::date)
      )
      SELECT min(data_ref), count(*)::integer INTO v_inicio, v_dias FROM episodio;
    END IF;

    IF v_inicio IS NULL THEN
      v_sem_fonte := v_sem_fonte + 1;
    ELSIF v_inicio < v_ep.data_inicio THEN
      UPDATE public.risco_episodios
      SET chave_episodio = md5(concat_ws('|', modulo, fundo_cnpj, fundo_isin, source_key, v_inicio::text)),
          data_inicio = v_inicio,
          dias_com_evidencia = v_dias,
          source_payload = source_payload || jsonb_build_object(
            'inicio_reconciliado_em', now(),
            'inicio_reconciliado_da_fonte', v_inicio,
            'dias_com_evidencia_reconciliados', v_dias
          )
      WHERE id = v_ep.id;

      INSERT INTO public.risco_episodio_comunicacoes (
        episodio_id, tipo, canal, assunto, conteudo
      ) VALUES (
        v_ep.id, 'evidencia', 'sistema', 'Início do episódio reconciliado',
        format('Início retroagido de %s para %s após leitura integral da fonte diária.', v_ep.data_inicio, v_inicio)
      );
      v_atualizados := v_atualizados + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'episodios_analisados', v_total,
    'episodios_atualizados', v_atualizados,
    'episodios_sem_serie', v_sem_fonte,
    'reconciliado_em', now()
  );
END;
$$;

COMMENT ON FUNCTION public.reconciliar_inicios_episodios_ativos_risco(integer) IS
  'Reconcilia episódios ativos contra a série diária integral da própria regra, preservando planos, comunicações e o ID do caso.';

GRANT EXECUTE ON FUNCTION public.reconciliar_inicios_episodios_ativos_risco(integer) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
