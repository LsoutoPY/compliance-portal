-- CORREÇÃO URGENTE: Atualizar nomes dos ativos com os nomes corretos dos fundos investidos
-- 
-- Problema: Os ativos estavam sendo criados com o nome do FUNDO INVESTIDOR
-- ao invés do nome do FUNDO INVESTIDO (o ativo em si)
--
-- Solução: Buscar o nome correto em fundos_caracteristicas usando cnpjfundo + isin

BEGIN;

DO $$
DECLARE
  v_rec RECORD;
  v_nome_correto TEXT;
  v_atualizado INTEGER := 0;
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Corrigindo nomes dos ativos de fundos';
  RAISE NOTICE '========================================';
  
  -- Para cada ativo do tipo FUNDO que tem ISIN
  FOR v_rec IN
    SELECT 
      a.id,
      a.isin,
      a.cnpj,
      a.descricao as nome_atual
    FROM ativos a
    WHERE a.tipo_ativo = 'FUNDO'
      AND a.isin IS NOT NULL
      AND a.isin != ''
      AND LENGTH(a.isin) = 12
    ORDER BY a.cnpj, a.isin
  LOOP
    -- Busca o nome correto em fundos_caracteristicas
    -- PRIORIDADE 1: Match por ISIN + CNPJ
    SELECT fc.nome_comercial
    INTO v_nome_correto
    FROM fundos_caracteristicas fc
    WHERE fc.isin = v_rec.isin
      AND (fc.cnpj_classe = v_rec.cnpj OR fc.cnpj_fundo = v_rec.cnpj)
    LIMIT 1;
    
    -- PRIORIDADE 2: Se não achou, tenta só por CNPJ
    IF v_nome_correto IS NULL THEN
      SELECT fc.nome_comercial
      INTO v_nome_correto
      FROM fundos_caracteristicas fc
      WHERE (fc.cnpj_classe = v_rec.cnpj OR fc.cnpj_fundo = v_rec.cnpj)
        AND (fc.estrutura IS NULL OR fc.estrutura IN ('Classe', 'Fundo'))
      LIMIT 1;
    END IF;
    
    -- Se encontrou um nome e é diferente do atual, atualiza
    IF v_nome_correto IS NOT NULL AND v_nome_correto != v_rec.nome_atual THEN
      UPDATE ativos
      SET 
        descricao = v_nome_correto,
        nome_frontend = v_nome_correto
      WHERE id = v_rec.id;
      
      v_atualizado := v_atualizado + 1;
      
      IF v_atualizado <= 10 THEN
        RAISE NOTICE '[%] Corrigido: ISIN % - CNPJ %', v_atualizado, v_rec.isin, v_rec.cnpj;
        RAISE NOTICE '    Antigo: %', v_rec.nome_atual;
        RAISE NOTICE '    Novo  : %', v_nome_correto;
      END IF;
    END IF;
  END LOOP;
  
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Total de ativos corrigidos: %', v_atualizado;
  RAISE NOTICE '========================================';
END $$;

COMMIT;

-- Query de verificação
-- SELECT 
--   a.descricao,
--   a.isin,
--   a.cnpj,
--   fc.nome_comercial as nome_em_fc
-- FROM ativos a
-- LEFT JOIN fundos_caracteristicas fc 
--   ON fc.isin = a.isin 
--   AND (fc.cnpj_classe = a.cnpj OR fc.cnpj_fundo = a.cnpj)
-- WHERE a.tipo_ativo = 'FUNDO'
--   AND a.isin IS NOT NULL
-- ORDER BY a.cnpj, a.isin
-- LIMIT 20;
