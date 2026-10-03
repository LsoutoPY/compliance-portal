-- Inclui tipo de ativo COTA_FUNDO (cota de fundo) nas tabelas de gestão de crédito privado

ALTER TABLE ativos_credito DROP CONSTRAINT IF EXISTS ativos_credito_tipo_ativo_check;
ALTER TABLE ativos_credito ADD CONSTRAINT ativos_credito_tipo_ativo_check
  CHECK (tipo_ativo IN ('IF', 'CORPORATIVO', 'ESTRUTURADO', 'COTA_FUNDO'));

ALTER TABLE analises_credito DROP CONSTRAINT IF EXISTS analises_credito_tipo_ativo_check;
ALTER TABLE analises_credito ADD CONSTRAINT analises_credito_tipo_ativo_check
  CHECK (tipo_ativo IN ('IF', 'CORPORATIVO', 'ESTRUTURADO', 'COTA_FUNDO'));
