-- Tabela para controle de envios do relatório diário de rentabilidade
CREATE TABLE IF NOT EXISTS envios_relatorio_rentabilidade (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data_referencia DATE NOT NULL,
  destinatarios TEXT[] NOT NULL,
  enviado_por UUID REFERENCES auth.users(id),
  email_id TEXT, -- ID retornado pelo serviço de e-mail (Resend)
  status TEXT NOT NULL DEFAULT 'enviado', -- enviado, erro, agendado
  erro_mensagem TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices
CREATE INDEX idx_envios_relatorio_rentabilidade_data ON envios_relatorio_rentabilidade(data_referencia DESC);
CREATE INDEX idx_envios_relatorio_rentabilidade_enviado_por ON envios_relatorio_rentabilidade(enviado_por);
CREATE INDEX idx_envios_relatorio_rentabilidade_status ON envios_relatorio_rentabilidade(status);

-- RLS policies
ALTER TABLE envios_relatorio_rentabilidade ENABLE ROW LEVEL SECURITY;

-- Permitir leitura para usuários autenticados
CREATE POLICY "Usuários autenticados podem visualizar envios"
  ON envios_relatorio_rentabilidade
  FOR SELECT
  TO authenticated
  USING (true);

-- Permitir inserção para usuários autenticados (via edge function)
CREATE POLICY "Serviço pode inserir envios"
  ON envios_relatorio_rentabilidade
  FOR INSERT
  TO service_role
  WITH CHECK (true);

-- Comentários
COMMENT ON TABLE envios_relatorio_rentabilidade IS 'Registro de envios do relatório diário de rentabilidade por e-mail';
COMMENT ON COLUMN envios_relatorio_rentabilidade.data_referencia IS 'Data de referência dos dados do relatório';
COMMENT ON COLUMN envios_relatorio_rentabilidade.destinatarios IS 'Lista de e-mails destinatários';
COMMENT ON COLUMN envios_relatorio_rentabilidade.enviado_por IS 'Usuário que solicitou o envio';
COMMENT ON COLUMN envios_relatorio_rentabilidade.email_id IS 'ID do e-mail retornado pelo provedor (Resend)';
COMMENT ON COLUMN envios_relatorio_rentabilidade.status IS 'Status do envio: enviado, erro, agendado';
