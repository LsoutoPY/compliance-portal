/**
 * Exportação Excel/PDF do Relatório Consolidado de Risco de Mercado (por fundo gerido).
 * Espelha scripts/gerar-relatorio-risco.py — dados via edge function buscar-risco-consolidado.
 */
import * as XLSX from "xlsx-js-style";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { RiscoConsolidadoResponse } from "@/types/risco-mercado";

// ── API ─────────────────────────────────────────────────────────────────────

export async function fetchRiscoConsolidado(
  dataPosicao?: string | null,
): Promise<RiscoConsolidadoResponse> {
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "";
  const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";
  const qs = dataPosicao ? `?data_posicao=${encodeURIComponent(dataPosicao)}` : "";
  const r = await fetch(
    `${SUPABASE_URL}/functions/v1/buscar-risco-consolidado${qs}`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
  );
  const json = await r.json();
  if (!r.ok || json?.success === false) {
    throw new Error(json?.error ?? `HTTP ${r.status}`);
  }
  return json as RiscoConsolidadoResponse;
}

// ── Paleta Frame Control Center — Equity OS (index.css + elegibilidade-export) ──

type RGB = [number, number, number];

const PAL = {
  headerBg:    "1C2333",  // nav dark — hsl(220,13%,10%)
  accentGreen: "003D27",  // sidebar ativo
  sidebarGray: "737D87",  // sidebar bg
  bg:          "F9FAFB",
  panel:       "FFFFFF",
  border:      "E5E7EB",
  text:        "272A30",
  muted:       "6B7280",
  errorBg:     "FEE2E2",
  errorText:   "991B1B",
  warningBg:   "FEF3C7",
  warningText: "92400E",
  white:       "FFFFFF",
} as const;

const PDF_C = {
  headerBg:    [28,  35,  51]  as RGB,  // #1C2333
  accentGreen: [0,   61,  39]  as RGB,  // #003D27
  sidebarGray: [115, 125, 135] as RGB,  // #737D87
  bg:          [249, 250, 251] as RGB,
  panel:       [255, 255, 255] as RGB,
  text:        [39,  42,  48]  as RGB,
  muted:       [107, 114, 128] as RGB,
  border:      [229, 231, 235] as RGB,
  errorBg:     [254, 226, 226] as RGB,
  errorText:   [153, 27,  27]  as RGB,
  warningBg:   [254, 243, 199] as RGB,
  warningText: [146, 64,  14]  as RGB,
  white:       [255, 255, 255] as RGB,
} as const;

const xBorder = {
  top:    { style: "thin" as const, color: { rgb: PAL.border } },
  bottom: { style: "thin" as const, color: { rgb: PAL.border } },
  left:   { style: "thin" as const, color: { rgb: PAL.border } },
  right:  { style: "thin" as const, color: { rgb: PAL.border } },
};

function to6(hex: string) { return hex.replace("#", "").toUpperCase().slice(-6); }
function xFill(hex: string) { return { patternType: "solid" as const, fgColor: { rgb: to6(hex) } }; }
function xFont(hex: string, bold = false, sz = 9) {
  return { name: "Calibri", sz, bold, color: { rgb: to6(hex) } };
}
function xAlign(h: "left" | "center" | "right" = "left") {
  return { horizontal: h, vertical: "center" as const, wrapText: true };
}

/**
 * jsPDF (Helvetica) nao suporta bem unicode — caracteres como ÷, —, √ e acentos
 * forcam troca de codificacao e espacam cada letra. Ver elegibilidade-export.ts.
 */
function sanitizePdfText(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/−|—|–/g, "-")
    .replace(/×/g, "x")
    .replace(/÷/g, "/")
    .replace(/√/g, "sqrt")
    .replace(/\u2212/g, "-")
    .replace(/\u00d7/g, "x")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'");
}

function fmtDataIso(iso: string): string {
  try {
    return format(parseISO(`${iso}T12:00:00`), "dd/MM/yyyy", { locale: ptBR });
  } catch {
    return iso;
  }
}

function fmtPctDecimal(v: number | null | undefined, digits = 3): string {
  if (v == null) return "—";
  const pct = v * 100;
  return `${pct >= 0 ? "" : ""}${pct.toFixed(digits)}%`;
}

function fmtPctSigned(v: number | null | undefined): string {
  if (v == null) return "—";
  const pct = v * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(3)}%`;
}

function fmtBrl(v: number | null | undefined, decimals = 2): string {
  if (v == null) return "—";
  return v.toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtRs(v: number | null | undefined): string {
  if (v == null) return "—";
  return `R$ ${v.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`;
}

type CellStyle = { fill: string; font: string; bold?: boolean };

function stressCellStyle(sv: number | null, contratado: number | null, rowBg: string): CellStyle {
  if (sv == null || !contratado) return { fill: rowBg, font: PAL.text };
  const lim = contratado / 100;
  if (Math.abs(sv) > lim) return { fill: PAL.errorBg, font: PAL.errorText, bold: true };
  if (Math.abs(sv) > lim * 0.8) return { fill: PAL.warningBg, font: PAL.warningText };
  return { fill: rowBg, font: PAL.text };
}

function consumoCellStyle(consumo: number | null, rowBg: string): CellStyle {
  if (consumo == null) return { fill: rowBg, font: PAL.text };
  if (consumo > 100) return { fill: PAL.errorBg, font: PAL.errorText, bold: true };
  if (consumo > 80) return { fill: PAL.warningBg, font: PAL.warningText };
  return { fill: rowBg, font: PAL.text };
}

function varAltoStyle(rowBg: string): CellStyle {
  return { fill: PAL.warningBg, font: PAL.warningText };
}

// ── Excel ───────────────────────────────────────────────────────────────────

export function exportRiscoConsolidadoExcel(data: RiscoConsolidadoResponse): void {
  const { linhas, cenarios, data_base: dataBase, summary } = data;
  const wb = XLSX.utils.book_new();
  const ws: XLSX.WorkSheet = {};
  const nCols = 7 + cenarios.length + 2;

  const merge = (r1: number, c1: number, r2: number, c2: number) => {
    if (!ws["!merges"]) ws["!merges"] = [];
    ws["!merges"].push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });
  };

  const setCell = (r: number, c: number, v: string | number | null, style?: object) => {
    const ref = XLSX.utils.encode_cell({ r, c });
    const isNum = typeof v === "number";
    ws[ref] = { v: v ?? "", t: isNum ? "n" : "s", ...(style ? { s: style } : {}) };
  };

  // Linha 1 — título
  merge(0, 0, 0, nCols - 1);
  setCell(0, 0, "QUADRANTE INVESTIMENTOS — RELATÓRIO DE RISCO DE MERCADO CONSOLIDADO", {
    fill: xFill(PAL.headerBg), font: xFont(PAL.white, true, 12), alignment: xAlign("center"), border: xBorder,
  });

  // Linha 2 — subtítulo
  merge(1, 0, 1, nCols - 1);
  const gerado = format(new Date(), "dd/MM/yyyy HH:mm", { locale: ptBR });
  setCell(1, 0, `Data base: ${fmtDataIso(dataBase)}    |    Gerado em: ${gerado}`, {
    fill: xFill(PAL.accentGreen), font: xFont(PAL.white, false, 10), alignment: xAlign("center"), border: xBorder,
  });

  // Linha 3 — cabeçalhos
  const titulos = [
    "Fundo", "PL\n(R$)", "Exposição\n(R$)",
    "VaR Param\n1d 95% (%)", "ETL Param\n(R$)",
    "VaR Histórico\n21d 95% (%)", "ETL Histórico\n(R$)",
    ...cenarios.map((c) => `Stress\n${c}\n(%)`),
    "Stress\nContratado\n(%)", "Consumo\nStress\n(%)",
  ];
  titulos.forEach((t, ci) => {
    setCell(2, ci, t, {
      fill: xFill(PAL.headerBg), font: xFont(PAL.white, true, 8), alignment: xAlign("center"), border: xBorder,
    });
  });

  // Dados
  linhas.forEach((row, ri) => {
    const r = ri + 3;
    const rowBg = ri % 2 === 0 ? PAL.bg : PAL.panel;
    const baseStyle = { fill: xFill(rowBg), font: xFont(PAL.text), alignment: xAlign("right") as object, border: xBorder };

    setCell(r, 0, row.nome_fundo, { ...baseStyle, alignment: xAlign("left") });

    setCell(r, 1, row.pl, { ...baseStyle, numFmt: "#,##0.00" });
    setCell(r, 2, row.exposicao, { ...baseStyle, numFmt: "#,##0.00" });

    const vpSt = row.var_param_pct != null && row.var_param_pct > 0.03
      ? varAltoStyle(rowBg) : { fill: rowBg, font: PAL.text };
    setCell(r, 3, row.var_param_pct != null ? row.var_param_pct : null, {
      fill: xFill(vpSt.fill), font: xFont(vpSt.font), alignment: xAlign("right"), border: xBorder, numFmt: "0.00%",
    });

    setCell(r, 4, row.etl_param_rs, { ...baseStyle, numFmt: "#,##0.00" });

    const vhSt = row.var_hist_pct != null && row.var_hist_pct > 0.03
      ? varAltoStyle(rowBg) : { fill: rowBg, font: PAL.text };
    setCell(r, 5, row.var_hist_pct != null ? row.var_hist_pct : null, {
      fill: xFill(vhSt.fill), font: xFont(vhSt.font), alignment: xAlign("right"), border: xBorder, numFmt: "0.00%",
    });

    setCell(r, 6, row.etl_hist_rs, { ...baseStyle, numFmt: "#,##0.00" });

    let col = 7;
    for (const cen of cenarios) {
      const sv = row.stress[cen] ?? null;
      const st = stressCellStyle(sv, row.stress_contratado, rowBg);
      setCell(r, col, sv, {
        fill: xFill(st.fill),
        font: xFont(st.font, st.bold),
        alignment: xAlign("right"),
        border: xBorder,
        numFmt: "+0.000%;-0.000%",
      });
      col++;
    }

    setCell(r, col, row.stress_contratado != null ? row.stress_contratado / 100 : "—", {
      ...baseStyle, numFmt: row.stress_contratado != null ? "0.00%" : undefined,
    });
    col++;

    const cs = consumoCellStyle(row.consumo_pct, rowBg);
    setCell(r, col, row.consumo_pct != null ? row.consumo_pct / 100 : "—", {
      fill: xFill(cs.fill),
      font: xFont(cs.font, cs.bold),
      alignment: xAlign("right"),
      border: xBorder,
      numFmt: row.consumo_pct != null ? "0.0%" : undefined,
    });
  });

  // Total
  const totalRow = linhas.length + 3;
  merge(totalRow, 0, totalRow, 0);
  for (let c = 0; c < nCols; c++) {
    const v = c === 0 ? "TOTAL GERAL" : c === 1 ? summary.pl_total : c === 2 ? summary.exposicao_total : "";
    setCell(totalRow, c, v, {
      fill: xFill(PAL.headerBg), font: xFont(PAL.white, true, 9),
      alignment: xAlign(c === 0 ? "center" : "right"), border: xBorder,
      ...(c === 1 || c === 2 ? { numFmt: "#,##0.00" } : {}),
    });
  }

  // Nota rodapé
  const notaRow = totalRow + 2;
  merge(notaRow, 0, notaRow, nCols - 1);
  setCell(notaRow, 0,
    "* VaR Parametrico de 1 dia com intervalo de confianca de 95%, calculado a partir do VaR 21d escalonado (/ sqrt(21)). " +
    "VaR Historico de 21 dias uteis com IC 95%.  ** O relatorio nao considera as exposicoes dos fundos investidos (look-through).",
    {
      fill: xFill(PAL.bg),
      font: { name: "Calibri", sz: 7, italic: true, color: { rgb: PAL.muted } },
      alignment: { wrapText: true, vertical: "top" },
      border: xBorder,
    },
  );

  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: notaRow, c: nCols - 1 } });
  ws["!cols"] = [
    { wch: 30 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 16 },
    { wch: 16 }, { wch: 16 },
    ...cenarios.map(() => ({ wch: 14 })),
    { wch: 14 }, { wch: 12 },
  ];
  ws["!freeze"] = { xSplit: 1, ySplit: 3, topLeftCell: "B4", activePane: "bottomRight", state: "frozen" };

  XLSX.utils.book_append_sheet(wb, ws, "Risco de Mercado");
  XLSX.writeFile(wb, `Risco_Consolidado_${dataBase}.xlsx`);
}

// ── PDF ─────────────────────────────────────────────────────────────────────

const MARGIN = 12;

export function exportRiscoConsolidadoPdf(data: RiscoConsolidadoResponse): void {
  const { linhas, cenarios, data_base: dataBase, summary } = data;
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();

  const headerCols = [
    "Fundo", "PL\n(R$)", "Exposicao\n(R$)",
    "VaR Param\n1d 95% (%)", "ETL Param\n(R$)",
    "VaR Hist\n21d 95% (%)", "ETL Hist\n(R$)",
    ...cenarios.map((c) => sanitizePdfText(`Stress\n${c}\n(%)`)),
    "Stress\nContrat.\n(%)", "Consumo\n(%)",
  ].map(sanitizePdfText);

  const bodyRows = linhas.map((row) => {
    const stressCols = cenarios.map((c) => fmtPctSigned(row.stress[c] ?? null));
    return [
      row.nome_fundo,
      fmtBrl(row.pl),
      fmtBrl(row.exposicao),
      fmtPctDecimal(row.var_param_pct),
      fmtRs(row.etl_param_rs),
      fmtPctDecimal(row.var_hist_pct),
      fmtRs(row.etl_hist_rs),
      ...stressCols,
      row.stress_contratado != null ? `${row.stress_contratado.toFixed(1)}%` : "-",
      row.consumo_pct != null ? `${row.consumo_pct.toFixed(1)}%` : "-",
    ].map(sanitizePdfText);
  });

  bodyRows.push(
    [
      "TOTAL GERAL",
      fmtBrl(summary.pl_total),
      fmtBrl(summary.exposicao_total),
      ...Array(headerCols.length - 3).fill("-"),
    ].map(sanitizePdfText),
  );

  const gerado = format(new Date(), "dd/MM/yyyy HH:mm", { locale: ptBR });
  let startY = MARGIN;

  autoTable(pdf, {
    startY,
    head: [[sanitizePdfText(`Relatorio Diario de Risco de Mercado - Data base: ${fmtDataIso(dataBase)}`)]],
    body: [[sanitizePdfText(`Gerado em ${gerado}  |  Quadrante Investimentos`)]],
    theme: "plain",
    margin: { left: MARGIN, right: MARGIN },
    styles: { cellPadding: 2, font: "helvetica" },
    headStyles: {
      fillColor: PDF_C.headerBg, textColor: PDF_C.white, fontStyle: "bold", fontSize: 11, halign: "center",
    },
    bodyStyles: {
      fillColor: PDF_C.accentGreen, textColor: PDF_C.white, fontSize: 8, halign: "center",
    },
  });

  startY = (pdf as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 3;

  const stressStartCol = 7;
  const consumoCol = headerCols.length - 1;
  const contratadoCol = headerCols.length - 2;

  autoTable(pdf, {
    startY,
    head: [headerCols],
    body: bodyRows,
    margin: { left: MARGIN, right: MARGIN, bottom: 14 },
    theme: "grid",
    styles: {
      fontSize: 7.5,
      cellPadding: { top: 2, right: 2, bottom: 2, left: 2 },
      lineColor: PDF_C.border,
      lineWidth: 0.2,
      textColor: PDF_C.text,
      valign: "middle",
    },
    headStyles: {
      fillColor: PDF_C.headerBg, textColor: PDF_C.white, fontStyle: "bold", fontSize: 7,
      halign: "center",
    },
    alternateRowStyles: { fillColor: PDF_C.bg },
    columnStyles: {
      0: { cellWidth: 45, fontStyle: "bold", halign: "left" },
    },
    didParseCell: (hook) => {
      const rowIdx = hook.row.index;
      const colIdx = hook.column.index;
      const isTotal = rowIdx === bodyRows.length - 1;

      if (isTotal) {
        hook.cell.styles.fillColor = PDF_C.headerBg;
        hook.cell.styles.textColor = PDF_C.white;
        hook.cell.styles.fontStyle = "bold";
        return;
      }

      const linha = linhas[rowIdx];
      if (!linha) return;

      // VaR elevado (>3%)
      if (colIdx === 3 && linha.var_param_pct != null && linha.var_param_pct > 0.03) {
        hook.cell.styles.fillColor = PDF_C.warningBg;
        hook.cell.styles.textColor = PDF_C.warningText;
      }
      if (colIdx === 5 && linha.var_hist_pct != null && linha.var_hist_pct > 0.03) {
        hook.cell.styles.fillColor = PDF_C.warningBg;
        hook.cell.styles.textColor = PDF_C.warningText;
      }

      if (colIdx >= stressStartCol && colIdx < stressStartCol + cenarios.length) {
        const cenIdx = colIdx - stressStartCol;
        const sv = linha.stress[cenarios[cenIdx]] ?? null;
        const sc = linha.stress_contratado;
        if (sv != null && sc) {
          if (Math.abs(sv) > sc / 100) {
            hook.cell.styles.fillColor = PDF_C.errorBg;
            hook.cell.styles.textColor = PDF_C.errorText;
            hook.cell.styles.fontStyle = "bold";
          } else if (Math.abs(sv) > (sc / 100) * 0.8) {
            hook.cell.styles.fillColor = PDF_C.warningBg;
            hook.cell.styles.textColor = PDF_C.warningText;
          }
        }
      }

      if (colIdx === consumoCol && linha.consumo_pct != null) {
        if (linha.consumo_pct > 100) {
          hook.cell.styles.fillColor = PDF_C.errorBg;
          hook.cell.styles.textColor = PDF_C.errorText;
          hook.cell.styles.fontStyle = "bold";
        } else if (linha.consumo_pct > 80) {
          hook.cell.styles.fillColor = PDF_C.warningBg;
          hook.cell.styles.textColor = PDF_C.warningText;
        }
      }

      if (colIdx >= 1 && colIdx <= contratadoCol && colIdx !== 0) {
        hook.cell.styles.halign = "right";
      }
    },
  });

  const finalY = (pdf as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 3;

  autoTable(pdf, {
    startY: finalY,
    body: [[
      sanitizePdfText(
        "* VaR Parametrico de 1 dia com IC 95%, calculado a partir do VaR 21d (/ sqrt(21)). " +
        "VaR Historico de 21 dias uteis com IC 95%. " +
        "** Relatorio nao considera look-through dos fundos investidos.",
      ),
    ]],
    theme: "plain",
    margin: { left: MARGIN, right: MARGIN },
    styles: {
      fontSize: 6,
      cellPadding: { top: 2, right: 3, bottom: 2, left: 3 },
      textColor: PDF_C.muted,
      fillColor: PDF_C.bg,
      font: "helvetica",
      fontStyle: "italic",
    },
    columnStyles: { 0: { cellWidth: pageW - 2 * MARGIN } },
  });

  pdf.save(`Risco_Consolidado_${dataBase}.pdf`);
}
