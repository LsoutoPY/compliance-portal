-- Eventos imutáveis de revisão associados à execução exata (inclui versão e hash).
-- Nenhum papel do portal recebe INSERT direto; a autorização de decisão será
-- definida no endpoint de aprovação após confirmação do fluxo de Risco/Compliance.
create table if not exists public.liquidity_monthly_review_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.liquidity_monthly_runs(id),
  decision text not null check (decision in ('submitted', 'approved', 'returned')),
  note text not null,
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists liquidity_monthly_review_events_lookup_idx
  on public.liquidity_monthly_review_events (run_id, created_at desc, id desc);

create or replace function public.reject_liquidity_monthly_review_event_change()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'Evento de revisão é imutável; registre uma nova decisão';
end;
$$;

drop trigger if exists liquidity_monthly_review_event_immutable
  on public.liquidity_monthly_review_events;
create trigger liquidity_monthly_review_event_immutable
  before update or delete on public.liquidity_monthly_review_events
  for each row execute function public.reject_liquidity_monthly_review_event_change();

alter table public.liquidity_monthly_review_events enable row level security;
revoke all on public.liquidity_monthly_review_events from anon, authenticated;
grant select on public.liquidity_monthly_review_events to authenticated;
drop policy if exists liquidity_monthly_review_events_read
  on public.liquidity_monthly_review_events;
create policy liquidity_monthly_review_events_read
  on public.liquidity_monthly_review_events for select to authenticated
  using (public.user_is_active());
