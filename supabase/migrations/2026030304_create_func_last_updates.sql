DROP FUNCTION IF EXISTS get_fund_last_updates();

CREATE OR REPLACE FUNCTION get_fund_last_updates()
RETURNS TABLE (
  nome_fundo text,
  cnpj_fundo text,
  dt_posicao text,
  administrador text
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (p.fundo_cnpj)
    COALESCE(p.nome_fundo, p.fundo_nome) as nome_fundo,
    p.fundo_cnpj as cnpj_fundo,
    p.fundo_dtposicao as dt_posicao,
    p.fundo_nomeadm as administrador
  FROM posicao_carteira p
  WHERE p.fundo_cnpj IS NOT NULL
  ORDER BY p.fundo_cnpj, p.fundo_dtposicao DESC;
END;
$$ LANGUAGE plpgsql;
