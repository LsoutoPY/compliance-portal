-- L2: histórico de atribuição de metodologias. Nenhum resultado é recalculado.
create table if not exists public.liquidity_methodology_assignments (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funds(id),
  methodology_code text not null,
  methodology_version text not null,
  valid_from date not null,
  valid_to date,
  reason text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (methodology_code, methodology_version)
    references public.liquidity_monthly_methodologies(code, version),
  constraint liquidity_methodology_assignment_dates check (valid_to is null or valid_to >= valid_from),
  unique (fund_id, valid_from)
);

create index if not exists liquidity_methodology_assignments_lookup_idx
  on public.liquidity_methodology_assignments (fund_id, valid_from desc, valid_to);

create or replace function public.check_liquidity_methodology_assignment_overlap()
returns trigger language plpgsql set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.fund_id::text));
  if exists (
    select 1 from public.liquidity_methodology_assignments a
    where a.fund_id = new.fund_id and a.id <> new.id
      and daterange(a.valid_from, coalesce(a.valid_to, 'infinity'::date), '[]')
        && daterange(new.valid_from, coalesce(new.valid_to, 'infinity'::date), '[]')
  ) then
    raise exception 'Vigência de metodologia sobreposta para o fundo %', new.fund_id;
  end if;
  return new;
end;
$$;

drop trigger if exists liquidity_methodology_assignment_no_overlap
  on public.liquidity_methodology_assignments;
create trigger liquidity_methodology_assignment_no_overlap
  before insert or update on public.liquidity_methodology_assignments
  for each row execute function public.check_liquidity_methodology_assignment_overlap();

-- Uma versão publicada é imutável. Mudanças de regra ou parâmetro recebem
-- outra linha (code, version), preservando reemissões de competências antigas.
create or replace function public.reject_liquidity_methodology_change()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'Metodologia versionada é imutável; crie uma nova versão';
end;
$$;

drop trigger if exists liquidity_monthly_methodology_immutable
  on public.liquidity_monthly_methodologies;
create trigger liquidity_monthly_methodology_immutable
  before update or delete on public.liquidity_monthly_methodologies
  for each row execute function public.reject_liquidity_methodology_change();

alter table public.liquidity_methodology_assignments enable row level security;
revoke all on public.liquidity_methodology_assignments from anon, authenticated;
grant select on public.liquidity_methodology_assignments to authenticated;
drop policy if exists liquidity_methodology_assignments_read
  on public.liquidity_methodology_assignments;
create policy liquidity_methodology_assignments_read
  on public.liquidity_methodology_assignments for select to authenticated
  using (public.user_is_active());

-- Atribui apenas os quatro FIDC do cadastro original. Outros fundos aparecem
-- como pendência na visão geral até decisão explícita da metodologia.
insert into public.liquidity_methodology_assignments
  (fund_id, methodology_code, methodology_version, valid_from, reason)
select id, 'cvpar_fidc_mensal', '2026.2', date '2026-01-01',
  'Atribuição inicial L2 dos quatro FIDC do processo mensal congelado'
from public.funds
where cnpj_fundo_master in (
  '51864349000102', '23104485000169', '47425841000104', '58426775000103'
)
on conflict (fund_id, valid_from) do nothing;
