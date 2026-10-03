/**
 * Exportação Excel — aba Conferência (Controle de Taxas).
 * Paleta institucional do sistema (mesma dos demais exports: verde sidebar #003D27, cinza #737D87).
 */

import ExcelJS from 'exceljs'
import { supabase } from '@/integrations/supabase/client'
import { fmtCNPJ } from '@/lib/fundos-taxas-utils'
import { SEGMENTO_LABELS, type Segmento } from '@/types/fundos-taxas'
import {
  fmtMesRefLongo,
  intervaloMes,
  mesRefToMesAno,
  type ConferenciaTaxaDiaria,
  type ConferenciaTaxaMes,
  type ReferenciaProvisoesMes,
} from '@/types/conferencia-taxas'

// ── Paleta institucional (igual StressPainel.tsx / cadastro-partes-export.ts) ──
const SYS = {
  verde: 'FF003D27',
  cinza: 'FF737D87',
  cinzaClaro: 'FFF1F5F9',
  branco: 'FFFFFFFF',
  preto: 'FF272A30',
  vermelho: 'FF9C0006',
  verdeNum: 'FF276221',
  cinzaNum: 'FF475569',
  rowAlt: 'FFF8FAFC',
  amber: 'FFFEF3C7',
  amberText: 'FF92400E',
}

const MOEDA_FMT = '"R$" #,##0.00'

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function segmentoLabel(segmento: string): string {
  return segmento in SEGMENTO_LABELS ? SEGMENTO_LABELS[segmento as Segmento] : segmento
}

function fmtConfigTaxa(pct: number, min: number | null, fixo: number | null): string {
  if (fixo != null && fixo > 0) return `Fixo`
  if (pct > 0) return `${(pct * 100).toFixed(4)}% a.a.`
  return '—'
}

function fill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } }
}

function styleHeaderRow(row: ExcelJS.Row, bg = SYS.verde) {
  row.eachCell(cell => {
    cell.fill = fill(bg)
    cell.font = { bold: true, color: { argb: SYS.branco }, size: 10 }
    cell.alignment = { vertical: 'middle' }
  })
}

function cleanCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, '')
}

// ── Busca em massa (uma query por mês, não por fundo) ─────────────────────

async function fetchDiariaBulk(cnpjs: string[], mesRef: string): Promise<ConferenciaTaxaDiaria[]> {
  const { inicio, fim } = intervaloMes(mesRef)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('vw_conferencia_taxas_diaria')
    .select('*')
    .in('fundo_cnpj', cnpjs)
    .gte('data_ref', inicio)
    .lte('data_ref', fim)
    .order('fundo_cnpj')
    .order('data_ref', { ascending: true })

  if (error) throw new Error(error.message)
  return (data ?? []) as ConferenciaTaxaDiaria[]
}

async function fetchProvisoesBulk(cnpjs: string[], mesRef: string): Promise<Map<string, ReferenciaProvisoesMes>> {
  const cnpjsLimpos = cnpjs.map(cleanCnpj)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('vw_provisoes_taxas_mes')
    .select('*')
    .in('fundo_cnpj', cnpjsLimpos)
    .eq('mes_ref', mesRef)

  if (error) throw new Error(error.message)
  const map = new Map<string, ReferenciaProvisoesMes>()
  for (const row of (data ?? []) as ReferenciaProvisoesMes[]) {
    map.set(row.fundo_cnpj, row)
  }
  return map
}

type ExtratoAdm = { ta: number | null; tg: number | null; tc: number | null; total: number | null }

async function fetchExtratoBulk(cnpjs: string[], mesRef: string): Promise<Map<string, ExtratoAdm>> {
  const mesAno = mesRefToMesAno(mesRef)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('despesas_fundo')
    .select('categoria_despesa, valor, fundo_cnpj')
    .eq('mes_ano', mesAno)

  if (error) throw new Error(error.message)

  const cnpjsLimpos = new Set(cnpjs.map(cleanCnpj))
  const porFundo = new Map<string, { ta: number; tg: number; tc: number }>()

  for (const row of (data ?? []) as Array<{ categoria_despesa: string | null; valor: number; fundo_cnpj: string | null }>) {
    if (!row.fundo_cnpj) continue
    const cnpj = cleanCnpj(row.fundo_cnpj)
    if (!cnpjsLimpos.has(cnpj)) continue
    if (!porFundo.has(cnpj)) porFundo.set(cnpj, { ta: 0, tg: 0, tc: 0 })
    const acc = porFundo.get(cnpj)!
    const valor = Math.abs(Number(row.valor))
    if (row.categoria_despesa === 'taxa_administracao') acc.ta += valor
    else if (row.categoria_despesa === 'taxa_gestao') acc.tg += valor
    else if (row.categoria_despesa === 'taxa_custodia') acc.tc += valor
  }

  const map = new Map<string, ExtratoAdm>()
  for (const [cnpj, acc] of porFundo) {
    const ta = acc.ta > 0 ? acc.ta : null
    const tg = acc.tg > 0 ? acc.tg : null
    const tc = acc.tc > 0 ? acc.tc : null
    const total = [ta, tg, tc].filter((v): v is number => v != null).reduce((s, v) => s + v, 0)
    map.set(cnpj, { ta, tg, tc, total: total > 0 ? total : null })
  }
  return map
}

// ── Sheet: Resumo mensal ────────────────────────────────────────────────────

function buildSheetResumo(wb: ExcelJS.Workbook, fundos: ConferenciaTaxaMes[], mesRef: string) {
  const ws = wb.addWorksheet('Resumo mensal')
  ws.columns = [
    { header: 'Fundo', width: 38 },
    { header: 'CNPJ', width: 20 },
    { header: 'Tipo', width: 8 },
    { header: 'Administrador', width: 26 },
    { header: 'Gestor', width: 22 },
    { header: 'Segmento', width: 16 },
    { header: 'TX ADM', width: 12 },
    { header: 'TX Gestão', width: 12 },
    { header: 'TX Custódia', width: 12 },
    { header: 'Gross Up', width: 10 },
    { header: 'Dias úteis', width: 10 },
    { header: 'PL último dia útil', width: 18 },
    { header: 'TA/mês', width: 16 },
    { header: 'TG/mês', width: 16 },
    { header: 'TC/mês', width: 16 },
    { header: 'Total/mês', width: 16 },
  ]

  ws.mergeCells('A1:P1')
  const titulo = ws.getCell('A1')
  titulo.value = `Conferência de Taxas — ${fmtMesRefLongo(mesRef)}`
  titulo.font = { bold: true, size: 13, color: { argb: SYS.preto } }
  ws.insertRow(2, [])

  const headerRow = ws.getRow(3)
  headerRow.values = ws.columns.map(c => c.header as string)
  styleHeaderRow(headerRow)
  ws.views = [{ state: 'frozen', ySplit: 3 }]

  fundos.forEach((f, i) => {
    const row = ws.addRow([
      f.denominacao_social ?? fmtCNPJ(f.fundo_cnpj),
      fmtCNPJ(f.fundo_cnpj),
      f.tipo_fundo,
      f.administrador ?? '—',
      f.gestor ?? '—',
      segmentoLabel(f.segmento),
      f.tem_ta ? fmtConfigTaxa(f.ta_percentual, f.ta_minimo_mensal, f.ta_fixo_mensal) : '—',
      f.tem_tg ? fmtConfigTaxa(f.tg_percentual, f.tg_minimo_mensal, f.tg_fixo_mensal) : '—',
      f.tem_tc ? fmtConfigTaxa(f.tc_percentual, f.tc_minimo_mensal, f.tc_fixo_mensal) : '—',
      f.gross_up_ativo ? 'Sim' : 'Não',
      f.qtd_dias_uteis,
      f.pl_ultimo,
      f.ta_mensal || null,
      f.tg_mensal || null,
      f.tc_mensal || null,
      f.total_mensal,
    ])

    const bg = i % 2 === 0 ? SYS.branco : SYS.rowAlt
    row.eachCell(cell => {
      cell.fill = fill(bg)
      cell.font = { color: { argb: SYS.preto }, size: 10 }
    })
    ;[12, 13, 14, 15, 16].forEach(col => (row.getCell(col).numFmt = MOEDA_FMT))
    row.getCell(16).font = { bold: true, color: { argb: SYS.preto }, size: 10 }
    if (f.gross_up_ativo) {
      row.getCell(10).fill = fill(SYS.amber)
      row.getCell(10).font = { bold: true, color: { argb: SYS.amberText }, size: 10 }
    }
  })

  const totalRow = ws.addRow([
    `Total (${fundos.length} fundos)`, '', '', '', '', '', '', '', '', '', '', '',
    fundos.reduce((s, f) => s + (f.ta_mensal || 0), 0) || null,
    fundos.reduce((s, f) => s + (f.tg_mensal || 0), 0) || null,
    fundos.reduce((s, f) => s + (f.tc_mensal || 0), 0) || null,
    fundos.reduce((s, f) => s + (f.total_mensal || 0), 0),
  ])
  ws.mergeCells(`A${totalRow.number}:L${totalRow.number}`)
  totalRow.eachCell(cell => {
    cell.fill = fill(SYS.cinzaClaro)
    cell.font = { bold: true, color: { argb: SYS.preto }, size: 10 }
  })
  ;[13, 14, 15, 16].forEach(col => (totalRow.getCell(col).numFmt = MOEDA_FMT))

  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: 16 } }
}

// ── Sheet: Confronto mensal (calculado vs XML vs extrato) ──────────────────

function buildSheetConfronto(
  wb: ExcelJS.Workbook,
  fundos: ConferenciaTaxaMes[],
  provisoesMap: Map<string, ReferenciaProvisoesMes>,
  extratoMap: Map<string, ExtratoAdm>,
) {
  const ws = wb.addWorksheet('Confronto mensal')
  ws.columns = [
    { header: 'Fundo', width: 38 },
    { header: 'CNPJ', width: 20 },
    { header: 'Componente', width: 14 },
    { header: 'Valor calculado', width: 18 },
    { header: 'Provisão XML', width: 18 },
    { header: 'Diferença (calc − XML)', width: 20 },
    { header: 'Extrato adm', width: 18 },
  ]

  const headerRow = ws.getRow(1)
  headerRow.values = ws.columns.map(c => c.header as string)
  styleHeaderRow(headerRow)
  ws.views = [{ state: 'frozen', ySplit: 1 }]

  let rowIdx = 0
  for (const f of fundos) {
    const temTaTg = f.tem_ta || f.tem_tg
    if (!f.tem_tc && !temTaTg) continue

    const cnpj = cleanCnpj(f.fundo_cnpj)
    const prov = provisoesMap.get(cnpj)
    const ext = extratoMap.get(cnpj)

    const linhas: Array<{ componente: string; calc: number | null; xml: number | null; ext: number | null }> = []
    if (f.tem_tc) {
      linhas.push({
        componente: 'Custódia',
        calc: f.tc_mensal > 0 ? f.tc_mensal : null,
        xml: prov && prov.tc > 0 ? prov.tc : null,
        ext: ext?.tc ?? null,
      })
    }
    if (temTaTg) {
      const calcTaTg = f.ta_mensal + f.tg_mensal
      const extTaTg =
        ext && (ext.ta != null || ext.tg != null)
          ? [ext.ta, ext.tg].filter((v): v is number => v != null).reduce((s, v) => s + v, 0) || null
          : null
      linhas.push({
        componente: 'TA + TG',
        calc: calcTaTg > 0 ? calcTaTg : null,
        xml: prov && prov.ta_tg_agregado > 0 ? prov.ta_tg_agregado : null,
        ext: extTaTg,
      })
    }

    for (const l of linhas) {
      const bg = rowIdx % 2 === 0 ? SYS.branco : SYS.rowAlt
      const diff = l.calc != null && l.xml != null ? l.calc - l.xml : null
      const diffPct = diff != null && l.calc ? Math.abs(diff / l.calc) : null
      const diffColor =
        diffPct == null ? SYS.cinzaNum : diffPct < 0.001 ? SYS.verdeNum : diffPct < 0.02 ? SYS.amberText : SYS.vermelho

      const row = ws.addRow([
        f.denominacao_social ?? fmtCNPJ(f.fundo_cnpj),
        fmtCNPJ(f.fundo_cnpj),
        l.componente,
        l.calc,
        l.xml,
        diff,
        l.ext,
      ])
      row.eachCell(cell => {
        cell.fill = fill(bg)
        cell.font = { color: { argb: SYS.preto }, size: 10 }
      })
      ;[4, 5, 6, 7].forEach(col => (row.getCell(col).numFmt = MOEDA_FMT))
      const diffCell = row.getCell(6)
      diffCell.font = { bold: true, color: { argb: diffColor }, size: 10 }
      rowIdx += 1
    }
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 7 } }
}

// ── Sheet: Apuração diária (todos os fundos, todos os dias) ────────────────

function buildSheetDiaria(
  wb: ExcelJS.Workbook,
  fundos: ConferenciaTaxaMes[],
  linhasDiarias: ConferenciaTaxaDiaria[],
) {
  const ws = wb.addWorksheet('Apuração diária')
  ws.columns = [
    { header: 'Fundo', width: 38 },
    { header: 'CNPJ', width: 20 },
    { header: 'Data', width: 12 },
    { header: 'PL do dia', width: 18 },
    { header: 'TA/dia', width: 14 },
    { header: 'TG/dia', width: 14 },
    { header: 'TC/dia', width: 14 },
    { header: 'TCons/dia', width: 14 },
    { header: 'Total/dia', width: 14 },
  ]

  const headerRow = ws.getRow(1)
  headerRow.values = ws.columns.map(c => c.header as string)
  styleHeaderRow(headerRow)
  ws.views = [{ state: 'frozen', ySplit: 1 }]

  const nomesPorCnpj = new Map(fundos.map(f => [cleanCnpj(f.fundo_cnpj), f.denominacao_social ?? f.fundo_cnpj]))

  let rowIdx = 0
  for (const l of linhasDiarias) {
    const nome = nomesPorCnpj.get(cleanCnpj(l.fundo_cnpj)) ?? l.fundo_cnpj
    const total = l.ta_efetivo_dia + l.tg_efetivo_dia + l.tc_efetivo_dia + l.tcons_efetivo_dia
    const bg = rowIdx % 2 === 0 ? SYS.branco : SYS.rowAlt

    const [y, m, d] = l.data_ref.split('-')
    const row = ws.addRow([
      nome,
      fmtCNPJ(l.fundo_cnpj),
      `${d}/${m}/${y}`,
      l.pl_dia,
      l.ta_efetivo_dia || null,
      l.tg_efetivo_dia || null,
      l.tc_efetivo_dia || null,
      l.tcons_efetivo_dia || null,
      total || null,
    ])
    row.eachCell(cell => {
      cell.fill = fill(bg)
      cell.font = { color: { argb: SYS.preto }, size: 10 }
    })
    ;[4, 5, 6, 7, 8, 9].forEach(col => (row.getCell(col).numFmt = MOEDA_FMT))
    row.getCell(9).font = { bold: true, color: { argb: SYS.preto }, size: 10 }
    rowIdx += 1
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 9 } }
}

// ── Orquestração ────────────────────────────────────────────────────────────

export interface ExportConferenciaInput {
  fundos: ConferenciaTaxaMes[]
  mesRef: string
}

export async function exportConferenciaExcel({ fundos, mesRef }: ExportConferenciaInput): Promise<void> {
  if (fundos.length === 0) throw new Error('Nenhum fundo para exportar neste mês.')

  const cnpjs = fundos.map(f => f.fundo_cnpj)

  const [linhasDiarias, provisoesMap, extratoMap] = await Promise.all([
    fetchDiariaBulk(cnpjs, mesRef).catch(() => [] as ConferenciaTaxaDiaria[]),
    fetchProvisoesBulk(cnpjs, mesRef).catch(() => new Map<string, ReferenciaProvisoesMes>()),
    fetchExtratoBulk(cnpjs, mesRef).catch(() => new Map<string, ExtratoAdm>()),
  ])

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Frame Control Center'
  wb.created = new Date()

  buildSheetResumo(wb, fundos, mesRef)
  buildSheetConfronto(wb, fundos, provisoesMap, extratoMap)
  buildSheetDiaria(wb, fundos, linhasDiarias)

  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  downloadBlob(blob, `conferencia-taxas-${mesRef}.xlsx`)
}
