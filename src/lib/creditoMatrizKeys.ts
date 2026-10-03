/**
 * Query keys centralizadas para o módulo Matriz de Risco de Crédito.
 * Usadas em useQuery e invalidação após calcular-credito.
 */

export const creditoMatrizKeys = {
  all: ["credito-matriz"] as const,

  dates: () => [...creditoMatrizKeys.all, "dates"] as const,

  visaoGeral: (fund: string, date: string) =>
    [...creditoMatrizKeys.all, "visao-geral", fund, date] as const,
  fundoResumo: (fund: string, date: string) =>
    [...creditoMatrizKeys.all, "fundo-resumo", fund, date] as const,

  matrizPrazo: (fund: string, date: string) =>
    [...creditoMatrizKeys.all, "matriz-prazo", fund, date] as const,

  coberturaPdd: (fund: string, date: string) =>
    [...creditoMatrizKeys.all, "cobertura-pdd", fund, date] as const,

  concentracao: (fund: string, date: string) =>
    [...creditoMatrizKeys.all, "concentracao", fund, date] as const,
  concentracaoPartes: (fund: string, date: string) =>
    [...creditoMatrizKeys.all, "concentracao-partes", fund, date] as const,
  enquadramento: (fund: string, date: string) =>
    [...creditoMatrizKeys.all, "enquadramento", fund, date] as const,

  safrasEmissao: (fund: string, date: string) =>
    [...creditoMatrizKeys.all, "safras-emissao", fund, date] as const,

  safrasMetricas: (fund: string, date: string) =>
    [...creditoMatrizKeys.all, "safras-metricas", fund, date] as const,

  serieMensal: (fund: string, period: string) =>
    [...creditoMatrizKeys.all, "serie-mensal", fund, period] as const,

  score: (fund: string, date: string) =>
    [...creditoMatrizKeys.all, "score", fund, date] as const,

  alertas: (fund: string, date: string) =>
    [...creditoMatrizKeys.all, "alertas", fund, date] as const,
};
