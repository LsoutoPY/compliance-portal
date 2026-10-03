-- Permite classificar falsos positivos manualmente sem excluir a ocorrência,
-- a notificação, o plano de ação ou a trilha de auditoria.

ALTER TABLE public.risco_ocorrencias
  ADD COLUMN IF NOT EXISTS validade_bloqueada_manualmente BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS validade_atualizada_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS validade_atualizada_por UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS motivo_classificacao TEXT;

ALTER TABLE public.risco_ocorrencias
  DROP CONSTRAINT IF EXISTS risco_ocorrencias_motivo_classificacao_check;

ALTER TABLE public.risco_ocorrencias
  ADD CONSTRAINT risco_ocorrencias_motivo_classificacao_check
  CHECK (
    motivo_classificacao IS NULL
    OR motivo_classificacao IN (
      'xml_incorreto',
      'arquivo_reprocessado',
      'regra_incorreta',
      'duplicidade',
      'em_analise',
      'outro'
    )
  );

COMMENT ON COLUMN public.risco_ocorrencias.validade_bloqueada_manualmente IS
  'Quando true, a sincronização não pode sobrescrever a classificação humana da validade.';
COMMENT ON COLUMN public.risco_ocorrencias.motivo_classificacao IS
  'Motivo estruturado informado na classificação manual da validade.';

ALTER TABLE public.risco_ocorrencia_comunicacoes
  DROP CONSTRAINT IF EXISTS risco_ocorrencia_comunicacoes_tipo_check;

ALTER TABLE public.risco_ocorrencia_comunicacoes
  ADD CONSTRAINT risco_ocorrencia_comunicacoes_tipo_check
  CHECK (tipo IN (
    'notificacao_enviada',
    'resposta_recebida',
    'comentario',
    'evidencia',
    'status_alterado',
    'validade_alterada'
  ));

-- A reconciliação continua atualizando datas e fontes, mas preserva a validade
-- quando ela foi decidida manualmente. A RPC abaixo altera o marcador temporal
-- e, por isso, é reconhecida pelo trigger como uma decisão humana autorizada.
CREATE OR REPLACE FUNCTION public.risco_preservar_validade_manual()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.validade_bloqueada_manualmente
     AND NEW.validade_atualizada_em IS NOT DISTINCT FROM OLD.validade_atualizada_em THEN
    NEW.validade_ocorrencia := OLD.validade_ocorrencia;
    NEW.validade_bloqueada_manualmente := OLD.validade_bloqueada_manualmente;
    NEW.validade_atualizada_em := OLD.validade_atualizada_em;
    NEW.validade_atualizada_por := OLD.validade_atualizada_por;
    NEW.motivo_classificacao := OLD.motivo_classificacao;
    NEW.invalidada_em := OLD.invalidada_em;
    NEW.invalidada_por := OLD.invalidada_por;
    NEW.motivo_invalidacao := OLD.motivo_invalidacao;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_risco_preservar_validade_manual
  ON public.risco_ocorrencias;
CREATE TRIGGER trg_risco_preservar_validade_manual
  BEFORE UPDATE ON public.risco_ocorrencias
  FOR EACH ROW
  EXECUTE FUNCTION public.risco_preservar_validade_manual();

CREATE OR REPLACE FUNCTION public.classificar_validade_ocorrencia_risco(
  p_ocorrencia_id UUID,
  p_validade TEXT,
  p_motivo_classificacao TEXT,
  p_justificativa TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_anterior public.risco_ocorrencias%ROWTYPE;
  v_agora TIMESTAMPTZ := clock_timestamp();
  v_justificativa TEXT := NULLIF(trim(p_justificativa), '');
  v_motivo TEXT := NULLIF(trim(p_motivo_classificacao), '');
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

  IF p_validade <> 'confirmada' THEN
    IF v_motivo IS NULL OR v_motivo NOT IN (
      'xml_incorreto',
      'arquivo_reprocessado',
      'regra_incorreta',
      'duplicidade',
      'em_analise',
      'outro'
    ) THEN
      RAISE EXCEPTION 'Informe um motivo válido para a classificação';
    END IF;

    IF v_justificativa IS NULL OR char_length(v_justificativa) < 10 THEN
      RAISE EXCEPTION 'A justificativa deve possuir ao menos 10 caracteres';
    END IF;
  ELSIF v_anterior.validade_ocorrencia <> 'confirmada'
        AND (v_justificativa IS NULL OR char_length(v_justificativa) < 10) THEN
    RAISE EXCEPTION 'Justifique a reativação da ocorrência com ao menos 10 caracteres';
  END IF;

  UPDATE public.risco_ocorrencias
  SET validade_ocorrencia = p_validade,
      validade_bloqueada_manualmente = p_validade <> 'confirmada',
      validade_atualizada_em = v_agora,
      validade_atualizada_por = auth.uid(),
      motivo_classificacao = CASE WHEN p_validade = 'confirmada' THEN NULL ELSE v_motivo END,
      invalidada_em = CASE WHEN p_validade = 'invalidada_correcao_dado' THEN v_agora ELSE NULL END,
      invalidada_por = CASE WHEN p_validade = 'invalidada_correcao_dado' THEN auth.uid() ELSE NULL END,
      motivo_invalidacao = CASE WHEN p_validade = 'confirmada' THEN NULL ELSE v_justificativa END
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
    v_justificativa,
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

REVOKE ALL ON FUNCTION public.classificar_validade_ocorrencia_risco(UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.classificar_validade_ocorrencia_risco(UUID, TEXT, TEXT, TEXT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.classificar_validade_ocorrencia_risco(UUID, TEXT, TEXT, TEXT) IS
  'Classifica manualmente a validade da ocorrência, preservando histórico, auditoria e decisão humana.';

-- A view usa expansão estática de o.*; recriá-la expõe as novas colunas ao front.
DROP VIEW IF EXISTS public.vw_risco_ocorrencias_mensais;

CREATE VIEW public.vw_risco_ocorrencias_mensais
WITH (security_invoker = true) AS
SELECT
  o.*,
  p.id AS plano_id,
  p.versao AS plano_versao,
  p.conteudo AS plano_conteudo,
  p.responsavel_nome AS plano_responsavel_nome,
  p.responsavel_email AS plano_responsavel_email,
  p.prazo AS plano_prazo,
  p.recebido_em AS plano_recebido_em,
  p.status AS plano_status,
  p.origem AS plano_origem
FROM public.risco_ocorrencias o
LEFT JOIN LATERAL (
  SELECT pa.*
  FROM public.risco_planos_acao pa
  WHERE pa.ocorrencia_id = o.id AND pa.status <> 'substituido'
  ORDER BY pa.versao DESC
  LIMIT 1
) p ON true
WHERE NOT (o.modulo = 'mercado' AND o.source_key = 'QUALIDADE_SERIE')
  AND (
    o.modulo NOT IN ('enquadramento', 'concentracao')
    OR o.fundo_isin <> ''
  );

GRANT SELECT ON public.vw_risco_ocorrencias_mensais TO authenticated;

NOTIFY pgrst, 'reload schema';
