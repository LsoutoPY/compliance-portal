-- Módulo de Enquadramento Tributário — TRIB_FIQ_LP_90
-- IN RFB 1585/2015, Art. 5º: FIQ deve manter MM 10 d.u. >= 90% do PL em cotas LP tributário.
--
-- Tabelas criadas:
--   enquadramento_tributario_historico — série diária de p_dia e mm_10d por fundo
--   fundo_classificacao_tributaria     — cache de classificação LP/CP dos fundos investidos
--
-- O constraint de regra_categoria em enquadramento_resultado é expandido para incluir 'tributario'.

-- ============================================================
-- 1. Tabela de histórico diário (série temporal da MM-10d)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.enquadramento_tributario_historico (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fundo_cnpj          text NOT NULL,
  data_referencia     date NOT NULL,
  p_dia               numeric(8,4),        -- % do PL em cotas LP no dia (0-100)
  mm_10d              numeric(8,4),        -- média móvel de 10 d.u. (0-100)
  em_violacao         boolean,             -- true se mm_10d < 90
  eventos_ano         integer DEFAULT 0,   -- nº de sequências contíguas de violação no ano
  dias_violacao_ano   integer DEFAULT 0,   -- nº total de dias em violação no ano-calendário
  valor_lp            numeric(20,2),       -- R$ em cotas LP tributário
  valor_cp            numeric(20,2),       -- R$ em cotas CP tributário
  valor_excluido      numeric(20,2),       -- R$ em cotas excluídas (FIDC, FII, FIA, FIP…)
  pl_total            numeric(20,2),       -- PL total do fundo na data
  created_at          timestamptz DEFAULT now(),
  UNIQUE (fundo_cnpj, data_referencia)
);

COMMENT ON TABLE public.enquadramento_tributario_historico IS
  'Série diária de classificação tributária FIQ — base para cálculo da MM-10d do Art. 5º da IN RFB 1585/2015.';

CREATE INDEX IF NOT EXISTS idx_trib_hist_fundo_data
  ON public.enquadramento_tributario_historico (fundo_cnpj, data_referencia DESC);

CREATE INDEX IF NOT EXISTS idx_trib_hist_em_violacao
  ON public.enquadramento_tributario_historico (fundo_cnpj, data_referencia)
  WHERE em_violacao = true;

-- ============================================================
-- 2. Cache de classificação LP/CP dos fundos investidos
-- ============================================================
CREATE TABLE IF NOT EXISTS public.fundo_classificacao_tributaria (
  fundo_cnpj          text NOT NULL,
  data_referencia     date NOT NULL,
  prazo_medio_trib    numeric(10,2),       -- prazo médio tributário em dias corridos
  classificacao       text CHECK (classificacao IN ('lp', 'cp', 'excluido')),
  motivo              text,                -- ex: 'FIM LP (prazo 420d)' | 'FIDC excluído Art.4§5V'
  created_at          timestamptz DEFAULT now(),
  PRIMARY KEY (fundo_cnpj, data_referencia)
);

COMMENT ON TABLE public.fundo_classificacao_tributaria IS
  'Cache de classificação tributária LP/CP dos fundos investidos pelo FIQ. '
  'Evita recálculo recursivo em cada execução da rules-tributario.';

CREATE INDEX IF NOT EXISTS idx_fundo_class_trib_fundo
  ON public.fundo_classificacao_tributaria (fundo_cnpj, data_referencia DESC);

-- ============================================================
-- 3. Expandir constraint de regra_categoria para incluir 'tributario'
-- ============================================================
ALTER TABLE public.enquadramento_resultado
  DROP CONSTRAINT IF EXISTS enquadramento_resultado_regra_categoria_check;

ALTER TABLE public.enquadramento_resultado
  ADD CONSTRAINT enquadramento_resultado_regra_categoria_check
  CHECK (
    regra_categoria IN (
      'pl',
      'concentration',
      'liquidity',
      'classe',
      'relacional',
      'relational',
      'fidc-concentracao',
      'tributario'
    )
  );

-- ============================================================
-- 4. Seed: catálogo de regras compliance
-- ============================================================
INSERT INTO public.regras_compliance (codigo, descricao, parametros)
VALUES (
  'TRIB_FIQ_LP_90',
  'FIQ: mínimo 90% MM-10d em cotas LP tributário (IN RFB 1585/2015 Art. 5º)',
  '{
    "norma": "IN RFB 1585/2015 Art. 5º",
    "limite_mm": 90,
    "alerta_mm": 92,
    "janela_dias_uteis": 10,
    "max_eventos_ano": 3,
    "max_dias_violacao_ano": 45,
    "tipos_excluidos": ["FIDC", "FIDC NP", "FII", "FIA", "FIP", "FIP-IE", "FIP-PD&I", "FIEE", "FIAGRO"]
  }'::jsonb
) ON CONFLICT (codigo) DO NOTHING;
