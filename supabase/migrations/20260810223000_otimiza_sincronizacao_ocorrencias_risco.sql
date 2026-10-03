-- Otimiza a sincronizacao historica do monitoramento de desenquadramentos.
-- Evita ordenar toda a posicao_carteira e separa fontes no nivel do fundo
-- das ocorrencias por classe (CNPJ + ISIN).

CREATE INDEX IF NOT EXISTS idx_posicao_carteira_fundo_isin_dt_desc
  ON public.posicao_carteira (fundo_cnpj, fundo_isin, fundo_dtposicao DESC)
  INCLUDE (nome_fundo, fundo_nome)
  WHERE fundo_cnpj IS NOT NULL AND fundo_isin IS NOT NULL;

CREATE OR REPLACE FUNCTION public.risco_nome_fundo_competencia(
  p_cnpj TEXT,
  p_isin TEXT,
  p_data_limite DATE
)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    NULLIF(trim(p.nome_fundo), ''),
    NULLIF(trim(p.fundo_nome), ''),
    p_cnpj
  )
  FROM public.posicao_carteira p
  WHERE p.fundo_cnpj = p_cnpj
    AND (NULLIF(trim(p_isin), '') IS NULL OR upper(trim(COALESCE(p.fundo_isin, ''))) = upper(trim(p_isin)))
    AND p.fundo_dtposicao <= to_char(p_data_limite, 'YYYYMMDD')
  ORDER BY p.fundo_dtposicao DESC NULLS LAST
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.risco_nome_fundo_competencia(TEXT, TEXT, DATE) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.sincronizar_ocorrencias_risco_fundos(p_competencia DATE)
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
  v_total INTEGER := 0;
BEGIN
  IF auth.role() NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'Acesso nao autorizado';
  END IF;

  WITH liquidez_base AS (
    SELECT
      regexp_replace(l.fundo_cnpj, '\D', '', 'g') AS fundo_cnpj,
      l.is_fundo_fechado,
      CASE WHEN bool_or(l.status = 'violacao') THEN 'violacao' ELSE 'atencao' END AS nivel,
      min(to_date(l.dt_posicao, 'YYYYMMDD')) AS data_primeira,
      max(to_date(l.dt_posicao, 'YYYYMMDD')) AS data_ultima,
      count(DISTINCT l.dt_posicao)::integer AS dias_ocorrencia,
      min(CASE WHEN l.is_fundo_fechado THEN l.meses_cobertura ELSE l.indice_liquidez END) AS valor_pior
    FROM public.liquidez_monitoramento_risco l
    WHERE l.status IN ('alerta', 'violacao')
      AND l.dt_posicao BETWEEN v_inicio_texto AND v_fim_texto
    GROUP BY regexp_replace(l.fundo_cnpj, '\D', '', 'g'), l.is_fundo_fechado
  ),
  liquidez AS (
    SELECT
      v_competencia AS competencia,
      'liquidez'::text AS modulo,
      b.fundo_cnpj,
      COALESCE(public.risco_nome_fundo_competencia(b.fundo_cnpj, NULL, v_fim), b.fundo_cnpj) AS fundo_nome,
      b.nivel,
      'LIQUIDEZ_' || CASE WHEN b.is_fundo_fechado THEN 'COBERTURA' ELSE 'RESGATE' END AS source_key,
      'liquidez_monitoramento_risco'::text AS source_table,
      CASE WHEN b.is_fundo_fechado THEN 'Cobertura operacional de liquidez' ELSE 'Indice de liquidez para resgates' END AS titulo,
      CASE WHEN b.is_fundo_fechado THEN 'Cobertura de despesas abaixo do parametro.' ELSE 'Disponibilidade incompativel com o prazo de resgate.' END AS descricao,
      b.data_primeira,
      b.data_ultima,
      b.dias_ocorrencia,
      b.valor_pior,
      NULL::numeric AS limite_referencia,
      CASE WHEN b.is_fundo_fechado THEN 'meses' ELSE 'indice' END AS unidade,
      jsonb_build_object('fundo_fechado', b.is_fundo_fechado) AS source_payload
    FROM liquidez_base b
  ),
  mercado_base AS (
    SELECT
      regexp_replace(r.cnpj, '\D', '', 'g') AS fundo_cnpj,
      max(NULLIF(trim(r.nome_fundo), '')) AS nome_fonte,
      min(r.data_ref) AS data_primeira,
      max(r.data_ref) AS data_ultima,
      count(DISTINCT r.data_ref)::integer AS dias_ocorrencia,
      max(r.relacao_cota_cdi) AS valor_pior
    FROM public.risco_mercado_fundos_diario r
    WHERE r.data_ref BETWEEN v_competencia AND v_fim
      AND r.status_cota_cdi = 'atencao'
    GROUP BY regexp_replace(r.cnpj, '\D', '', 'g')
  ),
  mercado AS (
    SELECT
      v_competencia AS competencia,
      'mercado'::text AS modulo,
      b.fundo_cnpj,
      COALESCE(b.nome_fonte, public.risco_nome_fundo_competencia(b.fundo_cnpj, NULL, v_fim), b.fundo_cnpj) AS fundo_nome,
      'atencao'::text AS nivel,
      'COTA_CDI_2000'::text AS source_key,
      'risco_mercado_fundos_diario'::text AS source_table,
      'Oscilacao da cota superior a 2.000% do CDI/dia'::text AS titulo,
      'Gatilho de monitoramento de mercado que requer analise e registro da tratativa.'::text AS descricao,
      b.data_primeira,
      b.data_ultima,
      b.dias_ocorrencia,
      b.valor_pior,
      20::numeric AS limite_referencia,
      'multiplo_cdi'::text AS unidade,
      jsonb_build_object('metrica', 'relacao_cota_cdi') AS source_payload
    FROM mercado_base b
  ),
  fontes AS (
    SELECT * FROM liquidez
    UNION ALL
    SELECT * FROM mercado
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
      SELECT e.created_at
      FROM public.envios_notificacao_liquidez e
      WHERE e.status = 'enviado'
        AND regexp_replace(COALESCE(e.fundo_cnpj, ''), '\D', '', 'g') = o.fundo_cnpj
        AND e.data_referencia BETWEEN to_char(o.data_primeira, 'YYYYMMDD') AND to_char(o.data_ultima, 'YYYYMMDD')
      ORDER BY e.created_at DESC LIMIT 1
    ),
    notificacao_email_id = (
      SELECT e.email_id
      FROM public.envios_notificacao_liquidez e
      WHERE e.status = 'enviado'
        AND regexp_replace(COALESCE(e.fundo_cnpj, ''), '\D', '', 'g') = o.fundo_cnpj
        AND e.data_referencia BETWEEN to_char(o.data_primeira, 'YYYYMMDD') AND to_char(o.data_ultima, 'YYYYMMDD')
      ORDER BY e.created_at DESC LIMIT 1
    )
  WHERE o.competencia = v_competencia
    AND o.modulo = 'liquidez'
    AND o.notificacao_status = 'nao_enviada'
    AND EXISTS (
      SELECT 1 FROM public.envios_notificacao_liquidez e
      WHERE e.status = 'enviado'
        AND regexp_replace(COALESCE(e.fundo_cnpj, ''), '\D', '', 'g') = o.fundo_cnpj
        AND e.data_referencia BETWEEN to_char(o.data_primeira, 'YYYYMMDD') AND to_char(o.data_ultima, 'YYYYMMDD')
    );

  INSERT INTO public.risco_relatorios_mensais (competencia, preparado_por, created_by)
  VALUES (v_competencia, auth.uid(), auth.uid())
  ON CONFLICT (competencia) DO NOTHING;

  RETURN jsonb_build_object(
    'competencia', v_competencia,
    'ocorrencias_fundo_sincronizadas', v_total,
    'sincronizado_em', now()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.sincronizar_ocorrencias_enquadramento_isin(p_competencia DATE)
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
  v_total INTEGER := 0;
BEGIN
  IF auth.role() NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'Acesso nao autorizado';
  END IF;

  WITH fontes_base AS (
    SELECT
      CASE WHEN lower(e.regra_categoria) IN ('concentration', 'fidc-concentracao') THEN 'concentracao' ELSE 'enquadramento' END AS modulo,
      regexp_replace(e.fundo_cnpj, '\D', '', 'g') AS fundo_cnpj,
      upper(trim(e.fundo_isin)) AS fundo_isin,
      CASE WHEN bool_or(e.status = 'violacao') THEN 'violacao' ELSE 'atencao' END AS nivel,
      e.regra_codigo || '|' || upper(trim(e.fundo_isin)) AS source_key,
      COALESCE(max(e.regra_descricao), e.regra_codigo) AS titulo,
      max(e.regra_descricao) AS descricao,
      min(to_date(e.fundo_dtposicao, 'YYYYMMDD')) AS data_primeira,
      max(to_date(e.fundo_dtposicao, 'YYYYMMDD')) AS data_ultima,
      count(DISTINCT e.fundo_dtposicao)::integer AS dias_ocorrencia,
      max(e.valor_atual) AS valor_pior,
      max(e.valor_limite) AS limite_referencia,
      max(e.regra_categoria) AS regra_categoria,
      e.regra_codigo
    FROM public.enquadramento_resultado e
    WHERE e.status IN ('alerta', 'violacao')
      AND trim(COALESCE(e.fundo_isin, '')) <> ''
      AND e.fundo_dtposicao BETWEEN v_inicio_texto AND v_fim_texto
    GROUP BY
      regexp_replace(e.fundo_cnpj, '\D', '', 'g'),
      upper(trim(e.fundo_isin)),
      e.regra_categoria,
      e.regra_codigo
  ),
  fontes AS (
    SELECT
      v_competencia AS competencia,
      b.modulo,
      b.fundo_cnpj,
      b.fundo_isin,
      COALESCE(public.risco_nome_fundo_competencia(b.fundo_cnpj, b.fundo_isin, v_fim), b.fundo_cnpj) AS fundo_nome,
      b.nivel,
      b.source_key,
      'enquadramento_resultado'::text AS source_table,
      b.titulo,
      b.descricao,
      b.data_primeira,
      b.data_ultima,
      b.dias_ocorrencia,
      b.valor_pior,
      b.limite_referencia,
      'indice'::text AS unidade,
      jsonb_build_object('categoria', b.regra_categoria, 'regra', b.regra_codigo, 'fundo_isin', b.fundo_isin) AS source_payload
    FROM fontes_base b
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
        AND e.data_referencia BETWEEN to_char(o.data_primeira, 'YYYYMMDD') AND to_char(o.data_ultima, 'YYYYMMDD')
      ORDER BY e.created_at DESC LIMIT 1
    ),
    notificacao_email_id = (
      SELECT e.email_id
      FROM public.envios_notificacao_desenquadramento e
      WHERE e.status = 'enviado'
        AND e.data_referencia BETWEEN to_char(o.data_primeira, 'YYYYMMDD') AND to_char(o.data_ultima, 'YYYYMMDD')
      ORDER BY e.created_at DESC LIMIT 1
    )
  WHERE o.competencia = v_competencia
    AND o.modulo IN ('enquadramento', 'concentracao')
    AND o.fundo_isin <> ''
    AND o.notificacao_status = 'nao_enviada'
    AND EXISTS (
      SELECT 1 FROM public.envios_notificacao_desenquadramento e
      WHERE e.status = 'enviado'
        AND e.data_referencia BETWEEN to_char(o.data_primeira, 'YYYYMMDD') AND to_char(o.data_ultima, 'YYYYMMDD')
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
  v_fundos JSONB;
  v_classes JSONB;
BEGIN
  IF auth.role() NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'Acesso nao autorizado';
  END IF;

  v_fundos := public.sincronizar_ocorrencias_risco_fundos(p_competencia);
  v_classes := public.sincronizar_ocorrencias_enquadramento_isin(p_competencia);

  RETURN jsonb_build_object(
    'competencia', date_trunc('month', p_competencia)::date,
    'fontes_fundo', v_fundos,
    'fontes_classe', v_classes,
    'sincronizado_em', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sincronizar_ocorrencias_risco_fundos(DATE) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.sincronizar_ocorrencias_enquadramento_isin(DATE) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.sincronizar_ocorrencias_risco(DATE) TO authenticated, service_role;

COMMENT ON FUNCTION public.sincronizar_ocorrencias_risco(DATE) IS
  'Sincroniza ocorrencias mensais por fundo e por classe sem varrer integralmente a posicao_carteira.';
