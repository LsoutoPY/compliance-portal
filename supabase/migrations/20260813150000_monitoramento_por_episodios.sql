-- Monitoramento operacional por episódios.
-- O relatório mensal continua usando risco_ocorrencias; esta estrutura é a fonte
-- de verdade da fila de Compliance e não duplica um caso a cada competência.

CREATE TABLE IF NOT EXISTS public.risco_episodios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chave_episodio TEXT NOT NULL UNIQUE,
  modulo TEXT NOT NULL CHECK (modulo IN ('enquadramento', 'liquidez', 'mercado', 'concentracao')),
  fundo_cnpj TEXT NOT NULL CHECK (fundo_cnpj ~ '^[0-9]{14}$'),
  fundo_isin TEXT NOT NULL DEFAULT '',
  fundo_nome TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_table TEXT NOT NULL,
  titulo TEXT NOT NULL,
  descricao TEXT,
  nivel_atual TEXT NOT NULL CHECK (nivel_atual IN ('atencao', 'violacao')),
  violacao_detectada BOOLEAN NOT NULL DEFAULT false,
  data_inicio DATE NOT NULL,
  data_ultima_evidencia DATE NOT NULL,
  data_regularizacao DATE,
  dias_com_evidencia INTEGER NOT NULL DEFAULT 1 CHECK (dias_com_evidencia > 0),
  valor_atual NUMERIC,
  valor_pior NUMERIC,
  limite_referencia NUMERIC,
  unidade TEXT,
  status_workflow TEXT NOT NULL DEFAULT 'aberta'
    CHECK (status_workflow IN ('aberta', 'aguardando_plano', 'em_tratamento', 'regularizada', 'encerrada')),
  validade_ocorrencia TEXT NOT NULL DEFAULT 'confirmada'
    CHECK (validade_ocorrencia IN ('confirmada', 'em_revisao', 'invalidada_correcao_dado')),
  source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT risco_episodios_datas_check CHECK (
    data_ultima_evidencia >= data_inicio
    AND (data_regularizacao IS NULL OR data_regularizacao >= data_ultima_evidencia)
  )
);

CREATE INDEX IF NOT EXISTS idx_risco_episodios_monitoramento
  ON public.risco_episodios (status_workflow, nivel_atual, data_inicio DESC);
CREATE INDEX IF NOT EXISTS idx_risco_episodios_identidade
  ON public.risco_episodios (modulo, fundo_cnpj, fundo_isin, source_key, data_inicio DESC);

CREATE TABLE IF NOT EXISTS public.risco_episodio_planos_acao (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episodio_id UUID NOT NULL REFERENCES public.risco_episodios(id) ON DELETE CASCADE,
  versao INTEGER NOT NULL CHECK (versao > 0),
  origem TEXT NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual', 'email', 'integracao')),
  conteudo TEXT NOT NULL CHECK (length(trim(conteudo)) >= 10),
  responsavel_nome TEXT,
  responsavel_email TEXT,
  prazo DATE,
  recebido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'recebido'
    CHECK (status IN ('recebido', 'em_execucao', 'concluido', 'substituido')),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (episodio_id, versao)
);

CREATE INDEX IF NOT EXISTS idx_risco_episodio_planos_atual
  ON public.risco_episodio_planos_acao (episodio_id, versao DESC);

CREATE TABLE IF NOT EXISTS public.risco_episodio_comunicacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episodio_id UUID NOT NULL REFERENCES public.risco_episodios(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('notificacao_inicial', 'cobranca_prazo_vencido', 'resposta_recebida', 'comentario', 'evidencia')),
  canal TEXT NOT NULL DEFAULT 'sistema' CHECK (canal IN ('sistema', 'email', 'manual', 'integracao')),
  assunto TEXT,
  conteudo TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risco_episodio_comunicacoes_timeline
  ON public.risco_episodio_comunicacoes (episodio_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.risco_episodios_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_risco_episodios_updated_at ON public.risco_episodios;
CREATE TRIGGER trg_risco_episodios_updated_at
BEFORE UPDATE ON public.risco_episodios
FOR EACH ROW EXECUTE FUNCTION public.risco_episodios_set_updated_at();

DROP TRIGGER IF EXISTS trg_risco_episodio_planos_updated_at ON public.risco_episodio_planos_acao;
CREATE TRIGGER trg_risco_episodio_planos_updated_at
BEFORE UPDATE ON public.risco_episodio_planos_acao
FOR EACH ROW EXECUTE FUNCTION public.risco_episodios_set_updated_at();

ALTER TABLE public.risco_episodios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risco_episodio_planos_acao ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risco_episodio_comunicacoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_risco_episodios" ON public.risco_episodios
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_risco_episodio_planos" ON public.risco_episodio_planos_acao
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_risco_episodio_comunicacoes" ON public.risco_episodio_comunicacoes
  FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.salvar_plano_acao_episodio_risco(
  p_episodio_id UUID,
  p_conteudo TEXT,
  p_responsavel_nome TEXT DEFAULT NULL,
  p_responsavel_email TEXT DEFAULT NULL,
  p_prazo DATE DEFAULT NULL,
  p_origem TEXT DEFAULT 'manual'
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_versao INTEGER;
  v_id UUID;
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
  IF NOT EXISTS (SELECT 1 FROM public.risco_episodios WHERE id = p_episodio_id) THEN
    RAISE EXCEPTION 'Episodio nao encontrado';
  END IF;

  UPDATE public.risco_episodio_planos_acao
  SET status = 'substituido'
  WHERE episodio_id = p_episodio_id AND status <> 'substituido';

  SELECT COALESCE(MAX(versao), 0) + 1 INTO v_versao
  FROM public.risco_episodio_planos_acao WHERE episodio_id = p_episodio_id;

  INSERT INTO public.risco_episodio_planos_acao (
    episodio_id, versao, origem, conteudo, responsavel_nome, responsavel_email, prazo, created_by
  ) VALUES (
    p_episodio_id, v_versao, p_origem, trim(p_conteudo), NULLIF(trim(p_responsavel_nome), ''),
    NULLIF(trim(p_responsavel_email), ''), p_prazo, auth.uid()
  ) RETURNING id INTO v_id;

  UPDATE public.risco_episodios
  SET status_workflow = CASE WHEN data_regularizacao IS NULL THEN 'em_tratamento' ELSE 'regularizada' END
  WHERE id = p_episodio_id;

  INSERT INTO public.risco_episodio_comunicacoes (episodio_id, tipo, canal, assunto, conteudo, created_by)
  VALUES (p_episodio_id, 'resposta_recebida', p_origem, 'Plano de ação recebido', trim(p_conteudo), auth.uid());
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.sincronizar_episodios_risco()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_total INTEGER := 0;
BEGIN
  IF auth.role() NOT IN ('authenticated', 'service_role') THEN RAISE EXCEPTION 'Acesso nao autorizado'; END IF;

  WITH fontes AS (
    SELECT CASE WHEN lower(e.regra_categoria) IN ('concentration', 'fidc-concentracao') THEN 'concentracao' ELSE 'enquadramento' END AS modulo,
      regexp_replace(e.fundo_cnpj, '\D', '', 'g') AS fundo_cnpj, upper(trim(COALESCE(e.fundo_isin, ''))) AS fundo_isin,
      e.regra_codigo AS source_key, 'enquadramento_resultado'::text AS source_table,
      COALESCE(e.regra_descricao, e.regra_codigo) AS titulo, e.regra_descricao AS descricao,
      to_date(e.fundo_dtposicao, 'YYYYMMDD') AS data_ref,
      CASE WHEN e.status = 'violacao' THEN 'violacao' WHEN e.status = 'alerta' THEN 'atencao' ELSE 'ok' END AS status_diario,
      e.valor_atual::numeric AS valor_atual, e.valor_limite::numeric AS limite_referencia, 'indice'::text AS unidade,
      COALESCE(public.risco_nome_fundo_competencia(regexp_replace(e.fundo_cnpj, '\D', '', 'g'), upper(trim(COALESCE(e.fundo_isin, ''))), to_date(e.fundo_dtposicao, 'YYYYMMDD')), regexp_replace(e.fundo_cnpj, '\D', '', 'g')) AS fundo_nome
    FROM public.enquadramento_resultado e
    WHERE e.fundo_dtposicao ~ '^[0-9]{8}$' AND trim(COALESCE(e.fundo_isin, '')) <> ''
    UNION ALL
    SELECT 'liquidez', regexp_replace(l.fundo_cnpj, '\D', '', 'g'), '',
      'LIQUIDEZ_' || CASE WHEN l.is_fundo_fechado THEN 'COBERTURA' ELSE 'RESGATE' END, 'liquidez_monitoramento_risco',
      CASE WHEN l.is_fundo_fechado THEN 'Cobertura operacional de liquidez' ELSE 'Índice de liquidez para resgates' END,
      NULL, to_date(l.dt_posicao, 'YYYYMMDD'),
      CASE WHEN l.status = 'violacao' THEN 'violacao' WHEN l.status = 'alerta' THEN 'atencao' ELSE 'ok' END,
      CASE WHEN l.is_fundo_fechado THEN l.meses_cobertura ELSE l.indice_liquidez END, NULL,
      CASE WHEN l.is_fundo_fechado THEN 'meses' ELSE 'indice' END,
      COALESCE(public.risco_nome_fundo_competencia(regexp_replace(l.fundo_cnpj, '\D', '', 'g'), NULL, to_date(l.dt_posicao, 'YYYYMMDD')), regexp_replace(l.fundo_cnpj, '\D', '', 'g'))
    FROM public.liquidez_monitoramento_risco l WHERE l.dt_posicao ~ '^[0-9]{8}$'
    UNION ALL
    SELECT 'mercado', regexp_replace(r.cnpj, '\D', '', 'g'), '', 'COTA_CDI_2000', 'risco_mercado_fundos_diario',
      'Oscilação da cota superior a 2.000% do CDI/dia', NULL, r.data_ref,
      CASE WHEN r.status_cota_cdi = 'violacao' THEN 'violacao' WHEN r.status_cota_cdi = 'atencao' THEN 'atencao' ELSE 'ok' END,
      r.relacao_cota_cdi, 20::numeric, 'multiplo_cdi',
      COALESCE(NULLIF(trim(r.nome_fundo), ''), public.risco_nome_fundo_competencia(regexp_replace(r.cnpj, '\D', '', 'g'), NULL, r.data_ref), regexp_replace(r.cnpj, '\D', '', 'g'))
    FROM public.risco_mercado_fundos_diario r
  ), serie AS (
    SELECT modulo, fundo_cnpj, fundo_isin, source_key, max(source_table) AS source_table,
      max(titulo) AS titulo, max(descricao) AS descricao, data_ref,
      CASE WHEN bool_or(status_diario = 'violacao') THEN 'violacao' WHEN bool_or(status_diario = 'atencao') THEN 'atencao' ELSE 'ok' END AS status_diario,
      max(valor_atual) AS valor_atual, max(limite_referencia) AS limite_referencia, max(unidade) AS unidade, max(fundo_nome) AS fundo_nome
    FROM fontes WHERE length(fundo_cnpj) = 14
    GROUP BY modulo, fundo_cnpj, fundo_isin, source_key, data_ref
  ), marcados AS (
    SELECT *, count(*) FILTER (WHERE status_diario = 'ok') OVER (PARTITION BY modulo, fundo_cnpj, fundo_isin, source_key ORDER BY data_ref) AS bloco_ok
    FROM serie
  ), abertos AS (
    SELECT * FROM marcados WHERE status_diario <> 'ok'
  ), episodios AS (
    SELECT modulo, fundo_cnpj, fundo_isin, source_key, max(source_table) AS source_table, max(fundo_nome) AS fundo_nome,
      max(titulo) AS titulo, max(descricao) AS descricao, min(data_ref) AS data_inicio, max(data_ref) AS data_ultima_evidencia,
      count(*)::integer AS dias_com_evidencia, bool_or(status_diario = 'violacao') AS violacao_detectada,
      (array_agg(status_diario ORDER BY data_ref DESC))[1] AS nivel_atual,
      (array_agg(valor_atual ORDER BY data_ref DESC))[1] AS valor_atual, max(valor_atual) AS valor_pior,
      max(limite_referencia) AS limite_referencia, max(unidade) AS unidade
    FROM abertos GROUP BY modulo, fundo_cnpj, fundo_isin, source_key, bloco_ok
  ), episodios_fechados AS (
    SELECT e.*, (SELECT min(s.data_ref) FROM serie s WHERE s.modulo = e.modulo AND s.fundo_cnpj = e.fundo_cnpj AND s.fundo_isin = e.fundo_isin AND s.source_key = e.source_key AND s.data_ref > e.data_ultima_evidencia AND s.status_diario = 'ok') AS data_regularizacao
    FROM episodios e
  ), gravados AS (
    INSERT INTO public.risco_episodios (
      chave_episodio, modulo, fundo_cnpj, fundo_isin, fundo_nome, source_key, source_table, titulo, descricao,
      nivel_atual, violacao_detectada, data_inicio, data_ultima_evidencia, data_regularizacao, dias_com_evidencia,
      valor_atual, valor_pior, limite_referencia, unidade, status_workflow, source_payload
    )
    SELECT md5(concat_ws('|', modulo, fundo_cnpj, fundo_isin, source_key, data_inicio::text)), modulo, fundo_cnpj, fundo_isin, fundo_nome, source_key, source_table, titulo, descricao,
      nivel_atual, violacao_detectada, data_inicio, data_ultima_evidencia, data_regularizacao, dias_com_evidencia,
      valor_atual, valor_pior, limite_referencia, unidade,
      CASE WHEN data_regularizacao IS NOT NULL THEN 'regularizada' WHEN violacao_detectada THEN 'aguardando_plano' ELSE 'aberta' END,
      jsonb_build_object('fonte_diaria', source_table, 'ultima_evidencia', data_ultima_evidencia)
    FROM episodios_fechados
    ON CONFLICT (chave_episodio) DO UPDATE SET
      fundo_nome = EXCLUDED.fundo_nome, titulo = EXCLUDED.titulo, descricao = EXCLUDED.descricao, nivel_atual = EXCLUDED.nivel_atual,
      violacao_detectada = EXCLUDED.violacao_detectada, data_ultima_evidencia = EXCLUDED.data_ultima_evidencia,
      data_regularizacao = EXCLUDED.data_regularizacao, dias_com_evidencia = EXCLUDED.dias_com_evidencia,
      valor_atual = EXCLUDED.valor_atual, valor_pior = EXCLUDED.valor_pior, limite_referencia = EXCLUDED.limite_referencia,
      unidade = EXCLUDED.unidade, source_payload = EXCLUDED.source_payload,
      status_workflow = CASE WHEN EXCLUDED.data_regularizacao IS NOT NULL THEN 'regularizada'
        WHEN EXCLUDED.violacao_detectada AND EXISTS (SELECT 1 FROM public.risco_episodio_planos_acao p WHERE p.episodio_id = risco_episodios.id AND p.status <> 'substituido') THEN 'em_tratamento'
        WHEN EXCLUDED.violacao_detectada THEN 'aguardando_plano' ELSE 'aberta' END,
      updated_at = now()
    RETURNING id
  ) SELECT count(*) INTO v_total FROM gravados;

  RETURN jsonb_build_object('episodios_sincronizados', v_total, 'sincronizado_em', now());
END;
$$;

CREATE OR REPLACE VIEW public.vw_risco_episodios_monitoramento WITH (security_invoker = true) AS
SELECT e.*, p.id AS plano_id, p.versao AS plano_versao, p.conteudo AS plano_conteudo,
  p.responsavel_nome AS plano_responsavel_nome, p.responsavel_email AS plano_responsavel_email,
  p.prazo AS plano_prazo, p.recebido_em AS plano_recebido_em, p.status AS plano_status,
  CASE WHEN e.data_regularizacao IS NULL THEN (current_date - e.data_inicio + 1) ELSE (e.data_regularizacao - e.data_inicio + 1) END::integer AS dias_episodio,
  CASE WHEN e.data_regularizacao IS NOT NULL THEN false WHEN e.violacao_detectada AND p.id IS NULL THEN true WHEN e.violacao_detectada AND p.prazo < current_date THEN true ELSE false END AS notificacao_pendente
FROM public.risco_episodios e
LEFT JOIN LATERAL (
  SELECT * FROM public.risco_episodio_planos_acao p
  WHERE p.episodio_id = e.id AND p.status <> 'substituido' ORDER BY p.versao DESC LIMIT 1
) p ON true;

GRANT SELECT ON public.vw_risco_episodios_monitoramento TO authenticated;
GRANT EXECUTE ON FUNCTION public.sincronizar_episodios_risco() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.salvar_plano_acao_episodio_risco(UUID, TEXT, TEXT, TEXT, DATE, TEXT) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
