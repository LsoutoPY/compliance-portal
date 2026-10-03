-- O motivo estruturado é suficiente para classificar a validade. Substitui a
-- RPC anterior e mantém usuário, horário, antes/depois e motivo na auditoria.

DROP FUNCTION IF EXISTS public.classificar_validade_ocorrencia_risco(UUID, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.classificar_validade_ocorrencia_risco(
  p_ocorrencia_id UUID,
  p_validade TEXT,
  p_motivo_classificacao TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_anterior public.risco_ocorrencias%ROWTYPE;
  v_agora TIMESTAMPTZ := clock_timestamp();
  v_motivo TEXT := NULLIF(trim(p_motivo_classificacao), '');
  v_motivo_label TEXT;
BEGIN
  IF NOT public.risco_usuario_pode_editar() THEN
    RAISE EXCEPTION 'Usuário sem permissão para classificar a ocorrência';
  END IF;

  IF p_validade NOT IN ('confirmada', 'em_revisao', 'invalidada_correcao_dado') THEN
    RAISE EXCEPTION 'Validade da ocorrência inválida';
  END IF;

  SELECT *
  INTO v_anterior
  FROM public.risco_ocorrencias
  WHERE id = p_ocorrencia_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ocorrência não encontrada';
  END IF;

  IF p_validade <> 'confirmada'
     AND (v_motivo IS NULL OR v_motivo NOT IN (
       'xml_incorreto',
       'arquivo_reprocessado',
       'regra_incorreta',
       'duplicidade',
       'em_analise',
       'outro'
     )) THEN
    RAISE EXCEPTION 'Informe um motivo válido para a classificação';
  END IF;

  v_motivo_label := CASE v_motivo
    WHEN 'xml_incorreto' THEN 'XML incorreto'
    WHEN 'arquivo_reprocessado' THEN 'Arquivo substituído ou reprocessado'
    WHEN 'regra_incorreta' THEN 'Regra configurada incorretamente'
    WHEN 'duplicidade' THEN 'Ocorrência duplicada'
    WHEN 'em_analise' THEN 'Em análise'
    WHEN 'outro' THEN 'Outro motivo'
    ELSE NULL
  END;

  UPDATE public.risco_ocorrencias
  SET validade_ocorrencia = p_validade,
      validade_bloqueada_manualmente = p_validade <> 'confirmada',
      validade_atualizada_em = v_agora,
      validade_atualizada_por = auth.uid(),
      motivo_classificacao = CASE WHEN p_validade = 'confirmada' THEN NULL ELSE v_motivo END,
      invalidada_em = CASE WHEN p_validade = 'invalidada_correcao_dado' THEN v_agora ELSE NULL END,
      invalidada_por = CASE WHEN p_validade = 'invalidada_correcao_dado' THEN auth.uid() ELSE NULL END,
      motivo_invalidacao = CASE WHEN p_validade = 'confirmada' THEN NULL ELSE v_motivo_label END
  WHERE id = p_ocorrencia_id;

  INSERT INTO public.risco_ocorrencia_comunicacoes (
    ocorrencia_id,
    tipo,
    canal,
    assunto,
    conteudo,
    metadata,
    created_by
  ) VALUES (
    p_ocorrencia_id,
    'validade_alterada',
    'manual',
    'Validade da ocorrência atualizada',
    v_motivo_label,
    jsonb_build_object(
      'validade_anterior', v_anterior.validade_ocorrencia,
      'validade_nova', p_validade,
      'motivo_classificacao', CASE WHEN p_validade = 'confirmada' THEN NULL ELSE v_motivo END,
      'excluida_relatorio', p_validade = 'invalidada_correcao_dado'
    ),
    auth.uid()
  );

  RETURN jsonb_build_object(
    'id', p_ocorrencia_id,
    'validade_anterior', v_anterior.validade_ocorrencia,
    'validade_atual', p_validade,
    'bloqueada_manualmente', p_validade <> 'confirmada',
    'atualizada_em', v_agora
  );
END;
$$;

REVOKE ALL ON FUNCTION public.classificar_validade_ocorrencia_risco(UUID, TEXT, TEXT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.classificar_validade_ocorrencia_risco(UUID, TEXT, TEXT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.classificar_validade_ocorrencia_risco(UUID, TEXT, TEXT) IS
  'Classifica a validade pelo motivo estruturado, preservando histórico, auditoria e decisão humana.';

NOTIFY pgrst, 'reload schema';
