-- Migration: Retrocompatibilidade de permissões — credito.matriz
-- Garante que usuários com acesso a qualquer uma das telas antigas
-- também tenham acesso à nova tela unificada.

INSERT INTO user_menu_permissions (user_id, menu_key)
SELECT DISTINCT user_id, 'credito.matriz'
FROM user_menu_permissions
WHERE menu_key IN (
  'credito.dashboard',
  'credito.monitoramento',
  'credito.consolidado',
  'credito.safras'
)
ON CONFLICT (user_id, menu_key) DO NOTHING;

-- Log
DO $$
DECLARE v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count FROM user_menu_permissions WHERE menu_key = 'credito.matriz';
  RAISE NOTICE 'credito.matriz: % permissões ativas', v_count;
END $$;
