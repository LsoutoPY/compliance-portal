-- Classes distintas podem compartilhar CNPJ (ex.: NEXUM JR e SR). Quando há
-- ISIN, o nome deve vir obrigatoriamente da mesma classe; o cache por CNPJ só
-- é seguro para fontes que não possuem ISIN.

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
      SELECT NULLIF(trim(f.nome_comercial), '')
      FROM public.fundos_caracteristicas f
      WHERE NULLIF(trim(p_isin), '') IS NOT NULL
        AND upper(trim(COALESCE(f.isin, ''))) = upper(trim(p_isin))
        AND (
          regexp_replace(COALESCE(f.cnpj_classe, ''), '\D', '', 'g') = regexp_replace(p_cnpj, '\D', '', 'g')
          OR regexp_replace(COALESCE(f.cnpj_fundo, ''), '\D', '', 'g') = regexp_replace(p_cnpj, '\D', '', 'g')
        )
      ORDER BY CASE WHEN regexp_replace(COALESCE(f.cnpj_classe, ''), '\D', '', 'g') = regexp_replace(p_cnpj, '\D', '', 'g') THEN 0 ELSE 1 END
      LIMIT 1
    ),
    (
      SELECT COALESCE(
        NULLIF(trim(p.nome_fundo), ''),
        NULLIF(trim(p.fundo_nome), '')
      )
      FROM public.posicao_carteira p
      WHERE p.fundo_cnpj = p_cnpj
        AND NULLIF(trim(p_isin), '') IS NOT NULL
        AND upper(trim(COALESCE(p.fundo_isin, ''))) = upper(trim(p_isin))
        AND p.fundo_dtposicao <= to_char(p_data_limite, 'YYYYMMDD')
      ORDER BY p.fundo_dtposicao DESC NULLS LAST
      LIMIT 1
    ),
    (
      SELECT NULLIF(trim(c.nome_fundo), '')
      FROM public.fund_last_updates_cache c
      WHERE c.cnpj_fundo = p_cnpj
        AND NULLIF(trim(p_isin), '') IS NULL
      LIMIT 1
    ),
    (
      SELECT COALESCE(
        NULLIF(trim(p.nome_fundo), ''),
        NULLIF(trim(p.fundo_nome), '')
      )
      FROM public.posicao_carteira p
      WHERE p.fundo_cnpj = p_cnpj
        AND NULLIF(trim(p_isin), '') IS NULL
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
  'Resolve nomes por CNPJ + ISIN para classes; usa cache por CNPJ apenas quando a fonte não possui ISIN.';

-- Corrige ocorrências já consolidadas com nome herdado de outra classe.
UPDATE public.risco_ocorrencias o
SET fundo_nome = public.risco_nome_fundo_competencia(
      o.fundo_cnpj,
      o.fundo_isin,
      (o.competencia + interval '1 month - 1 day')::date
    )
WHERE NULLIF(trim(o.fundo_isin), '') IS NOT NULL
  AND o.fundo_nome IS DISTINCT FROM public.risco_nome_fundo_competencia(
        o.fundo_cnpj,
        o.fundo_isin,
        (o.competencia + interval '1 month - 1 day')::date
      );

NOTIFY pgrst, 'reload schema';
