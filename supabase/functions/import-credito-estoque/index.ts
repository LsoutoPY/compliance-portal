import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as XLSX from 'https://esm.sh/xlsx@0.18.5';

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

interface RawRow {
  [key: string]: unknown;
}

interface NormalizedRow {
  nome_fundo: string;
  doc_fundo: string | null;
  data_referencia: Date;
  data_vencimento_ajustada: Date;
  situacao_recebivel: string | null;
  valor_presente: number;
  valor_pdd_atual: number;
  faixa_pdd_arquivo: string | null;
  dias_atraso: number;
  bucket_atraso: Bucket;
}

interface BucketSummary {
  nome_fundo: string;
  doc_fundo: string | null;
  data_referencia: string;
  bucket_atraso: Bucket;
  exposicao: number;
  pdd_atual: number;
  pdd_modelo: number;
  gap: number;
  cobertura: number;
  percentual_carteira: number;
}

interface Indicador {
  nome_fundo: string;
  doc_fundo: string | null;
  data_referencia: string;
  carteira_total: number;
  over90: number;
  over180: number;
  coverage_vencidos: number;
  gap_total: number;
  pdd_atual_total: number;
  pdd_modelo_total: number;
  pl: number;
  pdd_sobre_pl: number;
  pdd_sobre_over90: number;
  impacto_stress_pl: number;
}

const defaultRates: Record<Bucket, number> = {
  Adimplente: 0.005,
  '1-30': 0.02,
  '31-60': 0.05,
  '61-90': 0.1,
  '91-180': 0.25,
  '180+': 0.5,
};

function normalizeHeader(input: string): string {
  return input
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cleanDoc(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits || raw;
}

function parseNumberBR(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  let s = String(value).trim();
  if (!s) return 0;

  s = s.replace(/\s/g, '');

  if (s.includes('.') && s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseDateDayFirst(value: unknown): Date | null {
  if (value == null || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 25569 && value < 70000) {
      const ms = Math.round((value - 25569) * 86400 * 1000);
      const excelDate = new Date(ms);
      return new Date(excelDate.getUTCFullYear(), excelDate.getUTCMonth(), excelDate.getUTCDate());
    }
    const numAsDate = new Date(value);
    if (!Number.isNaN(numAsDate.getTime())) {
      return new Date(numAsDate.getFullYear(), numAsDate.getMonth(), numAsDate.getDate());
    }
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const br = raw.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{2,4})$/);
  if (br) {
    const day = Number(br[1]);
    const month = Number(br[2]);
    const year = br[3].length === 2 ? Number(`20${br[3]}`) : Number(br[3]);
    const d = new Date(year, month - 1, day);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const iso = raw.match(/^(\d{4})[/. -](\d{1,2})[/. -](\d{1,2})$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const d = new Date(year, month - 1, day);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const fallback = new Date(raw);
  if (!Number.isNaN(fallback.getTime())) {
    return new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate());
  }

  return null;
}

function toYyyyMmDd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function toYyyyMmDdNoDash(dateStr: string): string {
  return dateStr.replace(/-/g, '');
}

function safeFundName(name: string): string {
  const n = String(name || '').trim();
  if (!n) return 'CONSOLIDADO';
  return n;
}

function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 15).join('\n');
  const options = [';', ',', '\t', '|'];
  let best = ';';
  let bestScore = -1;
  for (const d of options) {
    const count = (sample.match(new RegExp(`\\${d}`, 'g')) || []).length;
    if (count > bestScore) {
      bestScore = count;
      best = d;
    }
  }
  return best;
}

function parseCsvRows(text: string, delimiter: string): RawRow[] {
  const wb = XLSX.read(text, { type: 'string', raw: false, FS: delimiter });
  const firstSheet = wb.SheetNames[0];
  if (!firstSheet) return [];
  const ws = wb.Sheets[firstSheet];
  return XLSX.utils.sheet_to_json(ws, { defval: null }) as RawRow[];
}

function decodeBytes(bytes: Uint8Array): { text: string; strategy: string } {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (utf8.includes('\uFFFD')) {
    const latin1 = new TextDecoder('iso-8859-1', { fatal: false }).decode(bytes);
    return { text: latin1, strategy: 'latin1' };
  }
  return { text: utf8, strategy: 'utf-8-sig' };
}

function detectFormat(fileName: string): 'csv' | 'xlsx' {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx';
  return 'csv';
}

function getColumn(raw: RawRow, candidates: string[]): unknown {
  for (const [key, val] of Object.entries(raw)) {
    const nk = normalizeHeader(key);
    if (candidates.includes(nk)) return val;
  }
  return null;
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

function daysDiff(ref: Date, due: Date): number {
  const ms = ref.getTime() - due.getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  return Math.max(0, days);
}

function percent(num: number, den: number): number {
  if (!den) return 0;
  return num / den;
}

function hasMissingColumnError(error: unknown, column: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const message = String((error as { message?: string }).message ?? '').toLowerCase();
  return message.includes('column') && message.includes(column.toLowerCase());
}

function toBase64(buffer: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function buildCsvExport(resumo: BucketSummary[], indicadores: Indicador[]): string {
  const resumoHeader = ['nome_fundo', 'doc_fundo', 'data_referencia', 'bucket_atraso', 'exposicao', 'percentual_carteira', 'pdd_atual', 'pdd_modelo', 'gap', 'cobertura'];
  const indicadorHeader = [
    'nome_fundo',
    'doc_fundo',
    'data_referencia',
    'carteira_total',
    'over90',
    'over180',
    'coverage_vencidos',
    'gap_total',
    'pdd_atual_total',
    'pdd_modelo_total',
    'pl',
    'pdd_sobre_pl',
    'pdd_sobre_over90',
    'impacto_stress_pl',
  ];
  const resumoRows = resumo.map((r) =>
    [r.nome_fundo, r.doc_fundo ?? '', r.data_referencia, r.bucket_atraso, r.exposicao, r.percentual_carteira, r.pdd_atual, r.pdd_modelo, r.gap, r.cobertura].join(';')
  );
  const indicadorRows = indicadores.map((i) =>
    [
      i.nome_fundo,
      i.doc_fundo ?? '',
      i.data_referencia,
      i.carteira_total,
      i.over90,
      i.over180,
      i.coverage_vencidos,
      i.gap_total,
      i.pdd_atual_total,
      i.pdd_modelo_total,
      i.pl,
      i.pdd_sobre_pl,
      i.pdd_sobre_over90,
      i.impacto_stress_pl,
    ].join(';')
  );

  return [
    '[Resumo_por_faixa]',
    resumoHeader.join(';'),
    ...resumoRows,
    '',
    '[Indicadores]',
    indicadorHeader.join(';'),
    ...indicadorRows,
  ].join('\n');
}

function buildXlsxExport(resumo: BucketSummary[], indicadores: Indicador[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  const wsResumo = XLSX.utils.json_to_sheet(resumo);
  const wsIndicadores = XLSX.utils.json_to_sheet(indicadores);
  XLSX.utils.book_append_sheet(wb, wsResumo, 'Resumo_por_faixa');
  XLSX.utils.book_append_sheet(wb, wsIndicadores, 'Indicadores');
  const raw = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  if (raw instanceof Uint8Array) return raw;
  return new Uint8Array(raw as ArrayBuffer);
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Content-Type deve ser multipart/form-data com o arquivo no campo "file".',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const formData = await req.formData();
    const file = formData.get('file');
    const bucketConfigJson = formData.get('bucket_config_json');
    const fundoFilterRaw = String(formData.get('fundo_filter') ?? '').trim();
    const rawRates = typeof bucketConfigJson === 'string' ? bucketConfigJson : null;
    const rates = resolveRates(rawRates);

    if (!file || !(file instanceof File)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Nenhum arquivo recebido no campo "file".' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const logs: string[] = [];
    const format = detectFormat(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let rawRows: RawRow[] = [];

    if (format === 'xlsx') {
      const wb = XLSX.read(bytes, { type: 'array', cellDates: false });
      const firstSheet = wb.SheetNames[0];
      if (!firstSheet) {
        return new Response(
          JSON.stringify({ success: false, error: 'Arquivo XLSX sem abas válidas.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      rawRows = XLSX.utils.sheet_to_json(wb.Sheets[firstSheet], { defval: null }) as RawRow[];
      logs.push(`Leitura XLSX concluída: ${rawRows.length} linhas.`);
    } else {
      const decoded = decodeBytes(bytes);
      logs.push(`Encoding detectado: ${decoded.strategy}.`);

      const attempts = [';', detectDelimiter(decoded.text)];
      let parsed = false;
      for (const sep of attempts) {
        try {
          rawRows = parseCsvRows(decoded.text, sep);
          logs.push(`CSV parseado com delimitador "${sep}" (${rawRows.length} linhas).`);
          parsed = true;
          if (rawRows.length > 0) break;
        } catch (error) {
          logs.push(`Falha no parse CSV com delimitador "${sep}": ${error instanceof Error ? error.message : 'erro'}`);
        }
      }
      if (!parsed || rawRows.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'Falha ao ler CSV. Verifique delimitador/encoding.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    const requiredCheck = rawRows[0] ?? {};
    const requiredMissing: string[] = [];
    const hasDataRef = getColumn(requiredCheck, ['DATA_REFERENCIA']) != null;
    const hasDataVenc = getColumn(requiredCheck, ['DATA_VENCIMENTO_AJUSTADA']) != null;
    const hasValorPresente = getColumn(requiredCheck, ['VALOR_PRESENTE']) != null;
    const hasPddGeral = getColumn(requiredCheck, ['VALOR_PDD_GERAL']) != null;
    const hasPdd = getColumn(requiredCheck, ['VALOR_PDD']) != null;

    if (!hasDataRef) requiredMissing.push('DATA_REFERENCIA');
    if (!hasDataVenc) requiredMissing.push('DATA_VENCIMENTO_AJUSTADA');
    if (!hasValorPresente) requiredMissing.push('VALOR_PRESENTE');

    if (requiredMissing.length > 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Colunas obrigatórias ausentes: ${requiredMissing.join(', ')}`,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!hasPddGeral && !hasPdd) {
      logs.push('PDD não encontrado no arquivo (VALOR_PDD_GERAL/VALOR_PDD). Será assumido 0.');
    }

    const normalized: NormalizedRow[] = [];
    let invalidDateCount = 0;
    for (const row of rawRows) {
      const dataRef = parseDateDayFirst(getColumn(row, ['DATA_REFERENCIA']));
      const dataVenc = parseDateDayFirst(getColumn(row, ['DATA_VENCIMENTO_AJUSTADA']));
      if (!dataRef || !dataVenc) {
        invalidDateCount++;
        continue;
      }

      const nomeFundo = safeFundName(String(getColumn(row, ['NOME_FUNDO']) ?? '').trim());
      const docFundo = cleanDoc(getColumn(row, ['DOC_FUNDO']));
      const valorPresente = parseNumberBR(getColumn(row, ['VALOR_PRESENTE']));
      const valorPddAtual = hasPddGeral
        ? parseNumberBR(getColumn(row, ['VALOR_PDD_GERAL']))
        : hasPdd
        ? parseNumberBR(getColumn(row, ['VALOR_PDD']))
        : 0;
      const situacao = String(getColumn(row, ['SITUACAO_RECEBIVEL']) ?? '').trim() || null;
      const faixaPdd = String(getColumn(row, ['FAIXA_PDD_GERAL', 'FAIXA_PDD']) ?? '').trim() || null;

      const dias = daysDiff(dataRef, dataVenc);
      const bucket = bucketFromDelay(dias);

      normalized.push({
        nome_fundo: nomeFundo,
        doc_fundo: docFundo,
        data_referencia: dataRef,
        data_vencimento_ajustada: dataVenc,
        situacao_recebivel: situacao,
        valor_presente: valorPresente,
        valor_pdd_atual: valorPddAtual,
        faixa_pdd_arquivo: faixaPdd,
        dias_atraso: dias,
        bucket_atraso: bucket,
      });
    }

    if (normalized.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Nenhuma linha válida após normalização.',
          logs,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (invalidDateCount > 0) {
      const pct = (invalidDateCount / rawRows.length) * 100;
      logs.push(`Datas inválidas: ${invalidDateCount}/${rawRows.length} (${pct.toFixed(2)}%).`);
    }

    const filteredRows =
      fundoFilterRaw.length > 0
        ? normalized.filter(
            (r) =>
              r.nome_fundo.toUpperCase().includes(fundoFilterRaw.toUpperCase()) ||
              (r.doc_fundo ?? '').includes(fundoFilterRaw.replace(/\D/g, ''))
          )
        : normalized;

    if (filteredRows.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Filtro de fundo sem resultados.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const importId = crypto.randomUUID();
    const receiveRecords = filteredRows.map((r) => ({
      import_id: importId,
      nome_fundo: r.nome_fundo,
      doc_fundo: r.doc_fundo,
      data_referencia: toYyyyMmDd(r.data_referencia),
      data_vencimento_ajustada: toYyyyMmDd(r.data_vencimento_ajustada),
      situacao_recebivel: r.situacao_recebivel,
      valor_presente: r.valor_presente,
      valor_pdd_atual: r.valor_pdd_atual,
      faixa_pdd_arquivo: r.faixa_pdd_arquivo,
      dias_atraso: r.dias_atraso,
      bucket_atraso: r.bucket_atraso,
      source_filename: file.name,
    }));

    const cleanupKeys = new Map<string, { nome: string; doc: string | null; data: string }>();
    for (const r of filteredRows) {
      const data = toYyyyMmDd(r.data_referencia);
      const key = `${r.doc_fundo ?? ''}|${r.nome_fundo}|${data}`;
      cleanupKeys.set(key, { nome: r.nome_fundo, doc: r.doc_fundo, data });
    }

    for (const k of cleanupKeys.values()) {
      let q1 = supabase.from('credito_estoque_recebiveis').delete().eq('data_referencia', k.data).eq('nome_fundo', k.nome);
      let q2 = supabase.from('credito_estoque_resumo_bucket').delete().eq('data_referencia', k.data).eq('nome_fundo', k.nome);
      let q3 = supabase.from('credito_estoque_indicadores').delete().eq('data_referencia', k.data).eq('nome_fundo', k.nome);
      if (k.doc) {
        q1 = q1.eq('doc_fundo', k.doc);
        q2 = q2.eq('doc_fundo', k.doc);
        q3 = q3.eq('doc_fundo', k.doc);
      }
      await q1;
      await q2;
      await q3;
    }

    const BATCH = 500;
    for (let i = 0; i < receiveRecords.length; i += BATCH) {
      const batch = receiveRecords.slice(i, i + BATCH);
      const { error } = await supabase.from('credito_estoque_recebiveis').insert(batch);
      if (error) throw error;
    }

    const grouped = new Map<string, NormalizedRow[]>();
    for (const row of filteredRows) {
      const key = `${row.doc_fundo ?? ''}|${row.nome_fundo}|${toYyyyMmDd(row.data_referencia)}`;
      const list = grouped.get(key) ?? [];
      list.push(row);
      grouped.set(key, list);
    }

    const resumo: BucketSummary[] = [];
    const indicadores: Indicador[] = [];

    for (const [key, rows] of grouped.entries()) {
      const [doc, nome, dataRef] = key.split('|');
      const byBucket = new Map<Bucket, { exposicao: number; pddAtual: number; pddModelo: number }>();
      for (const bucket of BUCKET_ORDER) {
        byBucket.set(bucket, { exposicao: 0, pddAtual: 0, pddModelo: 0 });
      }

      for (const row of rows) {
        const current = byBucket.get(row.bucket_atraso)!;
        current.exposicao += row.valor_presente;
        current.pddAtual += row.valor_pdd_atual;
      }

      const carteiraTotal = rows.reduce((acc, r) => acc + r.valor_presente, 0);
      const pddAtualTotal = rows.reduce((acc, r) => acc + r.valor_pdd_atual, 0);

      for (const bucket of BUCKET_ORDER) {
        const current = byBucket.get(bucket)!;
        current.pddModelo = current.exposicao * rates[bucket];
        const gap = current.pddModelo - current.pddAtual;
        const cobertura = percent(current.pddAtual, current.exposicao);
        const percentualCarteira = percent(current.exposicao, carteiraTotal);
        
        resumo.push({
          nome_fundo: nome,
          doc_fundo: doc || null,
          data_referencia: dataRef,
          bucket_atraso: bucket,
          exposicao: current.exposicao,
          pdd_atual: current.pddAtual,
          pdd_modelo: current.pddModelo,
          gap,
          cobertura,
          percentual_carteira: percentualCarteira,
        });
      }

      const pddModeloTotal = BUCKET_ORDER.reduce((acc, b) => acc + (byBucket.get(b)?.pddModelo ?? 0), 0);
      const exposicaoOver90 =
        (byBucket.get('91-180')?.exposicao ?? 0) + (byBucket.get('180+')?.exposicao ?? 0);
      const exposicaoOver180 = byBucket.get('180+')?.exposicao ?? 0;
      const exposicaoVencidos =
        (byBucket.get('1-30')?.exposicao ?? 0) +
        (byBucket.get('31-60')?.exposicao ?? 0) +
        (byBucket.get('61-90')?.exposicao ?? 0) +
        exposicaoOver90;
      const gapTotal = pddModeloTotal - pddAtualTotal;

      let pl = 0;
      if (doc) {
        const { data: plData } = await supabase
          .from('posicao_carteira')
          .select('fundo_patliq')
          .eq('fundo_cnpj', doc)
          .eq('fundo_dtposicao', toYyyyMmDdNoDash(dataRef))
          .limit(1)
          .maybeSingle();
        pl = plData?.fundo_patliq ?? 0;
      }

      indicadores.push({
        nome_fundo: nome,
        doc_fundo: doc || null,
        data_referencia: dataRef,
        carteira_total: carteiraTotal,
        over90: percent(exposicaoOver90, carteiraTotal),
        over180: percent(exposicaoOver180, carteiraTotal),
        coverage_vencidos: percent(pddAtualTotal, exposicaoVencidos),
        coverage_npl: percent(pddAtualTotal, exposicaoOver90),
        aderencia_pdd: pddModeloTotal ? percent(pddAtualTotal, pddModeloTotal) : null,
        gap_total: gapTotal,
        pdd_atual_total: pddAtualTotal,
        pdd_modelo_total: pddModeloTotal,
        pl,
        pdd_sobre_pl: percent(pddAtualTotal, pl),
        pdd_sobre_over90: percent(pddAtualTotal, exposicaoOver90),
        impacto_stress_pl: percent(gapTotal, pl),
        delta_over90: null,
        delta_over180: null,
      });
    }

    const consolidatedRows = filteredRows;
    if (consolidatedRows.length > 0) {
      const byBucket = new Map<Bucket, { exposicao: number; pddAtual: number; pddModelo: number }>();
      for (const b of BUCKET_ORDER) byBucket.set(b, { exposicao: 0, pddAtual: 0, pddModelo: 0 });
      for (const row of consolidatedRows) {
        const current = byBucket.get(row.bucket_atraso)!;
        current.exposicao += row.valor_presente;
        current.pddAtual += row.valor_pdd_atual;
      }
      const carteiraTotal = consolidatedRows.reduce((acc, r) => acc + r.valor_presente, 0);
      const pddAtualTotal = consolidatedRows.reduce((acc, r) => acc + r.valor_pdd_atual, 0);
      const pddModeloTotal = BUCKET_ORDER.reduce((acc, b) => acc + (byBucket.get(b)?.pddModelo ?? 0), 0);
      const refDate = toYyyyMmDd(consolidatedRows[0].data_referencia);

      for (const b of BUCKET_ORDER) {
        const curr = byBucket.get(b)!;
        resumo.push({
          nome_fundo: 'CONSOLIDADO',
          doc_fundo: null,
          data_referencia: refDate,
          bucket_atraso: b,
          exposicao: curr.exposicao,
          pdd_atual: curr.pddAtual,
          pdd_modelo: curr.pddModelo,
          gap: curr.pddModelo - curr.pddAtual,
          cobertura: percent(curr.pddAtual, curr.exposicao),
          percentual_carteira: percent(curr.exposicao, carteiraTotal),
        });
      }

      const exposicaoOver90 =
        (byBucket.get('91-180')?.exposicao ?? 0) + (byBucket.get('180+')?.exposicao ?? 0);
      const exposicaoOver180 = byBucket.get('180+')?.exposicao ?? 0;
      const exposicaoVencidos =
        (byBucket.get('1-30')?.exposicao ?? 0) +
        (byBucket.get('31-60')?.exposicao ?? 0) +
        (byBucket.get('61-90')?.exposicao ?? 0) +
        exposicaoOver90;
      const gapTotal = pddModeloTotal - pddAtualTotal;
      const plTotal = indicadores.reduce((acc, i) => acc + (i.pl || 0), 0);

      indicadores.push({
        nome_fundo: 'CONSOLIDADO',
        doc_fundo: null,
        data_referencia: refDate,
        carteira_total: carteiraTotal,
        over90: percent(exposicaoOver90, carteiraTotal),
        over180: percent(exposicaoOver180, carteiraTotal),
        coverage_vencidos: percent(pddAtualTotal, exposicaoVencidos),
        coverage_npl: percent(pddAtualTotal, exposicaoOver90),
        aderencia_pdd: pddModeloTotal ? percent(pddAtualTotal, pddModeloTotal) : null,
        gap_total: gapTotal,
        pdd_atual_total: pddAtualTotal,
        pdd_modelo_total: pddModeloTotal,
        pl: plTotal,
        pdd_sobre_pl: percent(pddAtualTotal, plTotal),
        pdd_sobre_over90: percent(pddAtualTotal, exposicaoOver90),
        impacto_stress_pl: percent(gapTotal, plTotal),
        delta_over90: null,
        delta_over180: null,
      });
    }

    if (resumo.length > 0) {
      const records = resumo.map((r) => ({ ...r, import_id: importId }));
      for (let i = 0; i < records.length; i += BATCH) {
        const batch = records.slice(i, i + BATCH);
        const { error } = await supabase.from('credito_estoque_resumo_bucket').insert(batch);
        if (error) {
          if (hasMissingColumnError(error, 'percentual_carteira')) {
            const legacyBatch = batch.map(({ percentual_carteira: _pc, ...rest }) => rest);
            const { error: legacyError } = await supabase.from('credito_estoque_resumo_bucket').insert(legacyBatch);
            if (legacyError) throw legacyError;
          } else {
            throw error;
          }
        }
      }
    }

    if (indicadores.length > 0) {
      const records = indicadores.map((i) => ({ ...i, import_id: importId }));
      const { error } = await supabase.from('credito_estoque_indicadores').insert(records);
      if (error) {
        const isLegacyIndicatorsTable =
          hasMissingColumnError(error, 'pl') ||
          hasMissingColumnError(error, 'pdd_sobre_pl') ||
          hasMissingColumnError(error, 'pdd_sobre_over90') ||
          hasMissingColumnError(error, 'impacto_stress_pl') ||
          hasMissingColumnError(error, 'coverage_npl') ||
          hasMissingColumnError(error, 'aderencia_pdd') ||
          hasMissingColumnError(error, 'delta_over90');

        if (isLegacyIndicatorsTable) {
          const legacyRecords = records.map(
            ({
              pl: _pl,
              pdd_sobre_pl: _psp,
              pdd_sobre_over90: _pso90,
              impacto_stress_pl: _isp,
              coverage_npl: _cnpl,
              aderencia_pdd: _ader,
              delta_over90: _d90,
              delta_over180: _d180,
              ...rest
            }) => rest
          );
          const { error: legacyError } = await supabase.from('credito_estoque_indicadores').insert(legacyRecords);
          if (legacyError) throw legacyError;
        } else {
          throw error;
        }
      }
    }

    const dateToken = indicadores[0]?.data_referencia?.replace(/-/g, '') ?? 'sem_data';
    const fundToken = fundoFilterRaw ? fundoFilterRaw.replace(/[^\w-]+/g, '_') : 'consolidado';
    const baseFileName = `aging_resumo_${fundToken}_${dateToken}`;
    const csvContent = buildCsvExport(resumo, indicadores);
    const xlsxBuffer = buildXlsxExport(resumo, indicadores);
    const csvBase64 = toBase64(new TextEncoder().encode(csvContent));
    const xlsxBase64 = toBase64(xlsxBuffer);

    return new Response(
      JSON.stringify({
        success: true,
        import_id: importId,
        filename: file.name,
        rows_read: rawRows.length,
        rows_valid: filteredRows.length,
        data_referencia_detectada: indicadores[0]?.data_referencia ?? null,
        logs,
        pdd_rates: rates,
        resumo_por_faixa: resumo,
        indicadores,
        exports: {
          csv: {
            filename: `${baseFileName}.csv`,
            content_base64: csvBase64,
          },
          xlsx: {
            filename: `${baseFileName}.xlsx`,
            content_base64: xlsxBase64,
          },
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[import-credito-estoque] erro:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
