/** Métricas tributárias FIQ (Art. 5º) — merge detalhes + histórico */

export interface TributarioHistoricoSnapshot {
  data_referencia: string;
  p_dia: number;
  mm_10d: number;
  em_violacao?: boolean;
  eventos_ano: number;
  dias_violacao_ano: number;
  valor_lp?: number | null;
  valor_cp?: number | null;
  valor_excluido?: number | null;
  pl_total?: number | null;
}

export interface TributarioDisplayMetrics {
  p_dia: number;
  mm_10d: number;
  valor_lp: number;
  valor_cp: number;
  valor_excluido: number;
  patliq: number;
  denominador: number;
  eventos_ano: number;
  dias_violacao_ano: number;
  pctLP: number;
  pctCP: number;
  pctExc: number;
  hasData: boolean;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Resolve métricas para exibição: detalhes do check + fallback do histórico MM-10d. */
export function resolveTributarioMetrics(
  detalhes: Record<string, unknown> | null | undefined,
  histRow: TributarioHistoricoSnapshot | null | undefined,
  valorAtual: number | null,
): TributarioDisplayMetrics {
  const p_dia =
    num(detalhes?.p_dia) ??
    num(histRow?.p_dia) ??
    0;

  const mm_10d =
    num(detalhes?.mm_10d) ??
    num(histRow?.mm_10d) ??
    (valorAtual != null ? valorAtual * 100 : null) ??
    p_dia;

  const valor_lp = num(detalhes?.valor_lp) ?? num(histRow?.valor_lp) ?? 0;
  const valor_cp = num(detalhes?.valor_cp) ?? num(histRow?.valor_cp) ?? 0;
  const valor_excluido =
    num(detalhes?.valor_excluido) ?? num(histRow?.valor_excluido) ?? 0;
  const patliq =
    num(detalhes?.patliq) ??
    num(detalhes?.pl_total) ??
    num(histRow?.pl_total) ??
    1;

  const denominador = num(detalhes?.denominador) ?? patliq;

  const eventos_ano =
    num(detalhes?.eventos_ano) ?? num(histRow?.eventos_ano) ?? 0;
  const dias_violacao_ano =
    num(detalhes?.dias_violacao_ano) ?? num(histRow?.dias_violacao_ano) ?? 0;

  // Cartões LP/CP/Excluído: % sobre o PL (mesma base do administrador)
  const pctLP =
    num(detalhes?.p_dia) ??
    num(histRow?.p_dia) ??
    (patliq > 0 ? (valor_lp / patliq) * 100 : 0);
  const pctCP = patliq > 0 ? (valor_cp / patliq) * 100 : 0;
  const pctExc = patliq > 0 ? (valor_excluido / patliq) * 100 : 0;

  const hasData =
    num(detalhes?.p_dia) != null ||
    num(histRow?.p_dia) != null ||
    valorAtual != null;

  return {
    p_dia,
    mm_10d,
    valor_lp,
    valor_cp,
    valor_excluido,
    patliq,
    denominador,
    eventos_ano,
    dias_violacao_ano,
    pctLP,
    pctCP,
    pctExc,
    hasData,
  };
}

/** p do dia — coluna VALOR ATUAL (fração 0–1 comparada ao limite 90%). */
export function tributarioPDiaDisplay(
  detalhes: Record<string, unknown> | null | undefined,
  histRow: TributarioHistoricoSnapshot | null | undefined,
): number | null {
  const p = num(detalhes?.p_dia) ?? num(histRow?.p_dia);
  return p != null ? p / 100 : null;
}

/** MM-10d — indicador regulatório de status (fração 0–1). */
export function tributarioMm10dDisplay(
  detalhes: Record<string, unknown> | null | undefined,
  histRow: TributarioHistoricoSnapshot | null | undefined,
  valorAtual: number | null,
): number | null {
  const mm = num(detalhes?.mm_10d) ?? num(histRow?.mm_10d);
  if (mm != null) return mm / 100;
  return valorAtual;
}

/** @deprecated Use tributarioPDiaDisplay (coluna) ou tributarioMm10dDisplay (MM-10d). */
export const tributarioValorAtualDisplay = tributarioMm10dDisplay;
