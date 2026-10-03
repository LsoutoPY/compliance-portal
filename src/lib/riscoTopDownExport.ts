/**
 * Exportacao PDF top-down de Risco de Mercado (serie de cota / betas_por_cnpj).
 * Dados ja carregados via buscar-risco-mercado-v2 — abas Fundos e Carteiras.
 */
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  fetchUniversoCnpjsMonitorados,
  filtrarFundosUniversoMonitorado,
} from "@/lib/fundosMonitorados";
import type {
  CarteiraRiscoExtendida,
  FundoRiscoExtendido,
  RiscoV2Response,
  StatusRisco,
} from "@/types/risco-mercado";

type RGB = [number, number, number];

const PDF_C = {
  headerBg:    [28,  35,  51]  as RGB,
  accentGreen: [0,   61,  39]  as RGB,
  bg:          [249, 250, 251] as RGB,
  text:        [39,  42,  48]  as RGB,
  muted:       [107, 114, 128] as RGB,
  border:      [229, 231, 235] as RGB,
  errorBg:     [254, 226, 226] as RGB,
  errorText:   [153, 27,  27]  as RGB,
  warningBg:   [254, 243, 199] as RGB,
  warningText: [146, 64,  14]  as RGB,
  okBg:        [220, 252, 231] as RGB,
  okText:      [22,  101, 52]  as RGB,
  yellowText:  [161, 98,  7]   as RGB,  // text-yellow-700 (VaR negativo leve)
  white:       [255, 255, 255] as RGB,
} as const;

/** Mesmas faixas de `colorVar` / `colorDD` em RiscoMercado.tsx */
function applyVarPctStyle(
  v: number | null | undefined,
  styles: Record<string, unknown>,
): void {
  if (v == null || v >= 0) {
    styles.textColor = PDF_C.muted;
    return;
  }
  if (v < -5) {
    styles.fillColor = PDF_C.errorBg;
    styles.textColor = PDF_C.errorText;
    styles.fontStyle = "bold";
  } else if (v < -2) {
    styles.fillColor = PDF_C.warningBg;
    styles.textColor = PDF_C.warningText;
    styles.fontStyle = "bold";
  } else if (v < 0) {
    styles.textColor = PDF_C.yellowText;
  } else {
    styles.textColor = PDF_C.muted;
  }
}

function applyDdPctStyle(
  v: number | null | undefined,
  styles: Record<string, unknown>,
): void {
  if (v == null) {
    styles.textColor = PDF_C.muted;
    return;
  }
  if (v > 10) {
    styles.fillColor = PDF_C.errorBg;
    styles.textColor = PDF_C.errorText;
    styles.fontStyle = "bold";
  } else if (v > 5) {
    styles.fillColor = PDF_C.warningBg;
    styles.textColor = PDF_C.warningText;
    styles.fontStyle = "bold";
  } else if (v > 2) {
    styles.textColor = PDF_C.yellowText;
  } else {
    styles.textColor = PDF_C.muted;
  }
}

const MARGIN = 12;

function sanitizePdfText(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/−|—|–/g, "-")
    .replace(/×/g, "x")
    .replace(/÷/g, "/")
    .replace(/√/g, "sqrt");
}

function fmtDataIso(iso: string): string {
  try {
    return format(parseISO(`${iso}T12:00:00`), "dd/MM/yyyy", { locale: ptBR });
  } catch {
    return iso;
  }
}

function fmtPctPts(v: number | null | undefined, digits = 2): string {
  if (v == null) return "-";
  return `${v >= 0 ? "" : ""}${v.toFixed(digits)}%`;
}

/** VaR / Pior 21d: perda com sinal negativo; zero ou positivo → traço. */
function fmtVarPctPts(v: number | null | undefined, digits = 2): string {
  if (v == null || v >= 0) return "-";
  return `${v.toFixed(digits)}%`;
}

/** DD gravado como magnitude positiva; exibição com sinal negativo. */
function fmtDdPctPts(v: number | null | undefined, digits = 2): string {
  if (v == null || v <= 0) return "-";
  return `-${Math.abs(v).toFixed(digits)}%`;
}

function fmtCnpj(cnpj: string): string {
  const d = cnpj.replace(/\D/g, "");
  if (d.length !== 14) return cnpj;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

function fmtStatus(status: StatusRisco): string {
  switch (status) {
    case "breach": return "BREACH";
    case "alerta": return "ALERTA";
    case "ok": return "OK";
    default: return "SEM DADOS";
  }
}

function pdfLastY(pdf: jsPDF): number {
  return (pdf as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
}

function renderReportHeader(
  pdf: jsPDF,
  title: string,
  subtitle: string,
  startY: number,
): number {
  autoTable(pdf, {
    startY,
    head: [[sanitizePdfText(title)]],
    body: [[sanitizePdfText(subtitle)]],
    theme: "plain",
    margin: { left: MARGIN, right: MARGIN },
    styles: { cellPadding: 2, font: "helvetica" },
    headStyles: {
      fillColor: PDF_C.headerBg,
      textColor: PDF_C.white,
      fontStyle: "bold",
      fontSize: 11,
      halign: "center",
    },
    bodyStyles: {
      fillColor: PDF_C.accentGreen,
      textColor: PDF_C.white,
      fontSize: 8,
      halign: "center",
    },
  });
  return pdfLastY(pdf) + 3;
}

function renderFootnote(pdf: jsPDF, text: string, startY: number): void {
  const pageW = pdf.internal.pageSize.getWidth();
  autoTable(pdf, {
    startY,
    body: [[sanitizePdfText(text)]],
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
}

function buildFundosRows(fundos: FundoRiscoExtendido[]): string[][] {
  return fundos.map((f) => [
    f.nome_fundo ?? f.cnpj,
    fmtCnpj(f.cnpj),
    fmtVarPctPts(f.var_95_21d_pct),
    fmtVarPctPts(f.var_95_param_pct),
    fmtVarPctPts(f.var_95_mc_t_pct),
    fmtDdPctPts(f.drawdown_atual_pct),
    fmtDdPctPts(f.drawdown_max_252d_pct),
    fmtVarPctPts(f.pior_21d_pct),
    f.n_obs_21d != null ? String(f.n_obs_21d) : "-",
    f.fonte_cota ?? "-",
  ].map(sanitizePdfText));
}

function buildCarteirasRows(carteiras: CarteiraRiscoExtendida[]): string[][] {
  return carteiras.map((c) => [
    c.cliente,
    c.grupo ?? "-",
    fmtVarPctPts(c.var_mes_95_pct),
    fmtVarPctPts(c.var_95_hist_pct),
    fmtVarPctPts(c.var_95_param_pct),
    fmtVarPctPts(c.var_95_mc_t_pct),
    fmtVarPctPts(c.var_95_diversif_pct),
    c.pct_uso_limite != null ? `${c.pct_uso_limite.toFixed(1)}%` : "-",
    fmtStatus(c.status),
  ].map(sanitizePdfText));
}

function renderFundosTable(
  pdf: jsPDF,
  fundos: FundoRiscoExtendido[],
  startY: number,
): number {
  const headerCols = [
    "Fundo",
    "CNPJ",
    "VaR Hist\n95% (21d)",
    "VaR Param\n95%",
    "VaR MC(t)\n95%",
    "DD\nAtual",
    "DD Max\n252d",
    "Pior\n21d",
    "n obs",
    "Fonte",
  ].map(sanitizePdfText);

  const bodyRows = buildFundosRows(fundos);

  autoTable(pdf, {
    startY,
    head: [headerCols],
    body: bodyRows,
    margin: { left: MARGIN, right: MARGIN, bottom: 14 },
    theme: "grid",
    styles: {
      fontSize: 7,
      cellPadding: { top: 1.5, right: 1.5, bottom: 1.5, left: 1.5 },
      lineColor: PDF_C.border,
      lineWidth: 0.2,
      textColor: PDF_C.text,
      valign: "middle",
    },
    headStyles: {
      fillColor: PDF_C.headerBg,
      textColor: PDF_C.white,
      fontStyle: "bold",
      fontSize: 6.5,
      halign: "center",
    },
    alternateRowStyles: { fillColor: PDF_C.bg },
    columnStyles: {
      0: { cellWidth: 42, fontStyle: "bold", halign: "left" },
      1: { cellWidth: 28, halign: "left", fontSize: 6 },
      9: { cellWidth: 20, fontSize: 6 },
    },
    didParseCell: (hook) => {
      if (hook.section !== "body") return;
      const rowIdx = hook.row.index;
      const colIdx = hook.column.index;
      const fundo = fundos[rowIdx];
      if (!fundo) return;

      const varColMap: Record<number, number | null | undefined> = {
        2: fundo.var_95_21d_pct,
        3: fundo.var_95_param_pct,
        4: fundo.var_95_mc_t_pct,
        7: fundo.pior_21d_pct,
      };
      if (colIdx in varColMap) {
        applyVarPctStyle(varColMap[colIdx], hook.cell.styles as unknown as Record<string, unknown>);
      }
      if (colIdx === 5) applyDdPctStyle(fundo.drawdown_atual_pct, hook.cell.styles as unknown as Record<string, unknown>);
      if (colIdx === 6) applyDdPctStyle(fundo.drawdown_max_252d_pct, hook.cell.styles as unknown as Record<string, unknown>);

      if (colIdx >= 2 && colIdx <= 8) {
        hook.cell.styles.halign = "right";
      }
    },
  });

  return pdfLastY(pdf) + 3;
}

function renderCarteirasTable(
  pdf: jsPDF,
  carteiras: CarteiraRiscoExtendida[],
  startY: number,
): number {
  const headerCols = [
    "Carteira",
    "Grupo",
    "VaR EWMA\n95%",
    "VaR Hist\n95%",
    "VaR Param\n95%",
    "VaR MC(t)\n95%",
    "VaR Diversif\n95%",
    "Uso\nLimite",
    "Status",
  ].map(sanitizePdfText);

  const bodyRows = buildCarteirasRows(carteiras);

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
      fillColor: PDF_C.headerBg,
      textColor: PDF_C.white,
      fontStyle: "bold",
      fontSize: 7,
      halign: "center",
    },
    alternateRowStyles: { fillColor: PDF_C.bg },
    columnStyles: {
      0: { cellWidth: 42, fontStyle: "bold", halign: "left" },
    },
    didParseCell: (hook) => {
      if (hook.section !== "body") return;
      const rowIdx = hook.row.index;
      const colIdx = hook.column.index;
      const cart = carteiras[rowIdx];
      if (!cart) return;

      if (colIdx === 8) {
        if (cart.status === "breach") {
          hook.cell.styles.fillColor = PDF_C.errorBg;
          hook.cell.styles.textColor = PDF_C.errorText;
          hook.cell.styles.fontStyle = "bold";
        } else if (cart.status === "alerta") {
          hook.cell.styles.fillColor = PDF_C.warningBg;
          hook.cell.styles.textColor = PDF_C.warningText;
        } else if (cart.status === "ok") {
          hook.cell.styles.fillColor = PDF_C.okBg;
          hook.cell.styles.textColor = PDF_C.okText;
        }
      }

      const varColMap: Record<number, number | null | undefined> = {
        2: cart.var_mes_95_pct,
        3: cart.var_95_hist_pct,
        4: cart.var_95_param_pct,
        5: cart.var_95_mc_t_pct,
        6: cart.var_95_diversif_pct,
      };
      if (colIdx in varColMap) {
        applyVarPctStyle(varColMap[colIdx], hook.cell.styles as unknown as Record<string, unknown>);
      }

      if (colIdx >= 2 && colIdx <= 7) {
        hook.cell.styles.halign = "right";
      }
    },
  });

  return pdfLastY(pdf) + 3;
}

/**
 * Gera PDF top-down de FUNDOS (betas_por_cnpj / serie de cota).
 * Apenas gestores cadastrados em `gestores_monitorados` quando a allowlist estiver ativa.
 */
export async function exportRiscoTopDownFundosPdf(
  resp: RiscoV2Response,
  dataPosicao?: string | null,
): Promise<number> {
  const dataRef =
    dataPosicao ??
    resp.summary?.data_posicao_risco ??
    format(new Date(), "yyyy-MM-dd");
  const gerado = format(new Date(), "dd/MM/yyyy HH:mm", { locale: ptBR });

  const universo = await fetchUniversoCnpjsMonitorados();
  const fundosTodos = resp.fundos ?? [];
  const fundos = filtrarFundosUniversoMonitorado(fundosTodos, universo);

  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  let y = renderReportHeader(
    pdf,
    `Risco de Mercado — Fundos (Top-Down) - Data: ${fmtDataIso(dataRef)}`,
    `Gerado em ${gerado}  |  ${fundos.length} fundos  |  Quadrante Investimentos`,
    MARGIN,
  );

  autoTable(pdf, {
    startY: y,
    body: [[sanitizePdfText("FUNDOS — VaR por serie de cota (betas_por_cnpj)")]],
    theme: "plain",
    margin: { left: MARGIN, right: MARGIN },
    styles: {
      fontSize: 9,
      fontStyle: "bold",
      fillColor: PDF_C.bg,
      textColor: PDF_C.text,
      cellPadding: 2,
    },
  });
  y = pdfLastY(pdf) + 2;
  y = renderFundosTable(pdf, fundos, y);

  renderFootnote(
    pdf,
    "Metodologia top-down: VaR calculado na serie historica de cotas de cada fundo (CNPJ). " +
    "Horizonte 21 dias uteis, IC 95%. Nao agrega risco dos subjacentes (look-through). " +
    "Destaque VaR: vermelho <-5%, amarelo -2% a -5%, texto amarelo 0% a -2%. " +
    "Destaque DD: vermelho >10%, amarelo >5%, texto amarelo >2% (magnitude no banco).",
    y,
  );

  pdf.save(`Risco_TopDown_Fundos_${dataRef}.pdf`);
  return fundos.length;
}

/**
 * Gera PDF top-down de CARTEIRAS (posicao_diaria x betas_por_cnpj).
 */
export async function exportRiscoTopDownCarteirasPdf(
  resp: RiscoV2Response,
  dataPosicao?: string | null,
): Promise<number> {
  const dataRef =
    dataPosicao ??
    resp.summary?.data_posicao_risco ??
    format(new Date(), "yyyy-MM-dd");
  const gerado = format(new Date(), "dd/MM/yyyy HH:mm", { locale: ptBR });
  const carteiras = resp.carteiras ?? [];

  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  let y = renderReportHeader(
    pdf,
    `Risco de Mercado — Carteiras (Top-Down) - Data: ${fmtDataIso(dataRef)}`,
    `Gerado em ${gerado}  |  ${carteiras.length} carteiras  |  Quadrante Investimentos`,
    MARGIN,
  );

  autoTable(pdf, {
    startY: y,
    body: [[sanitizePdfText("CARTEIRAS — VaR aditivo e diversificado (posicao_diaria x betas_por_cnpj)")]],
    theme: "plain",
    margin: { left: MARGIN, right: MARGIN },
    styles: {
      fontSize: 9,
      fontStyle: "bold",
      fillColor: PDF_C.bg,
      textColor: PDF_C.text,
      cellPadding: 2,
    },
  });
  y = pdfLastY(pdf) + 2;
  y = renderCarteirasTable(pdf, carteiras, y);

  renderFootnote(
    pdf,
    "VaR aditivo: soma ponderada sem correlacao. VaR diversificado: MC multivariado t-Student quando disponivel. " +
    "Status vs limites configurados em var_limites. " +
    "Destaque VaR: vermelho <-5%, amarelo -2% a -5%, texto amarelo 0% a -2%.",
    y,
  );

  pdf.save(`Risco_TopDown_Carteiras_${dataRef}.pdf`);
  return carteiras.length;
}
