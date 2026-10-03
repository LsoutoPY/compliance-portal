-- ============================================================
-- BETAS E RENTABILIDADE POR CNPJ DO FUNDO
-- ============================================================
-- Motivação:
--   O modelo de stress atual aplica betas por NomEstr (categoria
--   genérica). Isso é impreciso para fundos multimercado, FICs e
--   FOFs, onde a composição real varia muito dentro da classe.
--   Esta migração adiciona:
--     1. CNPJ nas linhas de posicao_diaria (para fundos brasileiros)
--     2. Tabela de betas calculados por CNPJ (regressão OLS contra
--        CDI / IMA-B / Ibov / Dólar / S&P)
--     3. Tabela de rentabilidade histórica por CNPJ
--     4. Tabela de mapeamento manual para ativos offshore (ISIN)
--     5. Metadados de origem do beta em resultado_auditoria
-- ============================================================

-- 1. CNPJ e status em posicao_diaria ---------------------------
ALTER TABLE posicao_diaria
  ADD COLUMN IF NOT EXISTS cnpj        TEXT,
  ADD COLUMN IF NOT EXISTS cnpj_status TEXT;

-- Status possíveis:
--   OK                   -> CNPJ 14 dígitos limpo
--   DUPLICADO_14D        -> "XX..., XX..." mesmo CNPJ repetido
--   MULTIPLOS_CNPJS      -> CNPJs diferentes separados por vírgula
--   CODIGO_ESTRANGEIRO   -> ISIN ou código (offshore) — ex.: G7112N284
--   NUMERICO_CURTO       -> Número curto (ETF com código interno, "0")
--   CIENTIFICA           -> Notação científica (dado corrompido)
--   INVALIDO             -> Não casou em nenhum padrão
--   VAZIO                -> Sem CNPJ (caixa, TPF direto, ações)
ALTER TABLE posicao_diaria
  DROP CONSTRAINT IF EXISTS posicao_diaria_cnpj_status_chk;
ALTER TABLE posicao_diaria
  ADD CONSTRAINT posicao_diaria_cnpj_status_chk
  CHECK (cnpj_status IS NULL OR cnpj_status IN (
    'OK','DUPLICADO_14D','MULTIPLOS_CNPJS','CODIGO_ESTRANGEIRO',
    'NUMERICO_CURTO','CIENTIFICA','INVALIDO','VAZIO'
  ));

CREATE INDEX IF NOT EXISTS idx_posicao_cnpj
  ON posicao_diaria(cnpj)
  WHERE cnpj IS NOT NULL;

-- 2. Tabela de betas por CNPJ ---------------------------------
CREATE TABLE IF NOT EXISTS betas_por_cnpj (
  cnpj             TEXT PRIMARY KEY,       -- 14 dígitos, sem máscara
  nome_fundo       TEXT,

  -- Coeficientes da regressão OLS (mesmo formato de betas por classe)
  b_cdi            NUMERIC NOT NULL DEFAULT 0,
  b_ipca           NUMERIC NOT NULL DEFAULT 0,
  b_ibov           NUMERIC NOT NULL DEFAULT 0,
  b_dolar          NUMERIC NOT NULL DEFAULT 0,
  b_sp500          NUMERIC NOT NULL DEFAULT 0,
  b_imab           NUMERIC NOT NULL DEFAULT 0,
  b_imab5          NUMERIC NOT NULL DEFAULT 0,
  b_imab5p         NUMERIC NOT NULL DEFAULT 0,

  -- Qualidade da regressão
  alpha_aa         NUMERIC,                -- alpha anualizado (%)
  r2               NUMERIC,
  n_obs            INTEGER,                -- nº de dias úteis usados
  janela_inicio    DATE,
  janela_fim       DATE,

  -- Pior 21 dias úteis observado na série do fundo
  pior_21d_pct     NUMERIC,                -- em %
  pior_21d_inicio  DATE,
  pior_21d_fim     DATE,

  -- Classificação automática e decisão humana
  --   USAR      -> betas calculados aplicados no cálculo de stress
  --   REVISAR   -> aguardando aprovação humana (fallback para classe)
  --   FALLBACK  -> sempre usar beta da classe (qualidade ruim / ilíquido)
  qualidade        TEXT NOT NULL DEFAULT 'REVISAR'
    CHECK (qualidade IN ('USAR','REVISAR','FALLBACK')),
  aprovado_por     TEXT,
  aprovado_em      TIMESTAMPTZ,
  observacao       TEXT,

  fonte            TEXT NOT NULL DEFAULT 'cvm_inf_diario',
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_betas_cnpj_qualidade
  ON betas_por_cnpj(qualidade);

-- 3. Tabela de rentabilidade diária por CNPJ ------------------
CREATE TABLE IF NOT EXISTS rentabilidade_fundos (
  cnpj      TEXT NOT NULL,
  data_ref  DATE NOT NULL,
  cota      NUMERIC,
  ret_1d    NUMERIC,          -- retorno diário (decimal)
  ret_21d   NUMERIC,          -- retorno 21 dias úteis (decimal)
  ret_252d  NUMERIC,          -- retorno 252 dias úteis (decimal)
  PRIMARY KEY (cnpj, data_ref)
);

CREATE INDEX IF NOT EXISTS idx_rentabilidade_cnpj_data
  ON rentabilidade_fundos(cnpj, data_ref DESC);

-- 4. Mapeamento opcional de ativos offshore (ISIN / código) → CNPJ
--    Usado quando queremos aproximar beta via fundo brasileiro
--    equivalente, ou simplesmente registrar a origem.
CREATE TABLE IF NOT EXISTS fundos_mapeamento_offshore (
  id            SERIAL PRIMARY KEY,
  codigo        TEXT NOT NULL UNIQUE,      -- ISIN ou código Smartbrain
  nome          TEXT,
  cnpj_espelho  TEXT,                      -- se houver fundo BR feeder
  observacao    TEXT,
  criado_em     TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Metadados de origem do beta em resultado_auditoria -------
ALTER TABLE resultado_auditoria
  ADD COLUMN IF NOT EXISTS origem_beta   TEXT,    -- 'CNPJ' | 'CLASSE' | 'NAO_MAPEADO'
  ADD COLUMN IF NOT EXISTS cnpj          TEXT,
  ADD COLUMN IF NOT EXISTS r2_beta_cnpj  NUMERIC;

ALTER TABLE resultado_auditoria
  DROP CONSTRAINT IF EXISTS resultado_auditoria_origem_beta_chk;
ALTER TABLE resultado_auditoria
  ADD CONSTRAINT resultado_auditoria_origem_beta_chk
  CHECK (origem_beta IS NULL OR origem_beta IN ('CNPJ','CLASSE','NAO_MAPEADO'));

-- 6. RPC para aprovar/rejeitar beta via UI --------------------
CREATE OR REPLACE FUNCTION aprovar_beta_cnpj(
  p_cnpj        TEXT,
  p_qualidade   TEXT,
  p_aprovado_por TEXT DEFAULT NULL,
  p_observacao  TEXT DEFAULT NULL
)
RETURNS void AS $$
  UPDATE betas_por_cnpj
     SET qualidade    = p_qualidade,
         aprovado_por = p_aprovado_por,
         aprovado_em  = NOW(),
         observacao   = COALESCE(p_observacao, observacao),
         atualizado_em = NOW()
   WHERE cnpj = p_cnpj;
$$ LANGUAGE sql;

-- 7. View de apoio: último snapshot de CNPJs com posição ------
--    Usado pelo script Python para descobrir quais CNPJs precisa
--    baixar da CVM.
CREATE OR REPLACE VIEW vw_cnpjs_em_posicao AS
SELECT DISTINCT
  cnpj,
  MAX(nom_atv)   AS nom_atv_amostra,
  MAX(nom_estr)  AS nom_estr_amostra,
  COUNT(*)       AS ocorrencias,
  MAX(data_posicao) AS ultima_data
FROM posicao_diaria
WHERE cnpj IS NOT NULL
  AND cnpj_status IN ('OK','DUPLICADO_14D')
GROUP BY cnpj;
