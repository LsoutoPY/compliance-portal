/**
 * Tipos e preparação de dados do relatório — porte Deno de
 * `src/lib/generateRentabilidadeRelatorioHTML_v2.ts` (subset usado no e-mail/Excel).
 */

import type { RentabilidadeFundoRow } from "./calc.ts";

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

const NOME_ATIVO_MAX_CHARS = 38;

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

export function prepareFundosRelatorio(
  fundos: RentabilidadeFundoRow[],
  ativosMap: Map<string, AtivoRelatorio[]>,
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
