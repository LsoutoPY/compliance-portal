-- Fontes de liquidez operam no CNPJ do fundo e nÃ£o distinguem classes por ISIN.
-- NÃ£o Ã© seguro exibir o nome de uma classe (JR/SR) nessa evidÃªncia.

CREATE OR REPLACE FUNCTION public.risco_nome_fundo_operacional(
  p_cnpj text,
  p_data_limite date
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    NULLIF(
      trim(
        regexp_replace(
          public.risco_nome_fundo_competencia(p_cnpj, NULL, p_data_limite),
          '\s+(JR|SR|MEZ[A-Z]*|SENIOR|JUNIOR)\s*$',
          '',
          'i'
        )
      ),
      ''
    ),
    p_cnpj
  );
$$;

REVOKE ALL ON FUNCTION public.risco_nome_fundo_operacional(text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.risco_nome_fundo_operacional(text, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.risco_capturar_liquidez_evidencia()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_chave text;
  v_titulo text;
  v_valor numeric;
  v_unidade text;
  v_data date;
BEGIN
  IF NEW.dt_posicao !~ '^[0-9]{8}$' THEN RETURN NEW; END IF;
  v_data := to_date(NEW.dt_posicao, 'YYYYMMDD');

  IF NEW.is_fundo_fechado THEN
    v_status := coalesce(NEW.status_cobertura, 'pendente');
    v_chave := 'LIQUIDEZ_COBERTURA';
    v_titulo := 'Cobertura operacional de liquidez';
    v_valor := NEW.meses_cobertura;
    v_unidade := 'meses';
  ELSE
    v_status := CASE
      WHEN lower(coalesce(NEW.status, '')) = 'violacao' THEN 'violacao'
      WHEN lower(coalesce(NEW.intermediate_status, '')) = 'alerta'
        OR lower(coalesce(NEW.status, '')) = 'alerta' THEN 'atencao'
      WHEN lower(coalesce(NEW.status, '')) = 'ok' THEN 'ok'
      ELSE 'pendente'
    END;
    v_chave := 'LIQUIDEZ_RESGATE';
    v_titulo := 'Índice de liquidez para resgates';
    v_valor := NEW.indice_liquidez;
    v_unidade := 'indice';
  END IF;

  PERFORM public.registrar_evidencia_diaria_risco(
    'liquidez',
    'liquidez_monitoramento_risco',
    NEW.fundo_cnpj,
    '',
    v_chave,
    v_titulo,
    NULL,
    v_data,
    v_status,
    v_valor,
    NULL,
    v_unidade,
    jsonb_build_object(
      'is_fundo_fechado', NEW.is_fundo_fechado,
      'status_principal', NEW.status,
      'status_cobertura', NEW.status_cobertura,
      'intermediate_status', NEW.intermediate_status,
      'fonte_despesa', NEW.fonte_despesa
    ),
    NEW.calculado_em,
    public.risco_nome_fundo_operacional(NEW.fundo_cnpj, v_data)
  );
  RETURN NEW;
END;
$$;

-- Corrige evidÃªncias e episÃ³dios jÃ¡ existentes sem alterar sua identidade.
UPDATE public.risco_evidencias_diarias e
SET fundo_nome = public.risco_nome_fundo_operacional(e.fundo_cnpj, e.data_referencia)
WHERE e.modulo = 'liquidez'
  AND e.fundo_isin = '';

UPDATE public.risco_episodios e
SET fundo_nome = public.risco_nome_fundo_operacional(e.fundo_cnpj, e.data_ultima_evidencia)
WHERE e.modulo = 'liquidez'
  AND e.fundo_isin = '';

NOTIFY pgrst, 'reload schema';
