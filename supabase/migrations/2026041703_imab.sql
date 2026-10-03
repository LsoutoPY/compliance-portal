-- ============================================================
-- IMA-B — ADICIONAR FATORES DE RISCO DE JURO REAL
-- Migration aditiva: não altera nenhuma coluna existente
-- ============================================================

-- 1a. Novas colunas em betas
ALTER TABLE betas
  ADD COLUMN IF NOT EXISTS b_imab   NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS b_imab5  NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS b_imab5p NUMERIC NOT NULL DEFAULT 0;

-- 1b. Novos choques em cenarios
ALTER TABLE cenarios
  ADD COLUMN IF NOT EXISTS delta_imab   NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delta_imab5  NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delta_imab5p NUMERIC NOT NULL DEFAULT 0;

-- 1c. Campos IMA-B em resultado_auditoria
ALTER TABLE resultado_auditoria
  ADD COLUMN IF NOT EXISTS b_imab   NUMERIC,
  ADD COLUMN IF NOT EXISTS b_imab5  NUMERIC,
  ADD COLUMN IF NOT EXISTS b_imab5p NUMERIC,
  ADD COLUMN IF NOT EXISTS imp_imab NUMERIC;

-- 1d. Histórico diário dos índices IMA-B (para calcular variação acumulada do mês)
CREATE TABLE IF NOT EXISTS historico_indices (
  data       DATE PRIMARY KEY,
  imab       NUMERIC,
  imab5      NUMERIC,
  imab5p     NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 1e. NomEstr sem beta definido — tabela de alerta para o Comitê
CREATE TABLE IF NOT EXISTS nom_estr_nao_mapeados (
  nom_estr     TEXT PRIMARY KEY,
  primeira_vez DATE NOT NULL,
  ultima_vez   DATE NOT NULL,
  ocorrencias  INTEGER NOT NULL DEFAULT 1
);

-- 1f. Choques históricos com valores IMA-B reais (dados históricos por crise)
UPDATE cenarios SET
  delta_imab = -3.1, delta_imab5 = -1.4, delta_imab5p = -4.2
WHERE nome = 'Joesley Day';

UPDATE cenarios SET
  delta_imab = -12.8, delta_imab5 = -5.2, delta_imab5p = -18.4
WHERE nome = 'Dilma 2015';

UPDATE cenarios SET
  delta_imab = -8.6, delta_imab5 = -3.1, delta_imab5p = -12.4
WHERE nome = 'COVID 2020';

UPDATE cenarios SET
  delta_imab = -6.2, delta_imab5 = -2.8, delta_imab5p = -8.9
WHERE nome = 'Greve Caminhoneiros 2018';

UPDATE cenarios SET
  delta_imab = -3.0, delta_imab5 = -1.5, delta_imab5p = -4.5
WHERE nome = 'Vigente';

-- 1g. Betas IMA-B por estratégia
-- Apenas as estratégias que têm exposição a juro real
UPDATE betas SET b_imab5 = 0.40, b_imab5p = 0.60
WHERE nom_estr = 'Renda Fixa - Inflação+';

UPDATE betas SET b_imab = 0.50
WHERE nom_estr = 'Fundos de Previdência';

UPDATE betas SET b_imab = 0.15
WHERE nom_estr = 'Multimercado - Exclusivo';

UPDATE betas SET b_imab = 0.10
WHERE nom_estr IN (
  'Multimercado - Multi Gestores',
  'Multimercado - Macro',
  'Fundos de Multimercado'
);

-- Passo 6 — Função RPC para incrementar contador de nom_estr não mapeados
CREATE OR REPLACE FUNCTION increment_ocorrencias(p_nom_estr TEXT)
RETURNS void AS $$
  UPDATE nom_estr_nao_mapeados
  SET ultima_vez  = CURRENT_DATE,
      ocorrencias = ocorrencias + 1
  WHERE nom_estr = p_nom_estr;
$$ LANGUAGE sql;
