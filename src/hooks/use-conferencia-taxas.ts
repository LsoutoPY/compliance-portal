import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/integrations/supabase/client'
import type {
  ConferenciaTaxaDiaria,
  ConferenciaTaxaMes,
  ProvisaoTaxaDetalhe,
  ReferenciaDespesas,
  ReferenciaProvisoesMes,
} from '@/types/conferencia-taxas'
import { intervaloMes, mesRefAtual, mesRefToMesAno } from '@/types/conferencia-taxas'
import { isMissingRelationError } from '@/lib/supabase-errors'

// ── Query Keys ─────────────────────────────────────────────────────────────

export const conferenciaKeys = {
  all: ['conferencia-taxas'] as const,
  resumo: (mesRef: string) => [...conferenciaKeys.all, 'resumo', mesRef] as const,
  diaria: (cnpj: string, mesRef: string) => [...conferenciaKeys.all, 'diaria', cnpj, mesRef] as const,
  referencia: (cnpj: string, mesRef: string) => [...conferenciaKeys.all, 'referencia', cnpj, mesRef] as const,
  provisoes: (cnpj: string, mesRef: string) => [...conferenciaKeys.all, 'provisoes', cnpj, mesRef] as const,
  provisoesBulk: (cnpjs: string[], mesRef: string) =>
    [...conferenciaKeys.all, 'provisoes-bulk', mesRef, ...cnpjs] as const,
  provisoesDetalhe: (cnpj: string, mesRef: string) => [...conferenciaKeys.all, 'provisoes-detalhe', cnpj, mesRef] as const,
}

/** Rebuild do cache materializado (full ou incremental por fundo/mês). */
export async function refreshConferenciaTaxasMesCache(
  fundoCnpj?: string,
  mesRef?: string,
): Promise<void> {
  const params: { p_fundo_cnpj?: string; p_mes_ref?: string } = {}
  if (fundoCnpj) params.p_fundo_cnpj = fundoCnpj
  if (mesRef) params.p_mes_ref = mesRef

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).rpc('refresh_conferencia_taxas_mes_cache', params)
  if (error) throw error
}

/** Igual ao refresh acima, mas não propaga erro (migration/RPC pendente). */
export async function refreshConferenciaTaxasMesCacheSafe(
  fundoCnpj?: string,
  mesRef?: string,
): Promise<void> {
  try {
    await refreshConferenciaTaxasMesCache(fundoCnpj, mesRef)
  } catch (err) {
    console.warn(
      '[conferencia] refresh cache falhou — aplique migrations 20260729 e 20260817:',
      err,
    )
  }
}

/** YYYYMMDD → YYYY-MM */
export function dtPosicaoToMesRef(dtposicao: string): string {
  if (dtposicao.length >= 6) {
    return `${dtposicao.slice(0, 4)}-${dtposicao.slice(4, 6)}`
  }
  return mesRefAtual()
}

// ── Resumo mensal (tabela de fundos) ──────────────────────────────────────

export function useConferenciaResumo(mesRef?: string) {
  const ref = mesRef ?? mesRefAtual()
  const { inicio, fim } = intervaloMes(ref)

  return useQuery({
    queryKey: conferenciaKeys.resumo(ref),
    queryFn: async (): Promise<ConferenciaTaxaMes[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('vw_conferencia_taxas_mes')
        .select('*')
        .eq('mes_ref', ref)
        .order('denominacao_social')

      if (error) {
        // A view filtra por mes_ref; se a coluna não existir ainda, retorna vazio
        console.error('[use-conferencia-taxas] resumo:', error)
        throw error
      }
      return (data ?? []) as ConferenciaTaxaMes[]
    },
    // Dados históricos são estáveis; revalida a cada 5 min apenas se mês atual
    staleTime: ref === mesRefAtual() ? 5 * 60 * 1000 : Infinity,
    refetchOnMount: 'always',
  })
}

// ── Apuração diária de um fundo ───────────────────────────────────────────

export function useConferenciaDiaria(fundoCnpj: string, mesRef: string) {
  const { inicio, fim } = intervaloMes(mesRef)

  return useQuery({
    queryKey: conferenciaKeys.diaria(fundoCnpj, mesRef),
    queryFn: async (): Promise<ConferenciaTaxaDiaria[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('vw_conferencia_taxas_diaria')
        .select('*')
        .eq('fundo_cnpj', fundoCnpj)
        .gte('data_ref', inicio)
        .lte('data_ref', fim)
        .order('data_ref', { ascending: true })

      if (error) {
        console.error('[use-conferencia-taxas] diaria:', error)
        throw error
      }
      return (data ?? []) as ConferenciaTaxaDiaria[]
    },
    enabled: !!fundoCnpj && !!mesRef,
    staleTime: mesRef === mesRefAtual() ? 5 * 60 * 1000 : Infinity,
    refetchOnMount: 'always',
  })
}

// ── Referência informada pela administradora (despesas_fundo) ─────────────

function cleanCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, '')
}

function somaCategoria(
  rows: Array<{ categoria_despesa: string | null; valor: number }>,
  categoria: string
): number | null {
  const total = rows
    .filter(r => r.categoria_despesa === categoria)
    .reduce((s, r) => s + Math.abs(Number(r.valor)), 0)
  return total > 0 ? total : null
}

export function useReferenciaDespesas(fundoCnpj: string, mesRef: string) {
  const mesAno = mesRefToMesAno(mesRef)
  const cnpj = cleanCnpj(fundoCnpj)

  return useQuery({
    queryKey: conferenciaKeys.referencia(cnpj, mesRef),
    queryFn: async (): Promise<ReferenciaDespesas> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('despesas_fundo')
        .select('categoria_despesa, valor, fundo_cnpj')
        .eq('mes_ano', mesAno)

      if (error) {
        console.error('[use-conferencia-taxas] referencia:', error)
        throw error
      }

      const rows = (data ?? []).filter(
        (r: { fundo_cnpj: string | null }) =>
          r.fundo_cnpj && cleanCnpj(r.fundo_cnpj) === cnpj
      )

      const ta = somaCategoria(rows, 'taxa_administracao')
      const tg = somaCategoria(rows, 'taxa_gestao')
      const tc = somaCategoria(rows, 'taxa_custodia')
      const total = [ta, tg, tc].filter((v): v is number => v != null).reduce((s, v) => s + v, 0)

      return {
        ta,
        tg,
        tc,
        total: total > 0 ? total : null,
      }
    },
    enabled: !!fundoCnpj && !!mesRef,
    staleTime: mesRef === mesRefAtual() ? 5 * 60 * 1000 : Infinity,
  })
}

// ── Referência XML — provisões de taxas (posicao_carteira) ────────────────

export function useReferenciaProvisoesBulk(cnpjs: string[], mesRef: string) {
  const cnpjsLimpos = cnpjs.map(cleanCnpj)

  return useQuery({
    queryKey: conferenciaKeys.provisoesBulk(cnpjsLimpos, mesRef),
    queryFn: async (): Promise<Map<string, ReferenciaProvisoesMes>> => {
      if (cnpjsLimpos.length === 0) return new Map()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('vw_provisoes_taxas_mes')
        .select('*')
        .in('fundo_cnpj', cnpjsLimpos)
        .eq('mes_ref', mesRef)

      if (error) {
        if (isMissingRelationError(error)) {
          console.warn('[use-conferencia-taxas] vw_provisoes_taxas_mes indisponível:', error)
          return new Map()
        }
        console.error('[use-conferencia-taxas] provisoes-bulk:', error)
        throw error
      }

      const map = new Map<string, ReferenciaProvisoesMes>()
      for (const row of (data ?? []) as ReferenciaProvisoesMes[]) {
        map.set(row.fundo_cnpj, row)
      }
      return map
    },
    enabled: cnpjsLimpos.length > 0 && !!mesRef,
    staleTime: mesRef === mesRefAtual() ? 5 * 60 * 1000 : Infinity,
    refetchOnMount: 'always',
  })
}

export function useReferenciaProvisoes(fundoCnpj: string, mesRef: string) {
  const cnpj = cleanCnpj(fundoCnpj)

  return useQuery({
    queryKey: conferenciaKeys.provisoes(cnpj, mesRef),
    queryFn: async (): Promise<ReferenciaProvisoesMes | null> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('vw_provisoes_taxas_mes')
        .select('*')
        .eq('fundo_cnpj', cnpj)
        .eq('mes_ref', mesRef)
        .maybeSingle()

      if (error) {
        console.error('[use-conferencia-taxas] provisoes:', error)
        throw error
      }
      return (data as ReferenciaProvisoesMes | null) ?? null
    },
    enabled: !!fundoCnpj && !!mesRef,
    staleTime: mesRef === mesRefAtual() ? 5 * 60 * 1000 : Infinity,
    refetchOnMount: 'always',
  })
}

export function useProvisoesTaxasDetalhe(fundoCnpj: string, mesRef: string, enabled = true) {
  const cnpj = cleanCnpj(fundoCnpj)

  return useQuery({
    queryKey: conferenciaKeys.provisoesDetalhe(cnpj, mesRef),
    queryFn: async (): Promise<ProvisaoTaxaDetalhe[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('vw_provisoes_taxas_detalhe')
        .select('*')
        .eq('fundo_cnpj', cnpj)
        .eq('mes_ref', mesRef)
        .order('codprov')
        .order('slot')

      if (error) {
        console.error('[use-conferencia-taxas] provisoes-detalhe:', error)
        throw error
      }
      return (data ?? []) as ProvisaoTaxaDetalhe[]
    },
    enabled: enabled && !!fundoCnpj && !!mesRef,
    staleTime: mesRef === mesRefAtual() ? 5 * 60 * 1000 : Infinity,
  })
}
