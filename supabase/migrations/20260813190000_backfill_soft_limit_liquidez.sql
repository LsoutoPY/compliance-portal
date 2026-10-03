-- Reclassifica Soft Limits jÃ¡ capturados como OK na primeira versÃ£o do motor.
-- O processamento da fila criarÃ¡/atualizarÃ¡ os episÃ³dios de AtenÃ§Ã£o.

UPDATE public.risco_evidencias_diarias
SET status = 'atencao',
    processada_em = NULL,
    updated_at = now()
WHERE modulo = 'liquidez'
  AND status = 'ok'
  AND (
    payload ->> 'intermediate_status' = 'alerta'
    OR payload ->> 'status_cobertura' = 'alerta'
  );

NOTIFY pgrst, 'reload schema';
