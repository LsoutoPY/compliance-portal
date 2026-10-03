import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx-js-style";

type Metric = { value: number | null; status: "apurado" | "aproximado" | "indisponivel"; source: string; note?: string };
type Result = { metrics: Record<string, Metric>; maturityCvm: { value: number | null }[]; overdueCvm?: { value: number | null }[]; gaps: string[] };
type Fund = { cnpj: string; shortName: string };
type Row = { section: string; label: string; key?: string; bucket?: { type: "maturityCvm" | "overdueCvm"; index: number }; unit?: "percent" | "days" | "count"; gap?: string };
export type MonthlyExportInput = {
  month: string;
  source: "portal" | "preview";
  funds: Fund[];
  rows: Row[];
  runs: Record<string, Result>;
  previousRuns?: Record<string, Result>;
  previousMonth?: string;
  simulated: boolean;
};

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const percent = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 2 });
const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const statusLabel = { apurado: "Apurado", aproximado: "Aproximado", indisponivel: "Indisponível" };
const fileBase = (input: MonthlyExportInput) => `Liquidez_FIDC_${input.month.replace("-", "")}_${input.source === "portal" ? "portal" : "previa"}`;
const sourceLabel = (source: MonthlyExportInput["source"]) => source === "portal" ? "Base do portal" : "Prévia CVM enviada";
const metricFor = (result: Result | undefined, row: Row): Metric | undefined => {
  if (!result) return undefined;
  if (row.key) return result.metrics[row.key];
  if (!row.bucket) return undefined;
  const value = result[row.bucket.type]?.[row.bucket.index]?.value ?? null;
  return {
    value,
    status: value === null ? "indisponivel" : "aproximado",
    source: `Informe CVM · TAB_V/VI_${row.bucket.type === "maturityCvm" ? "A" : "B"}${row.bucket.index + 1}`,
    note: row.bucket.type === "maturityCvm" ? "Vencimento contratual; não é previsão de caixa." : "Faixa agregada do informe.",
  };
};
const formatValue = (value: number | null | undefined, unit?: Row["unit"]) =>
  value == null ? "n/d" : unit === "percent" ? percent.format(value) : unit === "days" ? `${number.format(value)} dias` : unit === "count" ? number.format(value) : money.format(value);
const hex = (token: string) => getComputedStyle(document.documentElement).getPropertyValue(token).trim();
const rgb = (color: string): [number, number, number] => {
  const clean = color.replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(clean.slice(offset, offset + 2), 16)) as [number, number, number];
};
const pdfText = (value: string) => value.replace(/≤/g, "<=").replace(/≥/g, ">=").replace(/[–—]/g, "-").replace(/Δ/g, "Delta").replace(/×/g, "x");

export function exportMonthlyExcel(input: MonthlyExportInput) {
  const brand = hex("--teal-600").slice(1);
  const pale = hex("--teal-50").slice(1);
  const ink = hex("--neutral-900").slice(1);
  const soft = hex("--neutral-50").slice(1);
  const green = hex("--green-600").slice(1);
  const amber = hex("--amber-700").slice(1);
  const gray = hex("--neutral-500").slice(1);
  const workbook = XLSX.utils.book_new();
  const width = input.funds.length + 1;
  const matrix: (string | number | null)[][] = [
    ["RELATÓRIO MENSAL DE LIQUIDEZ · FIDC"],
    [`Competência ${input.month} · ${sourceLabel(input.source)} · Metodologia cvpar_fidc_mensal@2026.2`],
    [input.simulated ? "ATENÇÃO: contém mínimos de subordinação simulados e não salvos." : "Valores recalculados do Informe Mensal CVM; exportação estática para revisão."],
    ["Indicador", ...input.funds.map((fund) => `${fund.shortName}\n${fund.cnpj}`)],
  ];
  const sectionRows = new Set<number>();
  const reportRowBySheetRow = new Map<number, Row>();
  let lastSection = "";
  for (const row of input.rows) {
    if (row.section !== lastSection) {
      sectionRows.add(matrix.length);
      matrix.push([row.section.toLocaleUpperCase("pt-BR")]);
      lastSection = row.section;
    }
    reportRowBySheetRow.set(matrix.length, row);
    matrix.push([row.label, ...input.funds.map((fund) => metricFor(input.runs[fund.cnpj], row)?.value ?? "n/d")]);
  }
  const sheet = XLSX.utils.aoa_to_sheet(matrix);
  sheet["!cols"] = [{ wch: 48 }, ...input.funds.map(() => ({ wch: 23 }))];
  sheet["!rows"] = matrix.map((_, index) => ({ hpt: index < 3 ? 23 : index === 3 ? 32 : 19 }));
  sheet["!freeze"] = { xSplit: 1, ySplit: 4 };
  sheet["!autofilter"] = { ref: `A4:${XLSX.utils.encode_col(width - 1)}${matrix.length}` };
  for (let column = 0; column < width; column++) {
    for (let row = 0; row < matrix.length; row++) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (!cell) continue;
      const isBand = row < 4 || sectionRows.has(row);
      cell.s = {
        font: { name: "Arial", sz: row === 0 ? 15 : row === 3 ? 10 : 9, bold: isBand, color: { rgb: row === 0 || row === 3 ? "FFFFFF" : ink } },
        fill: { fgColor: { rgb: row === 0 || row === 3 ? brand : sectionRows.has(row) ? pale : row % 2 === 0 ? soft : "FFFFFF" } },
        alignment: { vertical: "center", horizontal: column === 0 ? "left" : "right", wrapText: row === 3 },
        border: { bottom: { style: "hair", color: { rgb: "D8DDDD" } } },
      };
      if (row > 3 && !sectionRows.has(row) && column > 0) {
        const reportRow = reportRowBySheetRow.get(row)!;
        const metric = metricFor(input.runs[input.funds[column - 1].cnpj], reportRow);
        if (metric?.value == null) {
          cell.v = "n/d";
          cell.t = "s";
          cell.s.font.color = { rgb: gray };
        } else {
          cell.z = reportRow.unit === "percent" ? "0.00%" : reportRow.unit === "days" ? "0.0" : reportRow.unit === "count" ? "#,##0" : '"R$" #,##0.00;[Red]-"R$" #,##0.00';
          cell.s.font.color = { rgb: metric.status === "apurado" ? green : amber };
        }
      }
    }
  }
  sheet["!merges"] = [0, 1, 2, ...sectionRows].map((row) => ({ s: { r: row, c: 0 }, e: { r: row, c: width - 1 } }));
  XLSX.utils.book_append_sheet(workbook, sheet, "Relatório");

  const memory: (string | number)[][] = [["Fundo", "CNPJ", "Seção", "Indicador", "Valor", "Unidade", "Qualidade", "Origem", "Ressalva"]];
  for (const fund of input.funds) for (const row of input.rows) {
    const metric = metricFor(input.runs[fund.cnpj], row);
    memory.push([fund.shortName, fund.cnpj, row.section, row.label, metric?.value ?? "n/d", row.unit ?? "BRL", statusLabel[metric?.status ?? "indisponivel"], metric?.source ?? "Fonte não disponível", metric?.note ?? row.gap ?? ""]);
  }
  const memorySheet = XLSX.utils.aoa_to_sheet(memory);
  memorySheet["!cols"] = [24, 20, 30, 48, 19, 12, 17, 70, 70].map((wch) => ({ wch }));
  memorySheet["!autofilter"] = { ref: `A1:I${memory.length}` };
  for (let col = 0; col < 9; col++) { const cell = memorySheet[XLSX.utils.encode_cell({ r: 0, c: col })]; cell.s = { font: { name: "Arial", bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: brand } } }; }
  XLSX.utils.book_append_sheet(workbook, memorySheet, "Memória e fontes");

  const gapRows = [["Fundo", "CNPJ", "Lacuna do cálculo"], ...input.funds.flatMap((fund) => (input.runs[fund.cnpj]?.gaps ?? ["Execução não disponível."]).map((gap) => [fund.shortName, fund.cnpj, gap]))];
  const gaps = XLSX.utils.aoa_to_sheet(gapRows);
  gaps["!cols"] = [{ wch: 26 }, { wch: 20 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(workbook, gaps, "Lacunas");

  const metadata = XLSX.utils.aoa_to_sheet([
    ["Campo", "Valor"], ["Competência", input.month], ["Origem", sourceLabel(input.source)], ["Metodologia", "cvpar_fidc_mensal@2026.2"],
    ["Gerado em", new Date().toLocaleString("pt-BR")], ["Fundos selecionados", input.funds.length],
    ["Parâmetros simulados", input.simulated ? "Sim; não salvos no banco" : "Não"],
    ["Nota", "Exportação de valores estáticos da execução. O Excel não é entrada do cálculo no portal."],
    ["Limite", "Vencimento contratual e liquidez contábil não são previsão de caixa nem cobertura de resgates."],
  ]);
  metadata["!cols"] = [{ wch: 25 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(workbook, metadata, "Metadados");
  if (input.previousRuns && input.previousMonth) {
    const comparison: (string | number)[][] = [["Fundo", "Indicador", input.previousMonth, input.month, "Variação"]];
    for (const fund of input.funds) for (const row of input.rows) {
      const before = metricFor(input.previousRuns[fund.cnpj], row)?.value;
      const after = metricFor(input.runs[fund.cnpj], row)?.value;
      comparison.push([fund.shortName, row.label, before ?? "n/d", after ?? "n/d", before == null || after == null ? "n/d" : after - before]);
    }
    const compareSheet = XLSX.utils.aoa_to_sheet(comparison);
    compareSheet["!cols"] = [{ wch: 26 }, { wch: 50 }, { wch: 22 }, { wch: 22 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(workbook, compareSheet, "Comparativo");
  }
  XLSX.writeFile(workbook, `${fileBase(input)}.xlsx`);
}

export function exportMonthlyPdf(input: MonthlyExportInput) {
  const brand = rgb(hex("--teal-600"));
  const pale = rgb(hex("--teal-50"));
  const ink = rgb(hex("--neutral-800"));
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  input.funds.forEach((fund, fundIndex) => {
    if (fundIndex) pdf.addPage();
    const result = input.runs[fund.cnpj];
    const drawHeader = () => {
      pdf.setFillColor(...brand); pdf.rect(0, 0, 210, 15, "F");
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(10); pdf.setTextColor(255, 255, 255);
      pdf.text("RISCO CVPAR  /  RELATÓRIO MENSAL FIDC", 12, 10);
      pdf.setTextColor(...ink); pdf.setFontSize(14);
      pdf.text(pdfText(fund.shortName), 12, 25);
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(8);
      pdf.text(`CNPJ ${fund.cnpj}  |  ${input.month}  |  ${sourceLabel(input.source)}  |  cvpar_fidc_mensal@2026.2`, 12, 31);
      if (input.simulated) { pdf.setTextColor(150, 83, 12); pdf.text("ATENÇÃO: inclui parâmetro local simulado; não salvo no banco.", 12, 36); pdf.setTextColor(...ink); }
    };
    const body: any[] = [];
    let lastSection = "";
    for (const row of input.rows) {
      if (row.section !== lastSection) {
        body.push([{ content: pdfText(row.section.toLocaleUpperCase("pt-BR")), colSpan: 4, styles: { fillColor: pale, textColor: brand, fontStyle: "bold" } }]);
        lastSection = row.section;
      }
      const metric = metricFor(result, row);
      const before = input.previousRuns ? metricFor(input.previousRuns[fund.cnpj], row)?.value : null;
      const delta = before == null || metric?.value == null ? "" : ` | Delta ${formatValue(metric.value - before, row.unit)}`;
      body.push([pdfText(row.label), pdfText(formatValue(metric?.value, row.unit) + delta), statusLabel[metric?.status ?? "indisponivel"], pdfText(metric?.note ?? row.gap ?? metric?.source ?? "Fonte não disponível")]);
    }
    if (result?.gaps?.length) {
      body.push([{ content: "LACUNAS DA FONTE", colSpan: 4, styles: { fillColor: pale, textColor: brand, fontStyle: "bold" } }]);
      for (const gap of result.gaps) body.push([{ content: pdfText(gap), colSpan: 4 }]);
    }
    autoTable(pdf, {
      head: [["Indicador", "Valor", "Qualidade", "Origem / ressalva"]], body,
      startY: 40, margin: { top: 40, bottom: 17, left: 12, right: 12 },
      tableWidth: 186, columnStyles: { 0: { cellWidth: 55 }, 1: { cellWidth: 39, halign: "right" }, 2: { cellWidth: 23 }, 3: { cellWidth: 69 } },
      styles: { font: "helvetica", fontSize: 7, cellPadding: 1.7, textColor: ink, lineColor: [216, 221, 221], lineWidth: 0.05, overflow: "linebreak" },
      headStyles: { fillColor: brand, textColor: [255, 255, 255], fontStyle: "bold" },
      alternateRowStyles: { fillColor: [250, 251, 251] },
      didDrawPage: drawHeader,
    });
  });
  const total = pdf.getNumberOfPages();
  for (let page = 1; page <= total; page++) {
    pdf.setPage(page); pdf.setFont("helvetica", "normal"); pdf.setFontSize(7); pdf.setTextColor(85, 98, 98);
    pdf.text("Fonte: Informe Mensal CVM. Liquidez contábil e vencimentos não comprovam cobertura de resgates.", 12, 286);
    pdf.text(`${page} / ${total}`, 198, 286, { align: "right" });
  }
  pdf.save(`${fileBase(input)}.pdf`);
}
