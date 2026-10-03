-- ============================================================
-- Bloco 1 — Arquitetura e Banco: Carteira Finvest + Posição Consolidada
--
-- Objetivo: receber a "Carteira Diária" exportada pelo administrador
-- Finvest (CSV separado por ";", encoding latin-1) e consolidar com
-- a posição XML da posicao_carteira, enriquecendo com:
--   macro_categoria / subcategoria / categoria_detalhada (GrpN1/N2/N3)
--   nivel_granularidade: analitico | agregado | generico
--   fonte_origem: xml | csv_finvest | consolidado
--   status_consolidacao: ok | refinado_csv | flag_revisao | somente_csv | somente_xml
--
-- Tabelas:
--   1. importacoes_carteira_finvest  — log de cada upload
--   2. carteira_finvest_raw          — linhas brutas do CSV
--   3. posicao_consolidada           — posição enriquecida (fonte para os módulos)
--
-- View:
--   vw_posicao_consolidada_status   — resumo por fundo/data com cobertura
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. importacoes_carteira_finvest
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS importacoes_carteira_finvest (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL    DEFAULT NOW(),
  file_name       TEXT        NOT NULL,
  data_posicao    DATE,
  status          TEXT        NOT NULL    DEFAULT 'pending'
                  CONSTRAINT chk_cfimport_status
                    CHECK (status IN ('pending','success','partial_success','error')),
  total_rows      INTEGER     NOT NULL    DEFAULT 0,
  imported_rows   INTEGER     NOT NULL    DEFAULT 0,
  rejected_rows   INTEGER     NOT NULL    DEFAULT 0,
  fundos_cnpj     TEXT[],                 -- array dos CNPJs parciais encontrados
  fundos_nomes    TEXT[],                 -- array dos nomes dos fundos encontrados
  error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_cfimport_data
  ON importacoes_carteira_finvest(data_posicao);
CREATE INDEX IF NOT EXISTS idx_cfimport_status
  ON importacoes_carteira_finvest(status);

ALTER TABLE importacoes_carteira_finvest ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on importacoes_carteira_finvest"
  ON importacoes_carteira_finvest FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE importacoes_carteira_finvest IS
  'Log de cada upload da Carteira Diária Finvest. Uma linha por arquivo CSV importado.';

-- ─────────────────────────────────────────────────────────────
-- 2. carteira_finvest_raw
--    Linhas brutas do CSV mapeadas para campos nomeados.
--    Colunas baseadas no layout LayCrtDia da Finvest:
--      col[3]  = CodigoCrt  (CNPJ parcial 8 dígitos)
--      col[4]  = NomeCrt    (nome do fundo)
--      col[10] = DataEmis   (DD/MM/YYYY)
--      col[11] = Titulo     (código do ativo)
--      col[12] = Nome       (nome curto)
--      col[13] = Espec      (especificação)
--      col[16] = QtDisp     (quantidade disponível)
--      col[17] = PuCst      (PU custo)
--      col[18] = VlCst      (valor financeiro custo)
--      col[19] = PuMrc      (PU mercado)
--      col[20] = VlMrc      (valor financeiro mercado)
--      col[22] = DataVenc   (vencimento)
--      col[47] = GrpN1      (código macro — 10000=ATIVO, 20000=PASSIVO)
--      col[48] = NoGrpN1    (nome macro)
--      col[49] = GrpN2      (código subcategoria)
--      col[50] = NoGrpN2    (nome subcategoria)
--      col[51] = GrpN3      (código categoria detalhada)
--      col[52] = NoGrpN3    (nome categoria detalhada)
--      col[59] = ValorTotalAtv
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS carteira_finvest_raw (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id        UUID        NOT NULL
                   REFERENCES importacoes_carteira_finvest(id) ON DELETE CASCADE,
  fundo_cnpj       TEXT        NOT NULL,   -- CodigoCrt (8 dígitos parciais)
  fundo_nome       TEXT,                   -- NomeCrt
  data_posicao     DATE        NOT NULL,
  codigo_ativo     TEXT,                   -- Titulo
  nome_ativo       TEXT,                   -- Nome (curto)
  especificacao    TEXT,                   -- Espec
  quantidade       NUMERIC,                -- QtDisp
  pu_custo         NUMERIC,                -- PuCst
  valor_custo      NUMERIC,                -- VlCst
  pu_mercado       NUMERIC,                -- PuMrc
  valor_mercado    NUMERIC,                -- VlMrc
  data_vencimento  DATE,                   -- DataVenc
  valor_total_ativo NUMERIC,              -- ValorTotalAtv (PL de referência da linha)
  grp_n1_codigo    TEXT,                   -- GrpN1
  grp_n1_nome      TEXT,                   -- NoGrpN1
  grp_n2_codigo    TEXT,                   -- GrpN2
  grp_n2_nome      TEXT,                   -- NoGrpN2
  grp_n3_codigo    TEXT,                   -- GrpN3
  grp_n3_nome      TEXT,                   -- NoGrpN3
  moeda            TEXT,
  administrador    TEXT,
  tipo_fundo       TEXT,
  seq_linha        INTEGER                 -- número da linha no CSV original
);

CREATE INDEX IF NOT EXISTS idx_cfraw_import    ON carteira_finvest_raw(import_id);
CREATE INDEX IF NOT EXISTS idx_cfraw_fundo_dt  ON carteira_finvest_raw(fundo_cnpj, data_posicao);
CREATE INDEX IF NOT EXISTS idx_cfraw_grp2      ON carteira_finvest_raw(grp_n2_codigo);

ALTER TABLE carteira_finvest_raw ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on carteira_finvest_raw"
  ON carteira_finvest_raw FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE carteira_finvest_raw IS
  'Linhas brutas da Carteira Diária Finvest. Uma linha por ativo de cada fundo. '
  'Preserva todo o detalhe original do CSV sem transformação de valor ou classificação.';

-- ─────────────────────────────────────────────────────────────
-- 3. posicao_consolidada
--    Posição enriquecida para consumo pelos módulos de liquidez,
--    enquadramento e crédito. Mescla XML + Finvest com campos de
--    rastreabilidade de fonte e nível de granularidade.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posicao_consolidada (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identificação do fundo e data
  fundo_cnpj                 TEXT        NOT NULL,
  fundo_nome                 TEXT,
  data_posicao               DATE        NOT NULL,

  -- Identificação do ativo
  codigo_ativo               TEXT,
  nome_ativo                 TEXT,
  descricao_original         TEXT,       -- texto bruto da fonte de origem

  -- Classificação hierárquica Finvest (GrpN1 / GrpN2 / GrpN3)
  macro_categoria            TEXT,       -- NoGrpN1  (ex: ATIVO, PASSIVO)
  codigo_macro               TEXT,       -- GrpN1    (ex: 10000, 20000)
  subcategoria               TEXT,       -- NoGrpN2  (ex: COTAS DE FUNDO, IMÓVEIS)
  codigo_subcategoria        TEXT,       -- GrpN2    (ex: 10400, 10800)
  categoria_detalhada        TEXT,       -- NoGrpN3  (ex: Cotas Fundo RF Referenciado)
  codigo_categoria_detalhada TEXT,       -- GrpN3    (ex: 10407)

  -- Metadados de qualidade e consolidação
  nivel_granularidade        TEXT        NOT NULL DEFAULT 'generico'
                             CONSTRAINT chk_nivel_granularidade
                               CHECK (nivel_granularidade IN ('analitico','agregado','generico')),
  fonte_origem               TEXT        NOT NULL DEFAULT 'csv_finvest'
                             CONSTRAINT chk_fonte_origem
                               CHECK (fonte_origem IN ('xml','csv_finvest','consolidado')),
  status_consolidacao        TEXT        NOT NULL DEFAULT 'somente_csv'
                             CONSTRAINT chk_status_consolidacao
                               CHECK (status_consolidacao IN (
                                 'ok','refinado_csv','flag_revisao',
                                 'somente_csv','somente_xml'
                               )),

  -- Seção correspondente no XML posicao_carteira
  secao_xml                  TEXT,       -- ex: cotas, titpublico, caixa, imoveis, provisao

  -- CNPJ do ativo investido (quando for cota de fundo)
  cnpj_ativo                 TEXT,

  -- Valores financeiros
  quantidade                 NUMERIC,
  pu_custo                   NUMERIC,
  valor_custo                NUMERIC,
  pu_mercado                 NUMERIC,
  valor_mercado              NUMERIC,
  data_vencimento            DATE,

  -- Rastreabilidade
  import_id                  UUID        REFERENCES importacoes_carteira_finvest(id),
  raw_id                     UUID        REFERENCES carteira_finvest_raw(id),
  posicao_carteira_fundo_cnpj TEXT,      -- fundo_cnpj exato encontrado no XML
  posicao_carteira_count     INTEGER     DEFAULT 0,  -- qtd de linhas XML que casaram

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unicidade: mesmo fundo+data+ativo+grpN3 por import (usa COALESCE para lidar com NULL)
CREATE UNIQUE INDEX IF NOT EXISTS uq_pcons_fundo_dt_ativo
  ON posicao_consolidada (
    fundo_cnpj,
    data_posicao,
    import_id,
    COALESCE(codigo_ativo, '_'),
    COALESCE(codigo_categoria_detalhada, '_')
  );

CREATE INDEX IF NOT EXISTS idx_pcons_fundo_dt
  ON posicao_consolidada(fundo_cnpj, data_posicao);
CREATE INDEX IF NOT EXISTS idx_pcons_status
  ON posicao_consolidada(status_consolidacao);
CREATE INDEX IF NOT EXISTS idx_pcons_nivel
  ON posicao_consolidada(nivel_granularidade);
CREATE INDEX IF NOT EXISTS idx_pcons_secao
  ON posicao_consolidada(secao_xml);
CREATE INDEX IF NOT EXISTS idx_pcons_import
  ON posicao_consolidada(import_id);

ALTER TABLE posicao_consolidada ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on posicao_consolidada"
  ON posicao_consolidada FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE posicao_consolidada IS
  'Posição enriquecida consolidando XML (posicao_carteira) e Finvest CSV. '
  'Fonte primária para os módulos de liquidez, enquadramento e crédito quando CSV disponível.';

COMMENT ON COLUMN posicao_consolidada.nivel_granularidade IS
  'analitico = item específico identificável (ex: CF XXXXX com CNPJ); '
  'agregado = categoria identificada mas sem item individualizado; '
  'generico = classificação ampla tipo "Outros Valores a Receber".';

COMMENT ON COLUMN posicao_consolidada.status_consolidacao IS
  'ok = mesmo item encontrado no XML com granularidade equivalente; '
  'refinado_csv = XML tem item genérico, CSV traz classificação analítica; '
  'flag_revisao = divergência material de valor entre XML e CSV (>5%); '
  'somente_csv = item existe no CSV mas não no XML para este fundo/data; '
  'somente_xml = item existe no XML mas não enviado pelo CSV.';

COMMENT ON COLUMN posicao_consolidada.secao_xml IS
  'Mapeamento do GrpN2 Finvest para a section de posicao_carteira: '
  '10100→caixa, 10400→cotas, 10800→imoveis, 19500→provisao, 22000→despesas, 23000→provisao.';

-- ─────────────────────────────────────────────────────────────
-- View: vw_posicao_consolidada_status
-- Resumo de cobertura por fundo e data — útil para monitoramento
-- ─────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS vw_posicao_consolidada_status;
CREATE OR REPLACE VIEW vw_posicao_consolidada_status AS
SELECT
  p.fundo_cnpj,
  p.fundo_nome,
  p.data_posicao,
  i.file_name                                           AS arquivo_origem,
  COUNT(*)                                              AS total_itens,
  COUNT(*) FILTER (WHERE p.nivel_granularidade = 'analitico')   AS itens_analiticos,
  COUNT(*) FILTER (WHERE p.nivel_granularidade = 'agregado')    AS itens_agregados,
  COUNT(*) FILTER (WHERE p.nivel_granularidade = 'generico')    AS itens_genericos,
  COUNT(*) FILTER (WHERE p.status_consolidacao = 'ok')          AS consolidados_ok,
  COUNT(*) FILTER (WHERE p.status_consolidacao = 'refinado_csv') AS refinados_csv,
  COUNT(*) FILTER (WHERE p.status_consolidacao = 'flag_revisao') AS flags_revisao,
  COUNT(*) FILTER (WHERE p.status_consolidacao = 'somente_csv') AS somente_csv,
  SUM(p.valor_mercado)                                  AS valor_total_mercado,
  MIN(p.created_at)                                     AS primeira_importacao,
  MAX(p.updated_at)                                     AS ultima_atualizacao
FROM posicao_consolidada p
LEFT JOIN importacoes_carteira_finvest i ON i.id = p.import_id
GROUP BY p.fundo_cnpj, p.fundo_nome, p.data_posicao, i.file_name
ORDER BY p.data_posicao DESC, p.fundo_cnpj;

COMMENT ON VIEW vw_posicao_consolidada_status IS
  'Resumo de cobertura da posição consolidada por fundo e data. '
  'Mostra distribuição por nível de granularidade e status de consolidação.';

GRANT SELECT ON vw_posicao_consolidada_status TO anon, authenticated, service_role;
