-- Snapshot de segurança antes de alterar estrutura e chave única de fundos_caracteristicas.
-- Criado em: 2026-05-12
-- Motivo: adição de 'Subclasse' ao check de estrutura + troca de chave única para codigo_anbima

CREATE TABLE IF NOT EXISTS public.fundos_caracteristicas_backup_20260512
AS SELECT * FROM public.fundos_caracteristicas;

COMMENT ON TABLE public.fundos_caracteristicas_backup_20260512
IS 'Backup de fundos_caracteristicas criado em 2026-05-12 antes da migração de subclasses ANBIMA.';
