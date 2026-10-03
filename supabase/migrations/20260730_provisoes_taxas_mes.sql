-- Provisões XML (posicao_carteira) como referência de confronto — Fase 1
--
-- Regras de agregação (Fase 0 fechada):
--   1. Snapshot: último fundo_dtposicao do mês (saldo acumulado, NÃO somar dias)
--   2. Ciclo de pagamento: dt = MAX(dt) por (fundo_cnpj, fundo_dtposicao, codprov)
--      — isolamento explícito do ciclo vigente; evita inflar TA+TG quando
--        dois ciclos (ex.: dt=20260707 + dt=20260807) coexistem no fechamento
--   3. cod 15 → TC | cod 34 → TA+TG agregado (split na Fase 2)
--
-- Pendências Fase 2:
--   - Validar slot rank no CARPE DIEM
--   - Fundos com 3+ linhas cod 34 por estrutura (não sobreposição de ciclo)
--   - Atribuição TA/TG com badge de confiança

-- ── Detalhe linha a linha (drill-down no confronto) ───────────────────────

create or replace view public.vw_provisoes_taxas_detalhe as
with ultima_pos AS (
  select
    p.fundo_cnpj,
    to_char(to_date(p.fundo_dtposicao, 'YYYYMMDD'), 'YYYY-MM') as mes_ref,
    max(p.fundo_dtposicao) as fundo_dtposicao
  from public.posicao_carteira p
  where p.section = 'provisao'
    and p.credeb = 'D'
    and p.codprov in ('15', '34')
  group by p.fundo_cnpj, to_char(to_date(p.fundo_dtposicao, 'YYYYMMDD'), 'YYYY-MM')
),
max_dt_por_codprov as (
  select
    p.fundo_cnpj,
    p.fundo_dtposicao,
    p.codprov,
    max(p.dt) as dt_vigente
  from public.posicao_carteira p
  inner join ultima_pos u
    on u.fundo_cnpj = p.fundo_cnpj
   and u.fundo_dtposicao = p.fundo_dtposicao
  where p.section = 'provisao'
    and p.credeb = 'D'
    and p.codprov in ('15', '34')
  group by p.fundo_cnpj, p.fundo_dtposicao, p.codprov
),
linhas_vigentes as (
  select
    p.fundo_cnpj,
    u.mes_ref,
    p.fundo_dtposicao,
    p.codprov,
    p.dt as dt_provisao,
    p.credeb,
    p.valor,
    row_number() over (
      partition by p.fundo_cnpj, p.fundo_dtposicao, p.codprov, p.dt
      order by p.valor asc
    ) as slot
  from public.posicao_carteira p
  inner join ultima_pos u
    on u.fundo_cnpj = p.fundo_cnpj
   and u.fundo_dtposicao = p.fundo_dtposicao
  inner join max_dt_por_codprov m
    on m.fundo_cnpj = p.fundo_cnpj
   and m.fundo_dtposicao = p.fundo_dtposicao
   and m.codprov = p.codprov
   and p.dt = m.dt_vigente
  where p.section = 'provisao'
    and p.credeb = 'D'
    and p.codprov in ('15', '34')
)
select
  fundo_cnpj,
  mes_ref,
  fundo_dtposicao as data_snapshot,
  codprov,
  dt_provisao,
  credeb,
  round(valor, 2) as valor,
  slot
from linhas_vigentes;

comment on view public.vw_provisoes_taxas_detalhe is
  'Linhas de provisão de taxas no último snapshot do mês. dt = MAX(dt) por codprov no snapshot. slot = rank por valor (Fase 2).';

grant select on public.vw_provisoes_taxas_detalhe to anon, authenticated, service_role;

-- ── Agregado mensal por fundo ─────────────────────────────────────────────

create or replace view public.vw_provisoes_taxas_mes as
select
  fundo_cnpj,
  mes_ref,
  data_snapshot,
  max(dt_provisao) filter (where codprov = '34') as dt_provisao_ta_tg,
  max(dt_provisao) filter (where codprov = '15') as dt_provisao_tc,
  round(coalesce(sum(valor) filter (where codprov = '15'), 0), 2) as tc,
  round(coalesce(sum(valor) filter (where codprov = '34'), 0), 2) as ta_tg_agregado,
  round(coalesce(sum(valor), 0), 2) as total_taxas,
  count(*) filter (where codprov = '34')::integer as qtd_linhas_cod34,
  count(*) filter (where codprov = '15')::integer as qtd_linhas_cod15
from public.vw_provisoes_taxas_detalhe
group by fundo_cnpj, mes_ref, data_snapshot;

comment on view public.vw_provisoes_taxas_mes is
  'Referência XML de taxas: saldo provisionado no último dia com posição no mês. TC=cod15, TA+TG=cod34 agregado.';

grant select on public.vw_provisoes_taxas_mes to anon, authenticated, service_role;
