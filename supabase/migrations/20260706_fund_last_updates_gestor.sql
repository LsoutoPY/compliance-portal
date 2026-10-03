-- Enriquece get_fund_last_updates com dados de gestor e flag de monitoramento
DROP FUNCTION IF EXISTS get_fund_last_updates();

CREATE OR REPLACE FUNCTION get_fund_last_updates()
RETURNS TABLE (
  nome_fundo text,
  cnpj_fundo text,
  dt_posicao text,
  administrador text,
  gestor_nome text,
  cnpj_gestor text,
  is_monitorado boolean
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (p.fundo_cnpj)
    COALESCE(p.nome_fundo, p.fundo_nome) AS nome_fundo,
    p.fundo_cnpj AS cnpj_fundo,
    p.fundo_dtposicao AS dt_posicao,
    p.fundo_nomeadm AS administrador,
    p.fundo_nomegestor AS gestor_nome,
    p.fundo_cnpjgestor AS cnpj_gestor,
    public.is_gestor_monitorado(p.fundo_cnpjgestor) AS is_monitorado
  FROM posicao_carteira p
  WHERE p.fundo_cnpj IS NOT NULL
  ORDER BY p.fundo_cnpj, p.fundo_dtposicao DESC;
END;
$$ LANGUAGE plpgsql;
