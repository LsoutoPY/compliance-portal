-- =====================================================
-- Migration: Create View Mapa de Ativos x Fundos
-- Description: View para mapear todos os ativos e os fundos que os detêm
-- Date: 2026-04-27
-- =====================================================

-- 1. Criar view para mapeamento de ativos x fundos
-- DROP necessário porque CREATE OR REPLACE não permite alterar ordem/nome de colunas existentes
DROP VIEW IF EXISTS vw_mapa_ativos_fundos;

CREATE VIEW vw_mapa_ativos_fundos AS
SELECT 
  -- Identificação do Fundo
  fundo_cnpj,
  COALESCE(nome_fundo, fundo_nome) AS fundo_nome,
  fundo_dtposicao,
  fundo_patliq,
  fundo_nomeadm    AS administrador,
  fundo_nomegestor AS gestor,
  
  -- Tipo de Ativo (section)
  section AS ativo_tipo,
  
  -- Identificador único do ativo (varia por tipo)
  CASE 
    WHEN section = 'cotas'        THEN cnpjfundo
    WHEN section IN ('titpublico', 'titprivado') THEN COALESCE(isin, cnpjemissor, codativo)
    WHEN section = 'caixa'        THEN isininstituicao
    WHEN section = 'participacoes' THEN cnpjpart
    WHEN section = 'imoveis'      THEN matricula
    WHEN section = 'acoes'        THEN isin
    ELSE NULL
  END AS ativo_identificador,
  
  -- Nome do ativo para imóveis (nomecomercial) — nulo nos demais tipos
  CASE
    WHEN section = 'imoveis' THEN nomecomercial
    ELSE NULL
  END AS ativo_nome_imovel,
  
  -- Campos adicionais para enriquecimento
  isin AS ativo_isin,
  cnpjemissor AS ativo_cnpj_emissor,
  cnpjfundo AS ativo_cnpj_fundo,
  codativo AS ativo_codigo,
  
  -- Quantidades e Valores
  CASE 
    WHEN section IN ('cotas', 'titpublico', 'titprivado', 'participacoes', 'acoes') THEN qtdisponivel
    ELSE NULL
  END AS quantidade,
  
  CASE 
    WHEN section IN ('cotas', 'titpublico', 'titprivado', 'participacoes', 'acoes') THEN puposicao
    ELSE NULL
  END AS preco_unitario,
  
  -- Valor financeiro: imóveis usam valorcontabil; demais usam valor_padrao
  CASE
    WHEN section = 'imoveis' THEN valorcontabil
    ELSE valor_padrao
  END AS valor_financeiro,
  
  -- Percentual sobre o PL do fundo (usa o mesmo valor_financeiro calculado acima)
  CASE 
    WHEN fundo_patliq > 0 AND (
      CASE WHEN section = 'imoveis' THEN valorcontabil ELSE valor_padrao END
    ) IS NOT NULL
    THEN (
      CASE WHEN section = 'imoveis' THEN valorcontabil ELSE valor_padrao END
      / fundo_patliq
    ) * 100
    ELSE NULL
  END AS percentual_pl,
  
  -- Informações adicionais por tipo
  CASE 
    WHEN section IN ('titpublico', 'titprivado') THEN dtvencimento
    ELSE NULL
  END AS data_vencimento,
  
  CASE 
    WHEN section IN ('titpublico', 'titprivado') THEN indexador
    ELSE NULL
  END AS indexador,
  
  -- Metadata
  arquivo_nome,
  natural_key,
  id AS posicao_id

FROM posicao_carteira
WHERE 
  section IN ('cotas', 'titpublico', 'titprivado', 'caixa', 'participacoes', 'imoveis', 'acoes')
  AND fundo_cnpj IS NOT NULL
  AND (
    -- Garantir que tem identificador válido por tipo
    (section = 'cotas'         AND cnpjfundo IS NOT NULL) OR
    (section IN ('titpublico', 'titprivado') AND (isin IS NOT NULL OR cnpjemissor IS NOT NULL OR codativo IS NOT NULL)) OR
    (section = 'caixa'         AND isininstituicao IS NOT NULL) OR
    (section = 'participacoes' AND cnpjpart IS NOT NULL) OR
    (section = 'imoveis'       AND matricula IS NOT NULL) OR
    (section = 'acoes'         AND isin IS NOT NULL)
  );

-- 2. Criar índices na tabela base para otimizar consultas da view
-- (somente se não existirem)

CREATE INDEX IF NOT EXISTS idx_posicao_section 
  ON posicao_carteira(section);

CREATE INDEX IF NOT EXISTS idx_posicao_fundo_data 
  ON posicao_carteira(fundo_cnpj, fundo_dtposicao);

CREATE INDEX IF NOT EXISTS idx_posicao_cnpjfundo 
  ON posicao_carteira(cnpjfundo) 
  WHERE section = 'cotas' AND cnpjfundo IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_posicao_cnpjemissor 
  ON posicao_carteira(cnpjemissor) 
  WHERE cnpjemissor IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_posicao_isin 
  ON posicao_carteira(isin) 
  WHERE isin IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_posicao_codativo 
  ON posicao_carteira(codativo) 
  WHERE codativo IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_posicao_isininstituicao 
  ON posicao_carteira(isininstituicao) 
  WHERE section = 'caixa' AND isininstituicao IS NOT NULL;

-- 3. Adicionar comentários
COMMENT ON VIEW vw_mapa_ativos_fundos IS 
'View consolidada de todos os ativos detidos pelos fundos. 
Permite consultar: 
- Todos os ativos de um fundo específico
- Todos os fundos que detêm um ativo específico
- Exposição consolidada por ativo
Atualização: tempo real (view normal, não materializada)';
