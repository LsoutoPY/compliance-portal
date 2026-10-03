-- ============================================================
-- Série temporal de VaR por fundo (CNPJ)
-- Populada por calcular_var_completo.py / backfill-var-historico.py
-- ============================================================

CREATE TABLE IF NOT EXISTS var_historico_fundo (
  cnpj          TEXT        NOT NULL,
  data_ref      DATE        NOT NULL,
  var_95_hist   NUMERIC,
  var_95_param  NUMERIC,
  var_95_mc_t   NUMERIC,
  created_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  PRIMARY KEY (cnpj, data_ref)
);

CREATE INDEX IF NOT EXISTS idx_var_hist_fundo_cnpj_data
  ON var_historico_fundo (cnpj, data_ref DESC);

COMMENT ON TABLE var_historico_fundo IS
  'Série temporal de VaR 95% por CNPJ (point-in-time). Populada pelo backfill diário.';
COMMENT ON COLUMN var_historico_fundo.var_95_hist IS
  'VaR Histórico 95% horizonte 21d na data_ref (decimal, negativo=perda).';
COMMENT ON COLUMN var_historico_fundo.var_95_param IS
  'VaR Paramétrico 95% horizonte 21d na data_ref.';
COMMENT ON COLUMN var_historico_fundo.var_95_mc_t IS
  'VaR MC t-Student 95% horizonte 21d na data_ref.';

ALTER TABLE var_historico_fundo ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'var_historico_fundo' AND policyname = 'read_all'
  ) THEN
    CREATE POLICY "read_all" ON var_historico_fundo FOR SELECT USING (true);
  END IF;
END $$;
