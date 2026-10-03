/**
 * Exportação PDF/Excel — aba Exposição × Limite (Cadastro de Partes).
 */

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import ExcelJS from "exceljs";
import {
  type ExposicaoLimitePayload,
  STATUS_LABEL,
  exposicaoExibicao,
  formatExposicao,
} from "@/lib/cadastroPartesExposicao";
import { formatBRL } from "@/lib/cadastroPartes";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d + "T12:00:00").toLocaleDateString("pt-BR");
  } catch {
    return d;
  }
}

export interface ExportExposicaoInput {
  fundo_nome: string;
  fundo_cnpj: string;
  payload: ExposicaoLimitePayload;
  exportadoEm?: Date;
}

export async function exportExposicaoLimitePDF(input: ExportExposicaoInput): Promise<void> {
  const { fundo_nome, fundo_cnpj, payload } = input;
  const now = input.exportadoEm ?? new Date();
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  doc.setFontSize(14);
  doc.text("Cadastro de Partes — Exposição × Limite", 14, 14);
  doc.setFontSize(9);
  doc.text(
    `Fundo: ${fundo_nome}  |  CNPJ: ${fundo_cnpj}  |  Estoque ref.: ${fmtDate(payload.reference_date)}  |  VP: ${payload.vp_liquido ? "líquido" : "bruto"}`,
    14,
    21,
  );
  doc.text(`Exportado: ${now.toLocaleString("pt-BR")}`, 14, 26);

  const body = payload.linhas.map((l) => {
    const exp = exposicaoExibicao(l, payload.vp_liquido);
    return [
      l.parte,
      l.doc,
      formatExposicao(exp),
      l.limite_operacao != null ? formatBRL(l.limite_operacao) : "sem limite",
      l.pct_uso != null ? `${l.pct_uso.toFixed(1)}%` : "—",
      l.dt_validade ? fmtDate(l.dt_validade) : "pendente",
      STATUS_LABEL[l.status],
      l.motivo_motor ?? "—",
    ];
  });

  autoTable(doc, {
    startY: 32,
    head: [["Parte", "CNPJ/Grupo", "Exposição", "Limite comitê", "% uso", "Validade", "Status", "Motivo motor"]],
    body,
    styles: { fontSize: 7, cellPadding: 1.5 },
    headStyles: { fillColor: [0, 61, 39], textColor: 255 },
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const status = payload.linhas[data.row.index]?.status;
      if (status === "BREACH" || status === "NAO_CADASTRADO") {
        data.cell.styles.fillColor = [254, 226, 226];
      } else if (status === "CAD_VENCIDO" || status === "ATENCAO") {
        data.cell.styles.fillColor = [254, 243, 199];
      }
    },
  });

  const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 180;
  doc.setFontSize(8);
  doc.text(
    `Total carteira (${payload.vp_liquido ? "VP líq." : "VP bruto"}): ${formatExposicao(payload.vp_liquido ? payload.total_carteira_liquida : payload.total_carteira_bruta)}`,
    14,
    finalY + 8,
  );

  const ts = now.toISOString().slice(0, 10);
  doc.save(`exposicao-limite-${fundo_cnpj.slice(-6)}-${ts}.pdf`);
}

export async function exportExposicaoLimiteExcel(input: ExportExposicaoInput): Promise<void> {
  const { fundo_nome, fundo_cnpj, payload } = input;
  const now = input.exportadoEm ?? new Date();
  const wb = new ExcelJS.Workbook();
  wb.creator = "Frame Control Center";

  const ws = wb.addWorksheet("Exposição × Limite");
  ws.columns = [
    { width: 36 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 10 },
    { width: 12 }, { width: 14 }, { width: 22 }, { width: 8 },
  ];

  ws.mergeCells("A1:I1");
  ws.getCell("A1").value = "Cadastro de Partes — Exposição × Limite";
  ws.getCell("A1").font = { bold: true, size: 12 };

  ws.mergeCells("A2:I2");
  ws.getCell("A2").value = `${fundo_nome} | CNPJ ${fundo_cnpj} | Estoque ${fmtDate(payload.reference_date)} | VP ${payload.vp_liquido ? "líquido" : "bruto"} | ${now.toLocaleString("pt-BR")}`;

  const header = ["Parte", "CNPJ/Grupo", "Exposição VP", "Limite comitê", "% uso", "Validade", "Status", "Motivo motor", "Títulos"];
  const hRow = ws.addRow(header);
  hRow.font = { bold: true };
  hRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF003D27" } };
  hRow.font = { bold: true, color: { argb: "FFFFFFFF" } };

  for (const l of payload.linhas) {
    const exp = exposicaoExibicao(l, payload.vp_liquido);
    const row = ws.addRow([
      l.parte,
      l.doc,
      exp,
      l.limite_operacao ?? "sem limite",
      l.pct_uso != null ? l.pct_uso / 100 : null,
      l.dt_validade ? fmtDate(l.dt_validade) : "pendente",
      STATUS_LABEL[l.status],
      l.motivo_motor ?? "",
      l.qtd_titulos,
    ]);
    if (l.pct_uso != null) row.getCell(5).numFmt = "0.0%";
    row.getCell(3).numFmt = '"R$" #,##0.00';
    if (typeof l.limite_operacao === "number") row.getCell(4).numFmt = '"R$" #,##0.00';
    if (l.status === "BREACH" || l.status === "NAO_CADASTRADO") {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDEAEA" } };
    } else if (l.status === "CAD_VENCIDO" || l.status === "ATENCAO") {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };
    }
  }

  ws.addRow([]);
  const foot = ws.addRow([
    "Total carteira",
    "",
    payload.vp_liquido ? payload.total_carteira_liquida : payload.total_carteira_bruta,
  ]);
  foot.font = { bold: true };
  foot.getCell(3).numFmt = '"R$" #,##0.00';

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const ts = now.toISOString().slice(0, 10);
  downloadBlob(blob, `exposicao-limite-${fundo_cnpj.slice(-6)}-${ts}.xlsx`);
}

export async function exportAlertasCadastroPDF(input: ExportExposicaoInput): Promise<void> {
  const { fundo_nome, payload } = input;
  const now = input.exportadoEm ?? new Date();
  const doc = new jsPDF();
  doc.setFontSize(14);
  doc.text("Cadastro de Partes — Alertas", 14, 16);
  doc.setFontSize(9);
  doc.text(`${fundo_nome} | ${now.toLocaleString("pt-BR")}`, 14, 23);
  doc.text(`Crítico: ${payload.contadores_alerta.critico}  |  Alerta: ${payload.contadores_alerta.alerta}  |  Info: ${payload.contadores_alerta.info}`, 14, 29);

  let y = 36;
  for (const a of payload.alertas) {
    if (y > 260) { doc.addPage(); y = 16; }
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text(`[${a.severidade.toUpperCase()}] ${a.titulo}`, 14, y);
    y += 5;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    const lines = doc.splitTextToSize(a.descricao + (a.motivo_motor ? ` (${a.motivo_motor})` : ""), 180);
    doc.text(lines, 14, y);
    y += lines.length * 4 + 2;
    for (const it of a.itens.slice(0, 15)) {
      const extra = [
        it.exposicao != null ? formatBRL(it.exposicao) : null,
        it.pct_uso != null ? `${it.pct_uso.toFixed(1)}%` : null,
        it.dias != null ? `${it.dias}d` : null,
      ].filter(Boolean).join(" · ");
      doc.text(`• ${it.nome} (${it.doc})${extra ? ` — ${extra}` : ""}`, 18, y);
      y += 4;
    }
    y += 4;
  }

  doc.save(`alertas-cadastro-${now.toISOString().slice(0, 10)}.pdf`);
}
