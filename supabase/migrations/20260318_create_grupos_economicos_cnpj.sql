-- Tabela de grupos econômicos para consolidação de exposição em regras de concentração.
-- Cada linha associa um CNPJ a um grupo econômico. CNPJs do mesmo grupo_id
-- têm sua exposição somada antes de verificar os limites de concentração.

CREATE TABLE IF NOT EXISTS grupos_economicos_cnpj (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj       TEXT        NOT NULL,          -- 14 dígitos sem formatação
  grupo_id   TEXT        NOT NULL,          -- chave do grupo (ex: 'GRUPO_LUPATECH')
  grupo_nome TEXT        NOT NULL,          -- nome exibido no frontend
  ativo      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cnpj)
);

CREATE INDEX IF NOT EXISTS idx_grupos_economicos_cnpj_grupo_id
  ON grupos_economicos_cnpj (grupo_id);

CREATE INDEX IF NOT EXISTS idx_grupos_economicos_cnpj_ativo
  ON grupos_economicos_cnpj (ativo);

COMMENT ON TABLE grupos_economicos_cnpj IS
  'Mapeamento de CNPJs para grupos econômicos. Usado pelas regras de concentração FIDC para consolidar exposição de empresas do mesmo grupo.';

COMMENT ON COLUMN grupos_economicos_cnpj.cnpj IS
  'CNPJ do cedente/sacado sem formatação (14 dígitos). Chave única — cada CNPJ pertence a no máximo um grupo.';

COMMENT ON COLUMN grupos_economicos_cnpj.grupo_id IS
  'Identificador interno do grupo econômico (ex: GRUPO_LUPATECH). Todos os CNPJs com mesmo grupo_id são consolidados.';

COMMENT ON COLUMN grupos_economicos_cnpj.grupo_nome IS
  'Nome amigável do grupo para exibição no frontend (ex: Lupatech S.A. - Grupo Econômico).';

COMMENT ON COLUMN grupos_economicos_cnpj.ativo IS
  'Quando false, o CNPJ é tratado individualmente mesmo que tenha grupo_id cadastrado.';
