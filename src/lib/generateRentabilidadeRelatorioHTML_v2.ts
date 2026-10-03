/**
 * Geração de HTML para relatório diário de rentabilidade - Versão 2
 * Com todas as colunas solicitadas
 */

import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";

export interface AtivoRelatorio {
  nome: string;
  cnpj?: string | null;
  qtd: number | null;
  pu: number | null;
  vlMercado: number | null;
  percPL: number;
  varDia: number | null;
  vsCdiDia: number | null;
  cdiPlusAaDia: number | null;
  varMes: number | null;
  vsCdiMes: number | null;
  cdiPlusAaMes: number | null;
  varAno: number | null;
  vsCdiAno: number | null;
  cdiPlusAaAno: number | null;
  var12M: number | null;
  vsCdi12M: number | null;
  cdiPlusAa12m: number | null;
  status: "abaixo" | "acima" | "ok" | "nm";
  isDetrator?: boolean;
}

export interface FundoRelatorio {
  fundo_cnpj: string;
  nome_fundo: string;
  administrador?: string;
  /** Data da posição (YYYY-MM-DD) — usada na aba Resumo Fundos do Excel. */
  data_posicao?: string;
  valor_cota: number | null;
  pl: number | null;
  ret_dia_pct: number | null;
  pct_cdi_dia: number | null;
  cdi_plus_aa_dia_pct: number | null;
  ret_mes_pct: number | null;
  pct_cdi_mes: number | null;
  cdi_plus_aa_mes_pct: number | null;
  ret_ano_pct: number | null;
  pct_cdi_ano: number | null;
  cdi_plus_aa_ano_pct: number | null;
  ret_12m_pct: number | null;
  pct_cdi_12m: number | null;
  cdi_plus_aa_12m_pct: number | null;
  cdi_dia_pct: number | null;
  ativos: AtivoRelatorio[];
  statusGeral: "abaixo" | "acima" | "ok" | "neutro";
  qtdAbaixo: number;
  qtdAcima: number;
}

export interface SummaryData {
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
    return `R$ ${(value / 1_000_000_000).toFixed(2)}bi`;
  }
  if (Math.abs(value) >= 1_000_000) {
    return `R$ ${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `R$ ${(value / 1_000).toFixed(1)}k`;
  }
  return `R$ ${value.toFixed(2)}`;
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

/**
 * Abrevia nomes longos de administradores removendo sufixos corporativos.
 * Ex.: "BTG PACTUAL SERVICOS FINANCEIROS S/A DTVM" → "BTG PACTUAL"
 */
export function abreviarAdministrador(nome: string | null | undefined): string {
  if (!nome) return "—";
  const clean = nome
    .replace(/\s+(SERVI[CÇ]OS\s+FINANCEIROS).*$/i, "")
    .replace(/\s+(DISTRIBUIDORA\s+DE\s+(T[IÍ]TULOS|VALORES).*|DISTRIBUIDORA).*$/i, "")
    .replace(/\s+(CCTVM|CTVM|DTVM)\s+S\/?A.*$/i, "")
    .replace(/\s+S\/?A\s+DTVM.*$/i, "")
    .replace(/\s+S\.A\..*$/i, "")
    .replace(/\s+S\/A.*$/i, "")
    .replace(/\s+LTDA.*$/i, "")
    .trim();
  return clean || nome;
}

function formatNumber(value: number | null, decimals = 3): string {
  if (value == null) return "—";
  return value.toLocaleString("pt-BR", { 
    minimumFractionDigits: decimals, 
    maximumFractionDigits: decimals 
  });
}

/**
 * Formata a coluna "vs CDI" idêntica à UI:
 * linha 1: "CDI +79,17% a.a."  (cdiPlusAa)
 * linha 2: "534,11% do CDI"    (pctCdi)
 */
function formatVsCDIHtml(cdiPlusAa: number | null, pctCdi: number | null): string {
  if (cdiPlusAa == null && pctCdi == null) return "<span style=\"color:#888\">—</span>";
  // Quando retorno é negativo (% do CDI < 0), exibir "—" como na UI
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
    ? `<span style="color:#555;font-size:8px;">${pctCdi.toFixed(2).replace(".", ",")}% do CDI</span>`
    : "";
  return [line1, line2].filter(Boolean).join("<br>");
}

function getNumClass(value: number | null): string {
  if (value == null) return "num neutro";
  if (value > 0.001) return "num pos";
  if (value < -0.001) return "num neg";
  return "num neutro";
}

function renderTabelaColunasHeader(): string {
  return `
        <tr class="thead-row">
          <th style="width: 200px;">Fundo / Ativo</th>
          <th style="width: 80px;">PL / Qtd</th>
          <th style="width: 70px;">Cota / PU</th>
          <th style="width: 62px;">Adm / % PL</th>
          <th style="width: 70px;">Ret/Var Dia</th>
          <th style="width: 70px;">vs CDI Dia</th>
          <th style="width: 70px;">Ret/Var Mês</th>
          <th style="width: 70px;">vs CDI Mês</th>
          <th style="width: 70px;">Ret/Var Ano</th>
          <th style="width: 70px;">vs CDI Ano</th>
          <th style="width: 70px;">Ret/Var 12M</th>
          <th style="width: 70px;">CDI Dia / vs CDI 12M</th>
        </tr>`;
}

const NOME_ATIVO_MAX_CHARS = 38;

/** Nome curto para HTML: sigla de nomes_fundos ou truncar em 38 chars. */
export function formatNomeAtivoHTML(
  nome: string,
  cnpj?: string | null,
  siglasPorCnpj?: Record<string, string>,
): string {
  const key = cnpj?.replace(/\D/g, "") ?? "";
  if (key && siglasPorCnpj?.[key]) return siglasPorCnpj[key];
  if (nome.length <= NOME_ATIVO_MAX_CHARS) return nome;
  return `${nome.slice(0, NOME_ATIVO_MAX_CHARS - 1)}…`;
}

/**
 * Gera o HTML completo do relatório diário
 */
export function generateRentabilidadeRelatorioHTML(
  fundos: FundoRelatorio[],
  summary: SummaryData,
  dataReferencia: string,
  siglasPorCnpj?: Record<string, string>,
): string {
  const dataFormatada = format(parseISO(dataReferencia), "dd/MM/yyyy", { locale: ptBR });

  // Ordenar fundos: alertas primeiro
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
    body { font-family: Arial, sans-serif; font-size: 11px; color: #1a1a1a; background: #f5f5f5; padding: 20px; }
    .relatorio-container { max-width: 1400px; margin: 0 auto; background: #fff; }
    
    /* Header */
    .header { background: #1F4E3D; color: #fff; padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; }
    .header-title { font-size: 16px; font-weight: 700; }
    .header-subtitle { font-size: 11px; color: #9FE1CB; margin-top: 4px; }
    .header-meta { text-align: right; }
    .header-date { font-size: 14px; font-weight: 700; }
    .header-info { font-size: 10px; color: #9FE1CB; margin-top: 2px; }
    
    /* Summary */
    .summary { background: #F0F4F2; border-bottom: 1px solid #d4e0db; padding: 12px 20px; display: flex; gap: 24px; flex-wrap: wrap; }
    .sum-item { display: flex; flex-direction: column; gap: 2px; }
    .sum-label { font-size: 9px; color: #5F7A6A; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; }
    .sum-val { font-size: 14px; font-weight: 700; color: #1F4E3D; }
    .sum-val.alert { color: #9C0006; }
    .sum-val.warn { color: #7F3F00; }
    .sum-val.ok { color: #1B6B3A; }
    
    /* Table */
    .table-wrap { overflow-x: auto; }
    .data-table { width: 100%; border-collapse: collapse; min-width: 1200px; }
    
    /* Header Row */
    .thead-row { background: #1F4E3D; color: #9FE1CB; }
    .thead-row th { font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .02em; padding: 6px 6px; text-align: right; border-right: 1px solid #2D5D4A; white-space: nowrap; }
    .thead-row th:first-child { text-align: left; }
    .thead-row th:last-child { border-right: none; text-align: center; }
    
    /* Fundo Row */
    .fundo-row { border-bottom: 2px solid #e0e0e0; }
    .fundo-row.abaixo { background: #FDE9E9; border-left: 4px solid #C0392B; }
    .fundo-row.acima { background: #FFF3E6; border-left: 4px solid #E07B39; }
    .fundo-row.ok { background: #F0FAF5; border-left: 4px solid #27AE60; }
    .fundo-row.neutro { background: #F8F8F8; border-left: 4px solid #BDBDBD; }
    .fundo-row td { padding: 8px 6px; font-size: 10px; border-right: 1px solid rgba(0,0,0,0.05); }
    .fundo-row td:last-child { border-right: none; }
    
    /* Ativo Row */
    .ativo-row { border-bottom: 1px solid #F0F0F0; }
    .ativo-row.abaixo { background: #FDF2F2; }
    .ativo-row.acima { background: #FFF8F0; }
    .ativo-row.ok { background: #FAFFFE; }
    .ativo-row.nm { background: #FAFAFA; }
    .ativo-row td { padding: 5px 6px; font-size: 9px; font-family: 'Courier New', monospace; border-right: 1px solid rgba(0,0,0,0.03); }
    .ativo-row td:first-child { font-family: Arial, sans-serif; padding-left: 24px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ativo-row td:last-child { border-right: none; }
    
    /* Cells */
    .cell-nome { font-weight: 600; color: #1a1a1a; }
    .cell-admin { font-size: 9px; color: #666; margin-top: 2px; }
    .cell-num { text-align: right; font-family: 'Courier New', monospace; }
    .cell-num.pos { color: #1B6B3A; font-weight: 700; }
    .cell-num.neg { color: #9C0006; font-weight: 700; }
    .cell-num.neutro { color: #555; }
    
    /* Badge */
    .badge { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 8px; font-weight: 700; margin-left: 4px; }
    .badge.abaixo { background: #FFC7CE; color: #7B0000; }
    .badge.acima { background: #FAD7B0; color: #6B3000; }
    .badge.ok { background: #C6EFCE; color: #1B4D1B; }
    .detrator { background: #F8D7DA; color: #7B0000; font-size: 7px; padding: 1px 4px; border-radius: 2px; margin-left: 4px; }
    
    /* Footer */
    .footer { background: #F5F5F5; border-top: 1px solid #ddd; padding: 10px 20px; font-size: 9px; color: #888; display: flex; justify-content: space-between; }
  </style>
</head>
<body>

<div class="relatorio-container">
  
  <!-- Header -->
  <div class="header">
    <div>
      <div class="header-title">Relatório Diário de Rentabilidade</div>
      <div class="header-subtitle">Quadrante Investimentos · Controle de Cotas</div>
    </div>
    <div class="header-meta">
      <div class="header-date">${dataFormatada}</div>
      <div class="header-info">${summary.totalFundos} fundos · ${summary.totalPosicoes} posições</div>
    </div>
  </div>
  
  <!-- Summary -->
  <div class="summary">
    <div class="sum-item"><span class="sum-label">Fundos</span><span class="sum-val">${summary.totalFundos}</span></div>
    <div class="sum-item"><span class="sum-label">Posições</span><span class="sum-val">${summary.totalPosicoes}</span></div>
    <div class="sum-item" style="margin-left: auto;"><span class="sum-label">PL Total</span><span class="sum-val">${formatCurrency(summary.plTotal)}</span></div>
  </div>
  
  <!-- Table -->
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        ${renderTabelaColunasHeader()}
      </thead>
      <tbody>
        ${fundosOrdenados.map(fundo => `
          <!-- Fundo -->
          <tr class="fundo-row ${fundo.statusGeral}">
            <td>
              <div class="cell-nome">${fundo.nome_fundo || "—"}</div>
            </td>
            <td class="cell-num ${getNumClass(fundo.pl)}">${formatCurrency(fundo.pl)}</td>
            <td class="cell-num neutro">${formatNumber(fundo.valor_cota, 4)}</td>
            <td class="cell-num neutro" style="text-align:left;font-family:Arial,sans-serif;font-size:9px;">${abreviarAdministrador(fundo.administrador)}</td>
            <td class="cell-num ${getNumClass(fundo.ret_dia_pct)}">${formatPct(fundo.ret_dia_pct, 4)}</td>
            <td class="cell-num" style="text-align:right;">${formatVsCDIHtml(fundo.cdi_plus_aa_dia_pct, fundo.pct_cdi_dia)}</td>
            <td class="cell-num ${getNumClass(fundo.ret_mes_pct)}">${formatPct(fundo.ret_mes_pct, 4)}</td>
            <td class="cell-num" style="text-align:right;">${formatVsCDIHtml(fundo.cdi_plus_aa_mes_pct, fundo.pct_cdi_mes)}</td>
            <td class="cell-num ${getNumClass(fundo.ret_ano_pct)}">${formatPct(fundo.ret_ano_pct, 4)}</td>
            <td class="cell-num" style="text-align:right;">${formatVsCDIHtml(fundo.cdi_plus_aa_ano_pct, fundo.pct_cdi_ano)}</td>
            <td class="cell-num ${getNumClass(fundo.ret_12m_pct)}">${formatPct(fundo.ret_12m_pct, 2)}</td>
            <td class="cell-num ${getNumClass(fundo.cdi_dia_pct)}">${formatPct(fundo.cdi_dia_pct, 4)}</td>
          </tr>
          
          ${fundo.ativos.length > 0 ? renderTabelaColunasHeader() : ''}
          
          <!-- Ativos -->
          ${fundo.ativos.map(ativo => `
            <tr class="ativo-row ${ativo.status}">
              <td title="${ativo.nome.replace(/"/g, "&quot;")}">
                ${formatNomeAtivoHTML(ativo.nome, ativo.cnpj, siglasPorCnpj)}${ativo.isDetrator ? '&nbsp;<span class="detrator">DETRATOR</span>' : ''}
              </td>
              <td class="cell-num neutro">${formatNumber(ativo.qtd, 0)}</td>
              <td class="cell-num neutro">${formatNumber(ativo.pu, 4)}</td>
              <td class="cell-num ${getNumClass(ativo.percPL)}">${formatPctSemSinal(ativo.percPL, 1)}</td>
              <td class="cell-num ${getNumClass(ativo.varDia)}">${formatPct(ativo.varDia, 4)}</td>
              <td class="cell-num" style="text-align:right;">${formatVsCDIHtml(ativo.cdiPlusAaDia, ativo.vsCdiDia)}</td>
              <td class="cell-num ${getNumClass(ativo.varMes)}">${formatPct(ativo.varMes, 4)}</td>
              <td class="cell-num" style="text-align:right;">${formatVsCDIHtml(ativo.cdiPlusAaMes, ativo.vsCdiMes)}</td>
              <td class="cell-num ${getNumClass(ativo.varAno)}">${formatPct(ativo.varAno, 4)}</td>
              <td class="cell-num" style="text-align:right;">${formatVsCDIHtml(ativo.cdiPlusAaAno, ativo.vsCdiAno)}</td>
              <td class="cell-num ${getNumClass(ativo.var12M)}">${formatPct(ativo.var12M, 2)}</td>
              <td class="cell-num" style="text-align:right;">${formatVsCDIHtml(ativo.cdiPlusAa12m, ativo.vsCdi12M)}</td>
            </tr>
          `).join('')}
        `).join('')}
      </tbody>
    </table>
  </div>
  
  <!-- Footer -->
  <div class="footer">
    <span>Gerado automaticamente · Hub Risco · ${format(new Date(), "dd/MM/yyyy HH:mm", { locale: ptBR })}</span>
    <span>Anexo: planilha Excel de rentabilidade</span>
  </div>
  
</div>

</body>
</html>`;
}

/**
 * Prepara dados dos fundos para o relatório
 */
export function prepareFundosRelatorio(
  fundos: any[],
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
    const fundoKey = fundo.fundo_key ?? fundo.fundo_cnpj;
    const ativos = ativosMap.get(fundoKey) || [];
    
    let qtdAbaixo = 0;
    let qtdAcima = 0;
    
    for (const ativo of ativos) {
      totalPosicoes++;
      if (ativo.status === "abaixo") {
        qtdAbaixo++;
        ativosAbaixo++;
        fundosComAbaixoSet.add(fundoKey);
      } else if (ativo.status === "acima") {
        qtdAcima++;
        ativosAcima++;
        fundosComAcimaSet.add(fundoKey);
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
      fundo_cnpj: fundo.fundo_cnpj,
      nome_fundo: fundo.nome_fundo ?? "",
      administrador: fundo.administrador ?? undefined,
      data_posicao: fundo.data_posicao ?? undefined,
      valor_cota: fundo.valor_cota ?? null,
      pl: fundo.pl ?? null,
      ret_dia_pct: fundo.retorno_dia_pct ?? null,
      pct_cdi_dia: fundo.pct_cdi ?? null,
      cdi_plus_aa_dia_pct: fundo.cdi_plus_aa_pct ?? null,
      ret_mes_pct: fundo.retorno_mes_pct ?? null,
      pct_cdi_mes: fundo.pct_cdi_mes ?? null,
      cdi_plus_aa_mes_pct: fundo.cdi_plus_aa_mes_pct ?? null,
      ret_ano_pct: fundo.retorno_ano_pct ?? null,
      pct_cdi_ano: fundo.pct_cdi_ano ?? null,
      cdi_plus_aa_ano_pct: fundo.cdi_plus_aa_ano_pct ?? null,
      ret_12m_pct: fundo.retorno_12m_pct ?? null,
      pct_cdi_12m: fundo.pct_cdi_12m ?? null,
      cdi_plus_aa_12m_pct: fundo.cdi_plus_aa_12m_pct ?? null,
      cdi_dia_pct: fundo.cdi_dia_pct ?? null,
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
