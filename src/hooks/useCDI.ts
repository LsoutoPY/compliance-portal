import { useQuery } from "@tanstack/react-query";

export interface BcbCdiRow {
  data: string; // DD/MM/YYYY
  valor: string;
}

/** "YYYY-MM-DD" → "DD/MM/YYYY" (formato BCB SGS) */
function isoToBcbDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** "DD/MM/YYYY" → "YYYY-MM-DD" */
function bcbDateToIso(bcb: string): string {
  const [d, m, y] = bcb.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

export async function fetchCdiRange(
  dataInicio: string,
  dataFim: string,
): Promise<Record<string, number>> {
  const url =
    `https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados` +
    `?formato=json&dataInicial=${isoToBcbDate(dataInicio)}&dataFinal=${isoToBcbDate(dataFim)}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`BCB SGS retornou HTTP ${resp.status}`);
  }

  const json = (await resp.json()) as BcbCdiRow[];
  const dict: Record<string, number> = {};

  for (const item of json) {
    const taxa = parseFloat(item.valor.replace(",", "."));
    if (!isNaN(taxa)) {
      dict[bcbDateToIso(item.data)] = taxa / 100;
    }
  }

  return dict;
}

/**
 * CDI diário da API BCB série 12.
 * cdiDict[dataISO] → taxa decimal (ex: 0.000534 = 0,0534%/dia).
 */
export function useCDI(dataInicio: string, dataFim: string) {
  const enabled = !!dataInicio && !!dataFim && dataInicio <= dataFim;

  const query = useQuery({
    queryKey: ["cdi-diario", dataInicio, dataFim],
    queryFn: () => fetchCdiRange(dataInicio, dataFim),
    enabled,
    staleTime: (query) => Number.isFinite(query.state.data?.[dataFim])
      ? 24 * 60 * 60 * 1000 : 60 * 1000,
    // Uma consulta feita antes da publicação não pode congelar o CDI por 24h.
    refetchInterval: (query) => query.state.data && !Number.isFinite(query.state.data[dataFim])
      ? 60 * 1000 : false,
    retry: 2,
  });

  return {
    cdiDict: query.data ?? {},
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
