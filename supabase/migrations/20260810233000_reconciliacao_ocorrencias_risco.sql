-- Reconcilia ocorrencias mensais sem apagar o historico operacional.
-- Validade da ocorrencia e andamento do caso sao dimensoes independentes.

CREATE TABLE IF NOT EXISTS public.risco_sincronizacoes (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competencia                DATE NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'em_processamento'
                             CHECK (status IN ('em_processamento', 'concluida', 'erro')),
  modulos_processados        TEXT[] NOT NULL DEFAULT '{}',
  ocorrencias_encontradas    INTEGER NOT NULL DEFAULT 0,
  ocorrencias_regularizadas  INTEGER NOT NULL DEFAULT 0,
  ocorrencias_invalidadas    INTEGER NOT NULL DEFAULT 0,
  ocorrencias_em_revisao     INTEGER NOT NULL DEFAULT 0,
  detalhes                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  erro                       TEXT,
  iniciado_em                TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em               TIMESTAMPTZ,
  created_by                 UUID REFERENCES auth.users(id),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT risco_sincronizacoes_competencia_mes
    CHECK (competencia = date_trunc('month', competencia)::date)
);

CREATE INDEX IF NOT EXISTS idx_risco_sincronizacoes_competencia
  ON public.risco_sincronizacoes (competencia DESC, iniciado_em DESC);

ALTER TABLE public.risco_ocorrencias
  ADD COLUMN IF NOT EXISTS validade_ocorrencia TEXT NOT NULL DEFAULT 'confirmada',
  ADD COLUMN IF NOT EXISTS invalidada_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invalidada_por UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS motivo_invalidacao TEXT,
  ADD COLUMN IF NOT EXISTS ultima_sincronizacao_id UUID
    REFERENCES public.risco_sincronizacoes(id) ON DELETE SET NULL;

ALTER TABLE public.risco_ocorrencias
  DROP CONSTRAINT IF EXISTS risco_ocorrencias_validade_check;

ALTER TABLE public.risco_ocorrencias
  ADD CONSTRAINT risco_ocorrencias_validade_check
  CHECK (validade_ocorrencia IN ('confirmada', 'em_revisao', 'invalidada_correcao_dado'));

CREATE INDEX IF NOT EXISTS idx_risco_ocorrencias_competencia_validade
  ON public.risco_ocorrencias (competencia DESC, validade_ocorrencia, modulo);

ALTER TABLE public.risco_sincronizacoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY risco_sincronizacoes_select ON public.risco_sincronizacoes
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY risco_sincronizacoes_write ON public.risco_sincronizacoes
  FOR ALL
  USING (public.risco_usuario_pode_editar())
  WITH CHECK (public.risco_usuario_pode_editar());

GRANT SELECT, INSERT, UPDATE ON public.risco_sincronizacoes TO authenticated;

DROP TRIGGER IF EXISTS trg_risco_sincronizacoes_updated_at ON public.risco_sincronizacoes;
CREATE TRIGGER trg_risco_sincronizacoes_updated_at
  BEFORE UPDATE ON public.risco_sincronizacoes
  FOR EACH ROW EXECUTE FUNCTION public.risco_set_updated_at();

DROP TRIGGER IF EXISTS trg_risco_sincronizacoes_audit ON public.risco_sincronizacoes;
CREATE TRIGGER trg_risco_sincronizacoes_audit
  AFTER INSERT OR UPDATE ON public.risco_sincronizacoes
  FOR EACH ROW EXECUTE FUNCTION public.risco_audit_row();

CREATE OR REPLACE FUNCTION public.risco_impedir_exclusao()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Exclusao nao permitida em %. O historico de risco deve ser preservado.', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_risco_ocorrencias_no_delete ON public.risco_ocorrencias;
CREATE TRIGGER trg_risco_ocorrencias_no_delete
  BEFORE DELETE ON public.risco_ocorrencias
  FOR EACH ROW EXECUTE FUNCTION public.risco_impedir_exclusao();

DROP TRIGGER IF EXISTS trg_risco_planos_no_delete ON public.risco_planos_acao;
CREATE TRIGGER trg_risco_planos_no_delete
  BEFORE DELETE ON public.risco_planos_acao
  FOR EACH ROW EXECUTE FUNCTION public.risco_impedir_exclusao();

DROP TRIGGER IF EXISTS trg_risco_comunicacoes_no_delete ON public.risco_ocorrencia_comunicacoes;
CREATE TRIGGER trg_risco_comunicacoes_no_delete
  BEFORE DELETE ON public.risco_ocorrencia_comunicacoes
  FOR EACH ROW EXECUTE FUNCTION public.risco_impedir_exclusao();

DROP TRIGGER IF EXISTS trg_risco_auditoria_no_delete ON public.risco_auditoria;
CREATE TRIGGER trg_risco_auditoria_no_delete
  BEFORE DELETE ON public.risco_auditoria
  FOR EACH ROW EXECUTE FUNCTION public.risco_impedir_exclusao();

CREATE OR REPLACE FUNCTION public.reconciliar_ocorrencias_risco(
  p_competencia DATE,
  p_sincronizacao_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_competencia DATE := date_trunc('month', p_competencia)::date;
  v_fim DATE := (date_trunc('month', p_competencia) + interval '1 month - 1 day')::date;
  v_inicio_texto TEXT := to_char(date_trunc('month', p_competencia)::date, 'YYYYMMDD');
  v_fim_texto TEXT := to_char((date_trunc('month', p_competencia) + interval '1 month - 1 day')::date, 'YYYYMMDD');
  v_encontradas INTEGER := 0;
  v_invalidadas INTEGER := 0;
  v_em_revisao INTEGER := 0;
  v_regularizadas INTEGER := 0;
BEGIN
  IF auth.role() NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'Acesso nao autorizado';
  END IF;

  -- Uma ocorrencia e encontrada quando a violacao original continua presente
  -- em qualquer posicao da competencia, usando a chave propria de cada modulo.
  WITH encontradas AS (
    SELECT o.id
    FROM public.risco_ocorrencias o
    WHERE o.competencia = v_competencia
      AND (
        (
          o.modulo IN ('enquadramento', 'concentracao')
          AND EXISTS (
            SELECT 1
            FROM public.enquadramento_resultado e
            WHERE regexp_replace(e.fundo_cnpj, '\D', '', 'g') = o.fundo_cnpj
              AND upper(trim(COALESCE(e.fundo_isin, ''))) = upper(trim(COALESCE(o.fundo_isin, '')))
              AND e.regra_codigo = split_part(o.source_key, '|', 1)
              AND CASE
                    WHEN lower(e.regra_categoria) IN ('concentration', 'fidc-concentracao')
                      THEN 'concentracao'
                    ELSE 'enquadramento'
                  END = o.modulo
              AND e.status IN ('alerta', 'violacao')
              AND e.fundo_dtposicao BETWEEN v_inicio_texto AND v_fim_texto
          )
        )
        OR (
          o.modulo = 'liquidez'
          AND EXISTS (
            SELECT 1
            FROM public.liquidez_monitoramento_risco l
            WHERE regexp_replace(l.fundo_cnpj, '\D', '', 'g') = o.fundo_cnpj
              AND 'LIQUIDEZ_' || CASE WHEN l.is_fundo_fechado THEN 'COBERTURA' ELSE 'RESGATE' END = o.source_key
              AND l.status IN ('alerta', 'violacao')
              AND l.dt_posicao BETWEEN v_inicio_texto AND v_fim_texto
          )
        )
        OR (
          o.modulo = 'mercado'
          AND o.source_key = 'COTA_CDI_2000'
          AND EXISTS (
            SELECT 1
            FROM public.risco_mercado_fundos_diario r
            WHERE regexp_replace(r.cnpj, '\D', '', 'g') = o.fundo_cnpj
              AND r.status_cota_cdi = 'atencao'
              AND r.data_ref BETWEEN v_competencia AND v_fim
          )
        )
      )
  ), marcadas AS (
    UPDATE public.risco_ocorrencias o
    SET validade_ocorrencia = 'confirmada',
        invalidada_em = NULL,
        invalidada_por = NULL,
        motivo_invalidacao = NULL,
        ultima_sincronizacao_id = p_sincronizacao_id
    FROM encontradas e
    WHERE o.id = e.id
    RETURNING o.id
  )
  SELECT count(*) INTO v_encontradas FROM marcadas;

  -- Se a violacao deixou de existir, so invalida quando existe uma posicao
  -- corrigida para a mesma regra e dentro do intervalo original. Sem essa
  -- evidencia, mantem a ocorrencia para analise humana como em_revisao.
  WITH ausentes AS (
    SELECT
      o.id,
      CASE WHEN
        (
          o.modulo IN ('enquadramento', 'concentracao')
          AND EXISTS (
            SELECT 1
            FROM public.enquadramento_resultado e
            WHERE regexp_replace(e.fundo_cnpj, '\D', '', 'g') = o.fundo_cnpj
              AND upper(trim(COALESCE(e.fundo_isin, ''))) = upper(trim(COALESCE(o.fundo_isin, '')))
              AND e.regra_codigo = split_part(o.source_key, '|', 1)
              AND CASE
                    WHEN lower(e.regra_categoria) IN ('concentration', 'fidc-concentracao')
                      THEN 'concentracao'
                    ELSE 'enquadramento'
                  END = o.modulo
              AND e.fundo_dtposicao BETWEEN to_char(o.data_primeira, 'YYYYMMDD')
                                          AND to_char(o.data_ultima, 'YYYYMMDD')
          )
        )
        OR (
          o.modulo = 'liquidez'
          AND EXISTS (
            SELECT 1
            FROM public.liquidez_monitoramento_risco l
            WHERE regexp_replace(l.fundo_cnpj, '\D', '', 'g') = o.fundo_cnpj
              AND 'LIQUIDEZ_' || CASE WHEN l.is_fundo_fechado THEN 'COBERTURA' ELSE 'RESGATE' END = o.source_key
              AND l.dt_posicao BETWEEN to_char(o.data_primeira, 'YYYYMMDD')
                                    AND to_char(o.data_ultima, 'YYYYMMDD')
          )
        )
        OR (
          o.modulo = 'mercado'
          AND EXISTS (
            SELECT 1
            FROM public.risco_mercado_fundos_diario r
            WHERE regexp_replace(r.cnpj, '\D', '', 'g') = o.fundo_cnpj
              AND r.data_ref BETWEEN o.data_primeira AND o.data_ultima
          )
        )
        THEN 'invalidada_correcao_dado'
        ELSE 'em_revisao'
      END AS nova_validade
    FROM public.risco_ocorrencias o
    WHERE o.competencia = v_competencia
      AND o.ultima_sincronizacao_id IS DISTINCT FROM p_sincronizacao_id
  ), alteradas AS (
    UPDATE public.risco_ocorrencias o
    SET validade_ocorrencia = a.nova_validade,
        invalidada_em = CASE WHEN a.nova_validade = 'invalidada_correcao_dado' THEN now() ELSE NULL END,
        invalidada_por = CASE WHEN a.nova_validade = 'invalidada_correcao_dado' THEN auth.uid() ELSE NULL END,
        motivo_invalidacao = CASE
          WHEN a.nova_validade = 'invalidada_correcao_dado'
            THEN 'A violacao deixou de existir apos correcao dos dados da mesma data e regra.'
          ELSE 'A ocorrencia nao foi reencontrada e ainda nao ha evidencia suficiente para invalidacao automatica.'
        END
    FROM ausentes a
    WHERE o.id = a.id
      AND o.validade_ocorrencia IS DISTINCT FROM a.nova_validade
    RETURNING o.validade_ocorrencia
  )
  SELECT
    count(*) FILTER (WHERE validade_ocorrencia = 'invalidada_correcao_dado'),
    count(*) FILTER (WHERE validade_ocorrencia = 'em_revisao')
  INTO v_invalidadas, v_em_revisao
  FROM alteradas;

  -- A validade continua confirmada quando a violacao historica permanece na
  -- fonte. Uma posicao OK posterior altera somente o andamento do workflow.
  WITH regularizaveis AS (
    SELECT o.id
    FROM public.risco_ocorrencias o
    WHERE o.competencia = v_competencia
      AND o.validade_ocorrencia = 'confirmada'
      AND o.status_workflow NOT IN ('regularizada', 'encerrada')
      AND (
        (
          o.modulo IN ('enquadramento', 'concentracao')
          AND EXISTS (
            SELECT 1
            FROM public.enquadramento_resultado e
            WHERE regexp_replace(e.fundo_cnpj, '\D', '', 'g') = o.fundo_cnpj
              AND upper(trim(COALESCE(e.fundo_isin, ''))) = upper(trim(COALESCE(o.fundo_isin, '')))
              AND e.regra_codigo = split_part(o.source_key, '|', 1)
              AND CASE
                    WHEN lower(e.regra_categoria) IN ('concentration', 'fidc-concentracao')
                      THEN 'concentracao'
                    ELSE 'enquadramento'
                  END = o.modulo
              AND e.status = 'ok'
              AND e.fundo_dtposicao > to_char(o.data_ultima, 'YYYYMMDD')
              AND e.fundo_dtposicao <= v_fim_texto
          )
        )
        OR (
          o.modulo = 'liquidez'
          AND EXISTS (
            SELECT 1
            FROM public.liquidez_monitoramento_risco l
            WHERE regexp_replace(l.fundo_cnpj, '\D', '', 'g') = o.fundo_cnpj
              AND 'LIQUIDEZ_' || CASE WHEN l.is_fundo_fechado THEN 'COBERTURA' ELSE 'RESGATE' END = o.source_key
              AND l.status = 'ok'
              AND l.dt_posicao > to_char(o.data_ultima, 'YYYYMMDD')
              AND l.dt_posicao <= v_fim_texto
          )
        )
        OR (
          o.modulo = 'mercado'
          AND EXISTS (
            SELECT 1
            FROM public.risco_mercado_fundos_diario r
            WHERE regexp_replace(r.cnpj, '\D', '', 'g') = o.fundo_cnpj
              AND r.status_cota_cdi = 'ok'
              AND r.data_ref > o.data_ultima
              AND r.data_ref <= v_fim
          )
        )
      )
  ), regularizadas AS (
    UPDATE public.risco_ocorrencias o
    SET status_workflow = 'regularizada'
    FROM regularizaveis r
    WHERE o.id = r.id
    RETURNING o.id
  )
  SELECT count(*) INTO v_regularizadas FROM regularizadas;

  RETURN jsonb_build_object(
    'ocorrencias_encontradas', v_encontradas,
    'ocorrencias_regularizadas', v_regularizadas,
    'ocorrencias_invalidadas', v_invalidadas,
    'ocorrencias_em_revisao', v_em_revisao
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconciliar_ocorrencias_risco(DATE, UUID)
  FROM PUBLIC, authenticated;

CREATE OR REPLACE FUNCTION public.sincronizar_ocorrencias_risco(p_competencia DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  -- A transacao so chega a reconciliacao quando todos os modulos concluem.
  -- Qualquer falha aborta o lote e impede invalidacoes parciais.
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

COMMENT ON COLUMN public.risco_ocorrencias.validade_ocorrencia IS
  'Validade da evidencia: confirmada, em revisao ou invalidada por correcao de dado. Independente do workflow.';

COMMENT ON FUNCTION public.sincronizar_ocorrencias_risco(DATE) IS
  'Sincroniza e reconcilia ocorrencias por competencia, sem excluir historico e sem invalidacao parcial por falha de modulo.';

NOTIFY pgrst, 'reload schema';
