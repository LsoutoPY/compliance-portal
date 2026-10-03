-- Corrige a identidade de ocorrencias de Enquadramento e Concentracao.
-- Um mesmo CNPJ pode possuir varias classes; nesses modulos a chave correta
-- e CNPJ + ISIN da classe + regra + competencia.

ALTER TABLE public.risco_ocorrencias
  ADD COLUMN IF NOT EXISTS fundo_isin TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN public.risco_ocorrencias.fundo_isin IS
  'ISIN da classe monitorada. Obrigatorio para Enquadramento e Concentracao; vazio para metricas no nivel do fundo.';

CREATE INDEX IF NOT EXISTS idx_risco_ocorrencias_cnpj_isin
  ON public.risco_ocorrencias (fundo_cnpj, fundo_isin, competencia DESC);

CREATE OR REPLACE FUNCTION public.risco_exigir_isin_por_classe()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.modulo IN ('enquadramento', 'concentracao')
     AND trim(COALESCE(NEW.fundo_isin, '')) = '' THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_risco_exigir_isin_por_classe ON public.risco_ocorrencias;
CREATE TRIGGER trg_risco_exigir_isin_por_classe
  BEFORE INSERT OR UPDATE ON public.risco_ocorrencias
  FOR EACH ROW EXECUTE FUNCTION public.risco_exigir_isin_por_classe();

-- Apenas ocorrencias derivadas sem tratativa sao reconstruidas.
DELETE FROM public.risco_ocorrencias o
WHERE o.modulo IN ('enquadramento', 'concentracao')
  AND NOT EXISTS (
    SELECT 1 FROM public.risco_planos_acao p WHERE p.ocorrencia_id = o.id
  );

-- Preserva o consolidador original para Liquidez e Mercado. O trigger acima
-- bloqueia apenas as linhas antigas de Enquadramento/Concentracao sem ISIN.
ALTER FUNCTION public.sincronizar_ocorrencias_risco(DATE)
  RENAME TO sincronizar_ocorrencias_risco_base;

CREATE OR REPLACE FUNCTION public.sincronizar_ocorrencias_enquadramento_isin(p_competencia DATE)
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
    SELECT DISTINCT ON (
      regexp_replace(fundo_cnpj, '\D', '', 'g'),
      upper(trim(COALESCE(fundo_isin, '')))
    )
      regexp_replace(fundo_cnpj, '\D', '', 'g') AS cnpj,
      upper(trim(COALESCE(fundo_isin, ''))) AS isin,
      COALESCE(
        NULLIF(trim(nome_fundo), ''),
        NULLIF(trim(fundo_nome), ''),
        regexp_replace(fundo_cnpj, '\D', '', 'g')
      ) AS nome
    FROM public.posicao_carteira
    WHERE fundo_cnpj IS NOT NULL
      AND trim(COALESCE(fundo_isin, '')) <> ''
    ORDER BY
      regexp_replace(fundo_cnpj, '\D', '', 'g'),
      upper(trim(COALESCE(fundo_isin, ''))),
      fundo_dtposicao DESC NULLS LAST
  ),
  fontes AS (
    SELECT
      v_competencia AS competencia,
      CASE
        WHEN lower(e.regra_categoria) IN ('concentration', 'fidc-concentracao') THEN 'concentracao'
        ELSE 'enquadramento'
      END AS modulo,
      regexp_replace(e.fundo_cnpj, '\D', '', 'g') AS fundo_cnpj,
      upper(trim(e.fundo_isin)) AS fundo_isin,
      COALESCE(max(n.nome), regexp_replace(e.fundo_cnpj, '\D', '', 'g')) AS fundo_nome,
      CASE WHEN bool_or(e.status = 'violacao') THEN 'violacao' ELSE 'atencao' END AS nivel,
      e.regra_codigo || '|' || upper(trim(e.fundo_isin)) AS source_key,
      'enquadramento_resultado'::text AS source_table,
      COALESCE(max(e.regra_descricao), e.regra_codigo) AS titulo,
      max(e.regra_descricao) AS descricao,
      min(to_date(e.fundo_dtposicao, 'YYYYMMDD')) AS data_primeira,
      max(to_date(e.fundo_dtposicao, 'YYYYMMDD')) AS data_ultima,
      count(DISTINCT e.fundo_dtposicao)::integer AS dias_ocorrencia,
      max(e.valor_atual) AS valor_pior,
      max(e.valor_limite) AS limite_referencia,
      'indice'::text AS unidade,
      jsonb_build_object(
        'categoria', e.regra_categoria,
        'regra', e.regra_codigo,
        'fundo_isin', upper(trim(e.fundo_isin))
      ) AS source_payload
    FROM public.enquadramento_resultado e
    LEFT JOIN nomes n
      ON n.cnpj = regexp_replace(e.fundo_cnpj, '\D', '', 'g')
     AND n.isin = upper(trim(e.fundo_isin))
    WHERE e.status IN ('alerta', 'violacao')
      AND e.fundo_dtposicao ~ '^[0-9]{8}$'
      AND trim(COALESCE(e.fundo_isin, '')) <> ''
      AND to_date(e.fundo_dtposicao, 'YYYYMMDD') BETWEEN v_competencia AND v_fim
    GROUP BY
      regexp_replace(e.fundo_cnpj, '\D', '', 'g'),
      upper(trim(e.fundo_isin)),
      e.regra_categoria,
      e.regra_codigo
  ),
  gravadas AS (
    INSERT INTO public.risco_ocorrencias (
      competencia, modulo, fundo_cnpj, fundo_isin, fundo_nome, nivel,
      source_key, source_table, titulo, descricao, data_primeira, data_ultima,
      dias_ocorrencia, valor_pior, limite_referencia, unidade,
      status_workflow, source_payload
    )
    SELECT
      competencia, modulo, fundo_cnpj, fundo_isin, fundo_nome, nivel,
      source_key, source_table, titulo, descricao, data_primeira, data_ultima,
      dias_ocorrencia, valor_pior, limite_referencia, unidade,
      CASE WHEN nivel = 'violacao' THEN 'aguardando_plano' ELSE 'aberta' END,
      source_payload
    FROM fontes
    WHERE length(fundo_cnpj) = 14 AND fundo_isin <> ''
    ON CONFLICT (competencia, modulo, fundo_cnpj, source_key) DO UPDATE SET
      fundo_isin = EXCLUDED.fundo_isin,
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
      SELECT e.created_at
      FROM public.envios_notificacao_desenquadramento e
      WHERE e.status = 'enviado'
        AND e.data_referencia ~ '^[0-9]{8}$'
        AND to_date(e.data_referencia, 'YYYYMMDD') BETWEEN o.data_primeira AND o.data_ultima
      ORDER BY e.created_at DESC LIMIT 1
    ),
    notificacao_email_id = (
      SELECT e.email_id
      FROM public.envios_notificacao_desenquadramento e
      WHERE e.status = 'enviado'
        AND e.data_referencia ~ '^[0-9]{8}$'
        AND to_date(e.data_referencia, 'YYYYMMDD') BETWEEN o.data_primeira AND o.data_ultima
      ORDER BY e.created_at DESC LIMIT 1
    )
  WHERE o.competencia = v_competencia
    AND o.modulo IN ('enquadramento', 'concentracao')
    AND o.fundo_isin <> ''
    AND o.notificacao_status = 'nao_enviada'
    AND EXISTS (
      SELECT 1
      FROM public.envios_notificacao_desenquadramento e
      WHERE e.status = 'enviado'
        AND e.data_referencia ~ '^[0-9]{8}$'
        AND to_date(e.data_referencia, 'YYYYMMDD') BETWEEN o.data_primeira AND o.data_ultima
    );

  RETURN jsonb_build_object(
    'competencia', v_competencia,
    'ocorrencias_classe_sincronizadas', v_total,
    'sincronizado_em', now()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.sincronizar_ocorrencias_risco(p_competencia DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base JSONB;
  v_classes JSONB;
BEGIN
  IF auth.role() NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'Acesso nao autorizado';
  END IF;

  v_base := public.sincronizar_ocorrencias_risco_base(p_competencia);
  v_classes := public.sincronizar_ocorrencias_enquadramento_isin(p_competencia);

  RETURN jsonb_build_object(
    'competencia', date_trunc('month', p_competencia)::date,
    'fontes_fundo', v_base,
    'fontes_classe', v_classes,
    'sincronizado_em', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sincronizar_ocorrencias_risco_base(DATE) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.sincronizar_ocorrencias_enquadramento_isin(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sincronizar_ocorrencias_risco(DATE) TO authenticated, service_role;

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

NOTIFY pgrst, 'reload schema';
