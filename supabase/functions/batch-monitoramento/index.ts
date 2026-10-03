/**
 * Edge Function: batch-monitoramento
 *
 * Orquestra a execução em lotes de enquadramento e/ou liquidez para todos os
 * fundos monitorados de uma data (modo "diario") ou para os pares pendentes
 * num intervalo histórico (modo "pendentes").
 *
 * Modos:
 *   "diario"    — processa a última data disponível em posicao_carteira;
 *                 chamado pelo pg_cron às 12h e 18:30 BRT.
 *   "pendentes" — processa apenas pares sem cálculo no intervalo data_inicio..data_fim;
 *                 chamado pelo botão "Processar pendentes" da UI.
 *   "periodo"   — reprocessa todos os pares com posição no intervalo (UI "Rodar por Período").
 *
 * Batching: batch_offset / batch_limit (default 5 fundos/chamada).
 * Com auto_continue=true o servidor encadeia os lotes (EdgeRuntime.waitUntil).
 *
 * Request POST application/json:
 *   { mode: "diario",    modos?: string[], batch_offset?: number, batch_limit?: number, job_id?: string }
 *   { mode: "pendentes", data_inicio: string, data_fim: string, datas_periodo: string[] (obrigatório), total_hint?: number, modos?: string[], ... }
 *   { mode: "periodo",   data_inicio: string, data_fim: string, datas_periodo?: string[], fundos_filtro?: {fundo_cnpj,fundo_isin?}[], modos?: string[], ... }
 *
 * Modo "pendentes": datas_periodo deve trazer as datas com posição no intervalo (ex.: fetchPosicaoAvailableDates()
 * filtrado). O servidor consulta pendências data a data (equality scan sempre indexado) e nunca varre o
 * intervalo inteiro numa única query — isso é o que causava "canceling statement due to statement timeout".
 * O progresso (qual data já foi totalmente processada) fica em monitoramento_job_log.detalhes.pendentes_cursor.
 *
 * Response:
 *   { success, done, job_id, processed, errors, next_offset, total, summary }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── CORS ─────────────────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

// ─── Supabase ─────────────────────────────────────────────────────────────────

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface BatchRequest {
  mode: 'diario' | 'pendentes' | 'periodo';
  modos?: Array<'enquadramento' | 'liquidez'>;
  data_inicio?: string;
  data_fim?: string;
  /** Modos periodo/pendentes: datas exatas com posição (YYYYMMDD), subset de data_inicio..data_fim.
   *  No modo pendentes é OBRIGATÓRIO — evita qualquer query que varra o intervalo inteiro. */
  datas_periodo?: string[];
  /** Modo periodo: restringe a pares fundo_cnpj|fundo_isin selecionados na UI */
  fundos_filtro?: Array<{ fundo_cnpj: string; fundo_isin?: string }>;
  /** Estimativa de total (ex.: resultado do botão "Contar" na UI) — evita contagem exata no servidor */
  total_hint?: number;
  batch_offset?: number;
  batch_limit?: number;
  job_id?: string;
  /** Se true (default no modo diario), dispara próximo lote automaticamente até done */
  auto_continue?: boolean;
  /** Modo diario: quantas datas distintas (com XML) processar, da mais recente para trás (default 1) */
  dias_retroativos?: number;
}

interface BatchResponse {
  success: boolean;
  done: boolean;
  job_id: string;
  processed: number;
  errors: number;
  next_offset: number;
  total: number;
  summary?: { enquadramento: number; liquidez: number };
  error?: string;
}

interface ParMonitorado {
  fundo_cnpj: string;
  fundo_isin: string;
  fundo_dtposicao: string;
  nome_fundo?: string;
  nivel1_categoria?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanCnpj(cnpj: string): string {
  return String(cnpj ?? '').replace(/\D/g, '').padStart(14, '0');
}

/**
 * NEXUM JR e SR compartilham o CNPJ, mas representam classes distintas por
 * ISIN. A persistência operacional de liquidez ainda é única por CNPJ/data;
 * portanto, processar a SR depois da JR substituiria o resultado que deve
 * alimentar o alerta. Mantemos a regra restrita à classe identificada pelo
 * nome ligado ao par CNPJ + ISIN, sem afetar o monitoramento de enquadramento.
 */
function isNexumSenior(par: Pick<ParMonitorado, 'nome_fundo'>): boolean {
  return /\bFIDC\s+NEXUM\s+SR\b/i.test(par.nome_fundo ?? '');
}

/**
 * Infere a classe ANBIMA com base no nivel1_categoria ou nome do fundo.
 * Mesma heurística de LiquidezMonitoramentoList.tsx.
 */
function inferClasseAnbima(nivel1Categoria: string | null, nomeFundo: string): string {
  const cat = (nivel1Categoria ?? '').toUpperCase();
  const nome = (nomeFundo ?? '').toUpperCase();
  if (cat.includes('FIDC') || nome.includes('FIDC')) return 'Renda Fixa Crédito';
  return 'Multimercados';
}

/**
 * Busca as N datas distintas mais recentes em posicao_carteira.
 */
async function getUltimasDatasDisponiveis(n: number): Promise<string[]> {
  const limit = Math.max(1, Math.min(n, 30));
  const { data, error } = await supabase.rpc('get_ultimas_datas_posicao', { p_limit: limit });
  if (!error) {
    return ((data ?? []) as Array<{ fundo_dtposicao: string }>).map((r) => r.fundo_dtposicao);
  }

  // Fallback se RPC ainda não existir (migration pendente)
  const { data: rows, error: rowsErr } = await supabase
    .from('posicao_carteira')
    .select('fundo_dtposicao')
    .order('fundo_dtposicao', { ascending: false })
    .limit(500);
  if (rowsErr || !rows?.length) return [];

  const seen = new Set<string>();
  const datas: string[] = [];
  for (const row of rows as Array<{ fundo_dtposicao: string }>) {
    const dt = row.fundo_dtposicao;
    if (!seen.has(dt)) {
      seen.add(dt);
      datas.push(dt);
      if (datas.length >= limit) break;
    }
  }
  return datas;
}

async function buildParesDiarioParaData(dtposicao: string): Promise<ParMonitorado[]> {
  const pares: ParMonitorado[] = [];
  const { data: paresRaw, error: paresErr } = await supabase.rpc('get_pares_fundo_monitorado', {
    p_dtposicao: dtposicao,
  });
  if (paresErr) throw new Error(`get_pares_fundo_monitorado: ${paresErr.message}`);

  for (const p of (paresRaw ?? []) as Array<{ fundo_cnpj: string; fundo_isin: string; nome_fundo?: string }>) {
    const { data: fc } = await supabase
      .from('fundos_caracteristicas')
      .select('nivel1_categoria')
      .or(`cnpj_fundo.eq.${cleanCnpj(p.fundo_cnpj)},cnpj_classe.eq.${cleanCnpj(p.fundo_cnpj)}`)
      .limit(1)
      .single();

    pares.push({
      fundo_cnpj: p.fundo_cnpj,
      fundo_isin: p.fundo_isin ?? '',
      fundo_dtposicao: dtposicao,
      nome_fundo: p.nome_fundo ?? '',
      nivel1_categoria: (fc as { nivel1_categoria?: string } | null)?.nivel1_categoria ?? '',
    });
  }
  return pares;
}

/** Todos os pares (fundo, data) com posição no intervalo — modo "periodo". */
async function buildParesPeriodo(
  dataInicio: string,
  dataFim: string,
  datasPeriodo?: string[],
  fundosFiltro?: Array<{ fundo_cnpj: string; fundo_isin?: string }>,
): Promise<ParMonitorado[]> {
  const filtroSet = fundosFiltro?.length
    ? new Set(fundosFiltro.map((f) => `${f.fundo_cnpj}|${f.fundo_isin ?? ''}`))
    : null;

  const paresMap = new Map<string, ParMonitorado>();
  let pageOffset = 0;
  const pageSize = 1000;

  while (true) {
    let q = supabase
      .from('posicao_carteira')
      .select('fundo_cnpj, fundo_isin, fundo_dtposicao, nome_fundo, fundo_nome')
      .gte('fundo_dtposicao', dataInicio)
      .lte('fundo_dtposicao', dataFim)
      .not('fundo_cnpj', 'is', null)
      .order('fundo_dtposicao', { ascending: true })
      .order('fundo_cnpj', { ascending: true })
      .range(pageOffset, pageOffset + pageSize - 1);

    if (datasPeriodo?.length) {
      q = q.in('fundo_dtposicao', datasPeriodo);
    }

    const { data: rows, error } = await q;
    if (error) throw new Error(`posicao_carteira (periodo): ${error.message}`);
    if (!rows?.length) break;

    for (const p of rows as Array<{
      fundo_cnpj: string;
      fundo_isin: string | null;
      fundo_dtposicao: string;
      nome_fundo?: string | null;
      fundo_nome?: string | null;
    }>) {
      const isin = p.fundo_isin ?? '';
      const fundKey = `${p.fundo_cnpj}|${isin}`;
      if (filtroSet && !filtroSet.has(fundKey)) continue;

      const parKey = `${fundKey}|${p.fundo_dtposicao}`;
      if (!paresMap.has(parKey)) {
        paresMap.set(parKey, {
          fundo_cnpj: p.fundo_cnpj,
          fundo_isin: isin,
          fundo_dtposicao: p.fundo_dtposicao,
          nome_fundo: p.nome_fundo ?? p.fundo_nome ?? '',
          nivel1_categoria: '',
        });
      }
    }

    if (rows.length < pageSize) break;
    pageOffset += pageSize;
  }

  return [...paresMap.values()].sort((a, b) => {
    const dtCmp = a.fundo_dtposicao.localeCompare(b.fundo_dtposicao);
    if (dtCmp !== 0) return dtCmp;
    const cnpjCmp = a.fundo_cnpj.localeCompare(b.fundo_cnpj);
    if (cnpjCmp !== 0) return cnpjCmp;
    return a.fundo_isin.localeCompare(b.fundo_isin);
  });
}

async function getUltimaDataDisponivel(): Promise<string | null> {
  const datas = await getUltimasDatasDisponiveis(1);
  return datas[0] ?? null;
}

/**
 * Busca pendentes de UMA data exata (equality scan — sempre rápido/indexado).
 * Nunca varre o intervalo inteiro: é chamada em loop pelo cursor por-data abaixo.
 */
async function fetchPendentesParaData(dt: string, modos: string[]): Promise<ParMonitorado[]> {
  const paresSet = new Map<string, ParMonitorado>();

  if (modos.includes('enquadramento')) {
    const { data, error } = await supabase.rpc('get_pares_pendentes_enquadramento_data', {
      p_data: dt,
    });
    if (error) throw new Error(`get_pares_pendentes_enquadramento_data: ${error.message}`);
    for (const p of (data ?? []) as Array<{ fundo_cnpj: string; fundo_isin: string; fundo_dtposicao: string; nome_fundo?: string }>) {
      const key = `${p.fundo_cnpj}|${p.fundo_isin}`;
      if (!paresSet.has(key)) {
        paresSet.set(key, {
          fundo_cnpj: p.fundo_cnpj,
          fundo_isin: p.fundo_isin ?? '',
          fundo_dtposicao: p.fundo_dtposicao,
          nome_fundo: p.nome_fundo ?? '',
          nivel1_categoria: '',
        });
      }
    }
  }

  if (modos.includes('liquidez')) {
    const { data, error } = await supabase.rpc('get_pares_pendentes_liquidez_data', {
      p_data: dt,
    });
    if (error) throw new Error(`get_pares_pendentes_liquidez_data: ${error.message}`);
    for (const p of (data ?? []) as Array<{ fundo_cnpj: string; fundo_isin: string; fundo_dtposicao: string; nome_fundo?: string; nivel1_categoria?: string }>) {
      const key = `${p.fundo_cnpj}|${p.fundo_isin}`;
      const existing = paresSet.get(key);
      if (existing) {
        existing.nivel1_categoria = p.nivel1_categoria ?? '';
      } else {
        paresSet.set(key, {
          fundo_cnpj: p.fundo_cnpj,
          fundo_isin: p.fundo_isin ?? '',
          fundo_dtposicao: p.fundo_dtposicao,
          nome_fundo: p.nome_fundo ?? '',
          nivel1_categoria: p.nivel1_categoria ?? '',
        });
      }
    }
  }

  return [...paresSet.values()].sort((a, b) => {
    const cnpjCmp = a.fundo_cnpj.localeCompare(b.fundo_cnpj);
    if (cnpjCmp !== 0) return cnpjCmp;
    return a.fundo_isin.localeCompare(b.fundo_isin);
  });
}

/**
 * Monta o próximo lote de pendentes avançando um cursor por-data (dateIdx).
 * Cada chamada de fetchPendentesParaData é um equality scan (rápido) — nunca
 * escaneia o intervalo inteiro, então não sofre statement timeout.
 *
 * Retorna o lote e o novo cursor (dateIdx) a persistir em detalhes do job.
 * done=true quando dateIdx alcança o fim de datasPeriodo.
 */
async function buildPendentesLotePorData(
  datasPeriodo: string[],
  modos: string[],
  batchLimit: number,
  cursorInicial: number,
): Promise<{ lote: ParMonitorado[]; novoCursor: number; done: boolean }> {
  const lote: ParMonitorado[] = [];
  let idx = Math.max(0, Math.min(cursorInicial, datasPeriodo.length));

  while (lote.length < batchLimit && idx < datasPeriodo.length) {
    const dt = datasPeriodo[idx];
    const pend = await fetchPendentesParaData(dt, modos);

    if (pend.length === 0) {
      idx += 1;
      continue;
    }

    const need = batchLimit - lote.length;
    const slice = pend.slice(0, need);
    lote.push(...slice);

    if (pend.length <= need) {
      // Data totalmente drenada — avança cursor
      idx += 1;
    }
    // Senão: ainda há pendentes nessa data; próxima chamada revisita o mesmo idx
    // (a query já exclui os que acabaram de ser processados, pois lê o estado atual)
  }

  return { lote, novoCursor: idx, done: idx >= datasPeriodo.length };
}

// ─── Execução por par ────────────────────────────────────────────────────────

/**
 * Roda verificação de enquadramento para um par (fundo, data).
 * Reutiliza o contrato exato do orquestrador check-enquadramento.
 */
async function runEnquadramento(par: ParMonitorado): Promise<{ success: boolean; error?: string }> {
  try {
    const body: Record<string, string> = {
      fundo_cnpj: par.fundo_cnpj,
      fundo_dtposicao: par.fundo_dtposicao,
    };
    if (par.fundo_isin) body.fundo_isin = par.fundo_isin;

    const res = await fetch(`${supabaseUrl}/functions/v1/check-enquadramento`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = await res.json().catch(() => ({}));
    return { success: data?.success !== false };
  } catch (err: unknown) {
    return { success: false, error: (err as Error)?.message ?? 'Erro desconhecido' };
  }
}

/**
 * Roda cálculo de liquidez para um par (fundo, data) e persiste em
 * liquidez_monitoramento_risco (service role — persistência hoje só existe no frontend).
 */
async function runLiquidez(par: ParMonitorado): Promise<{ success: boolean; error?: string }> {
  try {
    const classe = inferClasseAnbima(par.nivel1_categoria ?? null, par.nome_fundo ?? '');

    const res = await fetch(`${supabaseUrl}/functions/v1/calculo-risco-liquidez`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fundo_cnpj: par.fundo_cnpj,
        fundo_isin: par.fundo_isin || null,
        fundo_dtposicao: par.fundo_dtposicao,
        classe,
        segmento_investidor: 'PRIVATE',
        metrica: 'media_simples',
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = await res.json().catch(() => null);

    if (!data?.success) {
      return { success: false, error: data?.error ?? 'Erro no cálculo de liquidez' };
    }

    // Extrai resultados e persiste em liquidez_monitoramento_risco
    const d = data.data ?? {};
    const isFechado = !!d.isFundoFechado;
    const prazoResgate = d.mainFundChar?.prazo_pagamento_resgate_dias ?? null;
    let status: string = d.worstStatus ?? 'pendente';
    let indiceLiquidez: number | null = null;
    let intermediateStatus: string | null = null;
    const totalPL: number = d.totalPL ?? 0;

    if (isFechado && d.fundoFechadoAnalise) {
      const ffa = d.fundoFechadoAnalise;
      const cs = ffa.statusCoberturaDespesa ?? 'indisponivel';
      indiceLiquidez = null;
      status = cs === 'indisponivel' ? 'pendente' : (cs as string);
    } else if (prazoResgate != null && Array.isArray(d.tabelaVertices)) {
      const vertice = d.tabelaVertices.find((v: { vertice: unknown }) => Number(v.vertice) === Number(prazoResgate))
        ?? d.tabelaVertices.find((v: { vertice: unknown }) => Number(v.vertice) >= Number(prazoResgate));
      if (vertice) {
        indiceLiquidez = vertice.indiceAcumulado ?? (
          vertice.passivoAcumulado > 0 ? vertice.ativoAcumulado / vertice.passivoAcumulado : null
        );
        status = vertice.statusConsolidado ?? vertice.status ?? status;
      }

      const intermediateVertices = (d.tabelaVertices as Array<{ vertice: unknown; statusConsolidado?: string; status?: string }>)
        .filter((v) => Number(v.vertice) < Number(prazoResgate));
      const hasViolacao = intermediateVertices.some((v) => (v.statusConsolidado ?? v.status) === 'violacao');
      const hasAlerta = intermediateVertices.some((v) => (v.statusConsolidado ?? v.status) === 'alerta');
      if (hasViolacao) intermediateStatus = 'violacao';
      else if (hasAlerta) intermediateStatus = 'alerta';
    }

    const cnpjClean = cleanCnpj(par.fundo_cnpj);
    const ffa = isFechado ? d.fundoFechadoAnalise : null;
    const { error: upsertErr } = await supabase
      .from('liquidez_monitoramento_risco')
      .upsert({
        fundo_cnpj: cnpjClean,
        dt_posicao: par.fundo_dtposicao,
        total_pl: totalPL,
        is_fundo_fechado: isFechado,
        prazo_resgate: prazoResgate ?? null,
        indice_liquidez: isFechado ? null : indiceLiquidez,
        status,
        intermediate_status: intermediateStatus,
        meses_cobertura: isFechado ? (ffa?.mesesCobertura ?? null) : null,
        status_cobertura: isFechado ? (ffa?.statusCoberturaDespesa ?? null) : null,
        disp_pl: isFechado ? (ffa?.dispPL ?? null) : null,
        fonte_despesa: isFechado ? (ffa?.fonteDespesa ?? null) : null,
        calculado_em: new Date().toISOString(),
      }, { onConflict: 'fundo_cnpj,dt_posicao' });

    if (upsertErr) {
      console.error('[batch-monitoramento] Erro ao persistir liquidez:', upsertErr.message);
      return { success: false, error: upsertErr.message };
    }

    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: (err as Error)?.message ?? 'Erro desconhecido' };
  }
}

async function markJobError(jobId: string | undefined, reason: string) {
  if (!jobId) return;
  await supabase
    .from('monitoramento_job_log')
    .update({
      status: 'error',
      fim: new Date().toISOString(),
      detalhes: { erro: reason },
    })
    .eq('id', jobId);
}

/** Dispara o próximo lote e garante que a requisição complete antes do isolate encerrar */
async function chainNextBatch(jobId: string, chainBody: Record<string, unknown>) {
  const res = await fetch(`${supabaseUrl}/functions/v1/batch-monitoramento`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${supabaseServiceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(chainBody),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    throw new Error(data?.error ?? `HTTP ${res.status}`);
  }
  return data;
}

function scheduleChain(jobId: string, chainBody: Record<string, unknown>) {
  const chainPromise = chainNextBatch(jobId, chainBody).catch(async (e) => {
    const msg = (e as Error)?.message ?? 'Falha ao encadear lote';
    console.error('[batch-monitoramento] Falha ao encadear lote:', msg);
    await markJobError(jobId, msg);
  });

  // Mantém o isolate vivo até a chamada HTTP do próximo lote completar
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(chainPromise);
  } else {
    chainPromise.catch(() => undefined);
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ success: false, error: 'Método não permitido' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  let jobId: string | undefined;

  try {
    const body: BatchRequest = await req.json().catch(() => ({}));
    const {
      mode,
      modos = ['enquadramento', 'liquidez'],
      data_inicio,
      data_fim,
      datas_periodo,
      fundos_filtro,
      total_hint,
      batch_offset = 0,
      batch_limit = 5,
      job_id: existingJobId,
      auto_continue = mode === 'diario',
      dias_retroativos = 1,
    } = body;

    jobId = existingJobId;

    if (!mode || !['diario', 'pendentes', 'periodo'].includes(mode)) {
      return new Response(
        JSON.stringify({ success: false, error: 'mode deve ser "diario", "pendentes" ou "periodo"' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if ((mode === 'pendentes' || mode === 'periodo') && (!data_inicio || !data_fim)) {
      return new Response(
        JSON.stringify({ success: false, error: 'data_inicio e data_fim são obrigatórios nos modos pendentes e periodo' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (mode === 'pendentes' && !datas_periodo?.length) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'datas_periodo é obrigatório no modo pendentes (envie as datas com posição no intervalo — evita varrer o período inteiro no banco).',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log(`[batch-monitoramento] Iniciando mode=${mode} offset=${batch_offset} limit=${batch_limit} modos=${modos.join(',')}`);

    // ── Montar lista completa de pares ─────────────────────────────────────

    let todosOsPares: ParMonitorado[] = [];
    let jobDataInicio = data_inicio ?? '';
    let jobDataFim = data_fim ?? '';
    let totalPendentes = 0;
    let pendentesCursor = 0;
    let pendentesDone = false;

    if (mode === 'diario') {
      const nDias = Math.max(1, Math.min(dias_retroativos, 30));
      const datas = await getUltimasDatasDisponiveis(nDias);
      if (datas.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'Nenhuma data disponível em posicao_carteira' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      jobDataInicio = datas[datas.length - 1];
      jobDataFim = datas[0];

      // Datas ASC para enquadramento (MM-10d tributário)
      for (const dt of [...datas].reverse()) {
        const paresData = await buildParesDiarioParaData(dt);
        todosOsPares.push(...paresData);
      }
    } else if (mode === 'periodo') {
      jobDataInicio = data_inicio!;
      jobDataFim = data_fim!;
      todosOsPares = await buildParesPeriodo(
        data_inicio!,
        data_fim!,
        datas_periodo?.length ? datas_periodo : undefined,
        fundos_filtro?.length ? fundos_filtro : undefined,
      );
      totalPendentes = todosOsPares.length;
    } else {
      // modo pendentes — cursor por-data: cada chamada de RPC é um equality scan
      // (sempre rápido/indexado), nunca uma varredura do intervalo inteiro.
      jobDataInicio = data_inicio!;
      jobDataFim = data_fim!;

      if (jobId) {
        const { data: jobRow } = await supabase
          .from('monitoramento_job_log')
          .select('detalhes, total_pares')
          .eq('id', jobId)
          .maybeSingle();
        pendentesCursor = Number((jobRow as { detalhes?: { pendentes_cursor?: number } } | null)?.detalhes?.pendentes_cursor ?? 0);
        totalPendentes = Number((jobRow as { total_pares?: number } | null)?.total_pares ?? 0);
      } else {
        // Total é apenas uma estimativa (ex.: resultado do botão "Contar" na UI) — evita
        // qualquer contagem exata no servidor, que já demonstrou sofrer statement timeout.
        totalPendentes = Math.max(0, Number(total_hint ?? 0));
      }

      const resultado = await buildPendentesLotePorData(datas_periodo!, modos, batch_limit, pendentesCursor);
      todosOsPares = resultado.lote;
      pendentesCursor = resultado.novoCursor;
      pendentesDone = resultado.done;
    }

    if (mode !== 'pendentes') {
      totalPendentes = todosOsPares.length;
    }

    // ── Criar ou atualizar job de log ──────────────────────────────────────
    if (!jobId) {
      const { data: newJob, error: jobErr } = await supabase
        .from('monitoramento_job_log')
        .insert({
          modo: mode,
          status: 'running',
          data_inicio: jobDataInicio,
          data_fim: jobDataFim,
          total_pares: totalPendentes,
          processados: 0,
          erros: 0,
        })
        .select('id')
        .single();
      if (jobErr) throw new Error(`Erro ao criar job log: ${jobErr.message}`);
      jobId = (newJob as { id: string }).id;
    }

    // Modo pendentes: todosOsPares já é o lote pronto (cursor por-data); diario/periodo usam offset
    const sliceOffset = mode === 'pendentes' ? 0 : batch_offset;
    const lote = mode === 'pendentes' ? todosOsPares : todosOsPares.slice(sliceOffset, sliceOffset + batch_limit);

    if (lote.length === 0) {
      const { data: jobAtual } = await supabase
        .from('monitoramento_job_log')
        .select('processados, erros, total_pares')
        .eq('id', jobId)
        .maybeSingle();
      const proc = (jobAtual as { processados?: number } | null)?.processados ?? 0;
      const errTotal = (jobAtual as { erros?: number } | null)?.erros ?? 0;
      const totalJob = (jobAtual as { total_pares?: number } | null)?.total_pares ?? proc;

      await supabase
        .from('monitoramento_job_log')
        .update({
          status: 'done',
          fim: new Date().toISOString(),
          processados: proc,
          erros: errTotal,
          ...(mode === 'pendentes' ? { detalhes: { pendentes_cursor: pendentesCursor } } : {}),
        })
        .eq('id', jobId);

      return new Response(
        JSON.stringify({
          success: true,
          done: true,
          job_id: jobId,
          processed: 0,
          errors: 0,
          next_offset: proc,
          total: totalJob,
        } as BatchResponse),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── Processar lote atual ───────────────────────────────────────────────
    let processados = 0;
    let erros = 0;
    let eqCount = 0;
    let liqCount = 0;
    const detalhesLote: Array<{ cnpj: string; isin: string; data: string; ok_eq: boolean; ok_liq: boolean; erros: string[] }> = [];

    for (const par of lote) {
      const itemErros: string[] = [];
      let okEq = true;
      let okLiq = true;

      if (modos.includes('enquadramento')) {
        const r = await runEnquadramento(par);
        if (r.success) eqCount++;
        else { erros++; okEq = false; if (r.error) itemErros.push(`eq: ${r.error}`); }
      }

      if (modos.includes('liquidez')) {
        if (isNexumSenior(par)) {
          console.log(
            `[batch-monitoramento] Liquidez não calculada para FIDC NEXUM SR (ISIN ${par.fundo_isin}); a notificação permanece exclusivamente na classe JR.`,
          );
        } else {
          const r = await runLiquidez(par);
          if (r.success) liqCount++;
          else { erros++; okLiq = false; if (r.error) itemErros.push(`liq: ${r.error}`); }
        }
      }

      processados++;
      detalhesLote.push({ cnpj: par.fundo_cnpj, isin: par.fundo_isin, data: par.fundo_dtposicao, ok_eq: okEq, ok_liq: okLiq, erros: itemErros });
    }

    const { data: jobAtual } = await supabase
      .from('monitoramento_job_log')
      .select('processados, erros, total_pares')
      .eq('id', jobId)
      .maybeSingle();
    const processadosAcumulados = ((jobAtual as { processados?: number } | null)?.processados ?? 0) + processados;
    const errosAcumulados = ((jobAtual as { erros?: number } | null)?.erros ?? 0) + erros;
    const totalJob = (jobAtual as { total_pares?: number } | null)?.total_pares ?? totalPendentes;

    const nextOffset = mode === 'pendentes'
      ? processadosAcumulados
      : batch_offset + lote.length;
    const done = mode === 'pendentes' ? pendentesDone : nextOffset >= totalPendentes;

    // ── Atualizar log ──────────────────────────────────────────────────────
    await supabase
      .from('monitoramento_job_log')
      .update({
        processados: processadosAcumulados,
        erros: errosAcumulados,
        status: done ? 'done' : 'running',
        fim: done ? new Date().toISOString() : null,
        detalhes: {
          ultimo_lote: detalhesLote,
          eq_ok: eqCount,
          liq_ok: liqCount,
          ...(mode === 'pendentes' ? { pendentes_cursor: pendentesCursor } : {}),
        },
      })
      .eq('id', jobId);

    console.log(`[batch-monitoramento] Lote offset=${sliceOffset} processados=${processados} erros=${erros} done=${done}`);

    // Cada cálculo persiste uma evidência diária por trigger. Consumir a fila aqui
    // mantém os episódios atualizados sem reconstruir o histórico e sem depender
    // de alguém abrir a tela de Monitoramento.
    const { data: motorEpisodios, error: motorEpisodiosError } = await supabase.rpc(
      'processar_evidencias_risco',
      { p_limite: 1000 },
    );
    if (motorEpisodiosError) {
      console.error('[batch-monitoramento] Falha não crítica ao processar episódios:', motorEpisodiosError.message);
    } else {
      console.log('[batch-monitoramento] Motor incremental de episódios:', motorEpisodios);
    }

    // Dispara notificações por e-mail ao final do batch diário
    if (done && mode === 'diario') {
      const runtime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;

      const dispararNotificacao = (fnName: string, body: Record<string, string>) =>
        (async () => {
          try {
            const url = `${supabaseUrl}/functions/v1/${fnName}`;
            const res = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseServiceKey}`,
              },
              body: JSON.stringify(body),
            });
            const text = await res.text();
            console.log(`[batch-monitoramento] ${fnName} status=${res.status} body=${text.slice(0, 200)}`);
          } catch (notifErr) {
            console.error(
              `[batch-monitoramento] Falha ao disparar ${fnName} (não crítico):`,
              (notifErr as Error)?.message,
            );
          }
        })();

      if (modos.includes('enquadramento')) {
        const notifPromise = dispararNotificacao('send-desenquadramento-notification', {
          fundo_dtposicao: jobDataFim,
          origem: 'auto',
        });
        if (runtime?.waitUntil) runtime.waitUntil(notifPromise);
      }

      if (modos.includes('liquidez')) {
        const notifPromise = dispararNotificacao('send-liquidez-notification', {
          fundo_dtposicao: jobDataFim,
          origem: 'auto',
        });
        if (runtime?.waitUntil) runtime.waitUntil(notifPromise);
      }
    }

    // Encadeia próximo lote automaticamente até processar todos
    if (!done && auto_continue) {
      scheduleChain(jobId!, {
        mode,
        modos,
        data_inicio,
        data_fim,
        datas_periodo,
        fundos_filtro,
        total_hint,
        batch_offset: mode === 'pendentes' ? 0 : nextOffset,
        batch_limit,
        job_id: jobId,
        auto_continue: true,
        dias_retroativos,
      });
    }

    return new Response(
      JSON.stringify({
        success: erros === 0 || processados > erros,
        done,
        job_id: jobId,
        processed: processados,
        errors: errosAcumulados,
        next_offset: nextOffset,
        total: totalJob,
        summary: { enquadramento: eqCount, liquidez: liqCount },
        detalhes_lote: detalhesLote,
      } as BatchResponse & { detalhes_lote?: unknown[] }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err: unknown) {
    const message = (err as Error)?.message ?? 'Erro interno';
    console.error('[batch-monitoramento] Erro:', message);
    await markJobError(jobId, message);
    return new Response(
      JSON.stringify({ success: false, error: message } as Partial<BatchResponse>),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
