import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { statusLimiteMaximo } from '../_shared/rule-status.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Types
type RuleStatus = 'ok' | 'alerta' | 'violacao';

interface RuleResult {
  regra_codigo: string;
  regra_descricao: string;
  status: RuleStatus;
  valor_atual: number | null;
  valor_limite: number | null;
  detalhes?: Record<string, unknown>;
}

interface RuleCheckResponse {
  success: boolean;
  results: RuleResult[];
  error?: string;
}

interface CheckEnquadramentoRequest {
  fundo_cnpj?: string;       // Optional: check specific fund
  fundo_isin?: string;       // Optional: ISIN discriminator for multi-class funds (JR/SR)
  fundo_dtposicao?: string;  // Optional: check specific date
  categories?: string[];     // Optional: ['pl', 'concentration', 'liquidity']
}

interface CheckEnquadramentoResponse {
  success: boolean;
  total_fundos: number;
  total_rules_checked: number;
  summary: {
    ok: number;
    alerta: number;
    violacao: number;
  };
  results_by_fund: Record<string, RuleResult[]>;
  error?: string;
  warnings?: string[];
}

function normalizeCategoriaToken(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function parseDateOnly(value: unknown): Date | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const compact = raw.replace(/\D/g, '');
  if (compact.length === 8) {
    const y = Number(compact.slice(0, 4));
    const m = Number(compact.slice(4, 6));
    const d = Number(compact.slice(6, 8));
    if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(d)) {
      return new Date(y, m - 1, d);
    }
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function businessDaysBetween(start: Date, end: Date): number {
  const from = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const to = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  if (to.getTime() < from.getTime()) return 0;

  let count = 0;
  const cursor = new Date(from);
  while (cursor.getTime() <= to.getTime()) {
    const weekday = cursor.getDay();
    if (weekday !== 0 && weekday !== 6) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

function isRegraMin67FiiFidc(
  targetCategoria: string,
  limiteMin: number | null,
  regraCodigo?: string,
): boolean {
  if (limiteMin == null || limiteMin < 0.669) return false;
  const codigo = (regraCodigo || '').trim().toUpperCase();
  if (codigo === 'CLASSE_FII_67' || codigo === 'CLASSE_FIDC_67') return true;
  const tokens = targetCategoria
    .split(',')
    .map((c) => normalizeCategoriaToken(c))
    .filter(Boolean);
  return tokens.some((t) => t === 'FII' || t.startsWith('FIDC'));
}

const MIN_ALOC_MAX_EVENTOS_12M = 2;
const MIN_ALOC_MAX_EVENTOS_12M_COTAS_50 = 1;
const MIN_ALOC_MAX_DIAS_VIOLACAO_12M = 30;

function normalizeLimiteMinFrac(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n >= 2 ? n / 100 : n;
}

function isRegraMin50CotasFidc(limiteMin: number | null | undefined): boolean {
  const lim = normalizeLimiteMinFrac(limiteMin);
  return lim != null && Math.abs(lim - 0.5) < 0.001;
}

function resolveMaxEventosMinAloc12m(limiteMin: number | null | undefined): number {
  return isRegraMin50CotasFidc(limiteMin) ? MIN_ALOC_MAX_EVENTOS_12M_COTAS_50 : MIN_ALOC_MAX_EVENTOS_12M;
}

function categoriaEnvolveFidcMinAloc(targetCategoria: string): boolean {
  const tokens = targetCategoria
    .split(',')
    .map((c) => normalizeCategoriaToken(c))
    .filter(Boolean);
  return tokens.some(
    (t) => t.startsWith('FIDC') || t === 'FICFIDC' || t.includes('FICFIDC') || t === 'FIDCNP',
  );
}

function isRegraMinAlocacaoFidcComContadores(
  targetCategoria: string,
  limiteMin: number | null,
  regraCodigo?: string,
): boolean {
  const codigo = (regraCodigo ?? '').toUpperCase();
  if (codigo === 'CLASSE_FIDC_67' || codigo.startsWith('CLASSE_FIDC_')) return true;
  if (limiteMin == null || limiteMin <= 0) return false;
  return categoriaEnvolveFidcMinAloc(targetCategoria);
}

function rolling12mBoundsYmd(fundoDtposicao: string): { fromYmd: string; toYmd: string } {
  const toYmd = fundoDtposicao.replace(/\D/g, '').slice(0, 8);
  const y = parseInt(toYmd.slice(0, 4), 10);
  const m = parseInt(toYmd.slice(4, 6), 10) - 1;
  const d = parseInt(toYmd.slice(6, 8), 10);
  const end = new Date(y, m, d);
  const start = new Date(end);
  start.setMonth(start.getMonth() - 12);
  const pad = (n: number) => String(n).padStart(2, '0');
  const fromYmd = `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}`;
  return { fromYmd, toYmd };
}

async function carregarSerieMinAloc12m(
  fundo_cnpj: string,
  cleanCnpj: string,
  fundo_isin: string,
  regra_codigo: string,
  fromYmd: string,
  toYmd: string,
): Promise<Array<{ fundo_dtposicao: string; status: RuleStatus }>> {
  const { data, error } = await supabase
    .from('enquadramento_resultado')
    .select('fundo_dtposicao, status')
    .or(`fundo_cnpj.eq.${fundo_cnpj},fundo_cnpj.eq.${cleanCnpj}`)
    .eq('fundo_isin', fundo_isin)
    .eq('regra_codigo', regra_codigo)
    .gte('fundo_dtposicao', fromYmd)
    .lte('fundo_dtposicao', toYmd)
    .order('fundo_dtposicao');

  if (error) {
    console.warn(`[check-enquadramento] Erro ao carregar série min aloc 12m: ${error.message}`);
    return [];
  }

  return (data ?? []).map((row) => ({
    fundo_dtposicao: String(row.fundo_dtposicao).replace(/\D/g, '').slice(0, 8),
    status: row.status as RuleStatus,
  }));
}

function calcularContadoresMinAloc12m(
  registros: Array<{ fundo_dtposicao: string; status: RuleStatus }>,
  dtAtual: string,
  statusAtual: RuleStatus,
): { eventos_12m: number; dias_violacao_12m: number } {
  const map = new Map<string, RuleStatus>();
  for (const r of registros) map.set(r.fundo_dtposicao, r.status);
  map.set(dtAtual, statusAtual);

  const sorted = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  let eventos_12m = 0;
  let dias_violacao_12m = 0;
  let emBloco = false;

  for (const [, st] of sorted) {
    if (st === 'violacao') {
      dias_violacao_12m += 1;
      if (!emBloco) {
        eventos_12m += 1;
        emBloco = true;
      }
    } else {
      emBloco = false;
    }
  }

  return { eventos_12m, dias_violacao_12m };
}

interface PatliqHeaderFields {
  fundo_valorativos?: number | null;
  fundo_valorreceber?: number | null;
  fundo_valorpagar?: number | null;
  fundo_vlcotasresgatar?: number | null;
}

const PL_RECEBER_MIN_DIFF = 50_000;

function calcPlHeaderAnbima(va: number, vr: number, vp: number, vlc: number): number {
  if (va <= 0 && vr <= 0) return 0;
  return va + vr - vp - vlc;
}

function isFundoFidcNivel1(nivel1: string | null | undefined): boolean {
  const u = String(nivel1 ?? '').toUpperCase().replace(/\s/g, '');
  return u === 'FIDC' || u === 'FIDCNP';
}

function calcPlFidcHeader(valorativos: number, valorreceber: number): number {
  return valorativos + valorreceber;
}

/**
 * Seleciona o registro mais adequado de fundos_caracteristicas quando o mesmo CNPJ
 * possui múltiplas classes (ex: NEXUM JR, NEXUM SR, MOVVIME…).
 * Prioridade: 1) ISIN exato (único por subclasse); 2) nome_comercial exato; 3) primeiro registro.
 */
function pickBestFundChar<T extends { nome_comercial?: string | null; isin?: string | null }>(
  rows: T[] | null | undefined,
  fundoIsin?: string | null,
  nomeFundo?: string | null,
): T | null {
  if (!rows || rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  if (fundoIsin) {
    const upper = fundoIsin.toUpperCase().trim();
    const byIsin = rows.find(r => String(r.isin ?? '').toUpperCase().trim() === upper);
    if (byIsin) return byIsin;
  }
  if (nomeFundo) {
    const upper = nomeFundo.toUpperCase().trim();
    const byName = rows.find(r => String(r.nome_comercial ?? '').toUpperCase().trim() === upper);
    if (byName) return byName;
  }
  return rows[0];
}

function fundoRegrasIsinQueryValues(fundoIsin?: string | null): string[] {
  const isin = fundoIsin ?? '';
  return isin ? [isin, ''] : [''];
}

function resolveFundoRegrasForIsin<T extends { fundo_isin?: string | null; regra_id: string }>(
  rows: T[] | null | undefined,
  fundoIsin?: string | null,
): T[] {
  const isin = fundoIsin ?? '';
  const applicable = (rows ?? []).filter((r) => {
    const rowIsin = r.fundo_isin ?? '';
    return rowIsin === '' || rowIsin === isin;
  });
  const byRegra = new Map<string, T>();
  for (const row of applicable) {
    const rowIsin = row.fundo_isin ?? '';
    const existing = byRegra.get(row.regra_id);
    if (!existing) {
      byRegra.set(row.regra_id, row);
      continue;
    }
    if (rowIsin !== '' && (existing.fundo_isin ?? '') === '') {
      byRegra.set(row.regra_id, row);
    }
  }
  return Array.from(byRegra.values());
}

/** Busca características do fundo; prioriza lookup direto por ISIN (subclasses FIDC). */
async function fetchFundCharacteristics(
  cleanCnpj: string,
  fundoIsin?: string | null,
  nomeFundo?: string | null,
  extraFields = '',
): Promise<Record<string, unknown> | null> {
  const baseFields = 'nivel1_categoria, patliq_soma_fidc, pl_formula, nome_comercial, isin';
  const select = extraFields ? `${baseFields},${extraFields}` : baseFields;

  if (fundoIsin) {
    const { data: byIsin } = await (supabase as any)
      .from('fundos_caracteristicas')
      .select(select)
      .or(`cnpj_classe.eq.${cleanCnpj},cnpj_fundo.eq.${cleanCnpj}`)
      .eq('isin', fundoIsin)
      .limit(1)
      .maybeSingle();
    if (byIsin) return byIsin as Record<string, unknown>;
  }

  const { data: fundCharRows } = await (supabase as any)
    .from('fundos_caracteristicas')
    .select(select)
    .or(`cnpj_classe.eq.${cleanCnpj},cnpj_fundo.eq.${cleanCnpj}`)
    .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo')
    .limit(50);
  return pickBestFundChar(fundCharRows, fundoIsin, nomeFundo) as Record<string, unknown> | null;
}

async function getPatliqContext(
  fundoCnpj: string,
  fundoDtposicao: string,
  patliqXml: number,
  headerFields?: PatliqHeaderFields,
  nomeFundo?: string | null,
  fundoIsin?: string | null,
): Promise<{
  patliqFinal: number;
  patliqXml: number;
  patliqFidc: number | null;
  patliqCsv: number | null;
  patliqDivergente: boolean;
  origem: 'xml' | 'csv' | 'fidc_header';
}> {
  const cnpj8 = fundoCnpj.replace(/\D/g, '').slice(0, 8);
  const dtIso = `${fundoDtposicao.slice(0, 4)}-${fundoDtposicao.slice(4, 6)}-${fundoDtposicao.slice(6, 8)}`;
  const cleanCnpj = fundoCnpj.replace(/\D/g, '');

  const fundChar = await fetchFundCharacteristics(cleanCnpj, fundoIsin, nomeFundo);

  let valorativos = Number(headerFields?.fundo_valorativos ?? 0) || 0;
  let valorreceber = Number(headerFields?.fundo_valorreceber ?? 0) || 0;
  let valorpagar = Number(headerFields?.fundo_valorpagar ?? 0) || 0;
  let vlcotasresgatar = Number(headerFields?.fundo_vlcotasresgatar ?? 0) || 0;

  const isFidc = isFundoFidcNivel1(fundChar?.nivel1_categoria);
  // Aplica va+vr SOMENTE quando pl_formula = 'va_vr' (modo Nexum JR).
  const usaVaVr = isFidc && fundChar?.pl_formula === 'va_vr';
  if ((usaVaVr || isFidc) && headerFields == null) {
    let vaVrQuery = supabase
      .from('posicao_carteira')
      .select('fundo_valorativos, fundo_valorreceber, fundo_valorpagar, fundo_vlcotasresgatar')
      .eq('fundo_cnpj', fundoCnpj)
      .eq('fundo_dtposicao', fundoDtposicao);
    if (fundoIsin) vaVrQuery = vaVrQuery.eq('fundo_isin', fundoIsin);
    const { data: posRow } = await vaVrQuery.limit(1).maybeSingle();
    valorativos = Number((posRow as any)?.fundo_valorativos ?? 0) || 0;
    valorreceber = Number((posRow as any)?.fundo_valorreceber ?? 0) || 0;
    valorpagar = Number((posRow as any)?.fundo_valorpagar ?? 0) || 0;
    vlcotasresgatar = Number((posRow as any)?.fundo_vlcotasresgatar ?? 0) || 0;
  }

  let patliqFidc: number | null = null;
  if (usaVaVr) {
    const plFidcRaw = calcPlFidcHeader(valorativos, valorreceber);
    // Quando pl_formula='va_vr', sempre usa va+vr e ignora fundo_patliq do XML.
    patliqFidc = plFidcRaw > 0 ? plFidcRaw : null;
  } else if (isFidc) {
    const plHeader = calcPlHeaderAnbima(valorativos, valorreceber, valorpagar, vlcotasresgatar);
    if (
      plHeader > 0 &&
      valorreceber > PL_RECEBER_MIN_DIFF &&
      plHeader - patliqXml > PL_RECEBER_MIN_DIFF &&
      plHeader > patliqXml * 1.05
    ) {
      patliqFidc = plHeader;
    }
  }
  const skipCsvOverride = Boolean(fundChar?.patliq_soma_fidc) || patliqFidc != null;
  const patliqBase = patliqFidc ?? patliqXml;

  const { data, error } = await (supabase as any)
    .from('carteira_finvest_raw')
    .select('valor_total_ativo')
    .eq('fundo_cnpj', cnpj8)
    .eq('data_posicao', dtIso)
    .not('valor_total_ativo', 'is', null)
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  const patliqCsv = data?.valor_total_ativo != null ? Number(data.valor_total_ativo) : null;
  // CSV Finvest é por CNPJ8 — bloquear override só em FIDC com ISIN (subclasses JR/SR no mesmo CNPJ).
  // FII e demais tipos com ISIN único devem usar CSV quando diverge materialmente do XML.
  const skipCsvByIsin = Boolean(fundoIsin) && isFidc;
  const patliqDivergente = !skipCsvOverride && !skipCsvByIsin && patliqCsv != null && patliqCsv !== patliqBase;

  return {
    patliqFinal: patliqDivergente ? patliqCsv! : patliqBase,
    patliqXml,
    patliqFidc,
    patliqCsv,
    patliqDivergente,
    origem: patliqDivergente ? 'csv' : patliqFidc != null ? 'fidc_header' : 'xml',
  };
}

// ─── Relational rules logic (extracted for parallel execution) ────────────────

async function processRelationalCategory(
  fund: { fundo_cnpj: string; fundo_isin: string; fundo_dtposicao: string }
): Promise<RuleResult[]> {
  console.log(`[check-enquadramento] Executing relational rules locally for fund ${fund.fundo_cnpj} isin=${fund.fundo_isin || '(none)'}`);

  // 1. Fetch active rules for this fund (global '' + subclasse específica)
  const { data: fundRulesRaw, error: rulesError } = await supabase
    .from('fundo_regras')
    .select(`
      id,
      fundo_cnpj,
      fundo_isin,
      regra_id,
      ativo,
      dt_inicio_vigencia,
      dt_fim_vigencia,
      regras_compliance (
        id,
        codigo,
        descricao,
        parametros
      )
    `)
    .eq('fundo_cnpj', fund.fundo_cnpj.replace(/\D/g, ''))
    .in('fundo_isin', fundoRegrasIsinQueryValues(fund.fundo_isin))
    .eq('ativo', true)
    .eq('status_aprovacao', 'ativo');

  let fundRules = resolveFundoRegrasForIsin(fundRulesRaw, fund.fundo_isin);
  fundRules = fundRules.filter((r) => {
    const row = r as { dt_inicio_vigencia?: string | null; dt_fim_vigencia?: string | null };
    const pos = fund.fundo_dtposicao.replace(/\D/g, '').slice(0, 8);
    if (pos.length !== 8) return true;
    const posDate = `${pos.slice(0, 4)}-${pos.slice(4, 6)}-${pos.slice(6, 8)}`;
    if (row.dt_inicio_vigencia && posDate < row.dt_inicio_vigencia) return false;
    if (row.dt_fim_vigencia && posDate > row.dt_fim_vigencia) return false;
    return true;
  });

  // ALWAYS delete previous relational results for this fund and date
  const { error: deleteRelError } = await supabase
    .from('enquadramento_resultado')
    .delete()
    .eq('fundo_cnpj', fund.fundo_cnpj)
    .eq('fundo_isin', fund.fundo_isin)
    .eq('fundo_dtposicao', fund.fundo_dtposicao)
    .eq('regra_categoria', 'relacional');

  if (deleteRelError) {
    console.error('[check-enquadramento] Error deleting previous relational results:', deleteRelError);
    return [];
  }

  if (rulesError) {
    console.error('[check-enquadramento] Error fetching fund rules:', rulesError);
    return [];
  }

  if (!fundRules || fundRules.length === 0) {
    console.log(`[check-enquadramento] No active relational rules found for fund ${fund.fundo_cnpj}`);
    return [];
  }

  console.log(`[check-enquadramento] Found ${fundRules.length} active relational rules for fund ${fund.fundo_cnpj}`);

  // 2. Fetch fund portfolio (posicao_carteira) and CSV-only assets in parallel
  const [
    { data: assetsXml, error: assetsError },
    csvOnlyAssets,
  ] = await Promise.all([
    (async () => {
      let q = supabase
        .from('posicao_carteira')
        .select('*')
        .eq('fundo_cnpj', fund.fundo_cnpj)
        .eq('fundo_dtposicao', fund.fundo_dtposicao);
      if (fund.fundo_isin) q = q.eq('fundo_isin', fund.fundo_isin);
      return q;
    })(),
    (async () => {
      try {
        const cnpj8 = fund.fundo_cnpj.replace(/\D/g, '').slice(0, 8);
        const dtIso = `${fund.fundo_dtposicao.slice(0,4)}-${fund.fundo_dtposicao.slice(4,6)}-${fund.fundo_dtposicao.slice(6,8)}`;
        const { data: csvItems } = await supabase
          .from('posicao_consolidada' as any)
          .select('id, secao_xml, valor_mercado, cnpj_ativo, nome_ativo')
          .eq('fundo_cnpj', cnpj8)
          .eq('data_posicao', dtIso)
          .eq('status_consolidacao', 'somente_csv')
          .not('secao_xml', 'is', null);
        return csvItems ?? [];
      } catch (_) {
        return [];
      }
    })(),
  ]);

  if (assetsError) {
    console.error('[check-enquadramento] Error fetching assets:', assetsError);
    return [];
  }

  if (!assetsXml || assetsXml.length === 0) return [];

  const patliqXml = assetsXml[0]?.fundo_patliq || 0;
  const patliqContext = await getPatliqContext(fund.fundo_cnpj, fund.fundo_dtposicao, patliqXml, {
    fundo_valorativos: assetsXml[0]?.fundo_valorativos,
    fundo_valorreceber: assetsXml[0]?.fundo_valorreceber,
    fundo_valorpagar: assetsXml[0]?.fundo_valorpagar,
    fundo_vlcotasresgatar: assetsXml[0]?.fundo_vlcotasresgatar,
  }, assetsXml[0]?.nome_fundo ?? null, assetsXml[0]?.fundo_isin ?? null);
  const patliqRef = patliqContext.patliqFinal;
  const csvMapped = (csvOnlyAssets as any[]).map((c: any) => ({
    id: `csv_${c.id}`,
    section: c.secao_xml,
    fundo_cnpj: fund.fundo_cnpj,
    fundo_dtposicao: fund.fundo_dtposicao,
    fundo_patliq: patliqRef,
    valor_padrao: c.valor_mercado ?? 0,
    cnpjfundo: c.cnpj_ativo ?? null,
    nome_fundo: assetsXml[0]?.nome_fundo ?? null,
  }));
  if (csvMapped.length > 0) {
    console.log(`[check-enquadramento] +${csvMapped.length} ativos somente_csv para fundo ${fund.fundo_cnpj}`);
  }

  const assets = [...assetsXml, ...csvMapped];
  const patliq = patliqContext.patliqFinal;
  const patliqDetalhes = {
    patliq,
    patliq_xml: patliqContext.patliqXml,
    patliq_fidc: patliqContext.patliqFidc,
    patliq_csv: patliqContext.patliqCsv,
    patliq_divergente: patliqContext.patliqDivergente,
    patliq_origem_utilizada: patliqContext.origem,
  };

  // 2b. Fetch the fund's own characteristics
  const cleanCnpj = fund.fundo_cnpj.replace(/\D/g, '');
  const { data: fundChar } = await supabase
    .from('fundos_caracteristicas')
    .select('nivel1_categoria, data_inicio_atividade')
    .or(`cnpj_classe.eq.${cleanCnpj},cnpj_fundo.eq.${cleanCnpj}`)
    .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo')
    .limit(1)
    .maybeSingle();
  const fundOwnNivel1 = fundChar?.nivel1_categoria
    ? (fundChar.nivel1_categoria as string).toUpperCase()
    : null;
  const fundStartDate = parseDateOnly((fundChar as any)?.data_inicio_atividade);
  const dtPosicaoDate = parseDateOnly(fund.fundo_dtposicao);
  const carenciaMinimoDiasUteis = 180;
  const diasUteisDesdeInicio = fundStartDate && dtPosicaoDate
    ? businessDaysBetween(fundStartDate, dtPosicaoDate)
    : null;
  const emCarenciaIntegralizacao = diasUteisDesdeInicio != null
    ? diasUteisDesdeInicio <= carenciaMinimoDiasUteis
    : false;

  // 3. Pre-fetch necessary data for rules (cotas e fidc)
  const toCnpjKey = (v: string | number) => String(v).replace(/\D/g, '').padStart(14, '0');
  const toKey = (v: string) => v.startsWith('TP_') ? v : toCnpjKey(v);

  const assetCnpjs = assets
    .filter(a => {
      const s = (a.section || '').toLowerCase();
      return (s === 'cotas' && a.cnpjfundo) || (s === 'fidc' && (a.cnpjemissor || a.cnpjfundo));
    })
    .map(a => {
      const s = (a.section || '').toLowerCase();
      return (s === 'cotas' ? a.cnpjfundo : (a.cnpjemissor || a.cnpjfundo)) as string;
    });

  const uniqueAssetCnpjs = [...new Set(assetCnpjs)];
  const assetIds = assets
    .filter(a => a.tipo_ativo === 'TITULO_PUBLICO' && !a.cnpjfundo)
    .map(a => `TP_${a.id}`);

  const assetCharacteristicsMap = new Map<string, any>();
  const registryNameMap = new Map<string, string>();
  const assetAdminMap = new Map<string, string>();

  const cnpjNumbers = uniqueAssetCnpjs
    .map((c) => parseInt(c.replace(/\D/g, ''), 10))
    .filter((n) => !Number.isNaN(n));

  if (uniqueAssetCnpjs.length > 0 || assetIds.length > 0) {
    const searchList = [...uniqueAssetCnpjs, ...assetIds];

    // Paralelizar todas as lookups de características
    const [
      { data: assetCharsClasse },
      { data: assetCharsFundo },
      regFundosResult,
      regClassesResult,
      targetFundRecordsResult,
    ] = await Promise.all([
      supabase
        .from('fundos_caracteristicas')
        .select('cnpj_classe, cnpj_fundo, caracteristica_investidor, nome_comercial, nivel1_categoria, nivel2_categoria, nivel3_subcategoria')
        .in('cnpj_classe', searchList)
        .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo'),
      supabase
        .from('fundos_caracteristicas')
        .select('cnpj_classe, cnpj_fundo, caracteristica_investidor, nome_comercial, nivel1_categoria, nivel2_categoria, nivel3_subcategoria')
        .in('cnpj_fundo', searchList)
        .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo'),
      cnpjNumbers.length > 0
        ? supabase.from('registro_fundo').select('cnpj_fundo, denominacao_social').in('cnpj_fundo', cnpjNumbers)
        : Promise.resolve({ data: null }),
      cnpjNumbers.length > 0
        ? supabase.from('registro_classe').select('cnpj_classe, denominacao_social').in('cnpj_classe', cnpjNumbers)
        : Promise.resolve({ data: null }),
      supabase
        .from('posicao_carteira')
        .select('fundo_cnpj, fundo_cnpjadm')
        .in('fundo_cnpj', uniqueAssetCnpjs)
        .not('fundo_cnpjadm', 'is', null)
        .order('fundo_dtposicao', { ascending: false })
        .limit(uniqueAssetCnpjs.length * 5),
    ]);

    const assetChars = [...(assetCharsClasse || []), ...(assetCharsFundo || [])];
    assetChars.forEach((char: any) => {
      if (char.cnpj_classe) assetCharacteristicsMap.set(toKey(char.cnpj_classe), char);
      if (char.cnpj_fundo && char.cnpj_fundo !== char.cnpj_classe) {
        assetCharacteristicsMap.set(toKey(char.cnpj_fundo), char);
      }
    });

    regFundosResult.data?.forEach((r: any) => {
      if (r.denominacao_social) registryNameMap.set(toCnpjKey(r.cnpj_fundo), r.denominacao_social);
    });
    regClassesResult.data?.forEach((r: any) => {
      if (r.denominacao_social) registryNameMap.set(toCnpjKey(r.cnpj_classe), r.denominacao_social);
    });

    if (targetFundRecordsResult.data?.length) {
      const seen = new Set<string>();
      targetFundRecordsResult.data.forEach((r: any) => {
        const key = toCnpjKey(r.fundo_cnpj);
        if (!seen.has(key) && r.fundo_cnpjadm) {
          seen.add(key);
          assetAdminMap.set(key, toCnpjKey(r.fundo_cnpjadm));
        }
      });
    }
  }

  const investingFundCnpjAdm = assets.find((a: any) => a.fundo_cnpjadm)?.fundo_cnpjadm
    ? toCnpjKey(assets.find((a: any) => a.fundo_cnpjadm)!.fundo_cnpjadm)
    : null;

  const nomeFromPosicao = (posicao: any): string | null => {
    if (!posicao) return null;
    const section = String(posicao.section || '').toLowerCase();
    const candidatos = [
      posicao.nomecomercial,
      posicao.nome_comercial_ativo,
      posicao.nome_ativo,
      ...(section === 'titpublico' || section === 'titprivado'
        ? [posicao.codativo, posicao.idinternoativo]
        : []),
      posicao.isin,
      posicao.codativo,
      posicao.descricao,
    ];
    for (const v of candidatos) {
      const s = String(v ?? '').trim();
      if (s) return s;
    }
    if (section === 'titpublico') return 'Título Público';
    if (section === 'titprivado') return 'Título Privado';
    return null;
  };

  const getAssetNome = (cnpj: string | null | undefined, char: any, posicao: any) =>
    char?.nome_comercial ||
    (cnpj ? registryNameMap.get(toCnpjKey(cnpj)) : null) ||
    nomeFromPosicao(posicao) ||
    (cnpj ? String(cnpj) : (posicao?.id ? `TP_${posicao.id}` : 'Ativo'));

  const isFidcNpByName = (nome: string): boolean => {
    const n = (nome || '').toUpperCase();
    return (
      n.includes(' NP ') ||
      n.endsWith(' NP') ||
      n.startsWith('NP ') ||
      n.includes('NÃO PADRONIZADO') ||
      n.includes('NAO PADRONIZADO') ||
      n.includes('NÃO-PADRONIZADO') ||
      n.includes('NAO-PADRONIZADO')
    );
  };

  const isFidcNpAsset = (cnpjKey: string, char: any): boolean => {
    const assetCat = (char?.nivel1_categoria || '').toUpperCase().replace(/\s/g, '');
    if (assetCat === 'FIDCNP') return true;
    const nome = char?.nome_comercial || registryNameMap.get(cnpjKey) || '';
    return isFidcNpByName(nome);
  };

  // 4. Execute each rule
  const relationalResults: RuleResult[] = [];
  for (const ruleAssoc of fundRules) {
    const rule = ruleAssoc.regras_compliance;
    const ruleDef = Array.isArray(rule) ? rule[0] : rule;

    if (!ruleDef) continue;

    const params = ruleDef.parametros || {};
    const tipoRegra = params.tipo_regra as string | undefined;

    if (
      tipoRegra === 'CONCENTRACAO_DEVEDOR' ||
      tipoRegra === 'CONCENTRACAO_CEDENTE' ||
      tipoRegra === 'CONCENTRACAO_SEM_COOBRIGACAO'
    ) {
      console.log(`[check-enquadramento] Skipping ${ruleDef.codigo} in relational branch; handled by rules-fidc-concentracao`);
      continue;
    }

    if (tipoRegra === 'fidc_subordinacao') {
      console.log(`[check-enquadramento] Skipping ${ruleDef.codigo} in relational branch; handled by rules-fidc-estrutura`);
      continue;
    }

    console.log(`[check-enquadramento] Checking rule ${ruleDef.codigo}`);

    // Regra: vedação
    if (params.tipo_regra === 'vedacao') {
      const tipoFundo = (params.tipo_fundo as string) || '';
      const fundosCnpj = (params.fundos_cnpj as string[] | undefined) || [];
      const categoriasVedadas = (params.categorias_vedadas as string[] | undefined) || [];
      const categoriaVedadaLegacy = ((params.categoria_vedada as string) || '').toUpperCase();
      const catsUpper = categoriasVedadas.length > 0
        ? categoriasVedadas.map((c) => c.toUpperCase())
        : (categoriaVedadaLegacy ? [categoriaVedadaLegacy] : []);

      if (catsUpper.length === 0) {
        console.log(`[check-enquadramento] Rule ${ruleDef.codigo}: No categorias_vedadas, skipping`);
        continue;
      }

      const cnpjNorm = (c: string) => String(c || '').replace(/\D/g, '').padStart(14, '0').slice(-14);
      const fundCnpjNorm = cnpjNorm(fund.fundo_cnpj);
      let fundApplies = false;
      if (tipoFundo) {
        const tipoUpper = tipoFundo.toUpperCase();
        fundApplies = !!fundOwnNivel1 && (fundOwnNivel1 === tipoUpper || (tipoUpper === 'FIDC' && fundOwnNivel1 === 'FIDC NP'));
      }
      if (!fundApplies && fundosCnpj.length > 0) {
        fundApplies = fundosCnpj.some((cnpj) => cnpjNorm(cnpj) === fundCnpjNorm);
      }
      if (!fundApplies) {
        console.log(`[check-enquadramento] Rule ${ruleDef.codigo}: Fund ${fund.fundo_cnpj} does not match tipo_fundo or fundos_cnpj, skipping`);
        continue;
      }

      const matchingAssets = assets.filter(a => {
        if (a.section !== 'cotas' || !a.cnpjfundo) return false;
        const char = assetCharacteristicsMap.get(toKey(a.cnpjfundo));
        const assetCat = (char?.nivel1_categoria || '').toUpperCase();
        return char && catsUpper.some((cat) => assetCat === cat || (cat === 'FIDC' && assetCat === 'FIDC NP'));
      });

      const totalValue = matchingAssets.reduce((sum, a) => sum + (a.valor_padrao || 0), 0);
      const percentage = patliq > 0 ? totalValue / patliq : 0;

      const catLabel = catsUpper.join(', ');
      console.log(`[check-enquadramento] Rule ${ruleDef.codigo}: ${tipoFundo || 'fundos'} has ${matchingAssets.length} cotas vedadas (${catLabel}), total=${totalValue}, %=${percentage}`);

      const status: RuleStatus = percentage > 0 ? 'violacao' : 'ok';

      relationalResults.push({
        regra_codigo: ruleDef.codigo,
        regra_descricao: ruleDef.descricao,
        status,
        valor_atual: percentage,
        valor_limite: 0,
        detalhes: {
          total_investido: totalValue,
          ...patliqDetalhes,
          tipo_fundo: tipoFundo || null,
          fundos_cnpj: fundosCnpj.length ? fundosCnpj : null,
          categorias_vedadas: catsUpper,
          ativos_vedados: matchingAssets.map(a => ({
            nome: getAssetNome(a.cnpjfundo, assetCharacteristicsMap.get(toKey(a.cnpjfundo || `TP_${a.id}`)), a),
            cnpj: a.cnpjfundo,
            valor: a.valor_padrao,
            nivel1_categoria: assetCharacteristicsMap.get(toKey(a.cnpjfundo || `TP_${a.id}`))?.nivel1_categoria
          }))
        }
      });
      continue;
    }

    // Regra: percentual PL por categoria
    if (params.tipo_regra === 'percentual_pl_por_categoria') {
      const norm = (v: number) => (v >= 2 ? v / 100 : v);
      let limiteMin = params.limite_min != null ? Number(params.limite_min) : null;
      let limiteMax = params.limite_max != null ? Number(params.limite_max) : (params.limite != null ? Number(params.limite) : null);
      if (limiteMin != null && !Number.isNaN(limiteMin)) limiteMin = norm(limiteMin);
      if (limiteMax != null && !Number.isNaN(limiteMax)) limiteMax = norm(limiteMax);

      const segmentos = (params.segmentos as string[] | undefined) || [];
      const nivel1_categorias = (params.nivel1_categorias as string[] | undefined) || [];
      const section_carteiras = (params.section_carteiras as string[] | undefined) || [];
      const sectionCarteira = (params.section_carteira as string) || '';
      const segmento = (params.segmento as string) || '';
      // Filtro granular de provisão para a section "outros": apenas registros com esses codprov e credeb=C
      const outrosProvisaoCodprov: string[] = (params.outros_provisao_codprov as string[] | undefined) || [];
      let targetCategoria: string;
      let targetCatUpper = '';
      let matchingAssets: typeof assets;

      const isExterior = (char: any) => {
        const n2 = String(char?.nivel2_categoria || '');
        const n3 = String(char?.nivel3_subcategoria || '');
        const combined = `${n2} ${n3}`.toLowerCase();
        if (!combined.includes('>')) return false;
        return combined.includes('exterior');
      };

      const MAIN_SECTIONS = ['cotas', 'titpublico', 'titprivado', 'participacoes', 'acoes', 'imoveis', 'fidc', 'caixa'];

      if (segmentos.length > 0) {
        const matchedIds = new Set<string>();
        const allMatching: typeof assets = [];

        if (segmentos.includes('cotas')) {
          const cats = nivel1_categorias.length > 0 ? nivel1_categorias : ['Cotas'];
          const catUpperSet = new Set(cats.map((c) => c.toUpperCase().replace(/\s/g, '')));
          for (const a of assets) {
            const s = (a.section || '').toLowerCase();
            if (s === 'fidc' && (catUpperSet.has('FIDC') || catUpperSet.has('FIDCNP'))) {
              const aid = a.id || `${a.cnpjemissor || a.cnpjfundo}-${a.valor_padrao}`;
              if (!matchedIds.has(aid)) { matchedIds.add(aid); allMatching.push(a); }
              continue;
            }
            if (s !== 'cotas') continue;
            const aid = a.id || `${a.cnpjfundo}-${a.valor_padrao}`;
            if (matchedIds.has(aid)) continue;
            if (catUpperSet.has('COTAS')) { matchedIds.add(aid); allMatching.push(a); continue; }
            if (!a.cnpjfundo) continue;
            const cnpjKey = toKey(a.cnpjfundo);
            const char = assetCharacteristicsMap.get(cnpjKey);
            const assetCat = (char?.nivel1_categoria || '').toUpperCase().replace(/\s/g, '');
            let match = catUpperSet.has(assetCat) || (catUpperSet.has('FIDC') && assetCat === 'FIDCNP');
            if (!match && catUpperSet.has('FIDCNP') && isFidcNpAsset(cnpjKey, char)) match = true;
            if (!match && (catUpperSet.has('EXTERIOR') || catUpperSet.has('INVESTIMENTONOEXTERIOR')) && char && isExterior(char)) match = true;
            if (match) { matchedIds.add(aid); allMatching.push(a); }
          }
        }
        if (segmentos.includes('ativos_financeiros') && section_carteiras.length > 0) {
          const secSet = new Set(section_carteiras.map((s) => s.toLowerCase()));
          // 'outros' é um wildcard (não-MAIN_SECTIONS): deve ser verificado APÓS as seções explícitas
          // para não engolir assets de seções como titprivado/fidc quando ambas estão selecionadas.
          const hasOutros = secSet.has('outros');
          const explicitSecs = new Set([...secSet].filter(s => s !== 'outros'));

          for (const a of assets) {
            const aid = a.id || `${a.cnpjfundo}-${a.valor_padrao}`;
            if (matchedIds.has(aid)) continue;
            const s = (a.section || '').toLowerCase();

            if (explicitSecs.has(s)) {
              // Seção explicitamente selecionada (titprivado, fidc, titpublico, etc.)
              matchedIds.add(aid); allMatching.push(a);
            } else if (hasOutros) {
              // Wildcard 'outros': inclui tudo fora de MAIN_SECTIONS (ou codprov específico)
              if (outrosProvisaoCodprov.length > 0) {
                if (s === 'provisao' && a.credeb === 'C' && outrosProvisaoCodprov.includes(String(a.codprov ?? ''))) {
                  matchedIds.add(aid); allMatching.push(a);
                }
              } else if (s && !MAIN_SECTIONS.includes(s)) {
                matchedIds.add(aid); allMatching.push(a);
              }
            }
          }
        }
        matchingAssets = allMatching;
        targetCategoria = [
          ...(segmentos.includes('cotas') ? (nivel1_categorias.length > 0 ? nivel1_categorias : ['Cotas']) : []),
          ...(segmentos.includes('ativos_financeiros') ? section_carteiras : []),
        ].join(', ');
      } else if (segmento === 'ativos_financeiros' && sectionCarteira) {
        targetCategoria = sectionCarteira;
        const sec = sectionCarteira.toLowerCase();
        if (sec === 'outros') {
          matchingAssets = assets.filter(a => {
            const s = (a.section || '').toLowerCase();
            if (outrosProvisaoCodprov.length > 0) {
              return s === 'provisao' && a.credeb === 'C' && outrosProvisaoCodprov.includes(String(a.codprov ?? ''));
            }
            return s && !MAIN_SECTIONS.includes(s);
          });
        } else {
          matchingAssets = assets.filter(a => (a.section || '').toLowerCase() === sec);
        }
      } else {
        targetCategoria = (params.nivel1_categoria as string) || 'FIDC';
        targetCatUpper = targetCategoria.toUpperCase().replace(/\s/g, '');
        matchingAssets = targetCatUpper === 'COTAS'
          ? assets.filter(a => (a.section || '').toLowerCase() === 'cotas')
          : targetCatUpper === 'TÍTULOPÚBLICO' || targetCatUpper === 'TITULOPUBLICO'
          ? assets.filter(a => (a.section || '').toLowerCase() === 'titpublico')
          : targetCatUpper === 'TÍTULOPRIVADO' || targetCatUpper === 'TITULOPRIVADO' || targetCatUpper === 'RENDAFIXA'
          ? assets.filter(a => (a.section || '').toLowerCase() === 'titprivado')
          : targetCatUpper === 'EXTERIOR' || targetCatUpper === 'INVESTIMENTONOEXTERIOR'
          ? assets.filter(a => {
              if ((a.section || '').toLowerCase() !== 'cotas' || !a.cnpjfundo) return false;
              const char = assetCharacteristicsMap.get(toKey(a.cnpjfundo));
              return char && isExterior(char);
            })
          : (targetCatUpper === 'FIDC' || targetCatUpper === 'FIDCNP')
          ? assets.filter(a => {
              const s = (a.section || '').toLowerCase();
              if (s === 'fidc') return true;
              if (s === 'cotas' && a.cnpjfundo) {
                const cnpjKey = toKey(a.cnpjfundo);
                const char = assetCharacteristicsMap.get(cnpjKey);
                const assetCat = (char?.nivel1_categoria || '').toUpperCase().replace(/\s/g, '');
                if (assetCat === targetCatUpper || (targetCatUpper === 'FIDC' && assetCat === 'FIDCNP')) return true;
                if (targetCatUpper === 'FIDCNP') return isFidcNpAsset(cnpjKey, char);
                return false;
              }
              const key = a.cnpjfundo || a.cnpjemissor || (a.tipo_ativo === 'TITULO_PUBLICO' ? `TP_${a.id}` : null);
              if (key) {
                const cnpjKey = toKey(key);
                const char = assetCharacteristicsMap.get(cnpjKey);
                const assetCat = (char?.nivel1_categoria || '').toUpperCase().replace(/\s/g, '');
                if (assetCat === targetCatUpper || (targetCatUpper === 'FIDC' && assetCat === 'FIDCNP')) return true;
                if (targetCatUpper === 'FIDCNP') return isFidcNpAsset(cnpjKey, char);
              }
              return false;
            })
          : assets.filter(a => {
              if ((a.section || '').toLowerCase() === 'cotas' && a.cnpjfundo) {
                const char = assetCharacteristicsMap.get(toKey(a.cnpjfundo));
                const assetCat = (char?.nivel1_categoria || '').toUpperCase().replace(/\s/g, '');
                if (assetCat === targetCatUpper) return true;
                if (targetCatUpper === 'FIDC' && assetCat === 'FIDCNP') return true;
                return false;
              }
              const key = a.cnpjfundo || (a.tipo_ativo === 'TITULO_PUBLICO' ? `TP_${a.id}` : null);
              if (key) {
                const char = assetCharacteristicsMap.get(toKey(key));
                const assetCat = (char?.nivel1_categoria || '').toUpperCase().replace(/\s/g, '');
                return assetCat === targetCatUpper;
              }
              return false;
            });
      }

      const totalValue = matchingAssets.reduce((sum, a) => sum + (a.valor_padrao || 0), 0);
      const percentage = patliq > 0 ? totalValue / patliq : 0;

      console.log(`[check-enquadramento] Rule ${ruleDef.codigo}: ${matchingAssets.length} matching assets (${targetCategoria}), total=${totalValue}, %=${percentage}, min=${limiteMin}, max=${limiteMax}`);

      let status: RuleStatus = 'ok';
      const valor_limite = limiteMax ?? limiteMin ?? 0;
      const limiteEh100 = limiteMax != null && Math.abs(limiteMax - 1) < 0.001;
      const regraMin67FiiFidc = isRegraMin67FiiFidc(targetCategoria, limiteMin, ruleDef.codigo);
      const regraMinAlocFidcContadores = isRegraMinAlocacaoFidcComContadores(
        targetCategoria,
        limiteMin,
        ruleDef.codigo,
      );
      const violouMinimo = limiteMin != null && percentage < limiteMin;
      const violacaoMinimoBloqueia = violouMinimo && !(regraMin67FiiFidc && emCarenciaIntegralizacao);
      if (limiteMax != null && percentage > limiteMax && !limiteEh100) status = 'violacao';
      else if (violacaoMinimoBloqueia) status = 'violacao';

      let eventos_12m: number | undefined;
      let dias_violacao_12m: number | undefined;
      let maxEventos12m: number | undefined;
      if (regraMinAlocFidcContadores) {
        maxEventos12m = resolveMaxEventosMinAloc12m(limiteMin);
        const { fromYmd, toYmd } = rolling12mBoundsYmd(fund.fundo_dtposicao);
        const serie = await carregarSerieMinAloc12m(
          fund.fundo_cnpj,
          cleanCnpj,
          fund.fundo_isin,
          ruleDef.codigo,
          fromYmd,
          toYmd,
        );
        const dtAtual = fund.fundo_dtposicao.replace(/\D/g, '').slice(0, 8);
        const contadores = calcularContadoresMinAloc12m(serie, dtAtual, status);
        eventos_12m = contadores.eventos_12m;
        dias_violacao_12m = contadores.dias_violacao_12m;
        if (
          eventos_12m >= maxEventos12m! ||
          dias_violacao_12m >= MIN_ALOC_MAX_DIAS_VIOLACAO_12M
        ) {
          status = 'violacao';
        }
      }

      const sectionToLabel: Record<string, string> = {
        titpublico: 'Título Público',
        titprivado: 'Título Privado',
        participacoes: 'Participações',
        acoes: 'Ações',
        imoveis: 'Imóveis',
        fidc: 'FIDC (ativos)',
        caixa: 'Caixa',
        outros: 'Outros',
      };
      relationalResults.push({
        regra_codigo: ruleDef.codigo,
        regra_descricao: ruleDef.descricao,
        status,
        valor_atual: percentage,
        valor_limite,
        detalhes: {
          total_investido: totalValue,
          ...patliqDetalhes,
          categoria_alvo: segmento === 'ativos_financeiros' ? (sectionToLabel[sectionCarteira?.toLowerCase()] || targetCategoria) : targetCategoria,
          limite_min: limiteMin,
          limite_max: limiteMax,
          regra_min_67_fii_fidc: regraMin67FiiFidc,
          regra_min_alocacao_fidc: regraMinAlocFidcContadores,
          regra_cotas_50_art_caput: isRegraMin50CotasFidc(limiteMin),
          ...(eventos_12m != null
            ? {
                eventos_12m,
                dias_violacao_12m,
                max_eventos_12m: maxEventos12m ?? MIN_ALOC_MAX_EVENTOS_12M,
                max_dias_violacao_12m: MIN_ALOC_MAX_DIAS_VIOLACAO_12M,
              }
            : {}),
          data_inicio_atividade: (fundChar as any)?.data_inicio_atividade ?? null,
          dias_uteis_desde_inicio_atividade: diasUteisDesdeInicio,
          carencia_dias_uteis_minimo_alocacao: regraMin67FiiFidc ? carenciaMinimoDiasUteis : null,
          em_carencia_minimo_alocacao: regraMin67FiiFidc ? emCarenciaIntegralizacao : null,
          violacao_min_suprimida_por_carencia: regraMin67FiiFidc ? (violouMinimo && emCarenciaIntegralizacao) : null,
          ativos_contabilizados: matchingAssets.map(a => {
            const cnpjKey = a.cnpjfundo || a.cnpjemissor;
            const section = (a.section || '').toLowerCase();
            let catLabel = assetCharacteristicsMap.get(toKey(cnpjKey || `TP_${a.id}`))?.nivel1_categoria;
            if (segmento === 'ativos_financeiros') {
              catLabel = sectionToLabel[section] || section || catLabel;
            } else if (targetCatUpper === 'EXTERIOR' || targetCatUpper === 'INVESTIMENTONOEXTERIOR') {
              catLabel = 'Investimento no Exterior';
            } else if (section === 'fidc') catLabel = catLabel || 'FIDC';
            else if (section === 'titprivado') catLabel = catLabel || 'Título Privado';
            else if (section === 'titpublico') catLabel = catLabel || 'Título Público';
            else if (a.cnpjfundo) catLabel = catLabel || 'Cotas';
            return {
              nome: getAssetNome(cnpjKey, assetCharacteristicsMap.get(toKey(cnpjKey || `TP_${a.id}`)), a),
              cnpj: cnpjKey,
              valor: a.valor_padrao,
              percentual: patliq > 0 ? (a.valor_padrao || 0) / patliq : 0,
              nivel1_categoria: catLabel
            };
          })
        }
      });
      continue;
    }

    // Regras exclusivas do motor pré-trade (elegibilidade de cessão) — não avaliadas aqui
    if (tipoRegra === 'CESSAO_CONDICAO') {
      console.log(`[check-enquadramento] Skipping ${ruleDef.codigo} — CESSAO_CONDICAO é exclusiva do motor pré-trade (validar-cessao-elegibilidade)`);
      continue;
    }

    // Regra: agrupamento conjunto (soma de múltiplas exposições)
    if (tipoRegra === 'agrupamento_conjunto') {
      const limiteMax = params.limite_max != null ? Number(params.limite_max) : 0.40;
      const metodoAgregacao = (params.metodo_agregacao as string) || 'soma';
      const modo = (params.modo as string) || 'por_componentes';

      console.log(`[check-enquadramento] Processing ${ruleDef.codigo} with mode=${modo}`);

      // Map para armazenar ativos únicos (deduplicação)
      const exposicoes = new Map<string, { ativo: any; valor: number }>();
      let componentes: any[] = [];

      if (modo === 'por_regras') {
        // Modo: Selecionar Regras Existentes
        const regrasCodigos = (params.regras_base as string[]) || [];
        console.log(`[check-enquadramento] Loading ${regrasCodigos.length} base rules: ${regrasCodigos.join(', ')}`);

        // Buscar as regras base
        const { data: regrasBase, error: regrasError } = await supabase
          .from('regras_compliance')
          .select('*')
          .in('codigo', regrasCodigos);

        if (regrasError) {
          console.error(`[check-enquadramento] Error loading base rules:`, regrasError);
          continue;
        }

        if (!regrasBase || regrasBase.length === 0) {
          console.log(`[check-enquadramento] No base rules found for ${ruleDef.codigo}`);
          continue;
        }

        // Processar cada regra base e extrair seus ativos
        for (const regraBase of regrasBase) {
          const baseParams = regraBase.parametros as Record<string, unknown>;
          const baseTipoRegra = baseParams.tipo_regra as string;

          let matchingAssets: typeof assets = [];

          // Processar baseado no tipo da regra base
          if (baseTipoRegra === 'limite_por_tipo_investidor') {
            const targetType = (baseParams.tipo_investidor as string) || 'Profissional';
            const targetCategoria = baseParams.nivel1_categoria as string | undefined;
            matchingAssets = assets.filter((a: any) => {
              if (a.section !== 'cotas' || !a.cnpjfundo) return false;
              const cnpjKey = toKey(a.cnpjfundo);
              const char = assetCharacteristicsMap.get(cnpjKey);
              if (!char || char.caracteristica_investidor !== targetType) return false;
              if (targetCategoria) {
                const assetCat = (char.nivel1_categoria || '').toUpperCase();
                const targetCatUpper = targetCategoria.toUpperCase().replace(/\s/g, '');
                const assetCatNorm = assetCat.replace(/\s/g, '');
                if (assetCatNorm !== targetCatUpper && !(targetCatUpper === 'FIDC' && assetCatNorm === 'FIDCNP')) {
                  return false;
                }
              }
              return true;
            });
          } else if (baseTipoRegra === 'percentual_pl_por_categoria') {
            const nivel1Categoria = baseParams.nivel1_categoria as string | undefined;
            if (nivel1Categoria) {
              const targetCatUpper = nivel1Categoria.toUpperCase().replace(/\s/g, '');
              matchingAssets = assets.filter((a: any) => {
                const s = (a.section || '').toLowerCase();
                if (s === 'fidc' && (targetCatUpper === 'FIDC' || targetCatUpper === 'FIDCNP')) {
                  return true;
                }
                if (s === 'cotas' && a.cnpjfundo) {
                  const cnpjKey = toKey(a.cnpjfundo);
                  const char = assetCharacteristicsMap.get(cnpjKey);
                  const assetCat = (char?.nivel1_categoria || '').toUpperCase().replace(/\s/g, '');
                  if (assetCat === targetCatUpper) return true;
                  if (targetCatUpper === 'FIDC' && assetCat === 'FIDCNP') return true;
                  if (targetCatUpper === 'FIDCNP' && isFidcNpAsset(cnpjKey, char)) return true;
                }
                return false;
              });
            }
          }

          // Adicionar ao mapa (deduplicação)
          for (const asset of matchingAssets) {
            const assetId = asset.id || `${asset.cnpjfundo || asset.cnpjemissor}-${asset.valor_padrao}`;
            if (!exposicoes.has(assetId)) {
              exposicoes.set(assetId, {
                ativo: asset,
                valor: asset.valor_padrao || 0
              });
            }
          }
        }

        // Criar componentes para o breakdown (baseado nas regras)
        componentes = regrasBase.map(r => ({
          tipo: 'regra',
          valor: r.codigo,
          regra_descricao: r.descricao
        }));

      } else {
        // Modo: Criar Componentes Manualmente (lógica original)
        componentes = (params.componentes as any[]) || [];

        console.log(`[check-enquadramento] Processing ${componentes.length} manual components`);

        // Processar cada componente
      for (const comp of componentes) {
        const compTipo = comp.tipo as string;
        const compValor = comp.valor as string;
        let matchingAssets: typeof assets = [];

        if (compTipo === 'tipo_investidor') {
          // Filtrar por tipo de investidor
          matchingAssets = assets.filter((a: any) => {
            if (a.section !== 'cotas' || !a.cnpjfundo) return false;
            const cnpjKey = toKey(a.cnpjfundo);
            const char = assetCharacteristicsMap.get(cnpjKey);
            return char && char.caracteristica_investidor === compValor;
          });
        } else if (compTipo === 'cotas' || compTipo === 'categoria') {
          // Filtrar por categoria (cotas de fundos)
          const targetCatUpper = compValor.toUpperCase().replace(/\s/g, '');
          matchingAssets = assets.filter((a: any) => {
            const s = (a.section || '').toLowerCase();
            if (s === 'fidc' && (targetCatUpper === 'FIDC' || targetCatUpper === 'FIDCNP')) {
              return true;
            }
            if (s === 'cotas' && a.cnpjfundo) {
              const cnpjKey = toKey(a.cnpjfundo);
              const char = assetCharacteristicsMap.get(cnpjKey);
              const assetCat = (char?.nivel1_categoria || '').toUpperCase().replace(/\s/g, '');
              if (assetCat === targetCatUpper) return true;
              if (targetCatUpper === 'FIDC' && assetCat === 'FIDCNP') return true;
              if (targetCatUpper === 'FIDCNP' && isFidcNpAsset(cnpjKey, char)) return true;
              return false;
            }
            return false;
          });
        } else if (compTipo === 'ativos_financeiros' || compTipo === 'secao_carteira') {
          // Filtrar por seção de carteira (ativos financeiros diretos)
          const targetSection = compValor.toLowerCase();
          if (targetSection === 'outros') {
            const MAIN_SECTIONS = ['cotas', 'titpublico', 'titprivado', 'participacoes', 'acoes', 'imoveis', 'fidc', 'caixa'];
            matchingAssets = assets.filter((a: any) => {
              const s = (a.section || '').toLowerCase();
              return s && !MAIN_SECTIONS.includes(s);
            });
          } else {
            matchingAssets = assets.filter((a: any) => (a.section || '').toLowerCase() === targetSection);
          }
        }

        // Adicionar ao mapa (deduplicação automática por ID do ativo)
        for (const asset of matchingAssets) {
          const assetId = asset.id || `${asset.cnpjfundo || asset.cnpjemissor}-${asset.valor_padrao}`;
          if (!exposicoes.has(assetId)) {
            exposicoes.set(assetId, {
              ativo: asset,
              valor: asset.valor_padrao || 0
            });
          }
        }
      }
      } // Fim do else (modo por_componentes)

      // Calcular total baseado no método de agregação
      let totalExposicao = 0;
      if (metodoAgregacao === 'soma') {
        totalExposicao = Array.from(exposicoes.values()).reduce((sum, item) => sum + item.valor, 0);
      } else if (metodoAgregacao === 'maximo') {
        totalExposicao = Math.max(...Array.from(exposicoes.values()).map(item => item.valor), 0);
      }

      const percentualConjunto = patliq > 0 ? totalExposicao / patliq : 0;
      
      // Sistema de alerta: amarelo se estiver a 2% do limite
      const margemAlerta = 0.02; // 2 pontos percentuais
      const status = statusLimiteMaximo(percentualConjunto, limiteMax, margemAlerta);

      console.log(`[check-enquadramento] Rule ${ruleDef.codigo}: ${exposicoes.size} unique assets, total=${totalExposicao}, %=${percentualConjunto}, limit=${limiteMax}, status=${status}`);

      // Calcular breakdown por componente
      const componentesBreakdown = componentes.map((comp: any) => {
        let compExposicao = 0;
        let compAtivos = 0;

        // Para tipo "regra" (modo por_regras), não precisamos recalcular, pois já foi processado
        if (comp.tipo === 'regra') {
          // Não há cálculo individual por regra, apenas mostrar no breakdown
          return {
            tipo: comp.tipo,
            valor: comp.valor,
            regra_descricao: comp.regra_descricao,
            exposicao_valor: 0,  // Não calculado individualmente no modo por_regras
            exposicao_percentual: 0,
            ativos_count: 0
          };
        }

        // Recalcular para este componente específico (modo por_componentes)
        const compMatchingAssets: any[] = [];
        if (comp.tipo === 'tipo_investidor') {
          for (const item of exposicoes.values()) {
            const a = item.ativo;
            if (a.section === 'cotas' && a.cnpjfundo) {
              const char = assetCharacteristicsMap.get(toKey(a.cnpjfundo));
              if (char?.caracteristica_investidor === comp.valor) {
                compMatchingAssets.push(item);
              }
            }
          }
        } else if (comp.tipo === 'cotas' || comp.tipo === 'categoria') {
          const targetCatUpper = (comp.valor as string).toUpperCase().replace(/\s/g, '');
          for (const item of exposicoes.values()) {
            const a = item.ativo;
            const s = (a.section || '').toLowerCase();
            if (s === 'fidc' && (targetCatUpper === 'FIDC' || targetCatUpper === 'FIDCNP')) {
              compMatchingAssets.push(item);
              continue;
            }
            if (s === 'cotas' && a.cnpjfundo) {
              const char = assetCharacteristicsMap.get(toKey(a.cnpjfundo));
              const assetCat = (char?.nivel1_categoria || '').toUpperCase().replace(/\s/g, '');
              if (assetCat === targetCatUpper || (targetCatUpper === 'FIDC' && assetCat === 'FIDCNP')) {
                compMatchingAssets.push(item);
              }
            }
          }
        } else if (comp.tipo === 'ativos_financeiros' || comp.tipo === 'secao_carteira') {
          const targetSection = (comp.valor as string).toLowerCase();
          if (targetSection === 'outros') {
            const MAIN_SECTIONS = ['cotas', 'titpublico', 'titprivado', 'participacoes', 'acoes', 'imoveis', 'fidc', 'caixa'];
            for (const item of exposicoes.values()) {
              const a = item.ativo;
              const s = (a.section || '').toLowerCase();
              if (s && !MAIN_SECTIONS.includes(s)) {
                compMatchingAssets.push(item);
              }
            }
          } else {
            for (const item of exposicoes.values()) {
              const a = item.ativo;
              if ((a.section || '').toLowerCase() === targetSection) {
                compMatchingAssets.push(item);
              }
            }
          }
        }

        compExposicao = compMatchingAssets.reduce((sum, item) => sum + item.valor, 0);
        compAtivos = compMatchingAssets.length;

        return {
          tipo: comp.tipo,
          valor: comp.valor,
          exposicao_valor: compExposicao,
          exposicao_percentual: patliq > 0 ? compExposicao / patliq : 0,
          ativos_count: compAtivos
        };
      });

      relationalResults.push({
        regra_codigo: ruleDef.codigo,
        regra_descricao: ruleDef.descricao,
        status,
        valor_atual: percentualConjunto,
        valor_limite: limiteMax,
        detalhes: {
          total_investido: totalExposicao,
          ...patliqDetalhes,
          metodo_agregacao: metodoAgregacao,
          componentes_count: componentes.length,
          componentes_breakdown: componentesBreakdown,
          ativos_unicos_count: exposicoes.size,
          parametros: params, // Adicionar parâmetros para recalcular descrição no frontend
          ativos_contabilizados: Array.from(exposicoes.values()).map(item => {
            const a = item.ativo;
            const cnpjKey = a.cnpjfundo || a.cnpjemissor;
            return {
              nome: getAssetNome(cnpjKey, assetCharacteristicsMap.get(toKey(cnpjKey || `TP_${a.id}`)), a),
              cnpj: cnpjKey,
              valor: item.valor,
              percentual: patliq > 0 ? item.valor / patliq : 0,
              nivel1_categoria: assetCharacteristicsMap.get(toKey(cnpjKey || `TP_${a.id}`))?.nivel1_categoria
            };
          })
        }
      });
      continue;
    }

    // Guarda: somente processa limite_por_tipo_investidor a partir daqui
    if (tipoRegra !== 'limite_por_tipo_investidor') {
      console.log(`[check-enquadramento] tipo_regra desconhecido ignorado: ${tipoRegra} (regra ${ruleDef.codigo})`);
      continue;
    }

    // Regra: limite por tipo de investidor
    let limitParam = Number(params.limite);
    if (Number.isNaN(limitParam)) limitParam = 0.10;
    if (limitParam > 1) limitParam /= 100;
    const targetType = (params.tipo_investidor as string) || 'Profissional';
    const targetCategoria = params.nivel1_categoria as string | undefined;
    const mesmaAdministradora = params.mesma_administradora === true;

    const matchingAssets = assets.filter((a: any) => {
      if (a.section !== 'cotas' || !a.cnpjfundo) return false;
      const cnpjKey = toKey(a.cnpjfundo);
      const char = assetCharacteristicsMap.get(cnpjKey);
      if (!char || char.caracteristica_investidor !== targetType) return false;
      if (targetCategoria) {
        const assetCat = (char.nivel1_categoria || '').toUpperCase();
        const targetCatUpper = targetCategoria.toUpperCase().replace(/\s/g, '');
        const assetCatNorm = assetCat.replace(/\s/g, '');
        if (assetCatNorm === targetCatUpper) {
          // direct match
        } else if (targetCatUpper === 'FIDC' && assetCatNorm === 'FIDCNP') {
          // FIDC rule also matches FIDC NP
        } else if (targetCatUpper === 'FIDCNP' && isFidcNpAsset(cnpjKey, char)) {
          // FIDC NP rule: fallback by fund name
        } else {
          return false;
        }
      }
      if (mesmaAdministradora) {
        if (!investingFundCnpjAdm) return false;
        const targetAdm = assetAdminMap.get(cnpjKey);
        if (!targetAdm || targetAdm !== investingFundCnpjAdm) return false;
      }
      return true;
    });

    const totalValue = matchingAssets.reduce((sum: number, a: any) => sum + (a.valor_padrao || 0), 0);
    const percentage = patliq > 0 ? totalValue / patliq : 0;

    console.log(`[check-enquadramento] Rule ${ruleDef.codigo}: ${matchingAssets.length} matching assets (${targetType}${targetCategoria ? ` + ${targetCategoria}` : ''}${mesmaAdministradora ? ' + mesma_adm' : ''}), total=${totalValue}, %=${percentage}`);

    // Sistema de alerta: amarelo se estiver a 2% do limite
    const margemAlerta = 0.02; // 2 pontos percentuais
    const status = statusLimiteMaximo(percentage, limitParam, margemAlerta);

    relationalResults.push({
      regra_codigo: ruleDef.codigo,
      regra_descricao: ruleDef.descricao,
      status,
      valor_atual: percentage,
      valor_limite: limitParam,
      detalhes: {
        total_investido: totalValue,
        ...patliqDetalhes,
        tipo_alvo: targetType,
        categoria_alvo: targetCategoria || null,
        mesma_administradora: mesmaAdministradora,
        cnpjadm_fundo_investidor: investingFundCnpjAdm || null,
        ativos_contabilizados: matchingAssets.map((a: any) => ({
          nome: getAssetNome(a.cnpjfundo, assetCharacteristicsMap.get(toKey(a.cnpjfundo)), a),
          cnpj: a.cnpjfundo,
          valor: a.valor_padrao,
          percentual: patliq > 0 ? (a.valor_padrao || 0) / patliq : 0,
          tipo_investidor: assetCharacteristicsMap.get(toKey(a.cnpjfundo))?.caracteristica_investidor,
          nivel1_categoria: assetCharacteristicsMap.get(toKey(a.cnpjfundo))?.nivel1_categoria,
          cnpjadm: assetAdminMap.get(toKey(a.cnpjfundo)) || null,
        }))
      }
    });
  }

  // Save results
  if (relationalResults.length > 0) {
    console.log(`[check-enquadramento] Saving ${relationalResults.length} relational results for fund ${fund.fundo_cnpj}`);
    const records = relationalResults.map((r) => ({
      fundo_cnpj: fund.fundo_cnpj,
      fundo_isin: fund.fundo_isin,
      fundo_dtposicao: fund.fundo_dtposicao,
      regra_categoria: 'relacional',
      regra_codigo: r.regra_codigo,
      regra_descricao: r.regra_descricao,
      status: r.status,
      valor_atual: r.valor_atual,
      valor_limite: r.valor_limite,
      detalhes: r.detalhes || null,
    }));

    const { error: saveError } = await supabase
      .from('enquadramento_resultado')
      .upsert(records, {
        onConflict: 'fundo_cnpj,fundo_isin,fundo_dtposicao,regra_codigo',
      });

    if (saveError) {
      console.error('[check-enquadramento] Error saving relational results:', saveError);
    }
  }

  return relationalResults;
}

// ─── Process a single category for a fund via external Edge Function ──────────

interface CategoryResult {
  category: string;
  results: RuleResult[];
  error?: string;
}

async function processExternalCategory(
  fund: { fundo_cnpj: string; fundo_isin: string; fundo_dtposicao: string },
  category: string,
  fnBaseUrl: string,
  serviceKey: string,
): Promise<CategoryResult> {
  const functionName = `rules-${category}`;
  console.log(`[check-enquadramento] Invoking ${functionName} for fund ${fund.fundo_cnpj} isin=${fund.fundo_isin || '(none)'}`);

  const functionUrl = `${fnBaseUrl}/functions/v1/${functionName}`;
  const response = await fetch(functionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${serviceKey}`,
      'apikey': serviceKey,
    },
    body: JSON.stringify({
      fundo_cnpj: fund.fundo_cnpj,
      fundo_isin: fund.fundo_isin || undefined,
      fundo_dtposicao: fund.fundo_dtposicao,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[check-enquadramento] Error calling ${functionName}: status ${response.status}. Body: ${errorText}`);
    return { category, results: [], error: `HTTP ${response.status}: ${errorText.slice(0, 200)}` };
  }

  const data: RuleCheckResponse = await response.json();
  if (data?.success && data.results) {
    return { category, results: data.results };
  }
  return { category, results: [], error: data?.error || 'Resposta sem success=true' };
}

// ─── Process all categories for a single fund (in parallel) ──────────────────

interface FundProcessResult {
  results: RuleResult[];
  failedCategories: string[];
}

async function processFund(
  fund: { fundo_cnpj: string; fundo_isin: string; fundo_dtposicao: string },
  categories: string[],
  fnBaseUrl: string,
  serviceKey: string,
): Promise<FundProcessResult> {
  const categoryPromises = categories.map(async (category): Promise<CategoryResult> => {
    try {
      if (category === 'relational') {
        return { category, results: await processRelationalCategory(fund) };
      }
      return await processExternalCategory(fund, category, fnBaseUrl, serviceKey);
    } catch (err) {
      console.error(`[check-enquadramento] Error processing category ${category} for fund ${fund.fundo_cnpj} isin=${fund.fundo_isin || '(none)'}:`, err);
      return { category, results: [], error: err instanceof Error ? err.message : 'Erro desconhecido' };
    }
  });

  const settled = await Promise.allSettled(categoryPromises);
  const allResults: RuleResult[] = [];
  const failedCategories: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled') {
      allResults.push(...result.value.results);
      if (result.value.error) {
        failedCategories.push(`${categories[i]}: ${result.value.error}`);
      }
    } else {
      failedCategories.push(`${categories[i]}: ${result.reason}`);
    }
  }
  return { results: allResults, failedCategories };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Edge Function: check-enquadramento
 *
 * Orchestrator that coordinates the execution of all rule categories.
 * Processes all funds and categories in parallel to avoid timeout.
 *
 * Request body:
 * - fundo_cnpj: (optional) specific fund CNPJ
 * - fundo_dtposicao: (optional) specific date in YYYYMMDD format
 * - categories: (optional) array of categories to check ['pl', 'concentration', 'liquidity']
 */
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    let body: CheckEnquadramentoRequest;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: 'Request body inválido ou ausente. Envie JSON válido.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const { fundo_cnpj, fundo_isin, fundo_dtposicao, categories = ['pl', 'classe', 'relational', 'fidc-concentracao', 'fidc-estrutura', 'tributario', 'tributario-art4', 'tributario-art4-fidc'] } = body;

    console.log('[check-enquadramento] Starting check with params:', { fundo_cnpj, fundo_isin, fundo_dtposicao, categories });

    // Determine which funds to check
    let fundsToCheck: Array<{ fundo_cnpj: string; fundo_isin: string; fundo_dtposicao: string }> = [];

    /** Deduplicates (cnpj, isin) pairs from posicao_carteira rows */
    function deduplicateFundPairs(
      rows: Array<{ fundo_cnpj: string | null; fundo_isin: string | null }>,
      dtposicao: string,
    ): Array<{ fundo_cnpj: string; fundo_isin: string; fundo_dtposicao: string }> {
      const seen = new Set<string>();
      const result: Array<{ fundo_cnpj: string; fundo_isin: string; fundo_dtposicao: string }> = [];
      for (const row of rows) {
        const cnpj = row.fundo_cnpj;
        if (!cnpj) continue;
        const isin = row.fundo_isin ?? '';
        const key = `${cnpj}|${isin}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ fundo_cnpj: cnpj, fundo_isin: isin, fundo_dtposicao: dtposicao });
        }
      }
      return result;
    }

    if (fundo_cnpj && fundo_dtposicao) {
      // CNPJ explícito: processa independente de ser monitorado (acesso direto)
      fundsToCheck = [{ fundo_cnpj, fundo_isin: fundo_isin ?? '', fundo_dtposicao }];
    } else if (fundo_dtposicao) {
      // Batch por data: filtra apenas pares monitorados (fundo_cnpjgestor na allowlist)
      const { data: pares, error } = await supabase.rpc('get_pares_fundo_monitorado', {
        p_dtposicao: fundo_dtposicao,
      });
      if (error) throw error;
      fundsToCheck = (pares ?? []).map((p: { fundo_cnpj: string; fundo_isin: string }) => ({
        fundo_cnpj: p.fundo_cnpj,
        fundo_isin: p.fundo_isin ?? '',
        fundo_dtposicao,
      }));
    } else {
      const { data: latestData, error: latestError } = await supabase
        .from('posicao_carteira')
        .select('fundo_dtposicao')
        .order('fundo_dtposicao', { ascending: false })
        .limit(1)
        .single();

      if (latestError) throw latestError;

      const latestDate = latestData?.fundo_dtposicao;
      if (!latestDate) {
        return new Response(
          JSON.stringify({ success: false, error: 'No data found in posicao_carteira' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Batch sem data: filtra apenas pares monitorados da data mais recente
      const { data: pares, error } = await supabase.rpc('get_pares_fundo_monitorado', {
        p_dtposicao: latestDate,
      });
      if (error) throw error;
      fundsToCheck = (pares ?? []).map((p: { fundo_cnpj: string; fundo_isin: string }) => ({
        fundo_cnpj: p.fundo_cnpj,
        fundo_isin: p.fundo_isin ?? '',
        fundo_dtposicao: latestDate,
      }));
    }

    console.log(`[check-enquadramento] Will check ${fundsToCheck.length} funds in parallel`);

    // Process all funds in parallel
    const fundSettled = await Promise.allSettled(
      fundsToCheck.map(fund =>
        processFund(fund, categories, supabaseUrl, supabaseServiceKey)
          .then(result => ({ fundKey: `${fund.fundo_cnpj}|${fund.fundo_isin}`, ...result }))
      )
    );

    // Aggregate results — keyed by "cnpj|isin" so multi-class funds don't collide
    const resultsByFund: Record<string, RuleResult[]> = {};
    const summary = { ok: 0, alerta: 0, violacao: 0 };
    let totalRulesChecked = 0;
    const allFailedCategories: string[] = [];

    for (const settled of fundSettled) {
      if (settled.status === 'fulfilled') {
        const { fundKey, results, failedCategories } = settled.value;
        resultsByFund[fundKey] = results;
        for (const r of results) {
          summary[r.status]++;
          totalRulesChecked++;
        }
        if (failedCategories.length > 0) {
          allFailedCategories.push(...failedCategories.map(f => `${fundKey}: ${f}`));
        }
      } else {
        console.error('[check-enquadramento] Fund processing failed:', settled.reason);
      }
    }

    const hasFailures = allFailedCategories.length > 0;
    const responseBody: CheckEnquadramentoResponse = {
      success: !hasFailures,
      total_fundos: fundsToCheck.length,
      total_rules_checked: totalRulesChecked,
      summary,
      results_by_fund: resultsByFund,
      ...(hasFailures ? { warnings: allFailedCategories } : {}),
    };

    console.log('[check-enquadramento] Completed. Summary:', summary, hasFailures ? `Failures: ${allFailedCategories.length}` : '');

    return new Response(JSON.stringify(responseBody), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[check-enquadramento] Unexpected error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
