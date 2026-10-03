-- Conferência de taxas: usar PL da data de posição (pl_dia), não o dia anterior.
-- Antes: lag(fundo_patliq) deslocava PL e base de cálculo em 1 dia útil.
-- Fórmula diária: PL_dia × rate_aa / 252 (ou fixo_mensal / dias no mês).

create or replace view public.vw_conferencia_taxas_diaria as
with pl_diario as (
  select distinct on (fundo_cnpj, fundo_dtposicao)
    fundo_cnpj,
    to_date(fundo_dtposicao, 'YYYYMMDD') as data_ref,
    fundo_patliq,
    lag(fundo_patliq) over (
      partition by fundo_cnpj
      order by fundo_dtposicao
    ) as pl_anterior_raw
  from public.posicao_carteira
  where section = 'caixa'
    and fundo_patliq is not null
    and fundo_patliq > 0
  order by fundo_cnpj, fundo_dtposicao
),
dias_no_mes as (
  select
    fundo_cnpj,
    date_trunc('month', data_ref)::date as mes_inicio,
    count(*)::numeric as qtd_dias_mes
  from pl_diario
  group by fundo_cnpj, date_trunc('month', data_ref)
)
select
  pl.fundo_cnpj,
  pl.data_ref,
  pl.fundo_patliq as pl_dia,
  -- Mantido para auditoria; cálculo usa pl_dia
  pl.pl_anterior_raw as pl_anterior,

  case
    when coalesce(ft.ta_fixo_mensal, 0) > 0 then 0
    else round(pl.fundo_patliq * ft.ta_percentual / 252, 2)
  end as ta_pct_dia,

  case
    when coalesce(ft.ta_fixo_mensal, 0) > 0 then 0
    else round(coalesce(ft.ta_minimo_mensal, 0) / 21, 2)
  end as ta_min_dia,

  case
    when coalesce(pl.fundo_patliq, 0) = 0 then 0
    when coalesce(ft.ta_fixo_mensal, 0) > 0 then
      round(ft.ta_fixo_mensal / nullif(dm.qtd_dias_mes, 0), 2)
    else round(
      greatest(
        pl.fundo_patliq * ft.ta_percentual / 252,
        coalesce(ft.ta_minimo_mensal, 0) / 21
      ), 2
    )
  end as ta_efetivo_dia,

  case
    when coalesce(pl.fundo_patliq, 0) = 0 then 0
    when coalesce(ft.tg_fixo_mensal, 0) > 0 then
      round(ft.tg_fixo_mensal / nullif(dm.qtd_dias_mes, 0), 2)
    else round(
      greatest(
        pl.fundo_patliq * ft.tg_percentual / 252,
        coalesce(ft.tg_minimo_mensal, 0) / 21
      ), 2
    )
  end as tg_efetivo_dia,

  case
    when coalesce(pl.fundo_patliq, 0) = 0 then 0
    when coalesce(ft.tc_fixo_mensal, 0) > 0 then
      round(ft.tc_fixo_mensal / nullif(dm.qtd_dias_mes, 0), 2)
    else round(
      greatest(
        pl.fundo_patliq * ft.tc_percentual / 252,
        coalesce(ft.tc_minimo_mensal, 0) / 21
      ), 2
    )
  end as tc_efetivo_dia,

  case
    when coalesce(pl.fundo_patliq, 0) = 0 then 0
    when coalesce(ft.tcons_fixo_mensal, 0) > 0 then
      round(ft.tcons_fixo_mensal / nullif(dm.qtd_dias_mes, 0), 2)
    else round(
      greatest(
        pl.fundo_patliq * ft.tcons_percentual / 252,
        coalesce(ft.tcons_minimo_mensal, 0) / 21
      ), 2
    )
  end as tcons_efetivo_dia

from pl_diario pl
join public.fundos_taxas ft on ft.fundo_cnpj = pl.fundo_cnpj
left join dias_no_mes dm
       on dm.fundo_cnpj = pl.fundo_cnpj
      and dm.mes_inicio = date_trunc('month', pl.data_ref)::date
where ft.ativo = true;

comment on view public.vw_conferencia_taxas_diaria is
  'Provisão diária por fundo. Base: PL da data de posição (posicao_carteira section=caixa).';

grant select on public.vw_conferencia_taxas_diaria to anon, authenticated, service_role;
