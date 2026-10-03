-- A consolidacao mensal pode processar varias fontes historicas e ultrapassar
-- o timeout padrao do PostgREST em competencias mais densas. O limite fica
-- restrito a esta funcao; as demais consultas mantem a configuracao global.

CREATE OR REPLACE FUNCTION public.sincronizar_ocorrencias_risco(p_competencia DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '30s'
AS $$
DECLARE
  v_competencia DATE := date_trunc('month', p_competencia)::date;
  v_sincronizacao_id UUID;
  v_fundos JSONB;
  v_classes JSONB;
  v_reconciliacao JSONB;
BEGIN
  IF auth.role() NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'Acesso nao autorizado';
  END IF;

  INSERT INTO public.risco_sincronizacoes (competencia, created_by)
  VALUES (v_competencia, auth.uid())
  RETURNING id INTO v_sincronizacao_id;

  v_fundos := public.sincronizar_ocorrencias_risco_fundos(v_competencia);
  v_classes := public.sincronizar_ocorrencias_enquadramento_isin(v_competencia);
  v_reconciliacao := public.reconciliar_ocorrencias_risco(v_competencia, v_sincronizacao_id);

  UPDATE public.risco_sincronizacoes
  SET status = 'concluida',
      modulos_processados = ARRAY['enquadramento', 'liquidez', 'mercado', 'concentracao'],
      ocorrencias_encontradas = COALESCE((v_reconciliacao->>'ocorrencias_encontradas')::integer, 0),
      ocorrencias_regularizadas = COALESCE((v_reconciliacao->>'ocorrencias_regularizadas')::integer, 0),
      ocorrencias_invalidadas = COALESCE((v_reconciliacao->>'ocorrencias_invalidadas')::integer, 0),
      ocorrencias_em_revisao = COALESCE((v_reconciliacao->>'ocorrencias_em_revisao')::integer, 0),
      detalhes = jsonb_build_object('fontes_fundo', v_fundos, 'fontes_classe', v_classes),
      concluido_em = now()
  WHERE id = v_sincronizacao_id;

  RETURN jsonb_build_object(
    'sincronizacao_id', v_sincronizacao_id,
    'competencia', v_competencia,
    'fontes_fundo', v_fundos,
    'fontes_classe', v_classes,
    'reconciliacao', v_reconciliacao,
    'sincronizado_em', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sincronizar_ocorrencias_risco(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sincronizar_ocorrencias_risco(DATE)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.sincronizar_ocorrencias_risco(DATE) IS
  'Sincroniza e reconcilia ocorrencias por competencia com timeout isolado de 30 segundos.';

NOTIFY pgrst, 'reload schema';
