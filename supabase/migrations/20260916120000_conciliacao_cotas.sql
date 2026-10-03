-- Conciliação por instrumento e data, sem médias de PU e sem elevar permissões.
alter table public.informe_diario_metricas
  add column if not exists cnpj_origem text,
  add column if not exists vinculo_identidade text not null default 'legado'
    check (vinculo_identidade in ('direto', 'alias', 'legado'));

create index if not exists idx_conciliacao_posicao_data
  on public.posicao_carteira (fundo_dtposicao, section);

create table public.conciliacao_cotas_analises (
  id uuid primary key default gen_random_uuid(),
  grupo_chave text not null check (length(grupo_chave) between 1 and 200),
  data_referencia date not null,
  status text not null check (status in ('em_analise', 'justificado', 'resolvido')),
  justificativa text not null check (length(trim(justificativa)) between 5 and 4000),
  evidencia jsonb not null check (jsonb_typeof(evidencia) = 'object'),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_conciliacao_analises_grupo_data
  on public.conciliacao_cotas_analises (grupo_chave, data_referencia, created_at desc);
alter table public.conciliacao_cotas_analises enable row level security;
create policy conciliacao_analises_read on public.conciliacao_cotas_analises
  for select to authenticated using (public.user_is_active());
create policy conciliacao_analises_insert on public.conciliacao_cotas_analises
  for insert to authenticated with check (public.user_can_write() and created_by = auth.uid());
grant select, insert on public.conciliacao_cotas_analises to authenticated;
revoke update, delete on public.conciliacao_cotas_analises from authenticated, anon;
comment on table public.conciliacao_cotas_analises is
  'Histórico imutável de análises, com cópia das fontes e parâmetros vistos pelo analista. Não altera cotas.';

create or replace function public.get_conciliacao_cotas(
  p_data date, p_tolerancia_abs numeric default 0, p_tolerancia_pct numeric default 0
) returns jsonb language plpgsql stable security invoker set search_path = public
as $$
declare resultado jsonb;
begin
  if p_data is null or p_tolerancia_abs is null or p_tolerancia_pct is null
    or p_tolerancia_abs < 0 or p_tolerancia_pct < 0
    or p_tolerancia_abs::text in ('NaN', 'Infinity') or p_tolerancia_pct::text in ('NaN', 'Infinity') then
    raise exception 'Data e tolerâncias finitas não negativas são obrigatórias';
  end if;
  if not coalesce(public.user_is_active(), false) then raise exception 'Acesso não autorizado'; end if;

  with base as materialized (
    select p.*, regexp_replace(p.fundo_cnpj, '\D', '', 'g') investidor_cnpj,
      regexp_replace(coalesce(p.cnpjfundo, ''), '\D', '', 'g') investido_cnpj,
      case when trim(p.fundo_isin) ~* '^[A-Z]{2}[A-Z0-9]{9}[0-9]$' then upper(trim(p.fundo_isin)) else '' end investidor_isin,
      case when trim(p.isin) ~* '^[A-Z]{2}[A-Z0-9]{9}[0-9]$' then upper(trim(p.isin)) else '' end investido_isin,
      public.is_gestor_monitorado(p.fundo_cnpjgestor) monitorado
    from public.posicao_carteira p
    where p.fundo_dtposicao = to_char(p_data, 'YYYYMMDD')
  ), cabecalhos as (
    -- O cabeçalho se repete em cada ativo. Remove só repetições exatas do cabeçalho,
    -- preservando preços distintos, arquivos e classes.
    select investidor_cnpj cnpj, investidor_isin isin,
      coalesce(nullif(nome_fundo, ''), investidor_cnpj) nome,
      arquivo_nome arquivo, fundo_nomeadm administrador, fundo_valorcota cota,
      min(id::text) id, max(updated_at) atualizado_em, bool_or(monitorado) monitorado
    from base group by investidor_cnpj, investidor_isin, nome_fundo, arquivo_nome, fundo_nomeadm, fundo_valorcota
  ), posicoes as (
    select b.*, case when length(investido_cnpj) = 14 then investido_cnpj || '|' || investido_isin
      else 'sem-identidade:' || id::text end chave
    from base b where lower(section) = 'cotas' and monitorado
  ), universo as (
    select chave, investido_cnpj cnpj, investido_isin isin from posicoes
    union
    select cnpj || '|' || isin, cnpj, isin from cabecalhos where monitorado and length(cnpj) = 14
  ), identidades as (
    select cnpj, count(distinct isin) filter (where isin <> '') classes
    from (select investido_cnpj cnpj, investido_isin isin from base where lower(section) = 'cotas'
      union select cnpj, isin from cabecalhos) i group by cnpj
  ), grupos as (
    select u.*, coalesce(i.classes, 0) classes,
      exists(select 1 from public.fundos_caracteristicas f
        where (regexp_replace(coalesce(f.cnpj_classe,''), '\D','','g') = u.cnpj
          or (nullif(f.cnpj_classe,'') is null and regexp_replace(coalesce(f.cnpj_fundo,''), '\D','','g') = u.cnpj))
          and upper(coalesce(f.tipo_anbima,'') || ' ' || coalesce(f.categoria_anbima,'')) ~ '\m(FIDC|FII|FIP|FIAGRO)\M') estruturado,
      coalesce((select min(c.nome) from cabecalhos c where c.cnpj = u.cnpj and c.isin = u.isin),
        (select min(coalesce(nullif(a.nome_frontend,''), nullif(a.descricao,''))) from public.ativos a
         where regexp_replace(coalesce(a.cnpj,''), '\D','','g') = u.cnpj
           and (u.isin = '' or upper(trim(a.isin)) = u.isin)), nullif(u.cnpj,''), 'Identificação pendente') nome,
      length(u.cnpj) <> 14 or (u.isin = '' and (coalesce(i.classes, 0) > 0 or
        (select count(distinct c.nome) from cabecalhos c where c.cnpj = u.cnpj and c.isin = '') > 1)) identidade_pendente,
      (select count(distinct c.cota) from cabecalhos c where c.cnpj = u.cnpj and c.isin = u.isin and c.cota > 0) cotas_proprias,
      (select min(c.cota) from cabecalhos c where c.cnpj = u.cnpj and c.isin = u.isin and c.cota > 0) cota_propria,
      m.valor_cota cota_cvm, m.cnpj_origem, m.vinculo_identidade, m.arquivo_origem arquivo_cvm, m.carregado_em cvm_carregado_em,
      coalesce(m.vinculo_identidade = 'direto' and m.cnpj_origem = u.cnpj and coalesce(i.classes,0) <= 1, false) cvm_identificada
    from universo u left join identidades i on i.cnpj = u.cnpj
    left join public.informe_diario_metricas m on m.fundo_cnpj = u.cnpj
      and m.data_competencia = p_data and m.origem = 'informe_diario_fi'
  ), elegiveis as (
    select g.*, (cvm_identificada and not estruturado) cvm_elegivel from grupos g
  ), referencias as (
    select g.*, case when not identidade_pendente and cotas_proprias = 1 then cota_propria
      when not identidade_pendente and cotas_proprias = 0 and cvm_elegivel and cota_cvm > 0 then cota_cvm end referencia,
      case when not identidade_pendente and cotas_proprias = 1 then 'Cota própria (XML)'
      when not identidade_pendente and cotas_proprias = 0 and cvm_elegivel and cota_cvm > 0 then 'Informe Diário CVM' end fonte_referencia
    from elegiveis g
  ), observacoes as (
    select r.chave, c.cota, 'propria' fonte from referencias r join cabecalhos c on c.cnpj = r.cnpj and c.isin = r.isin
    union all select p.chave, p.puposicao, 'posicao:' || p.investidor_cnpj || '|' || p.investidor_isin || '|' || coalesce(p.arquivo_nome,'') from posicoes p
    union all select chave, cota_cvm, 'cvm' from referencias where cvm_elegivel
  ), agregados as (
    select r.*,
      (select count(*) from observacoes o where o.chave = r.chave and (o.cota is null or o.cota <= 0)) invalidos,
      (select count(*) from observacoes o where o.chave = r.chave and o.cota > 0) observacoes_validas,
      (select count(distinct o.fonte) from observacoes o where o.chave = r.chave and o.cota > 0) fontes_distintas,
      (select min(o.cota) from observacoes o where o.chave = r.chave and o.cota > 0) minima,
      (select max(o.cota) from observacoes o where o.chave = r.chave and o.cota > 0) maxima,
      (select count(distinct p.investidor_cnpj || '|' || p.investidor_isin) from posicoes p where p.chave = r.chave) investidores,
      exists(select 1 from observacoes o where o.chave = r.chave and o.cota > 0 and r.referencia > 0
        and abs(o.cota - r.referencia) > greatest(p_tolerancia_abs, abs(r.referencia) * p_tolerancia_pct / 100)) diverge_referencia
    from referencias r
  ), resultados as (
    select a.*, case when identidade_pendente then 'identidade_pendente'
      when cotas_proprias > 1 then 'referencia_conflitante'
      when referencia is null then case when maxima - minima > greatest(p_tolerancia_abs, abs(minima) * p_tolerancia_pct / 100)
        then 'divergente_sem_referencia' else 'sem_referencia' end
      when diverge_referencia then 'divergente'
      when invalidos > 0 then 'dado_invalido'
      when fontes_distintas < 2 then 'fonte_unica' else 'coincidente' end status
    from agregados a
  )
  select jsonb_build_object('data', p_data, 'calculado_em', now(),
    'tolerancia_abs', p_tolerancia_abs::text, 'tolerancia_pct', p_tolerancia_pct::text,
    'grupos', coalesce(jsonb_agg(jsonb_build_object(
      'chave', r.chave, 'cnpj', r.cnpj, 'isin', r.isin, 'nome', r.nome, 'status', r.status,
      'identidade_pendente', r.identidade_pendente, 'invalidos', r.invalidos,
      'referencia', r.referencia::text, 'fonte_referencia', r.fonte_referencia,
      'cota_propria', case when cotas_proprias = 1 then cota_propria::text end,
      'cota_cvm', cota_cvm::text, 'cvm_identificada', cvm_elegivel, 'cvm_nao_aplicavel', estruturado,
      'cnpj_origem_cvm', cnpj_origem, 'vinculo_cvm', vinculo_identidade,
      'arquivo_cvm', arquivo_cvm, 'cvm_carregado_em', cvm_carregado_em,
      'diferenca_cvm_pct', case when cvm_elegivel and referencia > 0 and cota_cvm > 0 then ((cota_cvm / referencia - 1) * 100)::text end,
      'minima', minima::text, 'maxima', maxima::text, 'investidores', investidores,
      'fontes_proprias', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'arquivo', c.arquivo,
        'administrador', c.administrador, 'cota', c.cota::text, 'atualizado_em', c.atualizado_em) order by c.arquivo, c.id), '[]'::jsonb)
        from cabecalhos c where c.cnpj = r.cnpj and c.isin = r.isin),
      'posicoes', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'investidor', coalesce(nullif(p.nome_fundo,''), p.investidor_cnpj),
        'investidor_cnpj', p.investidor_cnpj, 'investidor_isin', p.investidor_isin,
        'administrador', p.fundo_nomeadm, 'arquivo', p.arquivo_nome, 'atualizado_em', p.updated_at,
        'cota', p.puposicao::text, 'quantidade_disponivel', p.qtdisponivel::text, 'quantidade_garantia', p.qtgarantia::text,
        'diferenca', case when r.referencia > 0 and p.puposicao > 0 then (p.puposicao - r.referencia)::text end,
        'diferenca_pct', case when r.referencia > 0 and p.puposicao > 0 then ((p.puposicao / r.referencia - 1) * 100)::text end,
        'divergente', case when r.referencia > 0 and p.puposicao > 0 then abs(p.puposicao - r.referencia) > greatest(p_tolerancia_abs, abs(r.referencia) * p_tolerancia_pct / 100) end,
        -- Estimativa sobre quantidade disponível, sem presumir quantidade bloqueada.
        'ajuste_disponivel', case when r.referencia > 0 and p.puposicao > 0 and p.qtdisponivel >= 0 then (p.qtdisponivel * (r.referencia - p.puposicao))::text end
      ) order by p.investidor_cnpj, p.investidor_isin, p.arquivo_nome, p.id), '[]'::jsonb) from posicoes p where p.chave = r.chave)
    ) order by r.nome, r.chave), '[]'::jsonb)) into resultado from resultados r;
  return resultado;
end $$;
revoke all on function public.get_conciliacao_cotas(date,numeric,numeric) from public, anon;
grant execute on function public.get_conciliacao_cotas(date,numeric,numeric) to authenticated;
notify pgrst, 'reload schema';
