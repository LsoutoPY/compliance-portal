-- DROP TABLE IF EXISTS anbima_cod_lancamento;

CREATE TABLE IF NOT EXISTS anbima_cod_lancamento (
  cod_lancamento  VARCHAR(4)   NOT NULL,
  descricao       VARCHAR(255) NOT NULL,
  deb_cred        VARCHAR(3)   NOT NULL,
  grupo           VARCHAR(50)  NOT NULL,
  aceita_debito   BOOLEAN      NOT NULL,
  aceita_credito  BOOLEAN      NOT NULL,
  criado_em       TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT anbima_cod_lancamento_pkey PRIMARY KEY (cod_lancamento),
  CONSTRAINT anbima_cod_lancamento_deb_cred_check CHECK (deb_cred IN ('D', 'C', 'D/C'))
);

CREATE INDEX IF NOT EXISTS idx_anbima_cod_lancamento_grupo
  ON anbima_cod_lancamento (grupo);

INSERT INTO anbima_cod_lancamento
  (cod_lancamento, descricao, deb_cred, grupo, aceita_debito, aceita_credito)
VALUES
  ('1',   'Advogados',                                          'D',   'Despesas Administrativas', true,  false),
  ('2',   'Auditoria',                                          'D',   'Despesas Administrativas', true,  false),
  ('3',   'Bancárias',                                          'D',   'Despesas Administrativas', true,  false),
  ('4',   'Cartório',                                           'D',   'Despesas Administrativas', true,  false),
  ('5',   'Correspondências',                                   'D',   'Despesas Administrativas', true,  false),
  ('6',   'Impressos',                                          'D',   'Despesas Administrativas', true,  false),
  ('7',   'Jurídicas',                                          'D',   'Despesas Administrativas', true,  false),
  ('8',   'Outras Despesas Administrativas',                    'D',   'Despesas Administrativas', true,  false),
  ('9',   'Outras Despesas Exterior',                           'D',   'Despesas Administrativas', true,  false),
  ('10',  'Publicação de Atas',                                 'D',   'Despesas Administrativas', true,  false),
  ('11',  'Publicidade',                                        'D',   'Despesas Administrativas', true,  false),
  ('12',  'Taxa ANBIMA',                                        'D',   'Taxas Regulatórias',       true,  false),
  ('13',  'Taxa CETIP',                                         'D',   'Taxas Regulatórias',       true,  false),
  ('14',  'Taxa CVM',                                           'D',   'Taxas Regulatórias',       true,  false),
  ('15',  'Taxa Custódia',                                      'D',   'Taxas Regulatórias',       true,  false),
  ('16',  'Taxa SELIC',                                         'D',   'Taxas Regulatórias',       true,  false),
  ('17',  'Taxa SISBACEN',                                      'D',   'Taxas Regulatórias',       true,  false),
  ('18',  'Títulos Públicos',                                   'D/C', 'Provisões / Operações',    true,  true),
  ('19',  'Títulos Privados',                                   'D/C', 'Provisões / Operações',    true,  true),
  ('20',  'Debêntures',                                         'D/C', 'Provisões / Operações',    true,  true),
  ('21',  'Ações ou Opções de Ações',                          'D/C', 'Provisões / Operações',    true,  true),
  ('22',  'Derivativos (Opções Deriv., Flexíveis ou Futuros)', 'D/C', 'Provisões / Operações',    true,  true),
  ('23',  'Termo Ações',                                        'D/C', 'Provisões / Operações',    true,  true),
  ('24',  'Termo SELIC',                                        'D/C', 'Provisões / Operações',    true,  true),
  ('26',  'Swap',                                               'D/C', 'Provisões / Operações',    true,  true),
  ('27',  'Dividendos',                                         'C',   'Receitas / Créditos',      false, true),
  ('28',  'Juros sobre Capital Próprio',                        'C',   'Receitas / Créditos',      false, true),
  ('29',  'Subscrições',                                        'D',   'Receitas / Créditos',      true,  false),
  ('30',  'Juros (Renda Fixa)',                                 'C',   'Receitas / Créditos',      false, true),
  ('31',  'Empréstimo de Ação (Aluguel)',                       'D/C', 'Provisões / Operações',    true,  true),
  ('32',  'Empréstimo Título Público',                          'D/C', 'Provisões / Operações',    true,  true),
  ('33',  'Aluguel Imóvel',                                     'C',   'Receitas / Créditos',      false, true),
  ('34',  'Taxa de Administração',                              'D',   'Taxas do Fundo',           true,  false),
  ('35',  'Taxa de Performance',                                'D',   'Taxas do Fundo',           true,  false),
  ('36',  'Despesa Corretagem BOVESPA',                         'D',   'Corretagem',               true,  false),
  ('37',  'Despesa Corretagem BM&F',                            'D',   'Corretagem',               true,  false),
  ('38',  'Emolumentos',                                        'D',   'Corretagem',               true,  false),
  ('39',  'Valor BOVESPA',                                      'D',   'Corretagem',               true,  false),
  ('40',  'Valor Repasse BOVESPA',                              'D',   'Corretagem',               true,  false),
  ('41',  'Valor BM&F',                                         'D',   'Corretagem',               true,  false),
  ('42',  'Valor Repasse BM&F',                                 'D',   'Corretagem',               true,  false),
  ('43',  'Valor Outras Bolsas',                                'D',   'Corretagem',               true,  false),
  ('44',  'Valor Repasse Outras Bolsas',                        'D',   'Corretagem',               true,  false),
  ('45',  'Aplicação a Converter',                              'C',   'Movimentação de Cotas',    false, true),
  ('46',  'Resgate a Converter',                                'D',   'Movimentação de Cotas',    true,  false),
  ('47',  'Resgate a Liquidar',                                 'C',   'Movimentação de Cotas',    false, true),
  ('999', 'Outros',                                             'D/C', 'Outros',                   true,  true)
ON CONFLICT (cod_lancamento) DO NOTHING;

-- Permitir leitura para usuários autenticados (e anon se necessário)
ALTER TABLE anbima_cod_lancamento ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anbima_cod_lancamento_select" ON anbima_cod_lancamento;
CREATE POLICY "anbima_cod_lancamento_select"
  ON anbima_cod_lancamento
  FOR SELECT
  USING (true);

SELECT count(*) AS total_registros FROM anbima_cod_lancamento;
