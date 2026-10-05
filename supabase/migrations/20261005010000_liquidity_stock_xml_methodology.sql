-- Metodologia indicativa separada. Nenhuma atribuição de fundo é alterada.
insert into public.liquidity_monthly_methodologies (code, version, label, configuration)
values (
  'cvpar_fidc_estoque_xml', '2026.1', 'FIDC mensal — estoque e XML (indicativo)',
  '{"requiredInputs":["estoque_recebiveis","posicao_carteira_xml"],"approval":"pending","coverage":"unavailable"}'::jsonb
)
on conflict (code, version) do nothing;
