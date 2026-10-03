import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { buildSnapshot } from '@/lib/mapaFundos/snapshot';
import { buscarResumoCotistasPassivo } from '@/lib/mapaFundos/cotistasPassivo';
import { aliasesPerfilPorNome, cnpjEstrutura, cnpjsCvmDoNo, cnpjsParaMetricasEstrutura, dataIsoEstrutura, loteCnpjConsulta, reduzirMetricasPorFundo, type MetricaEstrutura, type PerfilEstrutura, type RegistroEstrutura } from '@/lib/mapaFundos/estrutura';
import { consolidarMetricasInformeMensalFidc, type LinhaInformeMensalFidc } from '@/lib/mapaFundos/informeMensalFidc';

type CatalogoFinvest = { codigo: string; nome: string };

const MIGRATIONS_CVM = '20260908090000_create_informe_diario_metricas.sql e 20260908100000_mapa_estruturas.sql';

function erroInfraAusente(error: { code?: string; message?: string; status?: number }): boolean {
  return error.code === '42P01'
    || error.code === 'PGRST202'
    || error.code === 'PGRST205'
    || error.status === 404
    || !!error.message?.includes('does not exist')
    || !!error.message?.includes('Could not find the function');
}

async function extrairErroEdgeFunction(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.json() as { error?: string; message?: string };
      return body.error ?? body.message ?? error.message;
    } catch {
      return error.message;
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

// As tabelas recentes ainda não constam no arquivo gerado types.ts.
async function paginarPorCnpj<T>(
  ids: string[],
  consultar: (idsLote: string[], de: number, ate: number) => Promise<{ data: T[] | null; error: { code?: string; message?: string; status?: number } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += 120) {
    const lote = ids.slice(i, i + 120);
    for (let start = 0; ; start += 1000) {
      const { data, error } = await consultar(lote, start, start + 999);
      if (error) throw error;
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
  }
  return rows;
}

export async function buscarMetricasEstrutura(cnpjs: string[], data: string): Promise<MetricaEstrutura[]> {
  if (!cnpjs.length) return [];
  const { digits, formatted } = loteCnpjConsulta(cnpjs);
  const rows: MetricaEstrutura[] = [];
  const carregar = async (ids: string[]) => {
    if (!ids.length) return;
    try {
      rows.push(...await paginarPorCnpj<MetricaEstrutura>(ids, async (lote, de, ate) => {
        const { data: result, error } = await supabase.from('informe_diario_metricas' as never)
          .select('fundo_cnpj, data_competencia, patrimonio_liquido, numero_cotistas, origem, arquivo_origem')
          .in('fundo_cnpj', lote)
          .lte('data_competencia', data)
          .order('data_competencia', { ascending: false })
          .range(de, ate);
        return { data: result as unknown as MetricaEstrutura[] | null, error: error as { code?: string; message?: string; status?: number } | null };
      }));
    } catch (error) {
      const err = error as { code?: string; message?: string; status?: number };
      if (erroInfraAusente(err)) {
        throw new Error(`Tabela informe_diario_metricas não encontrada. Aplique as migrations ${MIGRATIONS_CVM} no Supabase.`);
      }
      throw new Error(`Informe Diário indisponível: ${err.message ?? String(error)}`);
    }
  };
  await carregar(digits);
  try { await carregar(formatted); } catch { /* máscara CVM com "/" pode falhar no PostgREST; os dígitos já cobrem a carga normalizada */ }
  const diarias = reduzirMetricasPorFundo(rows);
  const mensais = await buscarMetricasInformeMensalFidc(cnpjs, data);
  return [...diarias, ...mensais];
}

async function buscarCatalogoFinvest(): Promise<CatalogoFinvest[]> {
  const { data, error } = await supabase.from('finvest_fundos' as never)
    .select('codigo, nome')
    .eq('ativo', true);
  if (error) return [];
  return (data as unknown as CatalogoFinvest[] ?? []).filter(r => r.codigo && r.nome);
}

function filtroMensalPorDigitos(digits: string[]): string {
  return `cnpj_fundo_classe.in.(${digits.join(',')}),cnpj_fundo.in.(${digits.join(',')}),cnpj_classe.in.(${digits.join(',')})`;
}

async function buscarMetricasInformeMensalFidc(cnpjs: string[], data: string): Promise<MetricaEstrutura[]> {
  if (!cnpjs.length) return [];
  const rows: LinhaInformeMensalFidc[] = [];
  const { digits } = loteCnpjConsulta(cnpjs);
  for (let i = 0; i < digits.length; i += 80) {
    const lote = digits.slice(i, i + 80);
    for (let start = 0; ; start += 1000) {
      const { data: result, error } = await supabase.from('fidc_informe_mensal_import' as never)
        .select('cnpj_fundo_classe, cnpj_fundo, cnpj_classe, dt_comptc, pl, numero_cotistas, origem_tabela, arquivo_origem')
        .in('origem_tabela', ['TAB_IV_PARTE_A', 'TAB_X_1'])
        .or(filtroMensalPorDigitos(lote))
        .lte('dt_comptc', data)
        .order('dt_comptc', { ascending: false })
        .range(start, start + 999);
      if (error) {
        if (start === 0 && i === 0) return buscarMetricasInformeMensalFidcLegado(cnpjs, data);
        return consolidarMetricasInformeMensalFidc(rows, cnpjs);
      }
      rows.push(...(result as unknown as LinhaInformeMensalFidc[] ?? []));
      if (!result || result.length < 1000) break;
    }
  }
  return consolidarMetricasInformeMensalFidc(rows, cnpjs);
}

async function buscarMetricasInformeMensalFidcLegado(cnpjs: string[], data: string): Promise<MetricaEstrutura[]> {
  const rows: LinhaInformeMensalFidc[] = [];
  const { digits } = loteCnpjConsulta(cnpjs);
  for (let i = 0; i < digits.length; i += 80) {
    const lote = digits.slice(i, i + 80);
    const { data: result, error } = await supabase.from('fidc_informe_mensal_import' as never)
      .select('cnpj_fundo_classe, cnpj_fundo, cnpj_classe, dt_comptc, pl, arquivo_origem')
      .eq('origem_tabela', 'TAB_IV_PARTE_A')
      .or(filtroMensalPorDigitos(lote))
      .lte('dt_comptc', data)
      .order('dt_comptc', { ascending: false });
    if (error) return [];
    rows.push(...((result as unknown as LinhaInformeMensalFidc[] ?? []).map(r => ({ ...r, origem_tabela: 'TAB_IV_PARTE_A' as const, numero_cotistas: null }))));
  }
  return consolidarMetricasInformeMensalFidc(rows, cnpjs);
}

export async function buscarPerfisEstrutura(cnpjs: string[]): Promise<PerfilEstrutura[]> {
  const rows: PerfilEstrutura[] = [];
  const { digits, formatted } = loteCnpjConsulta(cnpjs);
  const consultar = async (ids: string[], coluna: 'cnpj_classe' | 'cnpj_fundo') => {
    if (!ids.length) return;
    for (let i = 0; i < ids.length; i += 80) {
      const lote = ids.slice(i, i + 80);
      for (let start = 0; ; start += 1000) {
        const { data, error } = await supabase.from('fundos_caracteristicas' as never)
          .select('cnpj_classe, cnpj_fundo, estrutura, gestor_principal, administrador, tipo_anbima, categoria_anbima, status, updated_at')
          .in(coluna, lote)
          .order('id').range(start, start + 999);
        if (error) throw new Error(`Cadastro de fundos indisponível: ${error.message}`);
        rows.push(...(data as unknown as PerfilEstrutura[] ?? []));
        if (!data || data.length < 1000) break;
      }
    }
  };
  await consultar(digits, 'cnpj_classe');
  await consultar(digits, 'cnpj_fundo');
  try {
    await consultar(formatted, 'cnpj_classe');
    await consultar(formatted, 'cnpj_fundo');
  } catch { /* cadastro já coberto pelos dígitos quando o CNPJ está sem máscara */ }
  return rows;
}
export async function buscarRegistrosEstrutura(dataRef: string): Promise<RegistroEstrutura[]> {
  const rows: RegistroEstrutura[] = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await supabase.from('mapa_estrutura_registros' as never)
      .select('id, tipo, entidade_chave, data_referencia, status, nota, fonte, responsavel, proxima_revisao, created_at')
      .lte('data_referencia', dataRef).order('created_at', { ascending: false }).order('id').range(start, start + 999);
    if (error) {
      if (erroInfraAusente(error as { code?: string; message?: string; status?: number })) return [];
      throw new Error(`Histórico de análises e contrapartes indisponível: ${error.message}`);
    }
    rows.push(...(data as unknown as RegistroEstrutura[] ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}
export function useMapaEstruturas(dtposicao: string, active: boolean) {
  const client = useQueryClient();
  const dataRef = dataIsoEstrutura(dtposicao);
  const snapshot = useQuery({ queryKey: ['mapa-estruturas', 'snapshot', dtposicao], queryFn: () => buildSnapshot(dtposicao, { estrito: true }), enabled: active && !!dtposicao, staleTime: 300_000 });
  const cnpjs = useMemo(
    () => [...new Set((snapshot.data?.nos ?? []).filter(n => n.tipo === 'fundo').map(n => cnpjEstrutura(n.cnpj)).filter(c => c.length === 14))].sort(),
    [snapshot.data],
  );
  const fundosPassivo = (snapshot.data?.nos ?? []).filter(n => n.tipo === 'fundo').map(n => ({ cnpj: n.cnpj ?? '', nome: n.nome }));
  const enabled = active && cnpjs.length > 0;
  const perfis = useQuery({ queryKey: ['mapa-estruturas', 'perfis', cnpjs], queryFn: () => buscarPerfisEstrutura(cnpjs), enabled, staleTime: 300_000, retry: 1 });
  const finvest = useQuery({ queryKey: ['mapa-estruturas', 'finvest'], queryFn: buscarCatalogoFinvest, enabled: active, staleTime: 300_000, retry: 1 });
  const perfisComAlias = useMemo(() => {
    const fundos = (snapshot.data?.nos ?? []).filter(n => n.tipo === 'fundo').map(n => ({ cnpj: n.cnpj, nome: n.nome }));
    return [...(perfis.data ?? []), ...aliasesPerfilPorNome(fundos, finvest.data ?? [])];
  }, [snapshot.data, perfis.data, finvest.data]);
  const cnpjsMetricas = useMemo(() => cnpjsParaMetricasEstrutura(cnpjs, perfisComAlias), [cnpjs, perfisComAlias]);
  const metricas = useQuery({
    queryKey: ['mapa-estruturas', 'cvm', dataRef, cnpjsMetricas],
    queryFn: () => buscarMetricasEstrutura(cnpjsMetricas, dataRef),
    enabled: enabled && !perfis.isLoading && !finvest.isLoading,
    staleTime: 300_000,
    retry: false,
  });
  const registros = useQuery({ queryKey: ['mapa-estruturas', 'registros', dataRef], queryFn: () => buscarRegistrosEstrutura(dataRef), enabled: active, staleTime: 60_000, retry: false });
  const passivo = useQuery({
    queryKey: ['mapa-estruturas', 'passivo', dataRef, cnpjs],
    queryFn: () => buscarResumoCotistasPassivo(fundosPassivo, dataRef),
    enabled,
    staleTime: 300_000,
    retry: false,
  });
  const importar = useMutation({
    mutationFn: async () => {
      let count = 0;
      let competenciaUsada = '';
      const nomesPorCnpj = Object.fromEntries(
        (snapshot.data?.nos ?? [])
          .filter(n => n.tipo === 'fundo' && cnpjEstrutura(n.cnpj).length === 14 && n.nome)
          .map(n => [cnpjEstrutura(n.cnpj), n.nome]),
      );
      const fundosImportar = [...new Set([...(cnpjsMetricas.length ? cnpjsMetricas : cnpjs), ...cnpjs])];
      for (let i = 0; i < fundosImportar.length; i += 500) {
        const { data, error } = await supabase.functions.invoke('importar-informe-diario-cvm', {
          body: {
            competencia: dataRef.slice(0, 7).replace('-', ''),
            fundos: fundosImportar.slice(i, i + 500),
            nomes: nomesPorCnpj,
          },
        });
        if (error) throw new Error(await extrairErroEdgeFunction(error));
        if (!data?.success) throw new Error((data as { error?: string })?.error ?? 'Falha na importação da CVM.');
        count += (data as { registros_importados?: number }).registros_importados ?? 0;
        competenciaUsada = (data as { competencia?: string }).competencia ?? competenciaUsada;
      }
      if (count === 0) {
        throw new Error(
          competenciaUsada
            ? `Nenhum registro encontrado no Informe Diário CVM (${competenciaUsada}). Tente uma data de referência com carteira importada ou aguarde a publicação do mês na CVM.`
            : 'Nenhum registro importado. Verifique se a tabela informe_diario_metricas existe no Supabase.',
        );
      }
      return count;
    },
    // Um lote anterior pode ter sido gravado mesmo se o próximo falhou.
    onSettled: () => client.invalidateQueries({ queryKey: ['mapa-estruturas', 'cvm'] }),
  });
  const tentouImportar = useRef('');
  useEffect(() => {
    if (!enabled || metricas.isLoading || metricas.isFetching || importar.isPending) return;
    if (tentouImportar.current === dataRef) return;
    const comCotistas = new Set(
      (metricas.data ?? [])
        .filter(m => m.numero_cotistas != null)
        .map(m => cnpjEstrutura(m.fundo_cnpj)),
    );
    const nosFi = (snapshot.data?.nos ?? []).filter(n => {
      if (n.tipo !== 'fundo') return false;
      const nome = n.nome.toUpperCase();
      if (/\bFII\b/.test(nome) && !/\bFIF\b/.test(nome)) return false;
      if (/\bFIDC\b/.test(nome) || /\bFIP\b/.test(nome)) return false;
      return /\bFIF\b|\bFICFIF\b|\bFIM\b|\bFIC\b/.test(nome);
    });
    const falta = nosFi.some(n => !cnpjsCvmDoNo(cnpjEstrutura(n.cnpj), perfisComAlias).some(id => comCotistas.has(id)));
    tentouImportar.current = dataRef;
    if (falta) importar.mutate();
  }, [enabled, dataRef, snapshot.data, perfisComAlias, metricas.data, metricas.isLoading, metricas.isFetching, importar]);
  const salvar = useMutation({
    mutationFn: async (registro: Omit<RegistroEstrutura, 'id' | 'created_at'>) => {
      const { error } = await supabase.from('mapa_estrutura_registros' as never).insert(registro as never);
      if (error) throw error;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['mapa-estruturas', 'registros'] }),
  });
  return { snapshot, metricas, perfis: { ...perfis, data: perfisComAlias }, registros, passivo, importar, salvar, atualizar: () => client.invalidateQueries({ queryKey: ['mapa-estruturas'] }) };
}
