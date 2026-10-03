-- O ZIP mensal já possui hash, arquivo, horário e log; o log passa a registrar
-- quem acionou a importação. Fatos antigos continuam identificados pelo log,
-- mas podem não ter usuário conhecido.
alter table public.registry_sync_log
  add column if not exists initiated_by uuid references auth.users(id);
