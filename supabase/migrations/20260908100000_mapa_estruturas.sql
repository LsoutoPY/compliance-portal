-- Consulta por fundo e data, evitando truncar o histórico no limite do PostgREST.
create or replace function public.get_mapa_metricas_cvm(p_cnpjs text[], p_data date)
returns setof public.informe_diario_metricas
language sql stable security invoker set search_path = public
as $$
  select distinct on (m.fundo_cnpj) m.*
  from public.informe_diario_metricas m
  where m.fundo_cnpj = any(p_cnpjs) and m.data_competencia <= p_data
    and m.origem = 'informe_diario_fi' and public.user_is_active()
  order by m.fundo_cnpj, m.data_competencia desc, m.carregado_em desc, m.id;
$$;
revoke all on function public.get_mapa_metricas_cvm(text[], date) from public, anon;
grant execute on function public.get_mapa_metricas_cvm(text[], date) to authenticated;

-- Histórico imutável de decisões e situações documentadas de contraparte.
-- Uma revisão ou baixa cria novo registro; não apaga a evidência anterior.
create table public.mapa_estrutura_registros (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('analise', 'contraparte')),
  entidade_chave text not null check (length(entidade_chave) between 1 and 250),
  data_referencia date not null,
  status text not null,
  nota text not null check (length(trim(nota)) between 5 and 4000),
  fonte text,
  responsavel text,
  proxima_revisao date,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  constraint mapa_registro_status check (
    (tipo = 'analise' and status in ('a_investigar','em_analise','monitorar','concluido')) or
    (tipo = 'contraparte' and status in ('sem_restricao','recuperacao','liquidacao','intervencao'))
  ),
  constraint mapa_contraparte_fonte check (tipo <> 'contraparte' or
    (entidade_chave ~ '^cnpj:[0-9]{14}$' and length(trim(fonte)) > 4 and fonte is not null)),
  constraint mapa_revisao_data check (proxima_revisao is null or proxima_revisao >= data_referencia)
);
create index mapa_registros_entidade_data on public.mapa_estrutura_registros
  (entidade_chave, data_referencia desc, created_at desc);
alter table public.mapa_estrutura_registros enable row level security;
create policy mapa_registros_leitura on public.mapa_estrutura_registros
  for select to authenticated using (public.user_is_active());
create policy mapa_registros_inclusao on public.mapa_estrutura_registros
  for insert to authenticated with check (public.user_can_write() and created_by = auth.uid());
grant select, insert on public.mapa_estrutura_registros to authenticated;
revoke update, delete on public.mapa_estrutura_registros from authenticated, anon;
comment on table public.mapa_estrutura_registros is
  'Trilha de análise do mapa. Situações de contraparte são fatos cadastrados com fonte, não inferidos do nome ou do gestor monitorado.';
