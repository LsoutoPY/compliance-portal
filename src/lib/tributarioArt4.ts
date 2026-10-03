/** Contadores anuais e helpers — regras Art. 4º (TRIB_FIM_LP_365 / TRIB_FIDC_LP_365). */

export const ART4_MAX_EVENTOS_ANO = 3;
export const ART4_MAX_DIAS_VIOLACAO_ANO = 45;

export type Art4Status = "ok" | "alerta" | "violacao";

export interface Art4SerieDia {
  data_referencia: string;
  prazo_medio: number;
  limite_dias?: number;
}

export interface Art4Episodio {
  inicio: string;
  fim: string;
  dias: number;
  datas: string[];
}

export interface Art4ContadoresAno {
  eventos_ano: number;
  dias_violacao_ano: number;
  episodios: Art4Episodio[];
  dias_violacao: string[];
}

export function prazoMedioFromDetalhes(
  d: Record<string, unknown> | null | undefined,
  valorAtual?: number | null,
  limiteDias = 365,
): number | null {
  if (!d) return null;
  const pm = Number(d.prazo_medio_dias ?? d.prazo_medio_carteira);
  if (Number.isFinite(pm) && pm > 0) return pm;
  if (valorAtual != null && limiteDias > 0) {
    const v = Number(valorAtual) * limiteDias;
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/** Violação Art. 4º: prazo médio ≤ limite (carteira CP tributário). */
export function isArt4ViolacaoPrazo(prazoMedio: number, limiteDias: number): boolean {
  return prazoMedio <= limiteDias;
}

/** Sequências contíguas de dias com prazo médio ≤ limite. */
export function extrairEpisodiosArt4FromSeries(
  rows: Art4SerieDia[],
  limiteDias = 365,
): Art4Episodio[] {
  if (!rows.length) return [];

  const sorted = [...rows].sort((a, b) =>
    a.data_referencia.localeCompare(b.data_referencia),
  );

  const episodios: Art4Episodio[] = [];
  let current: Art4Episodio | null = null;

  for (const r of sorted) {
    const lim = r.limite_dias ?? limiteDias;
    const violacao = isArt4ViolacaoPrazo(r.prazo_medio, lim);
    if (violacao) {
      if (!current) {
        current = {
          inicio: r.data_referencia,
          fim: r.data_referencia,
          dias: 1,
          datas: [r.data_referencia],
        };
      } else {
        current.fim = r.data_referencia;
        current.dias += 1;
        current.datas.push(r.data_referencia);
      }
    } else if (current) {
      episodios.push(current);
      current = null;
    }
  }
  if (current) episodios.push(current);

  return episodios;
}

/** Episódios e dias em violação no ano-calendário (1 linha por data de posição). */
export function calcularContadoresAnoArt4FromSeries(
  rows: Art4SerieDia[],
  limiteDias = 365,
): Art4ContadoresAno {
  const episodios = extrairEpisodiosArt4FromSeries(rows, limiteDias);
  const dias_violacao = episodios.flatMap((e) => e.datas);

  return {
    eventos_ano: episodios.length,
    dias_violacao_ano: dias_violacao.length,
    episodios,
    dias_violacao,
  };
}

export function formatDataIsoBr(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return iso;
}

export function formatArt4EpisodioLabel(ep: Art4Episodio): string {
  const ini = formatDataIsoBr(ep.inicio);
  if (ep.dias <= 1) return ini;
  return `${ini} – ${formatDataIsoBr(ep.fim)} (${ep.dias}d)`;
}

export function art4EnquadramentoDisplay(status: Art4Status): {
  label: string;
  subtext: string;
  className: string;
} {
  if (status === "violacao") {
    return {
      label: "Não",
      subtext: "desenquadrado",
      className: "text-red-600 dark:text-red-400",
    };
  }
  if (status === "alerta") {
    return {
      label: "Sim",
      subtext: "zona de atenção",
      className: "text-amber-600 dark:text-amber-400",
    };
  }
  return {
    label: "Sim",
    subtext: "enquadrado",
    className: "text-emerald-600 dark:text-emerald-400",
  };
}

export function ymdPosicaoToIso(fundo_dtposicao: string): string | null {
  const ymd = fundo_dtposicao.replace(/\D/g, "").slice(0, 8);
  if (ymd.length !== 8) return null;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

export function rowArt4FromEnquadramentoResultado(row: {
  fundo_dtposicao: string;
  detalhes: unknown;
  valor_atual: number | null;
}): Art4SerieDia | null {
  const data_referencia = ymdPosicaoToIso(row.fundo_dtposicao);
  const d = row.detalhes as Record<string, unknown> | null;
  if (!data_referencia || !d) return null;

  const limite_dias = Number(d.limite_dias ?? 365);
  const prazo_medio = prazoMedioFromDetalhes(d, row.valor_atual, limite_dias);
  if (prazo_medio == null) return null;

  return { data_referencia, prazo_medio, limite_dias };
}
