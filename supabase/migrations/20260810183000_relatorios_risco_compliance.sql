-- Relatorios de Risco & Compliance (migration version 20260810183000)
-- Consolida ocorrencias mensais cross-modulo e mantem plano de acao,
-- comunicacoes, fechamento mensal e trilha de auditoria no mesmo dossie.

CREATE TABLE IF NOT EXISTS public.risco_ocorrencias (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competencia           DATE NOT NULL,
  modulo                TEXT NOT NULL CHECK (modulo IN ('enquadramento', 'liquidez', 'mercado', 'concentracao')),
  fundo_cnpj            TEXT NOT NULL,
  fundo_nome            TEXT NOT NULL,
  nivel                 TEXT NOT NULL CHECK (nivel IN ('atencao', 'violacao')),
  source_key            TEXT NOT NULL,
  source_table          TEXT NOT NULL,
  titulo                TEXT NOT NULL,
  descricao             TEXT,
  data_primeira         DATE NOT NULL,
  data_ultima           DATE NOT NULL,
  dias_ocorrencia       INTEGER NOT NULL DEFAULT 1 CHECK (dias_ocorrencia > 0),
  valor_pior            NUMERIC,
  limite_referencia     NUMERIC,
  unidade               TEXT,
  status_workflow       TEXT NOT NULL DEFAULT 'aberta'
                        CHECK (status_workflow IN ('aberta', 'aguardando_plano', 'em_tratamento', 'regularizada', 'encerrada')),
  notificacao_status    TEXT NOT NULL DEFAULT 'nao_enviada'
                        CHECK (notificacao_status IN ('nao_enviada', 'enviada', 'erro', 'dispensada')),
  notificacao_enviada_em TIMESTAMPTZ,
  notificacao_email_id  TEXT,
  source_payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT risco_ocorrencias_competencia_mes CHECK (competencia = date_trunc('month', competencia)::date),
  CONSTRAINT risco_ocorrencias_cnpj_check CHECK (fundo_cnpj ~ '^[0-9]{14}$'),
  CONSTRAINT risco_ocorrencias_datas_check CHECK (data_ultima >= data_primeira),
  CONSTRAINT risco_ocorrencias_source_unique UNIQUE (competencia, modulo, fundo_cnpj, source_key)
);

CREATE INDEX IF NOT EXISTS idx_risco_ocorrencias_competencia
  ON public.risco_ocorrencias (competencia DESC, nivel, modulo);
CREATE INDEX IF NOT EXISTS idx_risco_ocorrencias_fundo
  ON public.risco_ocorrencias (fundo_cnpj, data_primeira DESC);
CREATE INDEX IF NOT EXISTS idx_risco_ocorrencias_workflow
  ON public.risco_ocorrencias (competencia DESC, status_workflow);

CREATE TABLE IF NOT EXISTS public.risco_planos_acao (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ocorrencia_id         UUID NOT NULL REFERENCES public.risco_ocorrencias(id) ON DELETE CASCADE,
  versao                INTEGER NOT NULL DEFAULT 1 CHECK (versao > 0),
  origem                TEXT NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual', 'email', 'integracao')),
  conteudo              TEXT NOT NULL CHECK (length(trim(conteudo)) >= 10),
  responsavel_nome      TEXT,
  responsavel_email     TEXT,
  prazo                 DATE,
  recebido_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                TEXT NOT NULL DEFAULT 'recebido'
                        CHECK (status IN ('recebido', 'em_execucao', 'concluido', 'substituido')),
  evidencia_url         TEXT,
  email_message_id      TEXT,
  created_by            UUID REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT risco_planos_acao_versao_unique UNIQUE (ocorrencia_id, versao)
);

CREATE INDEX IF NOT EXISTS idx_risco_planos_ocorrencia
  ON public.risco_planos_acao (ocorrencia_id, versao DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_risco_planos_email_message
  ON public.risco_planos_acao (email_message_id)
  WHERE email_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.risco_ocorrencia_comunicacoes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ocorrencia_id         UUID NOT NULL REFERENCES public.risco_ocorrencias(id) ON DELETE CASCADE,
  tipo                  TEXT NOT NULL CHECK (tipo IN ('notificacao_enviada', 'resposta_recebida', 'comentario', 'evidencia', 'status_alterado')),
  canal                 TEXT NOT NULL DEFAULT 'sistema' CHECK (canal IN ('sistema', 'email', 'manual', 'integracao')),
  remetente             TEXT,
  destinatarios         TEXT[] NOT NULL DEFAULT '{}',
  assunto               TEXT,
  conteudo              TEXT,
  email_message_id      TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risco_comunicacoes_ocorrencia
  ON public.risco_ocorrencia_comunicacoes (ocorrencia_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.risco_relatorios_mensais (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competencia           DATE NOT NULL UNIQUE,
  status                TEXT NOT NULL DEFAULT 'rascunho'
                        CHECK (status IN ('rascunho', 'em_revisao', 'aprovado', 'arquivado')),
  manifestacao_diretor  TEXT,
  ressalvas             TEXT,
  preparado_por         UUID REFERENCES auth.users(id),
  aprovado_por          UUID REFERENCES auth.users(id),
  aprovado_em           TIMESTAMPTZ,
  arquivo_url           TEXT,
  snapshot              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT risco_relatorios_competencia_mes CHECK (competencia = date_trunc('month', competencia)::date)
);

CREATE TABLE IF NOT EXISTS public.risco_auditoria (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tabela                TEXT NOT NULL,
  registro_id           UUID NOT NULL,
  operacao              TEXT NOT NULL CHECK (operacao IN ('INSERT', 'UPDATE', 'DELETE')),
  dados_anteriores      JSONB,
  dados_novos           JSONB,
  alterado_por          UUID REFERENCES auth.users(id),
  alterado_em           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risco_auditoria_registro
  ON public.risco_auditoria (tabela, registro_id, alterado_em DESC);

CREATE OR REPLACE FUNCTION public.risco_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_risco_ocorrencias_updated_at ON public.risco_ocorrencias;
CREATE TRIGGER trg_risco_ocorrencias_updated_at
  BEFORE UPDATE ON public.risco_ocorrencias
  FOR EACH ROW EXECUTE FUNCTION public.risco_set_updated_at();

DROP TRIGGER IF EXISTS trg_risco_planos_updated_at ON public.risco_planos_acao;
CREATE TRIGGER trg_risco_planos_updated_at
  BEFORE UPDATE ON public.risco_planos_acao
  FOR EACH ROW EXECUTE FUNCTION public.risco_set_updated_at();

DROP TRIGGER IF EXISTS trg_risco_relatorios_updated_at ON public.risco_relatorios_mensais;
CREATE TRIGGER trg_risco_relatorios_updated_at
  BEFORE UPDATE ON public.risco_relatorios_mensais
  FOR EACH ROW EXECUTE FUNCTION public.risco_set_updated_at();

CREATE OR REPLACE FUNCTION public.risco_audit_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  v_id := COALESCE(NEW.id, OLD.id);
  INSERT INTO public.risco_auditoria (
    tabela, registro_id, operacao, dados_anteriores, dados_novos, alterado_por
  ) VALUES (
    TG_TABLE_NAME,
    v_id,
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END,
    auth.uid()
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_risco_ocorrencias_audit ON public.risco_ocorrencias;
CREATE TRIGGER trg_risco_ocorrencias_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.risco_ocorrencias
  FOR EACH ROW EXECUTE FUNCTION public.risco_audit_row();

DROP TRIGGER IF EXISTS trg_risco_planos_audit ON public.risco_planos_acao;
CREATE TRIGGER trg_risco_planos_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.risco_planos_acao
  FOR EACH ROW EXECUTE FUNCTION public.risco_audit_row();

DROP TRIGGER IF EXISTS trg_risco_relatorios_audit ON public.risco_relatorios_mensais;
CREATE TRIGGER trg_risco_relatorios_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.risco_relatorios_mensais
  FOR EACH ROW EXECUTE FUNCTION public.risco_audit_row();

CREATE OR REPLACE FUNCTION public.risco_usuario_pode_editar()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1
      FROM public.user_profiles p
      WHERE p.id = auth.uid()
        AND p.is_active = true
        AND p.access_type = 'completo'
    );
$$;

ALTER TABLE public.risco_ocorrencias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risco_planos_acao ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risco_ocorrencia_comunicacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risco_relatorios_mensais ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risco_auditoria ENABLE ROW LEVEL SECURITY;

CREATE POLICY risco_ocorrencias_select ON public.risco_ocorrencias
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY risco_ocorrencias_write ON public.risco_ocorrencias
  FOR ALL USING (public.risco_usuario_pode_editar()) WITH CHECK (public.risco_usuario_pode_editar());
CREATE POLICY risco_planos_select ON public.risco_planos_acao
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY risco_planos_write ON public.risco_planos_acao
  FOR ALL USING (public.risco_usuario_pode_editar()) WITH CHECK (public.risco_usuario_pode_editar());
CREATE POLICY risco_comunicacoes_select ON public.risco_ocorrencia_comunicacoes
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY risco_comunicacoes_write ON public.risco_ocorrencia_comunicacoes
  FOR ALL USING (public.risco_usuario_pode_editar()) WITH CHECK (public.risco_usuario_pode_editar());
CREATE POLICY risco_relatorios_select ON public.risco_relatorios_mensais
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY risco_relatorios_write ON public.risco_relatorios_mensais
  FOR ALL USING (public.risco_usuario_pode_editar()) WITH CHECK (public.risco_usuario_pode_editar());
CREATE POLICY risco_auditoria_select ON public.risco_auditoria
  FOR SELECT USING (auth.role() = 'authenticated');

-- Sincroniza uma competencia sem apagar informacao enriquecida pelo usuario.
-- Ocorrencias recorrentes no mesmo mes, fundo, modulo e regra viram um unico caso,
-- preservando primeira/ultima data e quantidade de dias afetados.
CREATE OR REPLACE FUNCTION public.sincronizar_ocorrencias_risco(p_competencia DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_competencia DATE := date_trunc('month', p_competencia)::date;
  v_fim DATE := (date_trunc('month', p_competencia) + interval '1 month - 1 day')::date;
  v_total INTEGER := 0;
BEGIN
  IF auth.role() NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'Acesso nao autorizado';
  END IF;

  WITH nomes AS (
    SELECT DISTINCT ON (regexp_replace(fundo_cnpj, '\D', '', 'g'))
      regexp_replace(fundo_cnpj, '\D', '', 'g') AS cnpj,
      COALESCE(NULLIF(trim(nome_fundo), ''), NULLIF(trim(fundo_nome), ''), regexp_replace(fundo_cnpj, '\D', '', 'g')) AS nome
    FROM public.posicao_carteira
    WHERE fundo_cnpj IS NOT NULL
    ORDER BY regexp_replace(fundo_cnpj, '\D', '', 'g'), fundo_dtposicao DESC NULLS LAST
  ),
  enquadramento AS (
    SELECT
      v_competencia AS competencia,
      CASE
        WHEN lower(regra_categoria) IN ('concentration', 'fidc-concentracao') THEN 'concentracao'
        ELSE 'enquadramento'
      END AS modulo,
      regexp_replace(fundo_cnpj, '\D', '', 'g') AS fundo_cnpj,
      COALESCE(max(n.nome), regexp_replace(e.fundo_cnpj, '\D', '', 'g')) AS fundo_nome,
      CASE WHEN bool_or(e.status = 'violacao') THEN 'violacao' ELSE 'atencao' END AS nivel,
      e.regra_codigo AS source_key,
      'enquadramento_resultado'::text AS source_table,
      COALESCE(max(e.regra_descricao), e.regra_codigo) AS titulo,
      max(e.regra_descricao) AS descricao,
      min(to_date(e.fundo_dtposicao, 'YYYYMMDD')) AS data_primeira,
      max(to_date(e.fundo_dtposicao, 'YYYYMMDD')) AS data_ultima,
      count(DISTINCT e.fundo_dtposicao)::integer AS dias_ocorrencia,
      max(e.valor_atual) AS valor_pior,
      max(e.valor_limite) AS limite_referencia,
      'indice'::text AS unidade,
      jsonb_build_object('categoria', e.regra_categoria, 'regra', e.regra_codigo) AS source_payload
    FROM public.enquadramento_resultado e
    LEFT JOIN nomes n ON n.cnpj = regexp_replace(e.fundo_cnpj, '\D', '', 'g')
    WHERE e.status IN ('alerta', 'violacao')
      AND e.fundo_dtposicao ~ '^[0-9]{8}$'
      AND to_date(e.fundo_dtposicao, 'YYYYMMDD') BETWEEN v_competencia AND v_fim
    GROUP BY regexp_replace(e.fundo_cnpj, '\D', '', 'g'), e.regra_categoria, e.regra_codigo
  ),
  liquidez AS (
    SELECT
      v_competencia AS competencia,
      'liquidez'::text AS modulo,
      regexp_replace(l.fundo_cnpj, '\D', '', 'g') AS fundo_cnpj,
      COALESCE(max(n.nome), regexp_replace(l.fundo_cnpj, '\D', '', 'g')) AS fundo_nome,
      CASE WHEN bool_or(l.status = 'violacao') THEN 'violacao' ELSE 'atencao' END AS nivel,
      'LIQUIDEZ_' || CASE WHEN l.is_fundo_fechado THEN 'COBERTURA' ELSE 'RESGATE' END AS source_key,
      'liquidez_monitoramento_risco'::text AS source_table,
      CASE WHEN l.is_fundo_fechado THEN 'Cobertura operacional de liquidez' ELSE 'Índice de liquidez para resgates' END AS titulo,
      CASE WHEN l.is_fundo_fechado THEN 'Cobertura de despesas abaixo do parâmetro.' ELSE 'Disponibilidade incompatível com o prazo de resgate.' END AS descricao,
      min(to_date(l.dt_posicao, 'YYYYMMDD')) AS data_primeira,
      max(to_date(l.dt_posicao, 'YYYYMMDD')) AS data_ultima,
      count(DISTINCT l.dt_posicao)::integer AS dias_ocorrencia,
      min(CASE WHEN l.is_fundo_fechado THEN l.meses_cobertura ELSE l.indice_liquidez END) AS valor_pior,
      NULL::numeric AS limite_referencia,
      CASE WHEN l.is_fundo_fechado THEN 'meses' ELSE 'indice' END AS unidade,
      jsonb_build_object('fundo_fechado', l.is_fundo_fechado) AS source_payload
    FROM public.liquidez_monitoramento_risco l
    LEFT JOIN nomes n ON n.cnpj = regexp_replace(l.fundo_cnpj, '\D', '', 'g')
    WHERE l.status IN ('alerta', 'violacao')
      AND l.dt_posicao ~ '^[0-9]{8}$'
      AND to_date(l.dt_posicao, 'YYYYMMDD') BETWEEN v_competencia AND v_fim
    GROUP BY regexp_replace(l.fundo_cnpj, '\D', '', 'g'), l.is_fundo_fechado
  ),
  mercado_cota_cdi AS (
    SELECT
      v_competencia AS competencia,
      'mercado'::text AS modulo,
      regexp_replace(r.cnpj, '\D', '', 'g') AS fundo_cnpj,
      COALESCE(max(NULLIF(trim(r.nome_fundo), '')), max(n.nome), regexp_replace(r.cnpj, '\D', '', 'g')) AS fundo_nome,
      'atencao'::text AS nivel,
      'COTA_CDI_2000'::text AS source_key,
      'risco_mercado_fundos_diario'::text AS source_table,
      'Oscilação da cota superior a 2.000% do CDI/dia'::text AS titulo,
      'Gatilho de monitoramento de mercado que requer análise e registro da tratativa.'::text AS descricao,
      min(r.data_ref) AS data_primeira,
      max(r.data_ref) AS data_ultima,
      count(DISTINCT r.data_ref)::integer AS dias_ocorrencia,
      max(r.relacao_cota_cdi) AS valor_pior,
      20::numeric AS limite_referencia,
      'multiplo_cdi'::text AS unidade,
      jsonb_build_object('metrica', 'relacao_cota_cdi') AS source_payload
    FROM public.risco_mercado_fundos_diario r
    LEFT JOIN nomes n ON n.cnpj = regexp_replace(r.cnpj, '\D', '', 'g')
    WHERE r.data_ref BETWEEN v_competencia AND v_fim
      AND r.status_cota_cdi = 'atencao'
    GROUP BY regexp_replace(r.cnpj, '\D', '', 'g')
  ),
  mercado_qualidade AS (
    SELECT
      v_competencia AS competencia,
      'mercado'::text AS modulo,
      regexp_replace(r.cnpj, '\D', '', 'g') AS fundo_cnpj,
      COALESCE(max(NULLIF(trim(r.nome_fundo), '')), max(n.nome), regexp_replace(r.cnpj, '\D', '', 'g')) AS fundo_nome,
      'atencao'::text AS nivel,
      'QUALIDADE_SERIE'::text AS source_key,
      'risco_mercado_fundos_diario'::text AS source_table,
      'Qualidade da série de cotas requer validação'::text AS titulo,
      'A série apresentou um ou mais gatilhos de qualidade que podem afetar a leitura das métricas.'::text AS descricao,
      min(r.data_ref) AS data_primeira,
      max(r.data_ref) AS data_ultima,
      count(DISTINCT r.data_ref)::integer AS dias_ocorrencia,
      NULL::numeric AS valor_pior,
      NULL::numeric AS limite_referencia,
      NULL::text AS unidade,
      jsonb_build_object('metrica', 'qualidade_serie_status') AS source_payload
    FROM public.risco_mercado_fundos_diario r
    LEFT JOIN nomes n ON n.cnpj = regexp_replace(r.cnpj, '\D', '', 'g')
    WHERE r.data_ref BETWEEN v_competencia AND v_fim
      AND r.qualidade_serie_status = 'suspeita'
    GROUP BY regexp_replace(r.cnpj, '\D', '', 'g')
  ),
  fontes AS (
    SELECT * FROM enquadramento
    UNION ALL SELECT * FROM liquidez
    UNION ALL SELECT * FROM mercado_cota_cdi
    UNION ALL SELECT * FROM mercado_qualidade
  ),
  gravadas AS (
    INSERT INTO public.risco_ocorrencias (
      competencia, modulo, fundo_cnpj, fundo_nome, nivel, source_key, source_table,
      titulo, descricao, data_primeira, data_ultima, dias_ocorrencia, valor_pior,
      limite_referencia, unidade, status_workflow, source_payload
    )
    SELECT
      competencia, modulo, fundo_cnpj, fundo_nome, nivel, source_key, source_table,
      titulo, descricao, data_primeira, data_ultima, dias_ocorrencia, valor_pior,
      limite_referencia, unidade,
      CASE WHEN nivel = 'violacao' THEN 'aguardando_plano' ELSE 'aberta' END,
      source_payload
    FROM fontes
    WHERE length(fundo_cnpj) = 14
    ON CONFLICT (competencia, modulo, fundo_cnpj, source_key) DO UPDATE SET
      fundo_nome = EXCLUDED.fundo_nome,
      nivel = EXCLUDED.nivel,
      titulo = EXCLUDED.titulo,
      descricao = EXCLUDED.descricao,
      data_primeira = EXCLUDED.data_primeira,
      data_ultima = EXCLUDED.data_ultima,
      dias_ocorrencia = EXCLUDED.dias_ocorrencia,
      valor_pior = EXCLUDED.valor_pior,
      limite_referencia = EXCLUDED.limite_referencia,
      unidade = EXCLUDED.unidade,
      source_payload = EXCLUDED.source_payload,
      updated_at = now()
    RETURNING id
  )
  SELECT count(*) INTO v_total FROM gravadas;

  UPDATE public.risco_ocorrencias o
  SET
    notificacao_status = 'enviada',
    notificacao_enviada_em = (
      SELECT e.created_at FROM public.envios_notificacao_desenquadramento e
      WHERE e.status = 'enviado' AND e.data_referencia ~ '^[0-9]{8}$'
        AND to_date(e.data_referencia, 'YYYYMMDD') BETWEEN o.data_primeira AND o.data_ultima
      ORDER BY e.created_at DESC LIMIT 1
    ),
    notificacao_email_id = (
      SELECT e.email_id FROM public.envios_notificacao_desenquadramento e
      WHERE e.status = 'enviado' AND e.data_referencia ~ '^[0-9]{8}$'
        AND to_date(e.data_referencia, 'YYYYMMDD') BETWEEN o.data_primeira AND o.data_ultima
      ORDER BY e.created_at DESC LIMIT 1
    )
  WHERE o.competencia = v_competencia
    AND o.modulo IN ('enquadramento', 'concentracao')
    AND o.notificacao_status = 'nao_enviada'
    AND EXISTS (
      SELECT 1 FROM public.envios_notificacao_desenquadramento e
      WHERE e.status = 'enviado' AND e.data_referencia ~ '^[0-9]{8}$'
        AND to_date(e.data_referencia, 'YYYYMMDD') BETWEEN o.data_primeira AND o.data_ultima
    );

  UPDATE public.risco_ocorrencias o
  SET
    notificacao_status = 'enviada',
    notificacao_enviada_em = (
      SELECT e.created_at FROM public.envios_notificacao_liquidez e
      WHERE e.status = 'enviado'
        AND regexp_replace(COALESCE(e.fundo_cnpj, ''), '\D', '', 'g') = o.fundo_cnpj
        AND e.data_referencia ~ '^[0-9]{8}$'
        AND to_date(e.data_referencia, 'YYYYMMDD') BETWEEN o.data_primeira AND o.data_ultima
      ORDER BY e.created_at DESC LIMIT 1
    ),
    notificacao_email_id = (
      SELECT e.email_id FROM public.envios_notificacao_liquidez e
      WHERE e.status = 'enviado'
        AND regexp_replace(COALESCE(e.fundo_cnpj, ''), '\D', '', 'g') = o.fundo_cnpj
        AND e.data_referencia ~ '^[0-9]{8}$'
        AND to_date(e.data_referencia, 'YYYYMMDD') BETWEEN o.data_primeira AND o.data_ultima
      ORDER BY e.created_at DESC LIMIT 1
    )
  WHERE o.competencia = v_competencia
    AND o.modulo = 'liquidez'
    AND o.notificacao_status = 'nao_enviada'
    AND EXISTS (
      SELECT 1 FROM public.envios_notificacao_liquidez e
      WHERE e.status = 'enviado'
        AND regexp_replace(COALESCE(e.fundo_cnpj, ''), '\D', '', 'g') = o.fundo_cnpj
        AND e.data_referencia ~ '^[0-9]{8}$'
        AND to_date(e.data_referencia, 'YYYYMMDD') BETWEEN o.data_primeira AND o.data_ultima
    );

  INSERT INTO public.risco_relatorios_mensais (competencia, preparado_por, created_by)
  VALUES (v_competencia, auth.uid(), auth.uid())
  ON CONFLICT (competencia) DO NOTHING;

  RETURN jsonb_build_object(
    'competencia', v_competencia,
    'ocorrencias_sincronizadas', v_total,
    'sincronizado_em', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.sincronizar_ocorrencias_risco(DATE) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.salvar_plano_acao_risco(
  p_ocorrencia_id UUID,
  p_conteudo TEXT,
  p_responsavel_nome TEXT DEFAULT NULL,
  p_responsavel_email TEXT DEFAULT NULL,
  p_prazo DATE DEFAULT NULL,
  p_origem TEXT DEFAULT 'manual'
)
RETURNS public.risco_planos_acao
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_versao INTEGER;
  v_plano public.risco_planos_acao;
BEGIN
  IF NOT public.risco_usuario_pode_editar() THEN
    RAISE EXCEPTION 'Usuario sem permissao para editar planos de acao';
  END IF;
  IF length(trim(COALESCE(p_conteudo, ''))) < 10 THEN
    RAISE EXCEPTION 'O plano de acao deve ter pelo menos 10 caracteres';
  END IF;
  IF p_origem NOT IN ('manual', 'email', 'integracao') THEN
    RAISE EXCEPTION 'Origem de plano invalida';
  END IF;

  PERFORM 1 FROM public.risco_ocorrencias WHERE id = p_ocorrencia_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ocorrencia nao encontrada';
  END IF;

  SELECT COALESCE(max(versao), 0) + 1
  INTO v_versao
  FROM public.risco_planos_acao
  WHERE ocorrencia_id = p_ocorrencia_id;

  UPDATE public.risco_planos_acao
  SET status = 'substituido'
  WHERE ocorrencia_id = p_ocorrencia_id
    AND status <> 'substituido';

  INSERT INTO public.risco_planos_acao (
    ocorrencia_id, versao, origem, conteudo, responsavel_nome,
    responsavel_email, prazo, created_by
  ) VALUES (
    p_ocorrencia_id, v_versao, p_origem, trim(p_conteudo),
    NULLIF(trim(p_responsavel_nome), ''), NULLIF(trim(p_responsavel_email), ''),
    p_prazo, auth.uid()
  ) RETURNING * INTO v_plano;

  UPDATE public.risco_ocorrencias
  SET status_workflow = 'em_tratamento'
  WHERE id = p_ocorrencia_id
    AND status_workflow IN ('aberta', 'aguardando_plano');

  INSERT INTO public.risco_ocorrencia_comunicacoes (
    ocorrencia_id, tipo, canal, remetente, assunto, conteudo, created_by, metadata
  ) VALUES (
    p_ocorrencia_id,
    CASE WHEN p_origem = 'email' THEN 'resposta_recebida' ELSE 'comentario' END,
    p_origem,
    NULLIF(trim(p_responsavel_email), ''),
    'Plano de ação recebido — versão ' || v_versao,
    trim(p_conteudo),
    auth.uid(),
    jsonb_build_object('plano_id', v_plano.id, 'versao', v_versao)
  );

  RETURN v_plano;
END;
$$;

GRANT EXECUTE ON FUNCTION public.salvar_plano_acao_risco(UUID, TEXT, TEXT, TEXT, DATE, TEXT)
  TO authenticated, service_role;

CREATE OR REPLACE VIEW public.vw_risco_ocorrencias_mensais
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
  WHERE pa.ocorrencia_id = o.id
    AND pa.status <> 'substituido'
  ORDER BY pa.versao DESC
  LIMIT 1
) p ON true;

COMMENT ON TABLE public.risco_ocorrencias IS
  'Caso mensal consolidado por fundo, modulo e regra. Nao e fotografia do ultimo dia.';
COMMENT ON TABLE public.risco_planos_acao IS
  'Versoes do plano de acao vinculadas a uma ocorrencia de risco.';
COMMENT ON TABLE public.risco_ocorrencia_comunicacoes IS
  'Timeline de notificacoes, respostas, comentarios e evidencias do caso.';
COMMENT ON TABLE public.risco_relatorios_mensais IS
  'Controle de preparacao, revisao, aprovacao e arquivamento do relatorio mensal.';
