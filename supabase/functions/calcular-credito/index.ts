/**
 * Edge Function: calcular-credito
 *
 * Lê os recebíveis de estoque_fidc (importados via import-estoque-fidc) e
 * calcula: aging por bucket, PDD modelo, cobertura, gap e indicadores
 * consolidados (Over90, Over180, coverage, impacto stress).
 *
 * Salva resultados em:
 *   - credito_estoque_resumo_bucket   (resumo por faixa de atraso)
 *   - credito_estoque_indicadores     (KPIs por fundo + CONSOLIDADO)
 *
 * Request JSON:
 *   {
 *     data_referencia: string;       // obrigatório  (YYYY-MM-DD)
 *     doc_fundo?: string;            // opcional — filtra por CNPJ específico
 *     nome_fundo?: string;           // opcional — filtra por nome (fallback)
 *     bucket_config_json?: string;   // opcional — taxas PDD customizadas
 *   }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const BUCKET_ORDER = ['Adimplente', '1-30', '31-60', '61-90', '91-180', '180+'] as const;
type Bucket = (typeof BUCKET_ORDER)[number];
const BATCH = 500;

const defaultRates: Record<Bucket, number> = {
  Adimplente: 0.005,
  '1-30': 0.02,
  '31-60': 0.05,
  '61-90': 0.1,
  '91-180': 0.25,
  '180+': 0.5,
};

interface EstoqueRow {
  nome_fundo: string | null;
  doc_fundo: string | null;
  data_referencia: string | null;
  data_vencimento_ajustada: string | null;
  valor_presente: number | null;
  valor_pdd_geral: number | null;
  valor_pdd: number | null;
}

function resolveRates(raw: string | null): Record<Bucket, number> {
  if (!raw) return { ...defaultRates };
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    const merged: Record<Bucket, number> = { ...defaultRates };
    for (const b of BUCKET_ORDER) {
      const v = parsed[b];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        merged[b] = v > 1 ? v / 100 : v;
      }
    }
    return merged;
  } catch {
    return { ...defaultRates };
  }
}

function bucketFromDelay(days: number): Bucket {
  if (days <= 0) return 'Adimplente';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  if (days <= 180) return '91-180';
  return '180+';
}

function daysDiff(refDate: string, dueDate: string): number {
  const ref = new Date(refDate).getTime();
  const due = new Date(dueDate).getTime();
  return Math.max(0, Math.floor((ref - due) / 86400000));
}

function pct(num: number, den: number): number {
  return den ? num / den : 0;
}

function emptyBuckets() {
  const m = new Map<Bucket, { exposicao: number; pddAtual: number; pddModelo: number }>();
  for (const b of BUCKET_ORDER) m.set(b, { exposicao: 0, pddAtual: 0, pddModelo: 0 });
  return m;
}

function calcBuckets(rows: EstoqueRow[], dataReferencia: string, rates: Record<Bucket, number>) {
  const byBucket = emptyBuckets();
  for (const row of rows) {
    const vp = row.valor_presente ?? 0;
    const pdd = row.valor_pdd_geral ?? row.valor_pdd ?? 0;
    const dias = row.data_vencimento_ajustada ? daysDiff(dataReferencia, row.data_vencimento_ajustada) : 0;
    const bucket = bucketFromDelay(dias);
    const cur = byBucket.get(bucket)!;
    cur.exposicao += vp;
    cur.pddAtual += pdd;
  }
  for (const b of BUCKET_ORDER) {
    byBucket.get(b)!.pddModelo = byBucket.get(b)!.exposicao * rates[b];
  }
  return byBucket;
}

function buildResumo(
  importId: string,
  nomeFundo: string,
  docFundo: string | null,
  dataReferencia: string,
  byBucket: Map<Bucket, { exposicao: number; pddAtual: number; pddModelo: number }>,
  carteiraTotal: number,
) {
  return BUCKET_ORDER.map((b) => {
    const cur = byBucket.get(b)!;
    return {
      import_id: importId,
      nome_fundo: nomeFundo,
      doc_fundo: docFundo,
      data_referencia: dataReferencia,
      bucket_atraso: b,
      exposicao: cur.exposicao,
      pdd_atual: cur.pddAtual,
      pdd_modelo: cur.pddModelo,
      gap: cur.pddModelo - cur.pddAtual,
      cobertura: pct(cur.pddAtual, cur.exposicao),
      percentual_carteira: pct(cur.exposicao, carteiraTotal),
    };
  });
}

function buildIndicador(
  importId: string,
  nomeFundo: string,
  docFundo: string | null,
  dataReferencia: string,
  byBucket: Map<Bucket, { exposicao: number; pddAtual: number; pddModelo: number }>,
  carteiraTotal: number,
  pl: number | null,
) {
  const pddAtualTotal = BUCKET_ORDER.reduce((acc, b) => acc + byBucket.get(b)!.pddAtual, 0);
  const pddModeloTotal = BUCKET_ORDER.reduce((acc, b) => acc + byBucket.get(b)!.pddModelo, 0);
  const exposicaoOver90 =
    (byBucket.get('91-180')!.exposicao) +
    (byBucket.get('180+')!.exposicao);
  const exposicaoOver180 = byBucket.get('180+')!.exposicao;
  const exposicaoVencidos =
    (byBucket.get('1-30')!.exposicao) +
    (byBucket.get('31-60')!.exposicao) +
    (byBucket.get('61-90')!.exposicao) +
    exposicaoOver90;
  const gapTotal = pddModeloTotal - pddAtualTotal;

  return {
    import_id: importId,
    nome_fundo: nomeFundo,
    doc_fundo: docFundo,
    data_referencia: dataReferencia,
    carteira_total: carteiraTotal,
    over90: pct(exposicaoOver90, carteiraTotal),
    over180: pct(exposicaoOver180, carteiraTotal),
    coverage_vencidos: pct(pddAtualTotal, exposicaoVencidos),
    coverage_npl: pct(pddAtualTotal, exposicaoOver90),
    aderencia_pdd: pddModeloTotal ? pct(pddAtualTotal, pddModeloTotal) : null,
    gap_total: gapTotal,
    pdd_atual_total: pddAtualTotal,
    pdd_modelo_total: pddModeloTotal,
    pl: pl ?? 0,
    pdd_sobre_pl: pl ? pct(pddAtualTotal, pl) : null,
    pdd_sobre_over90: pct(pddAtualTotal, exposicaoOver90),
    impacto_stress_pl: pl ? pct(gapTotal, pl) : null,
    delta_over90: null as number | null,
    delta_over180: null as number | null,
  };
}

async function fetchPreviousIndicador(
  docFundo: string | null,
  nomeFundo: string,
  dataReferencia: string,
): Promise<{ over90: number; over180: number } | null> {
  let q = supabase
    .from('credito_estoque_indicadores')
    .select('over90, over180')
    .lt('data_referencia', dataReferencia)
    .eq('nome_fundo', nomeFundo)
    .order('data_referencia', { ascending: false })
    .limit(1);
  if (docFundo) q = (q as ReturnType<typeof q.eq>).eq('doc_fundo', docFundo);
  else q = (q as ReturnType<typeof q.is>).is('doc_fundo', null);
  const { data } = await q.maybeSingle();
  if (!data) return null;
  return { over90: data.over90 ?? 0, over180: data.over180 ?? 0 };
}

function applyDeltas(
  indicador: ReturnType<typeof buildIndicador>,
  prev: { over90: number; over180: number } | null,
) {
  if (!prev) return indicador;
  return {
    ...indicador,
    delta_over90: indicador.over90 - prev.over90,
    delta_over180: indicador.over180 - prev.over180,
  };
}

async function fetchPl(docFundo: string): Promise<number | null> {
  const docClean = docFundo.replace(/\D/g, '');
  const { data } = await supabase
    .from('posicao_carteira')
    .select('fundo_patliq')
    .or(`fundo_cnpj.eq.${docFundo},fundo_cnpj.eq.${docClean}`)
    .order('fundo_dtposicao', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data || data.fundo_patliq == null || data.fundo_patliq === 0) {
    console.warn(`[calcular-credito] PL não encontrado ou zero para ${docFundo}`);
    return null;
  }
  return data.fundo_patliq;
}

async function insertBatch(table: string, records: Record<string, unknown>[]) {
  for (let i = 0; i < records.length; i += BATCH) {
    const { error } = await supabase.from(table).insert(records.slice(i, i + BATCH));
    if (error) throw new Error(`Erro ao inserir em ${table}: ${error.message}`);
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const dataReferencia: string | undefined = body.data_referencia;
    const docFundoFilter: string | null = body.doc_fundo ?? null;
    const nomeFundoFilter: string | null = body.nome_fundo ?? null;
    const bucketConfigJson: string | null = body.bucket_config_json ?? null;

    if (!dataReferencia) {
      return new Response(
        JSON.stringify({ success: false, error: 'data_referencia é obrigatório (formato YYYY-MM-DD).' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const rates = resolveRates(bucketConfigJson);

    // ── 1. Buscar recebíveis em estoque_fidc ─────────────────────────
    let query = supabase
      .from('estoque_fidc')
      .select('nome_fundo, doc_fundo, data_referencia, data_vencimento_ajustada, valor_presente, valor_pdd_geral, valor_pdd')
      .eq('data_referencia', dataReferencia)
      .not('data_vencimento_ajustada', 'is', null)
      .not('valor_presente', 'is', null);

    if (docFundoFilter) query = (query as ReturnType<typeof query.eq>).eq('doc_fundo', docFundoFilter);
    else if (nomeFundoFilter) query = (query as ReturnType<typeof query.eq>).eq('nome_fundo', nomeFundoFilter);

    const { data: rows, error: fetchError } = await query;
    if (fetchError) throw fetchError;

    if (!rows || rows.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Nenhum recebível encontrado em estoque_fidc para ${dataReferencia}${docFundoFilter ? ` (CNPJ: ${docFundoFilter})` : ''}. Importe o arquivo de estoque FIDC antes de calcular.`,
        }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 2. Agrupar por fundo ─────────────────────────────────────────
    const grouped = new Map<string, EstoqueRow[]>();
    for (const row of rows as EstoqueRow[]) {
      const nome = row.nome_fundo || 'CONSOLIDADO';
      const key = `${row.doc_fundo ?? ''}||${nome}`;
      const list = grouped.get(key) ?? [];
      list.push(row);
      grouped.set(key, list);
    }

    const importId = crypto.randomUUID();
    const resumoRecords: Record<string, unknown>[] = [];
    const indicadorRecords: Record<string, unknown>[] = [];

    // ── 3. Calcular por fundo ────────────────────────────────────────
    for (const [key, fundRows] of grouped.entries()) {
      const [doc, nome] = key.split('||');
      const byBucket = calcBuckets(fundRows, dataReferencia, rates);
      const carteiraTotal = fundRows.reduce((acc, r) => acc + (r.valor_presente ?? 0), 0);
      const pl = doc ? await fetchPl(doc) : null;

      resumoRecords.push(...buildResumo(importId, nome, doc || null, dataReferencia, byBucket, carteiraTotal));
      const prev = await fetchPreviousIndicador(doc || null, nome, dataReferencia);
      indicadorRecords.push(
        applyDeltas(buildIndicador(importId, nome, doc || null, dataReferencia, byBucket, carteiraTotal, pl), prev),
      );
    }

    // ── 4. Calcular CONSOLIDADO (somente quando não há filtro de fundo) ──
    const calcularConsolidado = !docFundoFilter && !nomeFundoFilter;
    if (calcularConsolidado) {
      const byBucketConsolidado = calcBuckets(rows as EstoqueRow[], dataReferencia, rates);
      const carteiraTotal = (rows as EstoqueRow[]).reduce((acc, r) => acc + (r.valor_presente ?? 0), 0);
      const plValues = indicadorRecords.map(i => i.pl as number).filter(v => v > 0);
      const plTotal = plValues.length > 0 ? plValues.reduce((acc, v) => acc + v, 0) : null;

      resumoRecords.push(...buildResumo(importId, 'CONSOLIDADO', null, dataReferencia, byBucketConsolidado, carteiraTotal));
      const prevCons = await fetchPreviousIndicador(null, 'CONSOLIDADO', dataReferencia);
      indicadorRecords.push(
        applyDeltas(
          buildIndicador(importId, 'CONSOLIDADO', null, dataReferencia, byBucketConsolidado, carteiraTotal, plTotal),
          prevCons,
        ),
      );
    }

    // ── 5. Limpar dados anteriores ───────────────────────────────────
    if (docFundoFilter || nomeFundoFilter) {
      let q1 = supabase.from('credito_estoque_resumo_bucket').delete().eq('data_referencia', dataReferencia);
      let q2 = supabase.from('credito_estoque_indicadores').delete().eq('data_referencia', dataReferencia);
      if (docFundoFilter) {
        q1 = (q1 as ReturnType<typeof q1.eq>).eq('doc_fundo', docFundoFilter);
        q2 = (q2 as ReturnType<typeof q2.eq>).eq('doc_fundo', docFundoFilter);
      } else {
        q1 = (q1 as ReturnType<typeof q1.eq>).eq('nome_fundo', nomeFundoFilter!);
        q2 = (q2 as ReturnType<typeof q2.eq>).eq('nome_fundo', nomeFundoFilter!);
      }
      const { error: delErr1 } = await q1;
      if (delErr1) throw new Error(`Erro ao limpar resumo_bucket: ${delErr1.message}`);
      const { error: delErr2 } = await q2;
      if (delErr2) throw new Error(`Erro ao limpar indicadores: ${delErr2.message}`);
    } else {
      const { error: delErr1 } = await supabase.from('credito_estoque_resumo_bucket').delete().eq('data_referencia', dataReferencia);
      if (delErr1) throw new Error(`Erro ao limpar resumo_bucket: ${delErr1.message}`);
      const { error: delErr2 } = await supabase.from('credito_estoque_indicadores').delete().eq('data_referencia', dataReferencia);
      if (delErr2) throw new Error(`Erro ao limpar indicadores: ${delErr2.message}`);
    }

    // ── 6. Inserir resultados ────────────────────────────────────────
    await insertBatch('credito_estoque_resumo_bucket', resumoRecords);
    await insertBatch('credito_estoque_indicadores', indicadorRecords);

    // ── 7. Atualizar snapshot mensal (histórico dos gráficos Saúde FIDC) ─
    let snapshot_mensal: { success: boolean; error?: string; fundos_persistidos?: number } = {
      success: false,
      error: 'nao_executado',
    };
    try {
      const snapshotUrl = `${supabaseUrl}/functions/v1/snapshot-credito-mensal`;
      const snapRes = await fetch(snapshotUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
        body: JSON.stringify({ data_referencia: dataReferencia }),
      });
      const snapBody = await snapRes.json().catch(() => ({}));
      if (!snapRes.ok || !snapBody.success) {
        const errMsg = snapBody.error ?? `HTTP ${snapRes.status}`;
        console.warn('[calcular-credito] snapshot-credito-mensal falhou:', errMsg);
        snapshot_mensal = { success: false, error: errMsg };
      } else {
        snapshot_mensal = { success: true, fundos_persistidos: snapBody.fundos_persistidos };
      }
    } catch (snapshotErr) {
      const errMsg = snapshotErr instanceof Error ? snapshotErr.message : 'Erro desconhecido';
      console.warn('[calcular-credito] snapshot-credito-mensal falhou:', errMsg);
      snapshot_mensal = { success: false, error: errMsg };
    }

    return new Response(
      JSON.stringify({
        success: true,
        import_id: importId,
        data_referencia: dataReferencia,
        fundos_calculados: grouped.size,
        consolidado_gerado: calcularConsolidado,
        registros_resumo: resumoRecords.length,
        registros_indicadores: indicadorRecords.length,
        snapshot_mensal,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('[calcular-credito] erro:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
