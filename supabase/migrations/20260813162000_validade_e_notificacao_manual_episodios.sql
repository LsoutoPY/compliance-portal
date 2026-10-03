ALTER TABLE public.risco_episodios
  ADD COLUMN IF NOT EXISTS validade_bloqueada_manualmente boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS validade_atualizada_em timestamptz,
  ADD COLUMN IF NOT EXISTS validade_atualizada_por uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS motivo_classificacao text;

ALTER TABLE public.risco_episodio_comunicacoes
  ADD COLUMN IF NOT EXISTS ocorrida_em timestamptz,
  ADD COLUMN IF NOT EXISTS destinatarios text[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION public.classificar_validade_episodio_risco(p_episodio_id uuid, p_validade text, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v public.risco_episodios%ROWTYPE; v_agora timestamptz:=clock_timestamp();
BEGIN
  IF NOT public.risco_usuario_pode_editar() THEN RAISE EXCEPTION 'Usuário sem permissão'; END IF;
  IF p_validade NOT IN ('confirmada','em_revisao','invalidada_correcao_dado') OR (p_validade<>'confirmada' AND p_motivo NOT IN ('xml_incorreto','arquivo_reprocessado','regra_incorreta','duplicidade','em_analise','outro')) THEN RAISE EXCEPTION 'Classificação inválida'; END IF;
  SELECT * INTO v FROM public.risco_episodios WHERE id=p_episodio_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Episódio não encontrado'; END IF;
  UPDATE public.risco_episodios SET validade_ocorrencia=p_validade,validade_bloqueada_manualmente=p_validade<>'confirmada',validade_atualizada_em=v_agora,validade_atualizada_por=auth.uid(),motivo_classificacao=CASE WHEN p_validade='confirmada' THEN NULL ELSE p_motivo END,status_workflow=CASE WHEN p_validade='invalidada_correcao_dado' THEN 'encerrada' WHEN v.status_workflow='encerrada' THEN CASE WHEN v.violacao_detectada THEN 'aguardando_plano' ELSE 'aberta' END ELSE v.status_workflow END WHERE id=p_episodio_id;
  INSERT INTO public.risco_episodio_comunicacoes(episodio_id,tipo,canal,assunto,conteudo,created_by) VALUES(p_episodio_id,'evidencia','manual','Validade do episódio atualizada',coalesce(p_motivo,'Confirmada'),auth.uid());
  RETURN jsonb_build_object('id',p_episodio_id,'validade',p_validade);
END; $$;

CREATE OR REPLACE FUNCTION public.registrar_notificacao_manual_episodio_risco(p_episodio_id uuid,p_ocorrida_em timestamptz,p_destinatarios text[] DEFAULT '{}',p_observacao text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.risco_usuario_pode_editar() THEN RAISE EXCEPTION 'Usuário sem permissão'; END IF;
  INSERT INTO public.risco_episodio_comunicacoes(episodio_id,tipo,canal,assunto,conteudo,ocorrida_em,destinatarios,created_by) VALUES(p_episodio_id,'notificacao_inicial','manual','Notificação manual registrada',nullif(trim(p_observacao),''),coalesce(p_ocorrida_em,now()),coalesce(p_destinatarios,'{}'),auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

DROP VIEW IF EXISTS public.vw_risco_episodios_monitoramento;
CREATE VIEW public.vw_risco_episodios_monitoramento WITH (security_invoker=true) AS
SELECT e.*,p.id plano_id,p.versao plano_versao,p.conteudo plano_conteudo,p.responsavel_nome plano_responsavel_nome,p.responsavel_email plano_responsavel_email,p.prazo plano_prazo,p.recebido_em plano_recebido_em,p.status plano_status,n.ocorrida_em notificacao_manual_em,n.destinatarios notificacao_manual_destinatarios,n.conteudo notificacao_manual_observacao,
CASE WHEN e.data_regularizacao IS NULL THEN (current_date-e.data_inicio+1) ELSE (e.data_regularizacao-e.data_inicio+1) END::integer dias_episodio,
CASE WHEN e.data_regularizacao IS NOT NULL OR e.validade_ocorrencia='invalidada_correcao_dado' THEN false WHEN e.violacao_detectada AND n.id IS NULL THEN true ELSE false END notificacao_pendente
FROM public.risco_episodios e
LEFT JOIN LATERAL(SELECT * FROM public.risco_episodio_planos_acao p WHERE p.episodio_id=e.id AND p.status<>'substituido' ORDER BY p.versao DESC LIMIT 1)p ON true
LEFT JOIN LATERAL(SELECT * FROM public.risco_episodio_comunicacoes c WHERE c.episodio_id=e.id AND c.tipo='notificacao_inicial' ORDER BY coalesce(c.ocorrida_em,c.created_at) DESC LIMIT 1)n ON true;
GRANT SELECT ON public.vw_risco_episodios_monitoramento TO authenticated;
GRANT EXECUTE ON FUNCTION public.classificar_validade_episodio_risco(uuid,text,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.registrar_notificacao_manual_episodio_risco(uuid,timestamptz,text[],text) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
