-- Snapshot incremental de rentabilidade por ativo.
--
-- Uma reimportacao substitui o conjunto inteiro de ativos de uma classe/fundo
-- naquela data. Isso evita duplicidade e impede que o relatorio leia uma
-- carteira parcialmente atualizada.

CREATE TABLE IF NOT EXISTS public.rentabilidade_snapshot_ativo (
  data_posicao date NOT NULL,
  fundo_key text NOT NULL,
  fundo_cnpj text NOT NULL,
  fundo_isin text NULL,
  ativo_key text NOT NULL,
  section text NOT NULL,
  ativo_cnpjfundo text NULL,
  ativo_isin text NULL,
  cnpj_ativo text NULL,
  isin_ativo text NULL,
  nome_ativo text NULL,
  nome_exibicao text NOT NULL,
  quantidade numeric NULL,
  pu_posicao numeric NULL,
  valor_mercado numeric NULL,
  perc_pl_pct numeric NULL,
  retorno_dia_pct numeric NULL,
  retorno_mes_pct numeric NULL,
  retorno_ano_pct numeric NULL,
  retorno_12m_pct numeric NULL,
  pct_cdi numeric NULL,
  cdi_plus_dia_pct numeric NULL,
  cdi_plus_aa_pct numeric NULL,
  pct_cdi_mes numeric NULL,
  cdi_plus_mes_pct numeric NULL,
  cdi_plus_aa_mes_pct numeric NULL,
  pct_cdi_ano numeric NULL,
  cdi_plus_ano_pct numeric NULL,
  cdi_plus_aa_ano_pct numeric NULL,
  pct_cdi_12m numeric NULL,
  cdi_plus_12m_pct numeric NULL,
  cdi_plus_aa_12m_pct numeric NULL,
  is_fidc boolean NOT NULL DEFAULT false,
  base_dia_data date NULL,
  base_mes_data date NULL,
  base_ano_data date NULL,
  base_12m_data date NULL,
  calc_version text NOT NULL DEFAULT 'rentabilidade_snapshot_v2',
  snapshot_created_at timestamptz NOT NULL DEFAULT now(),
  snapshot_updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (data_posicao, fundo_key, ativo_key)
);

-- Mantem a migration idempotente se a tabela for criada manualmente antes do deploy.
ALTER TABLE public.rentabilidade_snapshot_ativo
  ADD COLUMN IF NOT EXISTS ativo_cnpjfundo text NULL,
  ADD COLUMN IF NOT EXISTS ativo_isin text NULL;

COMMENT ON TABLE public.rentabilidade_snapshot_ativo IS
  'Resultado persistido da rentabilidade de cada ativo por fundo/classe e data.';
COMMENT ON COLUMN public.rentabilidade_snapshot_ativo.ativo_key IS
  'Chave deterministica do ativo. Reimportacao da mesma data substitui esta linha.';
COMMENT ON COLUMN public.rentabilidade_snapshot_ativo.ativo_cnpjfundo IS
  'Para section=cotas, CNPJ do fundo investido vindo de posicao_carteira.cnpjfundo.';
COMMENT ON COLUMN public.rentabilidade_snapshot_ativo.ativo_isin IS
  'Para section=cotas, ISIN do fundo investido vindo de posicao_carteira.isin.';

CREATE INDEX IF NOT EXISTS idx_rent_snapshot_ativo_fundo_data
  ON public.rentabilidade_snapshot_ativo (fundo_cnpj, data_posicao DESC);
CREATE INDEX IF NOT EXISTS idx_rent_snapshot_ativo_data
  ON public.rentabilidade_snapshot_ativo (data_posicao, fundo_key);

-- CDI e um dado compartilhado por todos os fundos. Persistir os acumulados por
-- data evita que cada fundo consulte e componha novamente os mesmos ~252 dias.
CREATE TABLE IF NOT EXISTS public.rentabilidade_snapshot_cdi (
  data_posicao date PRIMARY KEY,
  cdi_dia_pct numeric NULL,
  cdi_mes_pct numeric NULL,
  cdi_ano_pct numeric NULL,
  cdi_12m_pct numeric NULL,
  source text NOT NULL DEFAULT 'bcb_sgs_12',
  calculated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.rentabilidade_snapshot_cdi IS
  'Benchmark CDI acumulado por data, compartilhado por snapshots de fundos e ativos.';

ALTER TABLE public.rentabilidade_snapshot_ativo ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rentabilidade_snapshot_cdi ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rent_snap_ativo_select_auth" ON public.rentabilidade_snapshot_ativo;
CREATE POLICY "rent_snap_ativo_select_auth"
  ON public.rentabilidade_snapshot_ativo
  FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "rent_snap_cdi_select_auth" ON public.rentabilidade_snapshot_cdi;
CREATE POLICY "rent_snap_cdi_select_auth"
  ON public.rentabilidade_snapshot_cdi
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- Substitui de forma atomica todos os ativos de uma classe/fundo em uma data.
-- O parametro JSON permite que a Edge Function envie um unico payload e nunca
-- deixe a carteira em estado intermediario entre DELETE e INSERT.
CREATE OR REPLACE FUNCTION public.replace_rentabilidade_snapshot_ativos_v2(
  p_data_posicao date,
  p_fundo_key text,
  p_fundo_cnpj text,
  p_rows jsonb,
  p_calc_version text DEFAULT 'rentabilidade_snapshot_v2'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF p_data_posicao IS NULL OR COALESCE(trim(p_fundo_key), '') = '' OR COALESCE(trim(p_fundo_cnpj), '') = '' THEN
    RAISE EXCEPTION 'data_posicao, fundo_key e fundo_cnpj sao obrigatorios';
  END IF;

  DELETE FROM public.rentabilidade_snapshot_ativo
  WHERE data_posicao = p_data_posicao
    AND fundo_key = p_fundo_key;

  INSERT INTO public.rentabilidade_snapshot_ativo (
    data_posicao, fundo_key, fundo_cnpj, fundo_isin, ativo_key, section,
    ativo_cnpjfundo, ativo_isin, cnpj_ativo, isin_ativo, nome_ativo, nome_exibicao, quantidade, pu_posicao,
    valor_mercado, perc_pl_pct, retorno_dia_pct, retorno_mes_pct,
    retorno_ano_pct, retorno_12m_pct, pct_cdi, cdi_plus_dia_pct,
    cdi_plus_aa_pct, pct_cdi_mes, cdi_plus_mes_pct, cdi_plus_aa_mes_pct,
    pct_cdi_ano, cdi_plus_ano_pct, cdi_plus_aa_ano_pct, pct_cdi_12m,
    cdi_plus_12m_pct, cdi_plus_aa_12m_pct, is_fidc, base_dia_data,
    base_mes_data, base_ano_data, base_12m_data, calc_version,
    snapshot_created_at, snapshot_updated_at
  )
  SELECT
    p_data_posicao, p_fundo_key, p_fundo_cnpj, NULLIF(r.fundo_isin, ''),
    r.ativo_key, r.section, NULLIF(r.ativo_cnpjfundo, ''), NULLIF(r.ativo_isin, ''),
    NULLIF(r.cnpj_ativo, ''), NULLIF(r.isin_ativo, ''),
    NULLIF(r.nome_ativo, ''), r.nome_exibicao, r.quantidade, r.pu_posicao,
    r.valor_mercado, r.perc_pl_pct, r.retorno_dia_pct, r.retorno_mes_pct,
    r.retorno_ano_pct, r.retorno_12m_pct, r.pct_cdi, r.cdi_plus_dia_pct,
    r.cdi_plus_aa_pct, r.pct_cdi_mes, r.cdi_plus_mes_pct, r.cdi_plus_aa_mes_pct,
    r.pct_cdi_ano, r.cdi_plus_ano_pct, r.cdi_plus_aa_ano_pct, r.pct_cdi_12m,
    r.cdi_plus_12m_pct, r.cdi_plus_aa_12m_pct, COALESCE(r.is_fidc, false),
    r.base_dia_data, r.base_mes_data, r.base_ano_data, r.base_12m_data,
    COALESCE(NULLIF(trim(p_calc_version), ''), 'rentabilidade_snapshot_v2'), now(), now()
  FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb)) AS r(
    fundo_isin text, ativo_key text, section text, ativo_cnpjfundo text, ativo_isin text,
    cnpj_ativo text, isin_ativo text,
    nome_ativo text, nome_exibicao text, quantidade numeric, pu_posicao numeric,
    valor_mercado numeric, perc_pl_pct numeric, retorno_dia_pct numeric,
    retorno_mes_pct numeric, retorno_ano_pct numeric, retorno_12m_pct numeric,
    pct_cdi numeric, cdi_plus_dia_pct numeric, cdi_plus_aa_pct numeric,
    pct_cdi_mes numeric, cdi_plus_mes_pct numeric, cdi_plus_aa_mes_pct numeric,
    pct_cdi_ano numeric, cdi_plus_ano_pct numeric, cdi_plus_aa_ano_pct numeric,
    pct_cdi_12m numeric, cdi_plus_12m_pct numeric, cdi_plus_aa_12m_pct numeric,
    is_fidc boolean, base_dia_data date, base_mes_data date, base_ano_data date,
    base_12m_data date
  )
  WHERE COALESCE(trim(r.ativo_key), '') <> ''
    AND COALESCE(trim(r.section), '') <> ''
    AND COALESCE(trim(r.nome_exibicao), '') <> '';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_rentabilidade_snapshot_ativos_v2(date, text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_rentabilidade_snapshot_ativos_v2(date, text, text, jsonb, text) TO service_role;

NOTIFY pgrst, 'reload schema';
