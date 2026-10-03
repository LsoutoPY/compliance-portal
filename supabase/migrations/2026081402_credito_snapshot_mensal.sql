-- Migration: Snapshot mensal de crédito
-- Histórico de KPIs por fundo/mês para os cards de evolução da aba Saúde do FIDC.
-- Padrão inspirado em rentabilidade_snapshot_fundo / rentabilidade_snapshot_status.

-- ============================================================
-- Tabela principal de snapshot mensal
-- ============================================================
CREATE TABLE IF NOT EXISTS public.credito_snapshot_mensal_fundo (
  mes_referencia    date         NOT NULL CHECK (EXTRACT(DAY FROM mes_referencia) = 1),
  doc_fundo         text         NOT NULL,
  nome_fundo        text         NULL,
  -- indicadores de inadimplência
  provisao_total    numeric      NULL,   -- SUM(valor_pdd_atual) do estoque
  inadimplencia_pct numeric      NULL,   -- VP inadimplente / VP total
  over90_pct        numeric      NULL,   -- VP Over90 / VP total
  over180_pct       numeric      NULL,   -- VP Over180 / VP total
  -- write-off
  writeoff_total    numeric      NULL,   -- VP write-off
  -- retorno médio do crédito (proxy: tx_recebivel ponderada por VP)
  retorno_medio_credito numeric  NULL,
  -- tamanho da carteira
  vp_total          numeric      NULL,
  qtd_titulos       bigint       NULL,
  -- metadados
  calc_version      text         NOT NULL DEFAULT 'credito_v1',
  snapshot_created_at  timestamptz NOT NULL DEFAULT now(),
  snapshot_updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mes_referencia, doc_fundo)
);

CREATE INDEX IF NOT EXISTS idx_credito_snap_mensal_fundo
  ON public.credito_snapshot_mensal_fundo (doc_fundo, mes_referencia DESC);
CREATE INDEX IF NOT EXISTS idx_credito_snap_mensal_mes
  ON public.credito_snapshot_mensal_fundo (mes_referencia DESC);

COMMENT ON TABLE public.credito_snapshot_mensal_fundo IS
  'Snapshot persistido dos KPIs de crédito por fundo/mês (provisão, inadimplência, retorno médio).';

-- ============================================================
-- Tabela de status por mês (stale control)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.credito_snapshot_mensal_status (
  mes_referencia  date    PRIMARY KEY CHECK (EXTRACT(DAY FROM mes_referencia) = 1),
  is_stale        boolean NOT NULL DEFAULT false,
  stale_reason    text    NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_rebuild_at timestamptz NULL,
  last_rebuild_by uuid    NULL,
  calc_version    text    NULL
);

COMMENT ON TABLE public.credito_snapshot_mensal_status IS
  'Status de atualização do snapshot mensal de crédito por mês.';

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.credito_snapshot_mensal_fundo   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credito_snapshot_mensal_status  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "credito_snap_mensal_select_auth" ON public.credito_snapshot_mensal_fundo;
CREATE POLICY "credito_snap_mensal_select_auth"
  ON public.credito_snapshot_mensal_fundo FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "credito_snap_mensal_status_select_auth" ON public.credito_snapshot_mensal_status;
CREATE POLICY "credito_snap_mensal_status_select_auth"
  ON public.credito_snapshot_mensal_status FOR SELECT
  USING (auth.role() = 'authenticated');

-- Service role pode escrever (chamado pela edge function)
DROP POLICY IF EXISTS "credito_snap_mensal_insert_service" ON public.credito_snapshot_mensal_fundo;
CREATE POLICY "credito_snap_mensal_insert_service"
  ON public.credito_snapshot_mensal_fundo FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "credito_snap_mensal_status_insert_service" ON public.credito_snapshot_mensal_status;
CREATE POLICY "credito_snap_mensal_status_insert_service"
  ON public.credito_snapshot_mensal_status FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- RPC: upsert em lote — usada pela edge function snapshot-credito-mensal
-- p_mes: 'YYYY-MM-01' (primeiro dia do mês)
-- p_rows: jsonb array com campos da tabela
-- ============================================================
CREATE OR REPLACE FUNCTION public.upsert_credito_snapshot_mensal(
  p_mes     text,
  p_rows    jsonb,
  p_source  text DEFAULT 'manual'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_mes   date;
BEGIN
  -- Validar formato
  v_mes := p_mes::date;
  IF EXTRACT(DAY FROM v_mes) <> 1 THEN
    RAISE EXCEPTION 'p_mes deve ser o primeiro dia do mês, recebido: %', p_mes;
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.user_is_active() THEN
    RAISE EXCEPTION 'Usuário inativo';
  END IF;

  -- Deletar registros existentes do mês
  DELETE FROM public.credito_snapshot_mensal_fundo WHERE mes_referencia = v_mes;

  -- Inserir novos
  INSERT INTO public.credito_snapshot_mensal_fundo (
    mes_referencia, doc_fundo, nome_fundo,
    provisao_total, inadimplencia_pct, over90_pct, over180_pct,
    writeoff_total, retorno_medio_credito, vp_total, qtd_titulos,
    calc_version, snapshot_created_at, snapshot_updated_at
  )
  SELECT
    v_mes,
    r->>'doc_fundo',
    r->>'nome_fundo',
    (r->>'provisao_total')::numeric,
    (r->>'inadimplencia_pct')::numeric,
    (r->>'over90_pct')::numeric,
    (r->>'over180_pct')::numeric,
    (r->>'writeoff_total')::numeric,
    (r->>'retorno_medio_credito')::numeric,
    (r->>'vp_total')::numeric,
    (r->>'qtd_titulos')::bigint,
    COALESCE(r->>'calc_version', 'credito_v1'),
    now(), now()
  FROM jsonb_array_elements(p_rows) AS r;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Atualizar status do mês
  INSERT INTO public.credito_snapshot_mensal_status (mes_referencia, is_stale, updated_at, last_rebuild_at, calc_version)
  VALUES (v_mes, false, now(), now(), 'credito_v1')
  ON CONFLICT (mes_referencia) DO UPDATE SET
    is_stale = false,
    updated_at = now(),
    last_rebuild_at = now(),
    calc_version = 'credito_v1';

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.upsert_credito_snapshot_mensal IS
  'Upsert em lote de snapshots de crédito para um mês. Chamada pela edge function snapshot-credito-mensal.';

-- ============================================================
-- View de leitura da série mensal (para os cards de evolução)
-- ============================================================
CREATE OR REPLACE VIEW public.vw_credito_serie_mensal AS
SELECT
  s.mes_referencia,
  s.doc_fundo,
  s.nome_fundo,
  s.provisao_total,
  s.inadimplencia_pct,
  s.over90_pct,
  s.over180_pct,
  s.writeoff_total,
  s.retorno_medio_credito,
  s.vp_total,
  s.qtd_titulos,
  s.calc_version,
  s.snapshot_updated_at,
  st.is_stale
FROM public.credito_snapshot_mensal_fundo s
LEFT JOIN public.credito_snapshot_mensal_status st
  ON st.mes_referencia = s.mes_referencia
ORDER BY s.mes_referencia DESC, s.doc_fundo;

COMMENT ON VIEW public.vw_credito_serie_mensal IS
  'Série mensal de KPIs de crédito por fundo — base dos EvolutionCards na aba Saúde do FIDC.';
