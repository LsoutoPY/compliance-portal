/**
 * Excel anexo do envio automático — versão nível-fundo (sem drill-down de ativos).
 * Para o relatório completo com ativos, usar a tela "Enviar Relatório" (manual),
 * que gera o Excel completo via `src/lib/generateRentabilidadeRelatorioExcel.ts`.
 */

import * as XLSX from "npm:xlsx@0.18.5";
import type { RentabilidadeFundoRow } from "./calc.ts";
import { isFundoExclusivoRentabilidade } from "./calc.ts";

function fmtCnpj(cnpj: string): string {
  const numeros = cnpj.replace(/\D/g, "");
  if (numeros.length !== 14) return cnpj;
  return numeros.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

const HEADER = [
  "Fundo",
  "CNPJ",
  "Administrador",
  "PL",
  "Cota",
  "Ret. Dia %",
  "% CDI Dia",
  "Ret. Mês %",
  "% CDI Mês",
  "Ret. Ano %",
  "% CDI Ano",
  "Ret. 12M %",
  "% CDI 12M",
];

function fundoToRow(f: RentabilidadeFundoRow): unknown[] {
  return [
    f.nome_fundo || "—",
    fmtCnpj(f.fundo_cnpj),
    f.administrador || "—",
    f.pl ?? null,
    f.valor_cota ?? null,
    f.retorno_dia_pct != null ? f.retorno_dia_pct / 100 : null,
    f.pct_cdi != null ? f.pct_cdi / 100 : null,
    f.retorno_mes_pct != null ? f.retorno_mes_pct / 100 : null,
    f.pct_cdi_mes != null ? f.pct_cdi_mes / 100 : null,
    f.retorno_ano_pct != null ? f.retorno_ano_pct / 100 : null,
    f.pct_cdi_ano != null ? f.pct_cdi_ano / 100 : null,
    f.retorno_12m_pct != null ? f.retorno_12m_pct / 100 : null,
    f.pct_cdi_12m != null ? f.pct_cdi_12m / 100 : null,
  ];
}

function workbookToBase64(wb: XLSX.WorkBook): string {
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function rentabilidadeAutoExcelFilename(dataReferencia: string): string {
  return `Rentabilidade_${dataReferencia.replace(/-/g, "")}.xlsx`;
}

function fmtBRL(v: number): string {
  return `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface SecaoRows {
  dataRows: number[];
  plOnlyRows: number[];
}

/** Escreve uma seção (Condominiais/Exclusivos) na aoa e retorna as linhas (1-indexed) com dados numéricos. */
function appendSecao(
  aoa: unknown[][],
  titulo: string,
  fundos: RentabilidadeFundoRow[],
): SecaoRows {
  const plSecao = fundos.reduce((s, f) => s + (f.pl ?? 0), 0);
  aoa.push([`${titulo}   ·   ${fundos.length} fundo${fundos.length !== 1 ? "s" : ""}   ·   PL: ${fmtBRL(plSecao)}`]);
  aoa.push(HEADER);

  const dataRows: number[] = [];
  const plOnlyRows: number[] = [];
  if (fundos.length === 0) {
    aoa.push(["Nenhum fundo nesta categoria"]);
  } else {
    for (const f of fundos) {
      aoa.push(fundoToRow(f));
      dataRows.push(aoa.length); // 1-indexed (aoa.length já é a linha desta entrada)
    }
    aoa.push([`Subtotal — ${titulo}`, "", "", plSecao]);
    plOnlyRows.push(aoa.length);
  }
  aoa.push([]);
  return { dataRows, plOnlyRows };
}

export function buildRentabilidadeAutoExcel(
  fundos: RentabilidadeFundoRow[],
  dataReferencia: string,
): { base64: string; filename: string } {
  const dataFmt = dataReferencia.split("-").reverse().join("/");
  const plTotal = fundos.reduce((s, f) => s + (f.pl ?? 0), 0);

  const fundosCondominiais = [...fundos]
    .filter((f) => !isFundoExclusivoRentabilidade(f.nome_fundo))
    .sort((a, b) => (b.pl ?? 0) - (a.pl ?? 0));
  const fundosExclusivos = [...fundos]
    .filter((f) => isFundoExclusivoRentabilidade(f.nome_fundo))
    .sort((a, b) => (b.pl ?? 0) - (a.pl ?? 0));

  const aoa: unknown[][] = [
    [`RELATÓRIO DE RENTABILIDADE — CVPAR QUADRANTE (${dataFmt})`],
    [`${fundos.length} fundo(s) · PL Total: ${fmtBRL(plTotal)}`],
    [],
  ];

  const secaoCondominiais = appendSecao(aoa, "FUNDOS CONDOMINIAIS", fundosCondominiais);
  const secaoExclusivos = appendSecao(aoa, "FUNDOS EXCLUSIVOS", fundosExclusivos);

  aoa.push([`TOTAL GERAL — ${fundos.length} fundos`, "", "", plTotal]);
  const totalRow = aoa.length;

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 48 },
    { wch: 20 },
    { wch: 26 },
    { wch: 18 },
    { wch: 14 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
  ];

  const pctFmt = "0.00%";
  const brlFmt = '"R$" #,##0.00';
  for (const r of [...secaoCondominiais.dataRows, ...secaoExclusivos.dataRows]) {
    const plCell = ws[`D${r}`];
    if (plCell) plCell.z = brlFmt;
    const cotaCell = ws[`E${r}`];
    if (cotaCell) cotaCell.z = "0.000000";
    for (const col of ["F", "G", "H", "I", "J", "K", "L", "M"]) {
      const cell = ws[`${col}${r}`];
      if (cell) cell.z = pctFmt;
    }
  }
  for (const r of [...secaoCondominiais.plOnlyRows, ...secaoExclusivos.plOnlyRows, totalRow]) {
    const plCell = ws[`D${r}`];
    if (plCell) plCell.z = brlFmt;
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Rentabilidade");

  return { base64: workbookToBase64(wb), filename: rentabilidadeAutoExcelFilename(dataReferencia) };
}
