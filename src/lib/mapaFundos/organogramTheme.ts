/**
 * Tokens visuais do organograma em colunas — extraídos de prototype/mapa_fundos_sigma.html
 * (computeFlowLayout + drawFlowMode).
 *
 * Cores de nó e aresta compartilhadas com os modos de rede via grupos.ts e mapaFundosTheme.ts.
 */

export const ORG = {
  CANVAS_BG: "#e2e8f0",
  COL_START_X: 100,
  COL_GAP_MAX: 300,
  COL_GAP_MARGIN: 180,
  ROW_GAP_MAX: 80,
  ROW_GAP_MIN: 52,
  ROW_AREA_MARGIN: 100,
  HEADER_H: 54,          // reserva vertical para cabeçalhos de coluna
  HEADER_Y: 30,          // y do texto do cabeçalho
  NODE_LABEL_OFFSET_X: 20,
  NODE_LABEL_OFFSET_Y: 5,
  PCT_ACUM_OFFSET_Y: 22,
  LABEL_RESERVE_RIGHT: 240,
  EDGE_INSET: 8,
  PANEL_WIDTH: 300,
  ROOT_R: 14,
  NODE_R: 11,
  /** Contorno branco nos rótulos — legibilidade sobre arestas. */
  TEXT_STROKE: "#ffffff",
  TEXT_STROKE_WIDTH_LABEL: 5,
  TEXT_STROKE_WIDTH_PCT: 4.5,
  TEXT_STROKE_WIDTH_EDGE: 5,
  PCT_LABEL: "#059669",
  PCT_LABEL_PASSIVO: "#1e40af",
  TEXT_BRIGHT: "#0f172a",
  TEXT_HEADER: "#334155",
  SEED_STROKE: "#0f172a",
  FONT_HEADER: "700 14px Inter, Segoe UI, system-ui, sans-serif",
  FONT_NODE_ROOT: "700 16px Inter, Segoe UI, system-ui, sans-serif",
  FONT_NODE: "700 14px Inter, Segoe UI, system-ui, sans-serif",
  FONT_PCT: "700 12px Inter, Segoe UI, system-ui, sans-serif",
  FONT_EDGE_PCT: "700 12px Inter, Segoe UI, system-ui, sans-serif",
  /** Zoom mínimo no fit inicial — evita texto ilegível por encolhimento excessivo. */
  FIT_MARGIN: 0.96,
  FIT_MIN_SCALE: 0.9,
  /** % mínimo na aresta para exibir rótulo de passo. */
  EDGE_PCT_LABEL_MIN: 0.01,
} as const;

/** Gap de colunas baseado na largura da viewport (fórmula do protótipo). */
export function computeColGap(viewportWidth: number, nCols: number): number {
  return Math.min(ORG.COL_GAP_MAX, (viewportWidth - ORG.COL_GAP_MARGIN) / Math.max(1, nCols - 1 || 1));
}

/** Gap de linhas baseado na altura disponível e no número de nós. */
export function computeRowGap(availableHeight: number, nRows: number): number {
  return Math.min(ORG.ROW_GAP_MAX, Math.max(ORG.ROW_GAP_MIN, availableHeight / Math.max(1, nRows)));
}

/** Rótulo do cabeçalho de coluna. */
export function headerLabel(level: number, direcao: "ativo" | "passivo"): string {
  if (level === 0) return "FUNDO ALVO";
  return direcao === "passivo" ? `NÍVEL ${level} (investidor)` : `NÍVEL ${level} (investido)`;
}

/** Formata percentual de passo direto de aresta (ex.: "4,1%"). */
export function fmtPctStep(v: number): string {
  return (v * 100).toFixed(1) + "%";
}

/** Formata percentual acumulado para exibição no nó/painel (ex.: "12,3% acum."). */
export function fmtPctAcum(v: number): string {
  return (v * 100).toFixed(1) + "% acum.";
}

/** Percentual acumulado compacto no organograma (sem sufixo "acum."). */
export function fmtPctAcumOrg(v: number): string {
  return (v * 100).toFixed(1) + "%";
}
