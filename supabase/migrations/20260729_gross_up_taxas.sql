-- Gross Up: alíquotas PIS + COFINS + ISS por tipo de taxa (TA/TG/TC/TCons)
-- Valor bruto = valor líquido / (1 - alíquota total)

alter table public.fundos_taxas
  add column if not exists gross_up_ativo boolean not null default false,
  add column if not exists ta_gross_up_pis numeric default 0,
  add column if not exists ta_gross_up_cofins numeric default 0,
  add column if not exists ta_gross_up_iss numeric default 0,
  add column if not exists tg_gross_up_pis numeric default 0,
  add column if not exists tg_gross_up_cofins numeric default 0,
  add column if not exists tg_gross_up_iss numeric default 0,
  add column if not exists tc_gross_up_pis numeric default 0,
  add column if not exists tc_gross_up_cofins numeric default 0,
  add column if not exists tc_gross_up_iss numeric default 0,
  add column if not exists tcons_gross_up_pis numeric default 0,
  add column if not exists tcons_gross_up_cofins numeric default 0,
  add column if not exists tcons_gross_up_iss numeric default 0;

comment on column public.fundos_taxas.gross_up_ativo is
  'Quando true, apuração diária exibe colunas de valor bruto (gross up) ao lado das líquidas.';
comment on column public.fundos_taxas.ta_gross_up_pis is
  'Alíquota PIS para gross up da TA (decimal, ex: 0.0065 = 0,65%).';

-- Recria views dependentes de fundos_taxas
-- Ordem: dependentes do cache (20260817) antes de vw_fundos_com_receita

drop view if exists public.vw_conferencia_taxas_mes;
drop view if exists public.vw_conferencia_taxas_mes_live;
drop view if exists public.vw_fundos_com_receita;

create or replace view public.vw_fundos_com_receita as
with fc_por_cnpj as (
  select distinct on (cnpj_classe)
    cnpj_classe,
    nome_comercial,
    administrador,
    gestor_principal,
    codigo_anbima,
    categoria_anbima,
    tipo_anbima
  from public.fundos_caracteristicas
  where cnpj_classe is not null and cnpj_classe <> ''
  order by
    cnpj_classe,
    case coalesce(estrutura, '')
      when 'Classe' then 1
      when 'Fundo' then 2
      when 'Subclasse' then 3
      else 4
    end,
    codigo_anbima nulls last
),
ultima_pos as (
  select distinct on (fundo_cnpj)
    fundo_cnpj, fundo_patliq, nome_fundo, fundo_nomeadm, fundo_cnpjadm,
    fundo_nomegestor, fundo_cnpjgestor, fundo_dtposicao
  from public.posicao_carteira
  where section = 'caixa' and fundo_patliq is not null and fundo_patliq > 0
  order by fundo_cnpj, fundo_dtposicao desc
),
gestor_atual as (
  select distinct on (fundo_cnpj) fundo_cnpj, fundo_cnpjgestor, fundo_nomegestor
  from public.posicao_carteira
  where fundo_cnpjgestor is not null and fundo_cnpjgestor <> ''
  order by fundo_cnpj, fundo_dtposicao desc
),
passivo_latest as (
  select distinct on (fundo_cnpj) fundo_cnpj, data_posicao
  from public.passivo_fundos
  where fundo_cnpj is not null and fundo_cnpj <> ''
  order by fundo_cnpj, data_posicao desc
),
cotistas_passivo as (
  select p.fundo_cnpj,
         count(distinct p.cotista)::integer as qtd_cotistas_passivo,
         max(p.data_posicao) as data_passivo_atual
  from public.passivo_fundos p
  inner join passivo_latest pl on pl.fundo_cnpj = p.fundo_cnpj and pl.data_posicao = p.data_posicao
  group by p.fundo_cnpj
),
pl_dez_pos as (
  select distinct on (fundo_cnpj) fundo_cnpj, fundo_patliq as pl_dez_posicao, fundo_dtposicao as data_pl_dez
  from public.posicao_carteira
  where section = 'caixa' and fundo_patliq is not null and fundo_patliq > 0
    and substring(fundo_dtposicao, 5, 2) = '12'
  order by fundo_cnpj, fundo_dtposicao desc
)
select
  ft.id, ft.fundo_cnpj, ft.codigo, ft.responsabilidade, ft.tipo_fundo, ft.exercicio_social,
  ft.pl_dez, ft.pl_jan, ft.qtd_cotistas, ft.forma_condominio, ft.publico_alvo,
  ft.tg_percentual, ft.tg_minimo_mensal, ft.tg_fixo_mensal,
  ft.ta_percentual, ft.ta_minimo_mensal, ft.ta_fixo_mensal,
  ft.tc_percentual, ft.tc_minimo_mensal, ft.tc_fixo_mensal,
  ft.tcons_percentual, ft.tcons_minimo_mensal, ft.tcons_fixo_mensal,
  ft.gross_up_ativo,
  ft.ta_gross_up_pis, ft.ta_gross_up_cofins, ft.ta_gross_up_iss,
  ft.tg_gross_up_pis, ft.tg_gross_up_cofins, ft.tg_gross_up_iss,
  ft.tc_gross_up_pis, ft.tc_gross_up_cofins, ft.tc_gross_up_iss,
  ft.tcons_gross_up_pis, ft.tcons_gross_up_cofins, ft.tcons_gross_up_iss,
  ft.segmento, ft.ativo, ft.created_at, ft.updated_at,
  coalesce(up.fundo_patliq, ft.pl_jan) as pl_atual,
  up.fundo_dtposicao as data_posicao_atual,
  pd.pl_dez_posicao, pd.data_pl_dez,
  cp.qtd_cotistas_passivo, cp.data_passivo_atual,
  coalesce(up.nome_fundo, fc.nome_comercial, ft.fundo_cnpj) as denominacao_social,
  coalesce(up.fundo_nomeadm, fc.administrador) as administrador,
  coalesce(up.fundo_cnpjadm, ''::text) as cnpj_administrador,
  coalesce(up.fundo_nomegestor, ga.fundo_nomegestor, fc.gestor_principal) as gestor,
  coalesce(ga.fundo_cnpjgestor, up.fundo_cnpjgestor, ''::text) as cnpj_gestor,
  fc.codigo_anbima, fc.categoria_anbima, fc.tipo_anbima as classificacao_anbima,
  case
    when ft.tg_minimo_mensal is null or ft.tg_minimo_mensal = 0 then ft.tg_percentual
    when (ft.tg_percentual * coalesce(up.fundo_patliq, ft.pl_jan) / 12) > ft.tg_minimo_mensal then ft.tg_percentual
    else (ft.tg_minimo_mensal * 12 / nullif(coalesce(up.fundo_patliq, ft.pl_jan), 0))
  end as tg_efetiva,
  case
    when ft.segmento = 'prospeccao' then null
    when coalesce(ft.tg_fixo_mensal, 0) > 0 then ft.tg_fixo_mensal
    when ft.tg_percentual = 0 and (ft.tg_minimo_mensal is null or ft.tg_minimo_mensal = 0) then null
    when coalesce(up.fundo_patliq, ft.pl_jan) = 0 then null
    else greatest(ft.tg_percentual * coalesce(up.fundo_patliq, ft.pl_jan) / 12, coalesce(ft.tg_minimo_mensal, 0))
  end as receita_mensal,
  case
    when coalesce(ft.ta_fixo_mensal, 0) > 0 then ft.ta_fixo_mensal
    when (ft.ta_percentual = 0 or ft.ta_percentual is null)
      and (ft.ta_minimo_mensal is null or ft.ta_minimo_mensal = 0) then null
    when coalesce(up.fundo_patliq, ft.pl_jan) = 0 then null
    else greatest(coalesce(ft.ta_percentual, 0) * coalesce(up.fundo_patliq, ft.pl_jan) / 12, coalesce(ft.ta_minimo_mensal, 0))
  end as ta_receita_mensal,
  case
    when coalesce(ft.tc_fixo_mensal, 0) > 0 then ft.tc_fixo_mensal
    when (ft.tc_percentual = 0 or ft.tc_percentual is null)
      and (ft.tc_minimo_mensal is null or ft.tc_minimo_mensal = 0) then null
    when coalesce(up.fundo_patliq, ft.pl_jan) = 0 then null
    else greatest(coalesce(ft.tc_percentual, 0) * coalesce(up.fundo_patliq, ft.pl_jan) / 12, coalesce(ft.tc_minimo_mensal, 0))
  end as tc_receita_mensal,
  case
    when coalesce(ft.tcons_fixo_mensal, 0) > 0 then ft.tcons_fixo_mensal
    when (ft.tcons_percentual = 0 or ft.tcons_percentual is null)
      and (ft.tcons_minimo_mensal is null or ft.tcons_minimo_mensal = 0) then null
    when coalesce(up.fundo_patliq, ft.pl_jan) = 0 then null
    else greatest(coalesce(ft.tcons_percentual, 0) * coalesce(up.fundo_patliq, ft.pl_jan) / 12, coalesce(ft.tcons_minimo_mensal, 0))
  end as tcons_receita_mensal,
  case
    when ft.tg_minimo_mensal is not null and ft.tg_minimo_mensal > 0
      and coalesce(up.fundo_patliq, ft.pl_jan) > 0
      and coalesce(ft.tg_fixo_mensal, 0) = 0
      and (ft.tg_percentual * coalesce(up.fundo_patliq, ft.pl_jan) / 12) < ft.tg_minimo_mensal
    then true else false
  end as no_minimo
from public.fundos_taxas ft
left join fc_por_cnpj fc on fc.cnpj_classe = ft.fundo_cnpj
left join ultima_pos up on up.fundo_cnpj = ft.fundo_cnpj
left join gestor_atual ga on ga.fundo_cnpj = ft.fundo_cnpj
left join cotistas_passivo cp on cp.fundo_cnpj = ft.fundo_cnpj
left join pl_dez_pos pd on pd.fundo_cnpj = ft.fundo_cnpj
where ft.ativo = true;

grant select on public.vw_fundos_com_receita to anon, authenticated, service_role;

create or replace view public.vw_conferencia_taxas_mes as
select
  d.fundo_cnpj,
  to_char(d.data_ref, 'YYYY-MM') as mes_ref,
  coalesce(fc.denominacao_social, d.fundo_cnpj) as denominacao_social,
  fc.administrador, fc.gestor, ft.segmento, ft.tipo_fundo,
  ft.ta_percentual, ft.ta_minimo_mensal, ft.ta_fixo_mensal,
  ft.tg_percentual, ft.tg_minimo_mensal, ft.tg_fixo_mensal,
  ft.tc_percentual, ft.tc_minimo_mensal, ft.tc_fixo_mensal,
  ft.tcons_percentual, ft.tcons_minimo_mensal, ft.tcons_fixo_mensal,
  ft.gross_up_ativo,
  ft.ta_gross_up_pis, ft.ta_gross_up_cofins, ft.ta_gross_up_iss,
  ft.tg_gross_up_pis, ft.tg_gross_up_cofins, ft.tg_gross_up_iss,
  ft.tc_gross_up_pis, ft.tc_gross_up_cofins, ft.tc_gross_up_iss,
  ft.tcons_gross_up_pis, ft.tcons_gross_up_cofins, ft.tcons_gross_up_iss,
  (coalesce(ft.ta_fixo_mensal, 0) > 0 or ft.ta_percentual > 0 or coalesce(ft.ta_minimo_mensal, 0) > 0) as tem_ta,
  (coalesce(ft.tg_fixo_mensal, 0) > 0 or ft.tg_percentual > 0 or coalesce(ft.tg_minimo_mensal, 0) > 0) as tem_tg,
  (coalesce(ft.tc_fixo_mensal, 0) > 0 or ft.tc_percentual > 0 or coalesce(ft.tc_minimo_mensal, 0) > 0) as tem_tc,
  (coalesce(ft.tcons_fixo_mensal, 0) > 0 or ft.tcons_percentual > 0 or coalesce(ft.tcons_minimo_mensal, 0) > 0) as tem_tcons,
  round(sum(d.ta_efetivo_dia), 2) as ta_mensal,
  round(sum(d.tg_efetivo_dia), 2) as tg_mensal,
  round(sum(d.tc_efetivo_dia), 2) as tc_mensal,
  round(sum(d.tcons_efetivo_dia), 2) as tcons_mensal,
  round(sum(d.ta_efetivo_dia + d.tg_efetivo_dia + d.tc_efetivo_dia + d.tcons_efetivo_dia), 2) as total_mensal,
  (array_agg(d.pl_dia order by d.data_ref desc))[1] as pl_ultimo,
  count(d.data_ref) as qtd_dias_uteis
from public.vw_conferencia_taxas_diaria d
join public.fundos_taxas ft on ft.fundo_cnpj = d.fundo_cnpj
left join public.vw_fundos_com_receita fc on fc.fundo_cnpj = d.fundo_cnpj
group by
  d.fundo_cnpj, mes_ref, fc.denominacao_social, fc.administrador, fc.gestor,
  ft.segmento, ft.tipo_fundo,
  ft.ta_percentual, ft.ta_minimo_mensal, ft.ta_fixo_mensal,
  ft.tg_percentual, ft.tg_minimo_mensal, ft.tg_fixo_mensal,
  ft.tc_percentual, ft.tc_minimo_mensal, ft.tc_fixo_mensal,
  ft.tcons_percentual, ft.tcons_minimo_mensal, ft.tcons_fixo_mensal,
  ft.gross_up_ativo,
  ft.ta_gross_up_pis, ft.ta_gross_up_cofins, ft.ta_gross_up_iss,
  ft.tg_gross_up_pis, ft.tg_gross_up_cofins, ft.tg_gross_up_iss,
  ft.tc_gross_up_pis, ft.tc_gross_up_cofins, ft.tc_gross_up_iss,
  ft.tcons_gross_up_pis, ft.tcons_gross_up_cofins, ft.tcons_gross_up_iss;

grant select on public.vw_conferencia_taxas_mes to anon, authenticated, service_role;
