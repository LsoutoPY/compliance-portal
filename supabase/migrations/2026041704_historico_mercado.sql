-- ============================================================
-- HISTÓRICO DE MERCADO — para cálculo de pior janela histórica
-- Fonte: Economatica (importação inicial) + buscar-mercado (diário)
-- ============================================================

CREATE TABLE IF NOT EXISTS historico_mercado (
  data      DATE PRIMARY KEY,
  ibov      NUMERIC,          -- Ibovespa fechamento (pontos)
  sp500     NUMERIC,          -- S&P 500 fechamento (pontos) — via Yahoo
  dolar     NUMERIC,          -- Dólar PTAX venda (R$/USD)
  cdi_taxa  NUMERIC,          -- CDI 252 dias taxa anualizada (ex: 13.65 = 13.65% aa)
  cdi_acum  NUMERIC,          -- CDI Acumulado nível do índice
  imab      NUMERIC,          -- IMA-B nível (ANBIMA)
  imab5     NUMERIC,          -- IMA-B 5 nível (ANBIMA)
  imab5p    NUMERIC,          -- IMA-B 5+ nível (ANBIMA)
  fonte     TEXT DEFAULT 'economatica',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_historico_mercado_data ON historico_mercado(data DESC);

-- ── Adicionar campos de controle nos cenários ──────────────────────────
ALTER TABLE cenarios
  ADD COLUMN IF NOT EXISTS horizonte_anos INTEGER,
  ADD COLUMN IF NOT EXISTS janela_du      INTEGER,
  ADD COLUMN IF NOT EXISTS metadata       JSONB;

-- ── Novo cenário automático ────────────────────────────────────────────
INSERT INTO cenarios (nome, tipo, delta_cdi, delta_ipca, delta_ibov, delta_dolar, delta_sp500,
                      delta_imab, delta_imab5, delta_imab5p,
                      horizonte_anos, janela_du,
                      descricao)
VALUES (
  'Pior Histórico 21d',
  'historico',
  0, 0, 0, 0, 0, 0, 0, 0,
  7, 21,
  'Pior janela de 21 DU de cada fator nos últimos 7 anos. Calculado automaticamente via dados Economatica. Execute "Calcular Pior Janela" para atualizar.'
)
ON CONFLICT (nome) DO NOTHING;
