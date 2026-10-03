-- Motor incremental: fontes publicam evidências diárias; a tela consome a fila curta.
-- Histórico é capturado em job separado, nunca no clique do usuário.

CREATE TABLE IF NOT EXISTS public.risco_evidencias_diarias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  modulo text NOT NULL CHECK (modulo IN ('enquadramento','liquidez','mercado','concentracao')),
  fonte text NOT NULL,
  fundo_cnpj text NOT NULL CHECK (fundo_cnpj ~ '^[0-9]{14}$'),
  fundo_isin text NOT NULL DEFAULT '',
  fundo_nome text,
  chave_regra text NOT NULL,
  titulo text NOT NULL,
  descricao text,
  data_referencia date NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','atencao','violacao','pendente')),
  valor_atual numeric,
  limite_referencia numeric,
  unidade text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  origem_atualizada_em timestamptz,
  capturada_em timestamptz NOT NULL DEFAULT now(),
  processada_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (modulo, fundo_cnpj, fundo_isin, chave_regra, data_referencia)
);
COMMENT ON TABLE public.risco_evidencias_diarias IS
  'Contrato canônico diário. pendente ou ausência de cálculo não encerra episódio.';
CREATE INDEX IF NOT EXISTS idx_risco_evidencias_pendentes ON public.risco_evidencias_diarias (data_referencia, capturada_em) WHERE processada_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_risco_evidencias_identidade ON public.risco_evidencias_diarias (modulo, fundo_cnpj, fundo_isin, chave_regra, data_referencia);

CREATE TABLE IF NOT EXISTS public.risco_episodio_inconsistencias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidencia_id uuid NOT NULL REFERENCES public.risco_evidencias_diarias(id) ON DELETE CASCADE,
  episodio_id uuid REFERENCES public.risco_episodios(id) ON DELETE SET NULL,
  tipo text NOT NULL CHECK (tipo IN ('correcao_historica','sequencia_fora_de_ordem')),
  detalhes jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolvida_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evidencia_id, tipo)
);
CREATE INDEX IF NOT EXISTS idx_risco_episodio_inconsistencias_abertas ON public.risco_episodio_inconsistencias (created_at DESC) WHERE resolvida_em IS NULL;

ALTER TABLE public.risco_evidencias_diarias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risco_episodio_inconsistencias ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read_risco_evidencias_diarias" ON public.risco_evidencias_diarias FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_risco_episodio_inconsistencias" ON public.risco_episodio_inconsistencias FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.risco_evidencias_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_risco_evidencias_updated_at ON public.risco_evidencias_diarias;
CREATE TRIGGER trg_risco_evidencias_updated_at BEFORE UPDATE ON public.risco_evidencias_diarias FOR EACH ROW EXECUTE FUNCTION public.risco_evidencias_set_updated_at();

CREATE OR REPLACE FUNCTION public.registrar_evidencia_diaria_risco(
  p_modulo text, p_fonte text, p_fundo_cnpj text, p_fundo_isin text, p_chave_regra text,
  p_titulo text, p_descricao text, p_data_referencia date, p_status text,
  p_valor_atual numeric DEFAULT NULL, p_limite_referencia numeric DEFAULT NULL,
  p_unidade text DEFAULT NULL, p_payload jsonb DEFAULT '{}'::jsonb,
  p_origem_atualizada_em timestamptz DEFAULT NULL, p_fundo_nome text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_cnpj text:=regexp_replace(coalesce(p_fundo_cnpj,''),'\D','','g');
  v_status text:=CASE lower(trim(coalesce(p_status,'pendente'))) WHEN 'ok' THEN 'ok' WHEN 'alerta' THEN 'atencao' WHEN 'atencao' THEN 'atencao' WHEN 'violacao' THEN 'violacao' ELSE 'pendente' END;
BEGIN
  IF p_modulo NOT IN ('enquadramento','liquidez','mercado','concentracao') OR length(v_cnpj)<>14 OR p_data_referencia IS NULL OR trim(coalesce(p_chave_regra,''))='' THEN RAISE EXCEPTION 'Evidencia diaria de risco invalida'; END IF;
  INSERT INTO public.risco_evidencias_diarias(modulo,fonte,fundo_cnpj,fundo_isin,fundo_nome,chave_regra,titulo,descricao,data_referencia,status,valor_atual,limite_referencia,unidade,payload,origem_atualizada_em,capturada_em,processada_em)
  VALUES(p_modulo,trim(p_fonte),v_cnpj,upper(trim(coalesce(p_fundo_isin,''))),nullif(trim(p_fundo_nome),''),trim(p_chave_regra),trim(p_titulo),p_descricao,p_data_referencia,v_status,p_valor_atual,p_limite_referencia,p_unidade,coalesce(p_payload,'{}'::jsonb),p_origem_atualizada_em,now(),NULL)
  ON CONFLICT(modulo,fundo_cnpj,fundo_isin,chave_regra,data_referencia) DO UPDATE SET
    fonte=EXCLUDED.fonte,fundo_nome=coalesce(EXCLUDED.fundo_nome,risco_evidencias_diarias.fundo_nome),titulo=EXCLUDED.titulo,descricao=EXCLUDED.descricao,status=EXCLUDED.status,valor_atual=EXCLUDED.valor_atual,limite_referencia=EXCLUDED.limite_referencia,unidade=EXCLUDED.unidade,payload=EXCLUDED.payload,origem_atualizada_em=EXCLUDED.origem_atualizada_em,capturada_em=now(),processada_em=NULL
  WHERE (risco_evidencias_diarias.fonte,risco_evidencias_diarias.titulo,risco_evidencias_diarias.descricao,risco_evidencias_diarias.status,risco_evidencias_diarias.valor_atual,risco_evidencias_diarias.limite_referencia,risco_evidencias_diarias.unidade,risco_evidencias_diarias.payload)
    IS DISTINCT FROM (EXCLUDED.fonte,EXCLUDED.titulo,EXCLUDED.descricao,EXCLUDED.status,EXCLUDED.valor_atual,EXCLUDED.limite_referencia,EXCLUDED.unidade,EXCLUDED.payload)
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM public.risco_evidencias_diarias WHERE modulo=p_modulo AND fundo_cnpj=v_cnpj AND fundo_isin=upper(trim(coalesce(p_fundo_isin,''))) AND chave_regra=trim(p_chave_regra) AND data_referencia=p_data_referencia; END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.risco_capturar_enquadramento_evidencia()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.fundo_dtposicao~'^[0-9]{8}$' THEN
    PERFORM public.registrar_evidencia_diaria_risco(CASE WHEN lower(NEW.regra_categoria) IN ('concentration','fidc-concentracao') THEN 'concentracao' ELSE 'enquadramento' END,'enquadramento_resultado',NEW.fundo_cnpj,coalesce(NEW.fundo_isin,''),NEW.regra_codigo,coalesce(NEW.regra_descricao,NEW.regra_codigo),NEW.regra_descricao,to_date(NEW.fundo_dtposicao,'YYYYMMDD'),NEW.status,NEW.valor_atual,NEW.valor_limite,'indice',coalesce(NEW.detalhes,'{}'::jsonb),NEW.verificado_em,NULL);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_risco_capturar_enquadramento_evidencia ON public.enquadramento_resultado;
CREATE TRIGGER trg_risco_capturar_enquadramento_evidencia AFTER INSERT OR UPDATE OF status,regra_descricao,valor_atual,valor_limite,detalhes,verificado_em ON public.enquadramento_resultado FOR EACH ROW EXECUTE FUNCTION public.risco_capturar_enquadramento_evidencia();

CREATE OR REPLACE FUNCTION public.risco_capturar_liquidez_evidencia()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_status text; v_chave text; v_titulo text; v_valor numeric; v_unidade text;
BEGIN
  IF NEW.dt_posicao !~ '^[0-9]{8}$' THEN RETURN NEW; END IF;
  IF NEW.is_fundo_fechado THEN v_status:=coalesce(NEW.status_cobertura,'pendente');v_chave:='LIQUIDEZ_COBERTURA';v_titulo:='Cobertura operacional de liquidez';v_valor:=NEW.meses_cobertura;v_unidade:='meses';
  ELSE v_status:=coalesce(NEW.status,'pendente');v_chave:='LIQUIDEZ_RESGATE';v_titulo:='Índice de liquidez para resgates';v_valor:=NEW.indice_liquidez;v_unidade:='indice'; END IF;
  PERFORM public.registrar_evidencia_diaria_risco('liquidez','liquidez_monitoramento_risco',NEW.fundo_cnpj,'',v_chave,v_titulo,NULL,to_date(NEW.dt_posicao,'YYYYMMDD'),v_status,v_valor,NULL,v_unidade,jsonb_build_object('is_fundo_fechado',NEW.is_fundo_fechado,'status_principal',NEW.status,'status_cobertura',NEW.status_cobertura,'intermediate_status',NEW.intermediate_status,'fonte_despesa',NEW.fonte_despesa),NEW.calculado_em,NULL);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_risco_capturar_liquidez_evidencia ON public.liquidez_monitoramento_risco;
CREATE TRIGGER trg_risco_capturar_liquidez_evidencia AFTER INSERT OR UPDATE OF status,status_cobertura,indice_liquidez,meses_cobertura,intermediate_status,calculado_em ON public.liquidez_monitoramento_risco FOR EACH ROW EXECUTE FUNCTION public.risco_capturar_liquidez_evidencia();

CREATE OR REPLACE FUNCTION public.processar_evidencias_risco(p_limite integer DEFAULT 1000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_e public.risco_evidencias_diarias%ROWTYPE;v_ep public.risco_episodios%ROWTYPE;v_nome text;v_total integer:=0;v_abertos integer:=0;v_regularizados integer:=0;v_pendentes integer:=0;v_correcoes integer:=0;
BEGIN
  IF auth.role() NOT IN ('authenticated','service_role') THEN RAISE EXCEPTION 'Acesso não autorizado'; END IF;
  FOR v_e IN SELECT * FROM public.risco_evidencias_diarias WHERE processada_em IS NULL ORDER BY data_referencia,capturada_em,id LIMIT greatest(1,least(coalesce(p_limite,1000),5000)) FOR UPDATE SKIP LOCKED LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|',v_e.modulo,v_e.fundo_cnpj,v_e.fundo_isin,v_e.chave_regra),0));
    SELECT * INTO v_ep FROM public.risco_episodios WHERE modulo=v_e.modulo AND fundo_cnpj=v_e.fundo_cnpj AND fundo_isin=v_e.fundo_isin AND source_key=v_e.chave_regra AND data_regularizacao IS NULL ORDER BY data_inicio DESC LIMIT 1 FOR UPDATE;
    IF v_e.status='pendente' THEN UPDATE public.risco_evidencias_diarias SET processada_em=now() WHERE id=v_e.id;v_total:=v_total+1;v_pendentes:=v_pendentes+1;CONTINUE; END IF;
    IF v_ep.id IS NOT NULL AND v_e.data_referencia<v_ep.data_ultima_evidencia THEN
      INSERT INTO public.risco_episodio_inconsistencias(evidencia_id,episodio_id,tipo,detalhes) VALUES(v_e.id,v_ep.id,'correcao_historica',jsonb_build_object('data_evidencia',v_e.data_referencia,'ultima_evidencia',v_ep.data_ultima_evidencia,'status',v_e.status)) ON CONFLICT(evidencia_id,tipo) DO UPDATE SET detalhes=EXCLUDED.detalhes,resolvida_em=NULL;
      UPDATE public.risco_evidencias_diarias SET processada_em=now() WHERE id=v_e.id;v_total:=v_total+1;v_correcoes:=v_correcoes+1;CONTINUE;
    END IF;
    IF v_e.status='ok' THEN
      IF v_ep.id IS NOT NULL AND v_e.data_referencia>=v_ep.data_ultima_evidencia THEN UPDATE public.risco_episodios SET data_regularizacao=v_e.data_referencia,status_workflow='regularizada',source_payload=v_ep.source_payload||jsonb_build_object('ultima_evidencia',v_e.data_referencia,'regularizado_por',v_e.fonte) WHERE id=v_ep.id;v_regularizados:=v_regularizados+1; END IF;
    ELSIF v_ep.id IS NULL THEN
      v_nome:=coalesce(nullif(trim(v_e.fundo_nome),''),public.risco_nome_fundo_competencia(v_e.fundo_cnpj,nullif(v_e.fundo_isin,''),v_e.data_referencia),v_e.fundo_cnpj);
      INSERT INTO public.risco_episodios(chave_episodio,modulo,fundo_cnpj,fundo_isin,fundo_nome,source_key,source_table,titulo,descricao,nivel_atual,violacao_detectada,data_inicio,data_ultima_evidencia,dias_com_evidencia,valor_atual,valor_pior,limite_referencia,unidade,status_workflow,source_payload) VALUES(md5(concat_ws('|',v_e.modulo,v_e.fundo_cnpj,v_e.fundo_isin,v_e.chave_regra,v_e.data_referencia::text)),v_e.modulo,v_e.fundo_cnpj,v_e.fundo_isin,v_nome,v_e.chave_regra,v_e.fonte,v_e.titulo,v_e.descricao,v_e.status,v_e.status='violacao',v_e.data_referencia,v_e.data_referencia,1,v_e.valor_atual,v_e.valor_atual,v_e.limite_referencia,v_e.unidade,CASE WHEN v_e.status='violacao' THEN 'aguardando_plano' ELSE 'aberta' END,jsonb_build_object('fonte_diaria',v_e.fonte,'ultima_evidencia',v_e.data_referencia));v_abertos:=v_abertos+1;
    ELSE
      UPDATE public.risco_episodios SET titulo=v_e.titulo,descricao=v_e.descricao,nivel_atual=v_e.status,violacao_detectada=risco_episodios.violacao_detectada OR v_e.status='violacao',data_ultima_evidencia=greatest(risco_episodios.data_ultima_evidencia,v_e.data_referencia),dias_com_evidencia=risco_episodios.dias_com_evidencia+CASE WHEN v_e.data_referencia>risco_episodios.data_ultima_evidencia THEN 1 ELSE 0 END,valor_atual=v_e.valor_atual,limite_referencia=v_e.limite_referencia,unidade=v_e.unidade,status_workflow=CASE WHEN risco_episodios.violacao_detectada OR v_e.status='violacao' THEN CASE WHEN EXISTS(SELECT 1 FROM public.risco_episodio_planos_acao p WHERE p.episodio_id=risco_episodios.id AND p.status<>'substituido') THEN 'em_tratamento' ELSE 'aguardando_plano' END ELSE 'aberta' END,source_payload=risco_episodios.source_payload||jsonb_build_object('ultima_evidencia',v_e.data_referencia,'fonte_diaria',v_e.fonte) WHERE id=v_ep.id;
    END IF;
    UPDATE public.risco_evidencias_diarias SET processada_em=now() WHERE id=v_e.id;v_total:=v_total+1;
  END LOOP;
  RETURN jsonb_build_object('evidencias_processadas',v_total,'episodios_abertos',v_abertos,'episodios_regularizados',v_regularizados,'evidencias_pendentes',v_pendentes,'correcoes_para_reconciliar',v_correcoes,'processado_em',now());
END;
$$;

-- Backfill administrativo, por janela e com limite. Não concedido ao frontend.
CREATE OR REPLACE FUNCTION public.capturar_evidencias_risco_historicas(p_data_inicio date,p_data_fim date,p_limite integer DEFAULT 10000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_enq integer:=0;v_liq integer:=0;v_origem record;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'Backfill permitido somente ao serviço administrativo'; END IF;
  IF p_data_inicio IS NULL OR p_data_fim IS NULL OR p_data_inicio>p_data_fim THEN RAISE EXCEPTION 'Intervalo de backfill inválido'; END IF;
  FOR v_origem IN SELECT e.* FROM public.enquadramento_resultado e WHERE e.fundo_dtposicao~'^[0-9]{8}$' AND to_date(e.fundo_dtposicao,'YYYYMMDD') BETWEEN p_data_inicio AND p_data_fim ORDER BY e.fundo_dtposicao,e.id LIMIT greatest(1,least(p_limite,50000)) LOOP
    PERFORM public.registrar_evidencia_diaria_risco(CASE WHEN lower(v_origem.regra_categoria) IN ('concentration','fidc-concentracao') THEN 'concentracao' ELSE 'enquadramento' END,'enquadramento_resultado',v_origem.fundo_cnpj,coalesce(v_origem.fundo_isin,''),v_origem.regra_codigo,coalesce(v_origem.regra_descricao,v_origem.regra_codigo),v_origem.regra_descricao,to_date(v_origem.fundo_dtposicao,'YYYYMMDD'),v_origem.status,v_origem.valor_atual,v_origem.valor_limite,'indice',coalesce(v_origem.detalhes,'{}'::jsonb),v_origem.verificado_em,NULL);
    v_enq:=v_enq+1;
  END LOOP;
  FOR v_origem IN SELECT l.* FROM public.liquidez_monitoramento_risco l WHERE l.dt_posicao~'^[0-9]{8}$' AND to_date(l.dt_posicao,'YYYYMMDD') BETWEEN p_data_inicio AND p_data_fim ORDER BY l.dt_posicao,l.id LIMIT greatest(1,least(p_limite,50000)) LOOP
    PERFORM public.registrar_evidencia_diaria_risco('liquidez','liquidez_monitoramento_risco',v_origem.fundo_cnpj,'',CASE WHEN v_origem.is_fundo_fechado THEN 'LIQUIDEZ_COBERTURA' ELSE 'LIQUIDEZ_RESGATE' END,CASE WHEN v_origem.is_fundo_fechado THEN 'Cobertura operacional de liquidez' ELSE 'Índice de liquidez para resgates' END,NULL,to_date(v_origem.dt_posicao,'YYYYMMDD'),CASE WHEN v_origem.is_fundo_fechado THEN coalesce(v_origem.status_cobertura,'pendente') ELSE coalesce(v_origem.status,'pendente') END,CASE WHEN v_origem.is_fundo_fechado THEN v_origem.meses_cobertura ELSE v_origem.indice_liquidez END,NULL,CASE WHEN v_origem.is_fundo_fechado THEN 'meses' ELSE 'indice' END,jsonb_build_object('is_fundo_fechado',v_origem.is_fundo_fechado),v_origem.calculado_em,NULL);
    v_liq:=v_liq+1;
  END LOOP;
  RETURN jsonb_build_object('enquadramento_capturado',v_enq,'liquidez_capturada',v_liq,'intervalo',jsonb_build_array(p_data_inicio,p_data_fim));
END;
$$;

GRANT SELECT ON public.risco_evidencias_diarias,public.risco_episodio_inconsistencias TO authenticated;
GRANT EXECUTE ON FUNCTION public.processar_evidencias_risco(integer) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.capturar_evidencias_risco_historicas(date,date,integer) TO service_role;
REVOKE ALL ON FUNCTION public.registrar_evidencia_diaria_risco(text,text,text,text,text,text,text,date,text,numeric,numeric,text,jsonb,timestamptz,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_evidencia_diaria_risco(text,text,text,text,text,text,text,date,text,numeric,numeric,text,jsonb,timestamptz,text) TO service_role;
NOTIFY pgrst,'reload schema';
