-- Amplia apenas a amostra monitorada da prévia CVM. Mínimos permanecem nulos
-- até validação do regulamento por fundo/classe.
insert into public.funds (short_name, cnpj, cnpj_fundo_master, min_subordination_index, active)
values
  ('CVPAR MIDDLE MARKET', '66886906000163', '66886906000163', null, true),
  ('CVPAR OPPORTUNITY', '61866286000187', '61866286000187', null, true),
  ('FIC CVPAR I MEZANINO', '56073102000191', '56073102000191', null, true),
  ('CVPAR SÊNIOR MULTIGESTORES', '58311427000190', '58311427000190', null, true)
on conflict (short_name) do nothing;
