import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { unzipSync } from 'npm:fflate@0.8.2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CVM_INDEX_URL = 'https://dados.cvm.gov.br/dados/FIDC/DOC/INF_MENSAL/DADOS/';
const CVM_ZIP_BASE_URL = 'https://dados.cvm.gov.br/dados/FIDC/DOC/INF_MENSAL/DADOS';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Nomes exatos das colunas na TAB_V (CVM)
// TP_FUNDO_CLASSE;CNPJ_FUNDO_CLASSE;DENOM_SOCIAL;DT_COMPTC;
// TAB_V_A_VL_DIRCRED_PRAZO (total);
// TAB_V_A1_VL_PRAZO_VENC_30 ... TAB_V_A10_VL_PRAZO_VENC_MAIOR_1080
// TAB_V_B_VL_DIRCRED_INAD (total inadimplente); TAB_V_B1..B10
// TAB_V_C_VL_DIRCRED_ANTECIPADO (total antecipado); TAB_V_C1..C10

// TAB_IV: TP_FUNDO_CLASSE;CNPJ_FUNDO_CLASSE;DENOM_SOCIAL;DT_COMPTC;
//         TAB_IV_A_VL_PL (coluna E = índice 4);TAB_IV_B_VL_PL_MEDIO
// TAB_X_1: CNPJ_FUNDO_CLASSE;DT_COMPTC;TAB_X_CLASSE_SERIE;ID_SUBCLASSE;TAB_X_NR_COTST
//         (número de cotistas por subclasse; somado por CNPJ na matriz). Não usar tab_X_1_1.

type OrigemTabela = 'TAB_V' | 'TAB_VI' | 'TAB_IV_PARTE_A' | 'TAB_X_1';

interface ImportResponse {
  success: boolean;
  competencia?: string;
  competencias?: string[];
  zip_url?: string;
  data_referencia?: string; // DD/MM/YYYY - último dia do mês da competência
  files_processed?: string[];
  imported?: number;
  cotistas_importados?: number;
  carga_completa?: boolean;
  aviso?: string;
  errors: string[];
}

/** TAB_X_1 completa de um mês recente tem ~10 mil linhas; o ZIP do mês corrente na CVM costuma vir com ~1,5 mil. */
const MIN_TAB_X1_LINHAS_COMPLETA = 3000;
const MAX_COMPETENCIAS_FALLBACK = 4;

interface UnifiedRow {
  competencia_yyyymm: string;
  ano_referencia: number;
  mes_referencia: number;
  dt_comptc: string | null;
  origem_tabela: OrigemTabela;
  bucket_tipo: string | null;
  arquivo_origem: string;
  linha_arquivo: number;
  cnpj_fundo_classe: string | null;
  denom_social: string | null;
  pl: number | null;
  numero_cotistas: number | null;
  // Totais por grupo
  total_a_prazo: number | null;
  total_b_inad: number | null;
  total_c_antecipado: number | null;
  // Buckets A (a prazo por vencimento)
  bucket_a1: number | null;
  bucket_a2: number | null;
  bucket_a3: number | null;
  bucket_a4: number | null;
  bucket_a5: number | null;
  bucket_a6: number | null;
  bucket_a7: number | null;
  bucket_a8: number | null;
  bucket_a9: number | null;
  bucket_a10: number | null;
  // Vértices agregados (mapeamento sistema)
  vertice_d42: number | null;
  vertice_d63: number | null;
  vertice_d126: number | null;
  vertice_d252: number | null;
  vertice_d378: number | null;
  vertice_maior_365: number | null;
}

// ─── Utilitários ────────────────────────────────────────────────────────────

function sanitizeCnpj(value: string | null | undefined): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.padStart(14, '0').slice(-14);
}

function parseNum(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const s = value.trim().replace(/\s/g, '');
  if (!s) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parseDate(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
}

function decodeBytes(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (utf8.includes('\uFFFD')) {
    return new TextDecoder('iso-8859-1', { fatal: false }).decode(bytes);
  }
  return utf8;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
      continue;
    }
    if (ch === ';' && !inQuotes) { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out;
}

function parseCsvRows(csvText: string): string[][] {
  return csvText
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map(parseCsvLine);
}

/** Retorna índice da primeira coluna cujo nome (normalizado) começa com `prefix` */
function colByPrefix(header: string[], prefix: string): number {
  const p = prefix.toUpperCase();
  return header.findIndex((h) => h.toUpperCase().startsWith(p));
}

/** Retorna índice da primeira coluna cujo nome normalizado é exatamente `name` */
function colExact(header: string[], name: string): number {
  const n = name.toUpperCase();
  return header.findIndex((h) => h.trim().toUpperCase() === n);
}

function nvl(...vals: Array<number | null>): number {
  return vals.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}

// ─── Classificação de arquivos ───────────────────────────────────────────────

function extractCompetencias(indexHtml: string): string[] {
  return [...new Set([...indexHtml.matchAll(/inf_mensal_fidc_(\d{6})\.zip/gi)].map((m) => m[1]))]
    .sort()
    .reverse();
}

function dataReferenciaCompetencia(competencia: string): string {
  const ano = parseInt(competencia.slice(0, 4), 10);
  const mes = parseInt(competencia.slice(4, 6), 10);
  const ultimoDia = new Date(ano, mes, 0).getDate();
  return `${String(ultimoDia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}`;
}

/** tab_V — exclui tab_VI, tab_VII, tab_VIII, tab_IX */
function isTabVFile(name: string): boolean {
  return /^inf_mensal_fidc_tab_v(?:_|\.|$)/i.test(name);
}

/** tab_VI — exclui tab_VII, tab_VIII etc. */
function isTabVIFile(name: string): boolean {
  return /^inf_mensal_fidc_tab_vi(?:_|\.|$)/i.test(name);
}

/** tab_IV — único arquivo no ZIP (contém col A = PL e col B = PL médio) */
function isTabIvFile(name: string): boolean {
  return /^inf_mensal_fidc_tab_iv(?:_|\.|$)/i.test(name);
}

/** tab_X_1 — número de cotistas por subclasse. Não inclui tab_X_1_1 (composição por tipo). */
function isTabX1File(name: string): boolean {
  return /^inf_mensal_fidc_tab_x_1(?:_\d{6})?\.csv$/i.test(name.split('/').at(-1) ?? name);
}

function linhaVaziaBuckets(): Pick<UnifiedRow,
  'total_a_prazo' | 'total_b_inad' | 'total_c_antecipado' |
  'bucket_a1' | 'bucket_a2' | 'bucket_a3' | 'bucket_a4' | 'bucket_a5' |
  'bucket_a6' | 'bucket_a7' | 'bucket_a8' | 'bucket_a9' | 'bucket_a10' |
  'vertice_d42' | 'vertice_d63' | 'vertice_d126' | 'vertice_d252' | 'vertice_d378' | 'vertice_maior_365'
> {
  return {
    total_a_prazo: null, total_b_inad: null, total_c_antecipado: null,
    bucket_a1: null, bucket_a2: null, bucket_a3: null,
    bucket_a4: null, bucket_a5: null, bucket_a6: null,
    bucket_a7: null, bucket_a8: null, bucket_a9: null, bucket_a10: null,
    vertice_d42: null, vertice_d63: null, vertice_d126: null,
    vertice_d252: null, vertice_d378: null, vertice_maior_365: null,
  };
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

function parseTabVorVI(
  parsedRows: string[][],
  origem: OrigemTabela,
  fileName: string,
  competencia: string
): UnifiedRow[] {
  if (parsedRows.length < 2) return [];

  const header = parsedRows[0];
  const dataRows = parsedRows.slice(1);
  const ano = Number(competencia.slice(0, 4));
  const mes = Number(competencia.slice(4, 6));
  const bucketTipo = origem === 'TAB_V' ? 'com_aquisicao_substancial' : 'sem_aquisicao_substancial';

  // Prefixo dinâmico: TAB_V_ ou TAB_VI_
  const pfx = origem === 'TAB_VI' ? 'TAB_VI_' : 'TAB_V_';

  // CNPJ / data
  const idxCnpj = colExact(header, 'CNPJ_FUNDO_CLASSE');
  const idxDenom = colExact(header, 'DENOM_SOCIAL');
  const idxDt = colExact(header, 'DT_COMPTC');

  // Totais de grupo
  const idxTotalA = colByPrefix(header, `${pfx}A_VL_DIRCRED_PRAZO`);
  const idxTotalB = colByPrefix(header, `${pfx}B_VL_DIRCRED_INAD`);
  const idxTotalC = colByPrefix(header, `${pfx}C_VL_DIRCRED_ANTECIPADO`);

  // Buckets A1..A10 por prefixo (ex: TAB_V_A1_VL_PRAZO_VENC_30)
  const idxA: number[] = [];
  for (let i = 1; i <= 10; i++) {
    idxA.push(colByPrefix(header, `${pfx}A${i}_`));
  }

  const get = (row: string[], idx: number): string | null =>
    idx >= 0 && idx < row.length ? (row[idx].trim() || null) : null;

  return dataRows.map((row, lineIdx) => {
    const cnpj = sanitizeCnpj(get(row, idxCnpj));
    if (!cnpj) return null;

    const a1 = parseNum(get(row, idxA[0]));
    const a2 = parseNum(get(row, idxA[1]));
    const a3 = parseNum(get(row, idxA[2]));
    const a4 = parseNum(get(row, idxA[3]));
    const a5 = parseNum(get(row, idxA[4]));
    const a6 = parseNum(get(row, idxA[5]));
    const a7 = parseNum(get(row, idxA[6]));
    const a8 = parseNum(get(row, idxA[7]));
    const a9 = parseNum(get(row, idxA[8]));
    const a10 = parseNum(get(row, idxA[9]));

    return {
      competencia_yyyymm: competencia,
      ano_referencia: ano,
      mes_referencia: mes,
      dt_comptc: parseDate(get(row, idxDt)),
      origem_tabela: origem,
      bucket_tipo: bucketTipo,
      arquivo_origem: fileName,
      linha_arquivo: lineIdx + 2,
      cnpj_fundo_classe: cnpj,
      denom_social: get(row, idxDenom),
      pl: null,
      numero_cotistas: null,
      total_a_prazo: parseNum(get(row, idxTotalA)),
      total_b_inad: parseNum(get(row, idxTotalB)),
      total_c_antecipado: parseNum(get(row, idxTotalC)),
      bucket_a1: a1,
      bucket_a2: a2,
      bucket_a3: a3,
      bucket_a4: a4,
      bucket_a5: a5,
      bucket_a6: a6,
      bucket_a7: a7,
      bucket_a8: a8,
      bucket_a9: a9,
      bucket_a10: a10,
      // Vértices: mapeamento do sistema
      vertice_d42: a1,
      vertice_d63: a2,
      vertice_d126: nvl(a3, a4) || null,
      vertice_d252: nvl(a5, a6) || null,
      vertice_d378: a7,
      vertice_maior_365: nvl(a8, a9, a10) || null,
    } as UnifiedRow;
  }).filter((r): r is UnifiedRow => r !== null);
}

function parseTabIV(
  parsedRows: string[][],
  fileName: string,
  competencia: string
): UnifiedRow[] {
  if (parsedRows.length < 2) return [];

  const header = parsedRows[0];
  const dataRows = parsedRows.slice(1);
  const ano = Number(competencia.slice(0, 4));
  const mes = Number(competencia.slice(4, 6));

  // Colunas: TP_FUNDO_CLASSE(0);CNPJ_FUNDO_CLASSE(1);DENOM_SOCIAL(2);DT_COMPTC(3);
  //          TAB_IV_A_VL_PL(4);TAB_IV_B_VL_PL_MEDIO(5)
  const idxCnpj = colExact(header, 'CNPJ_FUNDO_CLASSE');
  const idxDenom = colExact(header, 'DENOM_SOCIAL');
  const idxDt = colExact(header, 'DT_COMPTC');
  const idxPL = colByPrefix(header, 'TAB_IV_A_VL_PL');   // coluna E

  const get = (row: string[], idx: number): string | null =>
    idx >= 0 && idx < row.length ? (row[idx].trim() || null) : null;

  return dataRows
    .map((row, lineIdx) => {
      const cnpj = sanitizeCnpj(get(row, idxCnpj));
      const pl = parseNum(get(row, idxPL));
      if (!cnpj && pl == null) return null;

      return {
        competencia_yyyymm: competencia,
        ano_referencia: ano,
        mes_referencia: mes,
        dt_comptc: parseDate(get(row, idxDt)),
        origem_tabela: 'TAB_IV_PARTE_A' as const,
        bucket_tipo: null,
        arquivo_origem: fileName,
        linha_arquivo: lineIdx + 2,
        cnpj_fundo_classe: cnpj,
        denom_social: get(row, idxDenom),
        pl,
        numero_cotistas: null,
        ...linhaVaziaBuckets(),
      } as UnifiedRow;
    })
    .filter((r): r is UnifiedRow => r !== null);
}

function parseTabX1(
  parsedRows: string[][],
  fileName: string,
  competencia: string
): UnifiedRow[] {
  if (parsedRows.length < 2) return [];

  const header = parsedRows[0];
  const dataRows = parsedRows.slice(1);
  const ano = Number(competencia.slice(0, 4));
  const mes = Number(competencia.slice(4, 6));

  const idxCnpj = colExact(header, 'CNPJ_FUNDO_CLASSE');
  const idxDenom = colExact(header, 'DENOM_SOCIAL');
  const idxDt = colExact(header, 'DT_COMPTC');
  const idxCotistas = colExact(header, 'TAB_X_NR_COTST');
  if (idxCnpj < 0 || idxCotistas < 0) {
    throw new Error('Colunas CNPJ_FUNDO_CLASSE ou TAB_X_NR_COTST não encontradas na TAB_X_1.');
  }

  const get = (row: string[], idx: number): string | null =>
    idx >= 0 && idx < row.length ? (row[idx].trim() || null) : null;

  return dataRows
    .map((row, lineIdx) => {
      const cnpj = sanitizeCnpj(get(row, idxCnpj));
      if (!cnpj) return null;
      const cotistas = parseNum(get(row, idxCotistas));
      const numeroCotistas = cotistas == null ? null : Math.round(cotistas);

      return {
        competencia_yyyymm: competencia,
        ano_referencia: ano,
        mes_referencia: mes,
        dt_comptc: parseDate(get(row, idxDt)),
        origem_tabela: 'TAB_X_1' as const,
        bucket_tipo: null,
        arquivo_origem: fileName,
        linha_arquivo: lineIdx + 2,
        cnpj_fundo_classe: cnpj,
        denom_social: get(row, idxDenom),
        pl: null,
        numero_cotistas: numeroCotistas,
        ...linhaVaziaBuckets(),
      } as UnifiedRow;
    })
    .filter((r): r is UnifiedRow => r !== null);
}

// ─── Supabase ────────────────────────────────────────────────────────────────

async function deleteCompetencia(competencia: string): Promise<void> {
  const { error } = await supabase
    .from('fidc_informe_mensal_import')
    .delete()
    .eq('competencia_yyyymm', competencia);
  if (error) throw error;
}

async function insertBatches(rows: UnifiedRow[]): Promise<void> {
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase
      .from('fidc_informe_mensal_import')
      .insert(rows.slice(i, i + BATCH));
    if (error) throw error;
  }
}

interface CargaCompetencia {
  competencia: string;
  zipUrl: string;
  files: string[];
  rows: UnifiedRow[];
  errors: string[];
}

async function baixarEParsearCompetencia(competencia: string): Promise<CargaCompetencia> {
  const zipUrl = `${CVM_ZIP_BASE_URL}/inf_mensal_fidc_${competencia}.zip`;
  const zipResp = await fetch(zipUrl);
  if (!zipResp.ok) {
    return { competencia, zipUrl, files: [], rows: [], errors: [`ZIP ${competencia}: HTTP ${zipResp.status}`] };
  }

  const zipEntries = unzipSync(new Uint8Array(await zipResp.arrayBuffer()));
  const selected = Object.keys(zipEntries)
    .map((k) => ({ key: k, name: k.split('/').at(-1) ?? k }))
    .filter(({ name }) => isTabVIFile(name) || isTabVFile(name) || isTabIvFile(name) || isTabX1File(name));

  if (selected.length === 0) {
    return { competencia, zipUrl, files: [], rows: [], errors: [`Nenhum arquivo elegível no ZIP ${competencia}.`] };
  }

  const rows: UnifiedRow[] = [];
  const errors: string[] = [];
  for (const { key, name } of selected) {
    try {
      const csvText = decodeBytes(zipEntries[key]);
      const parsed = parseCsvRows(csvText);
      if (isTabVIFile(name)) rows.push(...parseTabVorVI(parsed, 'TAB_VI', name, competencia));
      else if (isTabVFile(name)) rows.push(...parseTabVorVI(parsed, 'TAB_V', name, competencia));
      else if (isTabIvFile(name)) rows.push(...parseTabIV(parsed, name, competencia));
      else if (isTabX1File(name)) rows.push(...parseTabX1(parsed, name, competencia));
    } catch (e) {
      errors.push(`Falha em ${competencia}/${name}: ${String(e)}`);
    }
  }
  return { competencia, zipUrl, files: selected.map((s) => s.name), rows, errors };
}

function tabX1Completa(rows: UnifiedRow[]): boolean {
  return rows.filter((r) => r.origem_tabela === 'TAB_X_1').length >= MIN_TAB_X1_LINHAS_COMPLETA;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const errors: string[] = [];

    const indexResp = await fetch(CVM_INDEX_URL);
    if (!indexResp.ok) {
      return new Response(
        JSON.stringify({ success: false, errors: [`Índice CVM: HTTP ${indexResp.status}`] }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    const competenciasIndice = extractCompetencias(await indexResp.text());
    if (competenciasIndice.length === 0) {
      return new Response(
        JSON.stringify({ success: false, errors: ['Competência não encontrada no índice CVM.'] }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const importadas: CargaCompetencia[] = [];
    let cargaCompleta = false;
    for (const competencia of competenciasIndice.slice(0, MAX_COMPETENCIAS_FALLBACK)) {
      const carga = await baixarEParsearCompetencia(competencia);
      errors.push(...carga.errors);
      if (carga.rows.length === 0) continue;
      await deleteCompetencia(competencia);
      await insertBatches(carga.rows);
      importadas.push(carga);
      if (tabX1Completa(carga.rows)) {
        cargaCompleta = true;
        break;
      }
    }

    if (importadas.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          competencia: competenciasIndice[0],
          imported: 0,
          errors: errors.length ? errors : ['Nenhuma linha válida gerada.'],
        } as ImportResponse),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const principal = importadas.find((c) => tabX1Completa(c.rows)) ?? importadas[0];
    const imported = importadas.reduce((s, c) => s + c.rows.length, 0);
    const cotistasImportados = importadas.reduce(
      (s, c) => s + c.rows.filter((r) => r.origem_tabela === 'TAB_X_1').length,
      0,
    );
    const aviso = cargaCompleta
      ? importadas.length > 1
        ? `O ZIP ${importadas[0].competencia} ainda está incompleto na CVM; a TAB_X_1 completa veio de ${principal.competencia}.`
        : undefined
      : 'Nenhum ZIP recente tem TAB_X_1 completa; o número de cotistas pode ficar em branco até a CVM republicar o mês.';

    return new Response(
      JSON.stringify({
        success: errors.length === 0,
        competencia: principal.competencia,
        competencias: importadas.map((c) => c.competencia),
        zip_url: principal.zipUrl,
        data_referencia: dataReferenciaCompetencia(principal.competencia),
        files_processed: importadas.flatMap((c) => c.files.map((f) => `${c.competencia}:${f}`)),
        imported,
        cotistas_importados: cotistasImportados,
        carga_completa: cargaCompleta,
        aviso,
        errors,
      } as ImportResponse),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, errors: [error instanceof Error ? error.message : String(error)] }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});


