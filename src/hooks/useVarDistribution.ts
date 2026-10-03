import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { VarDistributionData } from "@/types/risco-mercado";

/**
 * Busca a série de retornos diários de um fundo (CNPJ) para o painel de
 * distribuição (VarDistributionCharts).
 *
 * - Só faz fetch quando `enabled` é true (usuário expandiu a linha do fundo)
 * - Cache de 10 minutos — dados históricos mudam pouco
 */
export function useVarDistribution(cnpj: string, enabled: boolean) {
  return useQuery<VarDistributionData>({
    queryKey: ["var-distribution", cnpj],
    enabled,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const res = await supabase.functions.invoke("buscar-risco-mercado-v2", {
        body: { cnpj, include_series: true },
      });
      if (res.error) throw new Error(res.error.message);
      const data = res.data as (VarDistributionData & { error?: string }) | null;
      if (!data || data.success === false) {
        throw new Error(data?.error ?? "Falha ao buscar série de retornos");
      }
      return data;
    },
  });
}
