-- CVM publica CNPJ com máscara (00.000.000/0001-00); o mapa cruza só dígitos.
-- Sem esta normalização a consulta .in() não encontra a linha.

UPDATE public.informe_diario_metricas
SET fundo_cnpj = regexp_replace(fundo_cnpj, '\D', '', 'g')
WHERE fundo_cnpj ~ '\D'
  AND regexp_replace(fundo_cnpj, '\D', '', 'g') ~ '^\d{14}$'
  AND NOT EXISTS (
    SELECT 1 FROM public.informe_diario_metricas d
    WHERE d.id <> informe_diario_metricas.id
      AND d.fundo_cnpj = regexp_replace(informe_diario_metricas.fundo_cnpj, '\D', '', 'g')
      AND d.data_competencia = informe_diario_metricas.data_competencia
      AND d.origem = informe_diario_metricas.origem
  );

DELETE FROM public.informe_diario_metricas a
USING public.informe_diario_metricas b
WHERE a.fundo_cnpj ~ '\D'
  AND b.fundo_cnpj = regexp_replace(a.fundo_cnpj, '\D', '', 'g')
  AND a.data_competencia = b.data_competencia
  AND a.origem = b.origem
  AND a.id <> b.id;

UPDATE public.fidc_informe_mensal_import
SET
  cnpj_fundo_classe = CASE
    WHEN cnpj_fundo_classe ~ '\D' THEN regexp_replace(cnpj_fundo_classe, '\D', '', 'g')
    ELSE cnpj_fundo_classe
  END,
  cnpj_fundo = CASE
    WHEN cnpj_fundo ~ '\D' THEN regexp_replace(cnpj_fundo, '\D', '', 'g')
    ELSE cnpj_fundo
  END,
  cnpj_classe = CASE
    WHEN cnpj_classe ~ '\D' THEN regexp_replace(cnpj_classe, '\D', '', 'g')
    ELSE cnpj_classe
  END
WHERE coalesce(cnpj_fundo_classe, '') ~ '\D'
   OR coalesce(cnpj_fundo, '') ~ '\D'
   OR coalesce(cnpj_classe, '') ~ '\D';
