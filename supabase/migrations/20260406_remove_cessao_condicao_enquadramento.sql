-- Remove registros de CESSAO_CONDICAO que foram gravados incorretamente
-- em enquadramento_resultado pelo branch relational do check-enquadramento.
-- Essas regras são exclusivas do motor pré-trade (validar-cessao-elegibilidade)
-- e não devem aparecer no monitoramento de compliance pós-trade.

DELETE FROM enquadramento_resultado
WHERE regra_codigo LIKE 'CESSAO_%';
