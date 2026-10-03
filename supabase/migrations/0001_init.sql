-- =============================================================
-- Portal de Compliance — Módulo de Liquidez
-- Schema inicial (Supabase / Postgres) — idempotente
-- =============================================================

do $$ begin
  create type user_role as enum ('risco', 'compliance');
exception when duplicate_object then null;
end $$;

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role user_role not null default 'compliance',
  created_at timestamptz not null default now()
);

create table if not exists funds (
  id uuid primary key default gen_random_uuid(),
  short_name text not null unique,
  cnpj text,
  administrator text,
  custodian text,
  min_subordination_index numeric,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

do $$ begin
  create type import_source_type as enum ('xlsx', 'pdf', 'xml');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type import_status as enum ('pending', 'parsed', 'error', 'applied');
exception when duplicate_object then null;
end $$;

create table if not exists raw_imports (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid references funds(id),
  source_type import_source_type not null,
  reference_month date,
  file_name text not null,
  storage_path text not null,
  status import_status not null default 'pending',
  parse_error text,
  parsed_payload jsonb,
  uploaded_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists liquidity_reports (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references funds(id),
  reference_month date not null,
  source_import_id uuid references raw_imports(id),

  despesa_taxa_administracao numeric,
  despesa_taxa_custodia numeric,
  despesa_taxa_gestao numeric,
  despesa_selic_anbid_cetip_bovespa_anbima numeric,
  despesa_resgate_amortizacao_iof numeric,
  despesa_outras numeric,

  mov_saidas numeric,
  mov_entradas numeric,
  mov_captacoes_liquidas numeric,

  pl numeric,
  volume_dc_total numeric,
  volume_dc_vencidos numeric,
  volume_dc_a_vencer numeric,
  titulos_publicos_compromissadas numeric,
  despesas_cpr numeric,
  valor_pdd numeric,
  ativos_liquidez_rf_zeragem numeric,
  saldo_tesouraria numeric,
  prazo_medio_dc_dias_uteis numeric,
  prazo_medio_dc_dias_corridos numeric,
  aquisicoes_no_mes numeric,
  taxa_cessao_dc numeric,
  taxa_cessao_du numeric,

  indice_pdd_sobre_dc numeric,
  indice_pdd_sobre_pl numeric,
  valor_vencidos_total numeric,
  vencidos_pct_dc numeric,
  vencidos_pct_pl numeric,
  vencidos_acima_120d numeric,
  faixa_vencidos_ate_5d numeric,
  faixa_vencidos_6_30d numeric,
  faixa_vencidos_31_60d numeric,
  faixa_vencidos_61_90d numeric,
  faixa_vencidos_91_120d numeric,
  faixa_vencidos_acima_120d numeric,

  volume_total_fidcs numeric,
  prev_liq_ate_5d numeric,
  prev_liq_6_30d numeric,
  prev_liq_31_60d numeric,
  prev_liq_61_90d numeric,
  prev_liq_91_120d numeric,
  prev_liq_121_180d numeric,
  prev_liq_181_240d numeric,
  prev_liq_241_300d numeric,
  prev_liq_301_365d numeric,
  prev_liq_acima_365d numeric,

  conc_cedentes_top1 numeric,
  conc_cedentes_top5 numeric,
  conc_cedentes_top10 numeric,
  conc_cedentes_top15 numeric,
  conc_sacados_top1 numeric,
  conc_sacados_top5 numeric,
  conc_sacados_top10 numeric,
  conc_sacados_top15 numeric,

  baixa_deposito_cedente numeric,
  baixa_recompra numeric,
  recompra_parcial_sem_adiantamento numeric,
  outras_liquidacoes numeric,
  indice_recompra_pct_liquidados numeric,
  indice_recompra_pct_pl numeric,

  indice_subordinacao numeric,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (fund_id, reference_month)
);

alter table profiles enable row level security;
alter table funds enable row level security;
alter table raw_imports enable row level security;
alter table liquidity_reports enable row level security;

create or replace function current_role_is(target user_role) returns boolean as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = target
  );
$$ language sql stable security definer;

drop policy if exists "read_funds" on funds;
create policy "read_funds" on funds for select
  using (auth.role() in ('anon', 'authenticated'));
drop policy if exists "read_liquidity_reports" on liquidity_reports;
create policy "read_liquidity_reports" on liquidity_reports for select
  using (auth.role() in ('anon', 'authenticated'));
drop policy if exists "read_raw_imports" on raw_imports;
create policy "read_raw_imports" on raw_imports for select
  using (auth.role() in ('anon', 'authenticated'));

drop policy if exists "write_funds" on funds;
create policy "write_funds" on funds for insert with check (current_role_is('risco'));
drop policy if exists "update_funds" on funds;
create policy "update_funds" on funds for update using (current_role_is('risco'));

drop policy if exists "write_raw_imports" on raw_imports;
create policy "write_raw_imports" on raw_imports for insert with check (current_role_is('risco'));
drop policy if exists "update_raw_imports" on raw_imports;
create policy "update_raw_imports" on raw_imports for update using (current_role_is('risco'));

drop policy if exists "write_liquidity_reports" on liquidity_reports;
create policy "write_liquidity_reports" on liquidity_reports for insert with check (current_role_is('risco'));
drop policy if exists "update_liquidity_reports" on liquidity_reports;
create policy "update_liquidity_reports" on liquidity_reports for update using (current_role_is('risco'));

drop policy if exists "read_profiles" on profiles;
create policy "read_profiles" on profiles for select using (auth.role() = 'authenticated');
drop policy if exists "update_own_profile" on profiles;
create policy "update_own_profile" on profiles for update using (id = auth.uid());
