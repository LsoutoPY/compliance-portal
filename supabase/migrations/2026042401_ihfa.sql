-- ============================================================
-- IHFA (Índice de Hedge Funds ANBIMA)
-- ============================================================
-- Adiciona IHFA como fator de risco e benchmark em todas as
-- tabelas relevantes do módulo de stress testing.
--
-- Fontes diárias:
--   Nível  → ANBIMA ima_completo.xls aba "Quadro Resumo" (IHF)
--   Histórico longo → importar da Economatica (mesma função)
-- ============================================================

-- 1. Histórico diário de mercado (usado pelo calcular-pior-janela)
ALTER TABLE historico_mercado
  ADD COLUMN IF NOT EXISTS ihfa NUMERIC;

-- 2. Índices diários (usado pelo atualizar-betas-por-cnpj.py)
ALTER TABLE historico_indices
  ADD COLUMN IF NOT EXISTS ihfa NUMERIC;

-- 3. Choques dos cenários
ALTER TABLE cenarios
  ADD COLUMN IF NOT EXISTS delta_ihfa NUMERIC NOT NULL DEFAULT 0;

-- 4. Betas por estratégia (tabela de fallback)
ALTER TABLE betas
  ADD COLUMN IF NOT EXISTS b_ihfa NUMERIC NOT NULL DEFAULT 0;

-- 5. Betas por CNPJ (regressão OLS)
ALTER TABLE betas_por_cnpj
  ADD COLUMN IF NOT EXISTS b_ihfa NUMERIC NOT NULL DEFAULT 0;

-- 6. Auditoria por ativo × cenário
ALTER TABLE resultado_auditoria
  ADD COLUMN IF NOT EXISTS b_ihfa   NUMERIC,
  ADD COLUMN IF NOT EXISTS imp_ihfa NUMERIC;

-- 7. Atualizar cenários históricos existentes com delta_ihfa = 0
--    (default já aplicado pelo ADD COLUMN, apenas para clareza)
UPDATE cenarios
  SET delta_ihfa = 0
  WHERE delta_ihfa IS NULL;
