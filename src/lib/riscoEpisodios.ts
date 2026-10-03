export type StatusDiarioEpisodio = "ok" | "atencao" | "violacao";

export type EvidenciaDiariaEpisodio = {
  data: string;
  status: StatusDiarioEpisodio;
};

export type EpisodioCalculado = {
  inicio: string;
  ultimaEvidencia: string;
  regularizadoEm: string | null;
  diasComEvidencia: number;
  houveViolacao: boolean;
  statusAtual: Exclude<StatusDiarioEpisodio, "ok">;
};

/**
 * Agrupa uma série diária em episódios. Apenas um status `ok` encerra a
 * sequência; lacunas de importação nunca são tratadas como regularização.
 */
export function extrairEpisodiosDaSerie(
  evidencias: EvidenciaDiariaEpisodio[],
): EpisodioCalculado[] {
  const porData = new Map<string, StatusDiarioEpisodio>();
  const peso: Record<StatusDiarioEpisodio, number> = { ok: 0, atencao: 1, violacao: 2 };

  for (const evidencia of evidencias) {
    const anterior = porData.get(evidencia.data);
    if (!anterior || peso[evidencia.status] > peso[anterior]) {
      porData.set(evidencia.data, evidencia.status);
    }
  }

  const serie = [...porData.entries()]
    .map(([data, status]) => ({ data, status }))
    .sort((a, b) => a.data.localeCompare(b.data));

  const episodios: EpisodioCalculado[] = [];
  let atual: Omit<EpisodioCalculado, "regularizadoEm"> | null = null;

  for (const dia of serie) {
    if (dia.status === "ok") {
      if (atual) {
        episodios.push({ ...atual, regularizadoEm: dia.data });
        atual = null;
      }
      continue;
    }

    if (!atual) {
      atual = {
        inicio: dia.data,
        ultimaEvidencia: dia.data,
        diasComEvidencia: 1,
        houveViolacao: dia.status === "violacao",
        statusAtual: dia.status,
      };
      continue;
    }

    atual.ultimaEvidencia = dia.data;
    atual.diasComEvidencia += 1;
    atual.houveViolacao ||= dia.status === "violacao";
    atual.statusAtual = dia.status;
  }

  if (atual) episodios.push({ ...atual, regularizadoEm: null });
  return episodios;
}
