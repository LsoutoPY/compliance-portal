-- Perfis de acesso (completo | consulta) e permissões de menu.
-- Gestão de usuários: Supabase Dashboard / service role (sem escrita via client).

-- ── Tipos ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE public.user_access_type AS ENUM ('completo', 'consulta');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── Tabelas ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name   TEXT,
  access_type public.user_access_type NOT NULL DEFAULT 'consulta',
  is_active   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_menu_permissions (
  user_id   UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  menu_key  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, menu_key)
);

CREATE INDEX IF NOT EXISTS idx_user_menu_permissions_user_id
  ON public.user_menu_permissions(user_id);

COMMENT ON TABLE public.user_profiles IS
  'Perfil de acesso da aplicação. completo = leitura+escrita; consulta = leitura com menus configuráveis.';
COMMENT ON TABLE public.user_menu_permissions IS
  'Itens de menu liberados para usuários consulta (menu_key do NAV_REGISTRY).';

-- ── Funções auxiliares ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.user_is_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT is_active FROM public.user_profiles WHERE id = auth.uid()),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.user_access_type()
RETURNS public.user_access_type
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT access_type
  FROM public.user_profiles
  WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.user_can_write()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT access_type = 'completo'::public.user_access_type AND is_active
      FROM public.user_profiles
      WHERE id = auth.uid()
    ),
    false
  );
$$;

GRANT EXECUTE ON FUNCTION public.user_is_active() TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_access_type() TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_write() TO authenticated;

-- ── Trigger: novo usuário → consulta inativo (admin habilita no Supabase) ───

CREATE OR REPLACE FUNCTION public.handle_new_user_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_profiles (id, full_name, access_type, is_active)
  VALUES (
    NEW.id,
    NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'full_name', '')), ''),
    'consulta',
    false
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_profile ON auth.users;
CREATE TRIGGER on_auth_user_created_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user_profile();

-- ── Backfill: usuários existentes → completo ativo ───────────────────────────

INSERT INTO public.user_profiles (id, full_name, access_type, is_active)
SELECT
  u.id,
  NULLIF(trim(COALESCE(u.raw_user_meta_data->>'full_name', '')), ''),
  'completo'::public.user_access_type,
  true
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- ── RLS nas tabelas de perfil ─────────────────────────────────────────────────

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_menu_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_own_profile" ON public.user_profiles;
CREATE POLICY "read_own_profile"
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS "read_own_menu_permissions" ON public.user_menu_permissions;
CREATE POLICY "read_own_menu_permissions"
  ON public.user_menu_permissions
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Escrita somente via service role (Dashboard / SQL Editor)

GRANT SELECT ON public.user_profiles TO authenticated;
GRANT SELECT ON public.user_menu_permissions TO authenticated;

-- ── Aplicar RLS de leitura/escrita nas demais tabelas public ─────────────────

CREATE OR REPLACE FUNCTION public.apply_access_rls_to_table(p_table text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pol record;
BEGIN
  IF p_table IN ('user_profiles', 'user_menu_permissions') THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = p_table
      AND c.relkind = 'r'
  ) THEN
    RETURN;
  END IF;

  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = p_table
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, p_table);
  END LOOP;

  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_table);

  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.user_is_active())',
    'access_select_' || p_table,
    p_table
  );

  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.user_can_write())',
    'access_insert_' || p_table,
    p_table
  );

  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.user_can_write()) WITH CHECK (public.user_can_write())',
    'access_update_' || p_table,
    p_table
  );

  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.user_can_write())',
    'access_delete_' || p_table,
    p_table
  );
END;
$$;

DO $$
DECLARE
  tbl record;
BEGIN
  FOR tbl IN
    SELECT c.relname AS tablename
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname NOT IN ('user_profiles', 'user_menu_permissions')
    ORDER BY c.relname
  LOOP
    PERFORM public.apply_access_rls_to_table(tbl.tablename);
  END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS public.apply_access_rls_to_table(text);
