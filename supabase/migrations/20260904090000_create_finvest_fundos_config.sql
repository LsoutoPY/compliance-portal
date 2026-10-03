-- Cadastro operacional dos fundos/carteiras consultados na API Finvest/Sinqia.
-- Esta tabela é a fonte única para as importações automáticas de XML e passivo.

CREATE TABLE IF NOT EXISTS public.finvest_fundos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo text NOT NULL UNIQUE CHECK (codigo ~ '^[0-9]{8}$'),
  nome text NOT NULL CHECK (length(trim(nome)) > 0),
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id)
);

COMMENT ON TABLE public.finvest_fundos IS
  'Carteiras Finvest/Sinqia elegíveis para importação automática de XML e passivo.';
COMMENT ON COLUMN public.finvest_fundos.codigo IS
  'Código de carteira Finvest/Sinqia: 8 dígitos. Nos cadastros atuais, equivale à raiz do CNPJ.';
COMMENT ON COLUMN public.finvest_fundos.ativo IS
  'Quando falso, o fundo permanece no cadastro, mas não é enviado às APIs automáticas.';

CREATE INDEX IF NOT EXISTS idx_finvest_fundos_ativos_codigo
  ON public.finvest_fundos (codigo)
  WHERE ativo;

CREATE OR REPLACE FUNCTION public.finvest_fundos_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_finvest_fundos_updated_at ON public.finvest_fundos;
CREATE TRIGGER trg_finvest_fundos_updated_at
  BEFORE UPDATE ON public.finvest_fundos
  FOR EACH ROW EXECUTE FUNCTION public.finvest_fundos_set_updated_at();

-- Migração do catálogo que antes estava duplicado nas Edge Functions.
INSERT INTO public.finvest_fundos (codigo, nome, ativo)
VALUES
  ('36517586', 'NEXUM FIDC', true),
  ('36517588', 'NEXUM FIDC SR', true),
  ('50168059', 'FIF QI PLUS', true),
  ('52611664', 'FICFIDC QI JS NP', true),
  ('53114587', 'FICFIDC QI PREC', true),
  ('53292014', 'FIP QI TURBI', true),
  ('53505712', 'FIDC QI LOANS', true),
  ('57845499', 'FIP TURBI 2.0', true),
  ('58062253', 'FIF QI T2.0', true),
  ('54738727', 'FICFIDC OPORT NP', true),
  ('54969186', 'FIDC SX CORP JR', true),
  ('55633981', 'FICFIF QI RM95', true),
  ('57284621', 'FICFIDC BIAJU', true),
  ('58197958', 'FIF QI FLUSS', true),
  ('58580017', 'FII SPOT ONE', true),
  ('61272053', 'FII QI RL 2', true),
  ('51479676', 'FICFIF QI ALVORADA', true),
  ('66664564', 'FIF QI APOLLO', true)
ON CONFLICT (codigo) DO NOTHING;

ALTER TABLE public.finvest_fundos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "finvest_fundos_select_active" ON public.finvest_fundos;
DROP POLICY IF EXISTS "finvest_fundos_insert_write" ON public.finvest_fundos;
DROP POLICY IF EXISTS "finvest_fundos_update_write" ON public.finvest_fundos;
DROP POLICY IF EXISTS "finvest_fundos_delete_write" ON public.finvest_fundos;

CREATE POLICY "finvest_fundos_select_active"
  ON public.finvest_fundos FOR SELECT TO authenticated
  USING (public.user_is_active());

CREATE POLICY "finvest_fundos_insert_write"
  ON public.finvest_fundos FOR INSERT TO authenticated
  WITH CHECK (public.user_can_write());

CREATE POLICY "finvest_fundos_update_write"
  ON public.finvest_fundos FOR UPDATE TO authenticated
  USING (public.user_can_write())
  WITH CHECK (public.user_can_write());

CREATE POLICY "finvest_fundos_delete_write"
  ON public.finvest_fundos FOR DELETE TO authenticated
  USING (public.user_can_write());
