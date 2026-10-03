import { jsPDF } from "jspdf";
import autoTable, { type UserOptions } from "jspdf-autotable";
import { pddRatio, type PddReport } from "@/lib/creditoPddReport";
import { formatDateBR } from "@/lib/creditoMatriz";

const money = (value: number) => new Intl.NumberFormat("pt-BR", {
  style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(value).replace(/\u00a0/g, " ");
const percent = (value: number | null) => value === null ? "N/D" :
  new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(value).replace(/\u00a0/g, " ");

/** Retorna o documento também para verificação de conteúdo e paginação. */
export function createPddPdf(report: PddReport): jsPDF {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const margin = 14;
  let y = 28;
  doc.setProperties({ title: "Relatório de Monitoramento de PDD", author: "Frame Control Center" });

  const table = (options: UserOptions) => {
    autoTable(doc, {
      startY: y, margin: { top: 28, bottom: 18, left: margin, right: margin },
      styles: { font: "helvetica", fontSize: 8, cellPadding: 2.2, overflow: "linebreak", textColor: [30, 41, 59] },
      headStyles: { fillColor: [0, 61, 39], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [244, 247, 246] },
      rowPageBreak: "avoid", ...options,
    });
    y = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 5;
  };
  const section = (title: string) => {
    if (y > height - 48) { doc.addPage(); y = 28; }
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(0, 61, 39);
    doc.text(title, margin, y); y += 4;
  };
  const coverage = (rows: { label: string; vp: number; pdd: number }[], vp: number, pdd: number) => {
    table({
      head: [["Faixa de atraso", "VP da faixa", "% da carteira", "PDD da faixa", "% da PDD total", "Cobertura PDD / VP"]],
      body: rows.map((row) => [row.label, money(row.vp), percent(pddRatio(row.vp, vp)), money(row.pdd),
        percent(pddRatio(row.pdd, pdd)), percent(pddRatio(row.pdd, row.vp))]),
      foot: [["TOTAL", money(vp), percent(pddRatio(vp, vp)), money(pdd), percent(pddRatio(pdd, pdd)), percent(pddRatio(pdd, vp))]],
      showFoot: "lastPage",
      footStyles: { fillColor: [224, 236, 229], textColor: [0, 61, 39], fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: 48 }, 1: { halign: "right" }, 2: { halign: "right" },
        3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } },
    });
  };

  const scope = report.fund === "TODOS" ? `Todos os fundos com dados (${report.funds.length})` :
    `${report.funds[0].nome_fundo} | CNPJ: ${report.funds[0].doc_fundo}`;
  table({ theme: "plain", body: [[`Escopo: ${scope}`],
    [`Emitido em: ${report.generatedAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} (Brasília)`]],
    styles: { fontSize: 9, cellPadding: 1.5 } });
  section("Resumo do monitoramento");
  const t = report.totals;
  table({
    head: [["Carteira (VP)", "PDD total", "PDD / carteira", "VP adimplente", "VP vencido*", "VP write-off*"]],
    body: [[money(t.vp), money(t.pdd), percent(pddRatio(t.pdd, t.vp)), money(t.adimplente), money(t.vencido), money(t.writeoff)]],
  });
  section(report.fund === "TODOS" ? "Cobertura consolidada por faixa" : "Cobertura de PDD por faixa");
  coverage(report.buckets, t.vp, t.pdd);

  section("Critérios e origem dos dados");
  table({ theme: "plain", styles: { fontSize: 8, cellPadding: 1.5 }, body: [
    ["PDD: provisão registrada no estoque importado. VP: valor-base do módulo de crédito. Valores em reais, com centavos."],
    ["Cobertura = PDD da faixa / VP da faixa. Percentuais consolidados são calculados sobre as somas dos valores. N/D indica denominador nulo ou não positivo."],
    ["* Vencidos excluem os títulos classificados como write-off pelo módulo. Write-off é a classificação operacional do sistema (atraso superior a 180 dias ou situação de baixa/perda), não uma confirmação de baixa contábil."],
    ["Faixas seguem a classificação do estoque. Registros não classificáveis são excluídos das bases de resumo e cobertura. Fonte: estoque FIDC; visões de monitoramento e cobertura de PDD, na data-base indicada."],
    ["Este relatório apresenta a posição de PDD na data-base. A suficiência da provisão depende da metodologia aplicável ao fundo; o relatório não calcula PDD modelo ou déficit de provisão."],
  ] });

  if (report.fund === "TODOS") {
    doc.addPage(); y = 28;
    section("Fundos incluídos no consolidado");
    table({ head: [["Fundo / CNPJ", "Carteira (VP)", "PDD", "PDD / carteira", "VP vencido*", "VP write-off*"]],
      body: report.funds.map((f) => [`${f.nome_fundo}\n${f.doc_fundo}`, money(f.vp_total), money(f.pdd_total),
        percent(pddRatio(f.pdd_total, f.vp_total)), money(f.vp_vencido), money(f.vp_writeoff)]),
      columnStyles: { 0: { cellWidth: 70 } } });
    for (const fund of report.funds) {
      doc.addPage(); y = 28;
      table({ theme: "plain", body: [[`Fundo: ${fund.nome_fundo}`], [`CNPJ: ${fund.doc_fundo}`]],
        styles: { fontSize: 10, cellPadding: 1.5 } });
      section("Cobertura de PDD por faixa");
      coverage(fund.faixas.map((row) => ({ label: row.faixa_prazo, vp: row.vp_total_faixa, pdd: row.vp_pdd_faixa })), fund.vp_total, fund.pdd_total);
    }
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFillColor(0, 61, 39); doc.rect(0, 0, width, 22, "F");
    doc.setTextColor(255); doc.setFontSize(14); doc.setFont("helvetica", "bold");
    doc.text("Relatório de Monitoramento de PDD", margin, 10);
    doc.setFontSize(9); doc.setFont("helvetica", "normal");
    doc.text(`Risco de Crédito | Data-base: ${formatDateBR(report.date)}`, margin, 17);
    doc.setTextColor(100); doc.setFontSize(8);
    doc.text("Frame Control Center | Uso interno e confidencial", margin, height - 8);
    doc.text(`Página ${i} de ${pages}`, width - margin, height - 8, { align: "right" });
  }
  return doc;
}

export async function exportPddPdf(report: PddReport): Promise<void> {
  const scope = report.fund === "TODOS" ? "todos-fundos" : report.fund.replace(/[^a-zA-Z0-9_-]/g, "");
  await createPddPdf(report).save(`monitoramento-pdd-${scope}-${report.date}.pdf`, { returnPromise: true });
}
