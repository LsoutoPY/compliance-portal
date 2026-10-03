-- Seed de dados de desenvolvimento para fundos_taxas
-- Execute APÓS a migration 20260602000000_create_fundos_taxas.sql
--
-- ❗ Atenção: os CNPJs abaixo são fictícios para desenvolvimento.
-- Para produção, use a função sync_fundos_from_posicao() que importa
-- os fundos reais de posicao_carteira.

-- ── Sincronizar fundos existentes em posicao_carteira ─────────────────────
-- (importa fundos reais, com segmento padrão 'prospeccao' para revisão manual)
select sync_fundos_from_posicao();

-- ── Dados de demonstração (apenas se a tabela estiver vazia após o sync) ──
-- Insere exemplos com diferentes combinações de segmento, tipo e taxa.
insert into public.fundos_taxas
  (fundo_cnpj, codigo, tipo_fundo, pl_dez, pl_jan, tg_percentual, tg_minimo_mensal, segmento)
select * from (values
  -- Exclusivo familiar — cobrando % (acima do mínimo)
  ('00000000000191', '357189',      'FI',   26000000, 27521036, 0.005,  null,  'exclusivo_familiar'),
  -- Exclusivo familiar — no mínimo (% insuficiente)
  ('00000000000282', 'C0001166395', 'FI',   17000000, 18340000, 0.0035, 3750,  'exclusivo_familiar'),
  -- Exclusivo familiar — no mínimo
  ('00000000000373', '223401',      'FI',    8500000,  9200000, 0.003,  2500,  'exclusivo_familiar'),
  -- Alocação — sem taxa (receita na camada abaixo)
  ('00000000000464', '44812',       'FI',  400000000,412000000, 0,      null,  'alocacao'),
  ('00000000000555', '55391',       'FI',   85000000, 89000000, 0,      null,  'alocacao'),
  -- Asset — FIDC com mínimo
  ('00000000000646', 'FIDC-001',    'FIDC', 58000000, 62000000, 0.012,  8000,  'asset'),
  -- Asset — FIP com mínimo alto
  ('00000000000737', 'FIP-002',     'FIP', 130000000,134000000, 0.015,  15000, 'asset'),
  -- Asset — FII com mínimo
  ('00000000000828', 'FII-003',     'FII',  42000000, 45000000, 0.008,  5000,  'asset'),
  -- Prospecção — sem taxa definida ainda
  ('00000000000919', 'PROS-01',     'FI',          0,         0, 0,      null,  'prospeccao')
) as v(fundo_cnpj, codigo, tipo_fundo, pl_dez, pl_jan, tg_percentual, tg_minimo_mensal, segmento)
where not exists (
  select 1 from public.fundos_taxas ft where ft.fundo_cnpj = v.fundo_cnpj
);

-- ── Histórico de PL para demonstração dos gráficos ────────────────────────
-- Inserir apenas se o histórico estiver vazio
insert into public.fundos_pl_historico (fundo_cnpj, mes_ref, pl_valor)
select v.fundo_cnpj, v.mes_ref::date, v.pl_valor
from (values
  ('00000000000191', '2025-06-01', 24000000::numeric),
  ('00000000000191', '2025-07-01', 24500000::numeric),
  ('00000000000191', '2025-08-01', 25000000::numeric),
  ('00000000000191', '2025-09-01', 25200000::numeric),
  ('00000000000191', '2025-10-01', 25800000::numeric),
  ('00000000000191', '2025-11-01', 26100000::numeric),
  ('00000000000191', '2025-12-01', 26000000::numeric),
  ('00000000000191', '2026-01-01', 27521036::numeric),
  ('00000000000282', '2025-12-01', 17000000::numeric),
  ('00000000000282', '2026-01-01', 18340000::numeric),
  ('00000000000373', '2025-12-01',  8500000::numeric),
  ('00000000000373', '2026-01-01',  9200000::numeric)
) as v(fundo_cnpj, mes_ref, pl_valor)
where not exists (
  select 1 from public.fundos_pl_historico h
  where h.fundo_cnpj = v.fundo_cnpj and h.mes_ref = v.mes_ref::date
)
  and exists (
  select 1 from public.fundos_taxas ft where ft.fundo_cnpj = v.fundo_cnpj
);
