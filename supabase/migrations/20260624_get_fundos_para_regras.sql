-- RPC: fundos disponíveis para associação de regras de enquadramento.
--
-- Regra de elegibilidade:
--   Para cada par (fundo_cnpj, fundo_isin), identifica a linha mais recente
--   onde fundo_cnpjgestor está preenchido (não-nulo, não-vazio) e verifica se
--   esse gestor está na allowlist. Linhas com gestor em branco são ignoradas
--   no critério de elegibilidade (mas usadas para extrair o nome do fundo).
--
-- Isso evita dois erros opostos:
--   - Manter fundos que mudaram de gestora (seria elegível por qualquer data histórica)
--   - Perder fundos cujos XMLs mais recentes vieram sem fundo_cnpjgestor preenchido

create or replace function public.get_fundos_para_regras()
returns table (fundo_cnpj text, fundo_isin text, fundo_nome text)
language sql stable parallel safe as $$
  with
  -- base: normaliza fundo_isin nulo para '' e extrai nome
  base as (
    select
      fundo_cnpj,
      coalesce(fundo_isin, '')              as fundo_isin,
      fundo_cnpjgestor,
      fundo_dtposicao,
      coalesce(nome_fundo, fundo_nome, '')  as nome
    from public.posicao_carteira
  ),

  -- linha mais recente com gestor preenchido por par (CNPJ, ISIN)
  com_gestor_ranked as (
    select
      fundo_cnpj,
      fundo_isin,
      fundo_cnpjgestor,
      row_number() over (
        partition by fundo_cnpj, fundo_isin
        order by fundo_dtposicao desc
      ) as rn
    from base
    where fundo_cnpjgestor is not null and fundo_cnpjgestor <> ''
  ),

  -- gestor "atual" de cada par = linha de rank 1
  gestora_atual as (
    select fundo_cnpj, fundo_isin, fundo_cnpjgestor
    from com_gestor_ranked
    where rn = 1
  ),

  -- pares cujo gestor atual está na allowlist
  pares_aprovados as (
    select fundo_cnpj, fundo_isin
    from gestora_atual
    where public.is_gestor_monitorado(fundo_cnpjgestor)
  ),

  -- CNPJs aprovados que têm ao menos um ISIN real (para filtrar entradas '' espúrias)
  cnpjs_com_isin as (
    select distinct fundo_cnpj
    from pares_aprovados
    where fundo_isin <> ''
  ),

  -- nome do par = linha com fundo_dtposicao mais recente (não max alfabético)
  nome_ranked as (
    select
      fundo_cnpj,
      fundo_isin,
      nome,
      row_number() over (
        partition by fundo_cnpj, fundo_isin
        order by fundo_dtposicao desc
      ) as rn
    from base
    where nome <> ''
  ),

  nome_atual as (
    select fundo_cnpj, fundo_isin, nome as fundo_nome
    from nome_ranked
    where rn = 1
  ),

  pares_filtrados as (
    select fundo_cnpj, fundo_isin
    from pares_aprovados
    where
      fundo_isin <> ''
      or fundo_cnpj not in (select fundo_cnpj from cnpjs_com_isin)
  )

  select
    pf.fundo_cnpj,
    pf.fundo_isin,
    coalesce(na.fundo_nome, '') as fundo_nome
  from pares_filtrados pf
  left join nome_atual na
    on  na.fundo_cnpj = pf.fundo_cnpj
    and na.fundo_isin  = pf.fundo_isin
  order by coalesce(na.fundo_nome, pf.fundo_cnpj)
$$;

comment on function public.get_fundos_para_regras is
  'Pares (fundo_cnpj, fundo_isin) elegíveis para associação de regras: '
  'gestor atual (linha mais recente com fundo_cnpjgestor preenchido) deve estar na allowlist. '
  'CNPJs com ISINs reais têm a entrada vazia descartada para evitar duplicatas. '
  'fundo_nome vem da linha com fundo_dtposicao mais recente (coalesce nome_fundo, fundo_nome).';

grant execute on function public.get_fundos_para_regras() to authenticated;
