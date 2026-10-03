import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/integrations/supabase/client'
import { calcEncargoMensal, numTaxa } from '@/lib/fundos-taxas-utils'
import type { FundoComReceita, PLHistoricoMensal } from '@/types/fundos-taxas'
import { SEGMENTO_COLORS, SEGMENTO_LABELS, SEGMENTO_ORDER } from '@/types/fundos-taxas'
import {
  CONCENTRACAO_TOP5_ALERTA,
  PL_ALERTA,
  PL_MINIMO,
  type PlLimiteFundo,
  type ReceitaFundoTrend,
  type ReceitaKpis,
  type SegmentoReceitaResumo,
} from '@/types/receita-fundo'

export const receitaFundoKeys = {
  all: ['receita-fundo-insights'] as const,
  trend: (cnpjs: string[]) => [...receitaFundoKeys.all, 'trend', ...cnpjs.sort()] as const,
}

const MESES_HISTORICO = 6

/** Últimos N meses no formato YYYY-MM (mes_ref de vw_conferencia_taxas_mes) */
export function ultimosNMesesRef(n: number): string[] {
  const out: string[] = []
  const hoje = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1)
    const mes = String(d.getMonth() + 1).padStart(2, '0')
    out.push(`${d.getFullYear()}-${mes}`)
  }
  return out
}

/** Retorna o último mes_ref com dado de conferência realmente fechado (tg_mensal preenchido) */
async function fetchMesReferenciaFechado(cnpjs: string[]): Promise<string | null> {
  const { data, error } = await supabase
    .from('vw_conferencia_taxas_mes')
    .select('mes_ref')
    .in('fundo_cnpj', cnpjs)
    .not('tg_mensal', 'is', null)
    .order('mes_ref', { ascending: false })
    .limit(1)

  if (error) throw new Error(error.message)
  return data?.[0]?.mes_ref ?? null
}

/** Últimos N meses terminando em mesRefFinal (em vez de terminar no mês corrente do calendário) */
export function ultimosNMesesAPartirDe(mesRefFinal: string, n: number): string[] {
  const [ano, mes] = mesRefFinal.split('-').map(Number)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(ano, mes - 1 - i, 1)
    const m = String(d.getMonth() + 1).padStart(2, '0')
    out.push(`${d.getFullYear()}-${m}`)
  }
  return out
}

type ConferenciaMesRow = {
  fundo_cnpj: string
  mes_ref: string
  denominacao_social: string | null
  gestor: string | null
  segmento: string
  tg_mensal: number | null
}

async function fetchPLHistorico(cnpjs: string[], meses: string[]): Promise<PLHistoricoMensal[]> {
  const { data, error } = await supabase
    .from('vw_pl_historico_mensal')
    .select('fundo_cnpj, mes_ref, pl_valor, data_referencia')
    .in('fundo_cnpj', cnpjs)
    .in('mes_ref', meses)

  if (error) throw new Error(error.message)
  return (data ?? []) as PLHistoricoMensal[]
}

async function fetchConferenciaMensal(cnpjs: string[], meses: string[]): Promise<ConferenciaMesRow[]> {
  const { data, error } = await supabase
    .from('vw_conferencia_taxas_mes')
    .select('fundo_cnpj, mes_ref, denominacao_social, gestor, segmento, tg_mensal')
    .in('fundo_cnpj', cnpjs)
    .in('mes_ref', meses)
    .order('mes_ref', { ascending: true })

  if (error) throw new Error(error.message)
  return (data ?? []) as ConferenciaMesRow[]
}

function receitaTGFromPL(fundo: FundoComReceita, pl: number): number {
  return (
    calcEncargoMensal(
      pl,
      numTaxa(fundo.tg_percentual),
      fundo.tg_minimo_mensal,
      fundo.tg_fixo_mensal,
      fundo.segmento,
      true,
    ) ?? 0
  )
}

function buildTrendFromConferencia(
  rows: ConferenciaMesRow[],
  fundos: FundoComReceita[],
  meses: string[],
): ReceitaFundoTrend[] {
  const fundoMap = new Map(fundos.map(f => [f.fundo_cnpj, f]))
  const porFundo = new Map<string, { pontos: Map<string, number>; meta: ConferenciaMesRow | null }>()

  for (const row of rows) {
    if (!porFundo.has(row.fundo_cnpj)) {
      porFundo.set(row.fundo_cnpj, { pontos: new Map(), meta: row })
    }
    const info = porFundo.get(row.fundo_cnpj)!
    info.pontos.set(row.mes_ref, numTaxa(row.tg_mensal))
    info.meta = row
  }

  const resultado: ReceitaFundoTrend[] = []

  for (const [fundo_cnpj, info] of porFundo) {
    const fundo = fundoMap.get(fundo_cnpj)
    const serie = meses.map(m => info.pontos.get(m) ?? 0)
    const atual = serie[serie.length - 1] ?? 0
    if (atual <= 0 && serie.every(v => v <= 0)) continue

    const anterior = serie[serie.length - 2] ?? 0
    const variacao = anterior === 0 ? 0 : ((atual - anterior) / anterior) * 100

    resultado.push({
      fundo_cnpj,
      fundo_nome: info.meta?.denominacao_social ?? fundo?.denominacao_social ?? fundo_cnpj,
      gestor: info.meta?.gestor ?? fundo?.gestor ?? '—',
      segmento: info.meta?.segmento ?? fundo?.segmento ?? 'alocacao',
      receita_atual: atual,
      variacao_mom: Number(variacao.toFixed(1)),
      serie,
    })
  }

  return resultado.sort((a, b) => b.receita_atual - a.receita_atual)
}

function buildTrendFromPLHistorico(
  plRows: PLHistoricoMensal[],
  fundos: FundoComReceita[],
  meses: string[],
): ReceitaFundoTrend[] {
  const fundoMap = new Map(fundos.map(f => [f.fundo_cnpj, f]))
  const porFundo = new Map<string, Map<string, number>>()

  for (const row of plRows) {
    const fundo = fundoMap.get(row.fundo_cnpj)
    if (!fundo) continue
    if (!porFundo.has(row.fundo_cnpj)) porFundo.set(row.fundo_cnpj, new Map())
    porFundo.get(row.fundo_cnpj)!.set(row.mes_ref, receitaTGFromPL(fundo, numTaxa(row.pl_valor)))
  }

  const resultado: ReceitaFundoTrend[] = []

  for (const [fundo_cnpj, pontos] of porFundo) {
    const fundo = fundoMap.get(fundo_cnpj)!
    const serie = meses.map(m => pontos.get(m) ?? 0)
    const atual = serie[serie.length - 1] ?? 0
    if (atual <= 0 && serie.every(v => v <= 0)) continue

    const anterior = serie[serie.length - 2] ?? 0
    const variacao = anterior === 0 ? 0 : ((atual - anterior) / anterior) * 100

    resultado.push({
      fundo_cnpj,
      fundo_nome: fundo.denominacao_social ?? fundo_cnpj,
      gestor: fundo.gestor ?? '—',
      segmento: fundo.segmento,
      receita_atual: atual,
      variacao_mom: Number(variacao.toFixed(1)),
      serie,
    })
  }

  return resultado.sort((a, b) => b.receita_atual - a.receita_atual)
}

/** Mescla conferência (preferida) com fallback PL histórico para meses faltantes */
function mergeTrendSources(
  conferencia: ReceitaFundoTrend[],
  plFallback: ReceitaFundoTrend[],
  meses: string[],
): ReceitaFundoTrend[] {
  const map = new Map<string, ReceitaFundoTrend>()

  for (const t of plFallback) map.set(t.fundo_cnpj, t)
  for (const t of conferencia) {
    const existing = map.get(t.fundo_cnpj)
    if (!existing) {
      map.set(t.fundo_cnpj, t)
      continue
    }
    const serie = meses.map((m, i) => {
      const confVal = t.serie[i] ?? 0
      return confVal > 0 ? confVal : (existing.serie[i] ?? 0)
    })
    const atual = serie[serie.length - 1] ?? 0
    const anterior = serie[serie.length - 2] ?? 0
    const variacao = anterior === 0 ? 0 : ((atual - anterior) / anterior) * 100
    map.set(t.fundo_cnpj, { ...t, serie, receita_atual: atual, variacao_mom: Number(variacao.toFixed(1)) })
  }

  return [...map.values()]
    .filter(t => t.receita_atual > 0 || t.serie.some(v => v > 0))
    .sort((a, b) => b.receita_atual - a.receita_atual)
}

async function fetchReceitaTrend(fundos: FundoComReceita[]): Promise<ReceitaFundoTrend[]> {
  const cnpjs = fundos.map(f => f.fundo_cnpj)
  if (cnpjs.length === 0) return []

  // Ancora a janela de 6 meses no último mês REALMENTE fechado (tg_mensal preenchido),
  // em vez de usar o mês corrente do calendário — evita comparar mês parcial vs mês fechado.
  const mesRefFechado = await fetchMesReferenciaFechado(cnpjs)
  const meses = mesRefFechado
    ? ultimosNMesesAPartirDe(mesRefFechado, MESES_HISTORICO)
    : ultimosNMesesRef(MESES_HISTORICO) // fallback: nenhum mês fechado ainda (base nova)

  const [conferenciaRows, plRows] = await Promise.all([
    fetchConferenciaMensal(cnpjs, meses).catch(() => [] as ConferenciaMesRow[]),
    fetchPLHistorico(cnpjs, meses).catch(() => [] as PLHistoricoMensal[]),
  ])

  const fromConferencia = buildTrendFromConferencia(conferenciaRows, fundos, meses)
  const fromPL = buildTrendFromPLHistorico(plRows, fundos, meses)

  if (fromConferencia.length === 0 && fromPL.length === 0) {
    // último fallback: receita atual dos fundos (mês corrente, sem histórico)
    return fundos
      .filter(f => f.receita_mensal != null && f.receita_mensal > 0)
      .map(f => ({
        fundo_cnpj: f.fundo_cnpj,
        fundo_nome: f.denominacao_social ?? f.fundo_cnpj,
        gestor: f.gestor ?? '—',
        segmento: f.segmento,
        receita_atual: numTaxa(f.receita_mensal),
        variacao_mom: 0,
        serie: Array(MESES_HISTORICO).fill(numTaxa(f.receita_mensal)),
      }))
      .sort((a, b) => b.receita_atual - a.receita_atual)
  }

  return mergeTrendSources(fromConferencia, fromPL, meses)
}

function computeKpis(trend: ReceitaFundoTrend[], fundos: FundoComReceita[]): ReceitaKpis {
  const lista = trend.filter(t => t.receita_atual > 0)
  const receitaTotalMes = lista.reduce((acc, f) => acc + f.receita_atual, 0)
  const receitaMediaPorFundo = lista.length ? receitaTotalMes / lista.length : 0

  const totalAnterior = lista.reduce((acc, f) => acc + (f.serie[f.serie.length - 2] ?? 0), 0)
  const variacaoMomTotal =
    totalAnterior === 0 ? 0 : ((receitaTotalMes - totalAnterior) / totalAnterior) * 100

  const top5 = [...lista]
    .sort((a, b) => b.receita_atual - a.receita_atual)
    .slice(0, 5)
    .reduce((acc, f) => acc + f.receita_atual, 0)
  const concentracaoTop5 = receitaTotalMes === 0 ? 0 : (top5 / receitaTotalMes) * 100

  const fundosAbaixoPlMinimo = fundos.filter(f => numTaxa(f.pl_atual) < PL_MINIMO).length

  return {
    receitaTotalMes,
    variacaoMomTotal: Number(variacaoMomTotal.toFixed(1)),
    receitaMediaPorFundo,
    fundosAtivos: lista.length,
    concentracaoTop5: Number(concentracaoTop5.toFixed(1)),
    fundosAbaixoPlMinimo,
  }
}

function computeSegmentosResumo(trend: ReceitaFundoTrend[]): SegmentoReceitaResumo[] {
  const porSegmento = new Map<string, { receita: number; qtdFundos: number }>()
  let total = 0

  for (const f of trend.filter(t => t.receita_atual > 0)) {
    const seg = f.segmento in SEGMENTO_LABELS ? f.segmento : 'alocacao'
    total += f.receita_atual
    const existing = porSegmento.get(seg)
    if (existing) {
      existing.receita += f.receita_atual
      existing.qtdFundos += 1
    } else {
      porSegmento.set(seg, { receita: f.receita_atual, qtdFundos: 1 })
    }
  }

  if (total === 0) return []

  return SEGMENTO_ORDER.filter(seg => porSegmento.has(seg)).map(seg => {
    const info = porSegmento.get(seg)!
    return {
      segmentoKey: seg,
      label: SEGMENTO_LABELS[seg],
      receita: info.receita,
      pct: (info.receita / total) * 100,
      fill: SEGMENTO_COLORS[seg],
      qtdFundos: info.qtdFundos,
    }
  })
}

function computePlLimites(fundos: FundoComReceita[]): PlLimiteFundo[] {
  return fundos
    .map(f => ({
      fundo_cnpj: f.fundo_cnpj,
      fundo_nome: f.denominacao_social ?? f.fundo_cnpj,
      pl_atual: numTaxa(f.pl_atual),
      pl_minimo: PL_MINIMO,
      pl_alerta: PL_ALERTA,
    }))
    .filter(f => f.pl_atual < PL_ALERTA)
    .sort((a, b) => a.pl_atual - b.pl_atual)
    .slice(0, 12)
}

export function useReceitaFundoInsights(fundos: FundoComReceita[]) {
  const cnpjs = useMemo(() => fundos.map(f => f.fundo_cnpj), [fundos])

  const trendQuery = useQuery({
    queryKey: receitaFundoKeys.trend(cnpjs),
    queryFn: () => fetchReceitaTrend(fundos),
    enabled: cnpjs.length > 0,
    staleTime: 60_000,
  })

  const trend = trendQuery.data ?? []

  const kpis = useMemo(() => computeKpis(trend, fundos), [trend, fundos])
  const segmentosResumo = useMemo(() => computeSegmentosResumo(trend), [trend])
  const plLimites = useMemo(() => computePlLimites(fundos), [fundos])

  return {
    trend,
    kpis,
    segmentosResumo,
    plLimites,
    isLoading: trendQuery.isLoading,
    error: trendQuery.error,
    refetch: trendQuery.refetch,
  }
}

export { CONCENTRACAO_TOP5_ALERTA, PL_ALERTA, PL_MINIMO }
