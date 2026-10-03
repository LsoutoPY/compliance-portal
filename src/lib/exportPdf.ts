import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { Chart, registerables } from "chart.js";
import annotationPlugin from "chartjs-plugin-annotation";
import { resolveTributarioMetrics } from "@/lib/tributarioMetrics";

Chart.register(...registerables, annotationPlugin);

const MARGIN = 10;

/** Expande áreas de scroll para capturar o conteúdo completo */
function expandScrollAreas(element: HTMLElement): () => void {
  const viewports = element.querySelectorAll("[data-radix-scroll-area-viewport]");
  const backups: { el: Element; overflow: string; height: string; maxHeight: string }[] = [];
  viewports.forEach((el) => {
    const html = el as HTMLElement;
    backups.push({
      el,
      overflow: html.style.overflow,
      height: html.style.height,
      maxHeight: html.style.maxHeight,
    });
    html.style.overflow = "visible";
    html.style.height = "auto";
    html.style.maxHeight = "none";
  });
  return () => {
    backups.forEach(({ el, overflow, height, maxHeight }) => {
      const html = el as HTMLElement;
      html.style.overflow = overflow;
      html.style.height = height;
      html.style.maxHeight = maxHeight;
    });
  };
}

/**
 * Exporta um elemento HTML como PDF.
 * @param element - Elemento DOM a ser capturado
 * @param filename - Nome do arquivo (sem extensão)
 */
export async function exportElementToPdf(element: HTMLElement, filename: string): Promise<void> {
  const restore = expandScrollAreas(element);
  try {
    const canvas = await html2canvas(element, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: "#ffffff",
    });

    const imgData = canvas.toDataURL("image/png", 1.0);
    const imgWidth = canvas.width;
    const imgHeight = canvas.height;

    const pdf = new jsPDF({
      orientation: imgHeight > imgWidth ? "portrait" : "landscape",
      unit: "mm",
      format: "a4",
    });

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const contentWidth = pageWidth - 2 * MARGIN;
    const contentHeight = pageHeight - 2 * MARGIN;

    const pxPerMm = 96 / 25.4;
    const scale = Math.min(
      (contentWidth * pxPerMm) / imgWidth,
      (contentHeight * pxPerMm) / imgHeight
    );
    const scaledWidthMm = (imgWidth * scale) / pxPerMm;
    const scaledHeightMm = (imgHeight * scale) / pxPerMm;

    if (scaledHeightMm <= contentHeight) {
      pdf.addImage(imgData, "PNG", MARGIN, MARGIN, scaledWidthMm, scaledHeightMm);
    } else {
      let sourceY = 0;
      let isFirstPage = true;

      while (sourceY < imgHeight) {
        const pageContentHeightMm = Math.min(contentHeight, scaledHeightMm - (sourceY / imgHeight) * scaledHeightMm);
        const sourceHeightPx = (pageContentHeightMm / scaledHeightMm) * imgHeight;
        const sliceHeight = Math.min(Math.round(sourceHeightPx), imgHeight - sourceY);

        const pageCanvas = document.createElement("canvas");
        pageCanvas.width = imgWidth;
        pageCanvas.height = sliceHeight;
        const ctx = pageCanvas.getContext("2d")!;
        ctx.drawImage(canvas, 0, sourceY, imgWidth, sliceHeight, 0, 0, imgWidth, sliceHeight);
        const pageImgData = pageCanvas.toDataURL("image/png", 1.0);

        const drawHeightMm = (sliceHeight / imgHeight) * scaledHeightMm;
        if (!isFirstPage) pdf.addPage();
        pdf.addImage(pageImgData, "PNG", MARGIN, MARGIN, scaledWidthMm, drawHeightMm);

        sourceY += sliceHeight;
        isFirstPage = false;
      }
    }

    pdf.save(`${filename}.pdf`);
  } finally {
    restore();
  }
}

// ── Logo loader (com detecção de aspect ratio) ───────────────────────────────
type LogoInfo = { data: string; ratio: number };

async function loadLogoAsBase64(): Promise<LogoInfo | null> {
  try {
    const resp = await fetch("/logo-cvpar.png");
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const data = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    });
    if (!data) return null;
    const ratio = await new Promise<number>((resolve) => {
      const img = new Image();
      img.onload = () =>
        resolve(
          img.naturalWidth > 0 && img.naturalHeight > 0
            ? img.naturalWidth / img.naturalHeight
            : 4.5
        );
      img.onerror = () => resolve(4.5);
      img.src = data;
    });
    return { data, ratio };
  } catch {
    return null;
  }
}

// ── Tipos ─────────────────────────────────────────────────────────────────────
type FundoRow = {
  nome_fundo: string;
  fundo_cnpj: string;
  administrador: string;
  pl: number;
  prazo_resgate: number | null;
  disponibilidade: number;
  dispPL: number;
  status: string;
  intermediateStatus?: string | null;
};

type Totals = {
  total: number;
  ok: number;
  alerta: number;
  violacao: number;
  semPrazo: number;
  plTotal: number;
};

type RGB = [number, number, number];

// ── Formatadores ─────────────────────────────────────────────────────────────
const fmtBRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);

const fmtPerc = (v: number) => `${(v * 100).toFixed(1)}%`;

const fmtCnpj = (cnpj: string) => {
  const clean = String(cnpj).replace(/\D/g, "");
  if (clean.length !== 14) return cnpj;
  return clean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
};

const statusLabel = (s: string) =>
  s === "ok"       ? "Enquadrado"
  : s === "alerta" ? "Soft Limit"
  : s === "violacao" ? "Hard Limit"
  : "Pendente";

// ── Paleta de marca CVPAR Quadrante ──────────────────────────────────────────
// Pantone 7733 C — verde principal
const BRAND_GREEN: RGB  = [0,   115,  74];
// Pantone Cool Gray 10 C — cinza escuro
const BRAND_GRAY1: RGB  = [91,   96, 102];
// Pantone Cool Gray 10 C variant — cinza médio
const BRAND_GRAY2: RGB  = [133, 133, 132];

// Status colors (no design institucional)
const STATUS_OK: RGB      = BRAND_GREEN;
const STATUS_OK_BG: RGB   = [224, 243, 234];
const STATUS_SOFT: RGB    = [153,  85,   0];
const STATUS_SOFT_BG: RGB = [255, 246, 224];
const STATUS_HARD: RGB    = [175,  25,  25];
const STATUS_HARD_BG: RGB = [253, 232, 232];
const STATUS_PEND: RGB    = BRAND_GRAY2;

// Neutros
const INK: RGB    = [25,  25,  25];
const BORDER: RGB = [210, 210, 210];
const BG_ROW: RGB = [249, 249, 249];
const WHITE: RGB  = [255, 255, 255];

// ── Tipos compartilhados para export de fundo ────────────────────────────────
export interface ExportAtivoVertice {
  nome: string;
  valor: number;
  prazo: number;
  fonte?: string;
  look_through_resumo?: string;
  look_through_fip_cnpj?: string;
  look_through_posicao_data?: string;
  look_through_detalhes?: Array<{ nome: string; valor: number; pct: number; data_liquidez: string; dias: number }>;
}

export interface ExportVerticeRow {
  vertice: number;
  ativoVertice: number;
  probabilidade: number;
  ativoAcumulado: number;
  passivoNoVertice: number;
  resgatesSolicitados?: number | null;
  passivoAcumulado: number;
  indice: number;
  status: "ok" | "alerta" | "violacao";
  indiceAcumulado: number;
  estadoAcumulado: "ok" | "alerta" | "violacao";
  statusConsolidado: "ok" | "alerta" | "violacao";
  ativosNoVertice: ExportAtivoVertice[];
}

export interface ExportStressInfo {
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

export interface ExportFundoFechadoAnalise {
  dispPL: number;
  disponibilidade: number;
  prazoResgate: number | null;
  status: "ok" | "alerta" | "violacao";
  mesesCobertura: number | null;
  caixaLiquido: number;
  darfEstimado: number;
  despesaOperacionalMensal: number | null;
  statusCoberturaDespesa: "ok" | "alerta" | "violacao" | "indisponivel";
  hardThreshold: number;   // fração (ex: 0.03)
  softThreshold: number;   // fração (ex: 0.04)
}

export interface ExportFundoInfo {
  nomeFundo: string;
  cnpj: string;        // formatado XX.XXX.XXX/XXXX-XX
  dataBase: string;    // "27/02/2026"
  administrador: string;
  tipo: string;        // "Aberto" | "Fechado"
  pl: number;
  prazoResgate: number | null;
  worstStatus: "ok" | "alerta" | "violacao";
  classe: string;
  segmento: string;
  metrica: string;
  // Campos exclusivos para fundo fechado
  fundoFechadoAnalise?: ExportFundoFechadoAnalise | null;
}

// ── Tipo de ativo da carteira (importado de exportFundoExcel) ─────────────────
export interface ExportPdfWalletAsset {
  section: string;
  nome: string;
  cnpj?: string | null;
  valor: number;
  prazo_dias: number | null;
  vertice: number | null;
}

// ── PDF Detalhado por Fundo ───────────────────────────────────────────────────
export async function exportFundoDetalhesPdf(
  info: ExportFundoInfo,
  vertices: ExportVerticeRow[],
  wallet?: ExportPdfWalletAsset[],
  stressInfo?: ExportStressInfo,
  ignorarResgates?: boolean,
  hardThreshold?: number,
  softThreshold?: number,
): Promise<void> {
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  const logo = await loadLogoAsBase64();

  const sf = (c: RGB) => pdf.setFillColor(c[0], c[1], c[2]);
  const sd = (c: RGB) => pdf.setDrawColor(c[0], c[1], c[2]);
  const st = (c: RGB) => pdf.setTextColor(c[0], c[1], c[2]);
  const lw = (w: number) => pdf.setLineWidth(w);

  const worstColor: RGB =
    info.worstStatus === "violacao" ? STATUS_HARD
    : info.worstStatus === "alerta" ? STATUS_SOFT
    : STATUS_OK;
  const worstBg: RGB =
    info.worstStatus === "violacao" ? STATUS_HARD_BG
    : info.worstStatus === "alerta" ? STATUS_SOFT_BG
    : STATUS_OK_BG;
  const worstLabel =
    info.worstStatus === "violacao" ? "HARD LIMIT"
    : info.worstStatus === "alerta" ? "SOFT LIMIT"
    : "ENQUADRADO";

  const HEADER_H = 26;

  // ── Header ────────────────────────────────────────────────────
  const drawHeader = (isFirst: boolean) => {
    sf(WHITE); pdf.rect(0, 0, pageW, HEADER_H, "F");
    sf(BRAND_GREEN); pdf.rect(0, 0, pageW, 2.5, "F");
    sd(BORDER); lw(0.3); pdf.line(0, HEADER_H, pageW, HEADER_H);

    let textX = MARGIN;
    if (logo) {
      const lh = 13;
      const lw2 = lh * logo.ratio;
      pdf.addImage(logo.data, "PNG", MARGIN, 5, lw2, lh);
      textX = MARGIN + lw2 + 10;
    }

    if (isFirst) {
      // Nome do fundo (truncado se necessário)
      const maxW = pageW - textX - MARGIN - 46;
      pdf.setFontSize(10);
      pdf.setFont("helvetica", "bold");
      st(INK);
      const nameLines = pdf.splitTextToSize(info.nomeFundo, maxW);
      pdf.text(nameLines[0], textX, 12);

      pdf.setFontSize(7);
      pdf.setFont("helvetica", "normal");
      st(BRAND_GRAY2);
      pdf.text("Análise de Risco de Liquidez — Gestão de Liquidez", textX, 19);
    }

    // Status badge — canto direito
    const badgeW = 38;
    const bX = pageW - MARGIN - badgeW;
    sf(worstBg);
    pdf.roundedRect(bX, 8, badgeW, 10, 1, 1, "F");
    sd(worstColor); lw(0.3);
    pdf.roundedRect(bX, 8, badgeW, 10, 1, 1, "S");
    pdf.setFontSize(7.5);
    pdf.setFont("helvetica", "bold");
    st(worstColor);
    pdf.text(worstLabel, bX + badgeW / 2, 14.5, { align: "center" });
  };

  // ── Footer ────────────────────────────────────────────────────
  const drawFooter = (pageNum: number, totalPages: number) => {
    sd(BORDER); lw(0.3);
    pdf.line(MARGIN, pageH - 13, pageW - MARGIN, pageH - 13);
    pdf.setFontSize(6.5);
    pdf.setFont("helvetica", "normal");
    st(BRAND_GRAY2);
    const now = new Date();
    const genDate =
      now.toLocaleDateString("pt-BR") + " " +
      now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    pdf.text("CVPAR Quadrante — Documento Confidencial", MARGIN, pageH - 8);
    pdf.text(`Gerado em: ${genDate}`, pageW / 2, pageH - 8, { align: "center" });
    pdf.text(`Página ${pageNum} de ${totalPages}`, pageW - MARGIN, pageH - 8, { align: "right" });
  };

  drawHeader(true);
  let curY = HEADER_H + 5;

  // ── Barra de info do fundo ────────────────────────────────────
  sf([248, 249, 250]);
  pdf.roundedRect(MARGIN, curY, pageW - 2 * MARGIN, 14, 1, 1, "F");
  sd(BORDER); lw(0.2);
  pdf.roundedRect(MARGIN, curY, pageW - 2 * MARGIN, 14, 1, 1, "S");

  const infoItems = [
    { label: "CNPJ",              value: info.cnpj },
    { label: "DATA BASE",         value: info.dataBase },
    { label: "ADMINISTRADOR",     value: info.administrador || "—" },
    { label: "TIPO",              value: info.tipo },
    { label: "PATRIMÔNIO LÍQUIDO",value: fmtBRL(info.pl) },
    { label: "PRAZO RESGATE",     value: info.prazoResgate != null ? `D+${info.prazoResgate}` : "—" },
  ];
  const iW = (pageW - 2 * MARGIN) / infoItems.length;
  infoItems.forEach((item, i) => {
    const ix = MARGIN + i * iW + iW / 2;
    pdf.setFontSize(5.5);
    pdf.setFont("helvetica", "bold");
    st(BRAND_GRAY2);
    pdf.text(item.label, ix, curY + 4, { align: "center" });
    pdf.setFontSize(7);
    pdf.setFont("helvetica", "bold");
    st(INK);
    pdf.text(item.value, ix, curY + 11, { align: "center" });
  });
  curY += 18;

  // ── Parâmetros ANBIMA ou Análise Fundo Fechado ───────────────
  const ffa = info.fundoFechadoAnalise;
  if (ffa) {
    // ── Bloco duplo: Amortização | Cobertura Operacional ────────
    const BLOCK_H = 28;
    const halfW = (pageW - 2 * MARGIN - 4) / 2;

    // Helper status colors
    const getStatusColors = (s: string): { fg: RGB; bg: RGB; label: string } => {
      if (s === "ok")       return { fg: STATUS_OK,   bg: STATUS_OK_BG,   label: "Enquadrado" };
      if (s === "alerta")   return { fg: STATUS_SOFT, bg: STATUS_SOFT_BG, label: "Soft Limit" };
      if (s === "violacao") return { fg: STATUS_HARD, bg: STATUS_HARD_BG, label: "Hard Limit" };
      return { fg: BRAND_GRAY2, bg: BG_ROW, label: "Indisponível" };
    };
    const amort = getStatusColors(ffa.status);
    const cover = getStatusColors(ffa.statusCoberturaDespesa);

    // Painel A — Amortização
    const pAx = MARGIN;
    sf([248, 249, 250]); pdf.roundedRect(pAx, curY, halfW, BLOCK_H, 1, 1, "F");
    sd(BORDER); lw(0.2); pdf.roundedRect(pAx, curY, halfW, BLOCK_H, 1, 1, "S");
    // Faixa de cor no topo
    sf(amort.fg); pdf.rect(pAx, curY, halfW, 2, "F");
    // Label painel
    pdf.setFontSize(5.5); pdf.setFont("helvetica", "bold"); st(BRAND_GRAY1);
    pdf.text("AMORTIZAÇÃO", pAx + 3, curY + 7);
    // Badge status
    const badgeAW = 22;
    sf(amort.bg); pdf.roundedRect(pAx + halfW - badgeAW - 3, curY + 3, badgeAW, 6, 0.8, 0.8, "F");
    pdf.setFontSize(5.5); pdf.setFont("helvetica", "bold"); st(amort.fg);
    pdf.text(amort.label, pAx + halfW - badgeAW / 2 - 3, curY + 7.2, { align: "center" });
    // Métrica principal: Disp. / PL
    pdf.setFontSize(16); pdf.setFont("helvetica", "bold"); st(amort.fg);
    pdf.text(`${(ffa.dispPL * 100).toFixed(2)}%`, pAx + halfW - 4, curY + 17, { align: "right" });
    pdf.setFontSize(6); pdf.setFont("helvetica", "normal"); st(BRAND_GRAY2);
    pdf.text("Disp. / PL", pAx + 3, curY + 17);
    // Sub-métricas
    pdf.setFontSize(5.5); pdf.setFont("helvetica", "normal"); st(BRAND_GRAY2);
    pdf.text(`Disponibilidade: ${fmtBRL(ffa.disponibilidade)}`, pAx + 3, curY + 22);
    pdf.text(`Prazo: ${ffa.prazoResgate != null ? `D+${ffa.prazoResgate}` : "—"}`, pAx + 3, curY + 26);
    // Limiares no rodapé
    pdf.setFontSize(5); pdf.setFont("helvetica", "normal"); st(BRAND_GRAY2);
    pdf.text(
      `Hard <= ${(ffa.hardThreshold * 100).toFixed(1)}%  |  Soft ${(ffa.hardThreshold * 100).toFixed(1)}-${(ffa.softThreshold * 100).toFixed(1)}%  |  OK >= ${(ffa.softThreshold * 100).toFixed(1)}%`,
      pAx + halfW / 2, curY + BLOCK_H - 1, { align: "center" }
    );

    // Painel B — Cobertura Operacional
    const pBx = MARGIN + halfW + 4;
    sf([248, 249, 250]); pdf.roundedRect(pBx, curY, halfW, BLOCK_H, 1, 1, "F");
    sd(BORDER); lw(0.2); pdf.roundedRect(pBx, curY, halfW, BLOCK_H, 1, 1, "S");
    // Faixa de cor
    sf(cover.fg); pdf.rect(pBx, curY, halfW, 2, "F");
    // Label painel
    pdf.setFontSize(5.5); pdf.setFont("helvetica", "bold"); st(BRAND_GRAY1);
    pdf.text("COBERTURA OPERACIONAL", pBx + 3, curY + 7);
    // Badge status cobertura
    sf(cover.bg); pdf.roundedRect(pBx + halfW - badgeAW - 3, curY + 3, badgeAW, 6, 0.8, 0.8, "F");
    pdf.setFontSize(5.5); pdf.setFont("helvetica", "bold"); st(cover.fg);
    pdf.text(cover.label, pBx + halfW - badgeAW / 2 - 3, curY + 7.2, { align: "center" });
    // Métrica principal: Meses Cobertura
    pdf.setFontSize(16); pdf.setFont("helvetica", "bold"); st(cover.fg);
    pdf.text(ffa.mesesCobertura != null ? `${ffa.mesesCobertura.toFixed(1)} m` : "—", pBx + halfW - 4, curY + 17, { align: "right" });
    pdf.setFontSize(6); pdf.setFont("helvetica", "normal"); st(BRAND_GRAY2);
    pdf.text("Meses cobertura", pBx + 3, curY + 17);
    // Sub-métricas
    pdf.setFontSize(5.5); pdf.setFont("helvetica", "normal"); st(BRAND_GRAY2);
    pdf.text(`Caixa líquido: ${fmtBRL(ffa.caixaLiquido)}`, pBx + 3, curY + 22);
    const despLabel = ffa.despesaOperacionalMensal != null
      ? `Despesa mensal: ${fmtBRL(ffa.despesaOperacionalMensal)}`
      : "Despesa mensal: não cadastrada";
    pdf.text(despLabel, pBx + 3, curY + 26);
    // Limiares fixos no rodapé
    pdf.setFontSize(5); pdf.setFont("helvetica", "normal"); st(BRAND_GRAY2);
    pdf.text("Hard < 3 m  |  Soft 3-7 m  |  OK >= 7 m", pBx + halfW / 2, curY + BLOCK_H - 1, { align: "center" });

    curY += BLOCK_H + 5;
  } else {
    // Fundo aberto: parâmetros ANBIMA
    pdf.setFontSize(6.5);
    pdf.setFont("helvetica", "bold");
    st(BRAND_GRAY1);
    pdf.text(
      `PARÂMETROS ANBIMA:  Classe: ${info.classe}   Segmento: ${info.segmento}   Métrica: ${info.metrica}`,
      MARGIN, curY
    );
    curY += 3;
    sd(BORDER); lw(0.2);
    pdf.line(MARGIN, curY, pageW - MARGIN, curY);
    curY += 4;

    // ── MUDANÇA A: Bloco de parâmetros do cenário de stress ─────
    const effectiveHard = hardThreshold ?? 1.0;
    const effectiveSoft = softThreshold ?? 1.05;
    
    if (stressInfo && stressInfo.choque > 0) {
      // Variação 2 — Stress ATIVO (bloco âmbar)
      const STRESS_H = 22;
      const STRESS_W = pageW - 2 * MARGIN;
      const AMBER_BG: RGB = [255, 251, 240];
      const AMBER_BORDER: RGB = [232, 160, 0];
      
      sf(AMBER_BG);
      pdf.roundedRect(MARGIN, curY, STRESS_W, STRESS_H, 1.5, 1.5, "F");
      sd(AMBER_BORDER); lw(0.3);
      pdf.roundedRect(MARGIN, curY, STRESS_W, STRESS_H, 1.5, 1.5, "S");
      
      // Título com ícone
      pdf.setFontSize(6.5);
      pdf.setFont("helvetica", "bold");
      st(INK);
      pdf.text("⚡ CENÁRIO DE STRESS ATIVO", MARGIN + 3, curY + 5);
      
      // Primeira linha: Choque e % PL
      pdf.setFontSize(6);
      pdf.setFont("helvetica", "normal");
      st(BRAND_GRAY1);
      const pctPL = info.pl > 0 ? (stressInfo.choque / info.pl) * 100 : 0;
      pdf.text(
        `Choque aplicado: ${fmtBRL(stressInfo.choque)}  |  % do PL: ${pctPL.toFixed(2)}%`,
        MARGIN + 3, curY + 10
      );
      
      // Segunda linha: Regra
      const regra = stressInfo.binding === "cap20"
        ? `20% PL (top 3 cotistas acima do teto: ${fmtBRL(stressInfo.somaCotistasTop3)})`
        : `20% PL (top 3 cotistas abaixo do piso: ${fmtBRL(stressInfo.somaCotistasTop3)})`;
      pdf.text(`Regra: ${regra}`, MARGIN + 3, curY + 14);
      
      // Terceira linha: Vértice impactado e Resgates solicitados
      const resgatesLabel = ignorarResgates ? "Considerados" : "Ignorados";
      pdf.text(
        `Vértice impactado: D+${stressInfo.prazoVertice}  |  Resgates solicitados: ${resgatesLabel}`,
        MARGIN + 3, curY + 18
      );
      
      // Limites no canto direito (alinhados)
      pdf.setFontSize(5.5);
      pdf.setFont("helvetica", "bold");
      st(BRAND_GRAY2);
      pdf.text(
        `Hard Limit: ${(effectiveHard * 100).toFixed(0)}%  |  Soft Limit: ${(effectiveSoft * 100).toFixed(0)}%`,
        MARGIN + STRESS_W - 3, curY + 5, { align: "right" }
      );
      
      curY += STRESS_H + 4;
    } else {
      // Variação 1 — Stress INATIVO (bloco simples)
      const SIMPLE_H = 10;
      const SIMPLE_W = pageW - 2 * MARGIN;
      
      sf([248, 249, 250]);
      pdf.roundedRect(MARGIN, curY, SIMPLE_W, SIMPLE_H, 1, 1, "F");
      sd(BORDER); lw(0.2);
      pdf.roundedRect(MARGIN, curY, SIMPLE_W, SIMPLE_H, 1, 1, "S");
      
      pdf.setFontSize(6);
      pdf.setFont("helvetica", "normal");
      st(BRAND_GRAY1);
      pdf.text(
        `Hard Limit: ${(effectiveHard * 100).toFixed(0)}%  |  Soft Limit: ${(effectiveSoft * 100).toFixed(0)}%`,
        MARGIN + SIMPLE_W / 2, curY + 7, { align: "center" }
      );
      
      curY += SIMPLE_H + 4;
    }
  }

  // ── Rótulo da seção ───────────────────────────────────────────
  pdf.setFontSize(6);
  pdf.setFont("helvetica", "bold");
  st(BRAND_GRAY1);
  pdf.text(ffa ? "COMPOSICAO DA CARTEIRA" : "ANALISE VERTICE A VERTICE", MARGIN, curY);
  if (ffa) {
    pdf.setFontSize(5.5);
    pdf.setFont("helvetica", "normal");
    st(BRAND_GRAY2);
    pdf.text("Detalhamento de Ativos e Lancamentos", MARGIN, curY + 3.5);
    curY += 3.5;
  }
  curY += 4;

  if (ffa) {
    // ── Fundo Fechado: tabela de Composição da Carteira ───────────
    const walletRows = (wallet ?? []).map(a => [
      a.section || "—",
      a.nome || "—",
      a.cnpj || "—",
      a.valor,
      a.prazo_dias != null ? String(a.prazo_dias) : "—",
      a.vertice != null ? `D+${a.vertice}` : "—",
    ]);

    const sectionOrder: Record<string, number> = {
      caixa: 1, titpublico: 2, titprivado: 3, cotas: 4,
      fidc: 5, acoes: 6, participacoes: 7, imoveis: 8,
      despesas: 9, provisao: 10,
    };
    walletRows.sort((a, b) => {
      const ao = sectionOrder[(a[0] as string).toLowerCase()] ?? 99;
      const bo = sectionOrder[(b[0] as string).toLowerCase()] ?? 99;
      return ao !== bo ? ao - bo : (b[3] as number) - (a[3] as number);
    });

    autoTable(pdf, {
      startY: curY,
      head: [["Secao", "Ativo / Nome", "CNPJ", "Valor (R$)", "Prazo (dias)", "Vertice"]],
      body: walletRows.map(r => [r[0], r[1], r[2], fmtBRL(r[3] as number), r[4], r[5]]),
      margin: { top: HEADER_H + 5, left: MARGIN, right: MARGIN, bottom: 18 },
      tableWidth: 277,
      styles: {
        fontSize: 7,
        cellPadding: { top: 2, right: 2, bottom: 2, left: 2 },
        lineColor: BORDER,
        lineWidth: 0.15,
        textColor: INK,
        overflow: "ellipsize",
      },
      headStyles: {
        fillColor: BRAND_GRAY1,
        textColor: WHITE,
        fontStyle: "bold",
        fontSize: 6.5,
        cellPadding: { top: 3, right: 2, bottom: 3, left: 2 },
      },
      alternateRowStyles: { fillColor: BG_ROW },
      columnStyles: {
        0: { cellWidth: 28, halign: "center" },
        1: { cellWidth: "auto", fontStyle: "bold", overflow: "ellipsize" },
        2: { cellWidth: 40, font: "courier", fontSize: 6.5, textColor: BRAND_GRAY2 },
        3: { cellWidth: 38, halign: "right", font: "courier" },
        4: { cellWidth: 22, halign: "center", font: "courier" },
        5: { cellWidth: 22, halign: "center", font: "courier" },
      },
      didDrawPage: (data) => {
        if (data.pageNumber > 1) drawHeader(false);
      },
    });
  } else {
    // ── Fundo Aberto: tabela vértice a vértice ────────────────────
    const subRowSet = new Set<number>();
    const vertexStatusByIdx = new Map<number, "ok" | "alerta" | "violacao">();
    const body: string[][] = [];

    // ── MUDANÇA B: Definir headers e colunas baseado em ignorarResgates ──
    const incluirResgatesSol = ignorarResgates === true;
    
    const headers = incluirResgatesSol
      ? [
          "Vertice", "Ativo Vert.", "Ativo Acum.", "Prob.%",
          "Passivo Vert.", "Passivo Acum.", "Resgates Sol.",
          "Indice", "Status", "Ind. Acum.", "Consolidado",
        ]
      : [
          "Vertice", "Ativo Vert.", "Ativo Acum.", "Prob.%",
          "Passivo Vert.", "Passivo Acum.",
          "Indice", "Status", "Ind. Acum.", "Consolidado",
        ];

    for (const v of vertices) {
      const vIdx = body.length;
      vertexStatusByIdx.set(vIdx, v.statusConsolidado);

      const vLabel = v.vertice === 1260 ? "D+720+" : `D+${v.vertice}`;
      const resg = v.resgatesSolicitados && v.resgatesSolicitados > 0
        ? fmtBRL(v.resgatesSolicitados) : "—";
      const statusTxt = (s: string) => s === "ok" ? "OK" : s === "alerta" ? "Soft" : "Hard";

      const row = incluirResgatesSol
        ? [
            vLabel,
            fmtBRL(v.ativoVertice),
            fmtBRL(v.ativoAcumulado),
            `${(v.probabilidade * 100).toFixed(2)}%`,
            fmtBRL(v.passivoNoVertice),
            fmtBRL(v.passivoAcumulado),
            resg,
            v.indice > 999 ? ">999" : v.indice.toFixed(2),
            statusTxt(v.status),
            v.indiceAcumulado > 999 ? ">999" : v.indiceAcumulado.toFixed(2),
            statusTxt(v.statusConsolidado),
          ]
        : [
            vLabel,
            fmtBRL(v.ativoVertice),
            fmtBRL(v.ativoAcumulado),
            `${(v.probabilidade * 100).toFixed(2)}%`,
            fmtBRL(v.passivoNoVertice),
            fmtBRL(v.passivoAcumulado),
            v.indice > 999 ? ">999" : v.indice.toFixed(2),
            statusTxt(v.status),
            v.indiceAcumulado > 999 ? ">999" : v.indiceAcumulado.toFixed(2),
            statusTxt(v.statusConsolidado),
          ];

      body.push(row);

      for (const a of v.ativosNoVertice) {
        const aIdx = body.length;
        subRowSet.add(aIdx);
        const nomeTrunc = a.nome.length > 34 ? a.nome.slice(0, 33) + "..." : a.nome;
        const fontePdf = a.fonte === "fip_lookthrough" ? "Look-through FIP" : (a.fonte || "—");
        
        const subRow = incluirResgatesSol
          ? [">", nomeTrunc, fmtBRL(a.valor), fontePdf, "", "", "", "", "", "", ""]
          : [">", nomeTrunc, fmtBRL(a.valor), fontePdf, "", "", "", "", "", ""];
        
        body.push(subRow);
        
        if (a.fonte === "fip_lookthrough" && a.look_through_detalhes?.length) {
          for (const d of a.look_through_detalhes) {
            const s = String(d.data_liquidez ?? "").trim();
            const br = /^\d{8}$/.test(s)
              ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`
              : s.length >= 10 && s[4] === "-" && s[7] === "-"
                ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`
                : s;
            const nomeD = d.nome.length > 30 ? d.nome.slice(0, 29) + "…" : d.nome;
            const pctStr = ` · ${d.pct}% do PL participações (FIP)`;
            
            const detailRow = incluirResgatesSol
              ? [
                  "  ↳",
                  `${nomeD} — D+${d.dias} · ${br}${pctStr}`,
                  fmtBRL(d.valor),
                  "investida",
                  "", "", "", "", "", "", "",
                ]
              : [
                  "  ↳",
                  `${nomeD} — D+${d.dias} · ${br}${pctStr}`,
                  fmtBRL(d.valor),
                  "investida",
                  "", "", "", "", "", "",
                ];
            
            body.push(detailRow);
            subRowSet.add(body.length - 1);
          }
        }
      }
    }

    // Definir columnStyles baseado em incluirResgatesSol
    const columnStyles: any = incluirResgatesSol
      ? {
          0:  { cellWidth: 16, halign: "center", fontStyle: "bold" },
          1:  { cellWidth: 35, halign: "right",  font: "courier" },
          2:  { cellWidth: 35, halign: "right",  font: "courier" },
          3:  { cellWidth: 15, halign: "center", font: "courier" },
          4:  { cellWidth: 31, halign: "right",  font: "courier" },
          5:  { cellWidth: 31, halign: "right",  font: "courier" },
          6:  { cellWidth: 26, halign: "right",  font: "courier" },
          7:  { cellWidth: 20, halign: "center", font: "courier", fontStyle: "bold" },
          8:  { cellWidth: 22, halign: "center", fontStyle: "bold" },
          9:  { cellWidth: 22, halign: "center", font: "courier", fontStyle: "bold" },
          10: { cellWidth: 24, halign: "center", fontStyle: "bold" },
        }
      : {
          0: { cellWidth: 16, halign: "center", fontStyle: "bold" },
          1: { cellWidth: 37, halign: "right",  font: "courier" },
          2: { cellWidth: 37, halign: "right",  font: "courier" },
          3: { cellWidth: 16, halign: "center", font: "courier" },
          4: { cellWidth: 33, halign: "right",  font: "courier" },
          5: { cellWidth: 33, halign: "right",  font: "courier" },
          6: { cellWidth: 22, halign: "center", font: "courier", fontStyle: "bold" },
          7: { cellWidth: 24, halign: "center", fontStyle: "bold" },
          8: { cellWidth: 24, halign: "center", font: "courier", fontStyle: "bold" },
          9: { cellWidth: 26, halign: "center", fontStyle: "bold" },
        };

    autoTable(pdf, {
      startY: curY,
      head: [headers],
      body,
      margin: { left: MARGIN, right: MARGIN, bottom: 18 },
      tableWidth: 277,
      styles: {
        fontSize: 7,
        cellPadding: { top: 2, right: 2, bottom: 2, left: 2 },
        lineColor: BORDER,
        lineWidth: 0.15,
        textColor: INK,
        overflow: "ellipsize",
      },
      headStyles: {
        fillColor: BRAND_GRAY1,
        textColor: WHITE,
        fontStyle: "bold",
        fontSize: 6.5,
        cellPadding: { top: 3, right: 2, bottom: 3, left: 2 },
        overflow: "ellipsize",
      },
      alternateRowStyles: { fillColor: BG_ROW },
      columnStyles,
      didParseCell: (data) => {
        if (data.section !== "body") return;
        const idx = data.row.index;

        if (subRowSet.has(idx)) {
          data.cell.styles.fillColor = [242, 244, 246];
          data.cell.styles.fontSize = 6.5;
          data.cell.styles.textColor = BRAND_GRAY1;
          data.cell.styles.fontStyle = "normal";
          if (data.column.index === 0) {
            data.cell.styles.textColor = BRAND_GRAY2;
            data.cell.styles.halign = "center";
          }
          if (data.column.index === 1) {
            data.cell.styles.halign = "left";
            data.cell.styles.font = "helvetica";
          }
          if (data.column.index === 2) {
            data.cell.styles.halign = "right";
            data.cell.styles.font = "courier";
          }
          if (data.column.index > 3) {
            data.cell.text = [];
          }
        } else {
          const vs = vertexStatusByIdx.get(idx);
          const applyStatus = (s: "ok" | "alerta" | "violacao" | undefined) => {
            if (s === "ok")       return { tc: STATUS_OK,   bg: STATUS_OK_BG };
            if (s === "alerta")   return { tc: STATUS_SOFT, bg: STATUS_SOFT_BG };
            if (s === "violacao") return { tc: STATUS_HARD, bg: STATUS_HARD_BG };
            return null;
          };
          
          // Ajustar índices de coluna baseado em incluirResgatesSol
          const statusColIdx = incluirResgatesSol ? 8 : 7;
          const consolidadoColIdx = incluirResgatesSol ? 10 : 9;
          const indiceColIdx = incluirResgatesSol ? 7 : 6;
          const indiceAcumColIdx = incluirResgatesSol ? 9 : 8;
          
          if (data.column.index === statusColIdx || data.column.index === consolidadoColIdx) {
            const r = applyStatus(vs);
            if (r) { data.cell.styles.textColor = r.tc; data.cell.styles.fillColor = r.bg; }
          }
          if (data.column.index === indiceColIdx || data.column.index === indiceAcumColIdx) {
            const r = applyStatus(vs);
            if (r) data.cell.styles.textColor = r.tc;
          }
        }
      },
      didDrawPage: (data) => {
        if (data.pageNumber > 1) drawHeader(false);
      },
    });
  }

  const totalPages = pdf.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i);
    drawFooter(i, totalPages);
  }

  const today = new Date();
  const ts = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("");
  const safeName = info.nomeFundo.replace(/[^a-zA-Z0-9\u00C0-\u024F\s-]/g, "_").slice(0, 40).trim();
  pdf.save(`Liquidez_${safeName}_${ts}.pdf`);
}

// ── Relatório Consolidado PDF (estilo Bloomberg/BTG Institucional) ────────────
export async function exportConsolidadoPdf(
  fundos: FundoRow[],
  totals: Totals,
  dataRef: string,
): Promise<void> {
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();   // 297mm
  const pageH = pdf.internal.pageSize.getHeight();  // 210mm

  const logo = await loadLogoAsBase64();

  // helpers inline
  const sf = (c: RGB) => pdf.setFillColor(c[0], c[1], c[2]);
  const sd = (c: RGB) => pdf.setDrawColor(c[0], c[1], c[2]);
  const st = (c: RGB) => pdf.setTextColor(c[0], c[1], c[2]);
  const lw = (w: number) => pdf.setLineWidth(w);

  // ── Header (fundo branco, linha verde no topo) ────────────────
  const HEADER_H = 26;

  const drawHeader = (isFirst: boolean) => {
    sf(WHITE);
    pdf.rect(0, 0, pageW, HEADER_H, "F");

    // Faixa verde fina no topo
    sf(BRAND_GREEN);
    pdf.rect(0, 0, pageW, 2.5, "F");

    // Linha separadora cinza embaixo do header
    sd(BORDER);
    lw(0.3);
    pdf.line(0, HEADER_H, pageW, HEADER_H);

    // Logo com aspect ratio correto
    let textX = MARGIN;
    if (logo) {
      const lh = 18;
      const lw2 = lh * logo.ratio;
      pdf.addImage(logo.data, "PNG", MARGIN, 4, lw2, lh);
      textX = MARGIN + lw2 + 10;
    }

    if (isFirst) {
      pdf.setFontSize(12);
      pdf.setFont("helvetica", "bold");
      st(INK);
      pdf.text("RELATÓRIO DE RISCO DE LIQUIDEZ", textX, 13);

      pdf.setFontSize(7.5);
      pdf.setFont("helvetica", "normal");
      st(BRAND_GRAY2);
      pdf.text("Análise consolidada de Gestão de Liquidez", textX, 20);
    }

    // Data de referência — canto direito
    const dX = pageW - MARGIN;
    pdf.setFontSize(6.5);
    pdf.setFont("helvetica", "normal");
    st(BRAND_GRAY2);
    pdf.text("DATA DE REFERÊNCIA", dX, 11, { align: "right" });
    pdf.setFontSize(11);
    pdf.setFont("helvetica", "bold");
    st(INK);
    pdf.text(dataRef, dX, 20, { align: "right" });
  };

  // ── Footer ────────────────────────────────────────────────────
  const drawFooter = (pageNum: number, totalPages: number) => {
    sd(BORDER);
    lw(0.3);
    pdf.line(MARGIN, pageH - 13, pageW - MARGIN, pageH - 13);
    pdf.setFontSize(6.5);
    pdf.setFont("helvetica", "normal");
    st(BRAND_GRAY2);
    const now = new Date();
    const genDate =
      now.toLocaleDateString("pt-BR") +
      " " +
      now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    pdf.text("CVPAR Quadrante — Documento Confidencial para Uso Interno", MARGIN, pageH - 8);
    pdf.text(`Gerado em: ${genDate}`, pageW / 2, pageH - 8, { align: "center" });
    pdf.text(`Página ${pageNum} de ${totalPages}`, pageW - MARGIN, pageH - 8, { align: "right" });
  };

  // ── Página 1 ──────────────────────────────────────────────────
  drawHeader(true);
  let curY = HEADER_H + 6;

  // ── 5 cards KPI (sem PL Total) ────────────────────────────────
  const CARD_H = 17;
  const GAP = 4;
  const N_CARDS = 5;
  const cardW = (pageW - 2 * MARGIN - (N_CARDS - 1) * GAP) / N_CARDS;

  const pctOf = (n: number) =>
    totals.total > 0 ? `${((n / totals.total) * 100).toFixed(0)}%` : "—";

  interface CardDef {
    label: string;
    value: string;
    pct?: string;
    valColor: RGB;
    accentColor: RGB;
  }

  const cards: CardDef[] = [
    {
      label: "TOTAL DE FUNDOS",
      value: String(totals.total),
      valColor: INK,
      accentColor: BRAND_GRAY1,
    },
    {
      label: "ENQUADRADOS",
      value: String(totals.ok),
      pct: pctOf(totals.ok),
      valColor: STATUS_OK,
      accentColor: STATUS_OK,
    },
    {
      label: "SOFT LIMIT",
      value: String(totals.alerta),
      pct: pctOf(totals.alerta),
      valColor: STATUS_SOFT,
      accentColor: STATUS_SOFT,
    },
    {
      label: "HARD LIMIT",
      value: String(totals.violacao),
      pct: pctOf(totals.violacao),
      valColor: STATUS_HARD,
      accentColor: STATUS_HARD,
    },
    {
      label: "PENDENTE",
      value: String(totals.semPrazo),
      pct: pctOf(totals.semPrazo),
      valColor: STATUS_PEND,
      accentColor: BRAND_GRAY2,
    },
  ];

  cards.forEach((card, i) => {
    const x = MARGIN + i * (cardW + GAP);

    // Fundo branco + borda cinza suave
    sf(WHITE);
    pdf.roundedRect(x, curY, cardW, CARD_H, 1, 1, "F");
    sd(BORDER);
    lw(0.3);
    pdf.roundedRect(x, curY, cardW, CARD_H, 1, 1, "S");

    // Faixa colorida de acento no topo do card
    sf(card.accentColor);
    pdf.rect(x, curY, cardW, 2, "F");

    // Label
    pdf.setFontSize(6);
    pdf.setFont("helvetica", "bold");
    st(BRAND_GRAY1);
    pdf.text(card.label, x + cardW / 2, curY + 7, { align: "center" });

    // Valor
    pdf.setFontSize(14);
    pdf.setFont("helvetica", "bold");
    st(card.valColor);
    pdf.text(card.value, x + cardW / 2, curY + 13.5, { align: "center" });

    // Percentual
    if (card.pct) {
      pdf.setFontSize(6);
      pdf.setFont("helvetica", "normal");
      st(BRAND_GRAY2);
      pdf.text(card.pct, x + cardW / 2, curY + CARD_H - 1, { align: "center" });
    }
  });

  curY += CARD_H + 7;

  // ── Barra de distribuição proporcional ────────────────────────
  if (totals.total > 0) {
    const BAR_H = 5;
    const BAR_W = pageW - 2 * MARGIN;

    pdf.setFontSize(6);
    pdf.setFont("helvetica", "bold");
    st(BRAND_GRAY1);
    pdf.text("DISTRIBUIÇÃO POR STATUS", MARGIN, curY + 1);

    const barY = curY + 4;
    let bx = MARGIN;

    const segs: { count: number; color: RGB; label: string }[] = [
      { count: totals.ok,       color: STATUS_OK,    label: "Enquadrado" },
      { count: totals.alerta,   color: STATUS_SOFT,  label: "Soft Limit" },
      { count: totals.violacao, color: STATUS_HARD,  label: "Hard Limit" },
      { count: totals.semPrazo, color: BRAND_GRAY2,  label: "Pendente"   },
    ].filter((s) => s.count > 0);

    for (const seg of segs) {
      const w = (seg.count / totals.total) * BAR_W;
      sf(seg.color);
      pdf.rect(bx, barY, w, BAR_H, "F");
      bx += w;
    }

    // Legenda abaixo da barra
    let lx = MARGIN;
    const legY = barY + BAR_H + 5;
    for (const seg of segs) {
      sf(seg.color);
      pdf.rect(lx, legY - 2.5, 4.5, 3, "F");
      pdf.setFontSize(6.5);
      pdf.setFont("helvetica", "normal");
      st(INK);
      const p = `${((seg.count / totals.total) * 100).toFixed(0)}%`;
      pdf.text(`${seg.label}: ${seg.count} (${p})`, lx + 6.5, legY);
      lx += 58;
    }

    curY += 4 + BAR_H + 13;
  }

  // ── Rótulo da seção de tabela ─────────────────────────────────
  pdf.setFontSize(6);
  pdf.setFont("helvetica", "bold");
  st(BRAND_GRAY1);
  pdf.text("DETALHAMENTO POR FUNDO", MARGIN, curY);
  curY += 4;

  // ── Tabela de fundos ──────────────────────────────────────────
  // Coluna "!" : texto vazio, ícone desenhado via didDrawCell
  const tableRows = fundos.map((f) => [
    f.nome_fundo || "—",
    fmtCnpj(f.fundo_cnpj),
    f.administrador || "—",
    fmtBRL(f.pl),
    f.prazo_resgate != null ? `D+${f.prazo_resgate}` : "—",
    f.prazo_resgate != null ? fmtPerc(f.dispPL) : "—",
    statusLabel(f.status),
    "",
  ]);

  autoTable(pdf, {
    startY: curY,
    head: [["Fundo", "CNPJ", "Administrador", "PL", "Prazo", "Índice Liq.", "Status", "!"]],
    body: tableRows,
    margin: { left: MARGIN, right: MARGIN, bottom: 18 },
    styles: {
      fontSize: 7.5,
      cellPadding: { top: 2.5, right: 3, bottom: 2.5, left: 3 },
      lineColor: BORDER,
      lineWidth: 0.2,
      textColor: INK,
    },
    headStyles: {
      fillColor: BRAND_GRAY1,
      textColor: WHITE,
      fontStyle: "bold",
      fontSize: 7.5,
      cellPadding: { top: 3.5, right: 3, bottom: 3.5, left: 3 },
    },
    alternateRowStyles: { fillColor: BG_ROW },
    columnStyles: {
      0: { cellWidth: 67, fontStyle: "bold" },
      1: { cellWidth: 33, font: "courier", fontSize: 7 },
      2: { cellWidth: 57 },
      3: { halign: "right",  font: "courier", cellWidth: 28 },
      4: { halign: "center", font: "courier", cellWidth: 18 },
      5: { halign: "right",  font: "courier", cellWidth: 24, fontStyle: "bold" },
      6: { halign: "center", cellWidth: 27, fontStyle: "bold" },
      7: { halign: "center", cellWidth: 23 },
    },
    didParseCell: (data) => {
      if (data.section === "body") {
        const idx = data.row.index;
        if (idx < 0 || idx >= fundos.length) return;
        const s = fundos[idx].status;

        // Coluna CNPJ e Admin — cinza médio
        if (data.column.index === 1 || data.column.index === 2) {
          data.cell.styles.textColor = BRAND_GRAY2;
        }

        // Coluna Índice Liq. — cor por status
        if (data.column.index === 5) {
          if (s === "ok")         data.cell.styles.textColor = STATUS_OK;
          else if (s === "alerta") data.cell.styles.textColor = STATUS_SOFT;
          else if (s === "violacao") data.cell.styles.textColor = STATUS_HARD;
        }

        // Coluna Status — fundo suave + texto colorido
        if (data.column.index === 6) {
          if (s === "ok") {
            data.cell.styles.textColor = STATUS_OK;
            data.cell.styles.fillColor = STATUS_OK_BG;
          } else if (s === "alerta") {
            data.cell.styles.textColor = STATUS_SOFT;
            data.cell.styles.fillColor = STATUS_SOFT_BG;
          } else if (s === "violacao") {
            data.cell.styles.textColor = STATUS_HARD;
            data.cell.styles.fillColor = STATUS_HARD_BG;
          } else {
            data.cell.styles.textColor = STATUS_PEND;
            data.cell.styles.fillColor = BG_ROW;
          }
        }

        // Coluna "!" — sem texto (ícone desenhado em didDrawCell)
        if (data.column.index === 7) {
          data.cell.text = [];
        }
      }
    },
    didDrawCell: (data) => {
      // Ícone de alerta intermediário — triângulo ⚠ minimalista
      if (data.section === "body" && data.column.index === 7) {
        const idx = data.row.index;
        if (idx < 0 || idx >= fundos.length) return;
        const interm = fundos[idx].intermediateStatus;
        if (!interm) return;

        const col: RGB = interm === "violacao" ? STATUS_HARD : STATUS_SOFT;
        const cx = data.cell.x + data.cell.width / 2;
        const cy = data.cell.y + data.cell.height / 2;

        // Triângulo equilátero pequeno (s = lado em mm)
        const s = 3.0;
        const h = s * Math.sqrt(3) / 2;  // ~2.6mm
        const x0 = cx;
        const y0 = cy - (h * 2) / 3;    // vértice do topo

        pdf.setFillColor(col[0], col[1], col[2]);
        pdf.setDrawColor(col[0], col[1], col[2]);
        pdf.setLineWidth(0.1);

        // do topo → base-direita (+s/2, +h) → base-esquerda (-s, 0) → fecha
        pdf.lines([[s / 2, h], [-s, 0]], x0, y0, [1, 1], "FD", true);

        // "!" branco minúsculo dentro do triângulo
        pdf.setFontSize(4);
        pdf.setFont("helvetica", "bold");
        pdf.setTextColor(255, 255, 255);
        pdf.text("!", cx, y0 + h * 0.78, { align: "center" });
      }
    },
    didDrawPage: (data) => {
      if (data.pageNumber > 1) {
        drawHeader(false);
      }
    },
  });

  const totalPages = pdf.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i);
    drawFooter(i, totalPages);
  }

  const today = new Date();
  const ts = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("");
  pdf.save(`Relatorio_Liquidez_${dataRef.replace(/\//g, "-")}_${ts}.pdf`);
}

// ── Tipos para export de Enquadramento ───────────────────────────────────────
type EnquadramentoFundoRow = {
  nome_fundo: string;
  fundo_cnpj: string;
  dt_posicao: string;   // YYYYMMDD
  statusDetail: string; // ok | alerta | violacao | pendente
  administrador?: string;
  pl?: number;
  nRegras?: number;
  nViolacoes?: number;
};

export interface ExportEnquadramentoConsolidadoPdfOptions {
  titulo?: string;
  layout?: "simples" | "completo";
  fileName?: string;
}

export interface ExportEnquadramentoFundoInfo {
  nomeFundo: string;
  cnpj: string;      // formatado XX.XXX.XXX/XXXX-XX
  isin?: string | null;
  dataBase: string;  // "27/02/2026"
  prazoResgate: number | null;
  totalPL: number;
  worstStatus: "ok" | "alerta" | "violacao" | "pendente";
}

export interface ExportEnquadramentoRule {
  regra_codigo: string;
  regra_descricao: string;
  regra_categoria: string;
  status: "ok" | "alerta" | "violacao";
  valor_atual: number | null;
  valor_limite: number | null;
  detalhes?: Record<string, unknown> | null;
}

export interface ExportWalletAsset {
  ativo: string;
  tipo: string;
  quantidade: string;
  precoUnit: string;
  liquidez: string;
  financeiro: string;
  percPL: string;
}

// ── Formatador de valor de regra ──────────────────────────────────────────────
function fmtRuleValue(v: number | null, isPercentual = true): string {
  if (v === null || v === undefined) return "—";
  if (isPercentual && Math.abs(v) < 1) return `${(v * 100).toFixed(2)}%`;
  if (!isPercentual || Math.abs(v) >= 1000) {
    return v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  }
  return `${(v * 100).toFixed(2)}%`;
}

function ruleValorAtualExport(r: ExportEnquadramentoRule): number | null {
  if (r.regra_codigo === "TRIB_FIQ_LP_90" || r.regra_categoria === "tributario") {
    const p = r.detalhes?.p_dia;
    if (p != null && Number.isFinite(Number(p))) return Number(p) / 100;
  }
  return r.valor_atual;
}

function enquadramentoStatusLabel(s: string): string {
  if (s === "ok") return "Regular";
  if (s === "alerta") return "Alerta";
  if (s === "violacao") return "Violação";
  return "Pendente";
}

const CATEGORY_LABELS: Record<string, string> = {
  "tributario-art4": "Tributário Art. 4º",
  "tributario-art4-fidc": "Tributário Art. 4º",
  tributario: "Tributário Art. 5º",
  pl: "PL",
  concentration: "Concentração",
  "fidc-concentracao": "FIDC Concentração",
  "fidc-estrutura": "FIDC Estrutura",
  liquidity: "Liquidez",
  classe: "Classe",
  relacional: "Manual",
  relational: "Manual",
};

type RuleComparison = "min" | "max" | "range" | "informative";

export interface EnquadramentoRulePdfPresentation {
  current: number | null;
  minimum: number | null;
  maximum: number | null;
  comparison: RuleComparison;
  currentDisplay: string;
  limitDisplay: string;
  criterionDisplay: string;
  marginDisplay: string;
  explanation: string;
}

interface PdfAuditField {
  label: string;
  value: string;
}

interface PdfRuleAsset {
  nome: string;
  identificador: string;
  classificacao: string;
  valor: number | null;
  percentual: number | null;
  limite: number | null;
  status: string;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentageDecimal(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed === null) return null;
  return Math.abs(parsed) > 1.5 ? parsed / 100 : parsed;
}

function pdfSafeText(value: unknown): string {
  return String(value ?? "-")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/→/g, "->")
    .replace(/•/g, "-")
    .replace(/\u00a0/g, " ");
}

function formatPdfDate(value: unknown): string {
  const raw = String(value ?? "");
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length !== 8) return raw || "-";
  return `${digits.slice(6, 8)}/${digits.slice(4, 6)}/${digits.slice(0, 4)}`;
}

function isCurrencyRule(rule: ExportEnquadramentoRule): boolean {
  const code = rule.regra_codigo.toUpperCase();
  return rule.regra_categoria === "pl" || code === "PL_MIN";
}

function formatRuleMetric(value: number | null, kind: "currency" | "days" | "percentage"): string {
  if (value === null) return "-";
  if (kind === "currency") return fmtBRL(value);
  if (kind === "days") return `${value.toFixed(2).replace(".", ",")}d`;
  return `${(value * 100).toFixed(2).replace(".", ",")}%`;
}

function formatRuleMargin(value: number | null, kind: "currency" | "days" | "percentage"): string {
  if (value === null) return "-";
  const sign = value > 0 ? "+" : "";
  if (kind === "currency") return `${sign}${fmtBRL(value)}`;
  if (kind === "days") return `${sign}${value.toFixed(2).replace(".", ",")}d`;
  return `${sign}${(value * 100).toFixed(2).replace(".", ",")} p.p.`;
}

/** Normaliza a leitura executiva de qualquer regra para o resumo e a memória do PDF. */
export function buildEnquadramentoRulePdfPresentation(
  rule: ExportEnquadramentoRule,
): EnquadramentoRulePdfPresentation {
  const details = (rule.detalhes ?? {}) as Record<string, unknown>;
  const currency = isCurrencyRule(rule);
  const days = isTribArt4Rule(rule);
  const metricKind = currency ? "currency" : days ? "days" : "percentage";

  let current = days
    ? finiteNumber(details.prazo_medio_dias)
    : isTribArt5Rule(rule)
      ? percentageDecimal(details.mm_10d ?? rule.valor_atual)
      : ruleValorAtualExport(rule);

  if (!currency && !days && current !== null && Math.abs(current) > 1.5) {
    current /= 100;
  }

  let minimum = days
    ? finiteNumber(details.limite_dias ?? rule.valor_limite)
    : isTribArt5Rule(rule)
      ? percentageDecimal(details.limite_mm ?? details.limite ?? rule.valor_limite)
      : finiteNumber(details.limite_min ?? details.limite_minimo);
  let maximum = finiteNumber(details.limite_max);

  if (!currency && !days) {
    minimum = percentageDecimal(minimum);
    maximum = percentageDecimal(maximum);
  }

  const code = rule.regra_codigo.toUpperCase();
  let comparison: RuleComparison;
  if (days || isTribArt5Rule(rule) || rule.regra_categoria === "fidc-estrutura" || code === "PL_MIN") {
    comparison = "min";
    minimum ??= currency || days ? rule.valor_limite : percentageDecimal(rule.valor_limite);
  } else if (minimum !== null && maximum !== null) {
    comparison = "range";
  } else if (minimum !== null) {
    comparison = "min";
  } else if (maximum !== null) {
    comparison = "max";
  } else if (rule.valor_limite !== null) {
    comparison = "max";
    maximum = currency ? rule.valor_limite : percentageDecimal(rule.valor_limite);
  } else {
    comparison = "informative";
  }

  const limitDisplay = comparison === "range"
    ? `${formatRuleMetric(minimum, metricKind)} a ${formatRuleMetric(maximum, metricKind)}`
    : formatRuleMetric(comparison === "min" ? minimum : maximum, metricKind);
  const criterionDisplay = comparison === "range"
    ? `${formatRuleMetric(minimum, metricKind)} <= valor <= ${formatRuleMetric(maximum, metricKind)}`
    : comparison === "min"
      ? `valor >= ${formatRuleMetric(minimum, metricKind)}`
      : comparison === "max"
        ? `valor <= ${formatRuleMetric(maximum, metricKind)}`
        : "regra informativa";

  let margin: number | null = null;
  if (current !== null) {
    if (comparison === "min" && minimum !== null) margin = current - minimum;
    if (comparison === "max" && maximum !== null) margin = maximum - current;
    if (comparison === "range" && minimum !== null && maximum !== null) {
      margin = current < minimum
        ? current - minimum
        : current > maximum
          ? maximum - current
          : Math.min(current - minimum, maximum - current);
    }
  }

  const motivo = details.motivo ? pdfSafeText(details.motivo) : null;
  const principalOfensor = details.principal_ofensor as Record<string, unknown> | undefined;
  const context = principalOfensor?.nome
    ? ` Principal ofensor: ${pdfSafeText(principalOfensor.nome)}.`
    : "";
  const marginText = formatRuleMargin(margin, metricKind);
  const explanation = motivo
    ? motivo
    : rule.status === "violacao"
      ? `Fora do critério definido (${criterionDisplay}). Margem apurada: ${marginText}.${context}`
      : rule.status === "alerta"
        ? `Próximo do limite ou com ressalva de dados. Margem apurada: ${marginText}.${context}`
        : comparison === "informative"
          ? "Resultado informativo, sem limite numérico associado."
          : `Em conformidade com o critério (${criterionDisplay}). Folga apurada: ${marginText}.${context}`;

  return {
    current,
    minimum,
    maximum,
    comparison,
    currentDisplay: formatRuleMetric(current, metricKind),
    limitDisplay,
    criterionDisplay,
    marginDisplay: marginText,
    explanation,
  };
}

function buildRulePdfAuditFields(rule: ExportEnquadramentoRule): PdfAuditField[] {
  const d = (rule.detalhes ?? {}) as Record<string, unknown>;
  const fields: PdfAuditField[] = [];
  const add = (label: string, value: unknown, formatter?: (n: number) => string) => {
    if (value === null || value === undefined || value === "") return;
    const text = formatter && finiteNumber(value) !== null
      ? formatter(finiteNumber(value) as number)
      : pdfSafeText(value);
    fields.push({ label, value: text });
  };

  add("PL utilizado", d.patliq ?? d.pl_classe, fmtBRL);
  add("Origem do PL", d.origem_pl_utilizada ?? d.origem_pl ?? d.patliq_origem_utilizada);
  const dataPl = d.data_pl_referencia ?? d.competencia_pl_referencia;
  add("Data do PL", dataPl ? formatPdfDate(dataPl) : null);
  add("Montante considerado", d.total_investido ?? d.total_imoveis ?? d.total_participacoes ?? d.total_fidc, fmtBRL);
  add("Categoria / alvo", d.categoria_alvo ?? d.classe_alvo ?? d.tipo_alvo);
  add("Base de cálculo", d.base_calculo ? String(d.base_calculo).replace(/_/g, " ") : null);
  add("Estoque de referência", d.data_referencia_estoque ? formatPdfDate(d.data_referencia_estoque) : null);
  add("Tratamento de PDD", d.usar_abatimento_pdd == null ? null : d.usar_abatimento_pdd ? "abatido" : "não abatido");
  add("Recebíveis processados", d.total_recebiveis, (n) => n.toLocaleString("pt-BR"));
  add("Recebíveis excluídos", d.recebiveis_excluidos, (n) => n.toLocaleString("pt-BR"));
  add("Registros sem chave", d.recebiveis_baixa_qualidade, (n) => n.toLocaleString("pt-BR"));
  add("Coobrigação indeterminada", d.qtd_ativos_coobrigacao_indeterminada, (n) => n.toLocaleString("pt-BR"));
  add("Grupos avaliados", d.total_grupos, (n) => n.toLocaleString("pt-BR"));
  add("Itens desenquadrados", d.qtd_desenquadrados, (n) => n.toLocaleString("pt-BR"));
  add("Método de agregação", d.metodo_agregacao);
  add("Componentes", d.componentes_count, (n) => n.toLocaleString("pt-BR"));
  add("Ativos únicos", d.ativos_unicos_count, (n) => n.toLocaleString("pt-BR"));
  const rawAssets = d.ativos_vedados ?? d.ativos_contabilizados;
  add("Ativos no cálculo", Array.isArray(rawAssets) ? rawAssets.length : null, (n) => n.toLocaleString("pt-BR"));
  add("PL subordinada", d.pl_jr, fmtBRL);
  add("PL mezanino", d.pl_mez, fmtBRL);
  add("PL sênior", d.pl_sr, fmtBRL);
  add("Índice de subordinação", d.indice_calculado, (n) => `${(n * 100).toFixed(2).replace(".", ",")}%`);
  add("Excesso de cobertura", d.excesso_cobertura, fmtBRL);
  add("Eventos em 12 meses", d.eventos_12m, (n) => n.toLocaleString("pt-BR"));
  add("Dias em violação (12m)", d.dias_violacao_12m, (n) => n.toLocaleString("pt-BR"));
  add("Observação", d.observacao);

  const warnings = [
    ...(Array.isArray(d.avisos_dados) ? d.avisos_dados : []),
    d.motivo_fallback,
    d.sem_dados ? d.motivo : null,
  ].filter(Boolean);
  if (warnings.length > 0) add("Ressalvas", warnings.map(pdfSafeText).join("; "));

  return fields.slice(0, 10);
}

function buildRulePdfAssets(rule: ExportEnquadramentoRule): PdfRuleAsset[] {
  const d = (rule.detalhes ?? {}) as Record<string, unknown>;
  const patliq = finiteNumber(d.patliq ?? d.pl_classe);
  const raw = (d.ativos_vedados ?? d.ativos_contabilizados) as unknown;
  if (!Array.isArray(raw)) return [];

  return raw.slice(0, 8).map((item) => {
    const asset = (item ?? {}) as Record<string, unknown>;
    const value = finiteNumber(asset.valor ?? asset.exposicao);
    const percentage = percentageDecimal(asset.percentual ?? asset.percentual_pl)
      ?? (value !== null && patliq && patliq > 0 ? value / patliq : null);
    const limit = percentageDecimal(asset.limite_aplicavel ?? rule.valor_limite);
    const assetStatus = String(asset.status ?? asset.status_grupo ?? "");
    const inferredStatus = assetStatus || (percentage !== null && limit !== null && percentage > limit ? "violação" : "regular");
    return {
      nome: pdfSafeText(asset.nome ?? asset.regra_descricao ?? "Item considerado"),
      identificador: asset.cnpj ? fmtCnpj(String(asset.cnpj)) : pdfSafeText(asset.identificador ?? "-"),
      classificacao: pdfSafeText(asset.nivel1_categoria ?? asset.tipo_investidor ?? asset.tipo ?? "-"),
      valor: value,
      percentual: percentage,
      limite: limit,
      status: inferredStatus,
    };
  });
}

// ── Helpers tributários (Art. 4º / Art. 5º) ─────────────────────────────────

export interface TribHistoricoItem {
  data: string;
  p_dia: number;
  mm_10d: number;
  status: "ok" | "alerta" | "violacao";
}

export interface TribArt4Ativo {
  nome: string;
  cnpj?: string | null;
  valor: number;
  percentual: number;
  prazo_dias: number | null;
  contribuicao_dias?: number | null;
  tipo: string;
  motivo?: string;
  section: string;
}

export function isTribArt4Rule(r: Pick<ExportEnquadramentoRule, "regra_codigo" | "regra_categoria">): boolean {
  const codigo = (r.regra_codigo ?? "").toUpperCase();
  const cat = (r.regra_categoria ?? "").toLowerCase();
  return (
    cat === "tributario-art4" ||
    cat === "tributario-art4-fidc" ||
    codigo === "TRIB_FIM_LP_365" ||
    codigo === "TRIB_FIDC_LP_365"
  );
}

export function isTribArt5Rule(r: Pick<ExportEnquadramentoRule, "regra_codigo" | "regra_categoria">): boolean {
  return r.regra_categoria === "tributario" && r.regra_codigo === "TRIB_FIQ_LP_90";
}

function tribArt4SemanticRgb(status: "ok" | "alerta" | "violacao"): RGB {
  if (status === "violacao") return STATUS_HARD;
  if (status === "alerta") return STATUS_SOFT;
  return STATUS_OK;
}

export function art4ClassificacaoLabel(asset: TribArt4Ativo): string {
  if (asset.tipo === "excluido") return "excluído §5º";
  if (asset.section === "cotas" && asset.prazo_dias === 366) return "LP 366d fixos";
  if (asset.section === "cotas" && asset.prazo_dias === 1) return "CP 1d fixo";
  if (asset.section === "titpublico" || asset.section === "titprivado") return "RF dias corridos";
  return asset.tipo === "contabilizado" ? "contabilizado" : String(asset.tipo ?? "—");
}

function tribArt5LimitePct(det: Record<string, unknown>): number {
  if (det.limite_mm != null) return Number(det.limite_mm);
  const l = Number(det.limite ?? 90);
  return l <= 1 ? l * 100 : l;
}

function tribArt5AlertaPct(det: Record<string, unknown>): number {
  if (det.alerta_mm != null) return Number(det.alerta_mm);
  const a = Number(det.alerta_inferior ?? 92);
  return a <= 1 ? a * 100 : a;
}

function tribArt5StatusFromMm(mmPct: number, limitePct: number, alertaPct: number): "ok" | "alerta" | "violacao" {
  if (mmPct >= alertaPct) return "ok";
  if (mmPct >= limitePct) return "alerta";
  return "violacao";
}

function subtractDaysYmd(ymd: string, daysBack: number): string {
  const clean = ymd.replace(/\D/g, "");
  if (clean.length !== 8) return clean || "00000000";
  const d = new Date(
    Number(clean.slice(0, 4)),
    Number(clean.slice(4, 6)) - 1,
    Number(clean.slice(6, 8)),
  );
  d.setDate(d.getDate() - daysBack);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("");
}

/** Monta série histórica Art. 5º a partir de detalhes.historico ou janela_p_dia. */
export function buildHistoricoArt5(
  det: Record<string, unknown>,
  rule: ExportEnquadramentoRule,
): TribHistoricoItem[] {
  const rawHist = det.historico;
  const limitePct = tribArt5LimitePct(det);
  const alertaPct = tribArt5AlertaPct(det);

  if (Array.isArray(rawHist) && rawHist.length > 0) {
    return rawHist.map((h: Record<string, unknown>) => {
      const pRaw = Number(h.p_dia ?? 0);
      const mmRaw = Number(h.mm_10d ?? 0);
      const pPct = pRaw <= 1 ? pRaw * 100 : pRaw;
      const mmPct = mmRaw <= 1 ? mmRaw * 100 : mmRaw;
      const st = (h.status as TribHistoricoItem["status"]) ??
        tribArt5StatusFromMm(mmPct, limitePct, alertaPct);
      return {
        data: String(h.data ?? h.data_referencia ?? "").replace(/\D/g, "").slice(0, 8),
        p_dia: pPct / 100,
        mm_10d: mmPct / 100,
        status: st,
      };
    });
  }

  const janela = Array.isArray(det.janela_p_dia) ? (det.janela_p_dia as number[]) : [];
  const pAtual = Number(det.p_dia ?? (rule.valor_atual != null ? rule.valor_atual * 100 : 0));
  const valores = [...janela, pAtual].filter((v) => Number.isFinite(v));
  if (valores.length === 0) return [];

  const dataRef = String(det.data_referencia ?? det.dt_posicao_efetiva ?? "")
    .replace(/\D/g, "")
    .slice(0, 8);

  return valores.map((pPct, idx) => {
    const slice = valores.slice(Math.max(0, idx - 9), idx + 1);
    const mmPct = slice.reduce((s, v) => s + v, 0) / slice.length;
    const daysBack = valores.length - 1 - idx;
    return {
      data: dataRef ? subtractDaysYmd(dataRef, daysBack) : String(idx).padStart(8, "0"),
      p_dia: pPct / 100,
      mm_10d: mmPct / 100,
      status: tribArt5StatusFromMm(mmPct, limitePct, alertaPct),
    };
  });
}

function hexToRgb(hex: string): RGB {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

async function renderChartArt5ToPng(
  historico: TribHistoricoItem[],
  limite: number,
  alerta: number,
  canvasW = 1800,
  canvasH = 420,
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  canvas.style.position = "fixed";
  canvas.style.opacity = "0";
  canvas.style.pointerEvents = "none";
  document.body.appendChild(canvas);

  const formatLabel = (d: string) => `${d.slice(6, 8)}/${d.slice(4, 6)}`;
  const labels = historico.map((h) => formatLabel(h.data));
  const pDia = historico.map((h) => parseFloat((h.p_dia * 100).toFixed(2)));
  const mm10d = historico.map((h) => parseFloat((h.mm_10d * 100).toFixed(2)));

  const limPct = limite * 100;
  const alertPct = alerta * 100;

  const pointColorsMm = mm10d.map((v) =>
    v < limPct ? "#DC2626" : v < alertPct ? "#D97706" : "#1D9E75",
  );
  const pointColorsPd = pDia.map((v) =>
    v < limPct ? "#DC2626" : v < alertPct ? "#D97706" : "#378ADD",
  );

  const allVals = [...pDia, ...mm10d];
  const yMin = Math.max(0, Math.floor(Math.min(...allVals) - 3));
  const yMax = Math.min(110, Math.ceil(Math.max(...allVals) + 2));

  const chart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "p do dia (% LP)",
          data: pDia,
          borderColor: "#378ADD",
          backgroundColor: "transparent",
          pointBackgroundColor: pointColorsPd,
          pointBorderColor: pointColorsPd,
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 1.5,
          tension: 0,
        },
        {
          label: "MM-10d",
          data: mm10d,
          borderColor: "#1D9E75",
          backgroundColor: "transparent",
          pointBackgroundColor: pointColorsMm,
          pointBorderColor: pointColorsMm,
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
          tension: 0,
        },
      ],
    },
    options: {
      animation: false,
      responsive: false,
      plugins: {
        legend: { display: false },
        annotation: {
          annotations: {
            zonaViolacao: {
              type: "box",
              yMin,
              yMax: limPct,
              backgroundColor: "rgba(254, 242, 242, 0.6)",
              borderWidth: 0,
            },
            zonaAlerta: {
              type: "box",
              yMin: limPct,
              yMax: alertPct,
              backgroundColor: "rgba(255, 251, 235, 0.6)",
              borderWidth: 0,
            },
            linhaLimite: {
              type: "line",
              yMin: limPct,
              yMax: limPct,
              borderColor: "#DC2626",
              borderWidth: 1,
              borderDash: [6, 4],
            },
            linhaAlerta: {
              type: "line",
              yMin: alertPct,
              yMax: alertPct,
              borderColor: "#D97706",
              borderWidth: 1,
              borderDash: [4, 4],
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            font: { size: 11 },
            color: "#6B7280",
            maxTicksLimit: 20,
            maxRotation: 0,
          },
          grid: { color: "rgba(0,0,0,0.05)" },
        },
        y: {
          min: yMin,
          max: yMax,
          ticks: {
            font: { size: 11 },
            color: "#6B7280",
            callback: (v) => `${Number(v).toFixed(0)}%`,
          },
          grid: { color: "rgba(0,0,0,0.07)" },
        },
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  const imgData = canvas.toDataURL("image/png", 1.0);
  chart.destroy();
  document.body.removeChild(canvas);
  return imgData;
}

const ART4_NORMA_FOOTER =
  "Prazo médio calculado conforme Art. 4º IN RFB 1.585/2015: cotas de fundo LP = 366 dias fixos " +
  "(§4º), cotas de fundo CP = 1 dia fixo (§3º), títulos RF = dias corridos até vencimento (§2º inciso I). " +
  "FII, FIA, FIP, CCB e COE excluídos (§5º).";

const ART5_NORMA_NOTE =
  "Enquadramento calculado conforme Art. 5º IN RFB 1.585/2015: o FIQ deve manter no mínimo 90% " +
  "do PL em cotas de fundos LP tributários, medido pela média móvel de 10 dias úteis (MM-10d). " +
  "FII são computados fora do LP.";

// ── PDF Consolidado de Enquadramento ─────────────────────────────────────────
export async function exportEnquadramentoConsolidadoPdf(
  fundos: EnquadramentoFundoRow[],
  dataRef: string,
  options: ExportEnquadramentoConsolidadoPdfOptions = {},
): Promise<void> {
  const { titulo = "RELATÓRIO DE ENQUADRAMENTO", layout = "simples", fileName } = options;
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  const logo = await loadLogoAsBase64();

  const sf = (c: RGB) => pdf.setFillColor(c[0], c[1], c[2]);
  const sd = (c: RGB) => pdf.setDrawColor(c[0], c[1], c[2]);
  const st = (c: RGB) => pdf.setTextColor(c[0], c[1], c[2]);
  const lw = (w: number) => pdf.setLineWidth(w);

  const HEADER_H = 26;

  const drawHeader = (isFirst: boolean) => {
    sf(WHITE); pdf.rect(0, 0, pageW, HEADER_H, "F");
    sf(BRAND_GREEN); pdf.rect(0, 0, pageW, 2.5, "F");
    sd(BORDER); lw(0.3); pdf.line(0, HEADER_H, pageW, HEADER_H);

    let textX = MARGIN;
    if (logo) {
      const lh = 14;
      const lw2 = lh * logo.ratio;
      pdf.addImage(logo.data, "PNG", MARGIN, 5, lw2, lh);
      textX = MARGIN + lw2 + 10;
    }

    if (isFirst) {
      pdf.setFontSize(12); pdf.setFont("helvetica", "bold"); st(INK);
      pdf.text(titulo, textX, 13);
      pdf.setFontSize(7.5); pdf.setFont("helvetica", "normal"); st(BRAND_GRAY2);
      pdf.text("Compliance e Enquadramento de Carteiras", textX, 20);
    }

    const dX = pageW - MARGIN;
    pdf.setFontSize(6.5); pdf.setFont("helvetica", "normal"); st(BRAND_GRAY2);
    pdf.text("DATA DE REFERÊNCIA", dX, 11, { align: "right" });
    pdf.setFontSize(11); pdf.setFont("helvetica", "bold"); st(INK);
    pdf.text(dataRef, dX, 20, { align: "right" });
  };

  const drawFooter = (pageNum: number, totalPages: number) => {
    sd(BORDER); lw(0.3);
    pdf.line(MARGIN, pageH - 13, pageW - MARGIN, pageH - 13);
    pdf.setFontSize(6.5); pdf.setFont("helvetica", "normal"); st(BRAND_GRAY2);
    const now = new Date();
    const genDate = now.toLocaleDateString("pt-BR") + " " +
      now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    pdf.text("CVPAR Quadrante — Documento Confidencial para Uso Interno", MARGIN, pageH - 8);
    pdf.text(`Gerado em: ${genDate}`, pageW / 2, pageH - 8, { align: "center" });
    pdf.text(`Página ${pageNum} de ${totalPages}`, pageW - MARGIN, pageH - 8, { align: "right" });
  };

  drawHeader(true);
  let curY = HEADER_H + 6;

  // Contagens
  const total = fundos.length;
  const nOk = fundos.filter(f => f.statusDetail === "ok").length;
  const nAlerta = fundos.filter(f => f.statusDetail === "alerta").length;
  const nViolacao = fundos.filter(f => f.statusDetail === "violacao").length;
  const nPendente = fundos.filter(f => f.statusDetail === "pendente").length;

  const CARD_H = 17;
  const GAP = 4;
  const N_CARDS = 5;
  const cardW = (pageW - 2 * MARGIN - (N_CARDS - 1) * GAP) / N_CARDS;
  const pctOf = (n: number) => total > 0 ? `${((n / total) * 100).toFixed(0)}%` : "—";

  const cards = [
    { label: "TOTAL DE FUNDOS", value: String(total), valColor: INK, accentColor: BRAND_GRAY1 },
    { label: "REGULAR",   value: String(nOk),      pct: pctOf(nOk),      valColor: STATUS_OK,   accentColor: STATUS_OK   },
    { label: "ALERTA",    value: String(nAlerta),   pct: pctOf(nAlerta),  valColor: STATUS_SOFT, accentColor: STATUS_SOFT },
    { label: "VIOLAÇÃO",  value: String(nViolacao), pct: pctOf(nViolacao),valColor: STATUS_HARD, accentColor: STATUS_HARD },
    { label: "PENDENTE",  value: String(nPendente), pct: pctOf(nPendente),valColor: STATUS_PEND, accentColor: BRAND_GRAY2 },
  ];

  cards.forEach((card, i) => {
    const x = MARGIN + i * (cardW + GAP);
    sf(WHITE); pdf.roundedRect(x, curY, cardW, CARD_H, 1, 1, "F");
    sd(BORDER); lw(0.3); pdf.roundedRect(x, curY, cardW, CARD_H, 1, 1, "S");
    sf(card.accentColor); pdf.rect(x, curY, cardW, 2, "F");
    pdf.setFontSize(6); pdf.setFont("helvetica", "bold"); st(BRAND_GRAY1);
    pdf.text(card.label, x + cardW / 2, curY + 7, { align: "center" });
    pdf.setFontSize(14); pdf.setFont("helvetica", "bold"); st(card.valColor);
    pdf.text(card.value, x + cardW / 2, curY + 13.5, { align: "center" });
    if ("pct" in card && card.pct) {
      pdf.setFontSize(6); pdf.setFont("helvetica", "normal"); st(BRAND_GRAY2);
      pdf.text(card.pct, x + cardW / 2, curY + CARD_H - 1, { align: "center" });
    }
  });
  curY += CARD_H + 7;

  // Barra de distribuição
  if (total > 0) {
    const BAR_H = 5;
    const BAR_W = pageW - 2 * MARGIN;
    pdf.setFontSize(6); pdf.setFont("helvetica", "bold"); st(BRAND_GRAY1);
    pdf.text("DISTRIBUIÇÃO POR STATUS", MARGIN, curY + 1);
    const barY = curY + 4;
    let bx = MARGIN;
    const segs = [
      { count: nOk,       color: STATUS_OK,   label: "Regular"  },
      { count: nAlerta,   color: STATUS_SOFT, label: "Alerta"   },
      { count: nViolacao, color: STATUS_HARD, label: "Violação" },
      { count: nPendente, color: BRAND_GRAY2, label: "Pendente" },
    ].filter(s => s.count > 0);
    for (const seg of segs) {
      const w = (seg.count / total) * BAR_W;
      sf(seg.color); pdf.rect(bx, barY, w, BAR_H, "F");
      bx += w;
    }
    let lx = MARGIN;
    const legY = barY + BAR_H + 5;
    for (const seg of segs) {
      sf(seg.color); pdf.rect(lx, legY - 2.5, 4.5, 3, "F");
      pdf.setFontSize(6.5); pdf.setFont("helvetica", "normal"); st(INK);
      const p = `${((seg.count / total) * 100).toFixed(0)}%`;
      pdf.text(`${seg.label}: ${seg.count} (${p})`, lx + 6.5, legY);
      lx += 58;
    }
    curY += 4 + BAR_H + 13;
  }

  pdf.setFontSize(6); pdf.setFont("helvetica", "bold"); st(BRAND_GRAY1);
  pdf.text("DETALHAMENTO POR FUNDO", MARGIN, curY);
  curY += 4;

  const fmtCount = (n: number | undefined) => (n != null && n > 0 ? String(n) : "—");

  const isCompleto = layout === "completo";
  const tableHead = isCompleto
    ? [["Fundo", "CNPJ", "Administrador", "PL", "Regras", "Violações", "Status"]]
    : [["Fundo", "CNPJ", "Data", "Status"]];

  const tableRows = isCompleto
    ? fundos.map(f => [
        f.nome_fundo || "—",
        fmtCnpj(f.fundo_cnpj),
        f.administrador || "—",
        f.pl != null ? fmtBRL(f.pl) : "—",
        fmtCount(f.nRegras),
        fmtCount(f.nViolacoes),
        enquadramentoStatusLabel(f.statusDetail),
      ])
    : fundos.map(f => [
        f.nome_fundo || "—",
        fmtCnpj(f.fundo_cnpj),
        f.dt_posicao?.replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1") || "—",
        enquadramentoStatusLabel(f.statusDetail),
      ]);

  const statusColIdx = isCompleto ? 6 : 3;
  const violColIdx = isCompleto ? 5 : -1;

  autoTable(pdf, {
    startY: curY,
    head: tableHead,
    body: tableRows,
    margin: { left: MARGIN, right: MARGIN, bottom: 18 },
    styles: {
      fontSize: 7.5,
      cellPadding: { top: 2.5, right: 3, bottom: 2.5, left: 3 },
      lineColor: BORDER, lineWidth: 0.2, textColor: INK,
    },
    headStyles: {
      fillColor: BRAND_GRAY1, textColor: WHITE, fontStyle: "bold",
      fontSize: 7.5, cellPadding: { top: 3.5, right: 3, bottom: 3.5, left: 3 },
    },
    alternateRowStyles: { fillColor: BG_ROW },
    columnStyles: isCompleto
      ? {
          0: { cellWidth: 62, fontStyle: "bold" },
          1: { cellWidth: 38, font: "courier", fontSize: 7, textColor: BRAND_GRAY2 },
          2: { cellWidth: 42 },
          3: { cellWidth: 28, halign: "right", font: "courier", fontSize: 7 },
          4: { cellWidth: 16, halign: "center" },
          5: { cellWidth: 20, halign: "center", fontStyle: "bold" },
          6: { halign: "center", fontStyle: "bold" },
        }
      : {
          0: { cellWidth: 110, fontStyle: "bold" },
          1: { cellWidth: 45, font: "courier", fontSize: 7, textColor: BRAND_GRAY2 },
          2: { cellWidth: 28, halign: "center", font: "courier" },
          3: { halign: "center", fontStyle: "bold" },
        },
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const idx = data.row.index;
      if (idx < 0 || idx >= fundos.length) return;

      if (data.column.index === statusColIdx) {
        data.cell.styles.halign = "center";
        const s = fundos[idx].statusDetail;
        if (s === "ok")       { data.cell.styles.textColor = STATUS_OK;   data.cell.styles.fillColor = STATUS_OK_BG;   }
        else if (s === "alerta")   { data.cell.styles.textColor = STATUS_SOFT; data.cell.styles.fillColor = STATUS_SOFT_BG; }
        else if (s === "violacao") { data.cell.styles.textColor = STATUS_HARD; data.cell.styles.fillColor = STATUS_HARD_BG; }
        else { data.cell.styles.textColor = STATUS_PEND; }
      }

      if (violColIdx >= 0 && data.column.index === violColIdx) {
        const n = fundos[idx].nViolacoes;
        if (n != null && n > 0) data.cell.styles.textColor = STATUS_HARD;
      }
    },
    didDrawPage: (data) => { if (data.pageNumber > 1) drawHeader(false); },
  });

  const totalPages = pdf.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) { pdf.setPage(i); drawFooter(i, totalPages); }

  const today = new Date();
  const ts = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("");
  const baseName = fileName ?? `Enquadramento_${dataRef.replace(/\//g, "-")}_${ts}`;
  pdf.save(`${baseName}.pdf`);
}

// ── PDF Detalhado por Fundo (Enquadramento) ───────────────────────────────────
export async function exportEnquadramentoFundoPdf(
  info: ExportEnquadramentoFundoInfo,
  rules: ExportEnquadramentoRule[],
  assets: ExportWalletAsset[] = [],
): Promise<void> {
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  const logo = await loadLogoAsBase64();

  const sf = (c: RGB) => pdf.setFillColor(c[0], c[1], c[2]);
  const sd = (c: RGB) => pdf.setDrawColor(c[0], c[1], c[2]);
  const st = (c: RGB) => pdf.setTextColor(c[0], c[1], c[2]);
  const lw = (w: number) => pdf.setLineWidth(w);

  const worstStatus = info.worstStatus;
  const worstColor: RGB = worstStatus === "violacao"
    ? STATUS_HARD
    : worstStatus === "alerta"
      ? STATUS_SOFT
      : worstStatus === "pendente"
        ? STATUS_PEND
        : STATUS_OK;
  const worstBg: RGB = worstStatus === "violacao"
    ? STATUS_HARD_BG
    : worstStatus === "alerta"
      ? STATUS_SOFT_BG
      : worstStatus === "pendente"
        ? [241, 245, 249]
        : STATUS_OK_BG;
  const worstLabel = worstStatus === "violacao"
    ? "DESENQUADRADO"
    : worstStatus === "alerta"
      ? "ALERTA"
      : worstStatus === "pendente"
        ? "PENDENTE"
        : "REGULAR";

  const HEADER_H = 26;

  const drawHeader = (isFirst: boolean) => {
    sf(WHITE); pdf.rect(0, 0, pageW, HEADER_H, "F");
    sf(BRAND_GREEN); pdf.rect(0, 0, pageW, 2.5, "F");
    sd(BORDER); lw(0.3); pdf.line(0, HEADER_H, pageW, HEADER_H);

    let textX = MARGIN;
    if (logo) {
      const lh = 13; const lw2 = lh * logo.ratio;
      pdf.addImage(logo.data, "PNG", MARGIN, 5, lw2, lh);
      textX = MARGIN + lw2 + 10;
    }

    const maxW = pageW - textX - MARGIN - 50;
    if (isFirst) {
      pdf.setFontSize(10); pdf.setFont("helvetica", "bold"); st(INK);
      const nameLines = pdf.splitTextToSize(pdfSafeText(info.nomeFundo), maxW);
      pdf.text(nameLines[0], textX, 12);
      pdf.setFontSize(7); pdf.setFont("helvetica", "normal"); st(BRAND_GRAY2);
      pdf.text("Relatório de Enquadramento e Compliance", textX, 19);

      const badgeW = 42;
      const bX = pageW - MARGIN - badgeW;
      sf(worstBg); pdf.roundedRect(bX, 8, badgeW, 10, 1, 1, "F");
      sd(worstColor); lw(0.3); pdf.roundedRect(bX, 8, badgeW, 10, 1, 1, "S");
      pdf.setFontSize(7.5); pdf.setFont("helvetica", "bold"); st(worstColor);
      pdf.text(worstLabel, bX + badgeW / 2, 14.5, { align: "center" });
    } else {
      const compactName = pdfSafeText(info.nomeFundo).slice(0, 76);
      pdf.setFontSize(8); pdf.setFont("courier", "bold"); st(INK);
      pdf.text(compactName, textX, 11);
      pdf.setFontSize(6); pdf.setFont("courier", "normal"); st(BRAND_GRAY2);
      pdf.text(`DATA-BASE ${info.dataBase} | CNPJ ${info.cnpj}`, textX, 18);
      pdf.setFontSize(7); pdf.setFont("courier", "bold"); st(worstColor);
      pdf.text(worstLabel, pageW - MARGIN, 14, { align: "right" });
    }
  };

  const drawFooter = (pageNum: number, totalPages: number) => {
    sd(BORDER); lw(0.3);
    pdf.line(MARGIN, pageH - 13, pageW - MARGIN, pageH - 13);
    pdf.setFontSize(6.5); pdf.setFont("helvetica", "normal"); st(BRAND_GRAY2);
    const now = new Date();
    const genDate = now.toLocaleDateString("pt-BR") + " " +
      now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    pdf.text("CVPAR Quadrante - Documento Confidencial", MARGIN, pageH - 8);
    pdf.text(`Gerado em: ${genDate}`, pageW / 2, pageH - 8, { align: "center" });
    pdf.text(`Página ${pageNum} de ${totalPages}`, pageW - MARGIN, pageH - 8, { align: "right" });
  };

  drawHeader(true);
  let curY = HEADER_H + 5;

  // Barra de informações do fundo
  sf([248, 249, 250]); pdf.roundedRect(MARGIN, curY, pageW - 2 * MARGIN, 14, 1, 1, "F");
  sd(BORDER); lw(0.2); pdf.roundedRect(MARGIN, curY, pageW - 2 * MARGIN, 14, 1, 1, "S");

  const statusCounts = {
    regular: rules.filter((r) => r.status === "ok").length,
    alerta: rules.filter((r) => r.status === "alerta").length,
    violacao: rules.filter((r) => r.status === "violacao").length,
  };
  const infoItems = [
    { label: "CNPJ", value: info.cnpj },
    { label: "ISIN", value: info.isin || "-" },
    { label: "DATA-BASE", value: info.dataBase },
    { label: "PATRIMÔNIO LÍQUIDO", value: fmtBRL(info.totalPL) },
    { label: "PRAZO DE RESGATE", value: info.prazoResgate != null ? `D+${info.prazoResgate}` : "-" },
    { label: "REGRAS", value: String(rules.length) },
    { label: "ALERTAS", value: String(statusCounts.alerta) },
    { label: "VIOLAÇÕES", value: String(statusCounts.violacao) },
  ];
  const iW = (pageW - 2 * MARGIN) / infoItems.length;
  infoItems.forEach((item, i) => {
    const ix = MARGIN + i * iW + iW / 2;
    pdf.setFontSize(5.5); pdf.setFont("helvetica", "bold"); st(BRAND_GRAY2);
    pdf.text(item.label, ix, curY + 4, { align: "center" });
    pdf.setFontSize(7); pdf.setFont("helvetica", "bold"); st(INK);
    pdf.text(item.value, ix, curY + 11, { align: "center" });
  });
  curY += 18;

  const sortOrder: Record<string, number> = { violacao: 0, alerta: 1, ok: 2 };

  const ensureSpace = (needed: number) => {
    if (curY + needed > pageH - 20) {
      pdf.addPage("a4", "landscape");
      drawHeader(false);
      curY = HEADER_H + 5;
    }
  };

  const drawSectionTitle = (title: string) => {
    ensureSpace(8);
    pdf.setFontSize(6);
    pdf.setFont("helvetica", "bold");
    st(BRAND_GRAY1);
    pdf.text(title, MARGIN, curY);
    curY += 5;
  };

  const drawMetricBox = (
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    value: string,
    valueRgb: RGB,
  ) => {
    sf(WHITE);
    sd(BORDER);
    lw(0.2);
    pdf.roundedRect(x, y, w, h, 1, 1, "FD");
    pdf.setFontSize(5);
    pdf.setFont("helvetica", "bold");
    st(BRAND_GRAY2);
    pdf.text(label, x + w / 2, y + 4, { align: "center" });
    pdf.setFontSize(8);
    pdf.setFont("helvetica", "bold");
    st(valueRgb);
    pdf.text(value, x + w / 2, y + 10, { align: "center" });
  };

  // Resumo executivo e matriz de regras: leitura rápida antes da memória de cálculo.
  drawSectionTitle("RESUMO EXECUTIVO");
  const summaryText = rules.length === 0
    ? "Nenhuma regra foi verificada para esta posição. Rode a verificação antes de utilizar o relatório."
    : worstStatus === "violacao"
      ? `${statusCounts.violacao} regra(s) violada(s) e ${statusCounts.alerta} em alerta. Priorize os itens em vermelho na memória de cálculo.`
      : worstStatus === "alerta"
        ? `Nenhuma violação identificada; ${statusCounts.alerta} regra(s) exige(m) acompanhamento por proximidade do limite ou ressalva de dados.`
        : `Carteira regular nas ${rules.length} regra(s) verificadas, com ${statusCounts.regular} resultado(s) em conformidade.`;
  const summaryLines = pdf.splitTextToSize(pdfSafeText(summaryText), pageW - 2 * MARGIN - 8);
  const summaryH = Math.max(12, summaryLines.length * 3.2 + 6);
  sf(worstBg); sd(worstColor); lw(0.25);
  pdf.roundedRect(MARGIN, curY, pageW - 2 * MARGIN, summaryH, 1, 1, "FD");
  sf(worstColor); pdf.rect(MARGIN, curY, 2, summaryH, "F");
  pdf.setFontSize(7.5); pdf.setFont("helvetica", "bold"); st(worstColor);
  pdf.text(worstLabel, MARGIN + 5, curY + 5);
  pdf.setFontSize(7); pdf.setFont("helvetica", "normal"); st(INK);
  pdf.text(summaryLines, MARGIN + 5, curY + 9);
  curY += summaryH + 6;

  const rulesSorted = [...rules].sort((a, b) => {
    const statusDiff = (sortOrder[a.status] ?? 3) - (sortOrder[b.status] ?? 3);
    if (statusDiff !== 0) return statusDiff;
    return a.regra_codigo.localeCompare(b.regra_codigo, "pt-BR");
  });

  if (rulesSorted.length > 0) {
    drawSectionTitle("MATRIZ DE REGRAS");
    autoTable(pdf, {
      startY: curY,
      head: [["#", "Código / Regra", "Categoria", "Critério", "Apurado", "Margem", "Status"]],
      body: rulesSorted.map((rule, index) => {
        const view = buildEnquadramentoRulePdfPresentation(rule);
        return [
          String(index + 1),
          `${pdfSafeText(rule.regra_codigo)}\n${pdfSafeText(rule.regra_descricao)}`,
          pdfSafeText(CATEGORY_LABELS[rule.regra_categoria] || rule.regra_categoria),
          pdfSafeText(view.criterionDisplay),
          pdfSafeText(view.currentDisplay),
          pdfSafeText(view.marginDisplay),
          enquadramentoStatusLabel(rule.status),
        ];
      }),
      margin: { left: MARGIN, right: MARGIN, bottom: 18 },
      styles: {
        fontSize: 6,
        cellPadding: { top: 2, right: 1.5, bottom: 2, left: 1.5 },
        lineColor: BORDER,
        lineWidth: 0.15,
        textColor: INK,
        overflow: "linebreak",
        valign: "middle",
      },
      headStyles: { fillColor: BRAND_GRAY1, textColor: WHITE, fontStyle: "bold", fontSize: 5.7 },
      alternateRowStyles: { fillColor: BG_ROW },
      columnStyles: {
        0: { cellWidth: 8, halign: "center", font: "courier" },
        1: { cellWidth: 94, fontStyle: "bold" },
        2: { cellWidth: 34 },
        3: { cellWidth: 49, font: "courier", fontSize: 5.5 },
        4: { cellWidth: 28, halign: "right", font: "courier", fontStyle: "bold" },
        5: { cellWidth: 31, halign: "right", font: "courier" },
        6: { cellWidth: 33, halign: "center", fontStyle: "bold" },
      },
      didParseCell: (data) => {
        if (data.section !== "body") return;
        const rule = rulesSorted[data.row.index];
        if (!rule) return;
        const color = rule.status === "violacao" ? STATUS_HARD : rule.status === "alerta" ? STATUS_SOFT : STATUS_OK;
        const bg = rule.status === "violacao" ? STATUS_HARD_BG : rule.status === "alerta" ? STATUS_SOFT_BG : STATUS_OK_BG;
        if (data.column.index === 4 || data.column.index === 5) data.cell.styles.textColor = color;
        if (data.column.index === 6) {
          data.cell.styles.textColor = color;
          data.cell.styles.fillColor = bg;
        }
      },
      didDrawPage: (data) => { if (data.pageNumber > 1) drawHeader(false); },
    });
    const matrixTable = (pdf as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    curY = matrixTable ? matrixTable.finalY + 7 : curY + 10;
  }

  const regraArt4 = rules.find((r) => isTribArt4Rule(r));
  const regraArt5 = rules.find((r) => isTribArt5Rule(r));
  const regrasDemais = rules
    .filter((r) => !isTribArt4Rule(r) && !isTribArt5Rule(r))
    .sort((a, b) => (sortOrder[a.status] ?? 3) - (sortOrder[b.status] ?? 3));

  // ── Bloco Art. 4º FIM ───────────────────────────────────────────────────────
  if (regraArt4) {
    pdf.addPage("a4", "landscape");
    drawHeader(false);
    curY = HEADER_H + 5;

    const det = (regraArt4.detalhes ?? {}) as Record<string, unknown>;
    const prazoMedio = Number(det.prazo_medio_dias ?? 0);
    const limiteDias = Number(det.limite_dias ?? 365);
    const patliq = Number(det.patliq ?? 0);
    const valorElegivel = Number(det.valor_elegivel ?? 0);
    const statusArt4 = regraArt4.status;
    const semColor = tribArt4SemanticRgb(statusArt4);
    const margem = prazoMedio - limiteDias;
    const margemStr = `${margem >= 0 ? "+" : ""}${margem.toFixed(2)}d`;

    drawSectionTitle(`TRIBUTÁRIO ART. 4º — ${regraArt4.regra_descricao}`);

    const contentW = pageW - 2 * MARGIN;
    const boxW = contentW / 4 - 2;
    const boxH = 14;
    const boxY = curY;
    drawMetricBox(MARGIN, boxY, boxW, boxH, "PRAZO MÉDIO", `${prazoMedio.toFixed(2)}d`, semColor);
    drawMetricBox(MARGIN + boxW + 2, boxY, boxW, boxH, "LIMITE LP", `${limiteDias},00d`, INK);
    drawMetricBox(MARGIN + (boxW + 2) * 2, boxY, boxW, boxH, "MARGEM", margemStr, semColor);
    drawMetricBox(MARGIN + (boxW + 2) * 3, boxY, boxW, boxH, "PL DO FUNDO", fmtBRL(patliq), INK);
    curY += boxH + 5;

    // Barra de progresso 0–500d
    const BAR_H = 4;
    const barW = contentW;
    const maxScale = 500;
    const barX = MARGIN;
    sf([240, 240, 240]);
    pdf.rect(barX, curY, barW, BAR_H, "F");
    const fillW = Math.min(barW, (prazoMedio / maxScale) * barW);
    sf(semColor);
    pdf.rect(barX, curY, fillW, BAR_H, "F");
    const limX = barX + (limiteDias / maxScale) * barW;
    sd(STATUS_HARD);
    lw(0.4);
    pdf.line(limX, curY - 0.5, limX, curY + BAR_H + 0.5);
    curY += BAR_H + 2;
    pdf.setFontSize(5);
    pdf.setFont("helvetica", "normal");
    st(BRAND_GRAY2);
    pdf.text("0d", barX, curY);
    pdf.text(`limite ${limiteDias}d`, limX, curY, { align: "center" });
    pdf.text("500d", barX + barW, curY, { align: "right" });
    curY += 5;

    const ativos = ((det.ativos_contabilizados ?? []) as TribArt4Ativo[]);
    if (ativos.length > 0) {
      const pesoTotal = ativos
        .filter((a) => a.tipo !== "excluido")
        .reduce((s, a) => s + Number(a.percentual ?? 0), 0);

      const assetBody = ativos.map((a) => {
        const excl = a.tipo === "excluido";
        return [
          a.nome,
          new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(a.valor),
          excl || a.prazo_dias == null ? "—" : `${Math.round(a.prazo_dias)}d`,
          excl ? "—" : `${(Number(a.percentual) * 100).toFixed(1)}%`,
          excl || a.contribuicao_dias == null ? "—" : `${Number(a.contribuicao_dias).toFixed(2).replace(".", ",")}d`,
          art4ClassificacaoLabel(a),
        ];
      });

      assetBody.push([
        "total",
        new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(valorElegivel),
        "—",
        `${(pesoTotal * 100).toFixed(1)}%`,
        `${prazoMedio.toFixed(2).replace(".", ",")}d`,
        String(det.classificacao_tributaria ?? "").toUpperCase() || "—",
      ]);

      autoTable(pdf, {
        startY: curY,
        head: [["Ativo", "Valor (R$)", "Prazo", "Peso %", "Contribuição (dias)", "Classificação"]],
        body: assetBody,
        margin: { top: HEADER_H + 5, left: MARGIN, right: MARGIN, bottom: 18 },
        styles: {
          fontSize: 6.5,
          cellPadding: { top: 2, right: 2, bottom: 2, left: 2 },
          lineColor: BORDER,
          lineWidth: 0.15,
          textColor: INK,
        },
        headStyles: {
          fillColor: BRAND_GRAY1,
          textColor: WHITE,
          fontStyle: "bold",
          fontSize: 6,
        },
        alternateRowStyles: { fillColor: BG_ROW },
        columnStyles: {
          0: { cellWidth: 100, fontStyle: "bold" },
          1: { cellWidth: 42, halign: "right", font: "courier", fontSize: 6 },
          2: { cellWidth: 24, halign: "center", font: "courier" },
          3: { cellWidth: 24, halign: "right", font: "courier" },
          4: { cellWidth: 47, halign: "right", font: "courier" },
          5: { cellWidth: 40, halign: "center", fontSize: 6 },
        },
        didParseCell: (data) => {
          if (data.section !== "body") return;
          const rowIdx = data.row.index;
          const isTotal = rowIdx === assetBody.length - 1;
          const asset = ativos[rowIdx];
          if (isTotal) {
            data.cell.styles.fontStyle = "bold";
            if (data.column.index === 4) {
              data.cell.styles.textColor = semColor;
              data.cell.styles.fontSize = 7.5;
            }
            return;
          }
          if (asset?.tipo === "excluido") {
            data.cell.styles.textColor = BRAND_GRAY2;
            data.cell.styles.fontStyle = "italic";
          }
        },
        didDrawPage: (data) => { if (data.pageNumber > 1) drawHeader(false); },
      });
      const lastT = (pdf as { lastAutoTable?: { finalY: number } }).lastAutoTable;
      curY = lastT ? lastT.finalY + 3 : curY + 10;
    }

    pdf.setFontSize(5);
    pdf.setFont("helvetica", "italic");
    st(BRAND_GRAY2);
    const footLines = pdf.splitTextToSize(ART4_NORMA_FOOTER, pageW - 2 * MARGIN);
    ensureSpace(footLines.length * 3 + 4);
    pdf.text(footLines, MARGIN, curY);
    curY += footLines.length * 3 + 6;
  }

  // ── Bloco Art. 5º FIQ (renderizado após demais regras) ──────────────────────
  const _renderArt5 = async () => {
    if (!regraArt5) return;
    pdf.addPage("a4", "landscape");
    drawHeader(false);
    curY = HEADER_H + 5;

    const det = (regraArt5.detalhes ?? {}) as Record<string, unknown>;
    const m = resolveTributarioMetrics(det, null, regraArt5.valor_atual);
    const limitePct = tribArt5LimitePct(det);
    const alertaPct = tribArt5AlertaPct(det);
    const mmColor = tribArt4SemanticRgb(tribArt5StatusFromMm(m.mm_10d, limitePct, alertaPct));
    const eventosLim = Number(det.eventos_limite ?? 3);
    const diasLim = Number(det.dias_limite ?? 45);

    drawSectionTitle(`TRIBUTÁRIO ART. 5º — ${regraArt5.regra_descricao}`);

    const contentW = pageW - 2 * MARGIN;
    const compW = contentW / 3 - 2;
    const compH = 16;
    const compY = curY;

    const compBlocks = [
      { label: "LONGO PRAZO (LP)", pct: m.pctLP, val: m.valor_lp, bg: STATUS_OK_BG, fg: STATUS_OK },
      { label: "CURTO PRAZO (CP)", pct: m.pctCP, val: m.valor_cp, bg: STATUS_SOFT_BG, fg: STATUS_SOFT },
      { label: "FII (FORA DO LP)", pct: m.pctExc, val: m.valor_excluido, bg: [241, 245, 249] as RGB, fg: BRAND_GRAY2 },
    ];
    compBlocks.forEach((b, i) => {
      const x = MARGIN + i * (compW + 2);
      sf(b.bg);
      sd(BORDER);
      lw(0.2);
      pdf.roundedRect(x, compY, compW, compH, 1, 1, "FD");
      pdf.setFontSize(5);
      pdf.setFont("helvetica", "bold");
      st(BRAND_GRAY2);
      pdf.text(b.label, x + compW / 2, compY + 4, { align: "center" });
      pdf.setFontSize(7.5);
      pdf.setFont("helvetica", "bold");
      st(b.fg);
      pdf.text(`${b.pct.toFixed(2)}%`, x + compW / 2, compY + 9, { align: "center" });
      pdf.setFontSize(5.5);
      pdf.setFont("helvetica", "normal");
      st(BRAND_GRAY2);
      pdf.text(fmtBRL(b.val), x + compW / 2, compY + 13.5, { align: "center" });
    });
    curY += compH + 5;

    const boxW = contentW / 6 - 1.5;
    const boxH = 14;
    const boxY = curY;
    const metrics = [
      { label: "MM-10D ATUAL", value: `${m.mm_10d.toFixed(2)}%`, color: mmColor },
      { label: "P DO DIA", value: `${m.p_dia.toFixed(2)}%`, color: INK },
      { label: "LIMITE", value: `${limitePct.toFixed(0)},00%`, color: INK },
      { label: "STATUS", value: enquadramentoStatusLabel(regraArt5.status), color: tribArt4SemanticRgb(regraArt5.status) },
      { label: "EVENTOS NO ANO", value: `${m.eventos_ano} / ${eventosLim}`, color: INK },
      { label: "DIAS EM VIOLAÇÃO", value: `${m.dias_violacao_ano} / ${diasLim}`, color: INK },
    ];
    metrics.forEach((met, i) => {
      drawMetricBox(MARGIN + i * (boxW + 1.5), boxY, boxW, boxH, met.label, met.value, met.color);
    });
    curY += boxH + 4;

    pdf.setFontSize(5);
    pdf.setFont("helvetica", "italic");
    st(BRAND_GRAY2);
    const noteLines = pdf.splitTextToSize(ART5_NORMA_NOTE, contentW);
    ensureSpace(noteLines.length * 3 + 4);
    pdf.text(noteLines, MARGIN, curY);
    curY += noteLines.length * 3 + 4;

    const historico = buildHistoricoArt5(det, regraArt5);
    if (historico.length > 0) {
      ensureSpace(50);
      pdf.setFontSize(6);
      pdf.setFont("helvetica", "bold");
      st(BRAND_GRAY2);
      pdf.text("HISTÓRICO DIÁRIO — P DO DIA (%) E MM-10D (%)", MARGIN, curY);
      curY += 4;

      const legendItems = [
        { color: "#378ADD", label: "p do dia (% LP)" },
        { color: "#1D9E75", label: "MM-10d" },
        { color: "#D97706", label: "alerta (90–92%)" },
        { color: "#DC2626", label: "violação (< 90%)" },
      ];
      let lx = MARGIN;
      for (const item of legendItems) {
        sf(hexToRgb(item.color));
        pdf.rect(lx, curY - 2.5, 8, 3, "F");
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(5.5);
        st(BRAND_GRAY2);
        pdf.text(item.label, lx + 10, curY);
        lx += 52;
      }
      curY += 5;

      try {
        const chartPng = await renderChartArt5ToPng(
          historico,
          limitePct / 100,
          alertaPct / 100,
        );
        const chartW = contentW;
        const chartH = chartW * (420 / 1800);
        ensureSpace(chartH + 4);
        pdf.addImage(chartPng, "PNG", MARGIN, curY, chartW, chartH);
        curY += chartH + 6;
      } catch (err) {
        console.error("[exportPdf] Erro ao renderizar gráfico Art. 5º:", err);
      }
    }
    curY += 4;
  };

  // ── Memória de cálculo das demais regras ────────────────────────────────────
  if (regrasDemais.length > 0) {
    const contentWd = pageW - 2 * MARGIN;
    const LINHA_H  = 7;

    const descW   = contentWd * 0.54;
    const categW  = contentWd * 0.12;
    const valW    = contentWd * 0.12;
    const limW    = contentWd * 0.11;
    const statusW = contentWd - descW - categW - valW - limW;

    const descX   = MARGIN;
    const categX  = descX  + descW;
    const valX    = categX + categW;
    const limX    = valX   + valW;
    const statusX = limX   + limW;

    const calcDetalheH = (r: ExportEnquadramentoRule): number => {
      const ativos = buildRulePdfAssets(r);
      const auditFields = buildRulePdfAuditFields(r);
      const view = buildEnquadramentoRulePdfPresentation(r);
      const explanationLines = pdf.splitTextToSize(pdfSafeText(view.explanation), contentWd - 12);
      const auditRows = Math.ceil(auditFields.length / 2);
      const assetsHeight = ativos.length > 0 ? 5 + ativos.length * 9 : 0;
      return 5 + 14 + explanationLines.length * 3.2 + 5 + auditRows * 7 + assetsHeight + 6;
    };

    const drawRulesDetailHeader = () => {
      drawSectionTitle("MEMÓRIA DE CÁLCULO - DEMAIS REGRAS");
      sf(BRAND_GRAY1);
      pdf.rect(MARGIN, curY, contentWd, LINHA_H - 1, "F");
      const hdrTextY = curY + (LINHA_H - 1) * 0.68;
      pdf.setFontSize(6); pdf.setFont("helvetica", "bold"); st(WHITE);
      pdf.text("Código / Regra", descX + 2, hdrTextY);
      pdf.text("Categoria", categX + categW / 2, hdrTextY, { align: "center" });
      pdf.text("Valor Atual", valX + valW - 2, hdrTextY, { align: "right" });
      pdf.text("Limite", limX + limW - 2, hdrTextY, { align: "right" });
      pdf.text("Status", statusX + statusW / 2, hdrTextY, { align: "center" });
      curY += LINHA_H;
    };

    let rowAlt = 0;
    for (const r of regrasDemais) {
      const isViolacao = r.status === "violacao";
      const isAlerta   = r.status === "alerta";
      const neededH = LINHA_H + calcDetalheH(r) + 2;
      if (rowAlt === 0 || curY + neededH > pageH - 20) {
        pdf.addPage("a4", "landscape");
        drawHeader(false);
        curY = HEADER_H + 5;
        drawRulesDetailHeader();
      }

      const stColor: RGB = isViolacao ? STATUS_HARD : isAlerta ? STATUS_SOFT : STATUS_OK;
      const stBg: RGB    = isViolacao ? STATUS_HARD_BG : isAlerta ? STATUS_SOFT_BG : STATUS_OK_BG;
      const rowBg: RGB   = isViolacao ? [254, 242, 242] : isAlerta ? [255, 251, 235]
                         : rowAlt % 2 === 0 ? WHITE : BG_ROW;
      const valRgb: RGB  = isViolacao ? STATUS_HARD : isAlerta ? STATUS_SOFT : STATUS_OK;

      // ── Linha compacta ───────────────────────────────────────────
      sf(rowBg); pdf.rect(MARGIN, curY, contentWd, LINHA_H, "F");
      sd(BORDER); lw(0.15); pdf.rect(MARGIN, curY, contentWd, LINHA_H, "S");
      sd([228, 228, 228]); lw(0.1);
      for (const cx of [categX, valX, limX, statusX]) {
        pdf.line(cx, curY, cx, curY + LINHA_H);
      }

      const textY = curY + LINHA_H * 0.66;
      const compactView = buildEnquadramentoRulePdfPresentation(r);

      pdf.setFontSize(7); pdf.setFont("helvetica", "bold"); st(INK);
      const descFit = pdf.splitTextToSize(`[${pdfSafeText(r.regra_codigo)}] ${pdfSafeText(r.regra_descricao)}`, descW - 4)[0];
      pdf.text(descFit, descX + 2, textY);

      pdf.setFontSize(5.5); pdf.setFont("helvetica", "normal"); st(BRAND_GRAY2);
      const catLabel = CATEGORY_LABELS[r.regra_categoria] || r.regra_categoria;
      pdf.text(catLabel, categX + categW / 2, textY, { align: "center" });

      pdf.setFontSize(7); pdf.setFont("courier", "bold"); st(valRgb);
      const valStr = compactView.currentDisplay;
      pdf.text(valStr, valX + valW - 2, textY, { align: "right" });

      pdf.setFontSize(7); pdf.setFont("courier", "normal"); st(BRAND_GRAY2);
      const limStr = compactView.limitDisplay;
      pdf.text(limStr, limX + limW - 2, textY, { align: "right" });

      const badgeW2  = statusW - 4;
      const badgeX2  = statusX + 2;
      sf(stBg); sd(stColor); lw(0.3);
      pdf.roundedRect(badgeX2, curY + 1.5, badgeW2, LINHA_H - 3, 0.8, 0.8, "FD");
      pdf.setFontSize(5.5); pdf.setFont("helvetica", "bold"); st(stColor);
      pdf.text(
        enquadramentoStatusLabel(r.status),
        badgeX2 + badgeW2 / 2,
        curY + LINHA_H / 2 + 1,
        { align: "center" },
      );

      curY += LINHA_H;

      // ── Bloco de detalhe e auditoria de cada regra ────────────────────────
      {
        const view = buildEnquadramentoRulePdfPresentation(r);
        const auditFields = buildRulePdfAuditFields(r);
        const ativos2 = buildRulePdfAssets(r);
        const detalheH = calcDetalheH(r);

        const DETAIL_BG: RGB = isViolacao ? [254, 249, 249] : isAlerta ? [255, 252, 242] : [247, 252, 249];
        const GRAY_MED: RGB  = BRAND_GRAY2;
        const detailColor: RGB = isViolacao ? STATUS_HARD : isAlerta ? STATUS_SOFT : STATUS_OK;

        // Borda esquerda semântica (2mm)
        sf(detailColor); pdf.rect(MARGIN, curY, 2, detalheH, "F");

        // Fundo do bloco
        sf(DETAIL_BG); pdf.rect(MARGIN + 2, curY, contentWd - 2, detalheH, "F");
        sd([229, 231, 235]); lw(0.15);
        pdf.rect(MARGIN + 2, curY, contentWd - 2, detalheH, "S");

        const innerX = MARGIN + 4;
        const innerW = contentWd - 4;
        let dy = curY + 5;

        // Sub-bloco de métricas
        const metricas2 = [
          { label: "VALOR APURADO", value: view.currentDisplay, highlight: true },
          { label: "CRITÉRIO", value: view.criterionDisplay, highlight: false },
          { label: "MARGEM / FOLGA", value: view.marginDisplay, highlight: true },
          { label: "STATUS", value: enquadramentoStatusLabel(r.status), highlight: true },
        ];
        const metW2 = innerW / metricas2.length;
        metricas2.forEach((met, i) => {
          const mx = innerX + i * metW2;
          pdf.setFontSize(5.5); pdf.setFont("helvetica", "bold"); st(GRAY_MED);
          pdf.text(met.label, mx + 2, dy);
          pdf.setFontSize(7.5); pdf.setFont("helvetica", "bold");
          st(met.highlight ? detailColor : INK);
          const metricFit = pdf.splitTextToSize(pdfSafeText(met.value), metW2 - 4)[0];
          pdf.text(metricFit, mx + 2, dy + 6);
        });
        dy += 14;

        // Leitura executiva da regra
        sd([229, 231, 235]); lw(0.3);
        pdf.line(innerX, dy, innerX + innerW, dy);
        dy += 4;
        pdf.setFontSize(5.5); pdf.setFont("helvetica", "bold"); st(GRAY_MED);
        pdf.text("LEITURA DO RESULTADO", innerX + 2, dy);
        dy += 3.5;
        const explanationLines = pdf.splitTextToSize(pdfSafeText(view.explanation), innerW - 4);
        pdf.setFontSize(6.5); pdf.setFont("helvetica", "normal"); st(INK);
        pdf.text(explanationLines, innerX + 2, dy);
        dy += explanationLines.length * 3.2 + 2;

        // Dados de auditoria armazenados pelo motor
        if (auditFields.length > 0) {
          sd([229, 231, 235]); lw(0.2);
          pdf.line(innerX, dy, innerX + innerW, dy);
          dy += 4;
          const auditColW = innerW / 2;
          for (let idx = 0; idx < auditFields.length; idx += 2) {
            for (let offset = 0; offset < 2; offset++) {
              const field = auditFields[idx + offset];
              if (!field) continue;
              const fieldX = innerX + offset * auditColW + 2;
              pdf.setFontSize(5); pdf.setFont("helvetica", "bold"); st(GRAY_MED);
              pdf.text(pdfSafeText(field.label).toUpperCase(), fieldX, dy);
              pdf.setFontSize(6.5); pdf.setFont("helvetica", "bold"); st(INK);
              const valueFit = pdf.splitTextToSize(pdfSafeText(field.value), auditColW - 6)[0];
              pdf.text(valueFit, fieldX, dy + 3.5);
            }
            dy += 7;
          }
        }

        if (ativos2.length > 0) {
          // Cabeçalho da sub-tabela
          pdf.setFontSize(5.5); pdf.setFont("helvetica", "bold"); st(GRAY_MED);
          pdf.text("PRINCIPAIS ATIVOS / OFENSORES (ATÉ 8 ITENS)", innerX + 2, dy);
          pdf.text("VALOR", innerX + innerW - 72, dy, { align: "right" });
          pdf.text("% PL", innerX + innerW - 2, dy, { align: "right" });
          dy += 5;
        }

        // Linhas de ativos
        for (const ativo of ativos2) {
          const pct2 = Number(ativo.percentual ?? 0) * 100;
          const limiteAtivo = ativo.limite;
          const isAbove = limiteAtivo != null && pct2 > limiteAtivo * 100;

          pdf.setFontSize(7); pdf.setFont("helvetica", "bold"); st(INK);
          const nomeStr = pdfSafeText(ativo.nome);
          const nomeTrunc = nomeStr.length > 52 ? nomeStr.slice(0, 51) + "..." : nomeStr;
          pdf.text(nomeTrunc, innerX + 2, dy);

          pdf.setFont("courier", "normal"); st(INK);
          pdf.text(ativo.valor != null ? fmtBRL(ativo.valor) : "-", innerX + innerW - 72, dy, { align: "right" });

          pdf.setFont("courier", "bold");
          st(isAbove ? STATUS_HARD : INK);
          pdf.text(`${pct2.toFixed(2)}%`, innerX + innerW - 2, dy, { align: "right" });
          dy += 4;

          if (ativo.identificador !== "-" || ativo.classificacao !== "-") {
            pdf.setFontSize(6); pdf.setFont("courier", "normal"); st(GRAY_MED);
            pdf.text(pdfSafeText(`${ativo.identificador}  ${ativo.classificacao}`), innerX + 2, dy);
            dy += 5;
          } else {
            dy += 4;
          }
        }
        curY = dy + 4;
      }

      curY += 2;
      rowAlt++;
    }
  } else if (!regraArt4 && !regraArt5) {
    drawSectionTitle("RESULTADO POR REGRA DE COMPLIANCE");
    pdf.setFontSize(7);
    pdf.setFont("helvetica", "normal");
    st(BRAND_GRAY2);
    pdf.text("Nenhuma regra verificada.", MARGIN, curY);
    curY += 6;
  }

  await _renderArt5();

  // ── Composição da Carteira — Detalhamento de Ativos e Lançamentos ───────────
  if (assets.length > 0) {
    pdf.addPage("a4", "landscape");
    drawHeader(false);
    let nextY = HEADER_H + 5;

    pdf.setFontSize(6); pdf.setFont("helvetica", "bold"); st(BRAND_GRAY1);
    const appendixTitle = `APÊNDICE - COMPOSIÇÃO DA CARTEIRA | ${pdfSafeText(info.nomeFundo)}`;
    pdf.text(pdf.splitTextToSize(appendixTitle, pageW - 2 * MARGIN)[0], MARGIN, nextY);
    nextY += 2;
    pdf.setFontSize(5.5); pdf.setFont("helvetica", "normal"); st(BRAND_GRAY2);
    pdf.text("Detalhamento de Ativos e Lançamentos", MARGIN, nextY);
    nextY += 6;

    const walletBody = assets.map(a => [
      a.ativo,
      a.tipo,
      a.quantidade,
      a.precoUnit,
      a.liquidez,
      a.financeiro,
      a.percPL,
    ]);

    autoTable(pdf, {
      startY: nextY,
      head: [["Ativo / Emissor", "Tipo", "Qtd", "P.U.", "Liquidez", "Financeiro", "% PL"]],
      body: walletBody,
      margin: { top: HEADER_H + 5, left: MARGIN, right: MARGIN, bottom: 18 },
      styles: {
        fontSize: 6.5,
        cellPadding: { top: 2, right: 2, bottom: 2, left: 2 },
        lineColor: BORDER, lineWidth: 0.15, textColor: INK,
      },
      headStyles: {
        fillColor: BRAND_GRAY1, textColor: WHITE, fontStyle: "bold",
        fontSize: 6, cellPadding: { top: 2.5, right: 2, bottom: 2.5, left: 2 },
      },
      alternateRowStyles: { fillColor: BG_ROW },
      columnStyles: {
        0: { cellWidth: 95, fontStyle: "bold", overflow: "ellipsize" },
        1: { cellWidth: 25, halign: "center" },
        2: { cellWidth: 25, halign: "right", font: "courier", fontSize: 6 },
        3: { cellWidth: 25, halign: "right", font: "courier", fontSize: 6 },
        4: { cellWidth: 25, halign: "center", font: "courier", fontSize: 6 },
        5: { cellWidth: 48, halign: "right", font: "courier", fontSize: 6 },
        6: { cellWidth: 34, halign: "right", font: "courier", fontSize: 6 },
      },
      didDrawPage: (data) => { if (data.pageNumber > 1) drawHeader(false); },
    });
  }

  const totalPages = pdf.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i);
    drawHeader(i === 1);
    drawFooter(i, totalPages);
  }

  const today = new Date();
  const ts = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("");
  const safeName = info.nomeFundo.replace(/[^a-zA-Z0-9\u00C0-\u024F\s-]/g, "_").slice(0, 40).trim();
  pdf.save(`Enquadramento_${safeName}_${ts}.pdf`);
}
