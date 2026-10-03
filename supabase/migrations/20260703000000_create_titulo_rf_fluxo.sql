-- titulo_rf_fluxo: cronograma de pagamentos de títulos RF com amortizações intermediárias
-- Usado para calcular prazo médio conforme Art. 4º §2º inciso II IN RFB 1585/2015
-- (média ponderada de todos os fluxos de principal e juros por valor nominal)

-- ────────────────────────────────────────────────
-- 1. Colunas novas em ativos
-- ────────────────────────────────────────────────

ALTER TABLE public.ativos
  ADD COLUMN IF NOT EXISTS usa_fluxo_intermediario BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.ativos
  ADD COLUMN IF NOT EXISTS metodo_prazo_rf TEXT NOT NULL DEFAULT 'vencimento';

ALTER TABLE public.ativos
  ADD CONSTRAINT ativos_metodo_prazo_rf_check
    CHECK (metodo_prazo_rf IN ('vencimento', 'fluxo_nominal'));

COMMENT ON COLUMN public.ativos.usa_fluxo_intermediario IS
  'true quando o título possui amortizações intermediárias cadastradas em titulo_rf_fluxo. '
  'Ativa o cálculo por inciso II (média ponderada de fluxos) no lugar do inciso I (vencimento final).';

COMMENT ON COLUMN public.ativos.metodo_prazo_rf IS
  'Método de cálculo do prazo médio tributário para este título: '
  '"vencimento" = inciso I (dtvencimento); "fluxo_nominal" = inciso II (WAM por fluxos nominais).';

-- ────────────────────────────────────────────────
-- 2. Tabela de cronograma de fluxos
-- ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.titulo_rf_fluxo (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Vínculo com o Cardápio de Ativos (nullable para importação sem match ainda)
  ativo_id        UUID        REFERENCES public.ativos(id) ON DELETE CASCADE,

  -- Chave textual canônica: "isin:BR..." ou "cetip:BRKMLTNCM008"
  -- Permite importar fluxos antes do ativo estar cadastrado ou quando não há UUID disponível
  chave_ativo     TEXT        NOT NULL,

  data_pagamento  DATE        NOT NULL,
  valor_nominal   NUMERIC     NOT NULL CHECK (valor_nominal > 0),

  tipo_fluxo      TEXT        NOT NULL DEFAULT 'amortizacao'
                  CHECK (tipo_fluxo IN ('amortizacao', 'juros', 'residual')),

  -- Ordem sequencial dentro do cronograma (opcional, para exibição)
  ordem           INT,

  arquivo_origem  TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Evita duplicatas exatas na importação
  UNIQUE (chave_ativo, data_pagamento, tipo_fluxo, valor_nominal)
);

CREATE INDEX IF NOT EXISTS idx_titulo_rf_fluxo_chave
  ON public.titulo_rf_fluxo(chave_ativo);

CREATE INDEX IF NOT EXISTS idx_titulo_rf_fluxo_ativo_id
  ON public.titulo_rf_fluxo(ativo_id)
  WHERE ativo_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_titulo_rf_fluxo_data
  ON public.titulo_rf_fluxo(data_pagamento);

-- RLS: mesma política permissiva usada nas demais tabelas do sistema
ALTER TABLE public.titulo_rf_fluxo ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on titulo_rf_fluxo"
  ON public.titulo_rf_fluxo
  FOR ALL
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.titulo_rf_fluxo IS
  'Cronograma de fluxos futuros (amortizações e juros) de títulos RF com pagamentos intermediários. '
  'Usado no cálculo do prazo médio tributário conforme Art. 4º §2º inciso II IN RFB 1585/2015. '
  'A chave_ativo no formato "isin:BRXXXX" ou "cetip:CODIGO" é usada para associar fluxos '
  'à linha correspondente em posicao_carteira.';

COMMENT ON COLUMN public.titulo_rf_fluxo.chave_ativo IS
  'Chave canônica do ativo: "isin:<ISIN>" ou "cetip:<CODIGO_CETIP_SELIC>". '
  'Usada para resolver o cronograma a partir de posicao_carteira.isin / posicao_carteira.codativo.';

COMMENT ON COLUMN public.titulo_rf_fluxo.data_pagamento IS
  'Data do pagamento do fluxo (liquidação financeira).';

COMMENT ON COLUMN public.titulo_rf_fluxo.valor_nominal IS
  'Valor nominal do fluxo (R$). Para amortização = parcela do principal; '
  'para juros = cupom do período. Usado como peso no WAM (inciso II).';

COMMENT ON COLUMN public.titulo_rf_fluxo.tipo_fluxo IS
  'amortizacao = parcela do principal; juros = cupom periódico; residual = valor final bullet.';
