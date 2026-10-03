-- RelatÃ³rio mensal derivado do motor Ãºnico de episÃ³dios.
-- O relatÃ³rio registra o que ocorreu no mÃªs de referÃªncia; nÃ£o cria um
-- novo caso mensal e nÃ£o inclui o mÃ³dulo de mercado nesta etapa.

CREATE TABLE IF NOT EXISTS public.risco_relatorio_mensal_episodios (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competencia                date NOT NULL,
  episodio_id                uuid NOT NULL REFERENCES public.risco_episodios(id) ON DELETE CASCADE,
  modulo                     text NOT NULL CHECK (modulo IN ('enquadramento','liquidez','concentracao')),
  fundo_cnpj                 text NOT NULL CHECK (fundo_cnpj ~ '^[0-9]{14}$'),
  fundo_isin                 text NOT NULL DEFAULT '',
  fundo_nome                 text NOT NULL,
  source_key                 text NOT NULL,
  source_table               text NOT NULL,
  titulo                     text NOT NULL,
  descricao                  text,
  nivel                      text NOT NULL CHECK (nivel IN ('atencao','violacao')),
  data_primeira              date NOT NULL,
  data_ultima                date NOT NULL,
  dias_ocorrencia            integer NOT NULL CHECK (dias_ocorrencia > 0),
  status_workflow             text NOT NULL CHECK (status_workflow IN ('aberta','aguardando_plano','em_tratamento','regularizada','encerrada')),
  validade_ocorrencia         text NOT NULL CHECK (validade_ocorrencia IN ('confirmada','em_revisao','invalidada_correcao_dado')),
  notificacao_status          text NOT NULL CHECK (notificacao_status IN ('nao_enviada','enviada','erro','dispensada')),
  notificacao_enviada_em      timestamptz,
  plano_id                    uuid,
  plano_versao                integer,
  plano_conteudo              text,
  plano_responsavel_nome      text,
  plano_responsavel_email     text,
  plano_prazo                 date,
  plano_recebido_em           timestamptz,
  plano_status                text,
  plano_origem                text,
  source_payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot_at                 timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (competencia, episodio_id),
  CONSTRAINT risco_relatorio_mensal_episodios_datas_check CHECK (data_ultima >= data_primeira),
  CONSTRAINT risco_relatorio_mensal_episodios_competencia_check CHECK (competencia = date_trunc('month', competencia)::date)
);

CREATE INDEX IF NOT EXISTS idx_risco_relatorio_mensal_episodios_competencia
  ON public.risco_relatorio_mensal_episodios (competencia DESC, modulo, nivel);

ALTER TABLE public.risco_relatorio_mensal_episodios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS risco_relatorio_mensal_episodios_select ON public.risco_relatorio_mensal_episodios;
CREATE POLICY risco_relatorio_mensal_episodios_select
  ON public.risco_relatorio_mensal_episodios FOR SELECT
  USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS risco_relatorio_mensal_episodios_write ON public.risco_relatorio_mensal_episodios;
CREATE POLICY risco_relatorio_mensal_episodios_write
  ON public.risco_relatorio_mensal_episodios FOR ALL
  USING (public.risco_usuario_pode_editar())
  WITH CHECK (public.risco_usuario_pode_editar());

CREATE OR REPLACE FUNCTION public.sincronizar_relatorio_mensal_episodios(p_competencia date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_competencia date := date_trunc('month', p_competencia)::date;
  v_fim date := (date_trunc('month', p_competencia) + interval '1 month - 1 day')::date;
  v_total integer := 0;
BEGIN
  IF auth.role() NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'Acesso nao autorizado';
  END IF;

  WITH evidencias AS (
    SELECT
      ep.id AS episodio_id,
      ep.modulo,
      ep.fundo_cnpj,
      ep.fundo_isin,
      ep.fundo_nome,
      ep.source_key,
      ep.source_table,
      ep.titulo,
      ep.descricao,
      ep.validade_ocorrencia,
      rd.data_referencia,
      rd.status,
      rd.valor_atual,
      rd.limite_referencia,
      rd.unidade
    FROM public.risco_evidencias_diarias rd
    JOIN public.risco_episodios ep
      ON ep.modulo = rd.modulo
      AND ep.fundo_cnpj = rd.fundo_cnpj
      AND ep.fundo_isin = rd.fundo_isin
      AND ep.source_key = rd.chave_regra
      AND rd.data_referencia >= ep.data_inicio
      AND (ep.data_regularizacao IS NULL OR rd.data_referencia < ep.data_regularizacao)
    WHERE rd.data_referencia BETWEEN v_competencia AND v_fim
      AND (
        rd.status = 'violacao'
        OR (rd.status = 'atencao' AND rd.modulo = 'liquidez')
      )
      AND ep.modulo IN ('enquadramento', 'liquidez', 'concentracao')
      AND ep.validade_ocorrencia <> 'invalidada_correcao_dado'
  ), agrupadas AS (
    SELECT
      e.episodio_id,
      max(e.modulo) AS modulo,
      max(e.fundo_cnpj) AS fundo_cnpj,
      max(e.fundo_isin) AS fundo_isin,
      max(e.fundo_nome) AS fundo_nome,
      max(e.source_key) AS source_key,
      max(e.source_table) AS source_table,
      max(e.titulo) AS titulo,
      max(e.descricao) AS descricao,
      CASE WHEN bool_or(e.status = 'violacao') THEN 'violacao' ELSE 'atencao' END AS nivel,
      min(e.data_referencia) AS data_primeira,
      max(e.data_referencia) AS data_ultima,
      count(DISTINCT e.data_referencia)::integer AS dias_ocorrencia,
      max(e.validade_ocorrencia) AS validade_ocorrencia,
      max(e.valor_atual) AS valor_atual,
      max(e.limite_referencia) AS limite_referencia,
      max(e.unidade) AS unidade
    FROM evidencias e
    GROUP BY e.episodio_id
  ), enriquecidas AS (
    SELECT
      a.*,
      ep.data_regularizacao,
      ep.source_payload AS episodio_payload,
      pl.id AS plano_id,
      pl.versao AS plano_versao,
      pl.conteudo AS plano_conteudo,
      pl.responsavel_nome AS plano_responsavel_nome,
      pl.responsavel_email AS plano_responsavel_email,
      pl.prazo AS plano_prazo,
      pl.recebido_em AS plano_recebido_em,
      pl.status AS plano_status,
      pl.origem AS plano_origem,
      nt.ocorrida_em AS notificacao_enviada_em,
      CASE
        WHEN a.nivel = 'atencao' THEN 'dispensada'
        WHEN nt.id IS NOT NULL THEN 'enviada'
        ELSE 'nao_enviada'
      END AS notificacao_status,
      ep.status_workflow AS status_workflow
    FROM agrupadas a
    JOIN public.risco_episodios ep ON ep.id = a.episodio_id
    LEFT JOIN LATERAL (
      SELECT p.*
      FROM public.risco_episodio_planos_acao p
      WHERE p.episodio_id = a.episodio_id
        AND p.status <> 'substituido'
      ORDER BY p.versao DESC
      LIMIT 1
    ) pl ON true
    LEFT JOIN LATERAL (
      SELECT c.*
      FROM public.risco_episodio_comunicacoes c
      WHERE c.episodio_id = a.episodio_id
        AND c.tipo = 'notificacao_inicial'
      ORDER BY coalesce(c.ocorrida_em, c.created_at) DESC
      LIMIT 1
    ) nt ON true
  ), gravadas AS (
    INSERT INTO public.risco_relatorio_mensal_episodios (
      competencia, episodio_id, modulo, fundo_cnpj, fundo_isin, fundo_nome,
      source_key, source_table, titulo, descricao, nivel, data_primeira,
      data_ultima, dias_ocorrencia, status_workflow, validade_ocorrencia,
      notificacao_status, notificacao_enviada_em, plano_id, plano_versao,
      plano_conteudo, plano_responsavel_nome, plano_responsavel_email,
      plano_prazo, plano_recebido_em, plano_status, plano_origem, source_payload,
      snapshot_at, updated_at
    )
    SELECT
      v_competencia, episodio_id, modulo, fundo_cnpj, coalesce(fundo_isin, ''), fundo_nome,
      source_key, source_table, titulo, descricao, nivel, data_primeira,
      data_ultima, dias_ocorrencia, status_workflow, validade_ocorrencia,
      notificacao_status, notificacao_enviada_em, plano_id, plano_versao,
      plano_conteudo, plano_responsavel_nome, plano_responsavel_email,
      plano_prazo, plano_recebido_em, plano_status, plano_origem,
      coalesce(episodio_payload, '{}'::jsonb) || jsonb_build_object('episodio_id', episodio_id, 'competencia', v_competencia),
      now(), now()
    FROM enriquecidas
    ON CONFLICT (competencia, episodio_id) DO UPDATE SET
      modulo = EXCLUDED.modulo,
      fundo_cnpj = EXCLUDED.fundo_cnpj,
      fundo_isin = EXCLUDED.fundo_isin,
      fundo_nome = EXCLUDED.fundo_nome,
      source_key = EXCLUDED.source_key,
      source_table = EXCLUDED.source_table,
      titulo = EXCLUDED.titulo,
      descricao = EXCLUDED.descricao,
      nivel = EXCLUDED.nivel,
      data_primeira = EXCLUDED.data_primeira,
      data_ultima = EXCLUDED.data_ultima,
      dias_ocorrencia = EXCLUDED.dias_ocorrencia,
      status_workflow = EXCLUDED.status_workflow,
      validade_ocorrencia = EXCLUDED.validade_ocorrencia,
      notificacao_status = EXCLUDED.notificacao_status,
      notificacao_enviada_em = EXCLUDED.notificacao_enviada_em,
      plano_id = EXCLUDED.plano_id,
      plano_versao = EXCLUDED.plano_versao,
      plano_conteudo = EXCLUDED.plano_conteudo,
      plano_responsavel_nome = EXCLUDED.plano_responsavel_nome,
      plano_responsavel_email = EXCLUDED.plano_responsavel_email,
      plano_prazo = EXCLUDED.plano_prazo,
      plano_recebido_em = EXCLUDED.plano_recebido_em,
      plano_status = EXCLUDED.plano_status,
      plano_origem = EXCLUDED.plano_origem,
      source_payload = EXCLUDED.source_payload,
      snapshot_at = EXCLUDED.snapshot_at,
      updated_at = now()
    RETURNING id
  ) SELECT count(*) INTO v_total FROM gravadas;

  DELETE FROM public.risco_relatorio_mensal_episodios r
  WHERE r.competencia = v_competencia
    AND NOT EXISTS (
      SELECT 1 FROM public.risco_evidencias_diarias rd
      JOIN public.risco_episodios ep
        ON ep.modulo = rd.modulo AND ep.fundo_cnpj = rd.fundo_cnpj
        AND ep.fundo_isin = rd.fundo_isin AND ep.source_key = rd.chave_regra
        AND rd.data_referencia >= ep.data_inicio
        AND (ep.data_regularizacao IS NULL OR rd.data_referencia < ep.data_regularizacao)
      WHERE ep.id = r.episodio_id
        AND rd.data_referencia BETWEEN v_competencia AND v_fim
        AND (
          rd.status = 'violacao'
          OR (rd.status = 'atencao' AND rd.modulo = 'liquidez')
        )
        AND ep.modulo IN ('enquadramento', 'liquidez', 'concentracao')
        AND ep.validade_ocorrencia <> 'invalidada_correcao_dado'
    );

  INSERT INTO public.risco_relatorios_mensais (competencia, preparado_por, created_by, snapshot)
  VALUES (
    v_competencia, auth.uid(), auth.uid(),
    jsonb_build_object('origem', 'risco_episodios', 'modulos', jsonb_build_array('enquadramento','liquidez','concentracao'), 'sincronizado_em', now())
  )
  ON CONFLICT (competencia) DO UPDATE SET
    snapshot = public.risco_relatorios_mensais.snapshot || EXCLUDED.snapshot,
    updated_at = now();

  RETURN jsonb_build_object('competencia', v_competencia, 'episodios_registrados', v_total, 'sincronizado_em', now());
END;
$$;

GRANT EXECUTE ON FUNCTION public.sincronizar_relatorio_mensal_episodios(date) TO authenticated, service_role;

DROP VIEW IF EXISTS public.vw_risco_ocorrencias_mensais;
CREATE VIEW public.vw_risco_ocorrencias_mensais
WITH (security_invoker = true) AS
SELECT
  r.id,
  r.competencia,
  r.modulo,
  r.fundo_cnpj,
  r.fundo_isin,
  r.fundo_nome,
  r.nivel,
  r.source_key,
  r.source_table,
  r.titulo,
  r.descricao,
  r.data_primeira,
  r.data_ultima,
  r.dias_ocorrencia,
  NULL::numeric AS valor_pior,
  NULL::numeric AS limite_referencia,
  NULL::text AS unidade,
  r.status_workflow,
  r.validade_ocorrencia,
  NULL::timestamptz AS invalidada_em,
  NULL::uuid AS invalidada_por,
  NULL::text AS motivo_invalidacao,
  NULL::text AS motivo_classificacao,
  false AS validade_bloqueada_manualmente,
  NULL::timestamptz AS validade_atualizada_em,
  NULL::uuid AS validade_atualizada_por,
  NULL::uuid AS ultima_sincronizacao_id,
  r.notificacao_status,
  r.notificacao_enviada_em,
  NULL::text AS notificacao_email_id,
  r.source_payload,
  r.created_at,
  r.updated_at,
  r.plano_id,
  r.plano_versao,
  r.plano_conteudo,
  r.plano_responsavel_nome,
  r.plano_responsavel_email,
  r.plano_prazo,
  r.plano_recebido_em,
  r.plano_status,
  r.plano_origem
FROM public.risco_relatorio_mensal_episodios r;

GRANT SELECT ON public.vw_risco_ocorrencias_mensais TO authenticated;
NOTIFY pgrst, 'reload schema';
