-- =============================================================
-- 0006_xml_posicao.sql
-- Completa o destino do XML de posição:
--   raw_xml_files  = arquivo bruto (Storage) + árvore parseada
--   fund_holdings  = uma linha por ativo (fonte = 'xml')
-- Permite INSERT pelo portal (ainda sem login) até o RBAC chegar.
-- =============================================================

alter table raw_xml_files
  add column if not exists file_name text,
  add column if not exists cnpj text;

alter table fund_holdings
  add column if not exists linha integer;

alter table fund_holdings drop constraint if exists fund_holdings_cnpj_data_fonte_ativo_key;
alter table fund_holdings drop constraint if exists fund_holdings_cnpj_data_fonte_linha_key;
alter table fund_holdings
  add constraint fund_holdings_cnpj_data_fonte_linha_key
  unique (cnpj, data, fonte, linha);

create index if not exists raw_xml_files_cnpj_idx on raw_xml_files (cnpj);
create index if not exists raw_xml_files_data_idx on raw_xml_files (data_posicao);

drop policy if exists "insert_raw_xml_files" on raw_xml_files;
create policy "insert_raw_xml_files" on raw_xml_files for insert
  with check (auth.role() in ('anon', 'authenticated'));

drop policy if exists "insert_fund_holdings" on fund_holdings;
create policy "insert_fund_holdings" on fund_holdings for insert
  with check (auth.role() in ('anon', 'authenticated'));

drop policy if exists "update_fund_holdings" on fund_holdings;
create policy "update_fund_holdings" on fund_holdings for update
  using (auth.role() in ('anon', 'authenticated'))
  with check (auth.role() in ('anon', 'authenticated'));

drop policy if exists "insert_ingest_runs" on ingest_runs;
create policy "insert_ingest_runs" on ingest_runs for insert
  with check (auth.role() in ('anon', 'authenticated'));

drop policy if exists "update_ingest_runs" on ingest_runs;
create policy "update_ingest_runs" on ingest_runs for update
  using (auth.role() in ('anon', 'authenticated'))
  with check (auth.role() in ('anon', 'authenticated'));

comment on column raw_xml_files.file_name is
  'Nome original do XML enviado no portal.';
comment on column fund_holdings.linha is
  'Ordem do ativo no arquivo. Unique com (cnpj, data, fonte).';
