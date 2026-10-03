-- Migration: Create passivo_cotista_de_para table
-- Description: Cadastro mestre de cotistas para padronização do passivo.
-- Colunas: Nº (código interno), Nome Clt., CPF/CNPJ, Conta XP, Conta BTG, Status
-- Usado para match: nome, conta XP (ex: P/C497092), conta BTG

CREATE TABLE IF NOT EXISTS passivo_cotista_de_para (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_cliente INTEGER NOT NULL,
  nome_cliente TEXT,
  cpf_cnpj TEXT,
  conta_xp TEXT,
  conta_btg TEXT,
  status TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT passivo_cotista_de_para_codigo_unique UNIQUE (codigo_cliente)
);

-- Índices para match rápido (Conta XP e BTG são os mais usados para P/C)
CREATE INDEX IF NOT EXISTS idx_passivo_cotista_de_para_conta_xp ON passivo_cotista_de_para(conta_xp) WHERE conta_xp IS NOT NULL AND conta_xp != '';
CREATE INDEX IF NOT EXISTS idx_passivo_cotista_de_para_conta_btg ON passivo_cotista_de_para(conta_btg) WHERE conta_btg IS NOT NULL AND conta_btg != '';
CREATE INDEX IF NOT EXISTS idx_passivo_cotista_de_para_nome ON passivo_cotista_de_para(nome_cliente) WHERE nome_cliente IS NOT NULL AND nome_cliente != '';

-- Adicionar coluna codigo_clt em passivo_fundos (código do cliente do De-Para)
ALTER TABLE passivo_fundos ADD COLUMN IF NOT EXISTS codigo_clt INTEGER;

CREATE INDEX IF NOT EXISTS idx_passivo_fundos_codigo_clt ON passivo_fundos(codigo_clt) WHERE codigo_clt IS NOT NULL;

-- RLS
ALTER TABLE passivo_cotista_de_para ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on passivo_cotista_de_para"
  ON passivo_cotista_de_para
  FOR ALL
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE passivo_cotista_de_para IS 'Cadastro mestre de cotistas para padronização do passivo (De-Para). Match por Nome, Conta XP (P/C), Conta BTG.';
COMMENT ON COLUMN passivo_cotista_de_para.codigo_cliente IS 'Nº - Código interno do cliente (chave final)';
COMMENT ON COLUMN passivo_cotista_de_para.conta_xp IS 'Número da conta XP (ex: 497092, sem P/C)';
COMMENT ON COLUMN passivo_cotista_de_para.conta_btg IS 'Número da conta BTG';
COMMENT ON COLUMN passivo_fundos.codigo_clt IS 'Código do cliente (Nº) do De-Para após match';
