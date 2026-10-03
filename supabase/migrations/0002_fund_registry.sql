-- =============================================================
-- Portal de Compliance — Cadastro Mestre de Fundos
-- Camada compartilhada por todos os módulos (liquidez, crédito,
-- enquadramento...). Resolve CNPJ → nome e dados cadastrais.
-- =============================================================

do $$ begin
  create type registro_tipo as enum ('fundo', 'classe', 'subclasse');
exception when duplicate_object then null;
end $$;
do $$ begin
  create type registro_fonte as enum ('cvm_registro_classe', 'cvm_cad_fi', 'manual');
exception when duplicate_object then null;
end $$;
do $$ begin
  create type isin_fonte as enum ('anbima_data', 'b3', 'manual');
exception when duplicate_object then null;
end $$;

-- ---------- Cadastro mestre (um registro por fundo/classe/subclasse) ----------
-- Chave: (fonte, tipo_registro, id_cvm). CNPJ da subclasse pode ser nulo
-- (a CVM não publica CNPJ próprio de subclasse — só o da classe-mãe).
create table if not exists fund_master (
  id uuid primary key default gen_random_uuid(),

  id_cvm text not null,               -- ID_Registro_Fundo / ID_Registro_Classe / ID_Subclasse
  cnpj text,                          -- só dígitos (14). nulo em subclasse
  cnpj_fundo_pai text,                -- CNPJ do fundo quando a linha é classe/subclasse
  tipo_registro registro_tipo not null default 'fundo',

  denominacao_social text,
  nome_comercial text,
  tipo_fundo text,                    -- FIDC / FIM / FII / FIP / Tipo_Classe
  classe_anbima text,

  situacao text,
  data_registro date,
  data_inicio_atividade date,
  data_cancelamento date,

  administrador_cnpj text,
  administrador_nome text,
  gestor_cnpj text,
  gestor_nome text,
  custodiante_nome text,
  auditor_nome text,

  publico_alvo text,
  condominio text,                    -- aberto / fechado

  patrimonio_liquido numeric,
  data_patrimonio_liquido date,

  fonte registro_fonte not null,
  raw_payload jsonb,                  -- linha bruta do CSV da CVM — nunca perde campo
  last_synced_at timestamptz not null default now(),

  unique (fonte, tipo_registro, id_cvm)
);
create index if not exists fund_master_cnpj_idx on fund_master (cnpj);
create index if not exists fund_master_cnpj_fundo_pai_idx on fund_master (cnpj_fundo_pai);
create index if not exists fund_master_denominacao_idx on fund_master (denominacao_social);

-- ---------- Mapeamento ISIN → cadastro (fonte ainda em aberto: B3/ANBIMA) ----------
create table if not exists fund_isin_map (
  isin text primary key,
  cnpj text not null,
  tipo_cota text,                     -- sênior / subordinada / única / mezanino
  fonte isin_fonte not null,
  raw_payload jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists fund_isin_map_cnpj_idx on fund_isin_map (cnpj);

-- ---------- Informe Mensal FIDC da CVM (staging) ----------
-- Uma linha por (cnpj, competência, tabela). `payload` é um ARRAY jsonb
-- com todas as linhas daquela tabela para aquele CNPJ/mês — tab_VIII
-- (sacados) e tab_X_2 (séries) têm N linhas, não uma.
create table if not exists fund_monthly_cvm_filing (
  id uuid primary key default gen_random_uuid(),
  cnpj text not null,                 -- só dígitos
  competencia date not null,
  tabela text not null,               -- 'tab_I', 'tab_VIII', 'tab_X_2', ...
  payload jsonb not null,             -- jsonb array de objetos (linhas do CSV)
  imported_at timestamptz not null default now(),
  unique (cnpj, competencia, tabela)
);
create index if not exists fund_monthly_cvm_filing_cnpj_idx on fund_monthly_cvm_filing (cnpj, competencia);

-- ---------- Log de sincronização ----------
create table if not exists registry_sync_log (
  id uuid primary key default gen_random_uuid(),
  dataset text not null,
  source_url text,
  rows_seen integer,
  rows_upserted integer,
  status text not null default 'ok',
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- ---------- Liga o fundo monitorado ao cadastro oficial ----------
alter table funds add column if not exists cnpj_fundo_master text;
create index if not exists funds_cnpj_fundo_master_idx on funds (cnpj_fundo_master);
comment on column funds.cnpj_fundo_master is
  'CNPJ só-dígitos que casa com fund_master.cnpj — JOIN único para todos os módulos.';

-- =============================================================
-- RLS — leitura no portal (ainda sem login); escrita só papel risco.
-- Scripts de sync usam service_role / sb_secret_ e ignoram RLS.
-- =============================================================
alter table fund_master enable row level security;
alter table fund_isin_map enable row level security;
alter table fund_monthly_cvm_filing enable row level security;
alter table registry_sync_log enable row level security;

drop policy if exists "read_fund_master" on fund_master;
create policy "read_fund_master" on fund_master for select
  using (auth.role() in ('anon', 'authenticated'));
drop policy if exists "read_fund_isin_map" on fund_isin_map;
create policy "read_fund_isin_map" on fund_isin_map for select
  using (auth.role() in ('anon', 'authenticated'));
drop policy if exists "read_fund_monthly_cvm_filing" on fund_monthly_cvm_filing;
create policy "read_fund_monthly_cvm_filing" on fund_monthly_cvm_filing for select
  using (auth.role() in ('anon', 'authenticated'));
drop policy if exists "read_registry_sync_log" on registry_sync_log;
create policy "read_registry_sync_log" on registry_sync_log for select
  using (auth.role() in ('anon', 'authenticated'));

drop policy if exists "write_fund_master" on fund_master;
create policy "write_fund_master" on fund_master for insert with check (current_role_is('risco'));
drop policy if exists "update_fund_master" on fund_master;
create policy "update_fund_master" on fund_master for update using (current_role_is('risco'));
drop policy if exists "write_fund_isin_map" on fund_isin_map;
create policy "write_fund_isin_map" on fund_isin_map for insert with check (current_role_is('risco'));
drop policy if exists "update_fund_isin_map" on fund_isin_map;
create policy "update_fund_isin_map" on fund_isin_map for update using (current_role_is('risco'));
drop policy if exists "write_fund_monthly_cvm_filing" on fund_monthly_cvm_filing;
create policy "write_fund_monthly_cvm_filing" on fund_monthly_cvm_filing for insert with check (current_role_is('risco'));
drop policy if exists "update_fund_monthly_cvm_filing" on fund_monthly_cvm_filing;
create policy "update_fund_monthly_cvm_filing" on fund_monthly_cvm_filing for update using (current_role_is('risco'));
drop policy if exists "write_registry_sync_log" on registry_sync_log;
create policy "write_registry_sync_log" on registry_sync_log for insert with check (current_role_is('risco'));
drop policy if exists "update_registry_sync_log" on registry_sync_log;
create policy "update_registry_sync_log" on registry_sync_log for update using (current_role_is('risco'));
