-- ============================================================
-- Mapa de Fundos — classificação visual por CNPJ gestor/admin
-- (A/B/C/H/R). Subordinação de tranche é sinal de aresta,
-- não coluna desta tabela — ver isTrancheSubordinada no frontend.
-- ============================================================

create table if not exists public.mapa_fundos_grupos (
  id          uuid        primary key default gen_random_uuid(),
  cnpj        text        not null,
  tipo        text        not null check (tipo in ('gestor', 'admin')),
  grupo       text        not null check (grupo in ('A', 'B', 'C', 'H', 'R')),
  ativo       boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (cnpj, tipo)
);

comment on table public.mapa_fundos_grupos is
  'Mapeamento CNPJ → grupo visual no Mapa de Fundos (Quadrante A/B/C = A/B/C, Hieron = H, REAG/Arandu = R). Subordinação de tranches é determinada por regex no nome da posição, não aqui.';

comment on column public.mapa_fundos_grupos.cnpj is
  '14 dígitos sem formatação. Pode ser CNPJ do gestor (fundo_cnpjgestor) ou do administrador (fundo_cnpjadm).';

comment on column public.mapa_fundos_grupos.tipo is
  'gestor: match com fundo_cnpjgestor; admin: match com fundo_cnpjadm.';

comment on column public.mapa_fundos_grupos.grupo is
  'A/B/C: variações Quadrante; H: Hieron; R: REAG/Arandu (só quando CNPJ confirmado).';

create index if not exists idx_mapa_fundos_grupos_cnpj
  on public.mapa_fundos_grupos (cnpj);

create index if not exists idx_mapa_fundos_grupos_ativo
  on public.mapa_fundos_grupos (ativo);

alter table public.mapa_fundos_grupos enable row level security;

create policy "Allow all authenticated mapa_fundos_grupos"
  on public.mapa_fundos_grupos for all using (auth.role() = 'authenticated');

create or replace function public.set_updated_at_mapa_fundos_grupos()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists mapa_fundos_grupos_updated_at on public.mapa_fundos_grupos;
create trigger mapa_fundos_grupos_updated_at
  before update on public.mapa_fundos_grupos
  for each row execute function public.set_updated_at_mapa_fundos_grupos();

-- Seed parcial — completar via UI (GestoresMonitorados) ou migration futura.
-- Exemplo de insert ao receber CNPJs confirmados:
-- insert into public.mapa_fundos_grupos (cnpj, tipo, grupo)
-- values ('00000000000000', 'gestor', 'R')  -- REAG gestor
-- on conflict (cnpj, tipo) do nothing;
