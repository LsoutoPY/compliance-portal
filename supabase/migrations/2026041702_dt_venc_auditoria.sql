-- Guardar dt_venc no resultado_auditoria para rastreabilidade
-- Permite saber qual sub-índice IMA-B foi usado em cada ativo
ALTER TABLE resultado_auditoria ADD COLUMN IF NOT EXISTS dt_venc DATE;
