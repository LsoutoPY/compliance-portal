-- ============================================================
-- Módulo: Universo de Monitoramento por Gestor
-- Filtra listas operacionais (Enquadramento, Liquidez, Posição,
-- Rentabilidade, Risco Mercado, Mapa de Ativos) pelos CNPJs de
-- gestores cadastrados, preservando posicao_carteira intacta
-- para look-through de fundos externos importados.
-- ============================================================

-- ── 1. Tabela gestores_monitorados ─────────────────────────
create table if not exists public.gestores_monitorados (
  id          uuid        primary key default gen_random_uuid(),
  cnpj_gestor text        not null unique, -- 14 dígitos sem formatação
  nome        text        not null,
  ativo       boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.gestores_monitorados is
  'CNPJs de gestoras cujos fundos devem aparecer nas listas operacionais de monitoramento (enquadramento, liquidez, rentabilidade etc.). Fundos de outros gestores importados apenas para look-through não são listados.';

comment on column public.gestores_monitorados.cnpj_gestor is
  '14 dígitos sem formatação (ex: 12345678000199). Vem do campo fundo_cnpjgestor do header XML.';

create index if not exists idx_gestores_monitorados_ativo
  on public.gestores_monitorados (ativo);

-- RLS: padrão do projeto (allow all para usuários autenticados)
alter table public.gestores_monitorados enable row level security;

create policy "Allow all authenticated" on public.gestores_monitorados
  for all using (auth.role() = 'authenticated');

-- trigger updated_at
create or replace function public.set_updated_at_gestores_monitorados()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists gestores_monitorados_updated_at on public.gestores_monitorados;
create trigger gestores_monitorados_updated_at
  before update on public.gestores_monitorados
  for each row execute function public.set_updated_at_gestores_monitorados();

-- ── 2. Helpers de normalização de CNPJ ────────────────────
create or replace function public.normalize_cnpj_digits(cnpj text)
returns text language sql immutable parallel safe as $$
  select lpad(regexp_replace(coalesce(cnpj, ''), '\D', '', 'g'), 14, '0')
$$;

comment on function public.normalize_cnpj_digits is
  'Remove não-dígitos e preenche com zeros à esquerda até 14 dígitos.';

-- ── 3. Predicado de gestor monitorado ─────────────────────
create or replace function public.is_gestor_monitorado(cnpj_gestor_raw text)
returns boolean language sql stable parallel safe as $$
  select exists (
    select 1 from public.gestores_monitorados
    where ativo = true
      and cnpj_gestor = public.normalize_cnpj_digits(cnpj_gestor_raw)
  )
$$;

comment on function public.is_gestor_monitorado is
  'Retorna true se o CNPJ (formatado ou não) pertence a uma gestora ativa monitorada.';

-- ── 4. RPC: pares (fundo_cnpj, fundo_isin) monitorados ────
-- Retorna os pares distintos de fundos cujo gestor está na allowlist,
-- enriquecidos com nome, gestor e PL para uso nas listas frontend.
create or replace function public.get_pares_fundo_monitorado(p_dtposicao text)
returns table (
  fundo_cnpj      text,
  fundo_isin      text,
  nome_fundo      text,
  gestor_nome     text,
  cnpj_gestor     text,
  fundo_patliq    numeric
) language sql stable parallel safe as $$
  select
    p.fundo_cnpj,
    coalesce(p.fundo_isin, '')         as fundo_isin,
    max(coalesce(p.nome_fundo, p.fundo_nome, '')) as nome_fundo,
    max(p.fundo_nomegestor)            as gestor_nome,
    max(p.fundo_cnpjgestor)            as cnpj_gestor,
    max(p.fundo_patliq)                as fundo_patliq
  from public.posicao_carteira p
  where p.fundo_dtposicao = p_dtposicao
    and public.is_gestor_monitorado(p.fundo_cnpjgestor)
  group by p.fundo_cnpj, coalesce(p.fundo_isin, '')
  order by max(coalesce(p.nome_fundo, p.fundo_nome, ''))
$$;

comment on function public.get_pares_fundo_monitorado is
  'Retorna pares (fundo_cnpj, fundo_isin) monitorados para uma data, com nome e gestor. Usado pelas listas de enquadramento, liquidez e rentabilidade.';

-- ── 5. View auxiliar: fundos sem gestor monitorado ────────
-- Útil para detectar XMLs importados de gestoras externas
-- ou fundos com fundo_cnpjgestor nulo.
create or replace view public.vw_fundos_sem_gestor_monitorado as
  select distinct
    p.fundo_cnpj,
    coalesce(p.fundo_isin, '')   as fundo_isin,
    max(coalesce(p.nome_fundo, p.fundo_nome, '')) as nome_fundo,
    max(p.fundo_nomegestor)      as gestor_nome,
    max(p.fundo_cnpjgestor)      as cnpj_gestor,
    max(p.fundo_dtposicao)       as ultima_dtposicao
  from public.posicao_carteira p
  where not public.is_gestor_monitorado(p.fundo_cnpjgestor)
  group by p.fundo_cnpj, coalesce(p.fundo_isin, '')
  order by max(p.fundo_dtposicao) desc, max(coalesce(p.nome_fundo, p.fundo_nome, ''));

comment on view public.vw_fundos_sem_gestor_monitorado is
  'Fundos com posição importada cujo gestor não está na allowlist. Inclui fundos de referência/look-through e fundos com fundo_cnpjgestor nulo.';

-- ── 6. Seed inicial ────────────────────────────────────────
-- Cadastre aqui o(s) CNPJ(s) da gestora Quadrante.
-- Para encontrar o valor, consulte:
--   SELECT DISTINCT fundo_cnpjgestor, fundo_nomegestor
--   FROM posicao_carteira
--   WHERE fundo_nomegestor ILIKE '%quadrante%'
--   LIMIT 10;
--
-- Descomente e preencha após confirmar:
-- insert into public.gestores_monitorados (cnpj_gestor, nome)
-- values ('CNPJ_14_DIGITOS_QUADRANTE', 'CVPAR Quadrante Investimentos')
-- on conflict (cnpj_gestor) do nothing;
