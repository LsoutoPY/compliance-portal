-- Limpeza dos dados de seed fictícios inseridos para desenvolvimento.
-- Remove todos os registros de fundos_taxas cujo fundo_cnpj NÃO existe
-- em posicao_carteira (ou seja, CNPJs que não são fundos reais do sistema).
-- Em seguida, garante que todos os fundos reais de posicao_carteira estejam
-- cadastrados em fundos_taxas via sync.

-- 1. Remove histórico de PL dos fundos fictícios (cascade já faria, mas
--    a FK é por fundo_cnpj texto, então fazemos explícito para segurança)
delete from public.fundos_pl_historico
where fundo_cnpj not in (
  select distinct fundo_cnpj
  from public.posicao_carteira
  where fundo_cnpj is not null
    and fundo_cnpj <> ''
);

-- 2. Remove os fundos fictícios
delete from public.fundos_taxas
where fundo_cnpj not in (
  select distinct fundo_cnpj
  from public.posicao_carteira
  where fundo_cnpj is not null
    and fundo_cnpj <> ''
);

-- 3. Sincroniza fundos reais que ainda não estejam na tabela
select sync_fundos_from_posicao();
