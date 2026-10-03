-- Evita consultar repetidamente a tabela volumosa de posicoes apenas para
-- obter o nome de exibicao. O cache por CNPJ e a fonte primaria; a busca
-- historica continua como fallback para fundos ainda nao cacheados.

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
    (
      SELECT NULLIF(trim(c.nome_fundo), '')
      FROM public.fund_last_updates_cache c
      WHERE c.cnpj_fundo = p_cnpj
      LIMIT 1
    ),
    (
      SELECT COALESCE(
        NULLIF(trim(p.nome_fundo), ''),
        NULLIF(trim(p.fundo_nome), ''),
        p_cnpj
      )
      FROM public.posicao_carteira p
      WHERE p.fundo_cnpj = p_cnpj
        AND (
          NULLIF(trim(p_isin), '') IS NULL
          OR upper(trim(COALESCE(p.fundo_isin, ''))) = upper(trim(p_isin))
        )
        AND p.fundo_dtposicao <= to_char(p_data_limite, 'YYYYMMDD')
      ORDER BY p.fundo_dtposicao DESC NULLS LAST
      LIMIT 1
    ),
    p_cnpj
  );
$$;

REVOKE ALL ON FUNCTION public.risco_nome_fundo_competencia(TEXT, TEXT, DATE)
  FROM PUBLIC;

COMMENT ON FUNCTION public.risco_nome_fundo_competencia(TEXT, TEXT, DATE) IS
  'Resolve nome pelo cache de ultima posicao e usa posicao_carteira historica somente como fallback.';
