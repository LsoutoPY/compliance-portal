import ExcelJS from "npm:exceljs@4.4.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

type RuleStatus = "ok" | "alerta" | "violacao";

interface ExportAtivoVertice {
  nome: string;
  valor: number;
  prazo: number;
  fonte?: string;
  look_through_detalhes?: Array<{ nome: string; valor: number; pct: number; data_liquidez: string; dias: number }>;
}

interface ExportVerticeRow {
  vertice: number;
  ativoVertice: number;
  probabilidade: number;
  ativoAcumulado: number;
  passivoNoVertice: number;
  resgatesSolicitados?: number | null;
  passivoAcumulado: number;
  indice: number;
  status: RuleStatus;
  indiceAcumulado: number;
  estadoAcumulado: RuleStatus;
  statusConsolidado: RuleStatus;
  ativosNoVertice: ExportAtivoVertice[];
}

interface ExportWalletAsset {
  section: string;
  nome: string;
  cnpj?: string | null;
  valor: number;
  prazo_dias: number | null;
  vertice: number | null;
  validado?: boolean;
}

interface ExportResgateRow {
  fundo: string;
  cotista: string;
  data_impacto: string;
  valor: number;
  tipo_movimento: string | null;
  dias_ate_pagamento: number | null;
}

interface ExportFundoFechadoAnalise {
  dispPL: number;
  disponibilidade: number;
  prazoResgate: number | null;
  status: RuleStatus;
  mesesCobertura: number | null;
  caixaLiquido: number;
  darfEstimado: number;
  despesaOperacionalMensal: number | null;
  statusCoberturaDespesa: RuleStatus | "indisponivel";
  hardThreshold: number;
  softThreshold: number;
}

interface ExportFundoInfo {
  nomeFundo: string;
  cnpj: string;
  dataBase: string;
  administrador: string;
  tipo: string;
  pl: number;
  prazoResgate: number | null;
  worstStatus: RuleStatus;
  classe: string;
  segmento: string;
  metrica: string;
  fundoFechadoAnalise?: ExportFundoFechadoAnalise | null;
}

interface StressExportInfo {
  choque: number;
  piso20: number;
  somaCotistasTop3: number;
  nCotistasTop3: number;
  binding: "piso20" | "cap20";
  prazoVertice: number;
  passivoSemStress: number;
  passivoComStress: number;
  indiceComStress: number;
}

interface AtivoComPrazoRow {
  id?: string;
  nome?: string;
  valor?: number;
  prazos_em_dias?: number | null;
  vertice?: number | null;
  section?: string;
}

interface CalculoLiquidezData {
  totalPL?: number;
  isFundoFechado?: boolean;
  worstStatus?: RuleStatus;
  tabelaVertices?: ExportVerticeRow[];
  fundoFechadoAnalise?: Record<string, unknown> | null;
  mainFundChar?: { prazo_pagamento_resgate_dias?: number | null };
  ativosComPrazo?: AtivoComPrazoRow[];
}

// ── Paleta de cores (ARGB) ────────────────────────────────────────────────────
const C = {
  GREEN_DARK:   "FF00734A",  // marca verde escuro
  GRAY_HEAD:    "FF5B6066",  // cinza escuro cabeçalho
  GRAY_SECTION: "FF8B8B8B",  // cinza médio seção
  GRAY_SUB:     "FFF2F4F6",  // fundo sub-linha ativo
  GRAY_ALT:     "FFF9FAFB",  // fundo linha alternada
  WHITE:        "FFFFFFFF",
  INK:          "FF1A1A2E",  // texto escuro
  INK_LIGHT:    "FF5B6066",  // texto cinza
  OK_BG:        "FFE6F9F1",
  OK_FG:        "FF00734A",
  SOFT_BG:      "FFFEF3CD",
  SOFT_FG:      "FF856404",
  HARD_BG:      "FFFDECEA",
  HARD_FG:      "FFC0392B",
  BORDER:       "FFD1D5DB",
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const thin: ExcelJS.Border = { style: "thin", color: { argb: C.BORDER } };
const borders = { top: thin, left: thin, bottom: thin, right: thin };

function statusInfo(s: string): { label: string; bg: string; fg: string } {
  if (s === "ok")       return { label: "Enquadrado", bg: C.OK_BG,   fg: C.OK_FG   };
  if (s === "alerta")   return { label: "Soft Limit", bg: C.SOFT_BG, fg: C.SOFT_FG };
  if (s === "violacao") return { label: "Hard Limit", bg: C.HARD_BG, fg: C.HARD_FG };
  return { label: "—", bg: C.WHITE, fg: C.INK };
}

function applyFill(cell: ExcelJS.Cell, argb: string) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function applyBorderAll(row: ExcelJS.Row, fromCol: number, toCol: number) {
  for (let c = fromCol; c <= toCol; c++) {
    row.getCell(c).border = borders;
  }
}

function brlFmt(v: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency", currency: "BRL", maximumFractionDigits: 2,
  }).format(v);
}

function formatIndiceCell(value: unknown): string | number {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n > 999) return 999;
  return +n.toFixed(4);
}

/** data_liquidez_prevista — YYYY-MM-DD ou YYYYMMDD → DD/MM/AAAA */
function formatDataLiquidezPrevistaExcel(dataLiquidez: string | undefined): string {
  const s = String(dataLiquidez ?? "").trim();
  if (!s) return "—";
  if (/^\d{8}$/.test(s)) return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  return s;
}

// ── Estilo de linha de cabeçalho de tabela ─────────────────────────────────
function styleHeaderRow(row: ExcelJS.Row, nCols: number) {
  for (let c = 1; c <= nCols; c++) {
    const cell = row.getCell(c);
    applyFill(cell, C.GRAY_HEAD);
    cell.font  = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = borders;
  }
  row.height = 28;
}

// ── Estilo de linha de dado (vértice) ──────────────────────────────────────
function styleVertexRow(row: ExcelJS.Row, nCols: number, isAlt: boolean) {
  for (let c = 1; c <= nCols; c++) {
    const cell = row.getCell(c);
    applyFill(cell, isAlt ? C.GRAY_ALT : C.WHITE);
    cell.font   = { size: 9, name: "Calibri", color: { argb: C.INK } };
    cell.border = borders;
  }
  row.height = 18;
}

// ── Estilo de sub-linha de ativo ──────────────────────────────────────────
function styleAssetRow(row: ExcelJS.Row, nCols: number) {
  for (let c = 1; c <= nCols; c++) {
    const cell = row.getCell(c);
    applyFill(cell, C.GRAY_SUB);
    cell.font   = { size: 8, italic: true, name: "Calibri", color: { argb: C.INK_LIGHT } };
    cell.border = { top: thin, left: thin, bottom: thin, right: thin };
  }
  row.height = 16;
}

// ── Tipo de stress ─────────────────────────────────────────────────────────────
export interface StressExportInfo {
  /** Choque em R$ somado ao passivo do vértice do prazo (sempre = piso20). */
  choque: number;
  /** 20% do PL. */
  piso20: number;
  /** Soma bruta dos top 3 cotistas (pode ser maior ou menor que piso20). */
  somaCotistasTop3: number;
  /** Quantos cotistas entram (0–3). */
  nCotistasTop3: number;
  /** "cap20" quando top3 > 20% PL; "piso20" nos demais casos. */
  binding: "piso20" | "cap20";
  /** Vértice D+N do prazo do fundo onde o choque é aplicado. */
  prazoVertice: number;
  /** Passivo original nesse vértice (sem stress). */
  passivoSemStress: number;
  /** Passivo + choque stress nesse vértice. */
  passivoComStress: number;
  /** Índice ativo/passivo calculado com o stress. */
  indiceComStress: number;
}

// Paleta extra para stress
const CS = {
  STRESS_BG:  "FFFFF3CD",  // âmbar claro
  STRESS_FG:  "FF856404",  // âmbar escuro
  STRESS_HDR: "FFD97706",  // cabeçalho âmbar
};

// ── Exportação principal ──────────────────────────────────────────────────────
async function buildLiquidezExcelWorkbook(
  info: ExportFundoInfo,
  vertices: ExportVerticeRow[],
  wallet: ExportWalletAsset[],
  resgates: ExportResgateRow[] | undefined,
  stressInfo: StressExportInfo | undefined,
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator  = "CVPAR Quadrante";
  wb.created  = new Date();
  wb.modified = new Date();

  // ────────────────────────────────────────────────────────────────
  // Aba 1 — RESUMO
  // ────────────────────────────────────────────────────────────────
  const wsR = wb.addWorksheet("Resumo", { properties: { tabColor: { argb: C.GREEN_DARK.replace("FF", "") } } });
  wsR.columns = [{ width: 30 }, { width: 55 }];

  const addTitle = (ws: ExcelJS.Worksheet, title: string) => {
    const r = ws.addRow([title]);
    ws.mergeCells(r.number, 1, r.number, 2);
    applyFill(r.getCell(1), C.GREEN_DARK);
    r.getCell(1).font = { bold: true, color: { argb: C.WHITE }, size: 11, name: "Calibri" };
    r.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
    r.height = 24;
  };

  const addSection = (ws: ExcelJS.Worksheet, label: string) => {
    const r = ws.addRow([label]);
    ws.mergeCells(r.number, 1, r.number, 2);
    applyFill(r.getCell(1), C.GRAY_HEAD);
    r.getCell(1).font = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
    r.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
    r.height = 20;
  };

  const addKV = (ws: ExcelJS.Worksheet, key: string, value: string | number) => {
    const r = ws.addRow([key, value]);
    applyFill(r.getCell(1), "FFF3F4F6");
    r.getCell(1).font = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    r.getCell(2).font = { size: 9, name: "Calibri", color: { argb: C.INK } };
    r.getCell(1).border = borders;
    r.getCell(2).border = borders;
    r.height = 16;
  };

  const worstSt = statusInfo(info.worstStatus);
  let worst: "ok" | "alerta" | "violacao" = "ok";
  let nSoft = 0, nHard = 0;
  for (const v of vertices) {
    if (v.statusConsolidado === "violacao") worst = "violacao";
    else if (v.statusConsolidado === "alerta" && worst !== "violacao") worst = "alerta";
    if (v.statusConsolidado === "alerta") nSoft++;
    if (v.statusConsolidado === "violacao") nHard++;
  }
  const nOK = vertices.filter(v => v.statusConsolidado === "ok").length;

  addTitle(wsR, "RELATÓRIO DE RISCO DE LIQUIDEZ — CVPAR QUADRANTE");
  wsR.addRow([]);
  addSection(wsR, "IDENTIFICAÇÃO DO FUNDO");
  addKV(wsR, "Nome do Fundo",       info.nomeFundo);
  addKV(wsR, "CNPJ",                info.cnpj);
  addKV(wsR, "Data Base",           info.dataBase);
  addKV(wsR, "Administrador",       info.administrador || "—");
  addKV(wsR, "Tipo",                info.tipo);
  addKV(wsR, "Patrimônio Líquido",  brlFmt(info.pl));
  addKV(wsR, "Prazo de Resgate",    info.prazoResgate != null ? `D+${info.prazoResgate}` : "—");
  const stRow = wsR.addRow(["Status de Liquidez", worstSt.label]);
  applyFill(stRow.getCell(1), "FFF3F4F6");
  applyFill(stRow.getCell(2), worstSt.bg);
  stRow.getCell(1).font = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
  stRow.getCell(2).font = { bold: true, size: 9, name: "Calibri", color: { argb: worstSt.fg } };
  stRow.getCell(1).border = borders;
  stRow.getCell(2).border = borders;
  stRow.height = 16;
  wsR.addRow([]);

  const ffa = info.fundoFechadoAnalise;
  if (ffa) {
    const coverLabel = (s: string) =>
      s === "ok" ? "Enquadrado" : s === "alerta" ? "Soft Limit" : s === "violacao" ? "Hard Limit" : "Indisponível";

    addSection(wsR, "AMORTIZAÇÃO — DISPONIBILIDADE");
    addKV(wsR, "Disp. / PL",         `${(ffa.dispPL * 100).toFixed(2)}%`);
    addKV(wsR, "Disponibilidade",    brlFmt(ffa.disponibilidade));
    addKV(wsR, "Prazo Resgate",      ffa.prazoResgate != null ? `D+${ffa.prazoResgate}` : "—");
    addKV(wsR, "Status Amortização", coverLabel(ffa.status));
    const amortSt = statusInfo(ffa.status);
    const amortRow = wsR.lastRow!;
    applyFill(amortRow.getCell(2), amortSt.bg);
    amortRow.getCell(2).font = { bold: true, size: 9, name: "Calibri", color: { argb: amortSt.fg } };
    addKV(wsR, "Limiar Hard",        `${(ffa.hardThreshold * 100).toFixed(1)}%`);
    addKV(wsR, "Limiar Soft",        `${(ffa.softThreshold * 100).toFixed(1)}%`);

    wsR.addRow([]);
    addSection(wsR, "COBERTURA OPERACIONAL");
    addKV(wsR, "Caixa Líquido",    brlFmt(ffa.caixaLiquido));
    addKV(wsR, "DARF Estimado",    brlFmt(ffa.darfEstimado));
    addKV(wsR, "Despesa Mensal",   ffa.despesaOperacionalMensal != null ? brlFmt(ffa.despesaOperacionalMensal) : "Não cadastrada");
    addKV(wsR, "Meses Cobertura",  ffa.mesesCobertura != null ? ffa.mesesCobertura.toFixed(1) : "—");
    addKV(wsR, "Status Cobertura", coverLabel(ffa.statusCoberturaDespesa));
    if (ffa.statusCoberturaDespesa !== "indisponivel") {
      const coverSt = statusInfo(ffa.statusCoberturaDespesa as string);
      const coverRow = wsR.lastRow!;
      applyFill(coverRow.getCell(2), coverSt.bg);
      coverRow.getCell(2).font = { bold: true, size: 9, name: "Calibri", color: { argb: coverSt.fg } };
    }
  } else {
    addSection(wsR, "PARÂMETROS ANBIMA");
    addKV(wsR, "Classe",    info.classe);
    addKV(wsR, "Segmento",  info.segmento);
    addKV(wsR, "Métrica",   info.metrica);
  }

  wsR.addRow([]);
  addSection(wsR, "RESUMO DE VÉRTICES");
  addKV(wsR, "Total de Vértices",   vertices.length);
  addKV(wsR, "Vértices Enquadrados (OK)", nOK);
  addKV(wsR, "Vértices Soft Limit", nSoft);
  addKV(wsR, "Vértices Hard Limit", nHard);

  // ── Seção de Stress (somente fundos abertos com info) ────────────────
  if (stressInfo && !info.fundoFechadoAnalise) {
    wsR.addRow([]);
    // Título colorido âmbar
    const stHdr = wsR.addRow(["CENÁRIO DE STRESS DE LIQUIDEZ"]);
    wsR.mergeCells(stHdr.number, 1, stHdr.number, 2);
    applyFill(stHdr.getCell(1), CS.STRESS_HDR);
    stHdr.getCell(1).font = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
    stHdr.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
    stHdr.height = 20;

    const si = stressInfo;
    const top3PctStr = info.pl > 0 ? `${((si.somaCotistasTop3 / info.pl) * 100).toFixed(1)}%` : "—";

    addKV(wsR, "Metodologia", "Top 3 cotistas · teto em 20% do PL");
    addKV(wsR, "Vértice afetado", `D+${si.prazoVertice}`);
    addKV(wsR, "PL do Fundo", brlFmt(info.pl));
    addKV(wsR, "20% do PL (piso / teto)", brlFmt(si.piso20));
    addKV(wsR, `Top ${si.nCotistasTop3} cotistas — soma bruta`, `${brlFmt(si.somaCotistasTop3)} (${top3PctStr} do PL)`);
    addKV(wsR, "Situação",
      si.binding === "cap20"
        ? "Top 3 cotistas excederam 20% do PL → teto aplicado"
        : "Top 3 cotistas abaixo de 20% do PL → piso aplicado"
    );
    addKV(wsR, "Choque aplicado (R$)", brlFmt(si.choque));
    addKV(wsR, "Passivo sem Stress (vértice prazo)", brlFmt(si.passivoSemStress));
    addKV(wsR, "Passivo com Stress (vértice prazo)", brlFmt(si.passivoComStress));
    const idxStRow = wsR.addRow(["Índice (Ativo/Passivo) com Stress", si.indiceComStress > 999 ? ">999" : si.indiceComStress.toFixed(4)]);
    applyFill(idxStRow.getCell(1), "FFF3F4F6");
    idxStRow.getCell(1).font = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    idxStRow.getCell(2).font = { bold: true, size: 9, name: "Calibri", color: { argb: si.indiceComStress >= 1 ? C.OK_FG : C.HARD_FG } };
    idxStRow.getCell(1).border = borders; idxStRow.getCell(2).border = borders;
    idxStRow.height = 16;

    // Nota explicativa
    wsR.addRow([]);
    const notaRow = wsR.addRow([
      "Nota:",
      "O choque de stress (20% do PL) é somado ao passivo do vértice D+" + si.prazoVertice +
      ". Representa o resgate potencial dos 3 maiores cotistas, limitado a 20% do PL. " +
      "Cotistas com participação > 20% do PL são truncados nesse teto. " +
      "Se a soma dos top 3 for inferior a 20%, o piso de 20% garante o cenário mínimo.",
    ]);
    notaRow.getCell(1).font = { bold: true, size: 8, name: "Calibri", color: { argb: CS.STRESS_FG } };
    notaRow.getCell(2).font = { italic: true, size: 8, name: "Calibri", color: { argb: C.INK_LIGHT } };
    notaRow.getCell(2).alignment = { wrapText: true };
    notaRow.height = 44;
  }

  wsR.addRow([]);
  addKV(wsR, "Gerado em", new Date().toLocaleString("pt-BR"));

  // ────────────────────────────────────────────────────────────────
  // Aba 2 — VÉRTICE A VÉRTICE (apenas para fundos abertos)
  // ────────────────────────────────────────────────────────────────
  if (!info.fundoFechadoAnalise) {
  const wsV = wb.addWorksheet("Vértice a Vértice");

  // Cabeçalhos das colunas
  const VT_COLS = [
    { header: "Vértice",                 width: 12 },
    { header: "Ativo no Vértice (R$)",   width: 22 },
    { header: "Ativo Acum. (R$)",        width: 22 },
    { header: "Prob. Resgate %",         width: 14 },
    { header: "Passivo no Vértice (R$)", width: 22 },
    { header: "Passivo Acum. (R$)",      width: 22 },
    { header: "Resgates Sol. (R$)",      width: 20 },
    { header: "Índice",                  width: 10 },
    { header: "Status",                  width: 14 },
    { header: "Índice Acum.",            width: 13 },
    { header: "Consolidado",             width: 14 },
    // Colunas de stress (preenchidas apenas na linha do prazo do fundo)
    { header: "Choque Stress (R$)",      width: 22 },
    { header: "Passivo c/ Stress (R$)",  width: 22 },
    { header: "Índice c/ Stress",        width: 14 },
    { header: "Status c/ Stress",        width: 16 },
  ];
  // Se não há stressInfo, remove as 4 colunas de stress (últimas)
  const activeCols = stressInfo ? VT_COLS : VT_COLS.slice(0, VT_COLS.length - 4);
  wsV.columns = activeCols.map(c => ({ header: c.header, width: c.width }));

  const vtHead = wsV.addRow(activeCols.map(c => c.header));
  styleHeaderRow(vtHead, activeCols.length);
  // Colore cabeçalhos das colunas de stress em âmbar
  if (stressInfo) {
    const stressStartCol = activeCols.length - 3; // col 12
    for (let c = stressStartCol; c <= activeCols.length; c++) {
      applyFill(vtHead.getCell(c), CS.STRESS_HDR);
      vtHead.getCell(c).font = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
    }
  }
  // Oculta a linha de cabeçalho gerada automaticamente pelo columns
  wsV.spliceRows(1, 1);

  let altIdx = 0;
  for (const v of vertices) {
    const vLabel = v.vertice === 1260 ? "D+720+" : `D+${v.vertice}`;
    const resg = v.resgatesSolicitados && v.resgatesSolicitados > 0
      ? v.resgatesSolicitados : null;
    const isAlt = altIdx % 2 !== 0;
    const isPrazoStress = stressInfo != null && v.vertice === stressInfo.prazoVertice;

    // ── Linha do vértice (colunas base)
    const baseValues: (string | number | null | undefined)[] = [
      vLabel,
      v.ativoVertice,
      v.ativoAcumulado,
      v.probabilidade,
      v.passivoNoVertice,
      v.passivoAcumulado,
      resg,
      formatIndiceCell(v.indice),
      statusInfo(v.status).label,
      formatIndiceCell(v.indiceAcumulado),
      statusInfo(v.statusConsolidado).label,
    ];

    // ── Colunas de stress (apenas na linha do prazo)
    if (stressInfo) {
      if (isPrazoStress) {
        const idxSt = stressInfo.indiceComStress;
        const stStatus = idxSt >= 1 ? "Enquadrado" : idxSt >= 0.8 ? "Soft Limit" : "Hard Limit";
        baseValues.push(stressInfo.choque);
        baseValues.push(stressInfo.passivoComStress);
        baseValues.push(idxSt > 999 ? 999 : +idxSt.toFixed(4));
        baseValues.push(stStatus);
      } else {
        baseValues.push("—", "—", "—", "—");
      }
    }

    const vRow = wsV.addRow(baseValues);

    styleVertexRow(vRow, activeCols.length, isAlt);

    // ── Destaque especial para linha do prazo do fundo ─────────────
    const isPrazoFundo = info.prazoResgate != null && v.vertice === info.prazoResgate;
    if (isPrazoFundo) {
      const prazoSt = statusInfo(v.statusConsolidado);
      // Fundo levemente colorido em todas as colunas exceto status (que já tem cor)
      const PRAZO_BG_MAP: Record<string, string> = {
        [C.OK_BG]:   "FFD4F0E3",  // verde mais intenso
        [C.SOFT_BG]: "FFFDE7A5",  // amarelo mais intenso
        [C.HARD_BG]: "FFFBC8C4",  // vermelho mais intenso
      };
      const prazoBg = PRAZO_BG_MAP[prazoSt.bg] ?? "FFE8F5FF";
      for (let c = 1; c <= activeCols.length; c++) {
        if (c !== 9 && c !== 11) applyFill(vRow.getCell(c), prazoBg);
      }
      // Vértice em negrito com rótulo "← Prazo"
      vRow.getCell(1).value = `${vLabel}  ← Prazo Fundo`;
      vRow.getCell(1).font = { bold: true, size: 9, name: "Calibri", color: { argb: prazoSt.fg }, italic: true };
      // Borda superior mais grossa para sinalizar a linha
      for (let c = 1; c <= activeCols.length; c++) {
        const cell = vRow.getCell(c);
        cell.border = {
          top:    { style: "medium", color: { argb: prazoSt.fg } },
          left:   thin,
          bottom: { style: "medium", color: { argb: prazoSt.fg } },
          right:  thin,
        };
      }
      vRow.height = 20;
    }

    // ── Formatação das colunas de stress na linha do prazo ──────────
    if (isPrazoStress && stressInfo) {
      const c12 = activeCols.length - 3; // "Choque Stress"
      const c13 = activeCols.length - 2; // "Passivo c/ Stress"
      const c14 = activeCols.length - 1; // "Índice c/ Stress"
      const c15 = activeCols.length;     // "Status c/ Stress"
      [c12, c13, c14, c15].forEach(c => applyFill(vRow.getCell(c), CS.STRESS_BG));
      vRow.getCell(c12).numFmt = '"R$" #,##0.00'; vRow.getCell(c12).alignment = { horizontal: "right" };
      vRow.getCell(c12).font = { bold: true, size: 9, name: "Calibri", color: { argb: CS.STRESS_FG } };
      vRow.getCell(c13).numFmt = '"R$" #,##0.00'; vRow.getCell(c13).alignment = { horizontal: "right" };
      vRow.getCell(c13).font = { bold: true, size: 9, name: "Calibri", color: { argb: CS.STRESS_FG } };
      vRow.getCell(c14).numFmt = "0.0000"; vRow.getCell(c14).alignment = { horizontal: "center" };
      vRow.getCell(c14).font = { bold: true, size: 9, name: "Calibri", color: { argb: CS.STRESS_FG } };
      const idxSt = stressInfo.indiceComStress;
      const stStatusFg = idxSt >= 1 ? C.OK_FG : idxSt >= 0.8 ? C.SOFT_FG : C.HARD_FG;
      const stStatusBg = idxSt >= 1 ? C.OK_BG : idxSt >= 0.8 ? C.SOFT_BG : C.HARD_BG;
      applyFill(vRow.getCell(c15), stStatusBg);
      vRow.getCell(c15).font = { bold: true, size: 9, name: "Calibri", color: { argb: stStatusFg } };
      vRow.getCell(c15).alignment = { horizontal: "center" };
    }

    altIdx++;

    // Formatação de células
    if (!isPrazoFundo) {
      vRow.getCell(1).font = { bold: true, size: 9, name: "Calibri" };
    }
    vRow.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
    // Monetários (col 2,3,5,6,7)
    [2, 3, 5, 6].forEach(c => {
      const cell = vRow.getCell(c);
      cell.numFmt = '"R$" #,##0.00';
      cell.alignment = { horizontal: "right" };
    });
    if (resg) {
      vRow.getCell(7).numFmt = '"R$" #,##0.00';
      vRow.getCell(7).alignment = { horizontal: "right" };
    } else {
      vRow.getCell(7).value = "—";
      vRow.getCell(7).alignment = { horizontal: "center" };
    }
    vRow.getCell(4).numFmt = "0.00%";
    vRow.getCell(4).alignment = { horizontal: "center" };
    [8, 10].forEach(c => {
      vRow.getCell(c).numFmt = "0.00";
      vRow.getCell(c).alignment = { horizontal: "center" };
    });

    // Colorir Status (col 9 e 11)
    [9, 11].forEach(c => {
      const si = statusInfo(c === 9 ? v.status : v.statusConsolidado);
      applyFill(vRow.getCell(c), si.bg);
      vRow.getCell(c).font = { bold: true, size: 9, name: "Calibri", color: { argb: si.fg } };
      vRow.getCell(c).alignment = { horizontal: "center", vertical: "middle" };
    });

    // ── Sub-linhas de ativos
    for (const a of v.ativosNoVertice) {
      const isLT = a.fonte === "fip_lookthrough";
      const fonteTxt = isLT ? "Look-through FIP" : (a.fonte || "—");
      const aRow = wsV.addRow([
        "  ▸ " + a.nome,
        a.valor,
        "", `D+${a.prazo}`, "", "", "",
        "", fonteTxt, "", "",
      ]);
      styleAssetRow(aRow, activeCols.length);
      aRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
      aRow.getCell(2).numFmt = '"R$" #,##0.00';
      aRow.getCell(2).alignment = { horizontal: "right" };
      aRow.getCell(4).alignment = { horizontal: "center" };
      aRow.getCell(9).alignment = { horizontal: "left", vertical: "middle" };

      // Sub-linhas por investida (look-through FIP com detalhes)
      if (isLT && (a as any).look_through_detalhes?.length) {
        for (const d of (a as any).look_through_detalhes as Array<{ nome: string; valor: number; pct: number; data_liquidez: string; dias: number }>) {
          const br = formatDataLiquidezPrevistaExcel(d.data_liquidez);
          const pctDec = d.pct != null && Number.isFinite(Number(d.pct)) ? Number(d.pct) / 100 : null;
          const ltRow = wsV.addRow([
            `      ↳ ${d.nome}`,
            d.valor,
            pctDec,
            `D+${d.dias} (${br})`, "", "", "",
            "", "investida FIP (participações na data da análise)", "", "",
          ]);
          styleAssetRow(ltRow, activeCols.length);
          ltRow.getCell(1).font = { italic: true, size: 8, name: "Calibri", color: { argb: "FF5B21B6" } };
          ltRow.getCell(2).numFmt = '"R$" #,##0.00';
          ltRow.getCell(2).alignment = { horizontal: "right" };
          ltRow.getCell(2).font = { italic: true, size: 8, name: "Calibri", color: { argb: "FF5B21B6" } };
          if (pctDec != null) {
            ltRow.getCell(3).numFmt = "0.00%";
            ltRow.getCell(3).alignment = { horizontal: "center", vertical: "middle" };
            ltRow.getCell(3).font = { italic: true, size: 8, name: "Calibri", color: { argb: "FF5B21B6" } };
          }
          ltRow.getCell(4).alignment = { horizontal: "center" };
          ltRow.getCell(4).font = { italic: true, size: 8, name: "Calibri", color: { argb: "FF5B21B6" } };
          ltRow.getCell(9).alignment = { horizontal: "left" };
          ltRow.getCell(9).font = { italic: true, size: 8, name: "Calibri", color: { argb: "FF5B21B6" } };
        }
      }
    }
  }

  // Congelar linha de cabeçalho
  wsV.views = [{ state: "frozen", ySplit: 1 }];
  } // fim bloco fundo aberto — Vértice a Vértice

  // ────────────────────────────────────────────────────────────────
  // Aba Carteira
  // ────────────────────────────────────────────────────────────────
  const wsC = wb.addWorksheet("Carteira");

  const CART_COLS = [
    { header: "Seção",            width: 16 },
    { header: "Nome / Ativo",     width: 48 },
    { header: "CNPJ",             width: 22 },
    { header: "Valor (R$)",       width: 18 },
    { header: "Prazo (dias)",     width: 12 },
    { header: "Vértice ANBIMA",   width: 14 },
    { header: "Validado",         width: 10 },
  ];
  wsC.columns = CART_COLS.map(c => ({ width: c.width }));

  const cartHead = wsC.addRow(CART_COLS.map(c => c.header));
  styleHeaderRow(cartHead, CART_COLS.length);

  const sectionOrder: Record<string, number> = {
    caixa: 1, titpublico: 2, titprivado: 3, cotas: 4,
    fidc: 5, acoes: 6, participacoes: 7, imoveis: 8,
    despesas: 9, provisao: 10,
  };

  const sortedWallet = [...wallet].sort((a, b) => {
    const ao = sectionOrder[a.section?.toLowerCase() ?? ""] ?? 99;
    const bo = sectionOrder[b.section?.toLowerCase() ?? ""] ?? 99;
    return ao !== bo ? ao - bo : b.valor - a.valor;
  });

  let cartAlt = 0;
  for (const a of sortedWallet) {
    const cRow = wsC.addRow([
      a.section || "—",
      a.nome || "—",
      a.cnpj || "—",
      a.valor,
      a.prazo_dias,
      a.vertice != null ? `D+${a.vertice}` : "—",
      a.validado === false ? "Não" : "Sim",
    ]);

    const isAlt = cartAlt % 2 !== 0;
    for (let c = 1; c <= CART_COLS.length; c++) {
      const cell = cRow.getCell(c);
      applyFill(cell, isAlt ? C.GRAY_ALT : C.WHITE);
      cell.font   = { size: 9, name: "Calibri", color: { argb: C.INK } };
      cell.border = borders;
    }
    cRow.getCell(4).numFmt = '"R$" #,##0.00';
    cRow.getCell(4).alignment = { horizontal: "right" };
    cRow.getCell(5).alignment = { horizontal: "center" };
    cRow.getCell(6).alignment = { horizontal: "center" };
    cRow.getCell(7).alignment = { horizontal: "center" };
    cRow.height = 16;
    cartAlt++;
  }

  wsC.views = [{ state: "frozen", ySplit: 1 }];

  // ────────────────────────────────────────────────────────────────
  // Aba Resgates Solicitados (apenas para fundos abertos, se houver dados)
  // ────────────────────────────────────────────────────────────────
  if (!info.fundoFechadoAnalise && resgates && resgates.length > 0) {
    const RESGATE_RED = "FFC0392B";

    const wsReg = wb.addWorksheet("Resgates Solicitados", {
      properties: { tabColor: { argb: C.GRAY_HEAD.replace("FF", "") } },
    });

    const REG_COLS = [
      { header: "Fundo",        width: 46 },
      { header: "Cotista",      width: 36 },
      { header: "Data Impacto", width: 14 },
      { header: "Valor (R$)",   width: 20 },
      { header: "Tipo",         width: 18 },
      { header: "Prazo",        width: 10 },
    ];
    wsReg.columns = REG_COLS.map(c => ({ width: c.width }));

    const regHead = wsReg.addRow(REG_COLS.map(c => c.header));
    styleHeaderRow(regHead, REG_COLS.length);

    // Formata data ISO (YYYY-MM-DD) → DD/MM/YYYY
    const fmtDateReg = (s: string | null) => {
      if (!s) return "—";
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
    };

    // Agrupa por fundo para cabeçalho de grupo
    const gruposMap = new Map<string, ExportResgateRow[]>();
    for (const r of resgates) {
      const key = r.fundo || "—";
      if (!gruposMap.has(key)) gruposMap.set(key, []);
      gruposMap.get(key)!.push(r);
    }
    // Ordena grupos por total decrescente
    const gruposOrdenados = [...gruposMap.entries()]
      .map(([fundo, linhas]) => ({
        fundo,
        linhas: linhas.slice().sort((a, b) => a.data_impacto.localeCompare(b.data_impacto)),
        total: linhas.reduce((s, l) => s + (l.valor ?? 0), 0),
        proximoVenc: linhas.reduce((d, l) => (!d || l.data_impacto < d) ? l.data_impacto : d, ""),
      }))
      .sort((a, b) => b.total - a.total);

    let regAlt = 0;
    for (const grupo of gruposOrdenados) {
      // ── Linha de cabeçalho do grupo (fundo)
      const grpRow = wsReg.addRow([
        grupo.fundo,
        `${grupo.linhas.length} resgate(s)`,
        fmtDateReg(grupo.proximoVenc) + " (próx.)",
        grupo.total,
        "", "",
      ]);
      styleHeaderRow(grpRow, REG_COLS.length);
      grpRow.getCell(1).alignment = { horizontal: "left" };
      grpRow.getCell(2).alignment = { horizontal: "center" };
      grpRow.getCell(3).alignment = { horizontal: "center" };
      grpRow.getCell(4).numFmt = '"R$" #,##0.00';
      grpRow.getCell(4).alignment = { horizontal: "right" };
      grpRow.height = 20;

      // ── Linhas de detalhe
      for (const r of grupo.linhas) {
        const isAlt = regAlt % 2 !== 0;
        const dRow = wsReg.addRow([
          r.fundo || "—",
          r.cotista || "—",
          fmtDateReg(r.data_impacto),
          r.valor ?? 0,
          r.tipo_movimento || "—",
          r.dias_ate_pagamento != null ? `D+${r.dias_ate_pagamento}` : "—",
        ]);
        for (let c = 1; c <= REG_COLS.length; c++) {
          const cell = dRow.getCell(c);
          applyFill(cell, isAlt ? C.GRAY_ALT : C.WHITE);
          cell.font   = { size: 9, name: "Calibri", color: { argb: C.INK } };
          cell.border = borders;
        }
        dRow.getCell(3).alignment = { horizontal: "center" };
        dRow.getCell(4).numFmt = '"R$" #,##0.00';
        dRow.getCell(4).alignment = { horizontal: "right" };
        dRow.getCell(5).alignment = { horizontal: "center" };
        dRow.getCell(6).alignment = { horizontal: "center" };
        dRow.getCell(6).font = { bold: true, size: 9, name: "Calibri", color: { argb: RESGATE_RED } };
        dRow.height = 16;
        regAlt++;
      }

      // Linha separadora
      const sepReg = wsReg.addRow(["", "", "", "", "", ""]);
      for (let c = 1; c <= REG_COLS.length; c++) {
        applyFill(sepReg.getCell(c), C.WHITE);
        sepReg.getCell(c).border = { bottom: thin };
      }
      sepReg.height = 5;
    }

    // Linha de total geral
    const totReg = wsReg.addRow([
      "TOTAL GERAL",
      `${resgates.length} registro(s)`,
      "", resgates.reduce((s, r) => s + (r.valor ?? 0), 0),
      "", "",
    ]);
    for (let c = 1; c <= REG_COLS.length; c++) {
      applyFill(totReg.getCell(c), C.GREEN_DARK);
      totReg.getCell(c).font   = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
      totReg.getCell(c).border = borders;
    }
    totReg.getCell(4).numFmt = '"R$" #,##0.00';
    totReg.getCell(4).alignment = { horizontal: "right" };
    totReg.height = 22;

    wsReg.views = [{ state: "frozen", ySplit: 1 }];
  }

    return wb;
}

function computeLiquidezStressChoque(plFund: number, valoresDescTop3: number[]) {
  if (plFund <= 0) return { choque: 0, piso20: 0, somaCotistasTop3: 0, nCotistasTop3: 0, binding: "piso20" as const };
  const piso20 = plFund * 0.2;
  const lista = valoresDescTop3.slice(0, 3);
  const somaCotistasTop3 = lista.reduce((s, v) => s + v, 0);
  const binding: "piso20" | "cap20" = somaCotistasTop3 > piso20 ? "cap20" : "piso20";
  return { choque: piso20, piso20, somaCotistasTop3, nCotistasTop3: lista.length, binding };
}

function normalizeCnpj14(cnpj: string): string {
  return String(cnpj ?? "").replace(/\D/g, "").padStart(14, "0");
}

function normalizeDtPosYYYYMMDD(raw: string | null | undefined): string {
  const r = String(raw ?? "").trim();
  if (!r) return "";
  const iso = r.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  const digits = r.replace(/\D/g, "");
  if (digits.length >= 8) {
    const head = digits.slice(0, 8);
    const yHead = parseInt(head.slice(0, 4), 10);
    if (yHead >= 1900 && yHead <= 2200) return head;
    const yEnd = parseInt(digits.slice(4, 8), 10);
    if (yEnd >= 1900 && yEnd <= 2200 && digits.length >= 8) {
      return `${digits.slice(4, 8)}${digits.slice(2, 4)}${digits.slice(0, 2)}`;
    }
    return head;
  }
  return "";
}

/** Variantes de data para bater com o formato gravado em posicao_carteira.fundo_dtposicao */
function expandFundoDtposicaoQueryVariants(raw: string | null | undefined): string[] {
  const ymd = normalizeDtPosYYYYMMDD(raw);
  const set = new Set<string>();
  const r = String(raw ?? "").trim();
  if (r) set.add(r);
  if (ymd.length === 8) {
    set.add(ymd);
    set.add(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`);
  }
  return [...set];
}

function formatCnpj(cnpj: string): string {
  const d = normalizeCnpj14(cnpj);
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

function formatDataBR(dtposicao: string): string {
  if (!dtposicao || dtposicao.length !== 8) return dtposicao;
  return `${dtposicao.slice(6, 8)}/${dtposicao.slice(4, 6)}/${dtposicao.slice(0, 4)}`;
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\u00C0-\u024F\s-]/g, "_").slice(0, 40).trim() || "Fundo";
}

async function workbookToBase64(wb: ExcelJS.Workbook): Promise<string> {
  const buf = await wb.xlsx.writeBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export async function fetchCalculoLiquidez(
  supabaseUrl: string,
  serviceKey: string,
  fundoCnpj: string,
  dtposicao: string,
  classe: string,
  fundoIsin?: string | null,
): Promise<CalculoLiquidezData | null> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/calculo-risco-liquidez`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fundo_cnpj: fundoCnpj,
        fundo_isin: fundoIsin || null,
        fundo_dtposicao: dtposicao,
        classe,
        segmento_investidor: "PRIVATE",
        metrica: "media_simples",
      }),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return json?.success ? (json.data as CalculoLiquidezData) : null;
  } catch {
    return null;
  }
}

const WALLET_SELECT =
  "id, section, valor_padrao, cnpjfundo, cnpjemissor, nomecomercial, isin, codativo, fundo_nome, fundo_nomeadm, nome_fundo, ativos(validado, nome_frontend)";

async function queryPosicaoCarteiraWallet(
  supabase: ReturnType<typeof createClient>,
  table: "posicao_carteira" | "vw_posicao_enriquecida",
  cnpj: string,
  dtVariants: string[],
  fundoIsin?: string | null,
): Promise<Array<Record<string, unknown>>> {
  let q = supabase.from(table).select(WALLET_SELECT).eq("fundo_cnpj", cnpj);
  if (fundoIsin) q = q.eq("fundo_isin", fundoIsin);
  q = dtVariants.length <= 1
    ? q.eq("fundo_dtposicao", dtVariants[0] ?? "")
    : q.in("fundo_dtposicao", dtVariants);
  const { data, error } = await q.order("valor_padrao", { ascending: false });
  if (error) {
    console.warn(`[send-liquidez-notification] Erro ao buscar carteira (${table}):`, error.message);
    return [];
  }
  return (data ?? []) as Array<Record<string, unknown>>;
}

async function fetchWalletRows(
  supabase: ReturnType<typeof createClient>,
  fundoCnpj: string,
  dtposicao: string,
  fundoIsin?: string | null,
) {
  const cnpjClean = normalizeCnpj14(fundoCnpj);
  const cnpjFormatted = formatCnpj(fundoCnpj);
  const cnpjVariants = [...new Set([fundoCnpj, cnpjClean, cnpjFormatted].filter(Boolean))];
  const dtVariants = expandFundoDtposicaoQueryVariants(dtposicao);

  for (const cnpj of cnpjVariants) {
    for (const table of ["posicao_carteira", "vw_posicao_enriquecida"] as const) {
      const rows = await queryPosicaoCarteiraWallet(supabase, table, cnpj, dtVariants, fundoIsin);
      if (rows.length > 0) return rows;
    }
  }

  return [] as Array<Record<string, unknown>>;
}

async function fetchResgatesExport(
  supabase: ReturnType<typeof createClient>,
  fundoCnpj: string,
  fundName: string,
  dtposicao: string,
): Promise<ExportResgateRow[]> {
  const dataIsoMin = `${dtposicao.slice(0, 4)}-${dtposicao.slice(4, 6)}-${dtposicao.slice(6, 8)}`;
  const cnpjClean = normalizeCnpj14(fundoCnpj);
  const cnpjFormatted = formatCnpj(fundoCnpj);
  const queries: Promise<{ data: ExportResgateRow[] | null }>[] = [];
  const sel = "fundo, cotista, data_impacto, valor, tipo_movimento, dias_ate_pagamento";
  if (cnpjClean) {
    queries.push(supabase.from("resgates_movimentacoes").select(sel).eq("fundo_cnpj", cnpjClean).gte("data_impacto", dataIsoMin).order("data_impacto", { ascending: true }) as any);
    queries.push(supabase.from("resgates_movimentacoes").select(sel).eq("fundo_cnpj", cnpjFormatted).gte("data_impacto", dataIsoMin).order("data_impacto", { ascending: true }) as any);
  }
  if (fundName) {
    queries.push(supabase.from("resgates_movimentacoes").select(sel).ilike("fundo", `%${fundName.slice(0, 20)}%`).gte("data_impacto", dataIsoMin).order("data_impacto", { ascending: true }) as any);
  }
  const results = await Promise.all(queries);
  const seen = new Set<string>();
  const merged: ExportResgateRow[] = [];
  for (const res of results) {
    for (const r of res.data ?? []) {
      const key = `${r.fundo}|${r.cotista}|${r.data_impacto}|${r.valor}`;
      if (!seen.has(key)) { seen.add(key); merged.push(r); }
    }
  }
  return merged
    .filter((r) => !r.data_impacto || r.data_impacto >= dataIsoMin)
    .sort((a, b) => a.data_impacto.localeCompare(b.data_impacto));
}

async function fetchTopCotistas(
  supabase: ReturnType<typeof createClient>,
  fundoCnpj: string,
): Promise<number[]> {
  const cnpjClean = normalizeCnpj14(fundoCnpj);
  const cnpjFormatted = formatCnpj(fundoCnpj);
  const fetchBy = async (cnpj: string) => {
    const { data } = await supabase
      .from("passivo_fundos")
      .select("cotista, valor, data_posicao")
      .eq("fundo_cnpj", cnpj)
      .order("data_posicao", { ascending: false })
      .limit(50000);
    return data ?? [];
  };
  const rows = [...await fetchBy(cnpjClean), ...(cnpjFormatted ? await fetchBy(cnpjFormatted) : [])];
  if (rows.length === 0) return [];
  const latest = rows.reduce((max, r) => {
    const d = String(r.data_posicao ?? "");
    return d > max ? d : max;
  }, "");
  const latestRows = rows.filter((r) => String(r.data_posicao ?? "") === latest);
  const byCotista = new Map<string, number>();
  for (const r of latestRows) {
    const cotista = String(r.cotista ?? "").trim();
    if (!cotista || cotista.toLowerCase().startsWith("total")) continue;
    byCotista.set(cotista, (byCotista.get(cotista) ?? 0) + (Number(r.valor) || 0));
  }
  return [...byCotista.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([, v]) => v);
}

function resolveWalletAssetNome(item: Record<string, unknown>): string {
  const ativos = item.ativos as { nome_frontend?: string } | null;
  return String(
    item.nomecomercial ??
      ativos?.nome_frontend ??
      item.isin ??
      item.codativo ??
      item.cnpjfundo ??
      item.cnpjemissor ??
      "—",
  );
}

function buildWalletExport(
  rows: Array<Record<string, unknown>>,
  ativosComPrazo?: AtivoComPrazoRow[],
): ExportWalletAsset[] {
  const prazoById = new Map(
    (ativosComPrazo ?? [])
      .filter((a) => a.id)
      .map((a) => [String(a.id), a]),
  );

  return rows.map((item) => {
    const ativos = item.ativos as { validado?: boolean; nome_frontend?: string } | null;
    const prazoInfo = prazoById.get(String(item.id ?? ""));
    return {
      section: String(item.section ?? "—"),
      nome: resolveWalletAssetNome(item),
      cnpj: (item.cnpjfundo ?? item.cnpjemissor ?? null) as string | null,
      valor: Number(item.valor_padrao) || 0,
      prazo_dias: prazoInfo?.prazos_em_dias != null ? Number(prazoInfo.prazos_em_dias) : null,
      vertice: prazoInfo?.vertice != null ? Number(prazoInfo.vertice) : null,
      validado: ativos?.validado ?? true,
    };
  });
}

/** Fallback quando posicao_carteira não retorna linhas — usa ativosComPrazo do cálculo de liquidez. */
function buildWalletFromAtivosComPrazo(ativos: AtivoComPrazoRow[]): ExportWalletAsset[] {
  return ativos.map((a) => ({
    section: String(a.section ?? "—"),
    nome: String(a.nome ?? "—"),
    cnpj: null,
    valor: Number(a.valor) || 0,
    prazo_dias: a.prazos_em_dias != null ? Number(a.prazos_em_dias) : null,
    vertice: a.vertice != null ? Number(a.vertice) : null,
    validado: true,
  }));
}

function buildWorstStatus(
  isFechado: boolean,
  ffa: ExportFundoFechadoAnalise | null,
  vertices: ExportVerticeRow[],
  prazoResgate: number | null,
): RuleStatus {
  if (isFechado && ffa) return ffa.status;
  const rel = prazoResgate != null ? vertices.filter((r) => r.vertice <= prazoResgate) : vertices;
  let worst: RuleStatus = "ok";
  for (const r of rel) {
    if (r.statusConsolidado === "violacao") return "violacao";
    if (r.statusConsolidado === "alerta") worst = "alerta";
  }
  return worst;
}

function buildStressExportInfo(
  calc: CalculoLiquidezData,
  topCotistas: number[],
): StressExportInfo | undefined {
  const prazo = calc.mainFundChar?.prazo_pagamento_resgate_dias ?? null;
  const pl = calc.totalPL ?? 0;
  const stress = computeLiquidezStressChoque(pl, topCotistas);
  if (prazo == null || stress.choque <= 0) return undefined;
  const prazoRow = calc.tabelaVertices?.find((r) => r.vertice === prazo);
  if (!prazoRow) return undefined;
  const passivoBase = (prazoRow.resgatesSolicitados ?? 0) > 0 ? prazoRow.resgatesSolicitados! : prazoRow.passivoNoVertice;
  const passivoStress = passivoBase + stress.choque;
  const indiceStress = passivoStress > 0 ? Math.abs(prazoRow.ativoAcumulado / passivoStress) : 100;
  return {
    choque: stress.choque,
    piso20: stress.piso20,
    somaCotistasTop3: stress.somaCotistasTop3,
    nCotistasTop3: stress.nCotistasTop3,
    binding: stress.binding,
    prazoVertice: prazo,
    passivoSemStress: passivoBase,
    passivoComStress: passivoStress,
    indiceComStress: indiceStress,
  };
}

function mapFechadoAnalise(raw: Record<string, unknown> | null | undefined): ExportFundoFechadoAnalise | null {
  if (!raw) return null;
  const dispPL = Number(raw.dispPL ?? 0);
  const hardThreshold = 0.02;
  const softThreshold = 0.03;
  return {
    dispPL,
    disponibilidade: Number(raw.disponibilidade ?? 0),
    prazoResgate: raw.prazoResgate != null ? Number(raw.prazoResgate) : null,
    status: dispPL >= softThreshold ? "ok" : dispPL >= hardThreshold ? "alerta" : "violacao",
    mesesCobertura: raw.mesesCobertura != null ? Number(raw.mesesCobertura) : null,
    caixaLiquido: Number(raw.caixaLiquido ?? 0),
    darfEstimado: Number(raw.darfEstimado ?? 0),
    despesaOperacionalMensal: raw.despesaOperacionalMensal != null ? Number(raw.despesaOperacionalMensal) : null,
    statusCoberturaDespesa: (raw.statusCoberturaDespesa as RuleStatus | "indisponivel") ?? "indisponivel",
    hardThreshold,
    softThreshold,
  };
}

export async function buildLiquidezFundoExcel(params: {
  supabase: ReturnType<typeof createClient>;
  supabaseUrl: string;
  serviceKey: string;
  nomeFundo: string;
  fundoCnpj: string;
  fundoIsin?: string | null;
  dtposicao: string;
  tipoLimite: "soft" | "hard";
  classe: string;
  calc?: CalculoLiquidezData | null;
}): Promise<{ base64: string; filename: string }> {
  const { supabase, supabaseUrl, serviceKey, nomeFundo, fundoCnpj, fundoIsin, dtposicao, tipoLimite, classe } = params;
  const cnpjNorm = normalizeCnpj14(fundoCnpj);

  const calc = params.calc ?? await fetchCalculoLiquidez(supabaseUrl, serviceKey, cnpjNorm, dtposicao, classe, fundoIsin);
  const walletRows = await fetchWalletRows(supabase, cnpjNorm, dtposicao, fundoIsin);
  const ativosComPrazo = calc?.ativosComPrazo;
  const wallet = walletRows.length > 0
    ? buildWalletExport(walletRows, ativosComPrazo)
    : buildWalletFromAtivosComPrazo(ativosComPrazo ?? []);
  const fundName = String(walletRows[0]?.nome_fundo ?? walletRows[0]?.fundo_nome ?? nomeFundo);
  const administrador = String(walletRows[0]?.fundo_nomeadm ?? "—");
  const isFechado = calc?.isFundoFechado ?? false;
  const vertices = (calc?.tabelaVertices ?? []) as ExportVerticeRow[];
  const prazoResgate = calc?.mainFundChar?.prazo_pagamento_resgate_dias ?? null;
  const ffa = mapFechadoAnalise(calc?.fundoFechadoAnalise as Record<string, unknown> | null);
  const resgates = isFechado ? undefined : await fetchResgatesExport(supabase, cnpjNorm, fundName, dtposicao);
  const topCotistas = isFechado ? [] : await fetchTopCotistas(supabase, cnpjNorm);
  const stressInfo = calc ? buildStressExportInfo(calc, topCotistas) : undefined;

  const info: ExportFundoInfo = {
    nomeFundo: fundName || nomeFundo,
    cnpj: formatCnpj(cnpjNorm),
    dataBase: formatDataBR(dtposicao),
    administrador,
    tipo: isFechado ? "Fechado" : "Aberto",
    pl: calc?.totalPL ?? 0,
    prazoResgate,
    worstStatus: buildWorstStatus(isFechado, ffa, vertices, prazoResgate),
    classe,
    segmento: "PRIVATE",
    metrica: "media_simples",
    fundoFechadoAnalise: ffa,
  };

  const wb = await buildLiquidezExcelWorkbook(info, vertices, wallet, resgates, stressInfo);
  const tipoLabel = tipoLimite === "hard" ? "HardLimit" : "SoftLimit";
  const filename = `Liquidez_${safeFileName(info.nomeFundo)}_${dtposicao}_${tipoLabel}.xlsx`;
  return { base64: await workbookToBase64(wb), filename };
}
