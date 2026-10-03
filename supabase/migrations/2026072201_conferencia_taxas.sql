-- Migration: Conferência de Taxas — Fase 1 (Apuração Diária)
-- Cria duas views:
--   vw_conferencia_taxas_diaria  — provisão estimada por fundo por dia útil
--   vw_conferencia_taxas_mes     — acumulado mensal por fundo
--
-- Fórmula (igual à planilha):
--   Componente %    = PL_anterior × rate_aa / 252
--   Componente mín  = minimo_mensal / 21
--   Efetivo do dia  = max(%, mín)  — zero se PL_anterior = 0
--
-- Fase 2 (futura): confronto com posicao_carteira.despesas.txadm

-- ── Garante colunas de taxas (migrations anteriores podem não ter sido aplicadas) ──

alter table public.fundos_taxas
  add column if not exists tc_percentual         numeric not null default 0,
  add column if not exists tc_minimo_mensal      numeric,
  add column if not exists ta_percentual         numeric not null default 0,
  add column if not exists ta_minimo_mensal      numeric,
  add column if not exists tcons_percentual      numeric not null default 0,
  add column if not exists tcons_minimo_mensal   numeric;

-- ── View: apuração diária por fundo ──────────────────────────────────────

create or replace view public.vw_conferencia_taxas_diaria as
with pl_diario as (
  -- Uma linha por fundo por data de posição (section = 'caixa')
  -- distinct on garante apenas um registro por fundo+data
  select distinct on (fundo_cnpj, fundo_dtposicao)
    fundo_cnpj,
    to_date(fundo_dtposicao, 'YYYYMMDD') as data_ref,
    fundo_patliq,
    lag(fundo_patliq) over (
      partition by fundo_cnpj
      order by fundo_dtposicao
    )                                 as pl_anterior
  from public.posicao_carteira
  where section = 'caixa'
    and fundo_patliq is not null
    and fundo_patliq > 0
  order by fundo_cnpj, fundo_dtposicao
)
select
  pl.fundo_cnpj,
  pl.data_ref,
  pl.fundo_patliq                                                       as pl_dia,
  -- Usa PL anterior; se não há anterior (primeiro dia), usa o próprio
  coalesce(pl.pl_anterior, pl.fundo_patliq)                             as pl_anterior,

  -- ── TA (Taxa de Administração) ──────────────────────────────────────
  -- Componente percentual
  round(
    coalesce(pl.pl_anterior, pl.fundo_patliq) * ft.ta_percentual / 252,
    2
  )                                                                     as ta_pct_dia,
  -- Componente mínimo diário
  round(coalesce(ft.ta_minimo_mensal, 0) / 21, 2)                      as ta_min_dia,
  -- Efetivo = max(%, mín) | zero se sem PL anterior
  case
    when coalesce(pl.pl_anterior, 0) = 0 then 0
    else round(
      greatest(
        coalesce(pl.pl_anterior, pl.fundo_patliq) * ft.ta_percentual / 252,
        coalesce(ft.ta_minimo_mensal, 0) / 21
      ), 2
    )
  end                                                                   as ta_efetivo_dia,

  -- ── TG (Taxa de Gestão) ──────────────────────────────────────────────
  case
    when coalesce(pl.pl_anterior, 0) = 0 then 0
    else round(
      greatest(
        coalesce(pl.pl_anterior, pl.fundo_patliq) * ft.tg_percentual / 252,
        coalesce(ft.tg_minimo_mensal, 0) / 21
      ), 2
    )
  end                                                                   as tg_efetivo_dia,

  -- ── TC (Taxa de Custódia) ────────────────────────────────────────────
  case
    when coalesce(pl.pl_anterior, 0) = 0 then 0
    else round(
      greatest(
        coalesce(pl.pl_anterior, pl.fundo_patliq) * ft.tc_percentual / 252,
        coalesce(ft.tc_minimo_mensal, 0) / 21
      ), 2
    )
  end                                                                   as tc_efetivo_dia,

  -- ── TCons (Taxa de Consultoria) ──────────────────────────────────────
  case
    when coalesce(pl.pl_anterior, 0) = 0 then 0
    else round(
      greatest(
        coalesce(pl.pl_anterior, pl.fundo_patliq) * ft.tcons_percentual / 252,
        coalesce(ft.tcons_minimo_mensal, 0) / 21
      ), 2
    )
  end                                                                   as tcons_efetivo_dia

from pl_diario pl
join public.fundos_taxas ft on ft.fundo_cnpj = pl.fundo_cnpj
where ft.ativo = true;

grant select on public.vw_conferencia_taxas_diaria to anon, authenticated, service_role;

-- ── View: resumo mensal por fundo ─────────────────────────────────────────

create or replace view public.vw_conferencia_taxas_mes as
select
  d.fundo_cnpj,
  to_char(d.data_ref, 'YYYY-MM')                                        as mes_ref,
  -- Identificação via vw_fundos_com_receita
  coalesce(fc.denominacao_social, d.fundo_cnpj)                         as denominacao_social,
  fc.administrador,
  fc.gestor,
  ft.segmento,
  ft.tipo_fundo,
  -- Taxas configuradas (para exibição no painel de detalhes)
  ft.ta_percentual,   ft.ta_minimo_mensal,
  ft.tg_percentual,   ft.tg_minimo_mensal,
  ft.tc_percentual,   ft.tc_minimo_mensal,
  ft.tcons_percentual, ft.tcons_minimo_mensal,
  -- Flags de taxas ativas (para badges na UI)
  (ft.ta_percentual > 0 or coalesce(ft.ta_minimo_mensal, 0) > 0)        as tem_ta,
  (ft.tg_percentual > 0 or coalesce(ft.tg_minimo_mensal, 0) > 0)        as tem_tg,
  (ft.tc_percentual > 0 or coalesce(ft.tc_minimo_mensal, 0) > 0)        as tem_tc,
  (ft.tcons_percentual > 0 or coalesce(ft.tcons_minimo_mensal, 0) > 0)  as tem_tcons,
  -- Acumulados mensais
  round(sum(d.ta_efetivo_dia), 2)                                       as ta_mensal,
  round(sum(d.tg_efetivo_dia), 2)                                       as tg_mensal,
  round(sum(d.tc_efetivo_dia), 2)                                       as tc_mensal,
  round(sum(d.tcons_efetivo_dia), 2)                                     as tcons_mensal,
  round(sum(d.ta_efetivo_dia + d.tg_efetivo_dia
          + d.tc_efetivo_dia + d.tcons_efetivo_dia), 2)                 as total_mensal,
  -- PL mais recente do mês (último dia útil disponível)
  (array_agg(d.pl_dia order by d.data_ref desc))[1]                     as pl_ultimo,
  count(d.data_ref)                                                     as qtd_dias_uteis
from public.vw_conferencia_taxas_diaria d
join public.fundos_taxas ft on ft.fundo_cnpj = d.fundo_cnpj
left join public.vw_fundos_com_receita fc on fc.fundo_cnpj = d.fundo_cnpj
group by
  d.fundo_cnpj,
  mes_ref,
  fc.denominacao_social,
  fc.administrador,
  fc.gestor,
  ft.segmento,
  ft.tipo_fundo,
  ft.ta_percentual,   ft.ta_minimo_mensal,
  ft.tg_percentual,   ft.tg_minimo_mensal,
  ft.tc_percentual,   ft.tc_minimo_mensal,
  ft.tcons_percentual, ft.tcons_minimo_mensal;

grant select on public.vw_conferencia_taxas_mes to anon, authenticated, service_role;
