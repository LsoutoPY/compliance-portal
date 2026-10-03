-- Envio automático do Relatório de Rentabilidade (10h e 19h BRT) com deduplicação.
--
-- Regra de negócio: o envio automático (origem='auto') só dispara um NOVO e-mail
-- quando o conjunto de fundos incluídos no relatório mudou desde o último envio
-- 'auto' daquela data_referencia (ex.: XMLs que chegaram entre 10h e 19h).
-- Envios manuais (origem='manual', tela Enviar Relatório) sempre disparam.

ALTER TABLE public.envios_relatorio_rentabilidade
  ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'manual'
    CHECK (origem IN ('auto', 'manual')),
  ADD COLUMN IF NOT EXISTS status_cobertura TEXT
    CHECK (status_cobertura IS NULL OR status_cobertura IN ('parcial', 'completo')),
  ADD COLUMN IF NOT EXISTS qtd_fundos INT,
  ADD COLUMN IF NOT EXISTS qtd_faltantes INT,
  ADD COLUMN IF NOT EXISTS fundos_incluidos TEXT[];

COMMENT ON COLUMN public.envios_relatorio_rentabilidade.origem IS
  'auto = disparado pelo cron (10h/19h BRT); manual = tela Enviar Relatório.';
COMMENT ON COLUMN public.envios_relatorio_rentabilidade.status_cobertura IS
  'completo = todos os fundos monitorados tinham XML na data; parcial = há fundos faltantes.';
COMMENT ON COLUMN public.envios_relatorio_rentabilidade.qtd_fundos IS
  'Quantidade de fundos incluídos no relatório enviado.';
COMMENT ON COLUMN public.envios_relatorio_rentabilidade.qtd_faltantes IS
  'Quantidade de fundos monitorados sem XML na data_referencia no momento do envio.';
COMMENT ON COLUMN public.envios_relatorio_rentabilidade.fundos_incluidos IS
  'CNPJs (14 dígitos, ordenados) dos fundos incluídos — usado para deduplicar envios automáticos: só reenvia quando este conjunto muda.';

CREATE INDEX IF NOT EXISTS idx_envios_relatorio_rentabilidade_origem_data
  ON public.envios_relatorio_rentabilidade (data_referencia, origem, created_at DESC);
