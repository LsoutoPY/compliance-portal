/**
 * Utilitários de exportação PDF e Excel para o módulo de Elegibilidade de Cessões.
 * Paleta de cores alinhada ao design system do Frame Control Center (Equity OS).
 */
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import ExcelJS from "exceljs";

// ── Tipos de dados para exportação ──────────────────────────────────────────

/** Linha do breakdown de cálculo de uma regra (pró-forma, cedente, sacado, DC). */
export interface BreakdownExportRow {
  tipo_item: "cedente" | "sacado" | "dc";
  tipo_linha?: "resumo" | "titulo" | "taxa" | "cadastro_limite";
  origem?: "estoque" | "csv" | "proforma";
  label: string;
  doc?: string;
  documento?: string;
  cedente?: string;
  sacado?: string;
  prazo?: number;
  valor_rs?: number;
  estoque_rs?: number;
  proposto_rs?: number;
  total_rs?: number;
  pct_pl?: number;
  limite_pct_pl?: number;
  valor_atual_texto?: string;
  limite_texto?: string;
  pct_uso_limite?: number | null;
  valor_extra?: string;
  status: "ok" | "violacao";
}

/** DC individual rejeitado por uma regra. */
export interface DetalheDcExport {
  ds_seu_numero?: string;
  nm_sacado?: string;
  nm_cedente?: string;
  vl_pago?: number;
  prazo?: number;
  valor_atual?: unknown;
  valor_limite?: unknown;
}

export interface HistoricoItem {
  id: string;
  created_at: string;
  fundo_cnpj: string;
  fundo_nome?: string;
  filename?: string;
  total_dcs: number;
  elegiveis: number;
  enquadram?: number;
  desenquadram?: number;
  vp_total_proposto: number | string;
  status: string;
}

export interface AnaliseCessao {
  simuladoEm: Date;
  fundo_cnpj?: string;
  fundo_nome?: string;
  carteira_atual?: {
    qtd_recebiveis: number;
    vp_total: number;
    pdd_total: number;
    prazo_medio_pond: number;
    perc_pl_alocado: number;
    pl: number;
    pl_header_raw?: number;
    pl_origem?: "xml" | "fidc_header";
    pl_data_posicao?: string | null;
    estoque_data_referencia?: string | null;
  };
  cessao_proposta?: {
    total_dcs: number;
    vp_total_proposto: number;
    elegiveis: number;
    inelegiveis: number;
    enquadram: number;
    desenquadram: number;
    vp_elegiveis: number;
  };
  recompras?: {
    total: number;
    vp: number;
  };
  proforma?: {
    vp_total: number;
    perc_pl: number;
    prazo_medio_pond: number;
    espaco_livre: number;
  };
  regras_checklist?: {
    regra_codigo: string;
    regra_descricao: string;
    modo: string;
    rejeicoes: number;
    total_dcs: number;
    status: "ok" | "violacao";
    valor_atual: string | null;
    valor_limite: string | null;
    /** Linhas de composição pró-forma / cedentes / sacados para este regra */
    breakdown?: BreakdownExportRow[];
    /** DCs individuais rejeitados por esta regra */
    detalhes_dcs?: DetalheDcExport[];
  }[];
  resultados?: {
    ds_seu_numero: string;
    nm_sacado: string;
    nm_cedente: string;
    cpf_cnpj_cedente: string;
    vl_pago: number;
    prazo: number;
    tipo_operacao?: "AQUISICAO" | "RECOMPRA";
    elegivel: boolean | null;
    enquadra?: boolean | null;
    motivos: { regra_codigo: string; regra_descricao: string; valor_atual: unknown; valor_limite: unknown }[];
  }[];
}

// ── Paleta do sistema (Frame Control Center — Equity OS) ─────────────────────
// hsl(220,13%,10%)  ≈ #161820 primary dark
// hsl(210,8%,49%)   = #737D87 sidebar background
// hsl(158,100%,12%) = #003D27 sidebar active / accent green
// hsl(142,71%,45%)  ≈ #22c55e success

type RGB = [number, number, number];

const C = {
  // PDF colors [R, G, B]
  headerBg:   [28,  35,  51]  as RGB,  // #1C2333 — nav dark
  accentGreen:[0,   61,  39]  as RGB,  // #003D27 — sidebar ativo
  sidebarGray:[115, 125, 135] as RGB,  // #737D87 — sidebar bg
  success:    [5,   150, 105] as RGB,  // #059669 — emerald
  successBg:  [209, 250, 229] as RGB,  // #D1FAE5
  error:      [220, 38,  38]  as RGB,  // #DC2626
  errorBg:    [254, 226, 226] as RGB,  // #FEE2E2
  warning:    [180, 100, 0]   as RGB,  // âmbar escuro (legível sobre branco)
  warningBg:  [254, 243, 199] as RGB,  // #FEF3C7
  white:      [255, 255, 255] as RGB,
  text:       [39,  42,  48]  as RGB,  // #272A30
  muted:      [107, 114, 128] as RGB,  // #6B7280
  border:     [229, 231, 235] as RGB,  // #E5E7EB
  rowAlt:     [249, 250, 251] as RGB,  // #F9FAFB

  // Excel ARGB (Alpha sempre FF = opaco)
  xl: {
    headerBg:    "FF1C2333",
    accentGreen: "FF003D27",
    sidebarGray: "FF737D87",
    success:     "FF059669",
    successBg:   "FFD1FAE5",
    successText: "FF065F46",
    error:       "FFDC2626",
    errorBg:     "FFFEE2E2",
    errorText:   "FF991B1B",
    warning:     "FFF59E0B",
    warningBg:   "FFFEF3C7",
    white:       "FFFFFFFF",
    text:        "FF272A30",
    muted:       "FF6B7280",
    border:      "FFE5E7EB",
    rowAlt:      "FFF9FAFB",
    rowEven:     "FFFFFFFF",
    subheader:   "FFF3F4F6",
  },
} as const;

// ── Helpers de formatação ─────────────────────────────────────────────────────

function fmtDate(d: Date): string {
  return d.toLocaleDateString("pt-BR");
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtBRL(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

function fmtPct(v: number): string {
  return `${v.toFixed(2)}%`;
}

function fmtDias(v: number): string {
  return `${Math.round(v)} dias`;
}

function fmtDateFromRaw(raw?: string | null): string {
  if (!raw) return "—";
  const s = String(raw).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString("pt-BR");
  }
  const compact = s.replace(/\D/g, "");
  if (compact.length === 8) {
    const d = new Date(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)) - 1, Number(compact.slice(6, 8)));
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString("pt-BR");
  }
  return s;
}

function fmtCnpj(d: string): string {
  const c = d.replace(/\D/g, "");
  if (c.length === 14) return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  return d;
}

/**
 * Substitui caracteres unicode que causam letter-spacing indesejado no jsPDF.
 * Caracteres como ≤ e ≥ forçam troca de codificação e espaçam letras seguintes.
 */
function sanitizePdfText(s: unknown): string {
  return String(s ?? "")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/−/g, "-")
    .replace(/×/g, "x")
    .replace(/\u2212/g, "-")
    .replace(/\u00d7/g, "x")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'");
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Carrega o logo sidebar (versão branca para fundos escuros) como data URL base64. */
async function loadLogo(): Promise<string | null> {
  try {
    const res = await fetch("/logo-cvpar-sidebar.png");
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// ── PDF: utilitários de layout ────────────────────────────────────────────────

function pdfDrawHeader(
  doc: jsPDF,
  title: string,
  subtitle: string,
  logoDataUrl?: string | null,
): number {
  const W = doc.internal.pageSize.getWidth();
  const now = new Date();

  // Faixa escura principal
  doc.setFillColor(...C.headerBg);
  doc.rect(0, 0, W, 30, "F");

  // Logo no canto superior direito (versão sidebar = fundo escuro)
  const LOGO_H = 22;
  const LOGO_W = 50; // largura máxima; jsPDF mantém proporção
  const logoX = W - 14 - LOGO_W;
  const logoY = 4;
  if (logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, "PNG", logoX, logoY, LOGO_W, LOGO_H);
    } catch {
      // Silencia erro caso o formato não seja suportado
    }
  }

  // Rótulo do sistema (canto superior esquerdo)
  doc.setFontSize(6.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...C.sidebarGray);
  doc.text("FRAME CONTROL CENTER — EVIDÊNCIA DE AUDITORIA", 14, 10);

  // Timestamp de exportação abaixo do rótulo (esquerda)
  doc.setFontSize(6.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(160, 165, 175);
  doc.text(`Exportado em ${fmtDate(now)} às ${fmtTime(now)}`, 14, 17);

  // Título principal
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...C.white);
  doc.text(title, 14, 26);

  // Faixa verde de subtítulo
  doc.setFillColor(...C.accentGreen);
  doc.rect(0, 30, W, 8, "F");
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...C.white);
  doc.text(subtitle, 14, 35.5);

  return 44;
}

function pdfDrawMetaBlock(
  doc: jsPDF,
  items: { label: string; value: string }[],
  startY: number,
): number {
  const W = doc.internal.pageSize.getWidth();
  const M = 14;
  const blockH = 6 + items.length * 6;

  doc.setFillColor(...C.rowAlt);
  doc.rect(M, startY, W - M * 2, blockH, "F");
  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.3);
  doc.rect(M, startY, W - M * 2, blockH, "S");

  // Barra lateral verde
  doc.setFillColor(...C.accentGreen);
  doc.rect(M, startY, 3, blockH, "F");

  doc.setFontSize(7.5);
  let y = startY + 6;
  for (const item of items) {
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...C.muted);
    doc.text(`${item.label}:`, M + 7, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...C.text);
    doc.text(item.value, M + 58, y);
    y += 6;
  }

  return startY + blockH + 4;
}

function pdfSectionTitle(doc: jsPDF, text: string, y: number): number {
  const W = doc.internal.pageSize.getWidth();
  const M = 14;

  doc.setFillColor(...C.sidebarGray);
  doc.rect(M, y, W - M * 2, 7, "F");
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...C.white);
  doc.text(text, M + 4, y + 4.8);

  return y + 10;
}

function pdfFooter(doc: jsPDF, exportedAt: Date): void {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const total = (doc as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages();

  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.3);
    doc.line(14, H - 12, W - 14, H - 12);
    doc.setFontSize(6.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...C.muted);
    doc.text(
      `Frame Control Center — Evidência de Auditoria — Gerado em ${fmtDate(exportedAt)} às ${fmtTime(exportedAt)} — Página ${p} de ${total}`,
      W / 2,
      H - 7,
      { align: "center" },
    );
  }
}

// ── Excel: utilitários de célula ──────────────────────────────────────────────

function xlHeaderCell(cell: ExcelJS.Cell, text: string, bgArgb: string = C.xl.accentGreen): void {
  cell.value = text;
  cell.font = { bold: true, color: { argb: C.xl.white }, size: 9, name: "Calibri" };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };
  cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
}

function xlTitleRow(ws: ExcelJS.Worksheet, text: string, mergeRange: string, bgArgb: string = C.xl.headerBg): void {
  ws.mergeCells(mergeRange);
  const cell = ws.getCell(mergeRange.split(":")[0]);
  cell.value = text;
  cell.font = { bold: true, color: { argb: C.xl.white }, size: 12, name: "Calibri" };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };
  cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  ws.getRow(ws.rowCount).height = 28;
}

function xlMetaRow(ws: ExcelJS.Worksheet, text: string, mergeRange: string): void {
  ws.mergeCells(mergeRange);
  const cell = ws.getCell(mergeRange.split(":")[0]);
  cell.value = text;
  cell.font = { italic: true, size: 8, color: { argb: C.xl.muted }, name: "Calibri" };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.xl.subheader } };
  cell.alignment = { vertical: "middle", indent: 1 };
  ws.getRow(ws.rowCount).height = 16;
}

function xlKpiRow(ws: ExcelJS.Worksheet, label: string, value: string, isSection = false): void {
  const row = ws.addRow([label, value]);
  row.height = isSection ? 20 : 15;

  const lCell = row.getCell(1);
  const vCell = row.getCell(2);

  if (isSection) {
    lCell.value = label;
    lCell.font = { bold: true, color: { argb: C.xl.white }, size: 9 };
    lCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.xl.sidebarGray } };
    lCell.alignment = { vertical: "middle", indent: 1 };
    vCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.xl.sidebarGray } };
    ws.mergeCells(`A${row.number}:B${row.number}`);
  } else {
    lCell.font = { bold: true, size: 9, color: { argb: C.xl.muted } };
    lCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.xl.rowAlt } };
    lCell.alignment = { vertical: "middle", indent: 2 };
    vCell.font = { size: 9, color: { argb: C.xl.text } };
    vCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.xl.rowAlt } };
    vCell.alignment = { vertical: "middle" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ITEM INDIVIDUAL DO HISTÓRICO — helpers de conversão
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reconstrói um regras_checklist simplificado a partir dos motivos de rejeição
 * dos DCs, para registros que não possuem regras_snapshot gravado no banco.
 * Cobre apenas regras do tipo "individual" (por DC); regras pró-forma e de
 * concentração que não geram motivos por DC não aparecem nesta reconstrução.
 */
function reconstructRegrasFromResultados(
  resultados: AnaliseCessao["resultados"],
  totalDcs: number,
): AnaliseCessao["regras_checklist"] {
  if (!resultados || resultados.length === 0) return undefined;

  const map = new Map<string, {
    regra_codigo: string;
    regra_descricao: string;
    rejeicoes: number;
    valor_atual: string | null;
    valor_limite: string | null;
  }>();

  for (const dc of resultados) {
    for (const m of dc.motivos) {
      if (!map.has(m.regra_codigo)) {
        map.set(m.regra_codigo, {
          regra_codigo: m.regra_codigo,
          regra_descricao: m.regra_descricao,
          rejeicoes: 0,
          valor_atual: m.valor_atual != null ? String(m.valor_atual) : null,
          valor_limite: m.valor_limite != null ? String(m.valor_limite) : null,
        });
      }
      map.get(m.regra_codigo)!.rejeicoes++;
    }
  }

  if (map.size === 0) return undefined;

  return Array.from(map.values()).map(r => ({
    regra_codigo: r.regra_codigo,
    regra_descricao: r.regra_descricao,
    modo: "individual" as const,
    rejeicoes: r.rejeicoes,
    total_dcs: totalDcs,
    status: (r.rejeicoes > 0 ? "violacao" : "ok") as "ok" | "violacao",
    valor_atual: r.valor_atual,
    valor_limite: r.valor_limite,
  }));
}

/**
 * Converte um registro do histórico (cessao_importacoes.*) num objeto AnaliseCessao,
 * aproveitando todos os campos JSON que o backend possa ter gravado no registro.
 * Quando regras_snapshot é null (registros anteriores à coluna ser adicionada),
 * reconstrói o checklist a partir dos motivos dos DCs.
 */
function historicoItemToAnalise(h: Record<string, unknown>): AnaliseCessao {
  const resultados = h.resultados as AnaliseCessao["resultados"] ?? undefined;
  const totalDcs   = Number(h.total_dcs) || 0;
  const regrasSnapshot = h.regras_snapshot as AnaliseCessao["regras_checklist"] ?? undefined;

  return {
    simuladoEm: new Date(h.created_at as string),
    fundo_cnpj: (h.fundo_cnpj as string) ?? "",
    fundo_nome: (h.fundo_nome as string) ?? undefined,
    carteira_atual: h.carteira_snapshot as AnaliseCessao["carteira_atual"] ?? undefined,
    cessao_proposta: (() => {
      const cp = h.cessao_proposta as Record<string, unknown> | undefined;
      if (cp) return cp as AnaliseCessao["cessao_proposta"];
      return {
        total_dcs:         totalDcs,
        vp_total_proposto: Number(h.vp_total_proposto) || 0,
        elegiveis:         Number(h.elegiveis) || 0,
        inelegiveis:       Number(h.inelegiveis) || 0,
        enquadram:         Number(h.enquadram ?? h.elegiveis) || 0,
        desenquadram:      Number(h.desenquadram) || 0,
        vp_elegiveis:      Number(h.vp_elegiveis ?? h.vp_total_proposto) || 0,
      };
    })(),
    proforma: h.proforma_snapshot as AnaliseCessao["proforma"] ?? undefined,
    recompras: (() => {
      const tr = Number(h.total_recompras) || 0;
      if (tr > 0) return { total: tr, vp: Number(h.vp_recompras) || 0 };
      return undefined;
    })(),
    regras_checklist: regrasSnapshot ?? reconstructRegrasFromResultados(resultados, totalDcs),
    resultados,
  };
}

/** Exporta um único registro do histórico como PDF. */
export async function exportHistoricoItemPDF(h: Record<string, unknown>): Promise<void> {
  return exportAnalisePDF(historicoItemToAnalise(h));
}

/** Exporta um único registro do histórico como Excel. */
export async function exportHistoricoItemExcel(h: Record<string, unknown>): Promise<void> {
  return exportAnaliseExcel(historicoItemToAnalise(h));
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTÓRICO — Exportação PDF
// ═══════════════════════════════════════════════════════════════════════════════

export async function exportHistoricoPDF(historico: HistoricoItem[]): Promise<void> {
  const logo = await loadLogo();
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const now = new Date();

  let y = pdfDrawHeader(
    doc,
    "Histórico de Validações de Elegibilidade",
    "Simulações de Cessão FIDC — Registro para Auditoria",
    logo,
  );

  y = pdfDrawMetaBlock(doc, [
    { label: "Data de exportação", value: fmtDate(now) },
    { label: "Hora de exportação", value: fmtTime(now) },
    { label: "Total de registros", value: `${historico.length} simulações` },
    { label: "Módulo", value: "Elegibilidade de Cessões (Crédito FIDC)" },
  ], y);

  y += 2;
  y = pdfSectionTitle(doc, "REGISTROS DE SIMULAÇÕES", y);

  autoTable(doc, {
    startY: y,
    head: [[
      "Data Simulação",
      "Hora Simulação",
      "Fundo",
      "Arquivo CSV",
      "Total DCs",
      "Elegíveis",
      "Enquadram",
      "Desenquadram",
      "VP Proposto (R$)",
      "Status",
    ]],
    body: historico.map(h => {
      const dt = new Date(h.created_at);
      return [
        fmtDate(dt),
        fmtTime(dt),
        h.fundo_nome || fmtCnpj(h.fundo_cnpj),
        h.filename || "—",
        String(h.total_dcs),
        String(h.elegiveis),
        String(h.enquadram ?? h.elegiveis),
        String(h.desenquadram ?? 0),
        fmtBRL(Number(h.vp_total_proposto) || 0),
        h.status === "success" ? "OK" : h.status.toUpperCase(),
      ];
    }),
    styles: {
      fontSize: 7.5,
      cellPadding: 2.5,
      textColor: C.text,
      lineColor: C.border,
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: C.headerBg,
      textColor: C.white,
      fontStyle: "bold",
      fontSize: 7,
    },
    alternateRowStyles: {
      fillColor: C.rowAlt,
    },
    columnStyles: {
      4: { halign: "right" },
      5: { halign: "right" },
      6: { halign: "right" },
      7: { halign: "right" },
      8: { halign: "right" },
      9: { halign: "center" },
    },
    didDrawCell: (data) => {
      if (data.section === "body" && data.column.index === 9) {
        const val = String(data.cell.raw);
        const isOk = val === "OK";
        doc.setFillColor(...(isOk ? C.successBg : C.errorBg));
        doc.rect(data.cell.x, data.cell.y, data.cell.width, data.cell.height, "F");
        doc.setFontSize(7);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(...(isOk ? C.success : C.error));
        doc.text(
          val,
          data.cell.x + data.cell.width / 2,
          data.cell.y + data.cell.height / 2 + 1,
          { align: "center" },
        );
      }
    },
    margin: { left: 14, right: 14 },
  });

  pdfFooter(doc, now);
  doc.save(`historico-cessoes-${now.toISOString().slice(0, 10)}.pdf`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTÓRICO — Exportação Excel
// ═══════════════════════════════════════════════════════════════════════════════

export async function exportHistoricoExcel(historico: HistoricoItem[]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Frame Control Center";
  wb.created = new Date();
  wb.properties.date1904 = false;

  const ws = wb.addWorksheet("Histórico de Validações", {
    views: [{ state: "frozen", ySplit: 5 }],
  });

  const now = new Date();

  ws.columns = [
    { key: "data",          width: 18 },
    { key: "hora",          width: 14 },
    { key: "fundo",         width: 42 },
    { key: "arquivo",       width: 32 },
    { key: "total_dcs",     width: 12 },
    { key: "elegiveis",     width: 12 },
    { key: "enquadram",     width: 14 },
    { key: "desenquadram",  width: 14 },
    { key: "vp_proposto",   width: 22 },
    { key: "status",        width: 12 },
  ];

  // Linha 1: Título
  xlTitleRow(ws, "FRAME CONTROL CENTER — Histórico de Validações de Elegibilidade de Cessões", "A1:J1");

  // Linha 2: Subtítulo verde
  xlTitleRow(ws, "Simulações de Cessão FIDC — Registro para Auditoria", "A2:J2", C.xl.accentGreen);
  ws.getRow(2).height = 18;

  // Linha 3: Metadados
  xlMetaRow(ws, `Exportado em: ${fmtDate(now)} às ${fmtTime(now)}  |  Total de registros: ${historico.length}`, "A3:J3");

  // Linha 4: Spacer
  ws.addRow([]);
  ws.getRow(4).height = 4;

  // Linha 5: Cabeçalho da tabela
  const headerRow = ws.addRow([
    "Data Simulação", "Hora Simulação", "Fundo", "Arquivo CSV",
    "Total DCs", "Elegíveis", "Enquadram", "Desenquadram", "VP Proposto (R$)", "Status",
  ]);
  headerRow.height = 22;
  headerRow.eachCell(cell => xlHeaderCell(cell, String(cell.value ?? "")));

  // Dados
  historico.forEach((h, i) => {
    const dt = new Date(h.created_at);
    const isAlt = i % 2 === 0;
    const rowBg = isAlt ? C.xl.rowAlt : C.xl.rowEven;

    const row = ws.addRow([
      fmtDate(dt),
      fmtTime(dt),
      h.fundo_nome || fmtCnpj(h.fundo_cnpj),
      h.filename || "—",
      h.total_dcs,
      h.elegiveis,
      h.enquadram ?? h.elegiveis,
      h.desenquadram ?? 0,
      Number(h.vp_total_proposto) || 0,
      h.status === "success" ? "OK" : h.status.toUpperCase(),
    ]);

    row.height = 16;
    row.eachCell((cell, colNum) => {
      const isStatus = colNum === 10;
      const isNumeric = colNum >= 5 && colNum <= 8;
      const isVP = colNum === 9;
      const isOk = String(cell.value) === "OK";

      cell.font = { size: 9, color: { argb: C.xl.text }, name: "Calibri" };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowBg } };
      cell.alignment = { vertical: "middle" };

      if (isNumeric) cell.alignment = { vertical: "middle", horizontal: "right" };
      if (isVP) {
        cell.numFmt = 'R$ #,##0';
        cell.alignment = { vertical: "middle", horizontal: "right" };
      }
      if (isStatus) {
        cell.value = isOk ? "OK" : h.status.toUpperCase();
        cell.font = { bold: true, size: 9, color: { argb: isOk ? C.xl.successText : C.xl.errorText } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: isOk ? C.xl.successBg : C.xl.errorBg } };
        cell.alignment = { vertical: "middle", horizontal: "center" };
      }
    });
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  downloadBlob(blob, `historico-cessoes-${now.toISOString().slice(0, 10)}.xlsx`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANÁLISE (Simular Cessão) — Exportação PDF
// ═══════════════════════════════════════════════════════════════════════════════

export async function exportAnalisePDF(analise: AnaliseCessao): Promise<void> {
  const logo = await loadLogo();
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 14;
  const now = new Date();

  let y = pdfDrawHeader(
    doc,
    "Análise de Elegibilidade de Cessão",
    "Evidência de Enquadramento Pré-Trade",
    logo,
  );

  // Bloco de metadados da análise
  y = pdfDrawMetaBlock(doc, [
    { label: "Data da análise",    value: fmtDate(analise.simuladoEm) },
    { label: "Hora da análise",    value: fmtTime(analise.simuladoEm) },
    { label: "Data de exportação", value: fmtDate(now) },
    { label: "Hora de exportação", value: fmtTime(now) },
    { label: "Fundo",              value: analise.fundo_nome || "—" },
    { label: "CNPJ do Fundo",      value: fmtCnpj(analise.fundo_cnpj || "") },
  ], y);

  y += 2;

  // ── Resumo da Operação ───────────────────────────────────────────────────────
  const ca = analise.carteira_atual;
  const cp = analise.cessao_proposta;
  const pf = analise.proforma;
  const recomp = analise.recompras;

  if (ca && cp && pf) {
    // Layout completo: 3 colunas (Carteira Atual | Cessão Proposta | Pró-Forma)
    y = pdfSectionTitle(doc, "RESUMO DA OPERAÇÃO", y);

    const colW = (W - M * 2 - 8) / 3;
    const cessaoItems: { label: string; value: string }[] = [
      { label: "Total DCs Propostos", value: cp.total_dcs.toLocaleString("pt-BR") },
      { label: "VP Total Proposto",   value: fmtBRL(cp.vp_total_proposto) },
      { label: "DCs Elegíveis",       value: String(cp.elegiveis) },
      { label: "DCs Inelegíveis",     value: String(cp.inelegiveis) },
      { label: "Enquadram",           value: String(cp.enquadram) },
      { label: "Desenquadram",        value: String(cp.desenquadram) },
      { label: "VP Elegíveis",        value: fmtBRL(cp.vp_elegiveis) },
    ];
    if (recomp && recomp.total > 0) {
      cessaoItems.push({ label: "Recompras (DCs)", value: String(recomp.total) });
      cessaoItems.push({ label: "VP Recompras",    value: fmtBRL(recomp.vp) });
    }
    const sections: { title: string; color: RGB; items: { label: string; value: string }[] }[] = [
      {
        title: "CARTEIRA ATUAL",
        color: C.accentGreen,
        items: [
          { label: "Estoque (data ref.)",  value: fmtDateFromRaw(ca.estoque_data_referencia) },
          { label: "Data posição (PL)",    value: fmtDateFromRaw(ca.pl_data_posicao) },
          { label: "PL considerado",       value: ca.pl > 0 ? fmtBRL(ca.pl) : "—" },
          { label: "Qtd Recebíveis",       value: ca.qtd_recebiveis.toLocaleString("pt-BR") },
          { label: "VP Total Estoque",     value: fmtBRL(ca.vp_total) },
          { label: "PDD Total",            value: fmtBRL(ca.pdd_total) },
          { label: "Prazo Médio Pond.",    value: fmtDias(ca.prazo_medio_pond) },
          { label: "% PL Alocado",         value: fmtPct(ca.perc_pl_alocado) },
        ],
      },
      {
        title: "CESSÃO PROPOSTA",
        color: [180, 130, 20],
        items: cessaoItems,
      },
      {
        title: "CARTEIRA PRÓ-FORMA",
        color: C.success,
        items: [
          { label: "Ref. PL (mesma data)", value: fmtDateFromRaw(ca.pl_data_posicao) },
          { label: "VP Total Pró-Forma",   value: fmtBRL(pf.vp_total) },
          { label: "% PL Pró-Forma",       value: fmtPct(pf.perc_pl) },
          { label: "Prazo Médio Pond.",     value: fmtDias(pf.prazo_medio_pond) },
          { label: "Espaço Livre",          value: fmtBRL(pf.espaco_livre) },
        ],
      },
    ];

    let xCursor = M;
    const maxItems = Math.max(...sections.map(s => s.items.length));

    for (const sec of sections) {
      doc.setFillColor(...sec.color);
      doc.rect(xCursor, y, colW, 7, "F");
      doc.setFontSize(6.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...C.white);
      doc.text(sec.title, xCursor + 3, y + 4.8);

      let itemY = y + 11;
      for (const item of sec.items) {
        doc.setFontSize(7);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(...C.muted);
        doc.text(item.label, xCursor + 3, itemY);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(...C.text);
        doc.text(item.value, xCursor + colW - 3, itemY, { align: "right" });
        doc.setDrawColor(...C.border);
        doc.setLineWidth(0.2);
        doc.line(xCursor + 2, itemY + 2, xCursor + colW - 2, itemY + 2);
        itemY += 6.5;
      }
      xCursor += colW + 4;
    }

    y += 7 + 4 + maxItems * 6.5 + 6;
  } else if (cp) {
    // Fallback: apenas Cessão Proposta (registros históricos sem snapshot de carteira)
    y = pdfSectionTitle(doc, "CESSÃO PROPOSTA", y);

    const cpItems: { label: string; value: string }[] = [
      { label: "Total DCs Propostos", value: cp.total_dcs.toLocaleString("pt-BR") },
      { label: "VP Total Proposto",   value: fmtBRL(cp.vp_total_proposto) },
      { label: "DCs Elegíveis",       value: String(cp.elegiveis) },
      { label: "DCs Inelegíveis",     value: String(cp.inelegiveis) },
      { label: "Enquadram",           value: String(cp.enquadram) },
      { label: "Desenquadram",        value: String(cp.desenquadram) },
      { label: "VP Elegíveis",        value: fmtBRL(cp.vp_elegiveis) },
    ];

    const blockColor: RGB = [180, 130, 20];
    const colW = (W - M * 2) / 2;
    doc.setFillColor(...blockColor);
    doc.rect(M, y, W - M * 2, 7, "F");
    doc.setFontSize(6.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...C.white);
    doc.text("CESSÃO PROPOSTA", M + 3, y + 4.8);

    let itemY = y + 11;
    for (let i = 0; i < cpItems.length; i++) {
      const item = cpItems[i];
      const col = i % 2 === 0 ? 0 : 1;
      const xItem = M + col * (colW + 4);
      doc.setFontSize(7);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...C.muted);
      doc.text(item.label, xItem + 3, itemY);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...C.text);
      doc.text(item.value, xItem + colW - 3, itemY, { align: "right" });
      doc.setDrawColor(...C.border);
      doc.setLineWidth(0.2);
      doc.line(xItem + 2, itemY + 2, xItem + colW - 2, itemY + 2);
      if (i % 2 === 1 || i === cpItems.length - 1) itemY += 6.5;
    }

    y += 7 + 4 + Math.ceil(cpItems.length / 2) * 6.5 + 6;
  }

  // ── Verificação de Regras Pré-Trade ─────────────────────────────────────────
  if (analise.regras_checklist && analise.regras_checklist.length > 0) {
    if (y > 215) { doc.addPage(); y = 20; }
    y = pdfSectionTitle(doc, `VERIFICAÇÃO DE REGRAS PRÉ-TRADE (${analise.regras_checklist.length} regras)`, y);

    autoTable(doc, {
      startY: y,
      head: [["Regra de Cessao", "Modo", "Valor Atual", "Limite", "Rejeicoes", "Status"]],
      body: analise.regras_checklist.map(rc => [
        sanitizePdfText(rc.regra_descricao),
        rc.modo === "individual" ? "Individual" : rc.modo === "proforma" ? "Pro-forma" : "Concentracao",
        sanitizePdfText(rc.valor_atual || "—"),
        sanitizePdfText(rc.valor_limite || "—"),
        `${rc.rejeicoes} / ${rc.total_dcs}`,
        rc.status === "ok" ? "OK" : rc.rejeicoes === 0 ? "ATENCAO" : "VIOLACAO",
      ]),
      styles: {
        fontSize: 7,
        cellPadding: 2.4,
        textColor: C.text,
        lineColor: C.border,
        lineWidth: 0.2,
        overflow: "linebreak",
        minCellHeight: 9,
      },
      headStyles: {
        fillColor: C.headerBg,
        textColor: C.white,
        fontStyle: "bold",
        fontSize: 7,
        minCellHeight: 9,
      },
      alternateRowStyles: { fillColor: C.rowAlt },
      columnStyles: {
        0: { cellWidth: 74 },
        1: { cellWidth: 22, halign: "center" },
        2: { cellWidth: 32, halign: "right" },
        3: { cellWidth: 24, halign: "right" },
        4: { cellWidth: 14, halign: "center" },
        5: { cellWidth: 16, halign: "center" },
      },
      didDrawCell: (data) => {
        if (data.section === "body" && data.column.index === 5) {
          const val = String(data.cell.raw);
          const isOk      = val === "OK";
          const isAtencao = val === "ATENCAO";
          const bgColor  = isOk ? C.successBg : isAtencao ? C.warningBg : C.errorBg;
          const txtColor = isOk ? C.success   : isAtencao ? C.warning   : C.error;
          const label    = isOk ? "OK" : isAtencao ? "ATENCAO" : "VIOLACAO";
          doc.setFillColor(...bgColor);
          doc.rect(data.cell.x, data.cell.y, data.cell.width, data.cell.height, "F");
          doc.setFontSize(6.5);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(...txtColor);
          doc.text(
            label,
            data.cell.x + data.cell.width / 2,
            data.cell.y + data.cell.height / 2 + 1,
            { align: "center" },
          );
        }
      },
      margin: { left: M, right: M },
    });

    y = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY) + 8;
  }

  // ── Detalhe do Calculo por Regra — somente regras com violacao ou atencao ────
  const regrasComDetalhe = (analise.regras_checklist || []).filter(rc =>
    rc.status !== "ok" && (
      (rc.breakdown && rc.breakdown.length > 0) ||
      (rc.detalhes_dcs && rc.detalhes_dcs.length > 0)
    ),
  );

  if (regrasComDetalhe.length > 0) {
    if (y > 220) { doc.addPage(); y = 20; }
    y = pdfSectionTitle(doc, "DETALHE DO CALCULO POR REGRA", y);
    y += 4;

    for (const rc of regrasComDetalhe) {
      if (y > 250) { doc.addPage(); y = 20; }

      // ── Card de cabecalho da regra ────────────────────────────────────────
      const isVio = rc.status === "violacao";
      const accentRgb: RGB = isVio ? [185, 28, 28] as RGB : [4, 120, 87] as RGB;
      const bgRgb: RGB     = isVio ? [255, 245, 245] as RGB : [245, 253, 249] as RGB;

      const codeStr  = sanitizePdfText(rc.regra_codigo);
      const descStr  = sanitizePdfText(rc.regra_descricao);
      const descLines = doc.splitTextToSize(descStr, W - M * 2 - 14);
      const cardH = Math.max(13, 6 + descLines.length * 5 + 3);

      // Fundo do card
      doc.setFillColor(...bgRgb);
      doc.rect(M, y, W - M * 2, cardH, "F");
      // Borda esquerda colorida (3px)
      doc.setFillColor(...accentRgb);
      doc.rect(M, y, 3, cardH, "F");
      // Borda externa fina
      doc.setDrawColor(...accentRgb);
      doc.setLineWidth(0.2);
      doc.rect(M, y, W - M * 2, cardH, "S");

      // Codigo da regra (pequeno, colorido)
      doc.setFontSize(6);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...accentRgb);
      doc.text(codeStr, M + 6, y + 4.5);

      // Badge de status (direita)
      const badgeLabel = isVio ? "VIOLACAO" : "OK";
      const badgeW = isVio ? 24 : 14;
      const badgeX = W - M - badgeW - 2;
      const badgeY = y + 2;
      doc.setFillColor(...accentRgb);
      doc.rect(badgeX, badgeY, badgeW, 5.5, "F");
      doc.setFontSize(6.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...C.white);
      doc.text(badgeLabel, badgeX + badgeW / 2, badgeY + 3.6, { align: "center" });

      // Descricao (bold, escuro)
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...C.text);
      let lineY = y + 4.5 + 5;
      for (const line of descLines) {
        doc.text(line, M + 6, lineY);
        lineY += 5;
      }

      y += cardH + 2;

      // ── Composicao do Pro-Forma (linhas tipo "resumo") ──────────────────
      const resumoRows = (rc.breakdown || []).filter(b => b.tipo_linha === "resumo");
      if (resumoRows.length > 0) {
        if (y > 258) { doc.addPage(); y = 20; }

        doc.setFontSize(7);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(...C.muted);
        doc.text("Composicao do Pro-Forma", M + 2, y + 3.5);
        y += 6;

        autoTable(doc, {
          startY: y,
          head: [["Linha", "Estoque FIDC (R$)", "CSV Importado (R$)", "Total (R$)", "% PL", "Limite", "Status"]],
          body: resumoRows.map(b => [
            sanitizePdfText(b.label),
            fmtBRL(b.estoque_rs ?? 0),
            fmtBRL(b.proposto_rs ?? 0),
            fmtBRL(b.total_rs ?? 0),
            sanitizePdfText(b.valor_atual_texto ?? fmtPct(b.pct_pl ?? 0)),
            sanitizePdfText(b.limite_texto ?? (b.limite_pct_pl != null ? `${b.limite_pct_pl.toFixed(2)}%` : "---")),
            b.status === "ok" ? "OK" : "Violacao",
          ]),
          styles: {
            fontSize: 7, cellPadding: 2.4, textColor: C.text,
            lineColor: C.border, lineWidth: 0.2, overflow: "linebreak", minCellHeight: 9,
          },
          headStyles: {
            fillColor: C.headerBg, textColor: C.white, fontStyle: "bold",
            fontSize: 7, minCellHeight: 9,
          },
          alternateRowStyles: { fillColor: C.rowAlt },
          columnStyles: {
            0: { cellWidth: "auto", fontStyle: "bold" },
            1: { cellWidth: 30, halign: "right" },
            2: { cellWidth: 32, halign: "right" },
            3: { cellWidth: 28, halign: "right" },
            4: { cellWidth: 20, halign: "right" },
            5: { cellWidth: 20, halign: "right" },
            6: { cellWidth: 16, halign: "center", fontStyle: "bold" },
          },
          didDrawCell: (data) => {
            if (data.section === "body" && data.column.index === 6) {
              const row = resumoRows[data.row.index];
              if (!row) return;
              const isOk = row.status === "ok";
              doc.setFillColor(...(isOk ? C.successBg : C.errorBg));
              doc.rect(data.cell.x, data.cell.y, data.cell.width, data.cell.height, "F");
              doc.setFontSize(6.5);
              doc.setFont("helvetica", "bold");
              doc.setTextColor(...(isOk ? C.success : C.error));
              doc.text(
                isOk ? "OK" : "Violacao",
                data.cell.x + data.cell.width / 2,
                data.cell.y + data.cell.height / 2 + 1,
                { align: "center" },
              );
            }
          },
          margin: { left: M, right: M },
        });
        y = ((doc as any).lastAutoTable.finalY as number) + 4;
      }

      // ── Cedentes / Sacados — Exposicao Pro-Forma ────────────────────────
      const cedenteRows = (rc.breakdown || []).filter(b =>
        (b.tipo_item === "cedente" || b.tipo_item === "sacado") && b.tipo_linha !== "resumo",
      );
      if (cedenteRows.length > 0) {
        if (y > 258) { doc.addPage(); y = 20; }
        const tipoCp = cedenteRows[0].tipo_item === "cedente" ? "Cedentes" : "Sacados";

        doc.setFontSize(7);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(...C.muted);
        doc.text(`${tipoCp} - Exposicao Pro-Forma (Estoque + Cessao Elegivel)`, M + 2, y + 3.5);
        y += 6;

        autoTable(doc, {
          startY: y,
          head: [[tipoCp, "Documento", "Estoque (R$)", "CSV Importado (R$)", "Total (R$)", "% PL", "Limite", "Status"]],
          body: cedenteRows.map(b => [
            sanitizePdfText(b.label),
            b.doc || "---",
            fmtBRL(b.estoque_rs ?? 0),
            fmtBRL(b.proposto_rs ?? 0),
            fmtBRL(b.total_rs ?? 0),
            fmtPct(b.pct_pl ?? 0),
            b.limite_pct_pl != null ? `${b.limite_pct_pl.toFixed(2)}%` : "---",
            b.status === "ok" ? "OK" : "Violacao",
          ]),
          styles: {
            fontSize: 7, cellPadding: 2.4, textColor: C.text,
            lineColor: C.border, lineWidth: 0.2, overflow: "ellipsize", minCellHeight: 9,
          },
          headStyles: {
            fillColor: C.headerBg, textColor: C.white, fontStyle: "bold",
            fontSize: 7, minCellHeight: 9,
          },
          alternateRowStyles: { fillColor: C.rowAlt },
          columnStyles: {
            0: { cellWidth: "auto", fontStyle: "bold" },
            1: { cellWidth: 30, fontSize: 6 },
            2: { cellWidth: 24, halign: "right" },
            3: { cellWidth: 26, halign: "right" },
            4: { cellWidth: 24, halign: "right" },
            5: { cellWidth: 16, halign: "right", fontStyle: "bold" },
            6: { cellWidth: 16, halign: "right" },
            7: { cellWidth: 16, halign: "center", fontStyle: "bold" },
          },
          didParseCell: (data) => {
            if (data.section === "body" && data.column.index === 5) {
              const row = cedenteRows[data.row.index];
              if (!row) return;
              data.cell.styles.textColor = row.status === "violacao" ? C.error : C.success;
            }
          },
          didDrawCell: (data) => {
            if (data.section === "body" && data.column.index === 7) {
              const row = cedenteRows[data.row.index];
              if (!row) return;
              const isOk = row.status === "ok";
              doc.setFillColor(...(isOk ? C.successBg : C.errorBg));
              doc.rect(data.cell.x, data.cell.y, data.cell.width, data.cell.height, "F");
              doc.setFontSize(6.5);
              doc.setFont("helvetica", "bold");
              doc.setTextColor(...(isOk ? C.success : C.error));
              doc.text(isOk ? "OK" : "Violacao", data.cell.x + data.cell.width / 2, data.cell.y + data.cell.height / 2 + 1, { align: "center" });
            }
          },
          margin: { left: M, right: M },
        });
        y = ((doc as any).lastAutoTable.finalY as number) + 4;
      }

      // ── DCs com violacao (detalhes_dcs) ─────────────────────────────────
      if (rc.detalhes_dcs && rc.detalhes_dcs.length > 0) {
        if (y > 258) { doc.addPage(); y = 20; }

        doc.setFontSize(7);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(...C.muted);
        doc.text(`DCs com Violacao — Detalhe (${rc.detalhes_dcs.length})`, M + 2, y + 3.5);
        y += 6;

        autoTable(doc, {
          startY: y,
          head: [["Numero Documento", "Cedente", "Sacado", "Valor Pago (R$)", "Prazo", "Valor Atual", "Limite"]],
          body: rc.detalhes_dcs.map(d => [
            d.ds_seu_numero || "---",
            sanitizePdfText(d.nm_cedente || "---"),
            sanitizePdfText(d.nm_sacado || "---"),
            fmtBRL(d.vl_pago ?? 0),
            d.prazo != null ? `${d.prazo} du` : "---",
            d.valor_atual != null ? sanitizePdfText(String(d.valor_atual)) : "---",
            d.valor_limite != null ? sanitizePdfText(String(d.valor_limite)) : "---",
          ]),
          styles: {
            fontSize: 7, cellPadding: 2.4, textColor: C.text,
            lineColor: C.border, lineWidth: 0.2, overflow: "ellipsize", minCellHeight: 9,
          },
          headStyles: {
            fillColor: [140, 20, 20] as RGB, textColor: C.white, fontStyle: "bold",
            fontSize: 7, minCellHeight: 9,
          },
          alternateRowStyles: { fillColor: [255, 249, 249] as RGB },
          columnStyles: {
            0: { cellWidth: 32, fontSize: 6 },
            1: { cellWidth: "auto", overflow: "ellipsize" },
            2: { cellWidth: "auto", overflow: "ellipsize" },
            3: { cellWidth: 26, halign: "right" },
            4: { cellWidth: 15, halign: "center" },
            5: { cellWidth: 22, halign: "right", fontStyle: "bold", textColor: C.error },
            6: { cellWidth: 18, halign: "right" },
          },
          margin: { left: M, right: M },
        });
        y = ((doc as any).lastAutoTable.finalY as number) + 4;
      }

      // Separador fino entre regras (exceto na ultima)
      if (rc !== regrasComDetalhe[regrasComDetalhe.length - 1]) {
        y += 1;
        doc.setDrawColor(...C.border);
        doc.setLineWidth(0.3);
        doc.line(M + 10, y, W - M - 10, y);
        y += 4;
      }
    }
    y += 3;
  }

  // ── Detalhamento por DC ───────────────────────────────────────────────────
  if (analise.resultados && analise.resultados.length > 0) {
    if (y > 215) { doc.addPage(); y = 20; }
    y = pdfSectionTitle(doc, `DETALHAMENTO POR DC (${analise.resultados.length} titulos)`, y);

    autoTable(doc, {
      startY: y,
      head: [["Cedente", "Sacado", "Valor Pago (R$)", "Prazo", "Elegivel", "Enquadra", "Motivos de Rejeicao"]],
      body: analise.resultados.map(dc => [
        sanitizePdfText(dc.nm_cedente || "---"),
        sanitizePdfText(dc.nm_sacado),
        fmtBRL(dc.vl_pago),
        `${dc.prazo} du`,
        dc.tipo_operacao === "RECOMPRA" ? "RECOMPRA" : dc.elegivel ? "Sim" : "Nao",
        dc.tipo_operacao === "RECOMPRA" ? "---" : dc.enquadra === true ? "Sim" : dc.elegivel ? "Nao" : "---",
        dc.tipo_operacao === "RECOMPRA" ? "Recompra — nao avaliada" : dc.motivos.map(m => sanitizePdfText(m.regra_descricao)).join("; ") || "---",
      ]),
      styles: {
        fontSize: 7,
        cellPadding: 2.4,
        textColor: C.text,
        lineColor: C.border,
        lineWidth: 0.2,
        overflow: "linebreak",
        minCellHeight: 9,
      },
      headStyles: {
        fillColor: C.headerBg,
        textColor: C.white,
        fontStyle: "bold",
        fontSize: 7,
        minCellHeight: 9,
      },
      alternateRowStyles: { fillColor: C.rowAlt },
      columnStyles: {
        0: { cellWidth: 38 },
        1: { cellWidth: 38 },
        2: { cellWidth: 24, halign: "right" },
        3: { cellWidth: 14, halign: "center" },
        4: { cellWidth: 14, halign: "center" },
        5: { cellWidth: 14, halign: "center" },
        6: { cellWidth: "auto" },
      },
      didParseCell: (data) => {
        if (data.section === "body" && (data.column.index === 4 || data.column.index === 5)) {
          const val = String(data.cell.raw);
          if (val === "---") return;
          const isSim = val === "Sim";
          data.cell.styles.textColor = isSim ? C.success : C.error;
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.halign = "center";
        }
      },
      margin: { left: M, right: M },
    });
  }

  pdfFooter(doc, now);
  const ts = analise.simuladoEm.toISOString().slice(0, 19).replace(/[T:]/g, "-");
  doc.save(`analise-cessao-${ts}.pdf`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANÁLISE (Simular Cessão) — Exportação Excel (redesign executivo)
// ═══════════════════════════════════════════════════════════════════════════════

export async function exportAnaliseExcel(analise: AnaliseCessao): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Frame Control Center";
  wb.created = new Date();
  wb.properties.date1904 = false;
  const now = new Date();

  // ── Paleta de cores ARGB (prefixo FF = opaco) ─────────────────────────────
  const XL = {
    verdeEscuro:   "FF1A3A2A",
    verdeMedio:    "FF2D5A3D",
    verdeClaro:    "FFE8F5EC",
    laranja:       "FFE8A020",
    vermelho:      "FFC0392B",
    vermelhoBg:    "FFFDEAEA",
    cinzaHeader:   "FF4A4A4A",
    cinzaBg:       "FFF5F5F5",
    azulBreakdown: "FFEAF0FB",
    subHeader:     "FFE8EAED",
    colBreakdown:  "FF6B7B8D",
    dcViolacao:    "FF8B1A1A",
    branco:        "FFFFFFFF",
    texto:         "FF1A1A1A",
    textoMuted:    "FF6B7280",
    border:        "FFCCCCCC",
    atencaoBg:     "FFFEF3C7",
    atencaoTxt:    "FF92400E",
  } as const;

  const thin = (argb: string) => ({ style: "thin" as const, color: { argb } });
  const applyBorder = (cell: ExcelJS.Cell) => {
    cell.border = { top: thin(XL.border), left: thin(XL.border), bottom: thin(XL.border), right: thin(XL.border) };
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Aba 1 — Resumo da Operação (3 blocos lado a lado)
  // ═══════════════════════════════════════════════════════════════════════════
  const wsR = wb.addWorksheet("Resumo da Operação", { views: [{ state: "frozen", ySplit: 4 }] });
  // A:B=bloco1  C=spacer  D:E=bloco2  F=spacer  G:H=bloco3
  wsR.columns = [
    { width: 26 }, { width: 18 }, { width: 3 },
    { width: 26 }, { width: 18 }, { width: 3 },
    { width: 26 }, { width: 18 },
  ];

  // Linha 1 — título
  wsR.mergeCells("A1:H1");
  wsR.getRow(1).height = 30;
  Object.assign(wsR.getCell("A1"), {
    value: "FRAME CONTROL CENTER — Análise de Elegibilidade de Cessão",
    font: { bold: true, size: 12, name: "Calibri", color: { argb: XL.branco } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: XL.verdeEscuro } },
    alignment: { vertical: "middle", horizontal: "left", indent: 1 },
  });

  // Linha 2 — subtítulo
  wsR.mergeCells("A2:H2");
  wsR.getRow(2).height = 18;
  Object.assign(wsR.getCell("A2"), {
    value: "Evidência de Enquadramento Pré-Trade",
    font: { size: 10, name: "Calibri", color: { argb: XL.branco }, italic: true },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: XL.verdeMedio } },
    alignment: { vertical: "middle", horizontal: "left", indent: 1 },
  });

  // Linha 3 — metadados
  wsR.mergeCells("A3:H3");
  wsR.getRow(3).height = 16;
  Object.assign(wsR.getCell("A3"), {
    value: `Análise: ${fmtDate(analise.simuladoEm)} às ${fmtTime(analise.simuladoEm)}  |  Exportado: ${fmtDate(now)} às ${fmtTime(now)}  |  Fundo: ${analise.fundo_nome || "—"}  |  CNPJ: ${fmtCnpj(analise.fundo_cnpj || "")}`,
    font: { size: 8, name: "Calibri", color: { argb: XL.textoMuted }, italic: true },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: XL.cinzaBg } },
    alignment: { vertical: "middle", indent: 1 },
  });

  // Linha 4 — spacer
  wsR.getRow(4).height = 8;

  // Linha 5 — headers dos 3 blocos
  wsR.getRow(5).height = 22;
  const applyBlockHdr = (col1: string, col2: string, label: string, bg: string) => {
    wsR.mergeCells(`${col1}5:${col2}5`);
    Object.assign(wsR.getCell(`${col1}5`), {
      value: label,
      font: { bold: true, size: 10, name: "Calibri", color: { argb: XL.branco } },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: bg } },
      alignment: { vertical: "middle", horizontal: "center" },
    });
  };
  applyBlockHdr("A", "B", "CARTEIRA ATUAL",       XL.verdeMedio);
  applyBlockHdr("D", "E", "CESSÃO PROPOSTA",       XL.laranja);
  applyBlockHdr("G", "H", "CARTEIRA PRÓ-FORMA",    XL.verdeEscuro);

  // Helper: preencher uma célula label+valor de bloco
  const setBlockCell = (
    rowN: number, colL: string, colV: string,
    label: string, value: ExcelJS.CellValue,
    numFmt?: string, isAlt = false,
  ) => {
    const bg = isAlt ? XL.cinzaBg : XL.branco;
    wsR.getRow(rowN).height = 18;
    const lc = wsR.getCell(`${colL}${rowN}`);
    lc.value = label;
    lc.font = { size: 9, name: "Calibri", color: { argb: XL.textoMuted } };
    lc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
    lc.alignment = { vertical: "middle", indent: 1 };
    applyBorder(lc);
    const vc = wsR.getCell(`${colV}${rowN}`);
    vc.value = value;
    vc.font = { bold: true, size: 9, name: "Calibri", color: { argb: XL.texto } };
    vc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
    vc.alignment = { vertical: "middle", horizontal: "right" };
    if (numFmt) vc.numFmt = numFmt;
    applyBorder(vc);
  };

  const ca = analise.carteira_atual;
  const cp = analise.cessao_proposta;
  const pf = analise.proforma;
  const recomp = analise.recompras;

  // Bloco 1 — Carteira Atual (linhas 6-13)
  if (ca) {
    const b1: [string, ExcelJS.CellValue, string?][] = [
      ["Estoque (data ref.)", fmtDateFromRaw(ca.estoque_data_referencia)],
      ["Data posição (PL)",   fmtDateFromRaw(ca.pl_data_posicao)],
      ["PL considerado",      ca.pl > 0 ? ca.pl : 0,         '"R$ "#,##0'],
      ["Qtd Recebíveis",      ca.qtd_recebiveis,              "#,##0"],
      ["VP Total Estoque",    ca.vp_total,                    '"R$ "#,##0'],
      ["PDD Total",           ca.pdd_total,                   '"R$ "#,##0'],
      ["Prazo Médio Pond.",   `${Math.round(ca.prazo_medio_pond)} dias`],
      ["% PL Alocado",        ca.perc_pl_alocado / 100,      "0.00%"],
    ];
    b1.forEach(([l, v, f], idx) => setBlockCell(6 + idx, "A", "B", l, v, f, idx % 2 === 1));
  }

  // Bloco 2 — Cessão Proposta (linhas 6-13, 7-9 dados + padded)
  if (cp) {
    const b2: [string, ExcelJS.CellValue, string?][] = [
      ["Total DCs Propostos", cp.total_dcs,            "#,##0"],
      ["VP Total Proposto",   cp.vp_total_proposto,    '"R$ "#,##0'],
      ["DCs Elegíveis",       cp.elegiveis,            "#,##0"],
      ["DCs Inelegíveis",     cp.inelegiveis,          "#,##0"],
      ["Enquadram",           cp.enquadram,            "#,##0"],
      ["Desenquadram",        cp.desenquadram,         "#,##0"],
      ["VP Elegíveis",        cp.vp_elegiveis,         '"R$ "#,##0'],
    ];
    if (recomp && recomp.total > 0) {
      b2.push(["Recompras (DCs)", recomp.total, "#,##0"]);
      b2.push(["VP Recompras",    recomp.vp,    '"R$ "#,##0']);
    } else {
      b2.push(["", ""]);
    }
    b2.forEach(([l, v, f], idx) => setBlockCell(6 + idx, "D", "E", l, v, f, idx % 2 === 1));
  }

  // Bloco 3 — Carteira Pró-Forma (linhas 6-13, 5 dados + 3 vazios)
  if (pf) {
    const b3: [string, ExcelJS.CellValue, string?][] = [
      ["Ref. PL (data ref.)", fmtDateFromRaw(ca?.pl_data_posicao)],
      ["VP Total Pró-Forma",  pf.vp_total,             '"R$ "#,##0'],
      ["% PL Pró-Forma",      pf.perc_pl / 100,        "0.00%"],
      ["Prazo Médio Pond.",   `${Math.round(pf.prazo_medio_pond)} dias`],
      ["Espaço Livre",        pf.espaco_livre,         '"R$ "#,##0'],
      ["", ""], ["", ""], ["", ""],
    ];
    b3.forEach(([l, v, f], idx) => setBlockCell(6 + idx, "G", "H", l, v, f, idx % 2 === 1));
  }

  // Linha 14 — spacer
  wsR.getRow(14).height = 10;

  // Linha 15 — RESULTADO DA ANÁLISE
  wsR.mergeCells("A15:H15");
  wsR.getRow(15).height = 26;
  Object.assign(wsR.getCell("A15"), {
    value: "RESULTADO DA ANÁLISE DE ENQUADRAMENTO",
    font: { bold: true, size: 11, name: "Calibri", color: { argb: XL.branco } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: XL.verdeEscuro } },
    alignment: { vertical: "middle", horizontal: "left", indent: 1 },
  });

  // Linha 16 — cabeçalhos resultado
  wsR.getRow(16).height = 22;
  const resColLetters = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
  ["Regras Verificadas", "OK", "VIOLAÇÃO", "Total DCs", "Elegíveis", "Inelegíveis", "Enquadram", "Desenquadram"]
    .forEach((label, i) => {
      const cell = wsR.getCell(`${resColLetters[i]}16`);
      cell.value = label;
      cell.font = { bold: true, size: 9, name: "Calibri", color: { argb: XL.branco } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XL.cinzaHeader } };
      cell.alignment = { vertical: "middle", horizontal: "center" };
      applyBorder(cell);
    });

  // Linha 17 — valores resultado
  const totalRegras = analise.regras_checklist?.length ?? 0;
  const regrasOk    = analise.regras_checklist?.filter(r => r.status === "ok").length ?? 0;
  const regrasVio   = totalRegras - regrasOk;
  wsR.getRow(17).height = 26;
  const resData: [ExcelJS.CellValue, string, string][] = [
    [totalRegras,          XL.cinzaBg,   XL.texto],
    [regrasOk,             XL.verdeClaro, XL.verdeMedio],
    [regrasVio,            XL.vermelhoBg, XL.vermelho],
    [cp?.total_dcs ?? 0,      XL.cinzaBg, XL.texto],
    [cp?.elegiveis ?? 0,       XL.cinzaBg, XL.texto],
    [cp?.inelegiveis ?? 0,     XL.cinzaBg, XL.texto],
    [cp?.enquadram ?? 0,       XL.cinzaBg, XL.texto],
    [cp?.desenquadram ?? 0,    XL.cinzaBg, XL.texto],
  ];
  resData.forEach(([val, bg, txt], i) => {
    const cell = wsR.getCell(`${resColLetters[i]}17`);
    cell.value = val;
    cell.numFmt = "#,##0";
    cell.font = { bold: true, size: 13, name: "Calibri", color: { argb: txt } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    applyBorder(cell);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Aba 2 — Regras Pré-Trade (hierarquia com breakdown)
  // ═══════════════════════════════════════════════════════════════════════════
  if (analise.regras_checklist && analise.regras_checklist.length > 0) {
    const wsReg = wb.addWorksheet("Regras Pré-Trade", { views: [{ state: "frozen", ySplit: 4 }] });
    wsReg.columns = [
      { width: 46 }, // A - descrição
      { width: 28 }, // B - código
      { width: 18 }, // C - modo
      { width: 30 }, // D - valor atual
      { width: 28 }, // E - limite
      { width: 14 }, // F - rejeições
      { width: 12 }, // G - status
    ];

    // Linha 1
    wsReg.mergeCells("A1:G1");
    wsReg.getRow(1).height = 30;
    Object.assign(wsReg.getCell("A1"), {
      value: "VERIFICAÇÃO DE REGRAS PRÉ-TRADE — Elegibilidade de Cessão",
      font: { bold: true, size: 12, name: "Calibri", color: { argb: XL.branco } },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: XL.verdeEscuro } },
      alignment: { vertical: "middle", horizontal: "left", indent: 1 },
    });

    // Linha 2
    wsReg.mergeCells("A2:G2");
    wsReg.getRow(2).height = 16;
    Object.assign(wsReg.getCell("A2"), {
      value: `Fundo: ${analise.fundo_nome || fmtCnpj(analise.fundo_cnpj || "")}  |  Análise: ${fmtDate(analise.simuladoEm)} às ${fmtTime(analise.simuladoEm)}`,
      font: { size: 9, name: "Calibri", color: { argb: XL.branco }, italic: true },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: XL.verdeMedio } },
      alignment: { vertical: "middle", indent: 1 },
    });

    // Linha 3 — spacer
    wsReg.getRow(3).height = 6;

    // Linha 4 — cabeçalhos
    const rHdr = wsReg.addRow(["Regra de Cessão", "Código", "Modo", "Valor Atual", "Limite", "Rejeições", "Status"]);
    rHdr.height = 22;
    rHdr.eachCell((cell, cn) => {
      if (cn > 7) return;
      cell.font = { bold: true, size: 9, name: "Calibri", color: { argb: XL.branco } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XL.cinzaHeader } };
      cell.alignment = { vertical: "middle", horizontal: cn === 1 ? "left" : "center", indent: cn === 1 ? 1 : 0 };
      applyBorder(cell);
    });

    analise.regras_checklist.forEach((rc, i) => {
      const isAlt  = i % 2 === 1;
      const rowBg  = isAlt ? XL.cinzaBg : XL.branco;
      const isOk   = rc.status === "ok";
      const isVio  = rc.status === "violacao" && rc.rejeicoes > 0;
      const statusLabel = isOk ? "OK" : isVio ? "VIOLAÇÃO" : "ATENÇÃO";

      // ── Linha principal da regra ──────────────────────────────────────────
      const mainRow = wsReg.addRow([
        rc.regra_descricao,
        rc.regra_codigo,
        rc.modo === "individual" ? "Individual" : rc.modo === "proforma" ? "Pro-forma" : "Concentração",
        rc.valor_atual || "—",
        rc.valor_limite || "—",
        `${rc.rejeicoes} / ${rc.total_dcs}`,
        statusLabel,
      ]);
      mainRow.height = 32;
      mainRow.eachCell((cell, cn) => {
        if (cn > 7) return;
        cell.font = { size: 9, name: "Calibri", color: { argb: XL.texto } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowBg } };
        cell.alignment = { vertical: "middle" };
        applyBorder(cell);
        if (cn === 1) cell.alignment = { vertical: "middle", wrapText: true, indent: 1 };
        if (cn === 4 || cn === 5) cell.alignment = { vertical: "middle", horizontal: "right", wrapText: true };
        if (cn === 6) cell.alignment = { vertical: "middle", horizontal: "center" };
        if (cn === 7) {
          const txtColor = isOk ? XL.verdeMedio : isVio ? XL.vermelho : XL.atencaoTxt;
          const bgColor  = isOk ? XL.verdeClaro  : isVio ? XL.vermelhoBg : XL.atencaoBg;
          cell.font = { bold: true, size: 9, name: "Calibri", color: { argb: txtColor } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
          cell.alignment = { vertical: "middle", horizontal: "center" };
        }
      });

      // ── Helpers internos de breakdown ─────────────────────────────────────
      const addBdSecHeader = (text: string) => {
        const r = wsReg.addRow([text]);
        r.height = 16;
        wsReg.mergeCells(`A${r.number}:G${r.number}`);
        const cell = wsReg.getCell(`A${r.number}`);
        cell.value = text;
        cell.font = { bold: true, size: 8, name: "Calibri", color: { argb: "FF444444" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XL.subHeader } };
        cell.alignment = { vertical: "middle", indent: 2 };
      };

      const addBdColHeader = (cols: string[], bgArgb: string = XL.colBreakdown) => {
        const r = wsReg.addRow(cols);
        r.height = 18;
        r.eachCell((cell, cn) => {
          if (cn > cols.length) return;
          cell.font = { bold: true, size: 8, name: "Calibri", color: { argb: XL.branco } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };
          cell.alignment = { vertical: "middle", horizontal: cn === 1 ? "left" : "center", indent: cn === 1 ? 2 : 0 };
          applyBorder(cell);
        });
      };

      const addBdDataRow = (
        cols: (string | number)[],
        statusVal: "ok" | "violacao",
        fmts: (string | null)[] = [],
      ) => {
        const r = wsReg.addRow(cols);
        r.height = 22;
        const bgRow = statusVal === "ok" ? XL.azulBreakdown : XL.vermelhoBg;
        r.eachCell((cell, cn) => {
          if (cn > cols.length) return;
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgRow } };
          cell.font = { size: 8, name: "Calibri", color: { argb: XL.texto } };
          cell.alignment = { vertical: "middle" };
          applyBorder(cell);
          const fmt = fmts[cn - 1];
          if (fmt) cell.numFmt = fmt;
          if (cn === 1) {
            cell.font = { bold: true, size: 8, name: "Calibri", color: { argb: XL.texto } };
            cell.alignment = { vertical: "middle", indent: 2 };
          }
          if (cn >= 2 && cn <= 6) cell.alignment = { vertical: "middle", horizontal: "right" };
          if (cn === 7) {
            const isOkRow = statusVal === "ok";
            cell.font = { bold: true, size: 8, name: "Calibri", color: { argb: isOkRow ? XL.verdeMedio : XL.vermelho } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: isOkRow ? XL.verdeClaro : XL.vermelhoBg } };
            cell.alignment = { vertical: "middle", horizontal: "center" };
          }
        });
      };

      // ── Composição pró-forma (linhas resumo) ──────────────────────────────
      const resumoRows = (rc.breakdown || []).filter(b => b.tipo_linha === "resumo");
      if (resumoRows.length > 0) {
        const isPrazo = resumoRows.some(b => b.valor_atual_texto != null && String(b.valor_atual_texto).includes("du"));
        addBdSecHeader("COMPOSIÇÃO DO PRÓ-FORMA");
        addBdColHeader([
          "Linha",
          isPrazo ? "Prazo Atual (du)" : "% Atual",
          isPrazo ? "Limite" : "% Limite",
          "Estoque FIDC (R$)", "CSV Importado (R$)", "Total (R$)", "Status",
        ]);
        for (const b of resumoRows) {
          const pctVal = b.pct_pl != null ? b.pct_pl / 100 : (b.valor_atual_texto ?? "");
          const limVal = b.limite_pct_pl != null ? b.limite_pct_pl / 100 : (b.limite_texto ?? "");
          addBdDataRow(
            [b.label, pctVal, limVal, b.estoque_rs ?? 0, b.proposto_rs ?? 0, b.total_rs ?? 0, b.status === "ok" ? "OK" : "VIOLAÇÃO"],
            b.status,
            [null, typeof pctVal === "number" ? "0.00%" : null, typeof limVal === "number" ? "0.00%" : null, '"R$ "#,##0', '"R$ "#,##0', '"R$ "#,##0', null],
          );
        }
      }

      // ── Cedentes / Sacados ────────────────────────────────────────────────
      const cedenteRows = (rc.breakdown || []).filter(b =>
        (b.tipo_item === "cedente" || b.tipo_item === "sacado") && b.tipo_linha !== "resumo",
      );
      if (cedenteRows.length > 0) {
        const tipoCp = cedenteRows[0].tipo_item === "cedente" ? "Cedentes" : "Sacados";
        const isTaxa = cedenteRows.some(b => b.valor_atual_texto != null && String(b.valor_atual_texto).toLowerCase().includes("a.a."));
        addBdSecHeader(`${tipoCp.toUpperCase()} — EXPOSIÇÃO PRÓ-FORMA (ESTOQUE + CESSÃO ELEGÍVEL)`);
        addBdColHeader([
          `${tipoCp} / Doc`,
          isTaxa ? "Taxa Declarada" : "% Atual",
          isTaxa ? "Taxa Limite (140% CDI)" : "% Limite",
          "Estoque FIDC (R$)", "CSV Importado (R$)", "Total (R$)", "Status",
        ]);
        for (const b of cedenteRows) {
          const pctVal = b.pct_pl != null ? b.pct_pl / 100 : (b.valor_atual_texto ?? "");
          const limVal = b.limite_pct_pl != null ? b.limite_pct_pl / 100 : (b.limite_texto ?? "");
          addBdDataRow(
            [b.label, pctVal, limVal, b.estoque_rs ?? 0, b.proposto_rs ?? 0, b.total_rs ?? 0, b.status === "ok" ? "OK" : "VIOLAÇÃO"],
            b.status,
            [null, typeof pctVal === "number" ? "0.00%" : null, typeof limVal === "number" ? "0.00%" : null, '"R$ "#,##0', '"R$ "#,##0', '"R$ "#,##0', null],
          );
        }
      }

      // ── DCs com violação ──────────────────────────────────────────────────
      if (rc.detalhes_dcs && rc.detalhes_dcs.length > 0) {
        const dcHdrRow = wsReg.addRow([`DCs COM VIOLAÇÃO — DETALHE (${rc.detalhes_dcs.length})`]);
        dcHdrRow.height = 16;
        wsReg.mergeCells(`A${dcHdrRow.number}:G${dcHdrRow.number}`);
        const dcHdrCell = wsReg.getCell(`A${dcHdrRow.number}`);
        dcHdrCell.value = `DCs COM VIOLAÇÃO — DETALHE (${rc.detalhes_dcs.length})`;
        dcHdrCell.font = { bold: true, size: 9, name: "Calibri", color: { argb: XL.branco } };
        dcHdrCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XL.vermelho } };
        dcHdrCell.alignment = { vertical: "middle", indent: 2 };

        addBdColHeader(["Nº Documento", "Cedente", "Sacado", "Valor Pago (R$)", "Prazo", "% Atual", "Limite"], XL.dcViolacao);

        for (const d of rc.detalhes_dcs) {
          const dcRow = wsReg.addRow([
            d.ds_seu_numero || "—",
            d.nm_cedente || "—",
            d.nm_sacado || "—",
            d.vl_pago != null ? Number(d.vl_pago) : 0,
            d.prazo != null ? `${d.prazo} du` : "—",
            d.valor_atual != null ? String(d.valor_atual) : "—",
            d.valor_limite != null ? String(d.valor_limite) : "—",
          ]);
          dcRow.height = 20;
          dcRow.eachCell((cell, cn) => {
            if (cn > 7) return;
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XL.vermelhoBg } };
            cell.font = { size: 8, name: "Calibri", color: { argb: XL.texto } };
            cell.alignment = { vertical: "middle" };
            applyBorder(cell);
            if (cn === 4) { cell.numFmt = '"R$ "#,##0.00'; cell.alignment = { vertical: "middle", horizontal: "right" }; }
            if (cn === 5) cell.alignment = { vertical: "middle", horizontal: "center" };
            if (cn === 6) { cell.font = { bold: true, size: 8, name: "Calibri", color: { argb: XL.vermelho } }; cell.alignment = { vertical: "middle", horizontal: "right" }; }
            if (cn === 7) cell.alignment = { vertical: "middle", horizontal: "right" };
          });
        }
      }

      // ── Spacer entre regras ───────────────────────────────────────────────
      const sep = wsReg.addRow(["", "", "", "", "", "", ""]);
      sep.height = 6;
      for (let c = 1; c <= 7; c++) {
        sep.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8F8F8" } };
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Aba 3 — Detalhamento por DC (com total)
  // ═══════════════════════════════════════════════════════════════════════════
  if (analise.resultados && analise.resultados.length > 0) {
    const wsDC = wb.addWorksheet("Detalhamento por DC", { views: [{ state: "frozen", ySplit: 4 }] });
    wsDC.columns = [
      { width: 28 }, // A - Nr Documento
      { width: 28 }, // B - Cedente
      { width: 40 }, // C - Sacado
      { width: 18 }, // D - Valor Pago
      { width: 10 }, // E - Prazo
      { width: 12 }, // F - Elegível
      { width: 12 }, // G - Enquadra
      { width: 60 }, // H - Motivos
    ];

    // Linha 1
    wsDC.mergeCells("A1:H1");
    wsDC.getRow(1).height = 30;
    Object.assign(wsDC.getCell("A1"), {
      value: `DETALHAMENTO POR DC — ${analise.resultados.length} títulos`,
      font: { bold: true, size: 12, name: "Calibri", color: { argb: XL.branco } },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: XL.verdeEscuro } },
      alignment: { vertical: "middle", horizontal: "left", indent: 1 },
    });

    // Linha 2 — meta
    wsDC.mergeCells("A2:H2");
    wsDC.getRow(2).height = 16;
    Object.assign(wsDC.getCell("A2"), {
      value: `Análise: ${fmtDate(analise.simuladoEm)} às ${fmtTime(analise.simuladoEm)}  |  Exportado: ${fmtDate(now)} às ${fmtTime(now)}  |  Fundo: ${analise.fundo_nome || fmtCnpj(analise.fundo_cnpj || "")}`,
      font: { size: 8, name: "Calibri", color: { argb: XL.textoMuted }, italic: true },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: XL.cinzaBg } },
      alignment: { vertical: "middle", indent: 1 },
    });

    // Linha 3 — spacer
    wsDC.getRow(3).height = 6;

    // Linha 4 — cabeçalhos
    const dcHdr = wsDC.addRow(["Nº Documento", "Cedente", "Sacado", "Valor Pago (R$)", "Prazo", "Elegível", "Enquadra", "Motivos de Rejeição"]);
    dcHdr.height = 22;
    dcHdr.eachCell((cell, cn) => {
      if (cn > 8) return;
      cell.font = { bold: true, size: 9, name: "Calibri", color: { argb: XL.branco } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XL.cinzaHeader } };
      cell.alignment = { vertical: "middle", horizontal: (cn === 1 || cn === 8) ? "left" : "center", indent: (cn === 1 || cn === 8) ? 1 : 0 };
      applyBorder(cell);
    });

    let totalVlPago = 0;

    analise.resultados.forEach((dc) => {
      const isRecompraRow = dc.tipo_operacao === "RECOMPRA";
      const recompraAvaliada = isRecompraRow && dc.elegivel !== null;
      const isEnquadra = dc.enquadra === true;
      const isElegivel = dc.elegivel;
      const rowBg = isRecompraRow && !recompraAvaliada
        ? XL.cinzaBg
        : isEnquadra ? XL.verdeClaro : isElegivel ? XL.vermelhoBg : XL.cinzaBg;
      const motivosText = isRecompraRow && !recompraAvaliada
        ? "Recompra — não avaliada"
        : dc.motivos.map(m => m.regra_descricao).join("; ") || "—";
      const vlPago = Number(dc.vl_pago) || 0;
      totalVlPago += vlPago;

      const row = wsDC.addRow([
        dc.ds_seu_numero,
        dc.nm_cedente || "—",
        dc.nm_sacado,
        vlPago,
        `${dc.prazo} du`,
        isRecompraRow && !recompraAvaliada ? "RECOMPRA" : dc.elegivel ? "Sim" : "Não",
        isRecompraRow && !recompraAvaliada ? "—" : dc.enquadra === true ? "Sim" : dc.elegivel ? "Não" : "—",
        motivosText,
      ]);
      row.height = 36;
      row.eachCell((cell, cn) => {
        if (cn > 8) return;
        cell.font = { size: 9, name: "Calibri", color: { argb: XL.texto } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowBg } };
        cell.alignment = { vertical: "middle" };
        applyBorder(cell);
        if (cn === 4) { cell.numFmt = '"R$ "#,##0.00'; cell.alignment = { vertical: "middle", horizontal: "right" }; }
        if (cn === 5) cell.alignment = { vertical: "middle", horizontal: "center" };
        if (cn === 6) {
          const elColor = isRecompraRow && !recompraAvaliada ? XL.cinzaBg : isElegivel ? XL.verdeMedio : XL.vermelho;
          cell.font = { bold: true, size: 9, name: "Calibri", color: { argb: elColor } };
          cell.alignment = { vertical: "middle", horizontal: "center" };
        }
        if (cn === 7) {
          if ((!isRecompraRow || recompraAvaliada) && isElegivel) cell.font = { bold: true, size: 9, name: "Calibri", color: { argb: isEnquadra ? XL.verdeMedio : XL.vermelho } };
          cell.alignment = { vertical: "middle", horizontal: "center" };
        }
        if (cn === 8) cell.alignment = { vertical: "middle", wrapText: true };
      });
    });

    // Spacer
    wsDC.addRow([]).height = 6;

    // Linha de total
    const totalRow = wsDC.addRow([
      `TOTAL (${analise.resultados.length} DCs)`, "", "", totalVlPago, "", "", "", "",
    ]);
    totalRow.height = 22;
    wsDC.mergeCells(`A${totalRow.number}:C${totalRow.number}`);
    totalRow.eachCell((cell, cn) => {
      if (cn > 4) return;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XL.cinzaHeader } };
      cell.font = { bold: true, size: 10, name: "Calibri", color: { argb: XL.branco } };
      cell.alignment = { vertical: "middle", horizontal: cn === 1 ? "right" : "right" };
      if (cn === 1) cell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
      if (cn === 4) {
        cell.numFmt = '"R$ "#,##0.00';
        applyBorder(cell);
      }
    });
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const ts = analise.simuladoEm.toISOString().slice(0, 19).replace(/[T:]/g, "-");
  downloadBlob(blob, `analise-cessao-${ts}.xlsx`);
}
