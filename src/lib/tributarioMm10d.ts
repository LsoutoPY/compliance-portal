/** MM-10d TRIB_FIQ_LP_90 — média aritmética simples (SMA) das últimas posições. */

export const TRIB_FIQ_MM_JANELA = 10;
export const TRIB_FIQ_MM_VERSAO = "sma10-v2";
export const TRIB_FIQ_MM_METODOLOGIA = "sma_10_posicoes";

/**
 * SMA regulatória: média dos p_dia da posição atual + até 9 posições anteriores.
 * Com janela incompleta (fundo novo), divide pelo nº de dias disponíveis.
 */
export function calcularMm10dSma(
  pDiaAtual: number,
  pDiaAnteriores: number[],
  janela = TRIB_FIQ_MM_JANELA,
): { mm_10d: number; n_dias_janela: number; janela_p_dia: number[] } {
  const valores = [
    pDiaAtual,
    ...pDiaAnteriores.slice(0, Math.max(0, janela - 1)),
  ].filter((v) => Number.isFinite(v));

  const n = valores.length;
  if (n === 0) {
    return { mm_10d: 0, n_dias_janela: 0, janela_p_dia: [] };
  }

  const soma = valores.reduce((s, v) => s + v, 0);
  return {
    mm_10d: soma / n,
    n_dias_janela: n,
    janela_p_dia: valores,
  };
}

const LIMITE_MM_DEFAULT = 90;

/** Contadores anuais a partir da série mm-10d (1 linha por data de posição). */
export function calcularContadoresAnoFromSeries(
  rows: { data_referencia: string; mm_10d: number }[],
  limiteMm = LIMITE_MM_DEFAULT,
): { eventos_ano: number; dias_violacao_ano: number } {
  if (!rows.length) return { eventos_ano: 0, dias_violacao_ano: 0 };

  const sorted = [...rows].sort((a, b) =>
    a.data_referencia.localeCompare(b.data_referencia),
  );

  let eventos_ano = 0;
  let dias_violacao_ano = 0;
  let emBloco = false;

  for (const r of sorted) {
    const mm = Number(r.mm_10d);
    const violacao = Number.isFinite(mm) && mm < limiteMm;
    if (violacao) {
      dias_violacao_ano += 1;
      if (!emBloco) {
        eventos_ano += 1;
        emBloco = true;
      }
    } else {
      emBloco = false;
    }
  }

  return { eventos_ano, dias_violacao_ano };
}

/**
 * Recalcula mm-10d para cada data a partir da série de p_dia (SMA rolling).
 * Garante consistência visual mesmo quando mm_10d gravada no banco está defasada.
 */
export function recalcularSerieMm10dSma(
  rows: { data_referencia: string; p_dia: number }[],
  janela = TRIB_FIQ_MM_JANELA,
): Map<string, { mm_10d: number; n_dias_janela: number }> {
  const sorted = [...rows].sort((a, b) =>
    a.data_referencia.localeCompare(b.data_referencia),
  );
  const out = new Map<string, { mm_10d: number; n_dias_janela: number }>();
  const buffer: number[] = [];

  for (const r of sorted) {
    const p = Number(r.p_dia);
    if (!Number.isFinite(p)) continue;
    buffer.push(p);
    if (buffer.length > janela) buffer.shift();
    const n = buffer.length;
    out.set(r.data_referencia, {
      mm_10d: buffer.reduce((s, v) => s + v, 0) / n,
      n_dias_janela: n,
    });
  }

  return out;
}

/** Aplica SMA recalculada sobre linhas de histórico já mescladas. */
export function aplicarMm10dRecalculada<
  T extends { data_referencia: string; p_dia: number; mm_10d: number; em_violacao?: boolean },
>(rows: T[], limiteMm = LIMITE_MM_DEFAULT): T[] {
  const mmMap = recalcularSerieMm10dSma(rows);
  return rows.map((r) => {
    const rec = mmMap.get(r.data_referencia);
    if (!rec) return r;
    return {
      ...r,
      mm_10d: rec.mm_10d,
      em_violacao: rec.mm_10d < limiteMm,
    };
  });
}
