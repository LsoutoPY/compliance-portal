-- Fix: Separar fundos BONA por ISIN ao invés de agrupar por CNPJ
-- Problema: Fundo 58.944.590/0001-90 tem 3 classes com ISINs diferentes, 
-- mas estava sendo tratado como 1 único ativo

BEGIN;

-- 1. Identificar os ISINs únicos do fundo BONA na posicao_carteira
-- (isso nos mostra quantas classes/séries existem)
DO $$
DECLARE
  v_cnpj TEXT := '58944590000190';
  v_isin TEXT;
  v_descricao TEXT;
  v_ativo_id UUID;
  v_count INTEGER;
BEGIN
  RAISE NOTICE 'Processando fundo BONA CNPJ: %', v_cnpj;
  
  -- Para cada ISIN único encontrado na posicao_carteira
  FOR v_isin, v_descricao IN 
    SELECT DISTINCT 
      pc.isin,
      COALESCE(pc.nome_fundo, 'BONA FIDE - FIDC NP') as descricao
    FROM posicao_carteira pc
    WHERE pc.section = 'cotas'
      AND pc.cnpjfundo = v_cnpj
      AND pc.isin IS NOT NULL
      AND pc.isin != ''
    ORDER BY pc.isin
  LOOP
    RAISE NOTICE 'Processando ISIN: % - %', v_isin, v_descricao;
    
    -- Verifica se já existe um ativo com este ISIN
    SELECT id INTO v_ativo_id
    FROM ativos
    WHERE isin = v_isin
    LIMIT 1;
    
    IF v_ativo_id IS NULL THEN
      -- Cria novo ativo para este ISIN específico
      INSERT INTO ativos (
        tipo_ativo,
        descricao,
        isin,
        cnpj,
        validado,
        nome_frontend
      ) VALUES (
        'FUNDO',
        v_descricao,
        v_isin,
        v_cnpj,
        false,
        v_descricao
      )
      RETURNING id INTO v_ativo_id;
      
      RAISE NOTICE 'Criado novo ativo % para ISIN %', v_ativo_id, v_isin;
    ELSE
      RAISE NOTICE 'Ativo já existe: % para ISIN %', v_ativo_id, v_isin;
    END IF;
    
    -- Atualiza posicao_carteira para vincular ao ativo correto
    UPDATE posicao_carteira
    SET ativo_id = v_ativo_id
    WHERE section = 'cotas'
      AND cnpjfundo = v_cnpj
      AND isin = v_isin;
    
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE NOTICE 'Atualizados % registros de posicao_carteira para ISIN %', v_count, v_isin;
  END LOOP;
  
  -- Remove ativo antigo agrupado apenas por CNPJ (se existir e não tiver ISIN)
  DELETE FROM ativos
  WHERE cnpj = v_cnpj
    AND tipo_ativo = 'FUNDO'
    AND (isin IS NULL OR isin = '');
  
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Removidos % ativos antigos sem ISIN', v_count;
  END IF;
  
END $$;

-- 2. Verificar resultado final
DO $$
DECLARE
  v_cnpj TEXT := '58944590000190';
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM ativos
  WHERE cnpj = v_cnpj
    AND tipo_ativo = 'FUNDO';
  
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Resumo Final:';
  RAISE NOTICE 'Total de ativos BONA criados: %', v_count;
  RAISE NOTICE '========================================';
  
  -- Mostrar detalhes de cada ativo
  FOR v_count IN 
    SELECT ROW_NUMBER() OVER (ORDER BY isin) as num
    FROM ativos
    WHERE cnpj = v_cnpj
      AND tipo_ativo = 'FUNDO'
  LOOP
    RAISE NOTICE 'Ativo % criado', v_count;
  END LOOP;
END $$;

COMMIT;

-- Query de verificação (executar após o script)
-- SELECT 
--   id,
--   descricao,
--   isin,
--   cnpj,
--   validado,
--   nome_frontend
-- FROM ativos
-- WHERE cnpj = '58944590000190'
-- ORDER BY isin;
