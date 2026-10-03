import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchXmlGapsPorReferencia,
  groupXmlGaps,
  resolveXmlGapsIntervalo,
} from "@/lib/xmlGaps";

export const xmlGapsQueryKey = (
  dataFimRef: string | null,
  ano: number,
) => ["xml-gaps-referencia", dataFimRef, ano] as const;

interface UseXmlGapsOptions {
  dataFimRefYyyymmdd: string | null;
  ano: number;
  enabled?: boolean;
}

export function useXmlGaps({
  dataFimRefYyyymmdd,
  ano,
  enabled = true,
}: UseXmlGapsOptions) {
  const intervalo = useMemo(() => {
    if (!dataFimRefYyyymmdd) return null;
    return resolveXmlGapsIntervalo(dataFimRefYyyymmdd, ano);
  }, [dataFimRefYyyymmdd, ano]);

  const query = useQuery({
    queryKey: xmlGapsQueryKey(dataFimRefYyyymmdd, ano),
    queryFn: () =>
      fetchXmlGapsPorReferencia(
        intervalo!.dataInicio,
        intervalo!.dataFim,
      ),
    enabled: enabled && !!intervalo,
    staleTime: 5 * 60 * 1000,
  });

  const grouped = useMemo(
    () =>
      groupXmlGaps(
        query.data?.gaps ?? [],
        intervalo ?? undefined,
        query.data?.totalFundosUniverso,
      ),
    [query.data, intervalo],
  );

  return {
    xmlGaps: query.data?.gaps ?? [],
    grouped,
    intervalo,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
    hasGaps: grouped.totalGaps > 0,
  };
}
