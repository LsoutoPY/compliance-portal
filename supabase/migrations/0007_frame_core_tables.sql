-- =============================================================
-- Baseline das tabelas do Frame que preexistem às migrations
-- timestampadas (posicao_carteira, ativos, fundos_caracteristicas).
-- regras_compliance/fundo_regras entram aqui porque o seed 20250213
-- roda antes da migration 20260213 que as criaria.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ativos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_ativo text NOT NULL,
  descricao text,
  isin text,
  cnpj text,
  ticker text,
  codigo_cetip_selic text,
  matricula_imovel text,
  endereco_imovel text,
  validado boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ativos_cnpj ON public.ativos (cnpj);
CREATE INDEX IF NOT EXISTS idx_ativos_isin ON public.ativos (isin);
CREATE INDEX IF NOT EXISTS idx_ativos_tipo ON public.ativos (tipo_ativo);
CREATE INDEX IF NOT EXISTS idx_ativos_ticker ON public.ativos (ticker);

COMMENT ON TABLE public.ativos IS
  'Cardápio de ativos (cadastro único). Criada no portal porque o Frame não tem CREATE TABLE histórico.';

CREATE TABLE IF NOT EXISTS public.posicao_carteira (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  natural_key text NOT NULL,
  arquivo_nome text,
  section text NOT NULL,
  possui_compromisso boolean DEFAULT false,
  fundo_isin text,
  fundo_cnpj text NOT NULL,
  fundo_nome text,
  nome_fundo text,
  fundo_dtposicao text,
  fundo_nomeadm text,
  fundo_cnpjadm text,
  fundo_nomegestor text,
  fundo_cnpjgestor text,
  fundo_nomecustodiante text,
  fundo_cnpjcustodiante text,
  fundo_valorcota numeric,
  fundo_quantidade numeric,
  fundo_patliq numeric,
  fundo_valorativos numeric,
  fundo_valorreceber numeric,
  fundo_valorpagar numeric,
  fundo_vlcotasemitir numeric,
  fundo_vlcotasresgatar numeric,
  fundo_codanbid text,
  fundo_tipofundo text,
  fundo_nivelrsc text,
  isin text,
  codativo text,
  cusip text,
  cnpjfundo text,
  cnpjemissor text,
  cnpjpart text,
  idinternoativo text,
  dtemissao text,
  dtoperacao text,
  dtvencimento text,
  qtdisponivel numeric,
  qtgarantia numeric,
  pucompra numeric,
  puposicao numeric,
  puvencimento numeric,
  puemissao numeric,
  principal numeric,
  valorfindisp numeric,
  valorfinemgar numeric,
  tributos numeric,
  valorfinanceiro numeric,
  indexador text,
  percindex numeric,
  coupom numeric,
  caracteristica text,
  classeoperacao text,
  depgar text,
  percprovcred numeric,
  nivelrsc text,
  compromisso_dtretorno text,
  compromisso_puretorno numeric,
  compromisso_indexadorcomp text,
  compromisso_perindexcomp numeric,
  compromisso_txoperacao numeric,
  compromisso_classecomp text,
  isininstituicao text,
  tpconta text,
  saldo numeric,
  txadm numeric,
  perctaxaadm numeric,
  txperf text,
  vltxperf numeric,
  perctxperf numeric,
  outtax numeric,
  codprov text,
  credeb text,
  dt text,
  valor numeric,
  nivel1_categoria text,
  valor_padrao numeric,
  logradouro text,
  numero text,
  complemento text,
  cidade text,
  estado text,
  cep text,
  nomecomercial text,
  percpart numeric,
  valorcontabil numeric,
  justificativa text,
  valoravaliacao numeric,
  tpavaliador text,
  cnpjcpfavaliador text,
  aluguelcontratado numeric,
  aluguelatrasado numeric,
  opcaorecompra text,
  dtopcaorecompra text,
  tipoimovel text,
  questjur text,
  motivoquestjur text,
  tipouso text,
  matricula text,
  cnpjemp text,
  ativo_id uuid REFERENCES public.ativos(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT posicao_carteira_natural_key_key UNIQUE (natural_key)
);

CREATE INDEX IF NOT EXISTS idx_posicao_carteira_fundo_dt
  ON public.posicao_carteira (fundo_cnpj, fundo_dtposicao);
CREATE INDEX IF NOT EXISTS idx_posicao_carteira_dt
  ON public.posicao_carteira (fundo_dtposicao);
CREATE INDEX IF NOT EXISTS idx_posicao_carteira_section
  ON public.posicao_carteira (section);
CREATE INDEX IF NOT EXISTS idx_posicao_carteira_ativo_id
  ON public.posicao_carteira (ativo_id);
CREATE INDEX IF NOT EXISTS idx_posicao_carteira_isin
  ON public.posicao_carteira (isin);
CREATE INDEX IF NOT EXISTS idx_posicao_carteira_cnpjfundo
  ON public.posicao_carteira (cnpjfundo);

COMMENT ON TABLE public.posicao_carteira IS
  'Posição XML ANBIMA por fundo/data. natural_key é a chave de upsert do import-xml.';

CREATE TABLE IF NOT EXISTS public.fundos_caracteristicas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_anbima text,
  estrutura text,
  nome_comercial text,
  cnpj_classe text NOT NULL,
  cnpj_fundo text,
  status text,
  data_inicio_atividade date,
  quantidade_subclasses integer,
  categoria_anbima text,
  tipo_anbima text,
  composicao_fundo text,
  aberto_estatutariamente text,
  fundo_esg text,
  tributacao_alvo text,
  administrador text,
  gestor_principal text,
  primeiro_aporte date,
  tipo_investidor text,
  caracteristica_investidor text,
  cota_abertura text,
  aplicacao_inicial_minima numeric,
  prazo_pagamento_resgate_dias numeric,
  adaptado_175 text,
  codigo_cvm_subclasse text,
  foco_atuacao text,
  nivel1_categoria text,
  nivel2_categoria text,
  nivel3_subcategoria text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fundos_caracteristicas_cnpj_classe
  ON public.fundos_caracteristicas (cnpj_classe);
CREATE INDEX IF NOT EXISTS idx_fundos_caracteristicas_cnpj_fundo
  ON public.fundos_caracteristicas (cnpj_fundo);
CREATE INDEX IF NOT EXISTS idx_fundos_caracteristicas_nivel1
  ON public.fundos_caracteristicas (nivel1_categoria);

COMMENT ON TABLE public.fundos_caracteristicas IS
  'Cardápio ANBIMA de fundos (planilha de características). Colunas posteriores entram nas migrations 2026*.';

CREATE TABLE IF NOT EXISTS public.regras_compliance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo text NOT NULL UNIQUE,
  descricao text NOT NULL,
  parametros jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.fundo_regras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fundo_cnpj text NOT NULL,
  regra_id uuid NOT NULL REFERENCES public.regras_compliance(id),
  ativo boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (fundo_cnpj, regra_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ativos TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.posicao_carteira TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fundos_caracteristicas TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.regras_compliance TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fundo_regras TO anon, authenticated;
