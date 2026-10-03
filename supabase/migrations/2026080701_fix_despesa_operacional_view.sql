-- Corrige interpretação da view de provisões operacionais:
-- saldo provisionado no XML (acumulado no ciclo) ≠ despesa mensal para cobertura.
-- Despesa mensal para fundos fechados: preferir vw_conferencia_taxas_mes (Controle Taxas).

COMMENT ON VIEW public.vw_provisoes_despesa_operacional_mes IS
  'DRILL-DOWN ONLY: saldos provisionados XML por codprov ANBIMA. '
  'NÃO usar como despesa mensal — valores são acumulados no ciclo, não fluxo mensal. '
  'Para cobertura operacional use vw_conferencia_taxas_mes.total_mensal.';

COMMENT ON VIEW public.vw_provisoes_despesa_operacional_detalhe IS
  'DRILL-DOWN ONLY: linhas de provisão XML (saldo acumulado por codprov no snapshot).';
