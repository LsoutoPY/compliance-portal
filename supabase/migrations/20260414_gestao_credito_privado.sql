-- =============================================================
-- Módulo: Gestão de Crédito Privado — P1 Aquisição / P4 Monitoramento / P5 Desenquadramentos
-- Projeto: Frame Control Center — CVPAR Quadrante
-- =============================================================

-- =============================================================
-- 1. ATIVOS_CREDITO — Cardápio mestre de ativos aprovados
-- =============================================================
CREATE TABLE IF NOT EXISTS ativos_credito (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome                TEXT NOT NULL,
  cnpj_emissor        TEXT,
  tipo_ativo          TEXT NOT NULL
    CHECK (tipo_ativo IN ('IF', 'CORPORATIVO', 'ESTRUTURADO')),
  tipo_instrumento    TEXT,
  rating_externo      TEXT,
  agencia_rating      TEXT,
  data_emissao        DATE,
  data_vencimento     DATE,
  limite_percentual   NUMERIC(5,2),
  prazo_revisao_dias  INTEGER DEFAULT 365,
  status              TEXT NOT NULL DEFAULT 'ATIVO'
    CHECK (status IN ('ATIVO', 'EM_ANALISE', 'SUSPENSO', 'ENCERRADO')),
  observacoes         TEXT,
  criado_em           TIMESTAMPTZ DEFAULT now(),
  atualizado_em       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ativos_credito_tipo_ativo ON ativos_credito(tipo_ativo);
CREATE INDEX IF NOT EXISTS idx_ativos_credito_status ON ativos_credito(status);
CREATE INDEX IF NOT EXISTS idx_ativos_credito_cnpj ON ativos_credito(cnpj_emissor);

-- =============================================================
-- 2. ANALISES_CREDITO — Relatórios de P1 (aquisição) e P4 (monitoramento)
-- =============================================================
CREATE TABLE IF NOT EXISTS analises_credito (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ativo_id                 UUID REFERENCES ativos_credito(id),
  tipo_analise             TEXT NOT NULL
    CHECK (tipo_analise IN ('AQUISICAO', 'MONITORAMENTO')),
  tipo_ativo               TEXT NOT NULL
    CHECK (tipo_ativo IN ('IF', 'CORPORATIVO', 'ESTRUTURADO')),
  analista                 TEXT,
  data_analise             DATE NOT NULL DEFAULT CURRENT_DATE,
  recomendacao             TEXT NOT NULL
    CHECK (recomendacao IN ('COMPRAR','MANTER','VENDER','APROVAR','NAO_APROVAR')),
  -- Campos comuns
  breve_historico          TEXT,
  analise_esg              TEXT,
  risco_operacao           TEXT,
  observacoes              TEXT,
  -- Campos exclusivos IF (CAMELS)
  if_sumario_financeiro    JSONB,
  if_estrutura_capital     TEXT,
  if_qualidade_carteira    TEXT,
  if_rentabilidade         TEXT,
  if_liquidez              TEXT,
  -- Campos exclusivos Corporativo (Fitch)
  corp_risco_negocio       TEXT,
  corp_risco_financeiro    TEXT,
  corp_risco_refinanciamento TEXT,
  corp_covenants           TEXT,
  -- Campos exclusivos Estruturado (Fitch Trade Receivables)
  estr_estrutura_operacao  TEXT,
  estr_risco_carteira      TEXT,
  estr_risco_subordinacao  TEXT,
  estr_risco_originador    TEXT,
  estr_triggers            TEXT,
  criado_em                TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analises_credito_ativo ON analises_credito(ativo_id);
CREATE INDEX IF NOT EXISTS idx_analises_credito_tipo ON analises_credito(tipo_analise);
CREATE INDEX IF NOT EXISTS idx_analises_credito_data ON analises_credito(data_analise DESC);

-- =============================================================
-- 3. COMITE_CREDITO_ATAS — Deliberações do Comitê de Crédito
-- =============================================================
CREATE TABLE IF NOT EXISTS comite_credito_atas (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analise_id          UUID REFERENCES analises_credito(id),
  ativo_id            UUID REFERENCES ativos_credito(id),
  data_comite         DATE NOT NULL DEFAULT CURRENT_DATE,
  decisao             TEXT NOT NULL
    CHECK (decisao IN ('APROVADO','NAO_APROVADO','VENDA_AUTORIZADA','MONITORAR')),
  limite_aprovado_pct NUMERIC(5,2),
  prazo_revisao_dias  INTEGER,
  participantes       TEXT[],
  observacoes         TEXT,
  enviado_compliance  BOOLEAN DEFAULT false,
  criado_em           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_comite_atas_analise ON comite_credito_atas(analise_id);
CREATE INDEX IF NOT EXISTS idx_comite_atas_ativo ON comite_credito_atas(ativo_id);
CREATE INDEX IF NOT EXISTS idx_comite_atas_data ON comite_credito_atas(data_comite DESC);

-- =============================================================
-- 4. MONITORAMENTO_AGENDA — Calendário P4
-- =============================================================
CREATE TABLE IF NOT EXISTS monitoramento_agenda (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ativo_id             UUID REFERENCES ativos_credito(id),
  data_proxima_revisao DATE NOT NULL,
  status               TEXT NOT NULL DEFAULT 'PENDENTE'
    CHECK (status IN ('PENDENTE','EM_ANDAMENTO','CONCLUIDO')),
  tipo_gatilho         TEXT NOT NULL DEFAULT 'PERIODICO'
    CHECK (tipo_gatilho IN ('PERIODICO','EVENTO_RELEVANTE','MANUAL')),
  descricao_evento     TEXT,
  criado_em            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_monitoramento_agenda_ativo ON monitoramento_agenda(ativo_id);
CREATE INDEX IF NOT EXISTS idx_monitoramento_agenda_data ON monitoramento_agenda(data_proxima_revisao);
CREATE INDEX IF NOT EXISTS idx_monitoramento_agenda_status ON monitoramento_agenda(status);

-- =============================================================
-- 5. DESENQUADRAMENTOS — Registro P5
-- =============================================================
CREATE TABLE IF NOT EXISTS desenquadramentos (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fundo_cnpj                      TEXT NOT NULL,
  fundo_nome                      TEXT,
  ativo_id                        UUID REFERENCES ativos_credito(id),
  tipo_desenquadramento           TEXT NOT NULL
    CHECK (tipo_desenquadramento IN ('PRECO','CONCENTRACAO','LIMITE_POLITICA','SUITABILITY')),
  data_identificacao              DATE NOT NULL DEFAULT CURRENT_DATE,
  descricao                       TEXT NOT NULL,
  valor_exposto                   NUMERIC(18,2),
  status                          TEXT NOT NULL DEFAULT 'ABERTO'
    CHECK (status IN ('ABERTO','EM_REENQUADRAMENTO','REENQUADRADO','JUSTIFICADO')),
  plano_acao                      TEXT,
  data_prevista_reenquadramento   DATE,
  data_efetiva_reenquadramento    DATE,
  mercado_secundario_disponivel   BOOLEAN,
  informado_risco                 BOOLEAN DEFAULT false,
  informado_compliance            BOOLEAN DEFAULT false,
  criado_em                       TIMESTAMPTZ DEFAULT now(),
  atualizado_em                   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_desenquadramentos_fundo ON desenquadramentos(fundo_cnpj);
CREATE INDEX IF NOT EXISTS idx_desenquadramentos_status ON desenquadramentos(status);
CREATE INDEX IF NOT EXISTS idx_desenquadramentos_data ON desenquadramentos(data_identificacao DESC);

-- =============================================================
-- RLS
-- =============================================================
ALTER TABLE ativos_credito          ENABLE ROW LEVEL SECURITY;
ALTER TABLE analises_credito        ENABLE ROW LEVEL SECURITY;
ALTER TABLE comite_credito_atas     ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoramento_agenda    ENABLE ROW LEVEL SECURITY;
ALTER TABLE desenquadramentos       ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_full" ON ativos_credito
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "auth_full" ON analises_credito
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "auth_full" ON comite_credito_atas
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "auth_full" ON monitoramento_agenda
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "auth_full" ON desenquadramentos
  FOR ALL USING (auth.role() = 'authenticated');
