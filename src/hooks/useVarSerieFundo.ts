import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { VarSerieFundoResponse } from "@/types/risco-mercado";

/**
 * Série temporal de VaR por fundo (CNPJ) — aba Evolução Temporal.
 * Lazy: só busca quando `enabled` é true (fundo selecionado).
 */
export function useVarSerieFundo(cnpj: string, enabled: boolean) {
  return useQuery<VarSerieFundoResponse>({
    queryKey: ["var-serie-fundo", cnpj],
    enabled: enabled && cnpj.length >= 14,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const res = await supabase.functions.invoke("buscar-risco-mercado-v2", {
        body: { cnpj, include_var_serie: true },
      });
      if (res.error) throw new Error(res.error.message);
      const data = res.data as VarSerieFundoResponse | null;
      if (!data || data.success === false) {
        throw new Error(data?.error ?? "Falha ao buscar série de VaR do fundo");
      }
      return data;
    },
  });
}
