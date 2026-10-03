-- Fundos monitorados do portal, ligados ao cadastro CVM (CNPJ só-dígitos).
-- Confirmados em registro_classe.csv da CVM em 2026-09.

insert into funds (short_name, cnpj, cnpj_fundo_master, administrator, custodian, min_subordination_index, active)
values
  ('CVPAR EDUC', '51864349000102', '51864349000102', 'QI CTVM', 'QI CTVM', 0.05, true),
  ('CVPAR I',    '23104485000169', '23104485000169', 'QI CTVM', 'QI CTVM', 0.15, true),
  ('CVPAR II',   '47425841000104', '47425841000104', 'QI CTVM', 'QI CTVM', 0.40, true),
  ('CVPAR NC',   '58426775000103', '58426775000103', 'QI CTVM', 'QI CTVM', 0.10, true)
on conflict (short_name) do update set
  cnpj = excluded.cnpj,
  cnpj_fundo_master = excluded.cnpj_fundo_master,
  administrator = excluded.administrator,
  custodian = excluded.custodian,
  min_subordination_index = excluded.min_subordination_index,
  active = excluded.active;
