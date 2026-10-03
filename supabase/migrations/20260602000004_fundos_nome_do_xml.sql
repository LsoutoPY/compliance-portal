-- Atualiza vw_fundos_com_receita para usar o nome do fundo diretamente
-- do XML (campo nome_fundo de posicao_carteira) como fonte primária.
-- Prioridade: nome_fundo (XML) > nome_comercial (fundos_caracteristicas) > fundo_cnpj

drop view if exists public.vw_fundos_com_receita;

create or replace view public.vw_fundos_com_receita as
with ultima_pos as (
  select distinct on (fundo_cnpj)
    fundo_cnpj,
    fundo_patliq,
    nome_fundo,
    fundo_nomeadm,
    fundo_cnpjadm,
    fundo_nomegestor,
    fundo_dtposicao
  from public.posicao_carteira
  where section = 'caixa'
    and fundo_patliq is not null
    and fundo_patliq > 0
  order by fundo_cnpj, fundo_dtposicao desc
)
select
  ft.id,
  ft.fundo_cnpj,
  ft.codigo,
  ft.responsabilidade,
  ft.tipo_fundo,
  ft.exercicio_social,
  ft.pl_dez,
  ft.pl_jan,
  ft.qtd_cotistas,
  ft.forma_condominio,
  ft.publico_alvo,
  ft.tg_percentual,
  ft.tg_minimo_mensal,
  ft.tc_percentual,
  ft.tc_minimo_mensal,
  ft.segmento,
  ft.ativo,
  ft.created_at,
  ft.updated_at,
  -- PL efetivo: posicao_carteira > pl_jan manual
  coalesce(up.fundo_patliq, ft.pl_jan)                             as pl_atual,
  up.fundo_dtposicao                                               as data_posicao_atual,
  -- Nome: XML (nome_fundo) > fundos_caracteristicas > CNPJ
  coalesce(up.nome_fundo, fc.nome_comercial, ft.fundo_cnpj)       as denominacao_social,
  -- Administrador: posicao_carteira > fundos_caracteristicas
  coalesce(up.fundo_nomeadm,    fc.administrador)                  as administrador,
  coalesce(up.fundo_cnpjadm,    ''::text)                          as cnpj_administrador,
  -- Gestor: posicao_carteira > fundos_caracteristicas
  coalesce(up.fundo_nomegestor, fc.gestor_principal)               as gestor,
  -- Dados ANBIMA
  fc.codigo_anbima,
  fc.categoria_anbima,
  fc.tipo_anbima                                                   as classificacao_anbima,
  -- TG efetiva
  case
    when ft.tg_minimo_mensal is null or ft.tg_minimo_mensal = 0
      then ft.tg_percentual
    when (ft.tg_percentual * coalesce(up.fundo_patliq, ft.pl_jan) / 12) > ft.tg_minimo_mensal
      then ft.tg_percentual
    else (ft.tg_minimo_mensal * 12 / nullif(coalesce(up.fundo_patliq, ft.pl_jan), 0))
  end as tg_efetiva,
  -- Receita TG mensal
  case
    when ft.segmento = 'prospeccao' then null
    when ft.tg_percentual = 0 and (ft.tg_minimo_mensal is null or ft.tg_minimo_mensal = 0) then null
    when coalesce(up.fundo_patliq, ft.pl_jan) = 0 then null
    else greatest(
      ft.tg_percentual * coalesce(up.fundo_patliq, ft.pl_jan) / 12,
      coalesce(ft.tg_minimo_mensal, 0)
    )
  end as receita_mensal,
  -- Receita TC (custódia) mensal
  case
    when ft.segmento = 'prospeccao' then null
    when (ft.tc_percentual = 0 or ft.tc_percentual is null)
      and (ft.tc_minimo_mensal is null or ft.tc_minimo_mensal = 0) then null
    when coalesce(up.fundo_patliq, ft.pl_jan) = 0 then null
    else greatest(
      coalesce(ft.tc_percentual, 0) * coalesce(up.fundo_patliq, ft.pl_jan) / 12,
      coalesce(ft.tc_minimo_mensal, 0)
    )
  end as tc_receita_mensal,
  -- Flag: cobrando mínimo de TG
  case
    when ft.tg_minimo_mensal is not null
      and ft.tg_minimo_mensal > 0
      and coalesce(up.fundo_patliq, ft.pl_jan) > 0
      and (ft.tg_percentual * coalesce(up.fundo_patliq, ft.pl_jan) / 12) < ft.tg_minimo_mensal
    then true
    else false
  end as no_minimo
from public.fundos_taxas ft
left join public.fundos_caracteristicas fc
       on fc.cnpj_classe = ft.fundo_cnpj
left join ultima_pos up
       on up.fundo_cnpj = ft.fundo_cnpj
where ft.ativo = true;

grant select on public.vw_fundos_com_receita to anon, authenticated, service_role;

-- Atualiza também a vw_pl_por_instituicao para usar nome_fundo do XML
create or replace view public.vw_pl_por_instituicao as
with ultima_pos as (
  select distinct on (fundo_cnpj)
    fundo_cnpj,
    fundo_patliq,
    nome_fundo,
    fundo_nomeadm,
    fundo_cnpjadm,
    fundo_dtposicao
  from public.posicao_carteira
  where section = 'caixa'
    and fundo_patliq is not null
    and fundo_patliq > 0
  order by fundo_cnpj, fundo_dtposicao desc
)
select
  coalesce(up.fundo_nomeadm, fc.administrador, 'Não identificado') as administrador,
  coalesce(up.fundo_cnpjadm, '')                                    as cnpj_administrador,
  max(up.fundo_dtposicao)                                           as data_referencia,
  count(ft.id)::integer                                             as qtd_fundos,
  sum(coalesce(up.fundo_patliq, ft.pl_jan))                        as pl_total,
  sum(
    case
      when ft.segmento in ('prospeccao', 'alocacao') then 0
      when ft.tg_percentual = 0 and (ft.tg_minimo_mensal is null or ft.tg_minimo_mensal = 0) then 0
      when coalesce(up.fundo_patliq, ft.pl_jan) = 0 then 0
      else greatest(
        ft.tg_percentual * coalesce(up.fundo_patliq, ft.pl_jan) / 12,
        coalesce(ft.tg_minimo_mensal, 0)
      )
    end
  ) as receita_tg_total,
  sum(
    case
      when ft.segmento = 'prospeccao' then 0
      when (ft.tc_percentual = 0 or ft.tc_percentual is null)
        and (ft.tc_minimo_mensal is null or ft.tc_minimo_mensal = 0) then 0
      when coalesce(up.fundo_patliq, ft.pl_jan) = 0 then 0
      else greatest(
        coalesce(ft.tc_percentual, 0) * coalesce(up.fundo_patliq, ft.pl_jan) / 12,
        coalesce(ft.tc_minimo_mensal, 0)
      )
    end
  ) as receita_tc_total
from public.fundos_taxas ft
left join public.fundos_caracteristicas fc on fc.cnpj_classe = ft.fundo_cnpj
left join ultima_pos up on up.fundo_cnpj = ft.fundo_cnpj
where ft.ativo = true
group by
  coalesce(up.fundo_nomeadm, fc.administrador, 'Não identificado'),
  coalesce(up.fundo_cnpjadm, '')
order by pl_total desc nulls last;

grant select on public.vw_pl_por_instituicao to anon, authenticated, service_role;
