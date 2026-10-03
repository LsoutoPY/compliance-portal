-- ============================================================
-- STRESS TESTING DIÁRIO — MIGRAÇÃO COMPLETA
-- ============================================================

-- 1. carteiras
CREATE TABLE IF NOT EXISTS carteiras (
  id              SERIAL PRIMARY KEY,
  cod_cli         INTEGER NOT NULL UNIQUE,
  nome            TEXT NOT NULL,
  officer         TEXT,
  perfil_gestao   TEXT,
  stress_contrato TEXT,
  stress_num      NUMERIC,
  grupo           CHAR(1) NOT NULL DEFAULT 'B',
  ativo           BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 2. posicao_diaria
CREATE TABLE IF NOT EXISTS posicao_diaria (
  id           SERIAL PRIMARY KEY,
  cod_cli      INTEGER NOT NULL,
  data_posicao DATE NOT NULL,
  nom_atv      TEXT,
  nom_estr     TEXT NOT NULL,
  risco        TEXT,
  sld_lqd      NUMERIC NOT NULL DEFAULT 0,
  sld_brt      NUMERIC,
  vlr_preco    NUMERIC,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_posicao_cod_cli ON posicao_diaria(cod_cli, data_posicao);
CREATE INDEX IF NOT EXISTS idx_posicao_data    ON posicao_diaria(data_posicao);

-- 3. pl_referencia
CREATE TABLE IF NOT EXISTS pl_referencia (
  id              SERIAL PRIMARY KEY,
  cod_cli         INTEGER NOT NULL,
  mes_referencia  TEXT NOT NULL,
  data_referencia DATE NOT NULL,
  pl_bruto        NUMERIC,
  pl_pos_taxas    NUMERIC NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(cod_cli, mes_referencia)
);

-- 4. betas
CREATE TABLE IF NOT EXISTS betas (
  id         SERIAL PRIMARY KEY,
  nom_estr   TEXT NOT NULL UNIQUE,
  b_cdi      NUMERIC NOT NULL DEFAULT 0,
  b_ipca     NUMERIC NOT NULL DEFAULT 0,
  b_ibov     NUMERIC NOT NULL DEFAULT 0,
  b_dolar    NUMERIC NOT NULL DEFAULT 0,
  b_sp500    NUMERIC NOT NULL DEFAULT 0,
  observacao TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. cenarios
CREATE TABLE IF NOT EXISTS cenarios (
  id          SERIAL PRIMARY KEY,
  nome        TEXT NOT NULL UNIQUE,
  tipo        TEXT NOT NULL CHECK (tipo IN ('vigente', 'historico')),
  delta_cdi   NUMERIC NOT NULL DEFAULT 0,
  delta_ipca  NUMERIC NOT NULL DEFAULT 0,
  delta_ibov  NUMERIC NOT NULL DEFAULT 0,
  delta_dolar NUMERIC NOT NULL DEFAULT 0,
  delta_sp500 NUMERIC NOT NULL DEFAULT 0,
  descricao   TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 6. resultado_stress
CREATE TABLE IF NOT EXISTS resultado_stress (
  id             SERIAL PRIMARY KEY,
  cod_cli        INTEGER NOT NULL,
  data_calculo   DATE NOT NULL,
  cenario_nome   TEXT NOT NULL,
  pl_ref         NUMERIC,
  pl_atual       NUMERIC,
  pl_estressado  NUMERIC,
  perda_absoluta NUMERIC,
  perda_pct      NUMERIC,
  pct_utilizado  NUMERIC,
  folga_rs       NUMERIC,
  status         TEXT CHECK (status IN ('GATILHO','ATENCAO','OK','PASSIVO','SEM_DADOS')),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(cod_cli, data_calculo, cenario_nome)
);

CREATE INDEX IF NOT EXISTS idx_resultado_data ON resultado_stress(data_calculo);
CREATE INDEX IF NOT EXISTS idx_resultado_cod  ON resultado_stress(cod_cli, data_calculo);

-- 7. resultado_auditoria
CREATE TABLE IF NOT EXISTS resultado_auditoria (
  id             SERIAL PRIMARY KEY,
  cod_cli        INTEGER NOT NULL,
  data_calculo   DATE NOT NULL,
  cenario_nome   TEXT NOT NULL,
  nom_atv        TEXT,
  nom_estr       TEXT,
  risco          TEXT,
  sld_lqd        NUMERIC,
  pct_pl         NUMERIC,
  b_cdi          NUMERIC,
  b_ipca         NUMERIC,
  b_ibov         NUMERIC,
  b_dolar        NUMERIC,
  b_sp500        NUMERIC,
  choque_total   NUMERIC,
  imp_cdi_ipca   NUMERIC,
  imp_ibov       NUMERIC,
  imp_dol_sp     NUMERIC,
  pl_estressado  NUMERIC,
  contrib_perda  NUMERIC,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auditoria_cod ON resultado_auditoria(cod_cli, data_calculo, cenario_nome);

-- ============================================================
-- SEEDS
-- ============================================================

-- Betas (43 estratégias)
INSERT INTO betas (nom_estr, b_cdi, b_ipca, b_ibov, b_dolar, b_sp500) VALUES
('DI',                                     -0.08,  0,     0,     0,    0),
('Renda Fixa - Cdi+/%Cdi',                 -0.35,  0,     0,     0,    0),
('Renda Fixa Pós Fixado',                  -0.20,  0,     0,     0,    0),
('Renda Fixa - Ativo',                     -0.50,  0,     0,     0,    0),
('Renda Fixa - Inflação+',                  0,    -3.5,   0,     0,    0),
('Renda Fixa - Pré-Fixado',                -1.20,  0,     0,     0,    0),
('Renda Fixa - Investimento Exterior',      0,     0,     0,     0.8,  0),
('Caixa',                                   0,     0,     0,     0,    0),
('Valores a  Liquidar',                     0,     0,     0,     0,    0),
('Imobiliário - FII',                      -0.50,  0,     0.60,  0,    0),
('Imobiliário - FOF',                      -0.50,  0,     0.60,  0,    0),
('Imobiliário - Desenvolvimento',           0,     0,     0.50,  0,    0),
('Imobiliário - Imóvel',                    0,     0,     0,     0,    0),
('Renda Variável - Mono Ações',             0,     0,     1.00,  0.10, 0.10),
('Renda Variável - Long Only',              0,     0,     1.00,  0.10, 0.10),
('Renda Variável - Multi Gestores',         0,     0,     0.80,  0.20, 0.10),
('Renda Variável - Setoriais',              0,     0,     1.00,  0.10, 0.10),
('RENDA VARIÁVEL',                          0,     0,     1.00,  0.10, 0.10),
('Renda Variável - Private Equity',         0,     0,     0.70,  0.15, 0.10),
('Renda Variável - Investimento Exterior',  0,     0,     0.30,  0.80, 0.80),
('PRIVATE EQUITIES',                        0,     0,     0.70,  0.15, 0.10),
('Multimercado - Exclusivo',               -0.20,  0,     0.25,  0.10, 0.05),
('Multimercado - Multi Gestores',          -0.15,  0,     0.30,  0.10, 0.05),
('Multimercado - Macro',                   -0.20,  0,     0.25,  0.20, 0.10),
('Multimercado - Investimento Exterior',    0,     0,     0.15,  0.70, 0.60),
('Fundos de Previdência',                  -0.30,  0,     0.15,  0.05, 0.05),
('Fundos de Multimercado',                 -0.15,  0,     0.30,  0.10, 0.05),
('W US Equities',                           0,     0,     0.20,  1.00, 1.00),
('W EM Equities',                           0,     0,     0.50,  0.50, 0.60),
('W Global Equities',                       0,     0,     0.20,  0.80, 0.80),
('W US Fixed Income',                       0,     0,     0,     0.90, 0),
('W Global Fixed Income',                   0,     0,     0,     0.80, 0),
('W EM Fixed Income',                       0,     0,     0.10,  0.60, 0),
('W Balanced',                              0,     0,     0.15,  0.70, 0.50),
('W Allocation 30',                         0,     0,     0.10,  0.70, 0.30),
('W Allocation 40',                         0,     0,     0.15,  0.70, 0.40),
('W Allocation 60',                         0,     0,     0.20,  0.70, 0.60),
('W Hedge Fund',                            0,     0,     0.20,  0.60, 0.30),
('W Alternatives',                          0,     0,     0.15,  0.60, 0.30),
('W Global Commodities',                    0,     0,     0.20,  0.50, 0.30),
('W Private Equity',                        0,     0,     0.30,  0.70, 0.50),
('W Currency',                              0,     0,     0,     1.00, 0),
('W US Real Estate',                        0,     0,     0.10,  0.90, 0.40)
ON CONFLICT (nom_estr) DO NOTHING;

-- Cenários iniciais
INSERT INTO cenarios (nome, tipo, delta_cdi, delta_ipca, delta_ibov, delta_dolar, delta_sp500, descricao) VALUES
('Vigente',     'vigente',   3.0,  2.0,  -20.0,  15.0, -25.0, 'Cenário definido pelo Comitê de Risco. Atualizar mensalmente.'),
('Joesley Day', 'historico', 0.5,  0.0,   -8.8,   7.6,  -0.1, 'Mai/2017 — Gravação JBS/Temer. Ibov -8,8% em 1 sessão, Dólar +7,6%.'),
('Dilma 2015',  'historico', 6.0,  3.0,  -23.0,  55.0,  -6.0, 'Jan–Set/2015 — Impeachment + recessão. CDI +6pp, Dólar +55%.'),
('COVID 2020',  'historico',-1.5, -0.5,  -46.0,  35.0, -34.0, 'Fev–Mar/2020 — Pandemia. Ibov -46%, S&P -34% em ~30 dias.'),
('Greve Caminhoneiros 2018', 'historico', 0.8, 0.5, -7.60, -5.5, -0.30, 'Mai/2018 - Greve dos caminhoneiros (10 dias). Petrobras -26%, Ibov -7,6%. Dolar maior alta mensal desde set/2015. Janela: 18-30/mai/2018.')
ON CONFLICT (nome) DO NOTHING;
