-- PL mensal por fundo a partir de posicao_carteira (section caixa).
-- Usado em Controle de Taxas → Histórico de PL.

create or replace view public.vw_pl_historico_mensal as
with caixa as (
  select
    p.fundo_cnpj,
    p.fundo_dtposicao,
    p.fundo_patliq,
    to_char(to_date(p.fundo_dtposicao, 'YYYYMMDD'), 'YYYY-MM-01') as mes_ref
  from public.posicao_carteira p
  where p.section = 'caixa'
    and p.fundo_cnpj is not null
    and p.fundo_cnpj <> ''
    and p.fundo_patliq is not null
    and p.fundo_patliq > 0
),
ranked as (
  select
    c.fundo_cnpj,
    c.mes_ref,
    c.fundo_patliq as pl_valor,
    c.fundo_dtposicao as data_referencia,
    row_number() over (
      partition by c.fundo_cnpj, c.mes_ref
      order by c.fundo_dtposicao desc
    ) as rn
  from caixa c
)
select
  r.fundo_cnpj,
  r.mes_ref,
  r.pl_valor,
  r.data_referencia
from ranked r
inner join public.fundos_taxas ft
        on ft.fundo_cnpj = r.fundo_cnpj
       and ft.ativo = true
where r.rn = 1;

comment on view public.vw_pl_historico_mensal is
  'Último PL do mês por fundo (posicao_carteira section=caixa). Base do gráfico Histórico de PL.';

grant select on public.vw_pl_historico_mensal to anon, authenticated, service_role;
