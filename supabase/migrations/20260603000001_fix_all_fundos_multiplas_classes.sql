-- Fix Global: Separar TODOS os fundos por ISIN quando têm múltiplas classes/séries
-- 
-- Problema: Fundos com mesmo CNPJ mas ISINs diferentes (classes diferentes)
-- estavam sendo agrupados em um único ativo
--
-- Solução: Criar um ativo separado para cada combinação CNPJ + ISIN

BEGIN;

-- Passo 1: Criar ativos para cada ISIN único de fundos na posicao_carteira
DO $$
DECLARE
  v_rec RECORD;
  v_ativo_id UUID;
  v_count INTEGER := 0;
  v_created INTEGER := 0;
  v_updated INTEGER := 0;
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Iniciando processamento de fundos com múltiplas classes';
  RAISE NOTICE '========================================';
  
  -- Para cada combinação única de CNPJ + ISIN na posicao_carteira
  FOR v_rec IN 
    SELECT DISTINCT 
      pc.cnpjfundo as cnpj,
      pc.isin,
      COALESCE(
        -- Busca nome em fundos_caracteristicas por CNPJ + ISIN do ATIVO (não do investidor)
        (SELECT fc.nome_comercial
         FROM fundos_caracteristicas fc
         WHERE fc.isin = pc.isin
           AND (fc.cnpj_classe = pc.cnpjfundo OR fc.cnpj_fundo = pc.cnpjfundo)
         LIMIT 1),
        -- Fallback: busca só por CNPJ
        (SELECT fc.nome_comercial
         FROM fundos_caracteristicas fc
         WHERE (fc.cnpj_classe = pc.cnpjfundo OR fc.cnpj_fundo = pc.cnpjfundo)
           AND (fc.estrutura IS NULL OR fc.estrutura IN ('Classe', 'Fundo'))
         LIMIT 1),
        'FUNDO CNPJ ' || pc.cnpjfundo
      ) as descricao
    FROM posicao_carteira pc
    WHERE pc.section = 'cotas'
      AND pc.cnpjfundo IS NOT NULL
      AND pc.cnpjfundo != ''
      AND pc.isin IS NOT NULL
      AND pc.isin != ''
      AND NOT pc.isin LIKE '%*%'  -- Ignora ISINs mascarados
      AND LENGTH(pc.isin) = 12     -- ISIN válido tem 12 caracteres
    GROUP BY pc.cnpjfundo, pc.isin
    ORDER BY pc.cnpjfundo, pc.isin
  LOOP
    v_count := v_count + 1;
    
    -- Verifica se já existe um ativo com este ISIN
    SELECT id INTO v_ativo_id
    FROM ativos
    WHERE isin = v_rec.isin
      AND tipo_ativo = 'FUNDO'
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
        v_rec.descricao,
        v_rec.isin,
        v_rec.cnpj,
        false,
        v_rec.descricao
      )
      RETURNING id INTO v_ativo_id;
      
      v_created := v_created + 1;
      
      IF v_created <= 10 THEN
        RAISE NOTICE '[%] Criado: ISIN % - CNPJ % - %', v_count, v_rec.isin, v_rec.cnpj, v_rec.descricao;
      END IF;
    END IF;
    
    -- Atualiza posicao_carteira para vincular ao ativo correto por ISIN
    UPDATE posicao_carteira
    SET ativo_id = v_ativo_id
    WHERE section = 'cotas'
      AND cnpjfundo = v_rec.cnpj
      AND isin = v_rec.isin
      AND (ativo_id IS NULL OR ativo_id != v_ativo_id);
    
    IF FOUND THEN
      v_updated := v_updated + 1;
    END IF;
  END LOOP;
  
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Processamento concluído:';
  RAISE NOTICE '- Total de combinações CNPJ+ISIN processadas: %', v_count;
  RAISE NOTICE '- Novos ativos criados: %', v_created;
  RAISE NOTICE '- Vínculos atualizados em posicao_carteira: %', v_updated;
  RAISE NOTICE '========================================';
  
END $$;

-- Passo 2: Limpar ativos antigos duplicados (apenas por CNPJ, sem ISIN)
DO $$
DECLARE
  v_deleted INTEGER := 0;
BEGIN
  -- Remove ativos de fundos que não têm ISIN, mas existem outros do mesmo CNPJ com ISIN
  DELETE FROM ativos a1
  WHERE a1.tipo_ativo = 'FUNDO'
    AND (a1.isin IS NULL OR a1.isin = '')
    AND a1.cnpj IS NOT NULL
    AND EXISTS (
      SELECT 1 
      FROM ativos a2 
      WHERE a2.tipo_ativo = 'FUNDO'
        AND a2.cnpj = a1.cnpj
        AND a2.isin IS NOT NULL
        AND a2.isin != ''
        AND a2.id != a1.id
    );
  
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  
  IF v_deleted > 0 THEN
    RAISE NOTICE 'Removidos % ativos duplicados sem ISIN', v_deleted;
  END IF;
END $$;

-- Passo 3: Relatório de fundos com múltiplas classes
DO $$
DECLARE
  v_rec RECORD;
  v_total INTEGER := 0;
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Fundos com múltiplas classes identificadas:';
  RAISE NOTICE '========================================';
  
  FOR v_rec IN
    SELECT 
      cnpj,
      COUNT(*) as num_classes,
      STRING_AGG(isin, ', ' ORDER BY isin) as isins,
      MAX(descricao) as exemplo_nome
    FROM ativos
    WHERE tipo_ativo = 'FUNDO'
      AND isin IS NOT NULL
      AND isin != ''
    GROUP BY cnpj
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC, cnpj
    LIMIT 20
  LOOP
    v_total := v_total + 1;
    RAISE NOTICE '[%] CNPJ: % - % classes - %', 
      v_total, 
      v_rec.cnpj, 
      v_rec.num_classes,
      v_rec.exemplo_nome;
    RAISE NOTICE '    ISINs: %', v_rec.isins;
  END LOOP;
  
  IF v_total = 0 THEN
    RAISE NOTICE '(Nenhum fundo com múltiplas classes encontrado)';
  ELSIF v_total = 20 THEN
    RAISE NOTICE '... (mostrando apenas os primeiros 20)';
  END IF;
  
  RAISE NOTICE '========================================';
END $$;

COMMIT;

-- Query de verificação específica para BONA
-- SELECT 
--   id,
--   descricao,
--   isin,
--   FORMAT('%s.%s.%s/%s-%s', 
--     SUBSTRING(cnpj, 1, 2),
--     SUBSTRING(cnpj, 3, 3),
--     SUBSTRING(cnpj, 6, 3),
--     SUBSTRING(cnpj, 9, 4),
--     SUBSTRING(cnpj, 13, 2)
--   ) as cnpj_formatado,
--   validado
-- FROM ativos
-- WHERE cnpj = '58944590000190'
--   AND tipo_ativo = 'FUNDO'
-- ORDER BY isin;
