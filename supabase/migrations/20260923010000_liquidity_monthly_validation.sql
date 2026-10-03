-- Fechamento experimental por fonte e versão. A planilha de Compliance não alimenta estas tabelas.
alter type ingest_source add value if not exists 'csv';

create table if not exists liquidity_monthly_methodologies (
  code text not null,
  version text not null,
  label text not null,
  configuration jsonb not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (code, version)
);

insert into liquidity_monthly_methodologies (code, version, label, configuration)
values (
  'cvpar_fidc_mensal', '2026.1', 'CVPAR FIDC mensal — validação 2026',
  '{"creditExtraFields":["TAB_I2H_VL_COTA_FIDC","TAB_I2C6_VL_OUTRO"],"grossUpPdd":true,"includeMezzanineInSubordination":true}'::jsonb
)
on conflict (code, version) do nothing;

create table if not exists liquidity_position_snapshots (
  id uuid primary key default gen_random_uuid(),
  cnpj text not null check (cnpj ~ '^[0-9]{14}$'),
  reference_date date not null,
  file_name text not null,
  file_sha256 text not null,
  storage_path text not null,
  summary jsonb not null,
  imported_by uuid references auth.users(id),
  imported_at timestamptz not null default now(),
  unique (cnpj, reference_date, file_sha256)
);
create index if not exists liquidity_position_snapshots_lookup_idx
  on liquidity_position_snapshots (cnpj, reference_date, imported_at desc);

insert into storage.buckets (id, name, public)
values ('liquidity-position-source', 'liquidity-position-source', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('cvm-fidc-monthly-source', 'cvm-fidc-monthly-source', false)
on conflict (id) do nothing;

drop policy if exists liquidity_position_source_read on storage.objects;
create policy liquidity_position_source_read on storage.objects
  for select to authenticated
  using (bucket_id = 'liquidity-position-source' and public.user_is_active());

drop policy if exists cvm_fidc_monthly_source_read on storage.objects;
create policy cvm_fidc_monthly_source_read on storage.objects
  for select to authenticated
  using (bucket_id = 'cvm-fidc-monthly-source' and public.user_is_active());

create table if not exists liquidity_monthly_runs (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid references funds(id),
  cnpj text not null check (cnpj ~ '^[0-9]{14}$'),
  reference_month date not null,
  methodology_code text not null,
  methodology_version text not null,
  input_sha256 text not null,
  source_manifest jsonb not null,
  result jsonb not null,
  calculated_by uuid references auth.users(id),
  calculated_at timestamptz not null default now(),
  foreign key (methodology_code, methodology_version)
    references liquidity_monthly_methodologies (code, version),
  unique (cnpj, reference_month, methodology_code, methodology_version, input_sha256)
);
create index if not exists liquidity_monthly_runs_lookup_idx
  on liquidity_monthly_runs (cnpj, reference_month, calculated_at desc);

alter table liquidity_monthly_methodologies enable row level security;
alter table liquidity_position_snapshots enable row level security;
alter table liquidity_monthly_runs enable row level security;

-- 20260917180000 concede DML por padrão a tabelas futuras; o portal só consulta estas.
revoke all on liquidity_monthly_methodologies, liquidity_position_snapshots, liquidity_monthly_runs from anon, authenticated;
grant select on liquidity_monthly_methodologies, liquidity_position_snapshots, liquidity_monthly_runs to authenticated;

drop policy if exists liquidity_monthly_methodologies_read on liquidity_monthly_methodologies;
create policy liquidity_monthly_methodologies_read on liquidity_monthly_methodologies
  for select to authenticated using (public.user_is_active());
drop policy if exists liquidity_position_snapshots_read on liquidity_position_snapshots;
create policy liquidity_position_snapshots_read on liquidity_position_snapshots
  for select to authenticated using (public.user_is_active());
drop policy if exists liquidity_monthly_runs_read on liquidity_monthly_runs;
create policy liquidity_monthly_runs_read on liquidity_monthly_runs
  for select to authenticated using (public.user_is_active());

comment on table liquidity_monthly_runs is
  'Cálculo experimental com fontes identificadas. Um novo hash cria nova versão, sem alterar execução anterior.';

-- A promoção de todas as tabelas de uma competência ocorre numa transação.
alter table fund_monthly_cvm_filing
  add column if not exists registry_sync_log_id uuid references registry_sync_log(id),
  add column if not exists source_sha256 text,
  add column if not exists source_storage_path text,
  add column if not exists source_origin text;

-- O informe é entrada de cálculo: a política antiga de acesso aberto permitiria
-- adulterar o fato pelo cliente e produzir um resultado aparentemente CVM.
drop policy if exists portal_open_all on fund_monthly_cvm_filing;
drop policy if exists read_fund_monthly_cvm_filing on fund_monthly_cvm_filing;
drop policy if exists write_fund_monthly_cvm_filing on fund_monthly_cvm_filing;
drop policy if exists update_fund_monthly_cvm_filing on fund_monthly_cvm_filing;
revoke all on fund_monthly_cvm_filing from anon, authenticated;
grant select on fund_monthly_cvm_filing to authenticated;
drop policy if exists liquidity_cvm_filing_read on fund_monthly_cvm_filing;
create policy liquidity_cvm_filing_read on fund_monthly_cvm_filing
  for select to authenticated using (public.user_is_active());

drop function if exists public.upsert_cvm_monthly_filing(jsonb);
create or replace function public.upsert_cvm_monthly_filing(
  p_rows jsonb, p_competencia date, p_cnpjs text[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  if jsonb_typeof(p_rows) <> 'array' or coalesce(array_length(p_cnpjs, 1), 0) = 0 then
    raise exception 'p_rows deve ser um array JSON e p_cnpjs não pode estar vazio';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_rows) as r(cnpj text, competencia date)
    where r.competencia <> p_competencia or not (r.cnpj = any(p_cnpjs))
  ) then
    raise exception 'Linhas fora da competência ou dos fundos monitorados';
  end if;
  perform pg_advisory_xact_lock(hashtext('cvm_monthly:' || p_competencia::text));
  delete from public.fund_monthly_cvm_filing
  where competencia = p_competencia and cnpj = any(p_cnpjs);
  insert into public.fund_monthly_cvm_filing
    (cnpj, competencia, tabela, payload, imported_at, registry_sync_log_id,
     source_sha256, source_storage_path, source_origin)
  select r.cnpj, r.competencia, r.tabela, r.payload, r.imported_at, r.registry_sync_log_id,
         r.source_sha256, r.source_storage_path, r.source_origin
  from jsonb_to_recordset(p_rows) as r(
    cnpj text,
    competencia date,
    tabela text,
    payload jsonb,
    imported_at timestamptz,
    registry_sync_log_id uuid,
    source_sha256 text,
    source_storage_path text,
    source_origin text
  );
  get diagnostics affected = row_count;
  return affected;
end;
$$;
revoke all on function public.upsert_cvm_monthly_filing(jsonb, date, text[]) from public, anon, authenticated;
grant execute on function public.upsert_cvm_monthly_filing(jsonb, date, text[]) to service_role;
