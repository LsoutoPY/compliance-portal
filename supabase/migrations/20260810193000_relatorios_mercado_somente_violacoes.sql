-- Relatorios de Risco & Compliance
-- Qualidade da serie e um alerta de dados, nao uma ocorrencia do fundo.
-- Ela permanece no modulo operacional de Mercado, mas nao integra o dossie mensal.

CREATE OR REPLACE FUNCTION public.risco_bloquear_alerta_qualidade_serie()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.modulo = 'mercado' AND NEW.source_key = 'QUALIDADE_SERIE' THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_risco_bloquear_qualidade_serie ON public.risco_ocorrencias;
CREATE TRIGGER trg_risco_bloquear_qualidade_serie
  BEFORE INSERT OR UPDATE ON public.risco_ocorrencias
  FOR EACH ROW EXECUTE FUNCTION public.risco_bloquear_alerta_qualidade_serie();

-- Os registros existentes eram integralmente derivados e ainda nao tinham plano de acao.
DELETE FROM public.risco_ocorrencias o
WHERE o.modulo = 'mercado'
  AND o.source_key = 'QUALIDADE_SERIE'
  AND NOT EXISTS (
    SELECT 1
    FROM public.risco_planos_acao p
    WHERE p.ocorrencia_id = o.id
  );

-- Defesa adicional: mesmo um registro legado preservado por possuir tratativa nao polui
-- o dossie mensal nem suas exportacoes.
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
) p ON true
WHERE NOT (o.modulo = 'mercado' AND o.source_key = 'QUALIDADE_SERIE');

NOTIFY pgrst, 'reload schema';
