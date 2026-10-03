/**
 * Exportação Excel do relatório diário de rentabilidade
 * Paleta de cores alinhada ao restante do sistema (exportFundoExcel.ts)
 */

import ExcelJS from "exceljs";
import type { AtivoRelatorio, FundoRelatorio } from "@/lib/generateRentabilidadeRelatorioHTML_v2";
import { abreviarAdministrador } from "@/lib/generateRentabilidadeRelatorioHTML_v2";
import { isFundoExclusivoRentabilidade } from "@/lib/fundosExclusivosRentabilidade";

// ── Paleta de cores (ARGB) — alinhada ao exportFundoExcel.ts ─────────────────
const C = {
  GREEN_DARK:   "FF00734A",
  GREEN_LIGHT:  "FF9FE1CB",
  GRAY_HEAD:    "FF5B6066",
  GRAY_SUB:     "FFF2F4F6",
  GRAY_ALT:     "FFF9FAFB",
  WHITE:        "FFFFFFFF",
  INK:          "FF1A1A2E",
  INK_LIGHT:    "FF5B6066",
  POS_FG:       "FF1B6B3A",
  POS_BG:       "FFE6F9F1",
  NEG_FG:       "FF9C0006",
  NEG_BG:       "FFFDE9E9",
  NEUTRO_FG:    "FF555555",
  BORDER:       "FFD1D5DB",
};

const thin: ExcelJS.Border = { style: "thin", color: { argb: C.BORDER } };
const borders = { top: thin, left: thin, bottom: thin, right: thin };

function applyFill(cell: ExcelJS.Cell, argb: string) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function pctColor(v: number | null): { fg: string; bg: string } {
  if (v == null || (v >= -0.001 && v <= 0.001)) return { fg: C.NEUTRO_FG, bg: C.WHITE };
  if (v > 0) return { fg: C.POS_FG, bg: C.POS_BG };
  return { fg: C.NEG_FG, bg: C.NEG_BG };
}

function fmtPct(v: number | null | undefined, casas = 4): string {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(casas)}%`;
}

/** Formata coluna vs CDI igual à UI: "CDI +79,17% a.a.\n534,11% do CDI" */
function fmtVsCDI(cdiPlusAa: number | null | undefined, pctCdi: number | null | undefined): string {
  if ((cdiPlusAa == null) && (pctCdi == null)) return "—";
  // Quando retorno é negativo (% do CDI < 0), exibir "—" como na UI
  if (pctCdi != null && pctCdi < 0) return "—";
  const line1 = cdiPlusAa != null
    ? (cdiPlusAa >= 0
        ? `CDI +${cdiPlusAa.toFixed(2).replace(".", ",")}% a.a.`
        : `CDI ${cdiPlusAa.toFixed(2).replace(".", ",")}% a.a.`)
    : "";
  const line2 = pctCdi != null
    ? `${pctCdi.toFixed(2).replace(".", ",")}% do CDI`
    : "";
  return [line1, line2].filter(Boolean).join("\n");
}

/** Retorno + linha "% do CDI" abaixo (coluna Ret/Var 12M) */
function fmtRetComPctCdi(
  ret: number | null | undefined,
  pctCdi: number | null | undefined,
  casasRet = 2,
): string {
  const line1 = ret != null ? fmtPct(ret, casasRet) : null;
  if (pctCdi == null || pctCdi < 0) return line1 ?? "—";
  const line2 = `${pctCdi.toFixed(2).replace(".", ",")}% do CDI`;
  return line1 != null ? `${line1}\n${line2}` : line2;
}

function fmtPctSemSinal(v: number | null | undefined, casas = 2): string {
  if (v == null) return "—";
  return `${v.toFixed(casas)}%`;
}

const BRL_NUM_FMT = '"R$" #,##0.00';

function fmtBRLText(v: number | null | undefined): string {
  if (v == null) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}

function writeBRLCell(row: ExcelJS.Row, col: number, v: number | null | undefined) {
  const cell = row.getCell(col);
  if (v == null) {
    cell.value = null;
    return;
  }
  cell.value = v;
  cell.numFmt = BRL_NUM_FMT;
  cell.alignment = { horizontal: "right", vertical: "middle" };
}

function fmtCota(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 6, maximumFractionDigits: 8 });
}

function fmtCnpj(cnpj: string): string {
  const numeros = cnpj.replace(/\D/g, "");
  if (numeros.length !== 14) return cnpj;
  return numeros.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

// ── Colunas da tabela principal ───────────────────────────────────────────────
const COLS = [
  { header: "Fundo / Ativo",   width: 48 },
  { header: "PL / Qtd",        width: 18 },
  { header: "Cota / PU",       width: 16 },
  { header: "Adm / % PL",      width: 22 },
  { header: "Ret/Var Dia",      width: 13 },
  { header: "vs CDI Dia",       width: 13 },
  { header: "Ret/Var Mês",      width: 13 },
  { header: "vs CDI Mês",       width: 13 },
  { header: "Ret/Var Ano",      width: 13 },
  { header: "vs CDI Ano",       width: 13 },
  { header: "Ret/Var 12M",      width: 16 },
];
const N = COLS.length;

function styleHeader(ws: ExcelJS.Worksheet, rowNum: number) {
  const row = ws.getRow(rowNum);
  for (let c = 1; c <= N; c++) {
    const cell = row.getCell(c);
    applyFill(cell, C.GREEN_DARK);
    cell.font = { bold: true, color: { argb: C.GREEN_LIGHT }, size: 8, name: "Calibri" };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = borders;
  }
  row.height = 26;
}

function writePctCell(row: ExcelJS.Row, col: number, v: number | null, casas = 4) {
  const cell = row.getCell(col);
  const txt = fmtPct(v, casas);
  cell.value = txt;
  cell.alignment = { horizontal: "right" };
  cell.font = { size: 9, name: "Calibri", color: { argb: pctColor(v).fg } };
  if (v != null && Math.abs(v) > 0.001) {
    applyFill(cell, pctColor(v).bg);
  }
  cell.border = borders;
}

function writePctCellSemSinal(row: ExcelJS.Row, col: number, v: number | null, casas = 2) {
  const cell = row.getCell(col);
  const txt = fmtPctSemSinal(v, casas);
  cell.value = txt;
  cell.alignment = { horizontal: "right" };
  cell.font = { size: 9, name: "Calibri", color: { argb: pctColor(v).fg } };
  cell.border = borders;
}

function sortFundosPorPLDesc(fundos: FundoRelatorio[]): FundoRelatorio[] {
  return [...fundos].sort((a, b) => (b.pl ?? 0) - (a.pl ?? 0));
}

function fmtDataFundo(dataPosicao: string | undefined, fallback: string): string {
  if (!dataPosicao) return fallback;
  return dataPosicao.includes("-")
    ? dataPosicao.split("-").reverse().join("/")
    : dataPosicao;
}

const RES_COLS = [
  { header: "Fundo",         width: 52 },
  { header: "CNPJ",          width: 20 },
  { header: "Data",          width: 14 },
  { header: "Administrador", width: 28 },
  { header: "PL",            width: 18 },
  { header: "Ret. Dia",      width: 13 },
  { header: "Ret. Mês",      width: 13 },
  { header: "Ret. Ano",       width: 13 },
  { header: "Ret. 12M",      width: 16 },
];
const RES_N = RES_COLS.length;

function styleResumoHeaderRow(row: ExcelJS.Row) {
  for (let c = 1; c <= RES_N; c++) {
    applyFill(row.getCell(c), C.GREEN_DARK);
    row.getCell(c).font = { bold: true, color: { argb: C.GREEN_LIGHT }, size: 8, name: "Calibri" };
    row.getCell(c).alignment = {
      horizontal: c <= 4 ? "left" : "center",
      vertical: "middle",
      wrapText: true,
    };
    row.getCell(c).border = borders;
  }
  row.height = 24;
}

function writeResumoFundoRow(
  ws: ExcelJS.Worksheet,
  fundo: FundoRelatorio,
  dataFmt: string,
  alt: boolean,
): ExcelJS.Row {
  const bg = alt ? C.GRAY_ALT : C.WHITE;
  const rRow = ws.addRow([
    fundo.nome_fundo || "—",
    fmtCnpj(fundo.fundo_cnpj),
    fmtDataFundo(fundo.data_posicao, dataFmt),
    abreviarAdministrador(fundo.administrador),
    fundo.pl ?? null,
    fmtPct(fundo.ret_dia_pct, 4),
    fmtPct(fundo.ret_mes_pct, 4),
    fmtRetComPctCdi(fundo.ret_ano_pct, fundo.pct_cdi_ano, 2),
    fmtRetComPctCdi(fundo.ret_12m_pct, fundo.pct_cdi_12m, 2),
  ]);
  for (let c = 1; c <= RES_N; c++) {
    applyFill(rRow.getCell(c), bg);
    rRow.getCell(c).font = { size: 9, name: "Calibri", color: { argb: C.INK } };
    rRow.getCell(c).border = borders;
    rRow.getCell(c).alignment = { horizontal: c <= 4 ? "left" : "right" };
  }
  rRow.getCell(1).font = { bold: true, size: 9, name: "Calibri", color: { argb: C.INK } };
  rRow.getCell(2).font = { size: 8, name: "Courier New", color: { argb: C.INK_LIGHT } };
  const colorResols: Array<[number, number | null]> = [
    [6, fundo.ret_dia_pct],
    [7, fundo.ret_mes_pct],
    [8, fundo.ret_ano_pct],
    [9, fundo.ret_12m_pct],
  ];
  for (const [col, val] of colorResols) {
    if (val != null && Math.abs(val) > 0.001) {
      const cor = pctColor(val);
      applyFill(rRow.getCell(col), cor.bg);
      rRow.getCell(col).font = { bold: true, size: 9, name: "Calibri", color: { argb: cor.fg } };
    }
  }
  rRow.getCell(8).alignment = { horizontal: "right", vertical: "middle", wrapText: true };
  rRow.getCell(9).alignment = { horizontal: "right", vertical: "middle", wrapText: true };
  writeBRLCell(rRow, 5, fundo.pl);
  rRow.height = 22;
  return rRow;
}

function writeResumoSubtotalRow(
  ws: ExcelJS.Worksheet,
  label: string,
  plTotal: number,
) {
  const row = ws.addRow(["", "", label, "", plTotal, "", "", "", ""]);
  for (let c = 1; c <= RES_N; c++) {
    applyFill(row.getCell(c), C.GRAY_HEAD);
    row.getCell(c).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9, name: "Calibri" };
    row.getCell(c).border = borders;
  }
  row.getCell(3).alignment = { horizontal: "left" };
  writeBRLCell(row, 5, plTotal);
  row.getCell(5).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9, name: "Calibri" };
  row.height = 20;
}

function writeResumoSecao(
  ws: ExcelJS.Worksheet,
  titulo: string,
  fundos: FundoRelatorio[],
  dataFmt: string,
) {
  const plSecao = fundos.reduce((s, f) => s + (f.pl ?? 0), 0);
  const secTitle = ws.addRow([
    `${titulo}   ·   ${fundos.length} fundo${fundos.length !== 1 ? "s" : ""}   ·   PL: ${fmtBRLText(plSecao)}`,
  ]);
  ws.mergeCells(secTitle.number, 1, secTitle.number, RES_N);
  applyFill(secTitle.getCell(1), "FF3A6B57");
  secTitle.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10, name: "Calibri" };
  secTitle.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  secTitle.height = 22;

  const hdrRow = ws.addRow(RES_COLS.map((c) => c.header));
  styleResumoHeaderRow(hdrRow);

  let alt = false;
  for (const fundo of fundos) {
    writeResumoFundoRow(ws, fundo, dataFmt, alt);
    alt = !alt;
  }

  if (fundos.length > 0) {
    writeResumoSubtotalRow(ws, `Subtotal — ${titulo}`, plSecao);
  } else {
    const emptyRow = ws.addRow(["Nenhum fundo nesta categoria", "", "", "", "", "", "", "", ""]);
    ws.mergeCells(emptyRow.number, 1, emptyRow.number, RES_N);
    emptyRow.getCell(1).font = { italic: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    emptyRow.getCell(1).alignment = { horizontal: "center" };
    emptyRow.height = 18;
  }

  ws.addRow([]);
}

function sortAtivosPorPLDesc(ativos: AtivoRelatorio[]): AtivoRelatorio[] {
  return [...ativos].sort((a, b) => {
    if (a.vlMercado != null && b.vlMercado != null) return b.vlMercado - a.vlMercado;
    return (b.percPL ?? 0) - (a.percPL ?? 0);
  });
}

function writeRentabilidadeSecaoTitle(ws: ExcelJS.Worksheet, titulo: string, fundos: FundoRelatorio[]) {
  const plSecao = fundos.reduce((s, f) => s + (f.pl ?? 0), 0);
  const secTitle = ws.addRow([
    `${titulo}   ·   ${fundos.length} fundo${fundos.length !== 1 ? "s" : ""}   ·   PL: ${fmtBRLText(plSecao)}`,
  ]);
  ws.mergeCells(secTitle.number, 1, secTitle.number, N);
  applyFill(secTitle.getCell(1), "FF3A6B57");
  secTitle.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10, name: "Calibri" };
  secTitle.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  secTitle.height = 22;
  return plSecao;
}

function writeRentabilidadeFundoBlock(ws: ExcelJS.Worksheet, fundo: FundoRelatorio) {
  const fundoRow = ws.addRow([
    fundo.nome_fundo || "—",
    fundo.pl ?? null,
    fmtCota(fundo.valor_cota),
    abreviarAdministrador(fundo.administrador),
    fmtPct(fundo.ret_dia_pct, 4),
    fmtVsCDI(fundo.cdi_plus_aa_dia_pct, fundo.pct_cdi_dia),
    fmtPct(fundo.ret_mes_pct, 4),
    fmtVsCDI(fundo.cdi_plus_aa_mes_pct, fundo.pct_cdi_mes),
    fmtPct(fundo.ret_ano_pct, 4),
    fmtVsCDI(fundo.cdi_plus_aa_ano_pct, fundo.pct_cdi_ano),
    fmtRetComPctCdi(fundo.ret_12m_pct, fundo.pct_cdi_12m, 2),
  ]);

  for (let c = 1; c <= N; c++) {
    applyFill(fundoRow.getCell(c), C.GRAY_HEAD);
    fundoRow.getCell(c).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9, name: "Calibri" };
    fundoRow.getCell(c).border = borders;
  }
  fundoRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  const rDia = fundo.ret_dia_pct;
  if (rDia != null && Math.abs(rDia) > 0.001) {
    const cor = pctColor(rDia);
    applyFill(fundoRow.getCell(5), cor.bg);
    fundoRow.getCell(5).font = { bold: true, color: { argb: cor.fg }, size: 9, name: "Calibri" };
  }
  for (let c = 2; c <= N; c++) {
    fundoRow.getCell(c).alignment = { horizontal: "right", vertical: "middle" };
  }
  writeBRLCell(fundoRow, 2, fundo.pl);
  fundoRow.getCell(2).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9, name: "Calibri" };
  [6, 8, 9, 10, 11].forEach((c) => {
    fundoRow.getCell(c).alignment = { horizontal: "right", vertical: "middle", wrapText: true };
  });
  fundoRow.height = 28;

  if (fundo.ativos.length > 0) {
    const ativoHdrRow = ws.addRow([
      "   Ativo", "Vl. Mercado", "PU", "% PL",
      "Var. Dia", "vs CDI Dia", "Var. Mês", "vs CDI Mês", "Var. Ano", "vs CDI Ano", "Var. 12M",
    ]);
    for (let c = 1; c <= N; c++) {
      applyFill(ativoHdrRow.getCell(c), "FF3A6B57");
      ativoHdrRow.getCell(c).font = { bold: true, color: { argb: C.GREEN_LIGHT }, size: 8, name: "Calibri" };
      ativoHdrRow.getCell(c).border = borders;
      ativoHdrRow.getCell(c).alignment = {
        horizontal: c === 1 ? "left" : "right",
        vertical: "middle",
      };
    }
    ativoHdrRow.height = 16;

    let altIdx = 0;
    for (const ativo of sortAtivosPorPLDesc(fundo.ativos)) {
      const isAlt = altIdx % 2 !== 0;
      const aRow = ws.addRow([
        `      ${ativo.nome || "—"}`,
        ativo.vlMercado ?? null,
        fmtCota(ativo.pu),
        fmtPctSemSinal(ativo.percPL, 1),
        fmtPct(ativo.varDia, 4),
        fmtVsCDI(ativo.cdiPlusAaDia, ativo.vsCdiDia),
        fmtPct(ativo.varMes, 4),
        fmtVsCDI(ativo.cdiPlusAaMes, ativo.vsCdiMes),
        fmtPct(ativo.varAno, 4),
        fmtVsCDI(ativo.cdiPlusAaAno, ativo.vsCdiAno),
        fmtRetComPctCdi(ativo.var12M, ativo.vsCdi12M, 2),
      ]);

      const bg = isAlt ? C.GRAY_ALT : C.WHITE;
      for (let c = 1; c <= N; c++) {
        applyFill(aRow.getCell(c), bg);
        aRow.getCell(c).font = { size: 8, name: "Calibri", color: { argb: C.INK_LIGHT } };
        aRow.getCell(c).border = { top: thin, left: thin, bottom: thin, right: thin };
        aRow.getCell(c).alignment = { horizontal: c === 1 ? "left" : "right" };
      }
      aRow.getCell(1).font = { size: 8, name: "Calibri", color: { argb: C.INK }, italic: true };

      const colorCols: Array<[number, number | null]> = [
        [5, ativo.varDia],
        [7, ativo.varMes],
        [9, ativo.varAno],
        [11, ativo.var12M],
      ];
      for (const [col, val] of colorCols) {
        if (val != null && Math.abs(val) > 0.001) {
          const cor = pctColor(val);
          aRow.getCell(col).font = { size: 8, name: "Calibri", color: { argb: cor.fg } };
        }
      }
      const vsCDICols: Array<[number, number | null]> = [
        [6, ativo.cdiPlusAaDia],
        [8, ativo.cdiPlusAaMes],
        [10, ativo.cdiPlusAaAno],
      ];
      for (const [col, val] of vsCDICols) {
        const cell = aRow.getCell(col);
        cell.alignment = { horizontal: "right", vertical: "middle", wrapText: true };
        if (val != null && Math.abs(val) > 0.001) {
          const cor = pctColor(val);
          cell.font = { size: 8, name: "Calibri", color: { argb: cor.fg } };
        }
      }
      aRow.getCell(11).alignment = { horizontal: "right", vertical: "middle", wrapText: true };
      writePctCellSemSinal(aRow, 4, ativo.percPL, 1);
      writeBRLCell(aRow, 2, ativo.vlMercado);
      aRow.height = 28;
      altIdx++;
    }
  }

  const sepRow = ws.addRow([]);
  for (let c = 1; c <= N; c++) {
    applyFill(sepRow.getCell(c), C.WHITE);
    sepRow.getCell(c).border = { bottom: { style: "thin", color: { argb: "FFEEEEEE" } } };
  }
  sepRow.height = 4;
}

function writeRentabilidadeSubtotalRow(ws: ExcelJS.Worksheet, label: string, plTotal: number) {
  const row = ws.addRow([label, plTotal, "", "", "", "", "", "", "", "", ""]);
  for (let c = 1; c <= N; c++) {
    applyFill(row.getCell(c), C.GRAY_HEAD);
    row.getCell(c).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9, name: "Calibri" };
    row.getCell(c).border = borders;
  }
  row.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  writeBRLCell(row, 2, plTotal);
  row.getCell(2).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9, name: "Calibri" };
  row.height = 20;
}

function writeRentabilidadeSecao(
  ws: ExcelJS.Worksheet,
  titulo: string,
  fundos: FundoRelatorio[],
) {
  const plSecao = writeRentabilidadeSecaoTitle(ws, titulo, fundos);

  const hdrRow = ws.addRow(COLS.map((c) => c.header));
  styleHeader(ws, hdrRow.number);

  if (fundos.length === 0) {
    const emptyRow = ws.addRow(["Nenhum fundo nesta categoria", "", "", "", "", "", "", "", "", "", ""]);
    ws.mergeCells(emptyRow.number, 1, emptyRow.number, N);
    emptyRow.getCell(1).font = { italic: true, size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
    emptyRow.getCell(1).alignment = { horizontal: "center" };
    emptyRow.height = 18;
  } else {
    for (const fundo of fundos) {
      writeRentabilidadeFundoBlock(ws, fundo);
    }
    writeRentabilidadeSubtotalRow(ws, `Subtotal — ${titulo}`, plSecao);
  }

  ws.addRow([]);
}

export function rentabilidadeExcelFilename(dataReferencia: string): string {
  const dateTag = dataReferencia.replace(/-/g, "");
  return `Rentabilidade_${dateTag}.xlsx`;
}

export function downloadExcelBuffer(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export async function buildRentabilidadeRelatorioExcelBuffer(
  fundos: FundoRelatorio[],
  dataReferencia: string,
  fundosResumo?: FundoRelatorio[],
): Promise<{ buffer: ArrayBuffer; filename: string }> {
  const fundosOrdenados = sortFundosPorPLDesc(fundos);
  const resumoOrdenados = sortFundosPorPLDesc(fundosResumo ?? fundosOrdenados);

  const wb = new ExcelJS.Workbook();
  wb.creator  = "CVPAR Quadrante";
  wb.created  = new Date();
  wb.modified = new Date();

  // ── Formata data ISO → DD/MM/YYYY ──────────────────────────────────────────
  const dataFmt = dataReferencia.includes("-")
    ? dataReferencia.split("-").reverse().join("/")
    : dataReferencia;

  // ────────────────────────────────────────────────────────────────────────────
  // Aba principal — Rentabilidade
  // ────────────────────────────────────────────────────────────────────────────
  const ws = wb.addWorksheet("Rentabilidade", {
    properties: { tabColor: { argb: C.GREEN_DARK.replace("FF", "") } },
  });
  ws.columns = COLS.map((c) => ({ width: c.width }));

  // Título
  const titleRow = ws.addRow(["RELATÓRIO DE RENTABILIDADE — CVPAR QUADRANTE"]);
  ws.mergeCells(titleRow.number, 1, titleRow.number, N);
  applyFill(titleRow.getCell(1), C.GREEN_DARK);
  titleRow.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 12, name: "Calibri" };
  titleRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  titleRow.height = 28;

  // Meta
  const plTotal = fundosOrdenados.reduce((s, f) => s + (f.pl ?? 0), 0);
  const fundosExclusivosDet = sortFundosPorPLDesc(
    fundosOrdenados.filter((f) => isFundoExclusivoRentabilidade(f.nome_fundo)),
  );
  const fundosCondominiaisDet = sortFundosPorPLDesc(
    fundosOrdenados.filter((f) => !isFundoExclusivoRentabilidade(f.nome_fundo)),
  );

  const cdiDia = fundosOrdenados[0]?.cdi_dia_pct ?? null;
  const cdiMeta = cdiDia != null ? `   ·   CDI Dia: ${fmtPct(cdiDia, 4)}` : "";

  const metaRow = ws.addRow([
    `Data de referência: ${dataFmt}   ·   ${fundosOrdenados.length} fundos   ·   PL Total: ${fmtBRLText(plTotal)}${cdiMeta}`,
  ]);
  ws.mergeCells(metaRow.number, 1, metaRow.number, N);
  applyFill(metaRow.getCell(1), "FFF0F4F2");
  metaRow.getCell(1).font = { size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
  metaRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  metaRow.height = 18;

  ws.addRow([]);

  writeRentabilidadeSecao(ws, "FUNDOS CONDOMINIAIS", fundosCondominiaisDet);
  writeRentabilidadeSecao(ws, "FUNDOS EXCLUSIVOS", fundosExclusivosDet);

  const totalRow = ws.addRow([`TOTAL GERAL — ${fundosOrdenados.length} fundos`, plTotal, "", "", "", "", "", "", "", "", ""]);
  for (let c = 1; c <= N; c++) {
    applyFill(totalRow.getCell(c), C.GREEN_DARK);
    totalRow.getCell(c).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9, name: "Calibri" };
    totalRow.getCell(c).border = borders;
  }
  totalRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  writeBRLCell(totalRow, 2, plTotal);
  totalRow.getCell(2).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9, name: "Calibri" };
  totalRow.height = 20;

  // Rodapé
  ws.addRow([]);
  const footRow = ws.addRow([
    `Gerado automaticamente · Frame Control Center · ${new Date().toLocaleString("pt-BR")}`,
  ]);
  ws.mergeCells(footRow.number, 1, footRow.number, N);
  footRow.getCell(1).font = { size: 8, italic: true, color: { argb: C.INK_LIGHT }, name: "Calibri" };
  footRow.getCell(1).alignment = { horizontal: "left" };

  // Congelar cabeçalho
  ws.views = [{ state: "frozen", ySplit: 4 }];

  // ────────────────────────────────────────────────────────────────────────────
  // Aba "Resumo" — condominiais e exclusivos (última data disponível, PL desc)
  // ────────────────────────────────────────────────────────────────────────────
  const wsRes = wb.addWorksheet("Resumo Fundos");
  wsRes.columns = RES_COLS.map((c) => ({ width: c.width }));

  const fundosExclusivos = sortFundosPorPLDesc(
    resumoOrdenados.filter((f) => isFundoExclusivoRentabilidade(f.nome_fundo)),
  );
  const fundosCondominiais = sortFundosPorPLDesc(
    resumoOrdenados.filter((f) => !isFundoExclusivoRentabilidade(f.nome_fundo)),
  );
  const resPlTotal = resumoOrdenados.reduce((s, f) => s + (f.pl ?? 0), 0);

  const resTitleRow = wsRes.addRow(["RENTABILIDADE — RESUMO POR FUNDO — CVPAR QUADRANTE"]);
  wsRes.mergeCells(resTitleRow.number, 1, resTitleRow.number, RES_N);
  applyFill(resTitleRow.getCell(1), C.GREEN_DARK);
  resTitleRow.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 12, name: "Calibri" };
  resTitleRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  resTitleRow.height = 28;

  const resCdiDia = resumoOrdenados[0]?.cdi_dia_pct ?? cdiDia;
  const resCdiMeta = resCdiDia != null ? `   ·   CDI Dia: ${fmtPct(resCdiDia, 4)}` : "";

  const resMetaRow = wsRes.addRow([
    `Referência: ${dataFmt}   ·   ${resumoOrdenados.length} fundo${resumoOrdenados.length !== 1 ? "s" : ""} na data de referência   ·   PL Total: ${fmtBRLText(resPlTotal)}${resCdiMeta}`,
  ]);
  wsRes.mergeCells(resMetaRow.number, 1, resMetaRow.number, RES_N);
  applyFill(resMetaRow.getCell(1), "FFF0F4F2");
  resMetaRow.getCell(1).font = { size: 9, name: "Calibri", color: { argb: C.INK_LIGHT } };
  resMetaRow.getCell(1).alignment = { horizontal: "left" };
  resMetaRow.height = 18;

  wsRes.addRow([]);

  writeResumoSecao(wsRes, "FUNDOS CONDOMINIAIS", fundosCondominiais, dataFmt);
  writeResumoSecao(wsRes, "FUNDOS EXCLUSIVOS", fundosExclusivos, dataFmt);

  const resTotRow = wsRes.addRow(["", "", "TOTAL GERAL", "", resPlTotal, "", "", "", ""]);
  for (let c = 1; c <= RES_N; c++) {
    applyFill(resTotRow.getCell(c), C.GREEN_DARK);
    resTotRow.getCell(c).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9, name: "Calibri" };
    resTotRow.getCell(c).border = borders;
  }
  writeBRLCell(resTotRow, 5, resPlTotal);
  resTotRow.getCell(5).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9, name: "Calibri" };
  resTotRow.height = 22;

  wsRes.views = [{ state: "frozen", ySplit: 4 }];

  const buffer = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  return { buffer, filename: rentabilidadeExcelFilename(dataReferencia) };
}

export async function generateRentabilidadeRelatorioExcel(
  fundos: FundoRelatorio[],
  dataReferencia: string,
  fundosResumo?: FundoRelatorio[],
): Promise<void> {
  const { buffer, filename } = await buildRentabilidadeRelatorioExcelBuffer(
    fundos,
    dataReferencia,
    fundosResumo,
  );
  downloadExcelBuffer(buffer, filename);
}
