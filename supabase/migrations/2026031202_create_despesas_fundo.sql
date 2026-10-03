-- ──────────────────────────────────────────────────────────────────────────────
-- Tabela: despesas_fundo
-- Armazena lançamentos de despesas operacionais de fundos, importados a partir
-- de relatórios dos custodiantes/administradores (Intrag/Itaú, BTG, CVPAR).
-- Suporta três formatos de origem:
--   • intrag_xls  — Relatório Mensal de Despesas (Itaú/Intrag), XLS
--   • btg_xlsx    — Extrato de Caixa BTG, XLSX
--   • cvpar_csv   — Extrato de Caixa CVPAR, CSV
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.despesas_fundo (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificação do fundo
  fundo_cnpj           TEXT,          -- ex: "34.218.601/0001-97" (BTG)
  fundo_codigo         TEXT,          -- ex: "INTRAG54022"        (Intrag)
  fundo_nome           TEXT NOT NULL, -- nome do fundo

  -- Dimensão temporal
  data_lancamento      DATE NOT NULL, -- data exata (BTG/CSV) ou 1º dia do mês (Intrag)
  mes_ano              TEXT NOT NULL, -- "MM/YYYY" — chave de agrupamento mensal

  -- Lançamento
  descricao_lancamento TEXT NOT NULL,
  tipo_lancamento      TEXT,          -- código numérico Intrag (041, 603, 156 …)
  valor                NUMERIC NOT NULL, -- sempre negativo = despesa; positivo = receita/estorno
  categoria_despesa    TEXT,          -- taxa_administracao | taxa_gestao | taxa_custodia |
                                      -- taxa_anbima | taxa_cetip | taxa_selic | tarifa_banco |
                                      -- outros_custos | receita | estorno | operacao_titulo

  -- Rastreabilidade
  fonte                TEXT NOT NULL, -- intrag_xls | btg_xlsx | cvpar_csv
  arquivo_nome         TEXT NOT NULL,

  -- Chave natural para upsert (evita duplicatas em reimportações)
  natural_key          TEXT UNIQUE NOT NULL,

  created_at           TIMESTAMPTZ  DEFAULT now(),
  updated_at           TIMESTAMPTZ  DEFAULT now()
);

-- Índices para as consultas mais frequentes
CREATE INDEX IF NOT EXISTS idx_despesas_fundo_cnpj     ON public.despesas_fundo (fundo_cnpj);
CREATE INDEX IF NOT EXISTS idx_despesas_fundo_codigo   ON public.despesas_fundo (fundo_codigo);
CREATE INDEX IF NOT EXISTS idx_despesas_fundo_mes_ano  ON public.despesas_fundo (mes_ano);
CREATE INDEX IF NOT EXISTS idx_despesas_fundo_cat      ON public.despesas_fundo (categoria_despesa);
CREATE INDEX IF NOT EXISTS idx_despesas_fundo_fonte    ON public.despesas_fundo (fonte);

-- Comentários
COMMENT ON TABLE  public.despesas_fundo IS
  'Lançamentos de despesas operacionais de fundos importados dos custodiantes.';
COMMENT ON COLUMN public.despesas_fundo.categoria_despesa IS
  'taxa_administracao | taxa_gestao | taxa_custodia | taxa_anbima | taxa_cetip | taxa_selic | tarifa_banco | outros_custos | receita | estorno | operacao_titulo';
COMMENT ON COLUMN public.despesas_fundo.natural_key IS
  'Hash determinístico: fonte + fundo + data + descricao + valor. Usado para upsert idempotente.';

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.set_despesas_fundo_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_despesas_fundo_updated_at ON public.despesas_fundo;
CREATE TRIGGER trg_despesas_fundo_updated_at
  BEFORE UPDATE ON public.despesas_fundo
  FOR EACH ROW EXECUTE FUNCTION public.set_despesas_fundo_updated_at();

-- View: resumo mensal por fundo — útil para alimentar despesa_operacional_mensal
CREATE OR REPLACE VIEW public.despesas_fundo_resumo_mensal AS
SELECT
  fundo_cnpj,
  fundo_codigo,
  fundo_nome,
  mes_ano,
  -- total de despesas (valor < 0) como positivo
  ABS(SUM(CASE WHEN valor < 0 THEN valor ELSE 0 END)) AS total_despesas,
  -- total de receitas/estornos (valor > 0)
  SUM(CASE WHEN valor > 0 THEN valor ELSE 0 END)       AS total_receitas,
  -- despesa líquida operacional
  ABS(SUM(valor))                                       AS despesa_liquida,
  COUNT(*)                                              AS qtd_lancamentos,
  -- breakdown por categoria
  ABS(SUM(CASE WHEN categoria_despesa = 'taxa_administracao' THEN valor ELSE 0 END)) AS taxa_administracao,
  ABS(SUM(CASE WHEN categoria_despesa = 'taxa_gestao'        THEN valor ELSE 0 END)) AS taxa_gestao,
  ABS(SUM(CASE WHEN categoria_despesa = 'taxa_custodia'      THEN valor ELSE 0 END)) AS taxa_custodia,
  ABS(SUM(CASE WHEN categoria_despesa = 'taxa_anbima'        THEN valor ELSE 0 END)) AS taxa_anbima,
  ABS(SUM(CASE WHEN categoria_despesa = 'taxa_cetip'         THEN valor ELSE 0 END)) AS taxa_cetip,
  ABS(SUM(CASE WHEN categoria_despesa = 'taxa_selic'         THEN valor ELSE 0 END)) AS taxa_selic,
  ABS(SUM(CASE WHEN categoria_despesa = 'tarifa_banco'       THEN valor ELSE 0 END)) AS tarifa_banco
FROM public.despesas_fundo
GROUP BY fundo_cnpj, fundo_codigo, fundo_nome, mes_ano;
