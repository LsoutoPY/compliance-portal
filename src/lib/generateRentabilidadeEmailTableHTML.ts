/**
 * Tabela HTML estilo paste do Excel para corpo de e-mail de rentabilidade.
 * Espelha a aba "Rentabilidade" do arquivo Rentabilidade_YYYYMMDD.xlsx.
 */

import type { AtivoRelatorio, FundoRelatorio } from "./generateRentabilidadeRelatorioHTML_v2";
import { abreviarAdministrador } from "./generateRentabilidadeRelatorioHTML_v2";
import { isFundoExclusivoRentabilidade } from "./fundosExclusivosRentabilidade";

const COL_HEADERS = [
  "Fundo / Ativo",
  "PL / Qtd",
  "Cota / PU",
  "Adm / % PL",
  "Ret/Var Dia",
  "vs CDI Dia",
  "Ret/Var Mês",
  "vs CDI Mês",
  "Ret/Var Ano",
  "vs CDI Ano",
  "Ret/Var 12M",
];

function fmtPct(v: number | null | undefined, casas = 4): string {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(casas)}%`;
}

function fmtPctSemSinal(v: number | null | undefined, casas = 2): string {
  if (v == null) return "—";
  return `${v.toFixed(casas)}%`;
}

function fmtVsCDI(
  cdiPlusAa: number | null | undefined,
  pctCdi: number | null | undefined,
): string {
  if (cdiPlusAa == null && pctCdi == null) return "—";
  if (pctCdi != null && pctCdi < 0) return "—";
  const line1 =
    cdiPlusAa != null
      ? cdiPlusAa >= 0
        ? `CDI +${cdiPlusAa.toFixed(2).replace(".", ",")}% a.a.`
        : `CDI ${cdiPlusAa.toFixed(2).replace(".", ",")}% a.a.`
      : "";
  const line2 =
    pctCdi != null ? `${pctCdi.toFixed(2).replace(".", ",")}% do CDI` : "";
  return [line1, line2].filter(Boolean).join("\n");
}

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

function fmtBRLText(v: number | null | undefined): string {
  if (v == null) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}

function fmtCota(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 6, maximumFractionDigits: 8 });
}

function sortFundosPorPLDesc(fundos: FundoRelatorio[]): FundoRelatorio[] {
  return [...fundos].sort((a, b) => (b.pl ?? 0) - (a.pl ?? 0));
}

function sortAtivosPorPLDesc(ativos: AtivoRelatorio[]): AtivoRelatorio[] {
  return [...ativos].sort((a, b) => {
    if (a.vlMercado != null && b.vlMercado != null) return b.vlMercado - a.vlMercado;
    return (b.percPL ?? 0) - (a.percPL ?? 0);
  });
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cell(text: string, opts?: { bold?: boolean; right?: boolean; bg?: string; color?: string }): string {
  const style: string[] = [
    "border:1px solid #d1d5db",
    "padding:3px 6px",
    "font-family:Calibri,Arial,sans-serif",
    "font-size:11px",
    "vertical-align:middle",
    "white-space:pre-wrap",
  ];
  if (opts?.bold) style.push("font-weight:bold");
  if (opts?.right === false) style.push("text-align:left");
  else style.push("text-align:right");
  if (opts?.bg) style.push(`background:${opts.bg}`);
  if (opts?.color) style.push(`color:${opts.color}`);
  return `<td style="${style.join(";")}">${esc(text)}</td>`;
}

function headerRow(): string {
  const cells = COL_HEADERS.map((h) =>
    cell(h, {
      bold: true,
      right: h === "Fundo / Ativo" ? false : true,
      bg: "#00734a",
      color: "#9fe1cb",
    }),
  );
  return `<tr>${cells.join("")}</tr>`;
}

function sectionTitleRow(title: string, plSecao: number, qtd: number): string {
  const text = `${title}   ·   ${qtd} fundo${qtd !== 1 ? "s" : ""}   ·   PL: ${fmtBRLText(plSecao)}`;
  return `<tr><td colspan="${COL_HEADERS.length}" style="border:1px solid #d1d5db;padding:4px 6px;font-family:Calibri,Arial,sans-serif;font-size:11px;font-weight:bold;background:#3a6b57;color:#fff;">${esc(text)}</td></tr>`;
}

function fundoRow(fundo: FundoRelatorio): string {
  const dark = { bold: true, bg: "#5b6066", color: "#ffffff" } as const;
  return `<tr>${[
    cell(fundo.nome_fundo || "—", { ...dark, right: false }),
    cell(fmtBRLText(fundo.pl), dark),
    cell(fmtCota(fundo.valor_cota), dark),
    cell(abreviarAdministrador(fundo.administrador), { ...dark, right: false }),
    cell(fmtPct(fundo.ret_dia_pct, 4), dark),
    cell(fmtVsCDI(fundo.cdi_plus_aa_dia_pct, fundo.pct_cdi_dia), dark),
    cell(fmtPct(fundo.ret_mes_pct, 4), dark),
    cell(fmtVsCDI(fundo.cdi_plus_aa_mes_pct, fundo.pct_cdi_mes), dark),
    cell(fmtPct(fundo.ret_ano_pct, 4), dark),
    cell(fmtVsCDI(fundo.cdi_plus_aa_ano_pct, fundo.pct_cdi_ano), dark),
    cell(fmtRetComPctCdi(fundo.ret_12m_pct, fundo.pct_cdi_12m, 2), dark),
  ].join("")}</tr>`;
}

function ativoHeaderRow(): string {
  const labels = [
    "   Ativo",
    "Vl. Mercado",
    "PU",
    "% PL",
    "Var. Dia",
    "vs CDI Dia",
    "Var. Mês",
    "vs CDI Mês",
    "Var. Ano",
    "vs CDI Ano",
    "Var. 12M",
  ];
  return `<tr>${labels
    .map((h, i) =>
      cell(h, { bold: true, right: i !== 0, bg: "#3a6b57", color: "#9fe1cb" }),
    )
    .join("")}</tr>`;
}

function ativoRow(ativo: AtivoRelatorio, alt: boolean): string {
  const bg = alt ? "#f9fafb" : "#ffffff";
  return `<tr>${[
    cell(`      ${ativo.nome || "—"}`, { right: false, bg }),
    cell(fmtBRLText(ativo.vlMercado), { bg }),
    cell(fmtCota(ativo.pu), { bg }),
    cell(fmtPctSemSinal(ativo.percPL, 1), { bg }),
    cell(fmtPct(ativo.varDia, 4), { bg }),
    cell(fmtVsCDI(ativo.cdiPlusAaDia, ativo.vsCdiDia), { bg }),
    cell(fmtPct(ativo.varMes, 4), { bg }),
    cell(fmtVsCDI(ativo.cdiPlusAaMes, ativo.vsCdiMes), { bg }),
    cell(fmtPct(ativo.varAno, 4), { bg }),
    cell(fmtVsCDI(ativo.cdiPlusAaAno, ativo.vsCdiAno), { bg }),
    cell(fmtRetComPctCdi(ativo.var12M, ativo.vsCdi12M, 2), { bg }),
  ].join("")}</tr>`;
}

function writeSecaoRows(fundos: FundoRelatorio[], titulo: string): string {
  const plSecao = fundos.reduce((s, f) => s + (f.pl ?? 0), 0);
  let html = sectionTitleRow(titulo, plSecao, fundos.length);
  html += headerRow();

  if (fundos.length === 0) {
    html += `<tr><td colspan="${COL_HEADERS.length}" style="border:1px solid #d1d5db;padding:4px 6px;font-family:Calibri,Arial,sans-serif;font-size:11px;font-style:italic;text-align:center;">Nenhum fundo nesta categoria</td></tr>`;
    return html;
  }

  for (const fundo of fundos) {
    html += fundoRow(fundo);
    if (fundo.ativos.length > 0) {
      html += ativoHeaderRow();
      let alt = false;
      for (const ativo of sortAtivosPorPLDesc(fundo.ativos)) {
        html += ativoRow(ativo, alt);
        alt = !alt;
      }
    }
  }

  html += `<tr>${[
    cell(`Subtotal — ${titulo}`, { bold: true, right: false, bg: "#5b6066", color: "#ffffff" }),
    cell(fmtBRLText(plSecao), { bold: true, bg: "#5b6066", color: "#ffffff" }),
    ...Array.from({ length: 9 }, () => cell("", { bold: true, bg: "#5b6066", color: "#ffffff" })),
  ].join("")}</tr>`;

  return html;
}

export interface RentabilidadeEmailTableResult {
  html: string;
  plainText: string;
}

export function generateRentabilidadeEmailTableHTML(
  fundos: FundoRelatorio[],
  dataReferencia: string,
): RentabilidadeEmailTableResult {
  const dataFmt = dataReferencia.includes("-")
    ? dataReferencia.split("-").reverse().join("/")
    : dataReferencia;

  const fundosOrdenados = sortFundosPorPLDesc(fundos);
  const plTotal = fundosOrdenados.reduce((s, f) => s + (f.pl ?? 0), 0);
  const cdiDia = fundosOrdenados[0]?.cdi_dia_pct ?? null;
  const cdiMeta = cdiDia != null ? `   ·   CDI Dia: ${fmtPct(cdiDia, 4)}` : "";

  const condominiais = sortFundosPorPLDesc(
    fundosOrdenados.filter((f) => !isFundoExclusivoRentabilidade(f.nome_fundo)),
  );
  const exclusivos = sortFundosPorPLDesc(
    fundosOrdenados.filter((f) => isFundoExclusivoRentabilidade(f.nome_fundo)),
  );

  const metaLine = `Data de referência: ${dataFmt}   ·   ${fundosOrdenados.length} fundos   ·   PL Total: ${fmtBRLText(plTotal)}${cdiMeta}`;

  let tableRows = "";
  tableRows += `<tr><td colspan="${COL_HEADERS.length}" style="border:1px solid #d1d5db;padding:6px 8px;font-family:Calibri,Arial,sans-serif;font-size:12px;font-weight:bold;background:#00734a;color:#fff;">RELATÓRIO DE RENTABILIDADE — CVPAR QUADRANTE</td></tr>`;
  tableRows += `<tr><td colspan="${COL_HEADERS.length}" style="border:1px solid #d1d5db;padding:4px 6px;font-family:Calibri,Arial,sans-serif;font-size:10px;background:#f0f4f2;">${esc(metaLine)}</td></tr>`;
  tableRows += `<tr><td colspan="${COL_HEADERS.length}" style="border:none;height:6px;"></td></tr>`;
  tableRows += writeSecaoRows(condominiais, "FUNDOS CONDOMINIAIS");
  tableRows += `<tr><td colspan="${COL_HEADERS.length}" style="border:none;height:6px;"></td></tr>`;
  tableRows += writeSecaoRows(exclusivos, "FUNDOS EXCLUSIVOS");
  tableRows += `<tr>${[
    cell(`TOTAL GERAL — ${fundosOrdenados.length} fundos`, { bold: true, right: false, bg: "#00734a", color: "#ffffff" }),
    cell(fmtBRLText(plTotal), { bold: true, bg: "#00734a", color: "#ffffff" }),
    ...Array.from({ length: 9 }, () => cell("", { bold: true, bg: "#00734a", color: "#ffffff" })),
  ].join("")}</tr>`;

  const html = `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;max-width:960px;">${tableRows}</table>`;
  const plainText = [
    "RELATÓRIO DE RENTABILIDADE — CVPAR QUADRANTE",
    metaLine,
    "",
    "Tabela completa disponível no Excel anexo.",
  ].join("\n");

  return { html, plainText };
}
