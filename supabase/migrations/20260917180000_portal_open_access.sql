-- Acesso aberto no portal CVPAR (ainda sem RBAC de usuário).
-- Políticas permissivas adicionais: no Postgres RLS, policies PERMISSIVE
-- combinam com OR, então convivem com as policies do Frame.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS tablename
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);

    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = r.tablename
        AND policyname = 'portal_open_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY portal_open_all ON public.%I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)',
        r.tablename
      );
    END IF;

    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon, authenticated',
      r.tablename
    );
  END LOOP;

  FOR r IN
    SELECT c.relname AS viewname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('v', 'm')
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', r.viewname);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;

-- Colunas usadas no cardápio de ativos do frontend e que não têm
-- migration ADD COLUMN no Frame.
ALTER TABLE public.ativos
  ADD COLUMN IF NOT EXISTS caracteristica_investidor text,
  ADD COLUMN IF NOT EXISTS tipo_publico_alvo text,
  ADD COLUMN IF NOT EXISTS nivel1_categoria text,
  ADD COLUMN IF NOT EXISTS prazo_pagamento_resgate_dias numeric,
  ADD COLUMN IF NOT EXISTS abertura_estatutariamente text;
