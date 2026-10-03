import type { Segmento, FundoComReceita, PLPorInstituicao } from '@/types/fundos-taxas'

// ── Formatação monetária ───────────────────────────────────────────────────

export const fmtBRL = (v: number, decimals = 0) =>
  new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: decimals,
  }).format(v)

/** Formato compacto para eixos de gráfico */
export const fmtBRLCompact = (v: number): string => {
  if (v >= 1e9) return `R$ ${(v / 1e9).toFixed(1)}bi`
  if (v >= 1e6) return `R$ ${(v / 1e6).toFixed(1)}MM`
  if (v >= 1e3) return `R$ ${(v / 1e3).toFixed(1)}k`
  return fmtBRL(v)
}

/** Percentual com 4 casas decimais para não perder precisão em taxas pequenas */
export const fmtPct = (v: number) => `${(v * 100).toFixed(4)}%`

/** Percentual com 2 casas decimais para exibição resumida */
export const fmtPct2 = (v: number) => `${(v * 100).toFixed(2)}%`

/** Soma PIS + COFINS + ISS (decimais, ex: 0.0965) */
export function aliquotaGrossUpTotal(pis: unknown, cofins: unknown, iss: unknown): number {
  return numTaxa(pis) + numTaxa(cofins) + numTaxa(iss)
}

/**
 * Gross up: valor bruto a provisionar para que, após retenções, sobre o líquido desejado.
 * Bruto = Líquido / (1 - alíquota total)
 */
export function calcGrossUp(
  valorLiquido: number,
  pis: unknown,
  cofins: unknown,
  iss: unknown,
): number {
  if (valorLiquido <= 0) return 0
  const aliq = aliquotaGrossUpTotal(pis, cofins, iss)
  if (aliq <= 0) return valorLiquido
  if (aliq >= 1) return valorLiquido
  return Math.round((valorLiquido / (1 - aliq)) * 100) / 100
}

/** Converte alíquota decimal (0.0065) para input em % (0.65) */
export function grossUpToInput(v: unknown): string {
  const n = numTaxa(v)
  if (n === 0) return ''
  return (n * 100).toFixed(4).replace(/\.?0+$/, '')
}

/** Coerce valores numéricos vindos do Supabase (numeric → string) */
export function numTaxa(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Taxa ativa se tem %, mínimo ou fixo mensal */
export function taxaAtiva(pct: unknown, min?: unknown, fixo?: unknown): boolean {
  return numTaxa(pct) > 0 || numTaxa(min) > 0 || numTaxa(fixo) > 0
}

/** Coluna de % a.a. na tabela de fundos */
export function fmtTaxaCol(pct: unknown, min?: unknown, fixo?: unknown): string {
  if (numTaxa(fixo) > 0) return `Fixo ${fmtBRL(numTaxa(fixo), 0)}`
  if (numTaxa(pct) > 0) return fmtPct(numTaxa(pct))
  return '—'
}

/**
 * Encargo mensal estimado — fixo tem prioridade sobre % e mínimo.
 * TG em segmento prospeccao retorna null (exceto se fixo? mantém null para TG).
 */
export function calcEncargoMensal(
  pl: number,
  pct: number,
  min: number | null | undefined,
  fixo: number | null | undefined,
  segmento: string,
  respeitarProspeccao = false,
): number | null {
  if (respeitarProspeccao && segmento === 'prospeccao') return null
  if (numTaxa(fixo) > 0) return numTaxa(fixo)
  return calcReceitaMensal(pl, pct, min, segmento)
}

/** Recalcula receitas TA/TCons quando a view não as expõe (migration desatualizada) */
export function enrichFundoComReceita(f: FundoComReceita): FundoComReceita {
  const pl = numTaxa(f.pl_atual ?? f.pl_jan)
  const tgPct = numTaxa(f.tg_percentual)
  const tgMin = f.tg_minimo_mensal != null ? numTaxa(f.tg_minimo_mensal) : null
  const tgFixo = f.tg_fixo_mensal != null ? numTaxa(f.tg_fixo_mensal) : null
  const taPct = numTaxa(f.ta_percentual)
  const taMin = f.ta_minimo_mensal != null ? numTaxa(f.ta_minimo_mensal) : null
  const taFixo = f.ta_fixo_mensal != null ? numTaxa(f.ta_fixo_mensal) : null
  const tcPct = numTaxa(f.tc_percentual)
  const tcMin = f.tc_minimo_mensal != null ? numTaxa(f.tc_minimo_mensal) : null
  const tcFixo = f.tc_fixo_mensal != null ? numTaxa(f.tc_fixo_mensal) : null
  const tconsPct = numTaxa(f.tcons_percentual)
  const tconsMin = f.tcons_minimo_mensal != null ? numTaxa(f.tcons_minimo_mensal) : null
  const tconsFixo = f.tcons_fixo_mensal != null ? numTaxa(f.tcons_fixo_mensal) : null

  const receitaTG =
    f.receita_mensal != null
      ? numTaxa(f.receita_mensal)
      : calcEncargoMensal(pl, tgPct, tgMin, tgFixo, f.segmento, true)

  const taReceita =
    f.ta_receita_mensal != null
      ? numTaxa(f.ta_receita_mensal)
      : calcEncargoMensal(pl, taPct, taMin, taFixo, 'exclusivo_familiar')

  const tcReceita =
    f.tc_receita_mensal != null
      ? numTaxa(f.tc_receita_mensal)
      : calcEncargoMensal(pl, tcPct, tcMin, tcFixo, 'exclusivo_familiar')

  const tconsReceita =
    f.tcons_receita_mensal != null
      ? numTaxa(f.tcons_receita_mensal)
      : calcEncargoMensal(pl, tconsPct, tconsMin, tconsFixo, f.segmento)

  return {
    ...f,
    tg_percentual: tgPct,
    tg_minimo_mensal: tgMin,
    tg_fixo_mensal: tgFixo,
    ta_percentual: taPct,
    ta_minimo_mensal: taMin,
    ta_fixo_mensal: taFixo,
    tc_percentual: tcPct,
    tc_minimo_mensal: tcMin,
    tc_fixo_mensal: tcFixo,
    tcons_percentual: tconsPct,
    tcons_minimo_mensal: tconsMin,
    tcons_fixo_mensal: tconsFixo,
    pl_atual: pl,
    receita_mensal: receitaTG,
    ta_receita_mensal: taReceita,
    tc_receita_mensal: tcReceita,
    tcons_receita_mensal: tconsReceita,
  }
}

/** Ajusta PL e encargos estimados para um mês histórico (vw_pl_historico_mensal). */
export function fundosComPlReferencia(
  fundos: FundoComReceita[],
  mesRef: string,
  plHistorico: { fundo_cnpj: string; mes_ref: string; pl_valor: number; data_referencia: string }[],
  mesAtual: string,
): FundoComReceita[] {
  if (mesRef >= mesAtual) return fundos

  const plMap = new Map<string, { pl_valor: number; data_referencia: string }>()
  for (const row of plHistorico) {
    if (row.mes_ref === mesRef) {
      plMap.set(row.fundo_cnpj, row)
    }
  }

  return fundos.map(f => {
    const row = plMap.get(f.fundo_cnpj)
    const pl = row?.pl_valor ?? 0
    const enriched = enrichFundoComReceita({
      ...f,
      pl_atual: pl,
      data_posicao_atual: row?.data_referencia ?? null,
      receita_mensal: null,
      ta_receita_mensal: null,
      tc_receita_mensal: null,
      tcons_receita_mensal: null,
    })
    return {
      ...enriched,
      no_minimo:
        numTaxa(f.tg_fixo_mensal) === 0 &&
        isNoMinimo(pl, numTaxa(f.tg_percentual), f.tg_minimo_mensal),
    }
  })
}

// ── Lógica central de receita ─────────────────────────────────────────────
// Espelha exatamente a view SQL vw_fundos_com_receita para uso no frontend.

/**
 * Calcula a receita mensal estimada.
 * - Segmento 'prospeccao': sempre null
 * - Sem taxa e sem mínimo: null
 * - PL = 0: null
 * - Caso contrário: max(tg% × PL / 12, mínimo)
 */
export function calcReceitaMensal(
  pl: number,
  tgPercentual: number,
  tgMinimoMensal: number | null | undefined,
  segmento: string
): number | null {
  if (segmento === 'prospeccao') return null
  if (tgPercentual === 0 && !tgMinimoMensal) return null
  if (pl === 0) return null
  const percentual = (tgPercentual * pl) / 12
  if (!tgMinimoMensal || tgMinimoMensal === 0) return percentual
  return Math.max(percentual, tgMinimoMensal)
}

/** Verifica se o fundo está cobrando o mínimo em vez do percentual */
export function isNoMinimo(
  pl: number,
  tgPercentual: number,
  tgMinimoMensal: number | null | undefined
): boolean {
  if (!tgMinimoMensal || tgMinimoMensal === 0 || pl === 0) return false
  return (tgPercentual * pl) / 12 < tgMinimoMensal
}

// ── Conversão de input de taxa ─────────────────────────────────────────────
// O usuário digita em %a.a. (ex.: "0.50"), mas no banco ficam decimais (0.005).

/** Converte input do usuário (% a.a.) para valor decimal a salvar no banco */
export const inputToTg = (v: string | number) => Number(v) / 100

/** Converte valor decimal do banco para exibição em % a.a. */
export const tgToInput = (v: number) => (v * 100).toFixed(4)

// ── Helpers de data ────────────────────────────────────────────────────────

/** Formata data YYYYMMDD ou YYYY-MM-DD → DD/MM/YYYY */
export function fmtDtPosicao(dt: string | null | undefined): string {
  if (!dt) return '—'
  if (/^\d{4}-\d{2}-\d{2}/.test(dt)) {
    const [y, m, d] = dt.slice(0, 10).split('-')
    return `${d}/${m}/${y}`
  }
  const d = dt.replace(/\D/g, '')
  if (d.length !== 8) return dt
  return `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`
}

/** Formata "2025-01-01" como "Jan/2025" */
export function fmtMesRef(mesRef: string): string {
  const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
                 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
  const [year, month] = mesRef.split('-')
  return `${meses[parseInt(month, 10) - 1]}/${year}`
}

/** Retorna o primeiro dia do mês atual como string "YYYY-MM-01" */
export function primeiroDiaMesAtual(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}-01`
}

/** Retorna os últimos N meses como datas "YYYY-MM-01" (do mais antigo ao mais recente) */
export function ultimosMeses(n: number): string[] {
  const result: string[] = []
  const now = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    result.push(`${y}-${m}-01`)
  }
  return result
}

// ── Helpers de CNPJ ────────────────────────────────────────────────────────

/** Formata CNPJ de 14 dígitos: "12345678000199" → "12.345.678/0001-99" */
export function fmtCNPJ(cnpj: string): string {
  const d = cnpj.replace(/\D/g, '')
  if (d.length !== 14) return cnpj
  return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`
}

/** Remove formatação do CNPJ */
export function cleanCNPJ(cnpj: string): string {
  return cnpj.replace(/\D/g, '')
}

// ── Segmentos que contribuem para totais ──────────────────────────────────

const SEGMENTOS_COM_RECEITA: Segmento[] = ['exclusivo_familiar', 'asset']

export function segmentoContribuiParaReceita(segmento: Segmento): boolean {
  return SEGMENTOS_COM_RECEITA.includes(segmento)
}

/** Agrega fundos por administrador (substitui vw_pl_por_instituicao no frontend com filtros) */
export function aggregatePLPorInstituicao(fundos: FundoComReceita[]): PLPorInstituicao[] {
  const map = new Map<string, PLPorInstituicao>()

  for (const f of fundos) {
    const admin = f.administrador ?? 'Não identificado'
    const cnpjAdm = f.cnpj_administrador ?? ''
    const key = `${admin}|${cnpjAdm}`

    const cur = map.get(key) ?? {
      administrador: admin,
      cnpj_administrador: cnpjAdm,
      data_referencia: f.data_posicao_atual,
      qtd_fundos: 0,
      pl_total: 0,
      receita_tg_total: 0,
      receita_ta_total: 0,
      receita_tc_total: 0,
    }

    cur.qtd_fundos += 1
    cur.pl_total += f.pl_atual ?? f.pl_jan ?? 0
    cur.receita_tg_total += f.receita_mensal ?? 0
    cur.receita_ta_total += f.ta_receita_mensal ?? 0
    cur.receita_tc_total += f.tc_receita_mensal ?? 0
    if (f.data_posicao_atual && (!cur.data_referencia || f.data_posicao_atual > cur.data_referencia)) {
      cur.data_referencia = f.data_posicao_atual
    }

    map.set(key, cur)
  }

  return Array.from(map.values()).sort((a, b) => b.pl_total - a.pl_total)
}

// ── Histórico de PL (posicao_carteira) ─────────────────────────────────────

const PL_CHART_COLORS = [
  '#185FA5', '#1D9E75', '#7F77DD', '#E67E22', '#E74C3C',
  '#2ECC71', '#9B59B6', '#16A085', '#F39C12', '#2980B9',
]

export function plHistoricoColor(idx: number): string {
  return PL_CHART_COLORS[idx % PL_CHART_COLORS.length]
}

/** Monta série consolidada (soma PL por mês) */
export function consolidarPLHistorico(
  rows: Array<{ mes_ref: string; pl_valor: number }>,
): { mes_ref: string; pl_valor: number }[] {
  const map = new Map<string, number>()
  for (const row of rows) {
    map.set(row.mes_ref, (map.get(row.mes_ref) ?? 0) + row.pl_valor)
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes_ref, pl_valor]) => ({ mes_ref, pl_valor }))
}

export interface PLHistoricoChartPoint {
  mes: string
  mes_ref: string
  [serieKey: string]: string | number
}

/**
 * Pontos do gráfico: uma coluna por mês, chaves dinâmicas por fundo ou "consolidado".
 */
export function buildPLHistoricoChartData(
  rows: Array<{ fundo_cnpj: string; mes_ref: string; pl_valor: number }>,
  fundos: FundoComReceita[],
  cnpjsSelecionados: string[],
  modo: 'consolidado' | 'fundos',
): { dados: PLHistoricoChartPoint[]; series: Array<{ key: string; label: string; color: string }> } {
  const cnpjSet = new Set(cnpjsSelecionados)
  const filtrados = cnpjSet.size > 0
    ? rows.filter(r => cnpjSet.has(r.fundo_cnpj))
    : rows

  const meses = Array.from(new Set(filtrados.map(r => r.mes_ref))).sort()

  if (modo === 'consolidado' || cnpjSet.size === 0) {
    const consolidado = consolidarPLHistorico(filtrados)
    const byMes = new Map(consolidado.map(d => [d.mes_ref, d.pl_valor]))
    const dados = meses.map(mes_ref => ({
      mes_ref,
      mes: fmtMesRef(mes_ref),
      consolidado: byMes.get(mes_ref) ?? 0,
    }))
    return {
      dados,
      series: [{ key: 'consolidado', label: 'PL consolidado', color: PL_CHART_COLORS[0] }],
    }
  }

  const nomePorCnpj = new Map(
    fundos.map(f => [f.fundo_cnpj, f.denominacao_social ?? f.fundo_cnpj]),
  )
  const series = cnpjsSelecionados.map((cnpj, idx) => ({
    key: cnpj,
    label: (nomePorCnpj.get(cnpj) ?? cnpj).slice(0, 40),
    color: plHistoricoColor(idx),
  }))

  const byMesFundo = new Map<string, Map<string, number>>()
  for (const row of filtrados) {
    if (!byMesFundo.has(row.mes_ref)) byMesFundo.set(row.mes_ref, new Map())
    byMesFundo.get(row.mes_ref)!.set(row.fundo_cnpj, row.pl_valor)
  }

  const dados = meses.map(mes_ref => {
    const point: PLHistoricoChartPoint = { mes_ref, mes: fmtMesRef(mes_ref) }
    const vals = byMesFundo.get(mes_ref)
    for (const s of series) {
      point[s.key] = vals?.get(s.key) ?? 0
    }
    return point
  })

  return { dados, series }
}
