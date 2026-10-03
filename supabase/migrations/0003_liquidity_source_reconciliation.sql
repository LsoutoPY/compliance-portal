-- =============================================================
-- liquidity_reports passa a admitir mais de uma fonte por
-- (fundo, mês): a planilha manual do compliance E o Informe
-- Mensal da CVM, lado a lado — para permitir reconciliação.
-- =============================================================

do $$ begin
  create type liquidity_report_source as enum ('manual_xlsx', 'cvm_informe_mensal');
exception when duplicate_object then null;
end $$;

alter table liquidity_reports
  add column if not exists source liquidity_report_source not null default 'manual_xlsx';

alter table liquidity_reports drop constraint if exists liquidity_reports_fund_id_reference_month_key;
alter table liquidity_reports drop constraint if exists liquidity_reports_fund_month_source_key;
alter table liquidity_reports
  add constraint liquidity_reports_fund_month_source_key
  unique (fund_id, reference_month, source);

comment on column liquidity_reports.source is
  'De onde este registro veio: preenchimento manual (planilha) ou calculado a partir do Informe Mensal FIDC da CVM. Os dois podem coexistir para o mesmo fundo/mês — ver view liquidity_reconciliation.';

create or replace view liquidity_reconciliation as
select
  m.fund_id,
  f.short_name as fund_short_name,
  m.reference_month,

  m.pl as pl_manual,
  c.pl as pl_cvm,

  m.indice_subordinacao as indice_subordinacao_manual,
  c.indice_subordinacao as indice_subordinacao_cvm,
  abs(coalesce(m.indice_subordinacao,0) - coalesce(c.indice_subordinacao,0)) as indice_subordinacao_diff,

  m.mov_captacoes_liquidas as mov_captacoes_liquidas_manual,
  c.mov_captacoes_liquidas as mov_captacoes_liquidas_cvm,

  m.valor_vencidos_total as valor_vencidos_total_manual,
  c.valor_vencidos_total as valor_vencidos_total_cvm,

  m.baixa_recompra as baixa_recompra_manual,
  c.baixa_recompra as baixa_recompra_cvm,

  m.conc_sacados_top1 as conc_sacados_top1_manual,
  c.conc_sacados_top1 as conc_sacados_top1_cvm

from liquidity_reports m
join liquidity_reports c
  on c.fund_id = m.fund_id
  and c.reference_month = m.reference_month
  and c.source = 'cvm_informe_mensal'
join funds f on f.id = m.fund_id
where m.source = 'manual_xlsx';

comment on view liquidity_reconciliation is
  'Compara lado a lado o que o compliance preencheu manualmente com o que foi calculado a partir do Informe Mensal FIDC da CVM, para o mesmo fundo/mês.';

alter view liquidity_reconciliation set (security_invoker = true);
