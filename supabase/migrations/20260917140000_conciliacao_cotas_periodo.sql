-- Período de conciliação (até 100 dias). Cada grupo traz a data da posição.
-- get_conciliacao_cotas passa a ser um atalho de um único dia, com a mesma chave.
create or replace function public.get_conciliacao_cotas_periodo(
  p_inicio date, p_fim date, p_tolerancia_abs numeric default 0, p_tolerancia_pct numeric default 0
) returns jsonb language plpgsql stable security invoker set search_path = public
as $$
declare resultado jsonb;
declare dia_unico boolean;
begin
  if p_inicio is null or p_fim is null or p_tolerancia_abs is null or p_tolerancia_pct is null
    or p_tolerancia_abs < 0 or p_tolerancia_pct < 0
    or p_tolerancia_abs::text in ('NaN', 'Infinity') or p_tolerancia_pct::text in ('NaN', 'Infinity') then
    raise exception 'Datas e tolerâncias finitas não negativas são obrigatórias';
  end if;
  if p_inicio > p_fim then raise exception 'Data inicial posterior à final'; end if;
  if (p_fim - p_inicio) > 100 then raise exception 'Período máximo de 100 dias'; end if;
  if not coalesce(public.user_is_active(), false) then raise exception 'Acesso não autorizado'; end if;
  dia_unico := p_inicio = p_fim;

  with raw as materialized (
    select p.id, p.fundo_cnpj, p.fundo_isin, p.cnpjfundo, p.isin,
      coalesce(p.fundo_cnpjgestor,'') gestor, p.section, p.nome_fundo, p.arquivo_nome,
      p.fundo_nomeadm, p.fundo_valorcota, p.puposicao, p.qtdisponivel, p.qtgarantia, p.updated_at,
      to_date(p.fundo_dtposicao, 'YYYYMMDD') dt
    from public.posicao_carteira p
    where p.fundo_dtposicao >= to_char(p_inicio, 'YYYYMMDD')
      and p.fundo_dtposicao <= to_char(p_fim, 'YYYYMMDD')
      and p.section in ('cotas', 'caixa', 'provisao')
  ), gestores as materialized (
    select gestor, public.is_gestor_monitorado(gestor) monitorado
    from (select distinct gestor from raw) g
  ), base as materialized (
    select p.*, regexp_replace(p.fundo_cnpj, '\D', '', 'g') investidor_cnpj,
      regexp_replace(coalesce(p.cnpjfundo, ''), '\D', '', 'g') investido_cnpj,
      case when trim(p.fundo_isin) ~* '^[A-Z]{2}[A-Z0-9]{9}[0-9]$' then upper(trim(p.fundo_isin)) else '' end investidor_isin,
      case when trim(p.isin) ~* '^[A-Z]{2}[A-Z0-9]{9}[0-9]$' then upper(trim(p.isin)) else '' end investido_isin,
      g.monitorado
    from raw p join gestores g using (gestor)
  ), cabecalhos_base as materialized (
    select dt, investidor_cnpj cnpj, investidor_isin isin,
      coalesce(nullif(nome_fundo, ''), investidor_cnpj) nome,
      arquivo_nome arquivo, fundo_nomeadm administrador, fundo_valorcota cota,
      min(id::text) id, max(updated_at) atualizado_em, bool_or(monitorado) monitorado
    from base group by dt, investidor_cnpj, investidor_isin, nome_fundo, arquivo_nome, fundo_nomeadm, fundo_valorcota
  ), posicoes as materialized (
    select b.*, case when length(investido_cnpj) = 14 then
        case when dia_unico then investido_cnpj || '|' || investido_isin
             else to_char(dt, 'YYYY-MM-DD') || '|' || investido_cnpj || '|' || investido_isin end
      else 'sem-identidade:' || case when dia_unico then id::text else to_char(dt, 'YYYY-MM-DD') || '|' || id::text end
      end chave
    from base b where lower(section) = 'cotas' and monitorado
  ), universo as materialized (
    select dt, chave, investido_cnpj cnpj, investido_isin isin from posicoes
    union
    select dt,
      case when dia_unico then cnpj || '|' || isin else to_char(dt, 'YYYY-MM-DD') || '|' || cnpj || '|' || isin end,
      cnpj, isin
    from cabecalhos_base where monitorado and length(cnpj) = 14
  ), extras as materialized (
    select to_date(p.fundo_dtposicao, 'YYYYMMDD') dt,
      regexp_replace(p.fundo_cnpj, '\D', '', 'g') cnpj,
      case when trim(p.fundo_isin) ~* '^[A-Z]{2}[A-Z0-9]{9}[0-9]$' then upper(trim(p.fundo_isin)) else '' end isin,
      coalesce(nullif(p.nome_fundo, ''), regexp_replace(p.fundo_cnpj, '\D', '', 'g')) nome,
      p.arquivo_nome arquivo, p.fundo_nomeadm administrador, p.fundo_valorcota cota,
      min(p.id::text) id, max(p.updated_at) atualizado_em,
      bool_or(public.is_gestor_monitorado(coalesce(p.fundo_cnpjgestor,''))) monitorado
    from public.posicao_carteira p
    join (
      select distinct u.cnpj, u.dt from universo u
      where length(u.cnpj) = 14
        and not exists (select 1 from cabecalhos_base c where c.cnpj = u.cnpj and c.dt = u.dt)
    ) f on p.fundo_cnpj = f.cnpj and to_date(p.fundo_dtposicao, 'YYYYMMDD') = f.dt
    where p.fundo_dtposicao >= to_char(p_inicio, 'YYYYMMDD')
      and p.fundo_dtposicao <= to_char(p_fim, 'YYYYMMDD')
      and p.section not in ('cotas', 'caixa', 'provisao')
    group by 1, 2, 3, 4, 5, 6, 7
  ), cabecalhos as materialized (
    select * from cabecalhos_base
    union all
    select * from extras
  ), cabecalhos_agg as (
    select dt, cnpj, isin, min(nome) nome, count(distinct nome) nomes,
      count(distinct cota) filter (where cota > 0) cotas_proprias,
      min(cota) filter (where cota > 0) cota_propria,
      jsonb_agg(jsonb_build_object('id', id, 'arquivo', arquivo, 'administrador', administrador,
        'cota', cota::text, 'atualizado_em', atualizado_em) order by arquivo, id) fontes_proprias
    from cabecalhos group by dt, cnpj, isin
  ), cnpjs as materialized (
    select distinct cnpj from universo
  ), identidades as (
    select dt, cnpj, count(distinct isin) filter (where isin <> '') classes
    from (select dt, investido_cnpj cnpj, investido_isin isin from base where lower(section) = 'cotas'
      union select dt, cnpj, isin from cabecalhos) i group by dt, cnpj
  ), cadastro as (
    select u.cnpj, bool_or(upper(coalesce(f.tipo_anbima,'') || ' ' || coalesce(f.categoria_anbima,''))
      ~ '\m(FIDC|FII|FIP|FIAGRO)\M') estruturado
    from cnpjs u join public.fundos_caracteristicas f
      on regexp_replace(coalesce(nullif(f.cnpj_classe,''), f.cnpj_fundo, ''), '\D','','g') = u.cnpj
    group by u.cnpj
  ), ativos_relevantes as materialized (
    select u.cnpj, upper(trim(a.isin)) isin,
      coalesce(nullif(a.nome_frontend,''), nullif(a.descricao,'')) nome
    from cnpjs u join public.ativos a
      on regexp_replace(coalesce(a.cnpj,''), '\D','','g') = u.cnpj
  ), nomes_ativos as (
    select cnpj, isin, min(nome) nome from ativos_relevantes where nome is not null group by cnpj, isin
  ), nomes_cnpj as (
    select cnpj, min(nome) nome from ativos_relevantes where nome is not null group by cnpj
  ), grupos as (
    select u.*, coalesce(i.classes, 0) classes, coalesce(f.estruturado,false) estruturado,
      coalesce(c.nome, case when u.isin = '' then nc.nome else na.nome end,
        nullif(u.cnpj,''), 'Identificação pendente') nome,
      length(u.cnpj) <> 14 or (u.isin = '' and (coalesce(i.classes,0) > 0 or coalesce(c.nomes,0) > 1)) identidade_pendente,
      coalesce(c.cotas_proprias,0) cotas_proprias, c.cota_propria,
      coalesce(c.fontes_proprias,'[]'::jsonb) fontes_proprias,
      m.valor_cota cota_cvm, m.cnpj_origem, m.vinculo_identidade, m.arquivo_origem arquivo_cvm, m.carregado_em cvm_carregado_em,
      coalesce(m.vinculo_identidade = 'direto' and m.cnpj_origem = u.cnpj and coalesce(i.classes,0) <= 1, false) cvm_identificada
    from universo u
    left join identidades i on i.cnpj = u.cnpj and i.dt = u.dt
    left join cabecalhos_agg c on c.cnpj = u.cnpj and c.isin = u.isin and c.dt = u.dt
    left join cadastro f on f.cnpj = u.cnpj
    left join nomes_ativos na on na.cnpj = u.cnpj and na.isin = u.isin
    left join nomes_cnpj nc on nc.cnpj = u.cnpj
    left join public.informe_diario_metricas m on m.fundo_cnpj = u.cnpj
      and m.data_competencia = u.dt and m.origem = 'informe_diario_fi'
  ), elegiveis as (
    select g.*, (cvm_identificada and not estruturado) cvm_elegivel from grupos g
  ), referencias as materialized (
    select g.*, case when not identidade_pendente and cotas_proprias = 1 then cota_propria
      when not identidade_pendente and cotas_proprias = 0 and cvm_elegivel and cota_cvm > 0 then cota_cvm end referencia,
      case when not identidade_pendente and cotas_proprias = 1 then 'Cota própria (XML)'
      when not identidade_pendente and cotas_proprias = 0 and cvm_elegivel and cota_cvm > 0 then 'Informe Diário CVM' end fonte_referencia
    from elegiveis g
  ), observacoes as (
    select r.chave, c.cota, 'propria' fonte from referencias r join cabecalhos c on c.cnpj = r.cnpj and c.isin = r.isin and c.dt = r.dt
    union all select p.chave, p.puposicao, 'posicao:' || p.investidor_cnpj || '|' || p.investidor_isin || '|' || coalesce(p.arquivo_nome,'') from posicoes p
    union all select chave, cota_cvm, 'cvm' from referencias where cvm_elegivel
  ), estatisticas as (
    select o.chave,
      count(*) filter (where o.cota is null or o.cota <= 0) invalidos,
      count(distinct o.fonte) filter (where o.cota > 0) fontes_distintas,
      min(o.cota) filter (where o.cota > 0) minima, max(o.cota) filter (where o.cota > 0) maxima,
      coalesce(bool_or(o.cota > 0 and r.referencia > 0 and abs(o.cota - r.referencia) >
        greatest(p_tolerancia_abs, abs(r.referencia) * p_tolerancia_pct / 100)), false) diverge_referencia
    from observacoes o join referencias r on r.chave = o.chave group by o.chave
  ), posicoes_agg as (
    select p.chave, count(distinct p.investidor_cnpj || '|' || p.investidor_isin) investidores,
      jsonb_agg(jsonb_build_object(
        'id', p.id, 'investidor', coalesce(nullif(p.nome_fundo,''), p.investidor_cnpj),
        'investidor_cnpj', p.investidor_cnpj, 'investidor_isin', p.investidor_isin,
        'administrador', p.fundo_nomeadm, 'arquivo', p.arquivo_nome, 'atualizado_em', p.updated_at,
        'cota', p.puposicao::text, 'quantidade_disponivel', p.qtdisponivel::text, 'quantidade_garantia', p.qtgarantia::text,
        'diferenca', case when r.referencia > 0 and p.puposicao > 0 then (p.puposicao - r.referencia)::text end,
        'diferenca_pct', case when r.referencia > 0 and p.puposicao > 0 then ((p.puposicao / r.referencia - 1) * 100)::text end,
        'divergente', case when r.referencia > 0 and p.puposicao > 0 then abs(p.puposicao - r.referencia) > greatest(p_tolerancia_abs, abs(r.referencia) * p_tolerancia_pct / 100) end,
        'ajuste_disponivel', case when r.referencia > 0 and p.puposicao > 0 and p.qtdisponivel >= 0 then (p.qtdisponivel * (r.referencia - p.puposicao))::text end
      ) order by p.investidor_cnpj, p.investidor_isin, p.arquivo_nome, p.id) posicoes
    from posicoes p join referencias r on r.chave = p.chave group by p.chave
  ), agregados as (
    select r.*, coalesce(e.invalidos,0) invalidos, coalesce(e.fontes_distintas,0) fontes_distintas,
      e.minima, e.maxima, coalesce(e.diverge_referencia,false) diverge_referencia,
      coalesce(p.investidores,0) investidores, coalesce(p.posicoes,'[]'::jsonb) posicoes
    from referencias r left join estatisticas e on e.chave = r.chave left join posicoes_agg p on p.chave = r.chave
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
  select jsonb_build_object(
    'data', case when dia_unico then p_inicio::text end,
    'inicio', p_inicio, 'fim', p_fim, 'calculado_em', now(),
    'tolerancia_abs', p_tolerancia_abs::text, 'tolerancia_pct', p_tolerancia_pct::text,
    'grupos', coalesce(jsonb_agg(jsonb_build_object(
      'chave', chave, 'data', dt, 'cnpj', cnpj, 'isin', isin, 'nome', nome, 'status', status,
      'identidade_pendente', identidade_pendente, 'invalidos', invalidos,
      'referencia', referencia::text, 'fonte_referencia', fonte_referencia,
      'cota_propria', case when cotas_proprias = 1 then cota_propria::text end,
      'cota_cvm', cota_cvm::text, 'cvm_identificada', cvm_elegivel, 'cvm_nao_aplicavel', estruturado,
      'cnpj_origem_cvm', cnpj_origem, 'vinculo_cvm', vinculo_identidade,
      'arquivo_cvm', arquivo_cvm, 'cvm_carregado_em', cvm_carregado_em,
      'diferenca_cvm_pct', case when cvm_elegivel and referencia > 0 and cota_cvm > 0 then ((cota_cvm / referencia - 1) * 100)::text end,
      'minima', minima::text, 'maxima', maxima::text, 'investidores', investidores,
      'fontes_proprias', fontes_proprias, 'posicoes', posicoes
    ) order by dt desc, nome, chave), '[]'::jsonb)) into resultado from resultados;
  return resultado;
end $$;

create or replace function public.get_conciliacao_cotas(
  p_data date, p_tolerancia_abs numeric default 0, p_tolerancia_pct numeric default 0
) returns jsonb language plpgsql stable security invoker set search_path = public
as $$
begin
  return public.get_conciliacao_cotas_periodo(p_data, p_data, p_tolerancia_abs, p_tolerancia_pct);
end $$;

revoke all on function public.get_conciliacao_cotas_periodo(date,date,numeric,numeric) from public, anon;
grant execute on function public.get_conciliacao_cotas_periodo(date,date,numeric,numeric) to authenticated;
revoke all on function public.get_conciliacao_cotas(date,numeric,numeric) from public, anon;
grant execute on function public.get_conciliacao_cotas(date,numeric,numeric) to authenticated;
notify pgrst, 'reload schema';
