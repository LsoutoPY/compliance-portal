-- Adiciona coluna isin a fundos_caracteristicas para permitir match preciso
-- por subclasse de FIDC (e outros fundos) durante o cálculo de risco de liquidez.
--
-- Contexto: quando um fundo (ex: Oportunidade) detém cotas de um FIDC com múltiplas
-- subclasses (SR, MEZ1, MEZ2...), o XML de carteira fornece o ISIN da cota específica
-- (ex: BRMOVVCTSR001 para a cota Sênior). Cada subclasse tem prazo_pagamento_resgate_dias
-- diferente. Sem o ISIN, o sistema buscava só pelo CNPJ e retornava o prazo da Classe-raiz,
-- ignorando as diferenças entre subclasses.
--
-- Solução: armazenar o ISIN da subclasse em fundos_caracteristicas (vem da planilha ANBIMA)
-- e fazer o lookup primeiro por ISIN, com fallback para CNPJ.

ALTER TABLE public.fundos_caracteristicas
  ADD COLUMN IF NOT EXISTS isin TEXT;

COMMENT ON COLUMN public.fundos_caracteristicas.isin
IS 'ISIN da cota/subclasse (ex: BRMOVVCTSR001). Permite match direto com posicao_carteira.isin para fundos FIDC com múltiplas subclasses.';

-- Índice único parcial: permite múltiplos NULLs (registros sem ISIN), mas garante
-- unicidade quando o ISIN é informado.
CREATE UNIQUE INDEX IF NOT EXISTS fundos_caracteristicas_isin_key
  ON public.fundos_caracteristicas (isin)
  WHERE isin IS NOT NULL;
