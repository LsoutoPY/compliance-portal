-- Migration: Módulo Controle de Taxas
-- Cria tabelas fundos_taxas e fundos_pl_historico,
-- view vw_fundos_com_receita (JOIN com fundos_caracteristicas),
-- RLS (allow all, padrão do projeto) e função de sincronização.

create extension if not exists "uuid-ossp";

-- ── Tabela principal de taxas ──────────────────────────────────────────────
-- Dados cadastrais (nome, administrador, gestor) vêm de fundos_caracteristicas via JOIN.
-- Aqui ficam apenas os campos de negócio exclusivos do controle de taxas.
create table if not exists public.fundos_taxas (
  id                  uuid primary key default gen_random_uuid(),
  fundo_cnpj          text not null unique,
  codigo              text,
  responsabilidade    text,
  tipo_fundo          text not null check (tipo_fundo in ('FI','FIDC','FIP','FII')),
  exercicio_social    integer,
  pl_dez              numeric,
  pl_jan              numeric not null default 0,
  qtd_cotistas        integer,
  forma_condominio    text check (forma_condominio in ('Aberto','Fechado')),
  publico_alvo        text,
  tg_percentual       numeric not null default 0,
  tg_minimo_mensal    numeric,
  segmento            text not null check (segmento in ('exclusivo_familiar','alocacao','asset','prospeccao')),
  ativo               boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ── Histórico de PL mensal ─────────────────────────────────────────────────
-- Um registro por fundo por mês. mes_ref sempre o primeiro dia do mês.
create table if not exists public.fundos_pl_historico (
  id         uuid primary key default gen_random_uuid(),
  fundo_cnpj text not null references public.fundos_taxas(fundo_cnpj) on delete cascade,
  mes_ref    date not null,
  pl_valor   numeric not null,
  created_at timestamptz not null default now(),
  unique(fundo_cnpj, mes_ref)
);

-- ── View com colunas calculadas ────────────────────────────────────────────
-- NUNCA persistir tg_efetiva, receita_mensal ou no_minimo — sempre calculados aqui.
create or replace view public.vw_fundos_com_receita as
select
  ft.id,
  ft.fundo_cnpj,
  ft.codigo,
  ft.responsabilidade,
  ft.tipo_fundo,
  ft.exercicio_social,
  ft.pl_dez,
  ft.pl_jan,
  ft.qtd_cotistas,
  ft.forma_condominio,
  ft.publico_alvo,
  ft.tg_percentual,
  ft.tg_minimo_mensal,
  ft.segmento,
  ft.ativo,
  ft.created_at,
  ft.updated_at,
  -- Dados cadastrais do JOIN com fundos_caracteristicas
  coalesce(fc.nome_comercial, ft.fundo_cnpj) as denominacao_social,
  fc.administrador,
  fc.gestor_principal                          as gestor,
  fc.codigo_anbima,
  fc.categoria_anbima,
  fc.tipo_anbima                               as classificacao_anbima,
  -- TG efetiva (% anual equivalente ao que de fato é cobrado)
  case
    when ft.tg_minimo_mensal is null or ft.tg_minimo_mensal = 0
      then ft.tg_percentual
    when (ft.tg_percentual * ft.pl_jan / 12) > ft.tg_minimo_mensal
      then ft.tg_percentual
    else (ft.tg_minimo_mensal * 12 / nullif(ft.pl_jan, 0))
  end as tg_efetiva,
  -- Receita mensal estimada
  case
    when ft.segmento = 'prospeccao' then null
    when ft.tg_percentual = 0 and (ft.tg_minimo_mensal is null or ft.tg_minimo_mensal = 0) then null
    when ft.pl_jan = 0 then null
    else greatest(
      ft.tg_percentual * ft.pl_jan / 12,
      coalesce(ft.tg_minimo_mensal, 0)
    )
  end as receita_mensal,
  -- Flag: cobrando mínimo contratado em vez do percentual
  case
    when ft.tg_minimo_mensal is not null
      and ft.tg_minimo_mensal > 0
      and ft.pl_jan > 0
      and (ft.tg_percentual * ft.pl_jan / 12) < ft.tg_minimo_mensal
    then true
    else false
  end as no_minimo
from public.fundos_taxas ft
left join public.fundos_caracteristicas fc
       on fc.cnpj_classe = ft.fundo_cnpj
where ft.ativo = true;

grant select on public.vw_fundos_com_receita to anon, authenticated, service_role;

-- ── RLS (padrão "Allow all" do projeto) ───────────────────────────────────
alter table public.fundos_taxas enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'fundos_taxas' and policyname = 'Allow all operations on fundos_taxas'
  ) then
    execute 'create policy "Allow all operations on fundos_taxas" on public.fundos_taxas for all using (true) with check (true)';
  end if;
end $$;

alter table public.fundos_pl_historico enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'fundos_pl_historico' and policyname = 'Allow all operations on fundos_pl_historico'
  ) then
    execute 'create policy "Allow all operations on fundos_pl_historico" on public.fundos_pl_historico for all using (true) with check (true)';
  end if;
end $$;

-- ── Trigger updated_at ─────────────────────────────────────────────────────
-- Reutiliza set_updated_at() já criada em migrations anteriores, se existir.
create or replace function public.set_updated_at_fundos_taxas()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists fundos_taxas_updated_at on public.fundos_taxas;
create trigger fundos_taxas_updated_at
  before update on public.fundos_taxas
  for each row execute function public.set_updated_at_fundos_taxas();

-- ── Função de sincronização com posicao_carteira ───────────────────────────
-- Insere fundos novos encontrados em posicao_carteira que ainda não estão
-- em fundos_taxas, com tipo inferido de fundos_caracteristicas e segmento
-- padrão 'prospeccao' (para revisão manual).
create or replace function public.sync_fundos_from_posicao()
returns integer language plpgsql as $$
declare
  inserted integer := 0;
begin
  with novos as (
    select distinct
      p.fundo_cnpj,
      case
        when fc.nivel1_categoria = 'FIDC' then 'FIDC'
        when fc.nivel1_categoria = 'FIP'  then 'FIP'
        when fc.nivel1_categoria = 'FII'  then 'FII'
        else 'FI'
      end as tipo_fundo,
      'prospeccao'::text as segmento
    from public.posicao_carteira p
    left join public.fundos_caracteristicas fc
           on fc.cnpj_classe = p.fundo_cnpj
    where p.fundo_cnpj is not null
      and p.fundo_cnpj <> ''
      and p.fundo_cnpj not in (select fundo_cnpj from public.fundos_taxas)
  )
  insert into public.fundos_taxas (fundo_cnpj, tipo_fundo, segmento)
  select fundo_cnpj, tipo_fundo, segmento from novos
  on conflict (fundo_cnpj) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;
