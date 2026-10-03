import { useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/integrations/supabase/client'
import { enrichFundoComReceita } from '@/lib/fundos-taxas-utils'
import {
  fetchGestoresMonitorados,
  fetchUniversoCnpjsMonitorados,
  fetchAdminCnpjsGrupoH,
  filtrarFundosPorGestoresMonitorados,
} from '@/lib/fundosMonitorados'
import { conferenciaKeys, refreshConferenciaTaxasMesCacheSafe } from '@/hooks/use-conferencia-taxas'
import { formatSupabaseError, isMissingColumnError } from '@/lib/supabase-errors'
import type {
  FundoComReceita,
  FundoTaxaFormData,
  FundoPLHistorico,
  FundosFiltros,
  PLPorInstituicao,
  PLHistoricoMensal,
} from '@/types/fundos-taxas'

const PAGE_SIZE = 1000

async function fetchAllPLHistoricoMensal(cnpjs?: string[]): Promise<PLHistoricoMensal[]> {
  const rows: PLHistoricoMensal[] = []
  let offset = 0

  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q = (supabase as any)
      .from('vw_pl_historico_mensal')
      .select('fundo_cnpj, mes_ref, pl_valor, data_referencia')
      .order('mes_ref', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)

    if (cnpjs && cnpjs.length > 0) {
      q = q.in('fundo_cnpj', cnpjs)
    }

    const { data, error } = await q
    if (error) throw error
    const batch = (data ?? []) as PLHistoricoMensal[]
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return rows
}

// ── Query Keys ────────────────────────────────────────────────────────────

export const fundosTaxasKeys = {
  all: ['fundos-taxas'] as const,
  lista: (filtros?: FundosFiltros) => [...fundosTaxasKeys.all, 'lista', filtros ?? {}] as const,
  historico: (cnpj: string) => [...fundosTaxasKeys.all, 'historico', cnpj] as const,
  historicoConsolidado: () => [...fundosTaxasKeys.all, 'historico', 'all'] as const,
  historicoPosicao: (cnpjs: string[]) =>
    [...fundosTaxasKeys.all, 'historico-posicao', ...cnpjs.sort()] as const,
  porInstituicao: () => [...fundosTaxasKeys.all, 'por-instituicao'] as const,
}

// ── Lista de fundos com receita calculada ─────────────────────────────────

/** Remove duplicatas por CNPJ (fallback se a view ainda não foi migrada). */
function dedupeFundosPorCnpj(fundos: FundoComReceita[]): FundoComReceita[] {
  const map = new Map<string, FundoComReceita>()
  for (const f of fundos) {
    if (!map.has(f.fundo_cnpj)) map.set(f.fundo_cnpj, f)
  }
  return [...map.values()]
}

type FundoTaxasRow = Pick<
  FundoComReceita,
  | 'fundo_cnpj'
  | 'tg_percentual' | 'tg_minimo_mensal' | 'tg_fixo_mensal'
  | 'ta_percentual' | 'ta_minimo_mensal' | 'ta_fixo_mensal'
  | 'tc_percentual' | 'tc_minimo_mensal' | 'tc_fixo_mensal'
  | 'tcons_percentual' | 'tcons_minimo_mensal' | 'tcons_fixo_mensal'
>

const TAXAS_SELECT_V2 =
  'fundo_cnpj, tg_percentual, tg_minimo_mensal, tg_fixo_mensal, ' +
  'ta_percentual, ta_minimo_mensal, ta_fixo_mensal, ' +
  'tc_percentual, tc_minimo_mensal, tc_fixo_mensal, ' +
  'tcons_percentual, tcons_minimo_mensal, tcons_fixo_mensal'

const TAXAS_SELECT_V1 =
  'fundo_cnpj, tg_percentual, tg_minimo_mensal, ' +
  'ta_percentual, ta_minimo_mensal, ' +
  'tc_percentual, tc_minimo_mensal, ' +
  'tcons_percentual, tcons_minimo_mensal'

async function fetchTaxasRowsFromTable(cnpjs: string[]): Promise<FundoTaxasRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let res = await (supabase as any)
    .from('fundos_taxas')
    .select(TAXAS_SELECT_V2)
    .in('fundo_cnpj', cnpjs)

  if (res.error && isMissingColumnError(res.error)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res = await (supabase as any)
      .from('fundos_taxas')
      .select(TAXAS_SELECT_V1)
      .in('fundo_cnpj', cnpjs)
  }

  if (res.error) throw res.error
  return (res.data ?? []) as FundoTaxasRow[]
}

/** Fallback quando vw_fundos_com_receita está indisponível (view desatualizada). */
async function fetchFundosTaxasDirect(): Promise<FundoComReceita[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('fundos_taxas')
    .select('*')
    .eq('ativo', true)
    .order('segmento')
    .order('fundo_cnpj')

  if (error) throw new Error(formatSupabaseError(error))

  return ((data ?? []) as FundoComReceita[]).map(f =>
    enrichFundoComReceita({
      ...f,
      pl_atual: f.pl_atual ?? f.pl_jan ?? 0,
      denominacao_social: f.denominacao_social ?? f.fundo_cnpj,
      cnpj_gestor: f.cnpj_gestor ?? '',
      cnpj_administrador: f.cnpj_administrador ?? '',
    }),
  )
}

async function fetchAllFundosComReceita(filtros?: FundosFiltros): Promise<FundoComReceita[]> {
  const rows: FundoComReceita[] = []
  let offset = 0
  let viewError: unknown = null

  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q = (supabase as any).from('vw_fundos_com_receita').select('*')
    if (filtros?.segmento)      q = q.eq('segmento', filtros.segmento)
    if (filtros?.tipo_fundo)    q = q.eq('tipo_fundo', filtros.tipo_fundo)
    if (filtros?.administrador) q = q.eq('administrador', filtros.administrador)
    if (filtros?.gestor)        q = q.eq('gestor', filtros.gestor)

    const { data, error } = await q
      .order('segmento')
      .order('denominacao_social')
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) {
      viewError = error
      break
    }
    const batch = (data ?? []) as FundoComReceita[]
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  if (viewError) {
    console.warn(
      '[use-fundos-taxas] vw_fundos_com_receita indisponível, usando fundos_taxas:',
      viewError,
    )
    return fetchFundosTaxasDirect()
  }

  return mergeTaxasFromFundosTaxas(rows)
}

async function mergeTaxasFromFundosTaxas(fundos: FundoComReceita[]): Promise<FundoComReceita[]> {
  if (fundos.length === 0) return []

  const deduped = dedupeFundosPorCnpj(fundos)

  // Só faz merge extra se a view não expõe colunas V2 (ex.: migration pendente).
  // ta_receita_mensal null é legítimo quando o fundo não tem TA — não dispara merge.
  const sample = deduped[0]
  const precisaMerge =
    !('ta_fixo_mensal' in sample) ||
    !('tg_fixo_mensal' in sample) ||
    !('ta_percentual' in sample)
  if (!precisaMerge) {
    return deduped.map(enrichFundoComReceita)
  }

  const cnpjs = deduped.map(f => f.fundo_cnpj)
  const taxasRows = await fetchTaxasRowsFromTable(cnpjs)

  const taxasMap = new Map<string, FundoTaxasRow>(
    taxasRows.map((r: FundoTaxasRow) => [r.fundo_cnpj, r]),
  )

  return deduped.map(f => {
    const t = taxasMap.get(f.fundo_cnpj)
    if (!t) return enrichFundoComReceita(f)
    return enrichFundoComReceita({
      ...f,
      tg_percentual: t.tg_percentual ?? f.tg_percentual ?? 0,
      tg_minimo_mensal: t.tg_minimo_mensal ?? f.tg_minimo_mensal,
      tg_fixo_mensal: t.tg_fixo_mensal ?? f.tg_fixo_mensal,
      ta_percentual: t.ta_percentual ?? f.ta_percentual ?? 0,
      ta_minimo_mensal: t.ta_minimo_mensal ?? f.ta_minimo_mensal,
      ta_fixo_mensal: t.ta_fixo_mensal ?? f.ta_fixo_mensal,
      tc_percentual: t.tc_percentual ?? f.tc_percentual ?? 0,
      tc_minimo_mensal: t.tc_minimo_mensal ?? f.tc_minimo_mensal,
      tc_fixo_mensal: t.tc_fixo_mensal ?? f.tc_fixo_mensal,
      tcons_percentual: t.tcons_percentual ?? f.tcons_percentual ?? 0,
      tcons_minimo_mensal: t.tcons_minimo_mensal ?? f.tcons_minimo_mensal,
      tcons_fixo_mensal: t.tcons_fixo_mensal ?? f.tcons_fixo_mensal,
    })
  })
}

export function useFundosComReceita(filtros?: FundosFiltros) {
  return useQuery({
    queryKey: fundosTaxasKeys.lista(filtros),
    queryFn: async () => {
      try {
        return await fetchAllFundosComReceita(filtros)
      } catch (err) {
        throw new Error(formatSupabaseError(err))
      }
    },
    staleTime: 2 * 60 * 1000,
    retry: 2,
    refetchOnMount: 'always',
  })
}

// ── Histórico de PL por fundo (posicao_carteira) ───────────────────────────

export function usePLHistorico(cnpj: string) {
  return useQuery({
    queryKey: fundosTaxasKeys.historico(cnpj),
    queryFn: async (): Promise<FundoPLHistorico[]> => {
      const rows = await fetchAllPLHistoricoMensal([cnpj])
      return rows.map(r => ({
        id: `${r.fundo_cnpj}-${r.mes_ref}`,
        fundo_cnpj: r.fundo_cnpj,
        mes_ref: r.mes_ref,
        pl_valor: r.pl_valor,
        created_at: r.data_referencia,
      }))
    },
    enabled: !!cnpj,
  })
}

// ── Histórico de PL — múltiplos fundos (posicao_carteira) ──────────────────

export function usePLHistoricoPosicao(cnpjs: string[]) {
  return useQuery({
    queryKey: fundosTaxasKeys.historicoPosicao(cnpjs),
    queryFn: () => fetchAllPLHistoricoMensal(cnpjs.length > 0 ? cnpjs : undefined),
    enabled: cnpjs.length > 0,
  })
}

// ── Histórico consolidado (todos os fundos, soma por mês) ─────────────────

export function usePLHistoricoConsolidado(cnpjs?: string[], enabled = true) {
  return useQuery({
    queryKey: [...fundosTaxasKeys.historicoConsolidado(), ...(cnpjs ?? []).sort()],
    queryFn: async (): Promise<{ mes_ref: string; pl_valor: number }[]> => {
      const rows = await fetchAllPLHistoricoMensal(
        cnpjs && cnpjs.length > 0 ? cnpjs : undefined,
      )
      const map = new Map<string, number>()
      for (const row of rows) {
        map.set(row.mes_ref, (map.get(row.mes_ref) ?? 0) + Number(row.pl_valor))
      }
      return Array.from(map.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([mes_ref, pl_valor]) => ({ mes_ref, pl_valor }))
    },
    enabled,
  })
}

export interface FundoDadosOperacionais {
  pl_dez_posicao: number | null
  data_pl_dez: string | null
  qtd_cotistas_passivo: number | null
  data_passivo_atual: string | null
}

/** PL dez e cotistas do passivo — fallback quando a view ainda não foi migrada */
export function useFundoDadosOperacionais(cnpj: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...fundosTaxasKeys.all, 'dados-operacionais', cnpj],
    enabled: enabled && !!cnpj,
    staleTime: 60_000,
    queryFn: async (): Promise<FundoDadosOperacionais> => {
      const normalized = cnpj!.replace(/\D/g, '')

      const { data: latestRows, error: errLatest } = await (supabase as any)
        .from('passivo_fundos')
        .select('data_posicao')
        .eq('fundo_cnpj', normalized)
        .order('data_posicao', { ascending: false })
        .limit(1)

      if (errLatest) throw errLatest

      const dataPassivo = latestRows?.[0]?.data_posicao ?? null
      let qtd_cotistas_passivo: number | null = null

      if (dataPassivo) {
        const { data: cotistas, error: errCot } = await (supabase as any)
          .from('passivo_fundos')
          .select('cotista')
          .eq('fundo_cnpj', normalized)
          .eq('data_posicao', dataPassivo)

        if (errCot) throw errCot
        qtd_cotistas_passivo = new Set(
          (cotistas ?? []).map((r: { cotista: string }) => r.cotista),
        ).size
      }

      const { data: plDezRows, error: errPlDez } = await (supabase as any)
        .from('posicao_carteira')
        .select('fundo_patliq, fundo_dtposicao')
        .eq('fundo_cnpj', normalized)
        .eq('section', 'caixa')
        .gt('fundo_patliq', 0)
        .like('fundo_dtposicao', '____12__')
        .order('fundo_dtposicao', { ascending: false })
        .limit(1)

      if (errPlDez) throw errPlDez

      return {
        qtd_cotistas_passivo,
        data_passivo_atual: dataPassivo,
        pl_dez_posicao: plDezRows?.[0]?.fundo_patliq ?? null,
        data_pl_dez: plDezRows?.[0]?.fundo_dtposicao ?? null,
      }
    },
  })
}

// ── Criar fundo ───────────────────────────────────────────────────────────

export function useCreateFundoTaxa() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: FundoTaxaFormData) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).from('fundos_taxas').insert(data)
      if (error) throw error
    },
    onSuccess: async (_data, variables) => {
      await refreshConferenciaTaxasMesCacheSafe(variables.fundo_cnpj)
      qc.invalidateQueries({ queryKey: fundosTaxasKeys.all })
      qc.invalidateQueries({ queryKey: conferenciaKeys.all })
    },
  })
}

// ── Editar fundo ──────────────────────────────────────────────────────────

export function useUpdateFundoTaxa() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ cnpj, data }: { cnpj: string; data: Partial<FundoTaxaFormData> }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from('fundos_taxas')
        .update(data)
        .eq('fundo_cnpj', cnpj)
      if (error) throw error
    },
    onSuccess: async (_data, variables) => {
      await refreshConferenciaTaxasMesCacheSafe(variables.cnpj)
      qc.invalidateQueries({ queryKey: fundosTaxasKeys.all })
      qc.invalidateQueries({ queryKey: conferenciaKeys.all })
    },
  })
}

// ── Inativar fundo (soft delete) ──────────────────────────────────────────

export function useInativarFundoTaxa() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (cnpj: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from('fundos_taxas')
        .update({ ativo: false })
        .eq('fundo_cnpj', cnpj)
      if (error) throw error
    },
    onSuccess: async (_data, cnpj) => {
      await refreshConferenciaTaxasMesCacheSafe(cnpj)
      qc.invalidateQueries({ queryKey: fundosTaxasKeys.all })
      qc.invalidateQueries({ queryKey: conferenciaKeys.all })
    },
  })
}

// ── Upsert histórico de PL ────────────────────────────────────────────────

export function useUpsertPLHistorico() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (
      rows: Array<{ fundo_cnpj: string; mes_ref: string; pl_valor: number }>
    ) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from('fundos_pl_historico')
        .upsert(rows, { onConflict: 'fundo_cnpj,mes_ref' })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: fundosTaxasKeys.all }),
  })
}

// ── PL por instituição (administrador) ────────────────────────────────────

export function usePLPorInstituicao() {
  return useQuery({
    queryKey: fundosTaxasKeys.porInstituicao(),
    queryFn: async (): Promise<PLPorInstituicao[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('vw_pl_por_instituicao')
        .select('*')
      if (error) throw error
      return (data ?? []) as PLPorInstituicao[]
    },
  })
}

// ── Sincronizar fundos de posicao_carteira ────────────────────────────────

export function useSyncFundos() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<number> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('sync_fundos_from_posicao')
      if (error) throw error
      return data as number
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: fundosTaxasKeys.all }),
  })
}

// ── Filtro de gestores monitorados (leve — sem vw_fundos_com_receita) ─────

export function useGestoresMonitoradosFiltro() {
  const gestoresQuery = useQuery({
    queryKey: ['gestores-monitorados'],
    queryFn: fetchGestoresMonitorados,
    staleTime: 5 * 60 * 1000,
    retry: 2,
  })

  const gestores = gestoresQuery.data ?? []

  const universoQuery = useQuery({
    queryKey: ['universo-cnpjs-monitorados'],
    queryFn: fetchUniversoCnpjsMonitorados,
    staleTime: 5 * 60 * 1000,
    retry: 2,
  })

  const adminGrupoHQuery = useQuery({
    queryKey: ['admin-cnpjs-grupo-h', gestores.map(g => g.id).join(',')],
    queryFn: () => fetchAdminCnpjsGrupoH(gestores),
    enabled: gestoresQuery.isSuccess && gestores.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: 2,
  })

  const filtroReady =
    gestoresQuery.isSuccess &&
    universoQuery.isSuccess &&
    (gestores.length === 0 || adminGrupoHQuery.isSuccess)

  const isLoading =
    (gestoresQuery.isPending && !gestoresQuery.data) ||
    (universoQuery.isPending && !universoQuery.data) ||
    (gestores.length > 0 && adminGrupoHQuery.isPending && !adminGrupoHQuery.data)

  return {
    gestores,
    universo: universoQuery.data ?? null,
    adminGrupoH: adminGrupoHQuery.data ?? new Set<string>(),
    filtroReady,
    isLoading,
    isFetching:
      gestoresQuery.isFetching ||
      universoQuery.isFetching ||
      adminGrupoHQuery.isFetching,
    isError: gestoresQuery.isError || universoQuery.isError,
    error: gestoresQuery.error ?? universoQuery.error ?? null,
  }
}

// ── Fundos do módulo Controle de Taxas (somente gestores monitorados) ─────

export function useControleTaxasFundos() {
  const queryClient = useQueryClient()
  const fundosQuery = useFundosComReceita()
  const filtro = useGestoresMonitoradosFiltro()

  const { gestores, universo, adminGrupoH, filtroReady } = filtro

  const fundosRaw = fundosQuery.data ?? []

  const fundosGestao = useMemo(() => {
    if (!filtroReady || !fundosQuery.isSuccess) return []
    if (gestores.length === 0) return fundosRaw
    return filtrarFundosPorGestoresMonitorados(
      fundosRaw,
      gestores,
      universo ?? null,
      adminGrupoH,
    )
  }, [filtroReady, fundosQuery.isSuccess, fundosRaw, gestores, universo, adminGrupoH])

  const cnpjsGestao = useMemo(
    () => fundosGestao.map(f => f.fundo_cnpj),
    [fundosGestao],
  )

  const isLoading =
    (fundosQuery.isPending && !fundosQuery.data) || filtro.isLoading

  const isRefreshing = fundosQuery.isFetching || filtro.isFetching

  const isError = fundosQuery.isError

  const error = fundosQuery.error ?? null

  const refetchAll = async () => {
    await refreshConferenciaTaxasMesCacheSafe()
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: fundosTaxasKeys.all }),
      queryClient.invalidateQueries({ queryKey: conferenciaKeys.all }),
      queryClient.invalidateQueries({ queryKey: ['gestores-monitorados'] }),
      queryClient.invalidateQueries({ queryKey: ['universo-cnpjs-monitorados'] }),
      queryClient.invalidateQueries({ queryKey: ['admin-cnpjs-grupo-h'] }),
    ])
  }

  return {
    fundos: fundosGestao,
    cnpjsGestao,
    isLoading,
    isRefreshing,
    isError,
    error,
    refetchAll,
    filtroReady,
  }
}
