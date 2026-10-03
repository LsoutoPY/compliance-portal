-- Métricas públicas da CVM para análise de dependência entre fundos.
-- Uma linha por CNPJ/classe e data de competência; a fonte é preservada
-- para não confundir o Informe Diário de FI com as medidas de estruturados.

create table if not exists public.informe_diario_metricas (
  id uuid primary key default gen_random_uuid(),
  fundo_cnpj text not null,
  data_competencia date not null,
  patrimonio_liquido numeric,
  numero_cotistas integer,
  valor_cota numeric,
  valor_carteira numeric,
  captacao_dia numeric,
  resgate_dia numeric,
  origem text not null check (origem in ('informe_diario_fi', 'medidas_estruturados')),
  arquivo_origem text,
  carregado_em timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fundo_cnpj, data_competencia, origem)
);

comment on table public.informe_diario_metricas is
  'PL, número de cotistas e métricas públicas importadas dos conjuntos Informe Diário FI e Medidas de Fundos Estruturados da CVM.';

create index if not exists idx_informe_diario_metricas_fundo_data
  on public.informe_diario_metricas (fundo_cnpj, data_competencia desc);

create index if not exists idx_informe_diario_metricas_data
  on public.informe_diario_metricas (data_competencia desc);

alter table public.informe_diario_metricas enable row level security;

create policy "Authenticated users can read informe diario metricas"
  on public.informe_diario_metricas for select
  using (auth.role() = 'authenticated');

create or replace function public.set_updated_at_informe_diario_metricas()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists informe_diario_metricas_updated_at on public.informe_diario_metricas;
create trigger informe_diario_metricas_updated_at
  before update on public.informe_diario_metricas
  for each row execute function public.set_updated_at_informe_diario_metricas();
