import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import {
  AlignmentType,
  Document,
  Header,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { RiscoOcorrenciaMensal, RiscoRelatorioMensal } from "@/types/relatorios-risco";
import { RISCO_MODULO_LABEL, RISCO_WORKFLOW_LABEL } from "@/types/relatorios-risco";

type PdfWithTable = jsPDF & { lastAutoTable?: { finalY: number } };

const formatDate = (iso: string | null) => (iso ? format(parseISO(iso), "dd/MM/yyyy") : "—");
const formatCnpj = (value: string) =>
  value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

function competenciaLabel(mes: string) {
  return format(parseISO(`${mes}-01`), "MMMM 'de' yyyy", { locale: ptBR });
}

function wordParagraph(text: string, options?: { bold?: boolean; color?: string; size?: number }) {
  return new Paragraph({
    spacing: { after: 100 },
    children: [new TextRun({ font: "Arial", text: text.replace(/\r?\n/g, " "), bold: options?.bold, color: options?.color, size: options?.size ?? 18 })],
  });
}

function wordCell(text: string, width: number, header = false, headerFill = "374151") {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: header ? { type: ShadingType.CLEAR, fill: headerFill } : undefined,
    margins: { top: 80, bottom: 80, left: 90, right: 90 },
    children: text.split("\n").map((line) => new Paragraph({
      spacing: { after: 0 },
      children: [new TextRun({ font: "Arial", text: line, bold: header, color: header ? "FFFFFF" : "1F2937", size: header ? 16 : 14 })],
    })),
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function exportRelatorioMensalRiscoExcel(
  mes: string,
  ocorrencias: RiscoOcorrenciaMensal[],
  relatorio?: RiscoRelatorioMensal | null,
) {
  const comPlano = ocorrencias.filter((o) => o.nivel === "violacao" && !!o.plano_conteudo).length;
  const resumo = [
    { Indicador: "Competência", Valor: competenciaLabel(mes) },
    { Indicador: "Status do relatório", Valor: relatorio?.status ?? "rascunho" },
    { Indicador: "Fundos com ocorrência", Valor: new Set(ocorrencias.map((o) => o.fundo_cnpj)).size },
    { Indicador: "Ocorrências", Valor: ocorrencias.length },
    { Indicador: "Violações", Valor: ocorrencias.filter((o) => o.nivel === "violacao").length },
    { Indicador: "Atenções", Valor: ocorrencias.filter((o) => o.nivel === "atencao").length },
    { Indicador: "Planos recebidos", Valor: comPlano },
    { Indicador: "Planos pendentes", Valor: ocorrencias.filter((o) => o.nivel === "violacao" && !o.plano_conteudo).length },
    { Indicador: "Manifestação do Diretor", Valor: relatorio?.manifestacao_diretor ?? "" },
    { Indicador: "Ressalvas", Valor: relatorio?.ressalvas ?? "" },
  ];

  const detalhes = ocorrencias.map((o) => ({
    Competência: competenciaLabel(mes),
    Fundo: o.fundo_nome,
    CNPJ: formatCnpj(o.fundo_cnpj),
    ISIN: o.fundo_isin || "",
    Módulo: RISCO_MODULO_LABEL[o.modulo],
    Nível: o.nivel === "violacao" ? "Violação" : "Atenção",
    Evento: o.titulo,
    Descrição: o.descricao ?? "",
    "Primeira ocorrência": formatDate(o.data_primeira),
    "Última ocorrência": formatDate(o.data_ultima),
    "Dias no mês": o.dias_ocorrencia,
    Notificação: o.nivel !== "violacao" ? "Não aplicável" : o.notificacao_status === "enviada" ? "Enviada" : "Pendente",
    "Data da notificação": formatDate(o.notificacao_enviada_em),
    "Plano de ação": o.plano_conteudo ?? (o.nivel === "violacao" ? "Pendente de recebimento" : "Não aplicável"),
    Responsável: o.plano_responsavel_nome ?? "",
    "E-mail do responsável": o.plano_responsavel_email ?? "",
    Prazo: formatDate(o.plano_prazo),
    "Status do caso": RISCO_WORKFLOW_LABEL[o.status_workflow],
  }));

  const workbook = XLSX.utils.book_new();
  const resumoSheet = XLSX.utils.json_to_sheet(resumo);
  resumoSheet["!cols"] = [{ wch: 28 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(workbook, resumoSheet, "Resumo");

  const detalhesSheet = XLSX.utils.json_to_sheet(detalhes);
  detalhesSheet["!cols"] = [
    { wch: 20 }, { wch: 40 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 42 },
    { wch: 55 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 14 }, { wch: 20 },
    { wch: 70 }, { wch: 28 }, { wch: 30 }, { wch: 14 }, { wch: 20 },
  ];
  XLSX.utils.book_append_sheet(workbook, detalhesSheet, "Ocorrências e Planos");
  XLSX.writeFile(workbook, `Relatorio_Mensal_Risco_${mes.replace("-", "")}.xlsx`);
}

export async function exportRelatorioMensalRiscoWord(
  mes: string,
  ocorrencias: RiscoOcorrenciaMensal[],
  relatorio?: RiscoRelatorioMensal | null,
) {
  const fundos = new Set(ocorrencias.map((o) => o.fundo_cnpj)).size;
  const violacoes = ocorrencias.filter((o) => o.nivel === "violacao").length;
  const planosRecebidos = ocorrencias.filter((o) => o.nivel === "violacao" && !!o.plano_conteudo).length;
  const planosPendentes = ocorrencias.filter((o) => o.nivel === "violacao" && !o.plano_conteudo).length;

  const summaryWidth = 10400;
  const summaryColumnWidth = 2080;
  const detailWidths = [2100, 2800, 1000, 3500, 1000];
  const detailHeaders = ["Fundo", "Evento / período", "Nível", "Plano de ação", "Status"];
  const modules = ["liquidez", "concentracao", "enquadramento"] as const;
  let sectionNumber = 3;

  const buildDetailTable = (rows: RiscoOcorrenciaMensal[]) => new Table({
    width: { size: summaryWidth, type: WidthType.DXA },
    columnWidths: detailWidths,
    rows: [
      new TableRow({
        tableHeader: true,
        children: detailHeaders.map((label, index) => wordCell(label, detailWidths[index], true)),
      }),
      ...rows.map((o) => new TableRow({
        children: [
          `${o.fundo_nome}\n${formatCnpj(o.fundo_cnpj)}${o.fundo_isin ? `\nISIN ${o.fundo_isin}` : ""}`,
          `${o.titulo}\n${formatDate(o.data_primeira)} a ${formatDate(o.data_ultima)} (${o.dias_ocorrencia} dia(s))`,
          o.nivel === "violacao" ? "Violação" : "Atenção",
          o.plano_conteudo ?? (o.nivel === "violacao" ? "Pendente de recebimento" : "Não aplicável"),
          RISCO_WORKFLOW_LABEL[o.status_workflow],
        ].map((value, index) => wordCell(value, detailWidths[index])),
      })),
    ],
  });

  const children = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ font: "Arial", text: "RELATÓRIO MENSAL DE RISCO", bold: true, color: "183B56", size: 36 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ font: "Arial", text: "Liquidez, Concentração e Enquadramento", bold: true, color: "1F2937", size: 22 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 260 }, children: [new TextRun({ font: "Arial", text: `Mês de referência: ${competenciaLabel(mes)}`, color: "1F2937", size: 20 })] }),
    new Table({
      width: { size: summaryWidth, type: WidthType.DXA },
      columnWidths: [summaryColumnWidth, summaryColumnWidth, summaryColumnWidth, summaryColumnWidth, summaryColumnWidth],
      rows: [
        new TableRow({ children: ["Fundos com ocorrência", "Ocorrências", "Violações", "Planos recebidos", "Pendências"].map((label) => wordCell(label, summaryColumnWidth, true, "197357")) }),
        new TableRow({ children: [String(fundos), String(ocorrencias.length), String(violacoes), String(planosRecebidos), String(planosPendentes)].map((value) => wordCell(value, summaryColumnWidth)) }),
      ],
    }),
    new Paragraph({ spacing: { before: 260, after: 100 }, children: [new TextRun({ font: "Arial", text: "1. Introdução e objetivo", bold: true, color: "1F2937", size: 24 })] }),
    wordParagraph("Este relatório consolida todas as ocorrências de risco identificadas no período, vinculando cada evento às comunicações, ao plano de ação e à situação de tratamento."),
    new Paragraph({ spacing: { before: 160, after: 100 }, children: [new TextRun({ font: "Arial", text: "2. Manifestação do Diretor de Risco", bold: true, color: "1F2937", size: 24 })] }),
    wordParagraph(relatorio?.manifestacao_diretor?.trim() || "Manifestação pendente de preenchimento e aprovação pelo Diretor de Risco."),
    ...(relatorio?.ressalvas?.trim() ? [wordParagraph(`Ressalvas: ${relatorio.ressalvas.trim()}`)] : []),
  ];

  for (const modulo of modules) {
    const rows = ocorrencias.filter((o) => o.modulo === modulo);
    if (!rows.length) continue;
    children.push(
      new Paragraph({ spacing: { before: 160, after: 100 }, children: [new TextRun({ font: "Arial", text: `${sectionNumber}. Risco de ${RISCO_MODULO_LABEL[modulo]}`, bold: true, color: "1F2937", size: 24 })] }),
      buildDetailTable(rows),
    );
    sectionNumber += 1;
  }

  if (!ocorrencias.length) children.push(wordParagraph("Nenhuma exceção foi registrada na competência."));

  children.push(
    new Paragraph({ spacing: { before: 220, after: 80 }, children: [new TextRun({ font: "Arial", text: "Controle e guarda", bold: true, color: "1F2937", size: 20 })] }),
    wordParagraph("O documento, suas evidências e a trilha de auditoria devem ser mantidos conforme a política interna e os prazos regulatórios aplicáveis.", { color: "4B5563", size: 16 }),
  );

  const document = new Document({
    creator: "Frame Control Center",
    title: `Relatório Mensal de Risco — ${competenciaLabel(mes)}`,
    description: "Dossiê mensal de ocorrências de risco para Compliance.",
    styles: { default: { document: { run: { font: "Arial", size: 18 } } } },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 720, right: 720, bottom: 720, left: 720 },
        },
      },
      headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ font: "Arial", text: "CONFIDENCIAL — USO INTERNO", bold: true, color: "6B7280", size: 14 })] })] }) },
      children,
    }],
  });

  const blob = await Packer.toBlob(document);
  downloadBlob(blob, `Relatorio_Mensal_Risco_${mes.replace("-", "")}.docx`);
}

export function exportRelatorioMensalRiscoPdf(
  mes: string,
  ocorrencias: RiscoOcorrenciaMensal[],
  relatorio?: RiscoRelatorioMensal | null,
) {
  const pdf = new jsPDF({ unit: "mm", format: "a4" }) as PdfWithTable;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 16;
  const fundos = new Set(ocorrencias.map((o) => o.fundo_cnpj)).size;
  const comPlano = ocorrencias.filter((o) => o.nivel === "violacao" && !!o.plano_conteudo).length;

  const drawHeader = () => {
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(7);
    pdf.setTextColor(109, 117, 128);
    pdf.text("CONFIDENCIAL — USO INTERNO", margin, 8);
    pdf.text(`Página ${pdf.getNumberOfPages()}`, pageWidth - margin, 8, { align: "right" });
    pdf.setDrawColor(215, 219, 224);
    pdf.line(margin, 10, pageWidth - margin, 10);
  };

  const ensureSpace = (required: number, currentY: number) => {
    if (currentY + required <= 278) return currentY;
    pdf.addPage();
    drawHeader();
    return 18;
  };

  drawHeader();
  pdf.setTextColor(24, 37, 48);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(18);
  pdf.text("RELATÓRIO MENSAL DE RISCO", pageWidth / 2, 34, { align: "center" });
  pdf.setFontSize(11);
  pdf.text("Liquidez, Concentração e Enquadramento", pageWidth / 2, 42, { align: "center" });
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.text(`Mês de referência: ${competenciaLabel(mes)}`, pageWidth / 2, 54, { align: "center" });
  pdf.setFontSize(8);
  pdf.setTextColor(109, 117, 128);
  pdf.text("Documento gerado pelo Frame Control Center — sujeito à revisão e aprovação do Diretor de Risco.", pageWidth / 2, 64, { align: "center" });

  autoTable(pdf, {
    startY: 78,
    head: [["Fundos com ocorrência", "Ocorrências", "Violações", "Planos recebidos", "Pendências"]],
    body: [[
      fundos,
      ocorrencias.length,
      ocorrencias.filter((o) => o.nivel === "violacao").length,
      comPlano,
      ocorrencias.filter((o) => o.nivel === "violacao" && !o.plano_conteudo).length,
    ]],
    theme: "grid",
    headStyles: { fillColor: [25, 115, 87], textColor: 255, fontSize: 8 },
    bodyStyles: { halign: "center", fontSize: 10, fontStyle: "bold" },
    margin: { left: margin, right: margin },
  });

  let y = (pdf.lastAutoTable?.finalY ?? 100) + 12;
  pdf.setTextColor(24, 37, 48);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(12);
  pdf.text("1. Introdução e objetivo", margin, y);
  y += 7;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  const intro =
    "Este relatório consolida todas as ocorrências de risco identificadas no período, independentemente do status observado no último dia útil, vinculando cada evento às comunicações, ao plano de ação e à situação de tratamento.";
  const introLines = pdf.splitTextToSize(intro, pageWidth - margin * 2);
  pdf.text(introLines, margin, y);
  y += introLines.length * 4.2 + 8;

  y = ensureSpace(35, y);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(12);
  pdf.text("2. Manifestação do Diretor de Risco", margin, y);
  y += 7;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  const manifestacao =
    relatorio?.manifestacao_diretor?.trim() ||
    "Manifestação pendente de preenchimento e aprovação pelo Diretor de Risco.";
  const manifestacaoLines = pdf.splitTextToSize(manifestacao, pageWidth - margin * 2);
  pdf.text(manifestacaoLines, margin, y);
  y += manifestacaoLines.length * 4.2 + 5;
  if (relatorio?.ressalvas?.trim()) {
    pdf.setFont("helvetica", "bold");
    pdf.text("Ressalvas:", margin, y);
    y += 5;
    pdf.setFont("helvetica", "normal");
    const ressalvaLines = pdf.splitTextToSize(relatorio.ressalvas, pageWidth - margin * 2);
    pdf.text(ressalvaLines, margin, y);
    y += ressalvaLines.length * 4.2 + 6;
  }

  const modulos = ["liquidez", "concentracao", "enquadramento"] as const;
  let section = 3;
  for (const modulo of modulos) {
    const rows = ocorrencias.filter((o) => o.modulo === modulo);
    if (!rows.length) continue;
    y = ensureSpace(45, y);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(12);
    pdf.text(`${section}. Risco de ${RISCO_MODULO_LABEL[modulo]}`, margin, y);
    y += 5;

    autoTable(pdf, {
      startY: y,
      head: [["Fundo", "Evento / período", "Nível", "Plano de ação", "Status"]],
      body: rows.map((o) => [
        `${o.fundo_nome}\n${formatCnpj(o.fundo_cnpj)}${o.fundo_isin ? `\nISIN ${o.fundo_isin}` : ""}`,
        `${o.titulo}\n${formatDate(o.data_primeira)} a ${formatDate(o.data_ultima)} (${o.dias_ocorrencia} dia(s))`,
        o.nivel === "violacao" ? "Violação" : "Atenção",
        o.plano_conteudo ?? (o.nivel === "violacao" ? "Pendente de recebimento" : "Não aplicável"),
        RISCO_WORKFLOW_LABEL[o.status_workflow],
      ]),
      theme: "grid",
      styles: { fontSize: 7, cellPadding: 2, valign: "top", overflow: "linebreak" },
      headStyles: { fillColor: [55, 65, 81], textColor: 255, fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: 37 },
        1: { cellWidth: 48 },
        2: { cellWidth: 18 },
        3: { cellWidth: 58 },
        4: { cellWidth: 22 },
      },
      margin: { left: margin, right: margin, top: 15, bottom: 14 },
      didDrawPage: drawHeader,
    });
    y = (pdf.lastAutoTable?.finalY ?? y + 30) + 10;
    section += 1;
  }

  y = ensureSpace(26, y);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10);
  pdf.text("Controle e guarda", margin, y);
  y += 5;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  const footer =
    "O documento, suas evidências e a trilha de auditoria devem ser mantidos conforme a política interna e os prazos regulatórios aplicáveis. A aprovação formal permanece sob responsabilidade do Diretor de Risco.";
  pdf.text(pdf.splitTextToSize(footer, pageWidth - margin * 2), margin, y);

  pdf.save(`Relatorio_Mensal_Risco_${mes.replace("-", "")}.pdf`);
}
