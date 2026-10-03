-- Exclusoes operacionais explicitas para o relatorio de rentabilidade.
-- Ausencia de ativos nao exclui um fundo automaticamente.

CREATE TABLE IF NOT EXISTS public.rentabilidade_relatorio_fundos_ignorados (
  fundo_key text PRIMARY KEY,
  fundo_cnpj text NOT NULL,
  fundo_isin text NULL,
  nome_fundo text NULL,
  ativo boolean NOT NULL DEFAULT true,
  motivo text NULL,
  created_by uuid NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rent_relatorio_ignorados_ativo
  ON public.rentabilidade_relatorio_fundos_ignorados (ativo)
  WHERE ativo = true;

ALTER TABLE public.rentabilidade_relatorio_fundos_ignorados ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rent_relatorio_ignorados_select_auth" ON public.rentabilidade_relatorio_fundos_ignorados;
CREATE POLICY "rent_relatorio_ignorados_select_auth"
  ON public.rentabilidade_relatorio_fundos_ignorados FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "rent_relatorio_ignorados_write_full_access" ON public.rentabilidade_relatorio_fundos_ignorados;
CREATE POLICY "rent_relatorio_ignorados_write_full_access"
  ON public.rentabilidade_relatorio_fundos_ignorados FOR ALL
  USING (public.user_can_write())
  WITH CHECK (public.user_can_write());

NOTIFY pgrst, 'reload schema';
