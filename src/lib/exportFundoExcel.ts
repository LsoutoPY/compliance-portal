import ExcelJS from "exceljs";
import type {
  ExportFundoInfo,
  ExportVerticeRow,
  ExportFundoFechadoAnalise,
  ExportEnquadramentoFundoInfo,
  ExportEnquadramentoRule,
  ExportWalletAsset as ExportEnquadramentoWalletAsset,
} from "./exportPdf";
import {
  isTribArt4Rule,
  isTribArt5Rule,
  art4ClassificacaoLabel,
  buildHistoricoArt5,
  type TribArt4Ativo,
} from "./exportPdf";
import { resolveTributarioMetrics } from "@/lib/tributarioMetrics";
// Re-export para uso externo se necessário
export type { ExportFundoFechadoAnalise };

export interface ExportWalletAsset {
  section: string;
  nome: string;
  cnpj?: string | null;
  valor: number;
  prazo_dias: number | null;
  vertice: number | null;
  validado?: boolean;
}

export interface ExportResgateRow {
  fundo: string;
  cotista: string;
  data_impacto: string;
  valor: number;
  tipo_movimento: string | null;
  dias_ate_pagamento: number | null;
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
export async function exportFundoDetalhesExcel(
  info: ExportFundoInfo,
  vertices: ExportVerticeRow[],
  wallet: ExportWalletAsset[],
  resgates?: ExportResgateRow[],
  stressInfo?: StressExportInfo,
): Promise<void> {
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
      v.indice > 999 ? 999 : +v.indice.toFixed(4),
      statusInfo(v.status).label,
      v.indiceAcumulado > 999 ? 999 : +v.indiceAcumulado.toFixed(4),
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

  // ── Salvar via buffer (browser) ───────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a2 = document.createElement("a");
  const today = new Date();
  const ts = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("");
  const safeName = info.nomeFundo
    .replace(/[^a-zA-Z0-9\u00C0-\u024F\s-]/g, "_")
    .slice(0, 40)
    .trim();

  a2.href     = url;
  a2.download = `Liquidez_${safeName}_${ts}.xlsx`;
  document.body.appendChild(a2);
  a2.click();
  document.body.removeChild(a2);
  URL.revokeObjectURL(url);
}

// ── Export Detalhado por Fundo (Enquadramento) ────────────────────────────────
export async function buildEnquadramentoFundoExcelBuffer(
  info: ExportEnquadramentoFundoInfo,
  rules: ExportEnquadramentoRule[],
  assets: ExportEnquadramentoWalletAsset[] = [],
): Promise<{ buffer: ArrayBuffer; filename: string }> {
  const wb = new ExcelJS.Workbook();
  wb.creator  = "CVPAR Quadrante";
  wb.created  = new Date();
  wb.modified = new Date();

  // ── Helpers de status ────────────────────────────────────────────
  const enquadrStatusInfo = (s: string): { label: string; bg: string; fg: string } => {
    if (s === "ok")       return { label: "Regular",  bg: C.OK_BG,   fg: C.OK_FG   };
    if (s === "alerta")   return { label: "Alerta",   bg: C.SOFT_BG, fg: C.SOFT_FG };
    if (s === "violacao") return { label: "Violação", bg: C.HARD_BG, fg: C.HARD_FG };
    return { label: "Pendente", bg: C.WHITE, fg: C.INK_LIGHT };
  };

  const fmtBRL = (v: number) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);

  const fmtRuleValue = (v: number | null, isPercentual = true): string => {
    if (v === null || v === undefined) return "—";
    if (isPercentual && Math.abs(v) < 1) return `${(v * 100).toFixed(2)}%`;
    if (!isPercentual || Math.abs(v) >= 1000) {
      return v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
    }
    return `${(v * 100).toFixed(2)}%`;
  };

  const CATEGORY_LABELS: Record<string, string> = {
    "tributario-art4": "Tributário Art. 4º",
    "tributario-art4-fidc": "Tributário Art. 4º",
    tributario: "Tributário Art. 5º",
    pl: "PL",
    concentration: "Concentração",
    "fidc-concentracao": "FIDC Concentração",
    liquidity: "Liquidez",
    classe: "Classe",
    relacional: "Manual",
  };

  const tribArt5LimitePct = (det: Record<string, unknown>) => {
    if (det.limite_mm != null) return Number(det.limite_mm);
    const l = Number(det.limite ?? 90);
    return l <= 1 ? l * 100 : l;
  };

  const tribArt5AlertaPct = (det: Record<string, unknown>) => {
    if (det.alerta_mm != null) return Number(det.alerta_mm);
    const a = Number(det.alerta_inferior ?? 92);
    return a <= 1 ? a * 100 : a;
  };

  const tribArt5StatusFromMm = (mmPct: number, limitePct: number, alertaPct: number) => {
    if (mmPct >= alertaPct) return "ok";
    if (mmPct >= limitePct) return "alerta";
    return "violacao";
  };

  const ART4_NORMA_FOOTER =
    "Prazo médio calculado conforme Art. 4º IN RFB 1.585/2015: cotas de fundo LP = 366 dias fixos " +
    "(§4º), cotas de fundo CP = 1 dia fixo (§3º), títulos RF = dias corridos até vencimento (§2º inciso I). " +
    "FII, FIA, FIP, CCB e COE excluídos (§5º).";

  const ART5_NORMA_NOTE =
    "Enquadramento calculado conforme Art. 5º IN RFB 1.585/2015: o FIQ deve manter no mínimo 90% " +
    "do PL em cotas de fundos LP tributários, medido pela média móvel de 10 dias úteis (MM-10d). " +
    "FII são computados fora do LP.";

  // ── Derived ──────────────────────────────────────────────────────
  const worstSt = enquadrStatusInfo(info.worstStatus === "pendente" ? "ok" : info.worstStatus);
  const nViolacao = rules.filter(r => r.status === "violacao").length;
  const nAlerta   = rules.filter(r => r.status === "alerta").length;
  const nOk       = rules.filter(r => r.status === "ok").length;

  // ────────────────────────────────────────────────────────────────
  // Aba 1 — RESUMO
  // ────────────────────────────────────────────────────────────────
  const wsR = wb.addWorksheet("Resumo", {
    properties: { tabColor: { argb: C.GREEN_DARK.replace("FF", "") } },
  });
  wsR.columns = [{ width: 32 }, { width: 50 }];

  // Título
  const titleRow = wsR.addRow(["RELATÓRIO DE ENQUADRAMENTO — CVPAR QUADRANTE"]);
  wsR.mergeCells(titleRow.number, 1, titleRow.number, 2);
  applyFill(titleRow.getCell(1), C.GREEN_DARK);
  titleRow.getCell(1).font      = { bold: true, color: { argb: C.WHITE }, size: 11, name: "Calibri" };
  titleRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  titleRow.height = 24;

  wsR.addRow([]);

  const addKV = (key: string, value: string | number, valueBg?: string, valueFg?: string) => {
    const r = wsR.addRow([key, value]);
    applyFill(r.getCell(1), "FFF3F4F6");
    r.getCell(1).font   = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    r.getCell(2).font   = { size: 9, name: "Calibri", color: { argb: valueFg ?? C.INK } };
    r.getCell(1).border = borders;
    r.getCell(2).border = borders;
    r.height = 16;
    if (valueBg) applyFill(r.getCell(2), valueBg);
    if (valueFg) r.getCell(2).font = { bold: true, size: 9, name: "Calibri", color: { argb: valueFg } };
    return r;
  };

  const addSection = (label: string) => {
    const r = wsR.addRow([label]);
    wsR.mergeCells(r.number, 1, r.number, 2);
    applyFill(r.getCell(1), C.GRAY_HEAD);
    r.getCell(1).font      = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
    r.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
    r.height = 20;
  };

  addSection("IDENTIFICAÇÃO DO FUNDO");
  addKV("Nome do Fundo",        info.nomeFundo);
  addKV("CNPJ",                 info.cnpj);
  addKV("Data Base",            info.dataBase);
  addKV("Patrimônio Líquido",   brlFmt(info.totalPL));
  addKV("Prazo de Resgate",     info.prazoResgate != null ? `D+${info.prazoResgate}` : "—");
  addKV("Status de Compliance", worstSt.label, worstSt.bg, worstSt.fg);

  wsR.addRow([]);
  addSection("RESUMO DE COMPLIANCE");
  addKV("Total de Regras Verificadas", rules.length);
  addKV("Regular (OK)",   nOk,       C.OK_BG,    C.OK_FG);
  addKV("Alerta",         nAlerta,   C.SOFT_BG,  C.SOFT_FG);
  addKV("Violação",       nViolacao, C.HARD_BG,  C.HARD_FG);

  wsR.addRow([]);
  const genRow = wsR.addRow(["Gerado em", new Date().toLocaleString("pt-BR")]);
  applyFill(genRow.getCell(1), "FFF3F4F6");
  genRow.getCell(1).font   = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
  genRow.getCell(2).font   = { size: 9, name: "Calibri", color: { argb: C.INK } };
  genRow.getCell(1).border = borders;
  genRow.getCell(2).border = borders;
  genRow.height = 16;

  // ────────────────────────────────────────────────────────────────
  // Aba 2 — COMPLIANCE (Regras + ativos considerados)
  // Colunas: Código | Nome/Ativo/Cedente | Categoria | Valor/Montante | % PL | Limite | Status
  // ────────────────────────────────────────────────────────────────
  const wsC = wb.addWorksheet("Compliance");

  // 7 colunas para acomodar tanto a linha de regra quanto sub-linhas de ativos
  const COMP_COLS = [
    { header: "Código",            width: 24 },  // col 1
    { header: "Descrição / Ativo", width: 56 },  // col 2
    { header: "Categoria",         width: 18 },  // col 3
    { header: "Valor / Montante",  width: 22 },  // col 4
    { header: "% PL",              width: 12 },  // col 5
    { header: "Limite",            width: 18 },  // col 6
    { header: "Status",            width: 16 },  // col 7
  ];
  wsC.columns = COMP_COLS.map(c => ({ width: c.width }));

  const compHead = wsC.addRow(COMP_COLS.map(c => c.header));
  styleHeaderRow(compHead, COMP_COLS.length);

  // Ordenar: violacao → alerta → ok
  const sortOrder: Record<string, number> = { violacao: 0, alerta: 1, ok: 2 };

  const regraArt4 = rules.find((r) => isTribArt4Rule(r));
  const regraArt5 = rules.find((r) => isTribArt5Rule(r));
  const regrasDemais = rules
    .filter((r) => !isTribArt4Rule(r) && !isTribArt5Rule(r))
    .sort((a, b) => (sortOrder[a.status] ?? 3) - (sortOrder[b.status] ?? 3));

  let ruleAlt = 0;
  let historicoArt5: ReturnType<typeof buildHistoricoArt5> = [];

  const ASSET_SECTION_BG = "FFF0F4F8";

  const fmtCnpjLocal = (cnpj: string) => {
    const clean = String(cnpj || "").replace(/\D/g, "");
    if (clean.length !== 14) return cnpj;
    return clean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  };

  // ── Art. 4º FIM ─────────────────────────────────────────────────────────────
  if (regraArt4) {
    const det = (regraArt4.detalhes ?? {}) as Record<string, unknown>;
    const prazoMedio = Number(det.prazo_medio_dias ?? 0);
    const limiteDias = Number(det.limite_dias ?? 365);
    const patliq = Number(det.patliq ?? 0);
    const valorElegivel = Number(det.valor_elegivel ?? 0);
    const si = enquadrStatusInfo(regraArt4.status);
    const margem = prazoMedio - limiteDias;

    const hdr = wsC.addRow([
      regraArt4.regra_codigo,
      regraArt4.regra_descricao,
      CATEGORY_LABELS["tributario-art4"],
      `${prazoMedio.toFixed(2)}d`,
      `${margem >= 0 ? "+" : ""}${margem.toFixed(2)}d`,
      `${limiteDias},00d`,
      si.label,
    ]);
    for (let c = 1; c <= COMP_COLS.length; c++) {
      const cell = hdr.getCell(c);
      applyFill(cell, c === 7 ? si.bg : C.WHITE);
      cell.border = borders;
      cell.font = { size: 9, name: "Calibri", color: { argb: c === 4 || c === 5 ? si.fg : C.INK }, bold: true };
    }
    hdr.getCell(4).numFmt = '0.00"d"';
    hdr.getCell(5).numFmt = '+0.00"d";-0.00"d"';
    hdr.height = 22;

    const metricsRow = wsC.addRow([
      "PRAZO MÉDIO", `${prazoMedio.toFixed(2)}d`,
      "LIMITE LP", `${limiteDias},00d`,
      "MARGEM", `${margem >= 0 ? "+" : ""}${margem.toFixed(2)}d`,
      `PL: ${brlFmt(patliq)}`,
    ]);
    wsC.mergeCells(metricsRow.number, 1, metricsRow.number, 2);
    wsC.mergeCells(metricsRow.number, 3, metricsRow.number, 4);
    wsC.mergeCells(metricsRow.number, 5, metricsRow.number, 6);
    for (let c = 1; c <= COMP_COLS.length; c++) {
      applyFill(metricsRow.getCell(c), C.SOFT_BG);
      metricsRow.getCell(c).border = borders;
      metricsRow.getCell(c).font = { size: 8, name: "Calibri", color: { argb: c === 2 || c === 6 ? si.fg : C.INK }, bold: true };
      metricsRow.getCell(c).alignment = { horizontal: "center" };
    }
    metricsRow.height = 18;

    const subHead = wsC.addRow([
      "", "Ativo", "Classificação", "Valor (R$)", "Peso %", "Prazo", "Contribuição (dias)",
    ]);
    for (let c = 1; c <= COMP_COLS.length; c++) {
      applyFill(subHead.getCell(c), ASSET_SECTION_BG);
      subHead.getCell(c).border = borders;
      subHead.getCell(c).font = { bold: true, size: 8, name: "Calibri", color: { argb: C.GRAY_HEAD } };
    }
    subHead.height = 16;

    const ativos = ((det.ativos_contabilizados ?? []) as TribArt4Ativo[]);
    for (const asset of ativos) {
      const excl = asset.tipo === "excluido";
      const aRow = wsC.addRow([
        "  ▸",
        asset.nome,
        art4ClassificacaoLabel(asset),
        asset.valor,
        excl ? null : asset.percentual,
        excl || asset.prazo_dias == null ? null : asset.prazo_dias,
        excl || asset.contribuicao_dias == null ? null : asset.contribuicao_dias,
      ]);
      for (let c = 1; c <= COMP_COLS.length; c++) {
        applyFill(aRow.getCell(c), C.GRAY_SUB);
        aRow.getCell(c).border = { left: thin, right: thin, bottom: { style: "thin", color: { argb: "FFE5E7EB" } } };
        aRow.getCell(c).font = {
          size: 8,
          name: "Calibri",
          color: { argb: excl ? C.GRAY_SECTION : C.INK },
          italic: excl,
        };
      }
      aRow.getCell(4).numFmt = '"R$"#,##0.00';
      aRow.getCell(4).alignment = { horizontal: "right" };
      if (!excl) {
        aRow.getCell(5).numFmt = "0.0%";
        aRow.getCell(5).alignment = { horizontal: "right" };
        aRow.getCell(6).numFmt = '0"d"';
        aRow.getCell(6).alignment = { horizontal: "center" };
        aRow.getCell(7).numFmt = '0.00"d"';
        aRow.getCell(7).alignment = { horizontal: "right" };
      }
      aRow.height = 16;
    }

    const pesoTotal = ativos
      .filter((a) => a.tipo !== "excluido")
      .reduce((s, a) => s + Number(a.percentual ?? 0), 0);
    const totalRow = wsC.addRow([
      "",
      "total",
      String(det.classificacao_tributaria ?? "").toUpperCase() || "—",
      valorElegivel,
      pesoTotal,
      null,
      prazoMedio,
    ]);
    for (let c = 1; c <= COMP_COLS.length; c++) {
      applyFill(totalRow.getCell(c), C.GRAY_HEAD);
      totalRow.getCell(c).border = borders;
      totalRow.getCell(c).font = { bold: true, size: 8, name: "Calibri", color: { argb: C.WHITE } };
    }
    totalRow.getCell(4).numFmt = '"R$"#,##0.00';
    totalRow.getCell(5).numFmt = "0.0%";
    totalRow.getCell(7).numFmt = '0.00"d"';
    totalRow.getCell(7).font = { bold: true, size: 9, name: "Calibri", color: { argb: si.fg } };
    totalRow.height = 18;

    const footRow = wsC.addRow([ART4_NORMA_FOOTER]);
    wsC.mergeCells(footRow.number, 1, footRow.number, COMP_COLS.length);
    applyFill(footRow.getCell(1), "FFFAFAFA");
    footRow.getCell(1).font = { size: 8, name: "Calibri", color: { argb: C.INK_LIGHT }, italic: true };
    footRow.getCell(1).alignment = { wrapText: true };
    footRow.height = 36;

    const sep = wsC.addRow(["", "", "", "", "", "", ""]);
    for (let c = 1; c <= COMP_COLS.length; c++) sep.getCell(c).border = { bottom: thin };
    sep.height = 4;
    ruleAlt++;
  }

  // ── Art. 5º FIQ ─────────────────────────────────────────────────────────────
  if (regraArt5) {
    const det = (regraArt5.detalhes ?? {}) as Record<string, unknown>;
    const m = resolveTributarioMetrics(det, null, regraArt5.valor_atual);
    const limitePct = tribArt5LimitePct(det);
    const alertaPct = tribArt5AlertaPct(det);
    const mmStatus = tribArt5StatusFromMm(m.mm_10d, limitePct, alertaPct);
    const si = enquadrStatusInfo(mmStatus);
    const eventosLim = Number(det.eventos_limite ?? 3);
    const diasLim = Number(det.dias_limite ?? 45);

    const hdr = wsC.addRow([
      regraArt5.regra_codigo,
      regraArt5.regra_descricao,
      CATEGORY_LABELS.tributario,
      `${m.mm_10d.toFixed(2)}%`,
      `${m.p_dia.toFixed(2)}%`,
      `${limitePct.toFixed(0)},00%`,
      si.label,
    ]);
    for (let c = 1; c <= COMP_COLS.length; c++) {
      const cell = hdr.getCell(c);
      applyFill(cell, c === 7 ? si.bg : C.WHITE);
      cell.border = borders;
      cell.font = { size: 9, name: "Calibri", color: { argb: c === 4 ? si.fg : C.INK }, bold: true };
    }
    hdr.getCell(4).numFmt = "0.00%";
    hdr.getCell(5).numFmt = "0.00%";
    hdr.height = 22;

    const compRow = wsC.addRow([
      `LP: ${m.pctLP.toFixed(2)}%`,
      brlFmt(m.valor_lp),
      `CP: ${m.pctCP.toFixed(2)}%`,
      brlFmt(m.valor_cp),
      `FII: ${m.pctExc.toFixed(2)}%`,
      brlFmt(m.valor_excluido),
      "",
    ]);
    wsC.mergeCells(compRow.number, 1, compRow.number, 2);
    wsC.mergeCells(compRow.number, 3, compRow.number, 4);
    wsC.mergeCells(compRow.number, 5, compRow.number, 6);
    applyFill(compRow.getCell(1), C.OK_BG);
    applyFill(compRow.getCell(3), C.SOFT_BG);
    applyFill(compRow.getCell(5), C.GRAY_ALT);
    for (let c = 1; c <= COMP_COLS.length; c++) {
      compRow.getCell(c).border = borders;
      compRow.getCell(c).font = { bold: true, size: 8, name: "Calibri", color: { argb: C.INK } };
      compRow.getCell(c).alignment = { horizontal: "center" };
    }
    compRow.height = 18;

    const metRow = wsC.addRow([
      "MM-10d",
      m.mm_10d / 100,
      "P do dia",
      m.p_dia / 100,
      "Eventos",
      `${m.eventos_ano} / ${eventosLim}`,
      `${m.dias_violacao_ano} / ${diasLim} dias`,
    ]);
    for (let c = 1; c <= COMP_COLS.length; c++) {
      applyFill(metRow.getCell(c), "FFF8FAFC");
      metRow.getCell(c).border = borders;
      metRow.getCell(c).font = { size: 8, name: "Calibri", color: { argb: c === 2 ? si.fg : C.INK }, bold: c === 2 };
      metRow.getCell(c).alignment = { horizontal: "center" };
    }
    metRow.getCell(2).numFmt = "0.00%";
    metRow.getCell(4).numFmt = "0.00%";
    metRow.height = 16;

    const noteRow = wsC.addRow([ART5_NORMA_NOTE]);
    wsC.mergeCells(noteRow.number, 1, noteRow.number, COMP_COLS.length);
    applyFill(noteRow.getCell(1), "FFFAFAFA");
    noteRow.getCell(1).font = { size: 8, name: "Calibri", color: { argb: C.INK_LIGHT }, italic: true };
    noteRow.getCell(1).alignment = { wrapText: true };
    noteRow.height = 32;

    historicoArt5 = buildHistoricoArt5(det, regraArt5);

    const sep = wsC.addRow(["", "", "", "", "", "", ""]);
    for (let c = 1; c <= COMP_COLS.length; c++) sep.getCell(c).border = { bottom: thin };
    sep.height = 4;
    ruleAlt++;
  }

  // ── Demais regras (compacto + detalhe automático em violação) ───────────────
  for (const rule of regrasDemais) {
    const isAlt      = ruleAlt % 2 !== 0;
    const isViolacao = rule.status === "violacao";
    const isAlerta   = rule.status === "alerta";
    const si         = enquadrStatusInfo(rule.status);
    const det        = (rule.detalhes || {}) as Record<string, unknown>;
    const patliq     = Number(det.patliq ?? 0);

    const valorAtualExibir =
      rule.regra_codigo === "TRIB_FIQ_LP_90" || rule.regra_categoria === "tributario"
        ? (det.p_dia != null && Number.isFinite(Number(det.p_dia))
          ? Number(det.p_dia) / 100
          : rule.valor_atual)
        : rule.valor_atual;

    const isPLRule = rule.regra_categoria === "pl";

    // Cor de fundo da linha compacta
    const rowBg = isViolacao ? "FFFEF2F2"
                : isAlerta   ? "FFFFFBEB"
                : isAlt      ? C.GRAY_ALT
                :              C.WHITE;

    // ── Linha compacta ────────────────────────────────────────────
    const ruleRow = wsC.addRow([
      rule.regra_codigo,
      rule.regra_descricao,
      CATEGORY_LABELS[rule.regra_categoria] || rule.regra_categoria,
      isPLRule ? (valorAtualExibir != null ? fmtBRL(valorAtualExibir) : "—") : fmtRuleValue(valorAtualExibir),
      isPLRule ? (rule.valor_limite != null ? fmtBRL(rule.valor_limite) : "—") : fmtRuleValue(rule.valor_limite),
      si.label,
      "",
    ]);

    for (let c = 1; c <= COMP_COLS.length; c++) {
      const cell = ruleRow.getCell(c);
      applyFill(cell, c === 6 ? si.bg : rowBg);
      cell.border = borders;
      cell.font   = { size: 9, name: "Calibri", color: { argb: C.INK } };
    }

    // Código: negrito; borda esquerda vermelha em violação
    ruleRow.getCell(1).font      = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK } };
    ruleRow.getCell(1).alignment = { horizontal: "center" };
    if (isViolacao) {
      ruleRow.getCell(1).border = {
        top: thin, bottom: thin, right: thin,
        left: { style: "medium", color: { argb: C.HARD_FG } },
      };
    }

    ruleRow.getCell(2).font      = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK } };
    ruleRow.getCell(3).alignment = { horizontal: "center" };
    ruleRow.getCell(3).font      = { size: 8, name: "Calibri", color: { argb: C.INK_LIGHT } };

    // Valor Atual: vermelho bold em violação, âmbar em alerta
    ruleRow.getCell(4).alignment = { horizontal: "right" };
    ruleRow.getCell(4).font      = {
      bold: isViolacao || isAlerta,
      size: 9,
      name: "Calibri",
      color: { argb: isViolacao ? C.HARD_FG : isAlerta ? C.SOFT_FG : C.INK },
    };

    ruleRow.getCell(5).alignment = { horizontal: "right" };
    ruleRow.getCell(5).font      = { size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    ruleRow.getCell(6).font      = { bold: true, size: 9, name: "Calibri", color: { argb: si.fg } };
    ruleRow.getCell(6).alignment = { horizontal: "center" };
    ruleRow.height = 20;

    // ── Bloco de detalhe (somente violação) ──────────────────────
    if (isViolacao) {
      const va = rule.valor_atual ?? 0;
      const vl = rule.valor_limite ?? 0;
      const ativos3 = (
        (det.ativos_vedados ?? det.ativos_contabilizados ?? []) as Record<string, unknown>[]
      );

      // Linha de métricas (4 blocos ou 2 para regras PL)
      const metRow = wsC.addRow(
        isPLRule
          ? ["PL Atual", fmtBRL(va), "PL Mínimo", fmtBRL(vl), "", "", ""]
          : [
              "PL do Fundo",
              brlFmt(patliq),
              "Montante Consid.",
              brlFmt(va * patliq),
              `% Calc.: ${(va * 100).toFixed(2)}%`,
              `Limite: ${(vl * 100).toFixed(2)}%`,
              "",
            ],
      );
      for (let c = 1; c <= COMP_COLS.length; c++) {
        applyFill(metRow.getCell(c), "FFFEF9F9");
        metRow.getCell(c).border = {
          top: thin, bottom: thin, right: thin,
          left: c === 1 ? { style: "medium", color: { argb: C.HARD_FG } } : thin,
        };
        metRow.getCell(c).font = {
          size: 8,
          name: "Calibri",
          color: { argb: c % 2 === 0 ? C.INK : C.INK_LIGHT },
          bold: c % 2 === 0,
        };
      }
      metRow.getCell(5).font = { bold: true, size: 8, name: "Calibri", color: { argb: C.HARD_FG } };
      metRow.height = 16;

      if (ativos3.length > 0) {
        // Cabeçalho dos ativos
        const subHead = wsC.addRow([
          "", "Ativos Considerados no Cálculo", "", "CNPJ", "Valor (R$)", "% PL", "",
        ]);
        for (let c = 1; c <= COMP_COLS.length; c++) {
          applyFill(subHead.getCell(c), C.GRAY_ALT);
          subHead.getCell(c).border = {
            top: thin, bottom: thin, right: thin,
            left: c === 1 ? { style: "medium", color: { argb: C.HARD_FG } } : thin,
          };
          subHead.getCell(c).font = { bold: true, size: 7.5, name: "Calibri", color: { argb: C.GRAY_HEAD } };
        }
        subHead.getCell(2).alignment = { horizontal: "left" };
        subHead.getCell(4).alignment = { horizontal: "center" };
        subHead.getCell(5).alignment = { horizontal: "right" };
        subHead.getCell(6).alignment = { horizontal: "right" };
        subHead.height = 15;

        for (const ativo of ativos3) {
          const assetPerc   = Number(ativo.percentual ?? 0);
          const isAboveLim  = assetPerc > vl;
          const cnpjFmt     = ativo.cnpj ? fmtCnpjLocal(String(ativo.cnpj)) : "—";

          const aRow = wsC.addRow([
            "  ▸",
            String(ativo.nome ?? "—"),
            "",
            cnpjFmt,
            Number(ativo.valor ?? 0),
            assetPerc,
            "",
          ]);

          for (let c = 1; c <= COMP_COLS.length; c++) {
            applyFill(aRow.getCell(c), "FFFEF4F4");
            aRow.getCell(c).border = {
              bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
              right: thin,
              left: c === 1 ? { style: "medium", color: { argb: C.HARD_FG } } : thin,
            };
            aRow.getCell(c).font = { size: 8, name: "Calibri", color: { argb: C.INK } };
          }
          aRow.getCell(1).alignment = { horizontal: "center" };
          aRow.getCell(1).font      = { size: 8, name: "Calibri", color: { argb: C.GRAY_SECTION } };
          aRow.getCell(2).font      = { bold: true, size: 8, name: "Calibri", color: { argb: C.INK } };
          aRow.getCell(4).font      = { size: 7.5, name: "Calibri", color: { argb: C.INK_LIGHT } };
          aRow.getCell(4).alignment = { horizontal: "center" };
          aRow.getCell(5).numFmt    = '"R$" #,##0.00';
          aRow.getCell(5).alignment = { horizontal: "right" };
          aRow.getCell(6).numFmt    = "0.00%";
          aRow.getCell(6).alignment = { horizontal: "right" };
          aRow.getCell(6).font      = {
            bold: isAboveLim,
            size: 8,
            name: "Calibri",
            color: { argb: isAboveLim ? C.HARD_FG : C.INK },
          };
          aRow.height = 16;
        }
      }

      // Linha separadora
      const sepRow = wsC.addRow(["", "", "", "", "", "", ""]);
      for (let c = 1; c <= COMP_COLS.length; c++) {
        applyFill(sepRow.getCell(c), C.WHITE);
        sepRow.getCell(c).border = { bottom: thin };
      }
      sepRow.height = 4;
    }

    ruleAlt++;
  }

  wsC.views = [{ state: "frozen", ySplit: 1 }];

  // ── Aba opcional — Histórico Tributário (Art. 5º) ───────────────────────────
  if (historicoArt5.length > 0) {
    const wsH = wb.addWorksheet("Histórico Tributário");
    wsH.columns = [
      { width: 14 },
      { width: 16 },
      { width: 16 },
      { width: 14 },
    ];

    const histHead = wsH.addRow(["Data", "P do Dia (%)", "MM-10d (%)", "Status"]);
    styleHeaderRow(histHead, 4);

    const statusFill: Record<string, { bg: string; fg: string; label: string }> = {
      ok: { bg: "FFF0FDF4", fg: "FF166534", label: "Regular" },
      alerta: { bg: "FFFFFBEB", fg: "FF92400E", label: "Alerta" },
      violacao: { bg: "FFFEF2F2", fg: "FF991B1B", label: "Violação" },
    };

    for (const h of historicoArt5) {
      const fmtDate = h.data.replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1");
      const st = statusFill[h.status] ?? statusFill.ok;
      const row = wsH.addRow([fmtDate, h.p_dia, h.mm_10d, st.label]);
      for (let c = 1; c <= 4; c++) {
        row.getCell(c).border = borders;
        row.getCell(c).font = { size: 9, name: "Calibri", color: { argb: c === 4 ? st.fg : C.INK } };
        if (c === 4) applyFill(row.getCell(c), st.bg);
      }
      row.getCell(2).numFmt = "0.00%";
      row.getCell(3).numFmt = "0.00%";
      row.getCell(4).alignment = { horizontal: "center" };
      row.height = 16;
    }

    wsH.views = [{ state: "frozen", ySplit: 1 }];
  }

  // ────────────────────────────────────────────────────────────────
  // Aba 3 — CARTEIRA (Composição)
  // ────────────────────────────────────────────────────────────────
  if (assets.length > 0) {
    const wsW = wb.addWorksheet("Carteira");

    const CART_COLS = [
      { header: "Ativo / Emissor", width: 52 },
      { header: "Tipo",            width: 16 },
      { header: "Quantidade",      width: 18 },
      { header: "P.U.",            width: 18 },
      { header: "Liquidez",        width: 12 },
      { header: "Financeiro (R$)", width: 22 },
      { header: "% PL",            width: 10 },
    ];
    wsW.columns = CART_COLS.map(c => ({ width: c.width }));

    const cartHead = wsW.addRow(CART_COLS.map(c => c.header));
    styleHeaderRow(cartHead, CART_COLS.length);

    let cartAlt = 0;
    for (const a of assets) {
      const isAlt = cartAlt % 2 !== 0;
      const row = wsW.addRow([
        a.ativo,
        a.tipo,
        a.quantidade,
        a.precoUnit,
        a.liquidez,
        a.financeiro,
        a.percPL,
      ]);

      for (let c = 1; c <= CART_COLS.length; c++) {
        const cell = row.getCell(c);
        applyFill(cell, isAlt ? C.GRAY_ALT : C.WHITE);
        cell.font   = { size: 9, name: "Calibri", color: { argb: C.INK } };
        cell.border = borders;
      }
      row.getCell(1).font      = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK } };
      row.getCell(2).alignment = { horizontal: "center" };
      row.getCell(2).font      = { size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
      row.getCell(3).alignment = { horizontal: "right" };
      row.getCell(4).alignment = { horizontal: "right" };
      row.getCell(5).alignment = { horizontal: "center" };
      row.getCell(5).font      = { size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
      row.getCell(6).alignment = { horizontal: "right" };
      row.getCell(7).alignment = { horizontal: "right" };
      row.height = 18;
      cartAlt++;
    }

    wsW.views = [{ state: "frozen", ySplit: 1 }];
  }

  // ── Salvar via buffer (browser) ────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const today = new Date();
  const ts = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("");
  const safeName = info.nomeFundo
    .replace(/[^a-zA-Z0-9\u00C0-\u024F\s-]/g, "_")
    .slice(0, 40)
    .trim();
  const filename = `Enquadramento_${safeName}_${ts}.xlsx`;
  return { buffer: buffer as ArrayBuffer, filename };
}

export async function exportEnquadramentoFundoExcel(
  info: ExportEnquadramentoFundoInfo,
  rules: ExportEnquadramentoRule[],
  assets: ExportEnquadramentoWalletAsset[] = [],
): Promise<void> {
  const { buffer, filename } = await buildEnquadramentoFundoExcelBuffer(info, rules, assets);
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a2 = document.createElement("a");
  a2.href = url;
  a2.download = filename;
  document.body.appendChild(a2);
  a2.click();
  document.body.removeChild(a2);
  URL.revokeObjectURL(url);
}

// ── Tipos para Export Consolidado de Enquadramento ────────────────────────────
export interface ExportEnquadramentoConsolidadoRow {
  nome_fundo: string;
  fundo_cnpj: string;
  dt_posicao: string;   // YYYYMMDD
  statusDetail: string; // ok | alerta | violacao | pendente
  administrador?: string;
  pl?: number;
  nRegras?: number;
  nViolacoes?: number;
}

export interface ExportEnquadramentoConsolidadoExcelOptions {
  layout?: "simples" | "completo";
  fileName?: string;
}

// ── Export Consolidado de Enquadramento (Excel) ───────────────────────────────
export async function exportEnquadramentoConsolidadoExcel(
  fundos: ExportEnquadramentoConsolidadoRow[],
  dataRef: string,
  options: ExportEnquadramentoConsolidadoExcelOptions = {},
): Promise<void> {
  const { layout = "simples", fileName } = options;
  const isCompleto = layout === "completo";
  const fmtCount = (n: number | undefined) => (n != null && n > 0 ? n : "—");
  const wb = new ExcelJS.Workbook();
  wb.creator  = "CVPAR Quadrante";
  wb.created  = new Date();
  wb.modified = new Date();

  const total     = fundos.length;
  const nOk       = fundos.filter(f => f.statusDetail === "ok").length;
  const nAlerta   = fundos.filter(f => f.statusDetail === "alerta").length;
  const nViolacao = fundos.filter(f => f.statusDetail === "violacao").length;
  const nPendente = fundos.filter(f => f.statusDetail === "pendente").length;

  // ── Helpers locais ──────────────────────────────────────────────
  const fmtCnpj = (cnpj: string) => {
    const clean = String(cnpj).replace(/\D/g, "");
    if (clean.length !== 14) return cnpj;
    return clean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  };
  const fmtDate = (d: string) => d?.replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1") || "—";
  const statusLabelEnq = (s: string) => {
    if (s === "ok")       return "Regular";
    if (s === "alerta")   return "Alerta";
    if (s === "violacao") return "Violação";
    return "Pendente";
  };

  // ────────────────────────────────────────────────────────────────
  // Aba 1 — RESUMO
  // ────────────────────────────────────────────────────────────────
  const wsRes = wb.addWorksheet("Resumo", {
    properties: { tabColor: { argb: C.GREEN_DARK.replace("FF", "") } },
  });
  wsRes.columns = [{ width: 30 }, { width: 20 }];

  // Título
  const titleRow = wsRes.addRow(["RELATÓRIO DE ENQUADRAMENTO — CVPAR QUADRANTE"]);
  wsRes.mergeCells(titleRow.number, 1, titleRow.number, 2);
  applyFill(titleRow.getCell(1), C.GREEN_DARK);
  titleRow.getCell(1).font      = { bold: true, color: { argb: C.WHITE }, size: 11, name: "Calibri" };
  titleRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  titleRow.height = 24;

  wsRes.addRow([]);

  // Data de referência
  const drRow = wsRes.addRow(["Data de Referência", dataRef]);
  applyFill(drRow.getCell(1), "FFF3F4F6");
  drRow.getCell(1).font   = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
  drRow.getCell(2).font   = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK } };
  drRow.getCell(1).border = borders;
  drRow.getCell(2).border = borders;
  drRow.height = 16;

  wsRes.addRow([]);

  // Seção de distribuição
  const secRow = wsRes.addRow(["DISTRIBUIÇÃO POR STATUS"]);
  wsRes.mergeCells(secRow.number, 1, secRow.number, 2);
  applyFill(secRow.getCell(1), C.GRAY_HEAD);
  secRow.getCell(1).font      = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
  secRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  secRow.height = 20;

  const addStatusRow = (label: string, count: number, bg: string, fg: string) => {
    const r = wsRes.addRow([label, count]);
    applyFill(r.getCell(1), "FFF3F4F6");
    applyFill(r.getCell(2), bg);
    r.getCell(1).font      = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    r.getCell(2).font      = { bold: true, size: 9, name: "Calibri", color: { argb: fg } };
    r.getCell(1).border    = borders;
    r.getCell(2).border    = borders;
    r.getCell(2).alignment = { horizontal: "center" };
    r.height = 16;
  };

  addStatusRow("Total de Fundos",  total,     C.WHITE,    C.INK);
  addStatusRow("Regular (OK)",     nOk,       C.OK_BG,    C.OK_FG);
  addStatusRow("Alerta",           nAlerta,   C.SOFT_BG,  C.SOFT_FG);
  addStatusRow("Violação",         nViolacao, C.HARD_BG,  C.HARD_FG);
  addStatusRow("Pendente",         nPendente, C.GRAY_ALT, C.GRAY_SECTION);

  wsRes.addRow([]);

  const genRow = wsRes.addRow(["Gerado em", new Date().toLocaleString("pt-BR")]);
  applyFill(genRow.getCell(1), "FFF3F4F6");
  genRow.getCell(1).font   = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
  genRow.getCell(2).font   = { size: 9, name: "Calibri", color: { argb: C.INK } };
  genRow.getCell(1).border = borders;
  genRow.getCell(2).border = borders;
  genRow.height = 16;

  // ────────────────────────────────────────────────────────────────
  // Aba 2 — DETALHAMENTO POR FUNDO
  // ────────────────────────────────────────────────────────────────
  const wsFunds = wb.addWorksheet("Fundos");

  const FUND_COLS = isCompleto
    ? [
        { header: "Fundo", width: 52 },
        { header: "CNPJ", width: 22 },
        { header: "Administrador", width: 28 },
        { header: "PL", width: 16 },
        { header: "Regras", width: 10 },
        { header: "Violações", width: 12 },
        { header: "Status", width: 14 },
      ]
    : [
        { header: "Fundo", width: 52 },
        { header: "CNPJ", width: 22 },
        { header: "Data", width: 12 },
        { header: "Status", width: 16 },
      ];
  wsFunds.columns = FUND_COLS.map(c => ({ width: c.width }));

  const headRow = wsFunds.addRow(FUND_COLS.map(c => c.header));
  styleHeaderRow(headRow, FUND_COLS.length);

  let altIdx = 0;
  for (const f of fundos) {
    const isAlt = altIdx % 2 !== 0;
    const si =
      f.statusDetail === "ok"       ? { bg: C.OK_BG,   fg: C.OK_FG   } :
      f.statusDetail === "alerta"   ? { bg: C.SOFT_BG, fg: C.SOFT_FG } :
      f.statusDetail === "violacao" ? { bg: C.HARD_BG, fg: C.HARD_FG } :
      { bg: isAlt ? C.GRAY_ALT : C.WHITE, fg: C.INK_LIGHT };

    const rowValues = isCompleto
      ? [
          f.nome_fundo || "—",
          fmtCnpj(f.fundo_cnpj),
          f.administrador || "—",
          f.pl != null
            ? f.pl.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 })
            : "—",
          fmtCount(f.nRegras),
          fmtCount(f.nViolacoes),
          statusLabelEnq(f.statusDetail),
        ]
      : [
          f.nome_fundo || "—",
          fmtCnpj(f.fundo_cnpj),
          fmtDate(f.dt_posicao),
          statusLabelEnq(f.statusDetail),
        ];

    const row = wsFunds.addRow(rowValues);

    for (let c = 1; c <= FUND_COLS.length; c++) {
      const cell = row.getCell(c);
      const statusCol = isCompleto ? 7 : 4;
      applyFill(cell, c === statusCol ? si.bg : (isAlt ? C.GRAY_ALT : C.WHITE));
      cell.border = borders;
    }
    row.getCell(1).font      = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK } };
    row.getCell(2).font      = { size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    row.getCell(2).alignment = { horizontal: "center" };
    if (isCompleto) {
      row.getCell(3).font      = { size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
      row.getCell(4).font      = { size: 9, name: "Calibri", color: { argb: C.INK } };
      row.getCell(4).alignment = { horizontal: "right" };
      row.getCell(5).alignment = { horizontal: "center" };
      row.getCell(6).alignment = { horizontal: "center" };
      if (f.nViolacoes != null && f.nViolacoes > 0) {
        row.getCell(6).font = { bold: true, size: 9, name: "Calibri", color: { argb: C.HARD_FG } };
      }
      row.getCell(7).font      = { bold: true, size: 9, name: "Calibri", color: { argb: si.fg } };
      row.getCell(7).alignment = { horizontal: "center" };
    } else {
      row.getCell(3).font      = { size: 9, name: "Calibri", color: { argb: C.INK } };
      row.getCell(3).alignment = { horizontal: "center" };
      row.getCell(4).font      = { bold: true, size: 9, name: "Calibri", color: { argb: si.fg } };
      row.getCell(4).alignment = { horizontal: "center" };
    }
    row.height = 18;
    altIdx++;
  }

  wsFunds.views = [{ state: "frozen", ySplit: 1 }];

  // ── Salvar via buffer (browser) ────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a2 = document.createElement("a");
  const today = new Date();
  const ts = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("");
  a2.href     = url;
  a2.download = `${fileName ?? `Enquadramento_${dataRef.replace(/\//g, "-")}_${ts}`}.xlsx`;
  document.body.appendChild(a2);
  a2.click();
  document.body.removeChild(a2);
  URL.revokeObjectURL(url);
}

// ── Exportação: Exposição Consolidada por Gestor / Administrador ─────────────

export interface ExposicaoGestorRow {
  fundoCnpj: string;
  fundoNome: string;
  administradorFundoInvestidor?: string | null;
  tipoExposicao: "direta" | "indireta";
  /** 0 = direta, 1 = 1 nível, 2 = 2 níveis, etc. */
  nivel: number;
  gestorPrincipal: string | null;
  administrador: string | null;
  fundoInvestidoCnpj?: string;
  fundoInvestidoNome?: string;
  /** Cadeia de fundos intermediários para nivel >= 2 (ex.: "Oportunidades → Alpha") */
  via?: string;
  valor: number;
  plFundo: number;
}

export interface ExportExposicaoGestorParams {
  tipo: "gestor" | "administrador";
  dateStr: string;
  linhas: ExposicaoGestorRow[];
}

export async function exportExposicaoGestorExcel(
  params: ExportExposicaoGestorParams,
): Promise<void> {
  const { tipo, dateStr, linhas } = params;

  const dimLabel = tipo === "gestor" ? "Gestor Principal" : "Administrador";
  const fmtDate  = dateStr
    ? `${dateStr.slice(6, 8)}/${dateStr.slice(4, 6)}/${dateStr.slice(0, 4)}`
    : "—";

  const fmtCnpj = (cnpj: string) =>
    cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

  const getEntidade = (l: ExposicaoGestorRow) =>
    (tipo === "gestor" ? l.gestorPrincipal : l.administrador) ?? "—";

  // Ordena: entidade → fundo → direto primeiro
  const linhasOrdenadas = [...linhas]
    .filter((l) => !!getEntidade(l) && getEntidade(l) !== "—")
    .sort((a, b) => {
      const ea = getEntidade(a);
      const eb = getEntidade(b);
      if (ea !== eb) return ea.localeCompare(eb, "pt-BR");
      if (a.fundoNome !== b.fundoNome) return a.fundoNome.localeCompare(b.fundoNome, "pt-BR");
      return a.tipoExposicao === "direta" ? -1 : 1;
    });

  const wb = new ExcelJS.Workbook();
  wb.creator  = "CVPAR Quadrante";
  wb.created  = new Date();
  wb.modified = new Date();

  // ────────────────────────────────────────────────────────────────────────────
  // Aba 1 — RESUMO POR GESTOR/ADM
  // ────────────────────────────────────────────────────────────────────────────
  const wsRes = wb.addWorksheet("Resumo", {
    properties: { tabColor: { argb: C.GREEN_DARK.replace("FF", "") } },
  });

  wsRes.columns = [
    { width: 52 }, // Entidade
    { width: 20 }, // Total Valor
    { width: 22 }, // Valor Direto
    { width: 22 }, // Valor Indireto
    { width: 14 }, // Nº Fundos Direto
    { width: 14 }, // Nº Fundos Indireto
  ];

  const addTitleWs = (ws: ExcelJS.Worksheet, title: string, nCols: number) => {
    const r = ws.addRow([title]);
    ws.mergeCells(r.number, 1, r.number, nCols);
    applyFill(r.getCell(1), C.GREEN_DARK);
    r.getCell(1).font      = { bold: true, color: { argb: C.WHITE }, size: 12, name: "Calibri" };
    r.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
    r.height = 28;
  };

  const addMetaWs = (ws: ExcelJS.Worksheet, label: string, value: string, nCols: number) => {
    const r = ws.addRow([label, value]);
    ws.mergeCells(r.number, 2, r.number, nCols);
    applyFill(r.getCell(1), "FFF3F4F6");
    r.getCell(1).font   = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    r.getCell(2).font   = { size: 9, name: "Calibri", color: { argb: C.INK } };
    r.getCell(1).border = borders;
    r.getCell(2).border = borders;
    r.height = 16;
  };

  addTitleWs(wsRes, `EXPOSIÇÃO POR ${dimLabel.toUpperCase()} — CVPAR QUADRANTE`, 6);
  wsRes.addRow([]);
  addMetaWs(wsRes, "Dimensão",         dimLabel,                                  6);
  addMetaWs(wsRes, "Data de Posição",  fmtDate,                                   6);
  addMetaWs(wsRes, "Total de Linhas",  String(linhasOrdenadas.length),            6);
  addMetaWs(wsRes, "Gerado em",        new Date().toLocaleString("pt-BR"),        6);
  wsRes.addRow([]);

  // Cabeçalho da tabela resumo
  const rHdr = wsRes.addRow([
    dimLabel,
    "Valor Total (R$)",
    "Valor Direto (R$)",
    "Valor Indireto (R$)",
    "Fundos Diretos",
    "Fundos Indiretos",
  ]);
  styleHeaderRow(rHdr, 6);

  // Agrupa por entidade
  const groupMap = new Map<string, {
    valorTotal: number;
    valorDireto: number;
    valorIndireto: number;
    fundosDiretos: Set<string>;
    fundosIndiretos: Set<string>;
  }>();

  for (const l of linhasOrdenadas) {
    const ent = getEntidade(l);
    const g   = groupMap.get(ent) ?? {
      valorTotal: 0, valorDireto: 0, valorIndireto: 0,
      fundosDiretos: new Set(), fundosIndiretos: new Set(),
    };
    g.valorTotal += l.valor;
    if (l.tipoExposicao === "direta") {
      g.valorDireto += l.valor;
      g.fundosDiretos.add(l.fundoCnpj);
    } else {
      g.valorIndireto += l.valor;
      g.fundosIndiretos.add(l.fundoCnpj);
    }
    groupMap.set(ent, g);
  }

  // Ordena por valor total decrescente
  const groupsSorted = Array.from(groupMap.entries()).sort((a, b) => b[1].valorTotal - a[1].valorTotal);
  let altRes = false;
  for (const [ent, g] of groupsSorted) {
    const r = wsRes.addRow([
      ent,
      g.valorTotal,
      g.valorDireto,
      g.valorIndireto,
      g.fundosDiretos.size,
      g.fundosIndiretos.size,
    ]);
    const bg = altRes ? C.GRAY_ALT : C.WHITE;
    for (let c = 1; c <= 6; c++) {
      applyFill(r.getCell(c), bg);
      r.getCell(c).font   = { size: 9, name: "Calibri", color: { argb: C.INK } };
      r.getCell(c).border = borders;
    }
    r.getCell(1).font = { size: 9, name: "Calibri", color: { argb: C.INK }, bold: true };
    r.getCell(2).numFmt = '#,##0.00'; r.getCell(2).alignment = { horizontal: "right" };
    r.getCell(3).numFmt = '#,##0.00'; r.getCell(3).alignment = { horizontal: "right" };
    r.getCell(4).numFmt = '#,##0.00'; r.getCell(4).alignment = { horizontal: "right" };
    r.getCell(5).alignment = { horizontal: "center" };
    r.getCell(6).alignment = { horizontal: "center" };
    r.height = 18;
    altRes = !altRes;
  }

  // Linha total resumo
  const totRes = wsRes.addRow([
    "TOTAL GERAL",
    linhasOrdenadas.reduce((s, l) => s + l.valor, 0),
    linhasOrdenadas.filter(l => l.tipoExposicao === "direta").reduce((s, l) => s + l.valor, 0),
    linhasOrdenadas.filter(l => l.tipoExposicao === "indireta").reduce((s, l) => s + l.valor, 0),
    new Set(linhasOrdenadas.filter(l => l.tipoExposicao === "direta").map(l => l.fundoCnpj)).size,
    new Set(linhasOrdenadas.filter(l => l.tipoExposicao === "indireta").map(l => l.fundoCnpj)).size,
  ]);
  for (let c = 1; c <= 6; c++) {
    applyFill(totRes.getCell(c), C.GREEN_DARK);
    totRes.getCell(c).font   = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
    totRes.getCell(c).border = borders;
  }
  totRes.getCell(2).numFmt = '#,##0.00'; totRes.getCell(2).alignment = { horizontal: "right" };
  totRes.getCell(3).numFmt = '#,##0.00'; totRes.getCell(3).alignment = { horizontal: "right" };
  totRes.getCell(4).numFmt = '#,##0.00'; totRes.getCell(4).alignment = { horizontal: "right" };
  totRes.getCell(5).alignment = { horizontal: "center" };
  totRes.getCell(6).alignment = { horizontal: "center" };
  totRes.height = 22;

  // ────────────────────────────────────────────────────────────────────────────
  // Aba 2 — DETALHAMENTO (todos os fundos × todos os gestores/adm)
  // ────────────────────────────────────────────────────────────────────────────
  const wsDet = wb.addWorksheet("Detalhamento");

  const DET_COLS = 12;
  wsDet.columns = [
    { width: 34 }, // Gestor Principal (fundo investido)
    { width: 34 }, // Administrador (fundo investido)
    { width: 44 }, // Fundo (carteira)
    { width: 34 }, // Administrador (fundo investidor)
    { width: 20 }, // CNPJ fundo
    { width: 14 }, // Tipo
    { width:  8 }, // Nível
    { width: 40 }, // Fundo investido
    { width: 20 }, // CNPJ fundo investido
    { width: 40 }, // Via (intermediários)
    { width: 20 }, // Valor
    { width: 12 }, // % PL
  ];

  addTitleWs(wsDet, `DETALHAMENTO EXPOSIÇÃO — ${dimLabel.toUpperCase()} — CVPAR QUADRANTE`, DET_COLS);
  wsDet.addRow([]);
  addMetaWs(wsDet, "Dimensão",        dimLabel,                           DET_COLS);
  addMetaWs(wsDet, "Data de Posição", fmtDate,                            DET_COLS);
  addMetaWs(wsDet, "Gerado em",       new Date().toLocaleString("pt-BR"), DET_COLS);
  wsDet.addRow([]);

  const dHdr = wsDet.addRow([
    "Gestor Principal (Fundo Investido)",
    "Administrador (Fundo Investido)",
    "Fundo (Carteira)",
    "Administrador (Fundo Investidor)",
    "CNPJ Fundo",
    "Tipo",
    "Nível",
    "Fundo Investido",
    "CNPJ Fundo Investido",
    "Via (Cadeia de Intermediários)",
    "Valor (R$)",
    "% do PL",
  ]);
  styleHeaderRow(dHdr, DET_COLS);

  const tipoLabel = (l: ExposicaoGestorRow) => {
    if (l.tipoExposicao === "direta") return "Direta";
    if (l.nivel <= 1) return "Indireta";
    return `Indireta ×${l.nivel}`;
  };

  let altDet = false;
  for (const linha of linhasOrdenadas) {
    const r = wsDet.addRow([
      linha.gestorPrincipal || "—",
      linha.administrador || "—",
      linha.fundoNome || linha.fundoCnpj,
      linha.administradorFundoInvestidor || "—",
      fmtCnpj(linha.fundoCnpj),
      tipoLabel(linha),
      linha.nivel === 0 ? "Direto" : `${linha.nivel}`,
      linha.fundoInvestidoNome || (linha.fundoInvestidoCnpj ? fmtCnpj(linha.fundoInvestidoCnpj) : "—"),
      linha.fundoInvestidoCnpj ? fmtCnpj(linha.fundoInvestidoCnpj) : "—",
      linha.via || "—",
      linha.valor,
      linha.plFundo > 0 ? linha.valor / linha.plFundo : null,
    ]);

    const bg = altDet ? C.GRAY_ALT : C.WHITE;
    for (let c = 1; c <= DET_COLS; c++) {
      applyFill(r.getCell(c), bg);
      r.getCell(c).font   = { size: 9, name: "Calibri", color: { argb: C.INK } };
      r.getCell(c).border = borders;
    }
    r.getCell(1).font = { size: 9, name: "Calibri", color: { argb: C.INK }, bold: true };
    r.getCell(11).numFmt    = '#,##0.00';
    r.getCell(11).alignment = { horizontal: "right" };
    if (linha.plFundo > 0) {
      r.getCell(12).numFmt    = '0.00%';
      r.getCell(12).alignment = { horizontal: "right" };
    }
    if (linha.tipoExposicao === "direta") {
      applyFill(r.getCell(6), "FFE8F4FD");
      r.getCell(6).font = { size: 9, name: "Calibri", color: { argb: "FF1B6FA8" }, bold: true };
    } else if (linha.nivel <= 1) {
      applyFill(r.getCell(6), "FFFFF3CD");
      r.getCell(6).font = { size: 9, name: "Calibri", color: { argb: "FF856404" }, bold: true };
    } else {
      applyFill(r.getCell(6), "FFFDE8D0");
      r.getCell(6).font = { size: 9, name: "Calibri", color: { argb: "FF953D00" }, bold: true };
    }
    r.getCell(6).alignment = { horizontal: "center" };
    r.getCell(7).alignment = { horizontal: "center" };
    r.height = 18;
    altDet = !altDet;
  }

  // Linha de total
  const totDet = wsDet.addRow([
    "TOTAL GERAL", "", "", "", "", "", "", "", "", "", 
    linhasOrdenadas.reduce((s, l) => s + l.valor, 0),
    "",
  ]);
  for (let c = 1; c <= DET_COLS; c++) {
    applyFill(totDet.getCell(c), C.GREEN_DARK);
    totDet.getCell(c).font   = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
    totDet.getCell(c).border = borders;
  }
  totDet.getCell(11).numFmt    = '#,##0.00';
  totDet.getCell(11).alignment = { horizontal: "right" };
  totDet.height = 22;

  // Download
  const buffer = await wb.xlsx.writeBuffer();
  const blob   = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url    = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const ts     = dateStr || new Date().toISOString().slice(0, 10).replace(/-/g, "");
  anchor.href     = url;
  anchor.download = `Exposicao_${tipo === "gestor" ? "Gestor" : "Adm"}_${ts}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

// ──────────────────────────────────────────────────────────────────────────────
// EXPORTAR RESGATES SOLICITADOS
// ──────────────────────────────────────────────────────────────────────────────

export interface ExportResgatesSolicitadosData {
  dataReferencia: string; // "04/05/2026"
  totalResgates: number;
  totalMovimentacoes: number;
  totalFundos: number;
  proximoVencimento: string | null; // "06/05/2026"
  porFundo: {
    fundo: string;
    qtd: number;
    total: number;
    proximoVencimento: string | null;
    linhas: ExportResgateRow[];
  }[];
}

export async function exportResgatesSolicitadosExcel(
  data: ExportResgatesSolicitadosData
) {
  const wb = new ExcelJS.Workbook();

  // ── Helpers ──
  const thin: ExcelJS.Border = { style: "thin", color: { argb: C.BORDER } };
  const borders = { top: thin, left: thin, bottom: thin, right: thin };

  const applyFill = (cell: ExcelJS.Cell, argb: string) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
  };

  const addTitleWs = (ws: ExcelJS.Worksheet, title: string, cols: number) => {
    const r = ws.addRow([title]);
    ws.mergeCells(r.number, 1, r.number, cols);
    const cell = r.getCell(1);
    applyFill(cell, C.GREEN_DARK);
    cell.font = { bold: true, color: { argb: C.WHITE }, size: 13, name: "Calibri" };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    r.height = 26;
  };

  const addMetaWs = (ws: ExcelJS.Worksheet, label: string, value: string, cols: number) => {
    const r = ws.addRow([label, value]);
    ws.mergeCells(r.number, 2, r.number, cols);
    const c1 = r.getCell(1);
    const c2 = r.getCell(2);
    applyFill(c1, C.GRAY_SUB);
    applyFill(c2, C.WHITE);
    c1.font = { bold: true, color: { argb: C.INK }, size: 9, name: "Calibri" };
    c1.border = borders;
    c2.font = { color: { argb: C.INK }, size: 9, name: "Calibri" };
    c2.border = borders;
    r.height = 18;
  };

  const styleHeaderRow = (row: ExcelJS.Row, cols: number) => {
    for (let c = 1; c <= cols; c++) {
      const cell = row.getCell(c);
      applyFill(cell, C.GRAY_HEAD);
      cell.font = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
      cell.border = borders;
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    }
    row.height = 24;
  };

  // ────────────────────────────────────────────────────────────────────────────
  // Aba 1 — VISÃO GERENCIAL (por fundo)
  // ────────────────────────────────────────────────────────────────────────────
  const wsResume = wb.addWorksheet("Visão Gerencial");

  const RESUME_COLS = 5;
  wsResume.columns = [
    { width: 5 },  // #
    { width: 38 }, // Fundo
    { width: 10 }, // Qtd
    { width: 18 }, // Total
    { width: 14 }, // Próx. Venc.
  ];

  addTitleWs(wsResume, `RESGATES SOLICITADOS — CVPAR QUADRANTE`, RESUME_COLS);
  wsResume.addRow([]);
  addMetaWs(wsResume, "Data de Referência", data.dataReferencia, RESUME_COLS);
  addMetaWs(wsResume, "Total de Resgates", new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(data.totalResgates), RESUME_COLS);
  addMetaWs(wsResume, "Fundos com Resgate", String(data.totalFundos), RESUME_COLS);
  addMetaWs(wsResume, "Próximo Vencimento", data.proximoVencimento || "—", RESUME_COLS);
  addMetaWs(wsResume, "Gerado em", new Date().toLocaleString("pt-BR"), RESUME_COLS);
  wsResume.addRow([]);

  const hdrResume = wsResume.addRow(["#", "Fundo", "Qtd", "Total (R$)", "Próx. Venc."]);
  styleHeaderRow(hdrResume, RESUME_COLS);

  let altResume = false;
  let idx = 1;
  for (const grupo of data.porFundo) {
    const r = wsResume.addRow([
      idx++,
      grupo.fundo,
      grupo.qtd,
      grupo.total,
      grupo.proximoVencimento || "—",
    ]);

    const bg = altResume ? C.GRAY_ALT : C.WHITE;
    for (let c = 1; c <= RESUME_COLS; c++) {
      applyFill(r.getCell(c), bg);
      r.getCell(c).font = { size: 9, name: "Calibri", color: { argb: C.INK } };
      r.getCell(c).border = borders;
    }
    r.getCell(1).alignment = { horizontal: "center" };
    r.getCell(1).font = { size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    r.getCell(2).font = { size: 9, name: "Calibri", color: { argb: C.INK }, bold: true };
    r.getCell(3).numFmt = "#,##0";
    r.getCell(3).alignment = { horizontal: "right" };
    r.getCell(4).numFmt = "#,##0.00";
    r.getCell(4).alignment = { horizontal: "right" };
    r.getCell(4).font = { size: 9, name: "Calibri", color: { argb: C.HARD_FG }, bold: true };
    r.getCell(5).alignment = { horizontal: "center" };
    r.height = 20;
    altResume = !altResume;
  }

  // Linha de total
  const totResume = wsResume.addRow([
    "", "TOTAL GERAL", data.totalMovimentacoes, data.totalResgates, ""
  ]);
  for (let c = 1; c <= RESUME_COLS; c++) {
    applyFill(totResume.getCell(c), C.GREEN_DARK);
    totResume.getCell(c).font = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
    totResume.getCell(c).border = borders;
  }
  totResume.getCell(3).numFmt = "#,##0";
  totResume.getCell(3).alignment = { horizontal: "right" };
  totResume.getCell(4).numFmt = "#,##0.00";
  totResume.getCell(4).alignment = { horizontal: "right" };
  totResume.height = 22;

  // ────────────────────────────────────────────────────────────────────────────
  // Aba 2 — DETALHAMENTO (todos os resgates)
  // ────────────────────────────────────────────────────────────────────────────
  const wsDet = wb.addWorksheet("Detalhamento");

  const DET_COLS = 6;
  wsDet.columns = [
    { width: 38 }, // Fundo
    { width: 28 }, // Cotista
    { width: 14 }, // Data Impacto
    { width: 18 }, // Valor
    { width: 16 }, // Tipo Movimento
    { width: 10 }, // Dias
  ];

  addTitleWs(wsDet, `RESGATES SOLICITADOS — DETALHAMENTO — CVPAR QUADRANTE`, DET_COLS);
  wsDet.addRow([]);
  addMetaWs(wsDet, "Data de Referência", data.dataReferencia, DET_COLS);
  addMetaWs(wsDet, "Gerado em", new Date().toLocaleString("pt-BR"), DET_COLS);
  wsDet.addRow([]);

  const dHdr = wsDet.addRow([
    "Fundo",
    "Cotista",
    "Data Impacto",
    "Valor (R$)",
    "Tipo Movimento",
    "Dias até Pgto",
  ]);
  styleHeaderRow(dHdr, DET_COLS);

  let altDet = false;
  const todasLinhas = data.porFundo.flatMap(g => 
    g.linhas.map(l => ({ ...l, fundo: g.fundo }))
  ).sort((a, b) => a.data_impacto.localeCompare(b.data_impacto));

  for (const linha of todasLinhas) {
    const r = wsDet.addRow([
      linha.fundo,
      linha.cotista || "—",
      linha.data_impacto,
      linha.valor,
      linha.tipo_movimento || "—",
      linha.dias_ate_pagamento != null ? `D+${linha.dias_ate_pagamento}` : "—",
    ]);

    const bg = altDet ? C.GRAY_ALT : C.WHITE;
    for (let c = 1; c <= DET_COLS; c++) {
      applyFill(r.getCell(c), bg);
      r.getCell(c).font = { size: 9, name: "Calibri", color: { argb: C.INK } };
      r.getCell(c).border = borders;
    }
    r.getCell(1).font = { size: 9, name: "Calibri", color: { argb: C.INK }, bold: true };
    r.getCell(3).alignment = { horizontal: "center" };
    r.getCell(4).numFmt = "#,##0.00";
    r.getCell(4).alignment = { horizontal: "right" };
    r.getCell(4).font = { size: 9, name: "Calibri", color: { argb: C.HARD_FG }, bold: true };
    r.getCell(5).alignment = { horizontal: "center" };
    r.getCell(5).font = { size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    r.getCell(6).alignment = { horizontal: "center" };
    r.getCell(6).font = { size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    r.height = 18;
    altDet = !altDet;
  }

  // Linha de total
  const totDet = wsDet.addRow([
    "TOTAL GERAL", "", "", todasLinhas.reduce((s, l) => s + l.valor, 0), "", ""
  ]);
  for (let c = 1; c <= DET_COLS; c++) {
    applyFill(totDet.getCell(c), C.GREEN_DARK);
    totDet.getCell(c).font = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
    totDet.getCell(c).border = borders;
  }
  totDet.getCell(4).numFmt = "#,##0.00";
  totDet.getCell(4).alignment = { horizontal: "right" };
  totDet.height = 22;

  // Download
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const ts = data.dataReferencia.replace(/\//g, "");
  anchor.href = url;
  anchor.download = `Resgates_Solicitados_${ts}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

// ── Export Mapa de Fundos ─────────────────────────────────────────────────────

export interface MapaFundosExportRow {
  nivel: number;
  nome: string;
  tipo: "fundo" | "cotista" | "ativo";
  cnpj?: string | null;
  section?: string | null;
  pctPasso: number;
  pctAcum: number;
}

export interface MapaFundosExportParams {
  seedNome: string;
  seedCnpj: string;
  dtposicao: string;
  /** Nós da direção ativo (carteira do fundo) — L1+ */
  rowsAtivo: MapaFundosExportRow[];
  /** Nós da direção passivo (quem investe no fundo) */
  rowsPassivo: MapaFundosExportRow[];
  nivelAtivo: number;
  nivelPassivo: number;
  plPassivoTotal?: number;
  dataPassivoUsada?: string;
}

const C_VIOLET_BG  = "FFDBEAFE";  // blue-100
const C_VIOLET_FG  = "FF1D4ED8";  // blue-700
const C_VIOLET_HDR = "FF1E40AF";  // blue-800

const SECTION_LABELS: Record<string, string> = {
  titpublico:    "Tít. Público",
  titprivado:    "Tít. Privado",
  caixa:         "Caixa",
  participacoes: "Participações",
  acoes:         "Ações",
  termorf:       "Termo RF",
  imoveis:       "Imóveis",
  cotas:         "Cotas",
  fidc:          "FIDC",
};

function fmtCnpjExcel(cnpj: string | null | undefined): string {
  const d = String(cnpj ?? "").replace(/\D/g, "");
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  return cnpj ?? "—";
}

function fmtDateExcel(s: string | undefined | null): string {
  if (!s) return "—";
  if (/^\d{8}$/.test(s)) return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  return s;
}

export async function exportMapaFundosExcel(p: MapaFundosExportParams): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator  = "CVPAR Quadrante";
  wb.created  = new Date();
  wb.modified = new Date();

  // ── helpers locais ────────────────────────────────────────────────────────────
  const addKV2 = (ws: ExcelJS.Worksheet, key: string, val: string | number) => {
    const r = ws.addRow([key, val]);
    applyFill(r.getCell(1), "FFF3F4F6");
    r.getCell(1).font   = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    r.getCell(2).font   = { size: 9, name: "Calibri", color: { argb: C.INK } };
    r.getCell(1).border = borders;
    r.getCell(2).border = borders;
    r.height = 16;
  };

  const addSection2 = (ws: ExcelJS.Worksheet, label: string, nCols = 2) => {
    const r = ws.addRow([label]);
    ws.mergeCells(r.number, 1, r.number, nCols);
    applyFill(r.getCell(1), C.GRAY_HEAD);
    r.getCell(1).font      = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
    r.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
    r.height = 20;
  };

  // ────────────────────────────────────────────────────────────────
  // Aba 1 — RESUMO
  // ────────────────────────────────────────────────────────────────
  const wsR = wb.addWorksheet("Resumo", {
    properties: { tabColor: { argb: C.GREEN_DARK.replace("FF", "") } },
  });
  wsR.columns = [{ width: 30 }, { width: 52 }];

  const titleRow = wsR.addRow(["MAPA DE FUNDOS — CVPAR QUADRANTE"]);
  wsR.mergeCells(titleRow.number, 1, titleRow.number, 2);
  applyFill(titleRow.getCell(1), C.GREEN_DARK);
  titleRow.getCell(1).font      = { bold: true, color: { argb: C.WHITE }, size: 11, name: "Calibri" };
  titleRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  titleRow.height = 24;
  wsR.addRow([]);

  addSection2(wsR, "IDENTIFICAÇÃO DO FUNDO");
  addKV2(wsR, "Fundo", p.seedNome);
  addKV2(wsR, "CNPJ",  fmtCnpjExcel(p.seedCnpj));
  addKV2(wsR, "Data Base", fmtDateExcel(p.dtposicao));

  wsR.addRow([]);
  addSection2(wsR, "ATIVO — CARTEIRA");
  addKV2(wsR, "Nível explorado", `${p.nivelAtivo}`);
  addKV2(wsR, "Fundos investidos", p.rowsAtivo.filter(r => r.tipo === "fundo").length);
  addKV2(wsR, "Ativos diretos",    p.rowsAtivo.filter(r => r.tipo === "ativo").length);
  addKV2(wsR, "Total de nós",      p.rowsAtivo.length);

  wsR.addRow([]);
  addSection2(wsR, "PASSIVO — INVESTIDORES");
  addKV2(wsR, "Nível explorado",   `${p.nivelPassivo}`);
  addKV2(wsR, "Cotistas",          p.rowsPassivo.filter(r => r.tipo === "cotista").length);
  addKV2(wsR, "Fundos investidores", p.rowsPassivo.filter(r => r.tipo === "fundo").length);
  addKV2(wsR, "Total de nós",      p.rowsPassivo.length);

  if (p.plPassivoTotal != null && p.plPassivoTotal > 0) {
    wsR.addRow([]);
    addSection2(wsR, "PASSIVO FUNDOS (dados importados)");
    addKV2(wsR, "Total Passivo (R$)",      new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.plPassivoTotal));
    addKV2(wsR, "Data Posição do Passivo", fmtDateExcel(p.dataPassivoUsada));
    const notaRow = wsR.addRow(["Nota", "% do passivo calculado sobre total do passivo importado (≠ PL da carteira XML)"]);
    applyFill(notaRow.getCell(1), "FFF3F4F6");
    notaRow.getCell(1).font = { bold: true, size: 8, name: "Calibri", color: { argb: C.INK_LIGHT } };
    notaRow.getCell(2).font = { italic: true, size: 8, name: "Calibri", color: { argb: C.INK_LIGHT } };
    notaRow.getCell(1).border = borders;
    notaRow.getCell(2).border = borders;
    notaRow.height = 16;
  }

  wsR.addRow([]);
  const genRow = wsR.addRow(["Gerado em", new Date().toLocaleString("pt-BR")]);
  applyFill(genRow.getCell(1), "FFF3F4F6");
  genRow.getCell(1).font   = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
  genRow.getCell(2).font   = { size: 9, name: "Calibri", color: { argb: C.INK } };
  genRow.getCell(1).border = borders;
  genRow.getCell(2).border = borders;
  genRow.height = 16;

  // ────────────────────────────────────────────────────────────────
  // Aba 2 — PASSIVO (quem investe no fundo)
  // ────────────────────────────────────────────────────────────────
  const wsP = wb.addWorksheet("Passivo — Investidores", {
    properties: { tabColor: { argb: C_VIOLET_HDR.replace("FF", "") } },
  });

  const PASS_COLS = [
    { header: "Nível",             width: 8  },
    { header: "Tipo",              width: 12 },
    { header: "Investidor",        width: 52 },
    { header: "CNPJ",              width: 22 },
    { header: "% Passivo (passo)", width: 20 },
    { header: "% Passivo (acum.)", width: 20 },
  ];
  wsP.columns = PASS_COLS.map(c => ({ width: c.width }));

  const passTitleRow = wsP.addRow([`PASSIVO — INVESTIDORES — ${p.seedNome} — ${fmtDateExcel(p.dtposicao)}`]);
  wsP.mergeCells(passTitleRow.number, 1, passTitleRow.number, PASS_COLS.length);
  applyFill(passTitleRow.getCell(1), C_VIOLET_HDR);
  passTitleRow.getCell(1).font      = { bold: true, color: { argb: C.WHITE }, size: 11, name: "Calibri" };
  passTitleRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  passTitleRow.height = 24;
  wsP.addRow([]);

  const passHead = wsP.addRow(PASS_COLS.map(c => c.header));
  styleHeaderRow(passHead, PASS_COLS.length);
  [5, 6].forEach(c => {
    applyFill(passHead.getCell(c), C_VIOLET_HDR);
    passHead.getCell(c).font = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
  });

  let altP = 0;
  for (const row of p.rowsPassivo) {
    const isCotista = row.tipo === "cotista";
    const isFundo   = row.tipo === "fundo";
    const isAlt     = altP % 2 !== 0;

    const r = wsP.addRow([
      `L${row.nivel}`,
      isCotista ? "Cotista" : "Fundo",
      row.nome || "—",
      isCotista ? "—" : fmtCnpjExcel(row.cnpj),
      row.pctPasso > 0 ? row.pctPasso : null,
      row.pctAcum  > 0 ? row.pctAcum  : null,
    ]);

    const bg = isCotista ? C_VIOLET_BG : isAlt ? C.GRAY_ALT : C.WHITE;
    for (let c = 1; c <= PASS_COLS.length; c++) {
      applyFill(r.getCell(c), bg);
      r.getCell(c).font   = { size: 9, name: "Calibri", color: { argb: isCotista ? C_VIOLET_FG : C.INK } };
      r.getCell(c).border = borders;
    }
    r.getCell(1).alignment = { horizontal: "center" };
    r.getCell(1).font      = { bold: true, size: 9, name: "Calibri", color: { argb: isCotista ? C_VIOLET_FG : C.INK_LIGHT } };
    r.getCell(2).font      = { size: 9, name: "Calibri", color: { argb: isCotista ? C_VIOLET_FG : C.INK_LIGHT } };
    r.getCell(2).alignment = { horizontal: "center" };
    r.getCell(3).font      = { bold: isFundo || isCotista, size: 9, name: "Calibri", color: { argb: isCotista ? C_VIOLET_FG : C.INK } };
    r.getCell(4).font      = { size: 8, name: "Calibri", color: { argb: C.INK_LIGHT } };
    r.getCell(4).alignment = { horizontal: "center" };

    if (row.pctPasso > 0) {
      r.getCell(5).numFmt    = "0.00%";
      r.getCell(5).alignment = { horizontal: "right" };
      r.getCell(5).font      = { size: 9, name: "Calibri", color: { argb: isCotista ? C_VIOLET_FG : C.OK_FG } };
    } else {
      r.getCell(5).value = "—"; r.getCell(5).alignment = { horizontal: "center" };
    }
    if (row.pctAcum > 0) {
      r.getCell(6).numFmt    = "0.00%";
      r.getCell(6).alignment = { horizontal: "right" };
      r.getCell(6).font      = { bold: true, size: 9, name: "Calibri", color: { argb: isCotista ? C_VIOLET_FG : C.OK_FG } };
    } else {
      r.getCell(6).value = "—"; r.getCell(6).alignment = { horizontal: "center" };
    }
    r.height = 18;
    altP++;
  }

  if (p.rowsPassivo.length === 0) {
    const emptyRow = wsP.addRow(["Sem dados de passivo disponíveis para este fundo."]);
    wsP.mergeCells(emptyRow.number, 1, emptyRow.number, PASS_COLS.length);
    emptyRow.getCell(1).font      = { italic: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    emptyRow.getCell(1).alignment = { horizontal: "center" };
  }

  if (p.rowsPassivo.some(r => r.tipo === "cotista")) {
    wsP.addRow([]);
    const legendRow = wsP.addRow(["■ Azul", "Cotista (fonte: Passivo Fundos — planilha importada)"]);
    wsP.mergeCells(legendRow.number, 2, legendRow.number, PASS_COLS.length);
    applyFill(legendRow.getCell(1), C_VIOLET_BG);
    applyFill(legendRow.getCell(2), C_VIOLET_BG);
    legendRow.getCell(1).font = { bold: true, size: 8, name: "Calibri", color: { argb: C_VIOLET_FG } };
    legendRow.getCell(2).font = { italic: true, size: 8, name: "Calibri", color: { argb: C_VIOLET_FG } };
    legendRow.height = 16;
  }

  wsP.views = [{ state: "frozen", ySplit: 3 }];

  // ────────────────────────────────────────────────────────────────
  // Aba 3 — ATIVO (carteira do fundo)
  // ────────────────────────────────────────────────────────────────
  const wsA = wb.addWorksheet("Ativo — Carteira", {
    properties: { tabColor: { argb: C.GREEN_DARK.replace("FF", "") } },
  });

  const ATIV_COLS = [
    { header: "Nível",          width: 8  },
    { header: "Tipo",           width: 12 },
    { header: "Nome",           width: 52 },
    { header: "CNPJ",           width: 22 },
    { header: "Seção",          width: 16 },
    { header: "% PL (passo)",   width: 18 },
    { header: "% PL (acum.)",   width: 18 },
  ];
  wsA.columns = ATIV_COLS.map(c => ({ width: c.width }));

  const ativTitleRow = wsA.addRow([`ATIVO — CARTEIRA — ${p.seedNome} — ${fmtDateExcel(p.dtposicao)}`]);
  wsA.mergeCells(ativTitleRow.number, 1, ativTitleRow.number, ATIV_COLS.length);
  applyFill(ativTitleRow.getCell(1), C.GREEN_DARK);
  ativTitleRow.getCell(1).font      = { bold: true, color: { argb: C.WHITE }, size: 11, name: "Calibri" };
  ativTitleRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  ativTitleRow.height = 24;
  wsA.addRow([]);

  const ativHead = wsA.addRow(ATIV_COLS.map(c => c.header));
  styleHeaderRow(ativHead, ATIV_COLS.length);
  const C_GREEN_DARK_HDR = "FF005C3B";
  [6, 7].forEach(c => {
    applyFill(ativHead.getCell(c), C_GREEN_DARK_HDR);
    ativHead.getCell(c).font = { bold: true, color: { argb: C.WHITE }, size: 9, name: "Calibri" };
  });

  let altA = 0;
  for (const row of p.rowsAtivo) {
    const isFundo   = row.tipo === "fundo";
    const isAtivo   = row.tipo === "ativo";
    const isAlt     = altA % 2 !== 0;

    const tipoLabel = isFundo ? "Fundo" : isAtivo ? "Ativo" : "—";
    const secLabel  = row.section ? (SECTION_LABELS[row.section] ?? row.section) : (isFundo ? "Cota" : "—");

    const r = wsA.addRow([
      `L${row.nivel}`,
      tipoLabel,
      row.nome || "—",
      fmtCnpjExcel(row.cnpj),
      secLabel,
      row.pctPasso > 0 ? row.pctPasso : null,
      row.pctAcum  > 0 ? row.pctAcum  : null,
    ]);

    for (let c = 1; c <= ATIV_COLS.length; c++) {
      applyFill(r.getCell(c), isAlt ? C.GRAY_ALT : C.WHITE);
      r.getCell(c).font   = { size: 9, name: "Calibri", color: { argb: C.INK } };
      r.getCell(c).border = borders;
    }
    r.getCell(1).alignment = { horizontal: "center" };
    r.getCell(1).font      = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    r.getCell(2).font      = { size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    r.getCell(2).alignment = { horizontal: "center" };
    r.getCell(3).font      = { bold: isFundo, size: 9, name: "Calibri", color: { argb: C.INK } };
    r.getCell(4).font      = { size: 8, name: "Calibri", color: { argb: C.INK_LIGHT } };
    r.getCell(4).alignment = { horizontal: "center" };
    r.getCell(5).font      = { size: 8, name: "Calibri", color: { argb: C.INK_LIGHT } };
    r.getCell(5).alignment = { horizontal: "center" };

    if (row.pctPasso > 0) {
      r.getCell(6).numFmt    = "0.00%";
      r.getCell(6).alignment = { horizontal: "right" };
      r.getCell(6).font      = { size: 9, name: "Calibri", color: { argb: C.OK_FG } };
    } else {
      r.getCell(6).value = "—"; r.getCell(6).alignment = { horizontal: "center" };
    }
    if (row.pctAcum > 0) {
      r.getCell(7).numFmt    = "0.00%";
      r.getCell(7).alignment = { horizontal: "right" };
      r.getCell(7).font      = { bold: true, size: 9, name: "Calibri", color: { argb: C.OK_FG } };
    } else {
      r.getCell(7).value = "—"; r.getCell(7).alignment = { horizontal: "center" };
    }
    r.height = 18;
    altA++;
  }

  if (p.rowsAtivo.length === 0) {
    const emptyRow = wsA.addRow(["Sem dados de carteira disponíveis para este fundo."]);
    wsA.mergeCells(emptyRow.number, 1, emptyRow.number, ATIV_COLS.length);
    emptyRow.getCell(1).font      = { italic: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    emptyRow.getCell(1).alignment = { horizontal: "center" };
  }

  wsA.views = [{ state: "frozen", ySplit: 3 }];

  // ── Download ─────────────────────────────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const blob   = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const today  = new Date();
  const ts = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("");
  const safeName = p.seedNome
    .replace(/[^a-zA-Z0-9\u00C0-\u024F\s-]/g, "_")
    .slice(0, 40)
    .trim();
  anchor.href     = url;
  anchor.download = `MapaFundos_${safeName}_${ts}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
