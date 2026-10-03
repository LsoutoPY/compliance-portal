/**
 * Geração de HTML para relatório diário de rentabilidade
 * Layout institucional para envio por e-mail com anexo PDF
 */

import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { RentabilidadeFundoRow } from "@/hooks/useRentabilidadeData";

interface AtivoRelatorio {
  nome: string;
  qtd: number | null;
  pu: number | null;
  vlMercado: number | null;
  percPL: number;
  varDia: number | null;
  vsCdiDia: number | null;
  varMes: number | null;
  vsCdiMes: number | null;
  var12M: number | null;
  vsCdi12M: number | null;
  status: "abaixo" | "acima" | "ok" | "nm";
  isDetrator?: boolean;
}

interface FundoRelatorio extends RentabilidadeFundoRow {
  ativos: AtivoRelatorio[];
  statusGeral: "abaixo" | "acima" | "ok" | "neutro";
  qtdAbaixo: number;
  qtdAcima: number;
}

interface SummaryData {
  totalFundos: number;
  ativosOk: number;
  ativosAbaixo: number;
  fundosComAbaixo: number;
  ativosAcima: number;
  fundosComAcima: number;
  ativosNaoMapeados: number;
  plTotal: number;
  totalPosicoes: number;
}

function formatCurrency(value: number | null): string {
  if (value == null) return "—";
  
  if (Math.abs(value) >= 1_000_000_000) {
    return `R$ ${(value / 1_000_000_000).toFixed(2)} bi`;
  }
  if (Math.abs(value) >= 1_000_000) {
    return `R$ ${(value / 1_000_000).toFixed(1)}M`;
  }
  return `R$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPct(value: number | null, decimals = 4): string {
  if (value == null) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

function formatNumber(value: number | null, decimals = 3): string {
  if (value == null) return "—";
  return value.toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function getNumClass(value: number | null): string {
  if (value == null) return "num neutro";
  if (value > 0) return "num pos";
  if (value < 0) return "num neg";
  return "num neutro";
}

function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    abaixo: "ABAIXO",
    acima: "ACIMA",
    ok: "OK",
    nm: "N. MAP.",
  };
  return map[status] || "—";
}

/**
 * Gera o HTML completo do relatório diário
 */
export function generateRentabilidadeRelatorioHTML(
  fundos: FundoRelatorio[],
  summary: SummaryData,
  dataReferencia: string,
  logoBase64?: string
): string {
  const dataFormatada = format(parseISO(dataReferencia), "dd/MM/yyyy", { locale: ptBR });

  // Ordenar fundos: alertas primeiro (abaixo > acima > ok)
  const fundosOrdenados = [...fundos].sort((a, b) => {
    const ordem = { abaixo: 0, acima: 1, ok: 2, neutro: 3 };
    return ordem[a.statusGeral] - ordem[b.statusGeral];
  });

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Relatório Diário de Rentabilidade - ${dataFormatada}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 12px; color: #1a1a1a; background: #f5f5f5; }
    .email-wrap { max-width: 760px; margin: 0 auto; background: #fff; border: 1px solid #d0d0d0; }
    .email-header { background: #1F4E3D; color: #fff; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; }
    .email-header-title { font-size: 15px; font-weight: 700; letter-spacing: .02em; }
    .email-header-meta { font-size: 11px; color: #9FE1CB; text-align: right; }
    .logo-container { max-width: 120px; max-height: 40px; }
    .logo { max-width: 100%; max-height: 100%; }
    .summary-bar { background: #F0F4F2; border-bottom: 1px solid #d4e0db; padding: 8px 20px; display: flex; gap: 24px; flex-wrap: wrap; }
    .sum-item { display: flex; flex-direction: column; gap: 1px; }
    .sum-label { font-size: 10px; color: #5F7A6A; text-transform: uppercase; letter-spacing: .04em; }
    .sum-val { font-size: 13px; font-weight: 700; color: #1F4E3D; }
    .sum-val.alert { color: #9C0006; }
    .sum-val.warn { color: #7F3F00; }
    .sum-val.ok { color: #1B6B3A; }
    .fundo-block { border-bottom: 1px solid #e0e0e0; }
    .fundo-header { padding: 7px 12px; display: grid; grid-template-columns: 180px 75px 60px 70px 50px 55px 55px 55px 55px 55px 55px 45px; align-items: center; gap: 0; font-size: 10px; }
    .fundo-header.abaixo { background: #FDE9E9; border-left: 3px solid #C0392B; }
    .fundo-header.acima { background: #FFF3E6; border-left: 3px solid #E07B39; }
    .fundo-header.ok { background: #F0FAF5; border-left: 3px solid #27AE60; }
    .fundo-header.neutro { background: #F8F8F8; border-left: 3px solid #BDBDBD; }
    .fundo-nome { font-weight: 700; font-size: 11px; color: #1a1a1a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fundo-admin { font-size: 10px; color: #666; font-weight: 400; }
    .num { text-align: right; font-size: 11px; font-family: 'Courier New', monospace; }
    .num.pos { color: #1B6B3A; font-weight: 700; }
    .num.neg { color: #9C0006; font-weight: 700; }
    .num.neutro { color: #555; }
    .col-h { font-size: 10px; color: #666; text-align: right; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
    .col-h.left { text-align: left; }
    .alertas-cell { display: flex; gap: 3px; justify-content: flex-end; }
    .badge { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; font-weight: 700; }
    .b-ab { background: #FFC7CE; color: #7B0000; }
    .b-ac { background: #FAD7B0; color: #6B3000; }
    .b-ok { background: #C6EFCE; color: #1B4D1B; }
    .b-nm { background: #E8E8E8; color: #555; }
    .ativos-table { width: 100%; border-collapse: collapse; }
    .ativos-table td { padding: 3px 8px; font-size: 9.5px; border-bottom: 1px solid #F0F0F0; font-family: 'Courier New', monospace; }
    .ativos-table td.nome-col { font-family: Arial, sans-serif; color: #333; padding-left: 24px; font-size: 9.5px; }
    .ativo-row.ab { background: #FDF2F2; }
    .ativo-row.ac { background: #FFF8F0; }
    .ativo-row.ok { background: #FAFFFE; }
    .ativo-row.nm { background: #FAFAFA; }
    .status-pill { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 10px; font-weight: 700; font-family: Arial, sans-serif; }
    .sp-ab { background: #FFC7CE; color: #7B0000; }
    .sp-ac { background: #FAD7B0; color: #6B3000; }
    .sp-ok { background: #C6EFCE; color: #1B4D1B; }
    .sp-nm { background: #E8E8E8; color: #555; }
    .detrator-tag { display: inline-block; background: #F8D7DA; color: #7B0000; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; margin-left: 4px; font-family: Arial, sans-serif; }
    .col-hdr-row td { background: #1F4E3D; color: #9FE1CB; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .02em; padding: 4px 8px; font-family: Arial, sans-serif; }
    .col-hdr-row td.right { text-align: right; }
    .col-hdr-row td.center { text-align: center; }
    .email-footer { background: #F5F5F5; border-top: 1px solid #ddd; padding: 8px 20px; font-size: 10px; color: #888; display: flex; justify-content: space-between; }
  </style>
</head>
<body>

<div class="email-wrap">

  <div class="email-header">
    <div>
      <div class="email-header-title">Relatório diário de rentabilidade</div>
      <div style="font-size:11px;color:#9FE1CB;margin-top:2px">Quadrante Investimentos · Controle de Cotas</div>
    </div>
    <div class="email-header-meta">
      <div style="font-size:13px;font-weight:700">${dataFormatada}</div>
      <div>${summary.totalFundos} fundos · ${summary.totalPosicoes} posições</div>
    </div>
  </div>

  <div class="summary-bar">
    <div class="sum-item"><span class="sum-label">Fundos</span><span class="sum-val">${summary.totalFundos}</span></div>
    <div class="sum-item"><span class="sum-label">Ativos OK</span><span class="sum-val ok">${summary.ativosOk}</span></div>
    <div class="sum-item"><span class="sum-label">Abaixo</span><span class="sum-val alert">${summary.ativosAbaixo} <span style="font-size:10px;font-weight:400">em ${summary.fundosComAbaixo} fundos</span></span></div>
    <div class="sum-item"><span class="sum-label">Acima</span><span class="sum-val warn">${summary.ativosAcima} <span style="font-size:10px;font-weight:400">em ${summary.fundosComAcima} fundos</span></span></div>
    <div class="sum-item"><span class="sum-label">Não mapeado</span><span class="sum-val" style="color:#555">${summary.ativosNaoMapeados}</span></div>
    <div class="sum-item" style="margin-left:auto"><span class="sum-label">PL Total</span><span class="sum-val">${formatCurrency(summary.plTotal)}</span></div>
  </div>

  <table class="ativos-table">
    <tr class="col-hdr-row">
      <td style="width:180px">Fundo / Ativo</td>
      <td class="right" style="width:75px">PL / Qtd</td>
      <td class="right" style="width:60px">PU</td>
      <td class="right" style="width:70px">Vl. Merc.</td>
      <td class="right" style="width:50px">% PL</td>
      <td class="right" style="width:55px">Ret/Var Dia</td>
      <td class="right" style="width:55px">vs CDI Dia</td>
      <td class="right" style="width:55px">Ret/Var Mês</td>
      <td class="right" style="width:55px">vs CDI Mês</td>
      <td class="right" style="width:55px">Ret/Var 12M</td>
      <td class="right" style="width:55px">vs CDI 12M</td>
      <td class="center" style="width:45px">Status</td>
    </tr>

    ${fundosOrdenados.map((fundo) => `
      <tr>
        <td colspan="12" style="padding:0">
          <div class="fundo-header ${fundo.statusGeral}">
            <div>
              <div class="fundo-nome">${fundo.nome_fundo || "—"}</div>
              <div class="fundo-admin">${fundo.administrador || "—"}</div>
            </div>
            <div class="${getNumClass(fundo.pl)}">${formatCurrency(fundo.pl)}</div>
            <div class="num neutro">${formatNumber(fundo.valor_cota)}</div>
            <div class="num neutro">—</div>
            <div class="num neutro">—</div>
            <div class="${getNumClass(fundo.ret_dia_pct)}">${formatPct(fundo.ret_dia_pct)}</div>
            <div class="${getNumClass(fundo.pct_cdi_dia)}">${formatPct(fundo.pct_cdi_dia, 2)}%</div>
            <div class="${getNumClass(fundo.ret_mes_pct)}">${formatPct(fundo.ret_mes_pct)}</div>
            <div class="${getNumClass(fundo.pct_cdi_mes)}">${formatPct(fundo.pct_cdi_mes, 2)}%</div>
            <div class="${getNumClass(fundo.ret_12m_pct)}">${formatPct(fundo.ret_12m_pct, 2)}</div>
            <div class="${getNumClass(fundo.pct_cdi_12m)}">${formatPct(fundo.pct_cdi_12m, 2)}%</div>
            <div class="alertas-cell">
              ${fundo.qtdAbaixo > 0 ? `<span class="badge b-ab">${fundo.qtdAbaixo}</span>` : ''}
              ${fundo.qtdAcima > 0 ? `<span class="badge b-ac">${fundo.qtdAcima}</span>` : ''}
              ${fundo.qtdAbaixo === 0 && fundo.qtdAcima === 0 ? `<span class="badge b-ok">OK</span>` : ''}
            </div>
          </div>
        </td>
      </tr>
      ${fundo.ativos.map((ativo) => `
        <tr class="ativo-row ${ativo.status}">
          <td class="nome-col">
            ${ativo.nome}
            ${ativo.isDetrator ? '<span class="detrator-tag">detrator</span>' : ''}
          </td>
          <td class="num" style="text-align:right">${formatNumber(ativo.qtd, 0)}</td>
          <td class="num" style="text-align:right">${formatNumber(ativo.pu)}</td>
          <td class="${getNumClass(ativo.vlMercado)}" style="text-align:right">${formatCurrency(ativo.vlMercado)}</td>
          <td class="${getNumClass(ativo.percPL)}" style="text-align:right">${formatPct(ativo.percPL, 1)}</td>
          <td class="${getNumClass(ativo.varDia)}" style="text-align:right">${formatPct(ativo.varDia)}</td>
          <td class="${getNumClass(ativo.vsCdiDia)}" style="text-align:right">${formatPct(ativo.vsCdiDia, 2)}%</td>
          <td class="${getNumClass(ativo.varMes)}" style="text-align:right">${formatPct(ativo.varMes)}</td>
          <td class="${getNumClass(ativo.vsCdiMes)}" style="text-align:right">${formatPct(ativo.vsCdiMes, 2)}%</td>
          <td class="${getNumClass(ativo.var12M)}" style="text-align:right">${formatPct(ativo.var12M, 2)}</td>
          <td class="${getNumClass(ativo.vsCdi12M)}" style="text-align:right">${formatPct(ativo.vsCdi12M, 2)}%</td>
          <td style="text-align:center"><span class="status-pill sp-${ativo.status}">${getStatusLabel(ativo.status)}</span></td>
        </tr>
      `).join('')}
    `).join('')}
  </table>

  <div class="email-footer">
    <span>Gerado automaticamente · Frame Control Center · ${format(new Date(), "dd/MM/yyyy HH:mm", { locale: ptBR })}</span>
    <span>Anexo: rentabilidade_${dataReferencia}.pdf</span>
  </div>

</div>

</body>
</html>`;
}

/**
 * Prepara dados dos fundos para o relatório
 */
export function prepareFundosRelatorio(
  fundos: RentabilidadeFundoRow[],
  ativosMap: Map<string, AtivoRelatorio[]>
): { fundos: FundoRelatorio[]; summary: SummaryData } {
  const fundosComAtivos: FundoRelatorio[] = [];
  
  let ativosOk = 0;
  let ativosAbaixo = 0;
  let ativosAcima = 0;
  let ativosNaoMapeados = 0;
  const fundosComAbaixoSet = new Set<string>();
  const fundosComAcimaSet = new Set<string>();
  let plTotal = 0;
  let totalPosicoes = 0;

  for (const fundo of fundos) {
    const ativos = ativosMap.get(fundo.fundo_cnpj) || [];
    
    let qtdAbaixo = 0;
    let qtdAcima = 0;
    
    for (const ativo of ativos) {
      totalPosicoes++;
      if (ativo.status === "abaixo") {
        qtdAbaixo++;
        ativosAbaixo++;
        fundosComAbaixoSet.add(fundo.fundo_cnpj);
      } else if (ativo.status === "acima") {
        qtdAcima++;
        ativosAcima++;
        fundosComAcimaSet.add(fundo.fundo_cnpj);
      } else if (ativo.status === "ok") {
        ativosOk++;
      } else if (ativo.status === "nm") {
        ativosNaoMapeados++;
      }
    }
    
    let statusGeral: FundoRelatorio["statusGeral"] = "neutro";
    if (qtdAbaixo > 0) statusGeral = "abaixo";
    else if (qtdAcima > 0) statusGeral = "acima";
    else if (ativos.length > 0) statusGeral = "ok";
    
    fundosComAtivos.push({
      ...fundo,
      ativos,
      statusGeral,
      qtdAbaixo,
      qtdAcima,
    });
    
    plTotal += fundo.pl || 0;
  }

  const summary: SummaryData = {
    totalFundos: fundos.length,
    ativosOk,
    ativosAbaixo,
    fundosComAbaixo: fundosComAbaixoSet.size,
    ativosAcima,
    fundosComAcima: fundosComAcimaSet.size,
    ativosNaoMapeados,
    plTotal,
    totalPosicoes,
  };

  return { fundos: fundosComAtivos, summary };
}
