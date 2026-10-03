-- ============================================================
-- SEED: Limites de VaR por carteira
-- ============================================================
-- Popula var_limites com um limite padrão de 5% (95%) / 8% (99%)
-- para TODAS as carteiras que atualmente têm posição em posicao_diaria.
--
-- Regra de negócio adotada (pode ser ajustada carteira a carteira):
--   limite_95 = 0.05  → alerta se |VaR 95%| > 5%
--   limite_99 = 0.08  → breach  se |VaR 99%| > 8%
--
-- Execute DEPOIS da migration 20260518_risco_mercado_var_v2.sql.
-- Pode ser re-executado sem erro (ON CONFLICT DO NOTHING).
-- ============================================================

-- ── 1. Seed automático — cria limites para todas as carteiras ──
INSERT INTO var_limites (cod_cli, limite_95, limite_99, ativo)
SELECT DISTINCT
  pd.cod_cli::INTEGER,
  0.05   AS limite_95,
  0.08   AS limite_99,
  true   AS ativo
FROM posicao_diaria pd
WHERE pd.cod_cli IS NOT NULL
ON CONFLICT (cod_cli) DO NOTHING;

-- ── 2. Ajustes específicos por perfil de carteira ──────────────
-- Fundos mais conservadores (renda-fixa pura): limite menor
-- Fundos multimercado / ações: limite maior
--
-- Descomente e ajuste conforme o comitê de risco deliberar.
-- Exemplo:
--
-- UPDATE var_limites SET limite_95 = 0.03, limite_99 = 0.05
--   WHERE cod_cli IN (/* cod_cli dos fundos RF */);
--
-- UPDATE var_limites SET limite_95 = 0.10, limite_99 = 0.15
--   WHERE cod_cli IN (/* cod_cli dos fundos de ações */);

-- ── 3. Mapa carteira → benchmark (para B-VaR) ─────────────────
-- Se a tabela carteira_benchmark não existir, cria ela aqui.
-- Usada pelo script calcular_var_completo.py para calcular B-VaR.

CREATE TABLE IF NOT EXISTS carteira_benchmark (
  id              UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  cod_cli         INTEGER NOT NULL UNIQUE,
  benchmark_nome  TEXT    NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now() NOT NULL
);

COMMENT ON TABLE carteira_benchmark IS
  'Mapa de carteira para benchmark de referência usado no cálculo de B-VaR.';

-- Seed: associa cada carteira ao CDI como benchmark padrão.
-- Ajuste para IBOV, IMA-B, etc. conforme mandato de cada fundo.
INSERT INTO carteira_benchmark (cod_cli, benchmark_nome)
SELECT DISTINCT
  pd.cod_cli::INTEGER,
  'CDI' AS benchmark_nome
FROM posicao_diaria pd
WHERE pd.cod_cli IS NOT NULL
ON CONFLICT (cod_cli) DO NOTHING;

-- ── 4. Verificação ────────────────────────────────────────────
SELECT
  vl.cod_cli,
  vl.limite_95,
  vl.limite_99,
  cb.benchmark_nome
FROM var_limites vl
LEFT JOIN carteira_benchmark cb USING (cod_cli)
ORDER BY vl.cod_cli;
