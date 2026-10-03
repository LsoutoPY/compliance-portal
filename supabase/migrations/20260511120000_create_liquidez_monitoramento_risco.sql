-- Tabela para persistir os resultados do cálculo de risco de liquidez por fundo/data.
-- Substitui o cache volátil de localStorage, garantindo que recalculações passadas
-- fiquem disponíveis em qualquer sessão, dispositivo ou navegador.

CREATE TABLE IF NOT EXISTS public.liquidez_monitoramento_risco (
  id                  uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  fundo_cnpj          text            NOT NULL,   -- CNPJ limpo (somente dígitos, 14 chars)
  dt_posicao          text            NOT NULL,   -- Formato YYYYMMDD
  total_pl            numeric         NULL,
  is_fundo_fechado    boolean         NOT NULL DEFAULT false,
  prazo_resgate       integer         NULL,
  indice_liquidez     numeric         NULL,
  status              text            NOT NULL,   -- 'ok' | 'alerta' | 'violacao' | 'pendente'
  intermediate_status text            NULL,       -- 'ok' | 'alerta' | 'violacao' | null
  calculado_em        timestamptz     NOT NULL DEFAULT now(),

  CONSTRAINT liquidez_monitoramento_risco_cnpj_dt_uq
    UNIQUE (fundo_cnpj, dt_posicao)
);

COMMENT ON TABLE public.liquidez_monitoramento_risco IS
  'Cache persistente dos resultados do cálculo de risco de liquidez por fundo e data de posição. '
  'Permite retornar a datas passadas sem precisar recalcular.';

-- Índices para consultas típicas
CREATE INDEX IF NOT EXISTS idx_lmr_dt_posicao
  ON public.liquidez_monitoramento_risco (dt_posicao DESC);

CREATE INDEX IF NOT EXISTS idx_lmr_cnpj_dt
  ON public.liquidez_monitoramento_risco (fundo_cnpj, dt_posicao);

-- RLS: leitura pública, escrita autenticada
ALTER TABLE public.liquidez_monitoramento_risco ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "liquidez_monitoramento_risco_select"    ON public.liquidez_monitoramento_risco;
DROP POLICY IF EXISTS "liquidez_monitoramento_risco_insert_update" ON public.liquidez_monitoramento_risco;

CREATE POLICY "liquidez_monitoramento_risco_select"
  ON public.liquidez_monitoramento_risco
  FOR SELECT USING (true);

CREATE POLICY "liquidez_monitoramento_risco_insert_update"
  ON public.liquidez_monitoramento_risco
  FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
