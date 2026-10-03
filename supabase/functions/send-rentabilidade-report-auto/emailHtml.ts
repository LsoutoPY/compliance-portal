/**
 * HTML detalhado do corpo do e-mail — porte Deno de `src/lib/generateRentabilidadeEmailHTML.ts`.
 * Compatível com Outlook; inclui drill-down de ativos (igual ao envio manual).
 */

import { format, parseISO } from "npm:date-fns@3.6.0";
import { ptBR } from "npm:date-fns@3.6.0/locale/pt-BR";
import type { FundoXmlCoverageRow } from "./calc.ts";
import { isFundoExclusivoRentabilidade } from "./calc.ts";
import {
  abreviarAdministrador,
  formatNomeAtivoHTML,
  type FundoRelatorio,
  type SummaryData,
} from "./relatorioHTML_v2.ts";
import { buildFaltantesEmailBlock } from "./rentabilidadeEmailOutlook.ts";

export interface RentabilidadeEmailOptions {
  cdiDiaPct?: number | null;
  faltantes?: FundoXmlCoverageRow[];
}

const SYSTEM_NAME = "Hub Risco";

function saudacaoPorHorario(): string {
  const hora = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hour12: false,
  });
  const h = parseInt(hora, 10);
  if (h < 12) return "bom dia";
  if (h < 18) return "boa tarde";
  return "boa noite";
}

function formatCurrency(value: number | null): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function formatPct(value: number | null, decimals = 4): string {
  if (value == null) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

function formatPctSemSinal(value: number | null, decimals = 2): string {
  if (value == null) return "—";
  return `${value.toFixed(decimals)}%`;
}

function formatVsCDIEmail(cdiPlusAa: number | null, pctCdi: number | null): string {
  if (cdiPlusAa == null && pctCdi == null) return "<span style=\"color:#888\">—</span>";
  if (pctCdi != null && pctCdi < 0) return "<span style=\"color:#888\">—</span>";
  const color = cdiPlusAa != null && Math.abs(cdiPlusAa) > 0.001
    ? (cdiPlusAa > 0 ? "#1B6B3A" : "#9C0006")
    : "#555";
  const line1 = cdiPlusAa != null
    ? `<span style="color:${color};font-weight:700;">`
      + (cdiPlusAa >= 0
          ? `CDI +${cdiPlusAa.toFixed(2).replace(".", ",")}% a.a.`
          : `CDI ${cdiPlusAa.toFixed(2).replace(".", ",")}% a.a.`)
      + `</span>`
    : "";
  const line2 = pctCdi != null
    ? `<span style="color:#555;font-size:10px;">${pctCdi.toFixed(2).replace(".", ",")}% do CDI</span>`
    : "";
  return [line1, line2].filter(Boolean).join("<br>");
}

function formatVsCDIPlain(cdiPlusAa: number | null, pctCdi: number | null): string {
  if (cdiPlusAa == null && pctCdi == null) return "—";
  if (pctCdi != null && pctCdi < 0) return "—";
  const line1 = cdiPlusAa != null
    ? (cdiPlusAa >= 0
        ? `CDI +${cdiPlusAa.toFixed(2).replace(".", ",")}% a.a.`
        : `CDI ${cdiPlusAa.toFixed(2).replace(".", ",")}% a.a.`)
    : "";
  const line2 = pctCdi != null ? `${pctCdi.toFixed(2).replace(".", ",")}% do CDI` : "";
  return [line1, line2].filter(Boolean).join("<br>");
}

function retDiaCellStyle(value: number | null): string {
  if (value == null || Math.abs(value) <= 0.001) return "color:#ffffff;";
  return value > 0 ? "background:#E6F9F1;color:#1B6B3A;" : "background:#FDE9E9;color:#9C0006;";
}

function formatNumber(value: number | null, decimals = 3): string {
  if (value == null) return "—";
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function getColorClass(value: number | null): string {
  if (value == null) return "color:#555;";
  if (value > 0.001) return "color:#1B6B3A;font-weight:700;";
  if (value < -0.001) return "color:#9C0006;font-weight:700;";
  return "color:#555;";
}

const COL_WIDTHS_PCT = [28, 6.5, 6.5, 7, 5.5, 7.5, 5.5, 7.5, 5.5, 7.5, 5.5, 7.5] as const;

function renderTabelaColgroup(): string {
  return `<colgroup>${COL_WIDTHS_PCT.map((w) => `<col width="${w}%">`).join("")}</colgroup>`;
}

function renderTabelaColunasHeader(): string {
  return `
  <tr style="background:#1F4E3D;color:#9FE1CB;">
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:left;border-right:1px solid #2D5D4A;">Fundo / Ativo</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">PL / Qtd</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">Cota/PU</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:left;border-right:1px solid #2D5D4A;">Adm / %PL</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">Ret/Var Dia</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">vs CDI Dia</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">Ret/Var Mês</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">vs CDI Mês</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">Ret/Var Ano</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">vs CDI Ano</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">Ret/Var 12M</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;">vs CDI 12M</th>
  </tr>`;
}

function renderAtivosColunasHeader(): string {
  return `
  <tr style="background:#1F4E3D;color:#9FE1CB;">
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:left;border-right:1px solid #2D5D4A;">Ativo</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">Vl. Mercado</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">PU</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">% PL</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">Var. Dia</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">vs CDI Dia</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">Var. Mês</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">vs CDI Mês</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">Var. Ano</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">vs CDI Ano</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;border-right:1px solid #2D5D4A;">Var. 12M</th>
    <th style="font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 4px;text-align:right;">vs CDI 12M</th>
  </tr>`;
}

function sortFundosPorPLDesc(fundos: FundoRelatorio[]): FundoRelatorio[] {
  return [...fundos].sort((a, b) => (b.pl ?? 0) - (a.pl ?? 0));
}

function renderSecaoBarRow(titulo: string, fundos: FundoRelatorio[]): string {
  const plSecao = fundos.reduce((s, f) => s + (f.pl ?? 0), 0);
  return `
  <tr>
    <td colspan="${COL_WIDTHS_PCT.length}" style="background:#3A6B57;color:#ffffff;font-size:13px;font-weight:700;padding:8px 6px;">
      ${titulo} &nbsp;·&nbsp; ${fundos.length} fundo${fundos.length !== 1 ? "s" : ""} &nbsp;·&nbsp; PL: ${formatCurrency(plSecao)}
    </td>
  </tr>`;
}

function renderSecaoVaziaRow(): string {
  return `
  <tr>
    <td colspan="${COL_WIDTHS_PCT.length}" style="padding:10px;text-align:center;color:#888;font-style:italic;font-size:12px;background:#FAFAFA;">
      Nenhum fundo nesta categoria
    </td>
  </tr>`;
}

function renderFundoBlock(
  fundo: FundoRelatorio,
  siglasPorCnpj: Record<string, string> | undefined,
): string {
  return `
  <!-- Fundo: ${fundo.nome_fundo} -->
  <tr style="background:#5B6066;border-bottom:2px solid #454B51;">
    <td style="padding:7px 6px;font-size:11px;border-right:1px solid rgba(255,255,255,0.08);white-space:normal;word-wrap:break-word;line-height:1.3;vertical-align:top;">
      <div style="font-weight:700;color:#ffffff;">${fundo.nome_fundo || "—"}</div>
    </td>
    <td style="padding:9px 6px;font-size:12px;text-align:right;font-family:'Courier New',monospace;border-right:1px solid rgba(255,255,255,0.08);color:#ffffff;font-weight:700;">${formatCurrency(fundo.pl)}</td>
    <td style="padding:9px 6px;font-size:12px;text-align:right;font-family:'Courier New',monospace;border-right:1px solid rgba(255,255,255,0.08);color:#ffffff;">${formatNumber(fundo.valor_cota, 4)}</td>
    <td style="padding:9px 6px;font-size:11px;text-align:left;border-right:1px solid rgba(255,255,255,0.08);color:#ffffff;">${abreviarAdministrador(fundo.administrador)}</td>
    <td style="padding:9px 6px;font-size:12px;text-align:right;font-family:'Courier New',monospace;border-right:1px solid rgba(255,255,255,0.08);font-weight:700;${retDiaCellStyle(fundo.ret_dia_pct)}">${formatPct(fundo.ret_dia_pct, 4)}</td>
    <td style="padding:9px 6px;font-size:11px;text-align:right;border-right:1px solid rgba(255,255,255,0.08);color:#ffffff;">${formatVsCDIPlain(fundo.cdi_plus_aa_dia_pct, fundo.pct_cdi_dia)}</td>
    <td style="padding:9px 6px;font-size:12px;text-align:right;font-family:'Courier New',monospace;border-right:1px solid rgba(255,255,255,0.08);color:#ffffff;">${formatPct(fundo.ret_mes_pct, 4)}</td>
    <td style="padding:9px 6px;font-size:11px;text-align:right;border-right:1px solid rgba(255,255,255,0.08);color:#ffffff;">${formatVsCDIPlain(fundo.cdi_plus_aa_mes_pct, fundo.pct_cdi_mes)}</td>
    <td style="padding:9px 6px;font-size:12px;text-align:right;font-family:'Courier New',monospace;border-right:1px solid rgba(255,255,255,0.08);color:#ffffff;">${formatPct(fundo.ret_ano_pct, 4)}</td>
    <td style="padding:9px 6px;font-size:11px;text-align:right;border-right:1px solid rgba(255,255,255,0.08);color:#ffffff;">${formatVsCDIPlain(fundo.cdi_plus_aa_ano_pct, fundo.pct_cdi_ano)}</td>
    <td style="padding:9px 6px;font-size:12px;text-align:right;font-family:'Courier New',monospace;border-right:1px solid rgba(255,255,255,0.08);color:#ffffff;">${formatPct(fundo.ret_12m_pct, 2)}</td>
    <td style="padding:9px 6px;font-size:11px;text-align:right;color:#ffffff;">${formatVsCDIPlain(fundo.cdi_plus_aa_12m_pct, fundo.pct_cdi_12m)}</td>
  </tr>
  
  ${fundo.ativos.length > 0 ? renderAtivosColunasHeader() : ""}
  
  ${fundo.ativos.map((ativo, idx) => {
    const ativoBgColor = idx % 2 === 0 ? "#FFFFFF" : "#FAFAFA";
    return `
  <tr style="background:${ativoBgColor};border-bottom:1px solid #F0F0F0;">
    <td style="padding:6px 6px;padding-left:10px;font-size:10px;font-family:Arial,sans-serif;border-right:1px solid rgba(0,0,0,0.03);white-space:normal;word-wrap:break-word;line-height:1.25;vertical-align:top;">
      ${formatNomeAtivoHTML(ativo.nome, ativo.cnpj, siglasPorCnpj)}
    </td>
    <td style="padding:6px 6px;font-size:11px;text-align:right;font-family:'Courier New',monospace;border-right:1px solid rgba(0,0,0,0.03);color:#555;">${formatCurrency(ativo.vlMercado)}</td>
    <td style="padding:6px 6px;font-size:11px;text-align:right;font-family:'Courier New',monospace;border-right:1px solid rgba(0,0,0,0.03);color:#555;">${formatNumber(ativo.pu, 4)}</td>
    <td style="padding:6px 6px;font-size:11px;text-align:right;font-family:'Courier New',monospace;border-right:1px solid rgba(0,0,0,0.03);${getColorClass(ativo.percPL)}">${formatPctSemSinal(ativo.percPL, 1)}</td>
    <td style="padding:6px 6px;font-size:11px;text-align:right;font-family:'Courier New',monospace;border-right:1px solid rgba(0,0,0,0.03);${getColorClass(ativo.varDia)}">${formatPct(ativo.varDia, 4)}</td>
    <td style="padding:6px 6px;font-size:11px;text-align:right;border-right:1px solid rgba(0,0,0,0.03);">${formatVsCDIEmail(ativo.cdiPlusAaDia, ativo.vsCdiDia)}</td>
    <td style="padding:6px 6px;font-size:11px;text-align:right;font-family:'Courier New',monospace;border-right:1px solid rgba(0,0,0,0.03);${getColorClass(ativo.varMes)}">${formatPct(ativo.varMes, 4)}</td>
    <td style="padding:6px 6px;font-size:11px;text-align:right;border-right:1px solid rgba(0,0,0,0.03);">${formatVsCDIEmail(ativo.cdiPlusAaMes, ativo.vsCdiMes)}</td>
    <td style="padding:6px 6px;font-size:11px;text-align:right;font-family:'Courier New',monospace;border-right:1px solid rgba(0,0,0,0.03);${getColorClass(ativo.varAno)}">${formatPct(ativo.varAno, 4)}</td>
    <td style="padding:6px 6px;font-size:11px;text-align:right;border-right:1px solid rgba(0,0,0,0.03);">${formatVsCDIEmail(ativo.cdiPlusAaAno, ativo.vsCdiAno)}</td>
    <td style="padding:6px 6px;font-size:11px;text-align:right;font-family:'Courier New',monospace;border-right:1px solid rgba(0,0,0,0.03);${getColorClass(ativo.var12M)}">${formatPct(ativo.var12M, 2)}</td>
    <td style="padding:6px 6px;font-size:11px;text-align:right;">${formatVsCDIEmail(ativo.cdiPlusAa12m, ativo.vsCdi12M)}</td>
  </tr>
    `;
  }).join("")}
    `;
}

export function generateRentabilidadeEmailHTML(
  fundos: FundoRelatorio[],
  summary: SummaryData,
  dataReferencia: string,
  siglasPorCnpj?: Record<string, string>,
  options?: RentabilidadeEmailOptions,
): string {
  const dataFormatada = format(parseISO(dataReferencia), "dd/MM/yyyy", { locale: ptBR });
  const cdiDiaPct = options?.cdiDiaPct ?? fundos[0]?.cdi_dia_pct ?? null;
  const faltantes = options?.faltantes ?? [];
  const siglas = siglasPorCnpj ?? {};
  const faltantesBlock = buildFaltantesEmailBlock(faltantes, siglas);

  const fundosCondominiais = sortFundosPorPLDesc(
    fundos.filter((f) => !isFundoExclusivoRentabilidade(f.nome_fundo)),
  );
  const fundosExclusivos = sortFundosPorPLDesc(
    fundos.filter((f) => isFundoExclusivoRentabilidade(f.nome_fundo)),
  );

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Relatório de Rentabilidade - ${dataFormatada}</title>
</head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;font-size:11px;color:#1a1a1a;background:#f5f5f5;">

<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:8px;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;margin-bottom:4px;border:1px solid #e5e7eb;">
  <tr>
    <td style="padding:12px 14px 10px;font-size:14px;line-height:1.45;color:#111827;">
      Caros, ${saudacaoPorHorario()}!<br/><br/>
      Segue o relatório diário de rentabilidade com data-base de
      <strong>${dataFormatada}</strong>, contemplando
      <strong>${summary.totalFundos}</strong> fundo(s) — detalhamento abaixo.
      O Excel consolidado segue em anexo.
    </td>
  </tr>
  ${faltantesBlock ? `<tr><td style="padding:0 14px 10px;">${faltantesBlock}</td></tr>` : ""}
</table>

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse;">
  <tr>
    <td bgcolor="#1F4E3D" style="background-color:#1F4E3D;color:#fff;padding:12px 14px;width:70%;">
      <div style="font-size:16px;font-weight:700;">Relatório Diário de Rentabilidade</div>
    </td>
    <td bgcolor="#1F4E3D" style="background-color:#1F4E3D;color:#fff;padding:12px 14px;text-align:right;white-space:nowrap;">
      <div style="font-size:13px;font-weight:700;">${dataFormatada}</div>
    </td>
  </tr>
  <tr>
    <td colspan="2" style="padding:8px 14px;background:#F0F4F2;border-bottom:1px solid #d4e0db;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding-right:20px;width:33%;">
            <div style="font-size:9px;color:#5F7A6A;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">Fundos</div>
            <div style="font-size:14px;font-weight:700;color:#1F4E3D;">${summary.totalFundos}</div>
          </td>
          <td style="padding-right:20px;width:33%;">
            <div style="font-size:9px;color:#5F7A6A;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">CDI Dia</div>
            <div style="font-size:14px;font-weight:700;color:#1F4E3D;">${formatPct(cdiDiaPct, 4)}</div>
          </td>
          <td style="width:34%;">
            <div style="font-size:9px;color:#5F7A6A;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">PL Total</div>
            <div style="font-size:14px;font-weight:700;color:#1F4E3D;">${formatCurrency(summary.plTotal)}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td colspan="2" style="padding:0;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;table-layout:fixed;">
  ${renderTabelaColgroup()}

  ${renderSecaoBarRow("Fundos Condominiais", fundosCondominiais)}
  ${renderTabelaColunasHeader()}
  ${fundosCondominiais.length > 0
    ? fundosCondominiais.map((fundo) => renderFundoBlock(fundo, siglasPorCnpj)).join("")
    : renderSecaoVaziaRow()}

  ${renderSecaoBarRow("Fundos Exclusivos", fundosExclusivos)}
  ${renderTabelaColunasHeader()}
  ${fundosExclusivos.length > 0
    ? fundosExclusivos.map((fundo) => renderFundoBlock(fundo, siglasPorCnpj)).join("")
    : renderSecaoVaziaRow()}
</table>
    </td>
  </tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;margin-top:0;">
  <tr>
    <td style="padding:20px;font-size:13px;color:#374151;line-height:1.5;">
      Luiz Souto<br/>
      Cvpar | Quadrante<br/>
      <span style="color:#9ca3af;font-size:11px;">
        São Paulo — Av. Faria Lima, 3477 - 8º andar - Torre A · Itaim Bibi
      </span>
    </td>
  </tr>
  <tr>
    <td style="padding:0 20px 16px;font-size:10px;color:#d1d5db;">
      Notificação automática · ${SYSTEM_NAME} ·
      ${format(new Date(), "dd/MM/yyyy HH:mm", { locale: ptBR })} (BRT)
    </td>
  </tr>
</table>

</td></tr>
</table>

</body>
</html>`;
}
