import ExcelJS from "npm:exceljs@4.4.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

type RuleStatus = "ok" | "alerta" | "violacao" | "pendente";

interface EnquadramentoRule {
  regra_codigo: string;
  regra_descricao: string;
  regra_categoria: string;
  status: RuleStatus;
  valor_atual: number | null;
  valor_limite: number | null;
  detalhes?: Record<string, unknown> | null;
}

interface EnquadramentoFundoInfo {
  nomeFundo: string;
  cnpj: string;
  dataBase: string;
  prazoResgate: number | null;
  totalPL: number;
  worstStatus: RuleStatus;
}

interface EnquadramentoWalletAsset {
  ativo: string;
  tipo: string;
  quantidade: string;
  precoUnit: string;
  liquidez: string;
  financeiro: string;
  percPL: string;
}

type ExportEnquadramentoFundoInfo = EnquadramentoFundoInfo;
type ExportEnquadramentoRule = EnquadramentoRule;
type ExportEnquadramentoWalletAsset = EnquadramentoWalletAsset;

interface ExportEnquadramentoConsolidadoRow {
  nome_fundo: string;
  fundo_cnpj: string;
  dt_posicao: string;
  statusDetail: string;
  administrador?: string;
  pl?: number;
  nRegras?: number;
  nViolacoes?: number;
}

export interface ViolacaoExcelRow {
  fundo_cnpj: string;
  fundo_isin: string;
  nome_comercial?: string | null;
  regra_codigo: string;
  regra_descricao: string | null;
  regra_categoria: string;
  valor_atual: number | null;
  valor_limite: number | null;
}

interface TribArt4Ativo {
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

// ── Tipo de stress (legado — não usado neste módulo) ───────────────────────────
interface StressExportInfo {
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


function isTribArt4Rule(r: Pick<EnquadramentoRule, "regra_codigo" | "regra_categoria">): boolean {
  const codigo = (r.regra_codigo ?? "").toUpperCase();
  const cat = (r.regra_categoria ?? "").toLowerCase();
  return (
    cat === "tributario-art4" ||
    cat === "tributario-art4-fidc" ||
    codigo === "TRIB_FIM_LP_365" ||
    codigo === "TRIB_FIDC_LP_365"
  );
}

function isTribArt5Rule(r: Pick<EnquadramentoRule, "regra_codigo" | "regra_categoria">): boolean {
  return r.regra_categoria === "tributario" && r.regra_codigo === "TRIB_FIQ_LP_90";
}

function art4ClassificacaoLabel(asset: TribArt4Ativo): string {
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
function buildHistoricoArt5(
  det: Record<string, unknown>,
  rule: EnquadramentoRule,
): Array<{ data: string; p_dia: number; mm_10d: number; status: string }> {
  const rawHist = det.historico;
  const limitePct = tribArt5LimitePct(det);
  const alertaPct = tribArt5AlertaPct(det);

  if (Array.isArray(rawHist) && rawHist.length > 0) {
    return rawHist.map((h: Record<string, unknown>) => {
      const pRaw = Number(h.p_dia ?? 0);
      const mmRaw = Number(h.mm_10d ?? 0);
      const pPct = pRaw <= 1 ? pRaw * 100 : pRaw;
      const mmPct = mmRaw <= 1 ? mmRaw * 100 : mmRaw;
      const st = (h.status as RuleStatus) ??
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


async function buildEnquadramentoFundoExcelWorkbook(
  info: ExportEnquadramentoFundoInfo,
  rules: ExportEnquadramentoRule[],
  assets: ExportEnquadramentoWalletAsset[] = [],
): Promise<ExcelJS.Workbook> {
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
  addKV("Patrimônio Líquido",   fmtBRL(info.totalPL));
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
      `PL: ${fmtBRL(patliq)}`,
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
      fmtBRL(m.valor_lp),
      `CP: ${m.pctCP.toFixed(2)}%`,
      fmtBRL(m.valor_cp),
      `FII: ${m.pctExc.toFixed(2)}%`,
      fmtBRL(m.valor_excluido),
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
              fmtBRL(patliq),
              "Montante Consid.",
              fmtBRL(va * patliq),
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

    return wb;
}
async function buildEnquadramentoConsolidadoWorkbook(
  fundos: ExportEnquadramentoConsolidadoRow[],
  dataRef: string,
): Promise<ExcelJS.Workbook> {
  const isCompleto = false;
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

    return wb;
}

function normalizeCnpj14(cnpj: string): string {
  return String(cnpj ?? "").replace(/\D/g, "").padStart(14, "0");
}

function formatCnpj(cnpj: string): string {
  const d = normalizeCnpj14(cnpj);
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

function formatDataBR(dtposicao: string): string {
  if (!dtposicao || dtposicao.length !== 8) return dtposicao;
  return `${dtposicao.slice(6, 8)}/${dtposicao.slice(4, 6)}/${dtposicao.slice(0, 4)}`;
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\u00C0-\u024F\s-]/g, "_").slice(0, 40).trim() || "Fundo";
}

async function workbookToBase64(wb: ExcelJS.Workbook): Promise<string> {
  const buf = await wb.xlsx.writeBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

async function fetchConsolidadoFundos(
  supabase: ReturnType<typeof createClient>,
  dtposicao: string,
): Promise<ExportEnquadramentoConsolidadoRow[]> {
  const { data: pares } = await supabase.rpc("get_pares_fundo_monitorado", { p_dtposicao: dtposicao });
  if (!pares?.length) return [];

  const { data: enqData } = await supabase
    .from("enquadramento_resultado")
    .select("fundo_cnpj, fundo_isin, status")
    .eq("fundo_dtposicao", dtposicao);

  const statusMap = new Map<string, string>();
  for (const item of enqData ?? []) {
    const cnpjKey = normalizeCnpj14(item.fundo_cnpj);
    const key = `${cnpjKey}|${item.fundo_isin ?? ""}`;
    const cur = statusMap.get(key);
    if (item.status === "violacao" || !cur) statusMap.set(key, item.status);
    else if (item.status === "alerta" && cur !== "violacao") statusMap.set(key, item.status);
  }

  return (pares as Array<{ fundo_cnpj: string; fundo_isin?: string; nome_fundo?: string }>).map((par) => {
    const isin = par.fundo_isin ?? "";
    const cnpjNorm = normalizeCnpj14(par.fundo_cnpj);
    const st =
      statusMap.get(`${cnpjNorm}|${isin}`) ??
      (isin ? statusMap.get(`${cnpjNorm}|`) : undefined) ??
      "pendente";
    return {
      nome_fundo: par.nome_fundo || par.fundo_cnpj,
      fundo_cnpj: par.fundo_cnpj,
      dt_posicao: dtposicao,
      statusDetail: st,
    };
  });
}

async function fetchFundoEnquadramentoBundle(
  supabase: ReturnType<typeof createClient>,
  dtposicao: string,
  fundoCnpj: string,
  fundoIsin: string,
  nomeFundo: string,
) {
  const cnpjNorm = normalizeCnpj14(fundoCnpj);
  const isin = fundoIsin ?? "";

  let rulesQuery = supabase
    .from("enquadramento_resultado")
    .select("regra_codigo, regra_descricao, regra_categoria, status, valor_atual, valor_limite, detalhes")
    .eq("fundo_dtposicao", dtposicao)
    .eq("fundo_cnpj", cnpjNorm);
  if (isin) rulesQuery = rulesQuery.eq("fundo_isin", isin);
  const { data: rulesRaw } = await rulesQuery.order("regra_categoria");

  const variants = [...new Set([cnpjNorm, formatCnpj(fundoCnpj), fundoCnpj])];
  let posRows: Array<Record<string, unknown>> = [];
  for (const cnpj of variants) {
    let q = supabase.from("posicao_carteira").select("*").eq("fundo_cnpj", cnpj).eq("fundo_dtposicao", dtposicao);
    if (isin) q = q.eq("fundo_isin", isin);
    const { data } = await q;
    if ((data ?? []).length > 0) { posRows = data as Array<Record<string, unknown>>; break; }
  }

  const totalPL = Number(posRows.find((r) => r.fundo_patliq != null && Number(r.fundo_patliq) > 0)?.fundo_patliq ?? 0);

  const { data: fc } = await supabase
    .from("fundos_caracteristicas")
    .select("prazo_pagamento_resgate_dias")
    .or(`cnpj_fundo.eq.${cnpjNorm},cnpj_classe.eq.${cnpjNorm}`)
    .limit(1)
    .maybeSingle();

  const rules = (rulesRaw ?? []) as EnquadramentoRule[];
  let worstStatus: RuleStatus = rules.length > 0 ? "ok" : "pendente";
  for (const r of rules) {
    if (r.status === "violacao") { worstStatus = "violacao"; break; }
    if (r.status === "alerta") worstStatus = "alerta";
  }

  const info: EnquadramentoFundoInfo = {
    nomeFundo: nomeFundo || String(posRows[0]?.nome_fundo ?? posRows[0]?.fundo_nome ?? fundoCnpj),
    cnpj: formatCnpj(cnpjNorm),
    dataBase: formatDataBR(dtposicao),
    prazoResgate: fc?.prazo_pagamento_resgate_dias != null ? Number(fc.prazo_pagamento_resgate_dias) : null,
    totalPL,
    worstStatus,
  };

  const assets: EnquadramentoWalletAsset[] = posRows.map((a) => {
    const valor = Number(a.valor_padrao ?? 0);
    const ativo = String(a.nome_comercial_ativo ?? a.cnpjfundo ?? a.cnpjemissor ?? "—");
    const prazo = a.prazos_em_dias != null ? Number(a.prazos_em_dias) : null;
    const share = totalPL > 0 ? valor / totalPL : 0;
    const percPL = share ? (a.credeb === "D" ? "-" : "") + (share * 100).toFixed(2) + "%" : "0.00%";
    const financeiro = valor != null
      ? (a.credeb === "D" ? "-" : "") + new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(valor)
      : "-";
    return {
      ativo: ativo.length > 50 ? ativo.slice(0, 49) + "…" : ativo,
      tipo: String(a.section ?? "").toLowerCase(),
      quantidade: a.qtdisponivel != null ? new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(Number(a.qtdisponivel)) : "-",
      precoUnit: a.puposicao != null ? new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 4, minimumFractionDigits: 2 }).format(Number(a.puposicao)) : "-",
      liquidez: prazo != null ? `D+${prazo}` : "N/D",
      financeiro,
      percPL,
    };
  });

  return { info, rules, assets };
}

export async function buildDesenquadramentoExcel(
  supabase: ReturnType<typeof createClient>,
  violacoes: ViolacaoExcelRow[],
  dtposicao: string,
  opts?: { nomeFundo?: string | null; fundoCnpj?: string | null; fundoIsin?: string | null },
): Promise<{ base64: string; filename: string }> {
  const qtdFundos = new Set(violacoes.map((v) => `${normalizeCnpj14(v.fundo_cnpj)}|${v.fundo_isin ?? ""}`)).size;
  const dataRef = formatDataBR(dtposicao);
  const singlePair = violacoes[0];
  const fundoCnpj = opts?.fundoCnpj ?? singlePair?.fundo_cnpj ?? "";
  const fundoIsin = opts?.fundoIsin ?? singlePair?.fundo_isin ?? "";
  const nomeFundo = opts?.nomeFundo ?? singlePair?.nome_comercial ?? null;

  let wb: ExcelJS.Workbook;
  let filename: string;

  if (qtdFundos === 1 && fundoCnpj) {
    const bundle = await fetchFundoEnquadramentoBundle(supabase, dtposicao, fundoCnpj, fundoIsin, nomeFundo ?? fundoCnpj);
    wb = await buildEnquadramentoFundoExcelWorkbook(bundle.info, bundle.rules, bundle.assets);
    const ts = dtposicao;
    filename = `Enquadramento_${safeFileName(bundle.info.nomeFundo)}_${ts}.xlsx`;
  } else {
    const fundos = await fetchConsolidadoFundos(supabase, dtposicao);
    wb = await buildEnquadramentoConsolidadoWorkbook(fundos, dataRef);
    filename = `Enquadramento_${dtposicao}.xlsx`;
  }

  return { base64: await workbookToBase64(wb), filename };
}
