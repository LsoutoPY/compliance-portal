-- =============================================================
-- 0005_hub_ingest_schema.sql
-- Hub de risco — 3 módulos: Liquidez, Mercado, Enquadramento
-- Tabelas novas: ingest_runs, fund_daily_cvm, fund_holdings,
--                raw_xml_files, compliance_limits, compliance_breaches
--
-- PRÉ-REQUISITO: rodar 0003_liquidity_source_reconciliation.sql
-- antes deste script caso ainda não tenha sido aplicado.
-- =============================================================

-- ── tipos ──────────────────────────────────────────────────────────────────

do $$ begin
  if not exists (select 1 from pg_type where typname = 'ingest_source') then
    create type ingest_source as enum ('cvm', 'xml');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'ingest_status') then
    create type ingest_status as enum ('running', 'ok', 'error');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'holding_source') then
    create type holding_source as enum ('cda', 'xml');
  end if;
end $$;

-- ── ingest_runs — auditoria de jobs de ingestão ────────────────────────────

create table if not exists ingest_runs (
  id              uuid primary key default gen_random_uuid(),
  dataset         text not null,              -- ex: 'cvm_informe_diario', 'xml_posicao'
  competencia     date,                       -- null para jobs ad-hoc
  source          ingest_source not null,
  status          ingest_status not null default 'running',
  rows_seen       integer,
  rows_upserted   integer,
  error_message   text,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz
);

comment on table ingest_runs is
  'Rastreia cada execução de edge function / script de ingestão. Substitui o log solto de registry_sync_log para os novos datasets.';

alter table ingest_runs enable row level security;

drop policy if exists "read_ingest_runs" on ingest_runs;
create policy "read_ingest_runs" on ingest_runs for select
  using (auth.role() in ('anon', 'authenticated'));

-- ── fund_daily_cvm — informe diário (CVM) ─────────────────────────────────

create table if not exists fund_daily_cvm (
  id              uuid primary key default gen_random_uuid(),
  cnpj            text not null,
  data            date not null,
  pl              numeric,
  valor_cota      numeric,
  captacao_dia    numeric,
  resgate_dia     numeric,
  nr_cotistas     integer,
  imported_at     timestamptz not null default now(),
  constraint fund_daily_cvm_cnpj_data_key unique (cnpj, data)
);

comment on table fund_daily_cvm is
  'Informe Diário de Fundos (CVM) — série PL/cota/cotistas por CNPJ e dia. Alimenta o módulo Risco de Mercado.';

create index if not exists fund_daily_cvm_cnpj_data_idx on fund_daily_cvm (cnpj, data);

alter table fund_daily_cvm enable row level security;

drop policy if exists "read_fund_daily_cvm" on fund_daily_cvm;
create policy "read_fund_daily_cvm" on fund_daily_cvm for select
  using (auth.role() in ('anon', 'authenticated'));

-- ── fund_holdings — posição (XML e/ou CDA) ────────────────────────────────

create table if not exists fund_holdings (
  id              uuid primary key default gen_random_uuid(),
  cnpj            text not null,              -- CNPJ do fundo
  data            date not null,
  fonte           holding_source not null,
  isin            text,
  ativo           text,
  emissor         text,
  vencimento      date,
  tipo_ativo      text,
  valor           numeric,                    -- valor financeiro na data
  pu              numeric,                    -- preço unitário
  quantidade      numeric,
  raw_payload     jsonb,
  constraint fund_holdings_cnpj_data_fonte_ativo_key
    unique (cnpj, data, fonte, ativo)
);

comment on table fund_holdings is
  'Posição da carteira do fundo por ativo — alimentada pela CDA (CVM) ou pelo XML da custodiante. Alimenta Mercado (alocação) e Enquadramento (limites por emissor/ativo).';

create index if not exists fund_holdings_cnpj_data_idx on fund_holdings (cnpj, data);

alter table fund_holdings enable row level security;

drop policy if exists "read_fund_holdings" on fund_holdings;
create policy "read_fund_holdings" on fund_holdings for select
  using (auth.role() in ('anon', 'authenticated'));

-- ── raw_xml_files — arquivo original no Storage ───────────────────────────

create table if not exists raw_xml_files (
  id              uuid primary key default gen_random_uuid(),
  fund_id         uuid references funds(id) on delete set null,
  storage_path    text not null,              -- path no Supabase Storage
  data_posicao    date,                       -- data de referência da posição
  payload         jsonb,                      -- árvore parseada (tag → valor)
  uploaded_at     timestamptz not null default now(),
  uploaded_by     uuid references auth.users(id) on delete set null
);

comment on table raw_xml_files is
  'Guarda o metadata e o payload JSON do XML de posição enviado via upload. O arquivo original permanece no Storage. O parser fino preenche fund_holdings.';

alter table raw_xml_files enable row level security;

drop policy if exists "read_raw_xml_files" on raw_xml_files;
create policy "read_raw_xml_files" on raw_xml_files for select
  using (auth.role() in ('anon', 'authenticated'));

-- ── compliance_limits — regras por fundo ─────────────────────────────────

create table if not exists compliance_limits (
  id              uuid primary key default gen_random_uuid(),
  fund_id         uuid not null references funds(id) on delete cascade,
  codigo          text not null,              -- ex: 'subordinacao', 'conc_sacados_top1'
  descricao       text,
  minimo          numeric,                    -- null = sem mínimo
  maximo          numeric,                    -- null = sem máximo
  unidade         text not null default 'pct', -- 'pct' | 'brl'
  ativo           boolean not null default true,
  created_at      timestamptz not null default now(),
  constraint compliance_limits_fund_codigo_key unique (fund_id, codigo)
);

comment on table compliance_limits is
  'Limites regulamentares e operacionais por fundo. Alimenta calculate-enquadramento.';

alter table compliance_limits enable row level security;

drop policy if exists "read_compliance_limits" on compliance_limits;
create policy "read_compliance_limits" on compliance_limits for select
  using (auth.role() in ('anon', 'authenticated'));

-- ── compliance_breaches — resultado do cálculo de enquadramento ───────────

create table if not exists compliance_breaches (
  id              uuid primary key default gen_random_uuid(),
  fund_id         uuid not null references funds(id) on delete cascade,
  reference_month date not null,
  limit_id        uuid references compliance_limits(id) on delete set null,
  codigo          text not null,
  valor_realizado numeric,
  valor_minimo    numeric,
  valor_maximo    numeric,
  status          text not null check (status in ('ok', 'alerta', 'desenquadrado')),
  calculated_at   timestamptz not null default now(),
  constraint compliance_breaches_fund_month_codigo_key
    unique (fund_id, reference_month, codigo)
);

comment on table compliance_breaches is
  'Resultado da verificação de enquadramento: limite vs realizado vs status. Calculado pela edge function calculate-enquadramento.';

alter table compliance_breaches enable row level security;

drop policy if exists "read_compliance_breaches" on compliance_breaches;
create policy "read_compliance_breaches" on compliance_breaches for select
  using (auth.role() in ('anon', 'authenticated'));

-- ── seed inicial de limites ────────────────────────────────────────────────
-- Usa short_name para mapear — requer que 0004_seed_cvpar_funds.sql
-- já tenha sido aplicado e que os fundos estejam em funds.
--
-- Ajuste minimo/maximo conforme regulamento de cada fundo.

insert into compliance_limits (fund_id, codigo, descricao, minimo, maximo, unidade)
select
  f.id,
  l.codigo,
  l.descricao,
  -- subordinacao usa o mínimo do próprio fundo; resto usa valor fixo da lista
  case when l.codigo = 'subordinacao' then f.min_subordination_index else l.minimo end,
  l.maximo,
  l.unidade
from funds f
cross join (values
  ('subordinacao',        'Índice de Subordinação',               null::numeric, null::numeric, 'pct'),
  ('conc_sacados_top1',   'Concentração de Sacados – Top 1',      null,          0.25,          'pct'),
  ('conc_sacados_top5',   'Concentração de Sacados – Top 5',      null,          0.50,          'pct'),
  ('conc_cedentes_top1',  'Concentração de Cedentes – Top 1',     null,          0.25,          'pct'),
  ('conc_cedentes_top5',  'Concentração de Cedentes – Top 5',     null,          0.50,          'pct'),
  ('caixa_minimo',        'Caixa / Tesouraria (% PL)',             0.01,          null,          'pct')
) as l(codigo, descricao, minimo, maximo, unidade)
on conflict (fund_id, codigo) do nothing;

-- ── comentário final ──────────────────────────────────────────────────────
comment on schema public is
  'Hub de Risco CVPAR — Liquidez | Mercado | Enquadramento. Ingestão centralizada por edge functions. Leitura via RLS (anon + authenticated). Escrita: service_role / sb_secret_.';
