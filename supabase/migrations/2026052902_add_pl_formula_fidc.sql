-- Adiciona coluna pl_formula em fundos_caracteristicas para controlar qual fórmula
-- deve ser usada no cálculo do PL de FIDCs nos módulos de enquadramento e cessão.
--
-- Valores possíveis:
--   NULL (padrão) → usa fundo_patliq armazenado no banco (padrão para todos os FIDCs)
--   'va_vr'       → aplica valorativos + valorreceber ao vivo (modo Nexum JR:
--                   necessário quando valorpagar ≈ valorativos, tornando o PL calculado
--                   na importação incorretamente baixo)

ALTER TABLE fundos_caracteristicas
  ADD COLUMN IF NOT EXISTS pl_formula TEXT DEFAULT NULL;

COMMENT ON COLUMN fundos_caracteristicas.pl_formula IS
  'Fórmula de PL a aplicar em módulos de enquadramento/cessão para FIDCs. '
  'NULL = usa fundo_patliq armazenado; ''va_vr'' = usa valorativos+valorreceber ao vivo.';
