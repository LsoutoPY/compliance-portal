-- Adiciona colunas de Taxa de Administração (TA) que estavam faltando.
-- A estrutura completa de taxas segue a planilha da CVM:
--   TG  = Taxa de Gestão        (receita Quadrante)
--   TA  = Taxa de Administração (paga ao administrador ex: INTRAG)
--   TC  = Taxa de Custódia      (paga ao custodiante ex: Itaú)
--   TCons = Taxa de Consultoria (raro, geralmente zero)

alter table public.fundos_taxas
  add column if not exists ta_percentual    numeric not null default 0,
  add column if not exists ta_minimo_mensal numeric,
  add column if not exists tcons_percentual    numeric not null default 0,
  add column if not exists tcons_minimo_mensal numeric;

comment on column public.fundos_taxas.ta_percentual     is 'Taxa de Administração % a.a. (paga ao administrador)';
comment on column public.fundos_taxas.ta_minimo_mensal  is 'Taxa de Administração mínimo mensal R$ (paga ao administrador)';
comment on column public.fundos_taxas.tcons_percentual    is 'Taxa de Consultoria % a.a.';
comment on column public.fundos_taxas.tcons_minimo_mensal is 'Taxa de Consultoria mínimo mensal R$';

-- Recria a view incluindo TA e TCons
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
  -- taxas
  ft.tg_percentual,
  ft.tg_minimo_mensal,
  ft.ta_percentual,
  ft.ta_minimo_mensal,
  ft.tc_percentual,
  ft.tc_minimo_mensal,
  ft.tcons_percentual,
  ft.tcons_minimo_mensal,
  ft.segmento,
  ft.ativo,
  ft.created_at,
  ft.updated_at,
  -- PL efetivo
  coalesce(up.fundo_patliq, ft.pl_jan)                              as pl_atual,
  up.fundo_dtposicao                                                as data_posicao_atual,
  -- Nome: XML > fundos_caracteristicas > CNPJ
  coalesce(up.nome_fundo, fc.nome_comercial, ft.fundo_cnpj)        as denominacao_social,
  -- Administrador: posicao_carteira > fundos_caracteristicas
  coalesce(up.fundo_nomeadm,    fc.administrador)                   as administrador,
  coalesce(up.fundo_cnpjadm,    ''::text)                           as cnpj_administrador,
  -- Gestor
  coalesce(up.fundo_nomegestor, fc.gestor_principal)                as gestor,
  -- Dados ANBIMA
  fc.codigo_anbima,
  fc.categoria_anbima,
  fc.tipo_anbima                                                    as classificacao_anbima,
  -- TG efetiva (para exibição de % real cobrado)
  case
    when ft.tg_minimo_mensal is null or ft.tg_minimo_mensal = 0
      then ft.tg_percentual
    when (ft.tg_percentual * coalesce(up.fundo_patliq, ft.pl_jan) / 12) > ft.tg_minimo_mensal
      then ft.tg_percentual
    else (ft.tg_minimo_mensal * 12 / nullif(coalesce(up.fundo_patliq, ft.pl_jan), 0))
  end as tg_efetiva,
  -- Receita TG mensal (receita da Quadrante como gestor)
  case
    when ft.segmento = 'prospeccao' then null
    when ft.tg_percentual = 0 and (ft.tg_minimo_mensal is null or ft.tg_minimo_mensal = 0) then null
    when coalesce(up.fundo_patliq, ft.pl_jan) = 0 then null
    else greatest(
      ft.tg_percentual * coalesce(up.fundo_patliq, ft.pl_jan) / 12,
      coalesce(ft.tg_minimo_mensal, 0)
    )
  end as receita_mensal,
  -- Taxa de Administração mensal (informativo — paga ao administrador)
  case
    when (ft.ta_percentual = 0 or ft.ta_percentual is null)
      and (ft.ta_minimo_mensal is null or ft.ta_minimo_mensal = 0) then null
    when coalesce(up.fundo_patliq, ft.pl_jan) = 0 then null
    else greatest(
      coalesce(ft.ta_percentual, 0) * coalesce(up.fundo_patliq, ft.pl_jan) / 12,
      coalesce(ft.ta_minimo_mensal, 0)
    )
  end as ta_receita_mensal,
  -- Receita TC (custódia) mensal (informativo — paga ao custodiante)
  case
    when (ft.tc_percentual = 0 or ft.tc_percentual is null)
      and (ft.tc_minimo_mensal is null or ft.tc_minimo_mensal = 0) then null
    when coalesce(up.fundo_patliq, ft.pl_jan) = 0 then null
    else greatest(
      coalesce(ft.tc_percentual, 0) * coalesce(up.fundo_patliq, ft.pl_jan) / 12,
      coalesce(ft.tc_minimo_mensal, 0)
    )
  end as tc_receita_mensal,
  -- TCons mensal (informativo)
  case
    when (ft.tcons_percentual = 0 or ft.tcons_percentual is null)
      and (ft.tcons_minimo_mensal is null or ft.tcons_minimo_mensal = 0) then null
    when coalesce(up.fundo_patliq, ft.pl_jan) = 0 then null
    else greatest(
      coalesce(ft.tcons_percentual, 0) * coalesce(up.fundo_patliq, ft.pl_jan) / 12,
      coalesce(ft.tcons_minimo_mensal, 0)
    )
  end as tcons_receita_mensal,
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

-- Recria vw_pl_por_instituicao (sem alteração de lógica, apenas para garantir consistência)
drop view if exists public.vw_pl_por_instituicao;
create or replace view public.vw_pl_por_instituicao as
with ultima_pos as (
  select distinct on (fundo_cnpj)
    fundo_cnpj,
    fundo_patliq,
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
      when (ft.ta_percentual = 0 or ft.ta_percentual is null)
        and (ft.ta_minimo_mensal is null or ft.ta_minimo_mensal = 0) then 0
      when coalesce(up.fundo_patliq, ft.pl_jan) = 0 then 0
      else greatest(
        coalesce(ft.ta_percentual, 0) * coalesce(up.fundo_patliq, ft.pl_jan) / 12,
        coalesce(ft.ta_minimo_mensal, 0)
      )
    end
  ) as receita_ta_total,
  sum(
    case
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
