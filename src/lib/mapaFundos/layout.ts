/**
 * Layout da rede de fundos (modos somente-revelado / rede-completa):
 *   force-directed orgânico (computeForceLayout).
 *
 * Organograma em colunas: computeOrganogramLayout (layout fixo por nível).
 */

import { buildFundoDisplayKey } from "./keys";
import { computeForceLayout, type ForceLayoutEdge } from "./forceLayout";
import { ORG, computeColGap, computeRowGap } from "./organogramTheme";

/** @deprecated Anéis concêntricos — mantido para referência/testes. */
export function computeLayoutCircular(
  fundoCnpjs: string[],
  ativoKeys: string[],
  width = 1000,
  height = 700,
): Map<string, { x: number; y: number }> {
  const cx = width / 2;
  const cy = height / 2;
  const base = Math.min(width, height);

  function circleLayout(
    keys: string[],
    radius: number,
  ): Map<string, { x: number; y: number }> {
    const sorted = [...keys].sort();
    const pos = new Map<string, { x: number; y: number }>();
    sorted.forEach((key, i) => {
      const angle = (2 * Math.PI * i) / Math.max(sorted.length, 1) - Math.PI / 2;
      pos.set(key, {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      });
    });
    return pos;
  }

  const fundoDisplayKeys = fundoCnpjs.map(buildFundoDisplayKey);
  const inner = circleLayout(fundoDisplayKeys, base * 0.3);
  const outer = circleLayout(ativoKeys, base * 0.46);
  return new Map([...inner, ...outer]);
}

/**
 * Layout force-directed: hubs perto do centro, vizinhos conectados agrupados.
 */
export function computeLayout(
  fundoCnpjs: string[],
  ativoKeys: string[],
  arestas: ForceLayoutEdge[] = [],
  width = 1000,
  height = 700,
): Map<string, { x: number; y: number }> {
  const fundoDisplayKeys = fundoCnpjs.map(buildFundoDisplayKey);
  const allKeys = [...fundoDisplayKeys, ...ativoKeys];
  return computeForceLayout(allKeys, arestas, width, height);
}

export interface OrganogramLayoutOptions {
  minColWidth?: number;
  minRowHeight?: number;
  padding?: number;
}

export interface OrganogramLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  contentWidth: number;
  contentHeight: number;
  /** colGap entre colunas consecutivas (= colWidth para compatibilidade). */
  colWidth: number;
  /** Gap de linha por coluna (coluna → px) */
  rowHeightByCol: number[];
}

/**
 * Organograma em colunas usando as fórmulas do protótipo mapa_fundos_sigma.html.
 *
 * - x = COL_START_X + colIdx * colGap  (inicia em x=90, não centrado)
 * - y = HEADER_H + (disponível/2) - (totalH/2) + rowIdx * rowGap  (centralizado verticalmente)
 * - opts preservado para compatibilidade mas ignorado — ORG theme governa.
 */
export function computeOrganogramLayout(
  niveisNos: string[][],
  viewportWidth: number,
  viewportHeight: number,
  _opts: OrganogramLayoutOptions = {},
): OrganogramLayoutResult {
  const positions = new Map<string, { x: number; y: number }>();
  const nCols = niveisNos.length;

  if (nCols === 0) {
    return { positions, contentWidth: viewportWidth, contentHeight: viewportHeight, colWidth: 0, rowHeightByCol: [] };
  }

  const colGap = computeColGap(viewportWidth, nCols);
  const maxRows = Math.max(1, ...niveisNos.map((c) => c.length));
  // Garante altura mínima: ROW_GAP_MIN por linha + header + margem
  const minRequiredH = ORG.HEADER_H + maxRows * ORG.ROW_GAP_MIN + 60;
  const effectiveH = Math.max(viewportHeight, minRequiredH);
  const availH = effectiveH - ORG.HEADER_H;
  const globalRowGap = computeRowGap(availH, maxRows);

  const rowHeightByCol: number[] = [];

  niveisNos.forEach((keys, colIdx) => {
    const nRows = Math.max(keys.length, 1);
    const colAvailH = Math.max(effectiveH - ORG.HEADER_H, nRows * ORG.ROW_GAP_MIN);
    const rowGap = computeRowGap(colAvailH, nRows);
    rowHeightByCol[colIdx] = rowGap;
    const totalH = rowGap * (nRows - 1);
    const startY = ORG.HEADER_H + colAvailH / 2 - totalH / 2;
    const x = ORG.COL_START_X + colIdx * colGap;

    keys.forEach((key, rowIdx) => {
      positions.set(key, { x, y: startY + rowIdx * rowGap });
    });
  });

  const lastX = ORG.COL_START_X + (nCols - 1) * colGap;
  const contentWidth = Math.max(viewportWidth, lastX + ORG.COL_START_X + ORG.LABEL_RESERVE_RIGHT);
  const contentHeight = Math.max(effectiveH, ORG.HEADER_H + maxRows * globalRowGap + 50);

  return {
    positions,
    contentWidth,
    contentHeight,
    colWidth: colGap,
    rowHeightByCol,
  };
}

/** Escala para caber o organograma na viewport (≤ 1). */
export function calcOrganogramFitScale(
  contentWidth: number,
  contentHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 0.94,
): number {
  if (contentWidth <= 0 || contentHeight <= 0) return 1;
  return Math.min(
    (viewportWidth / contentWidth) * margin,
    (viewportHeight / contentHeight) * margin,
    1,
  );
}
