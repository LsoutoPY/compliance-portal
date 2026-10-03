import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { statusLimiteMinimo } from '../_shared/rule-status.ts';

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

interface RuleCheckRequest {
  fundo_cnpj: string;
  fundo_isin?: string;  // ISIN discriminator for multi-class funds (optional)
  fundo_dtposicao: string;
}

interface RuleCheckResponse {
  success: boolean;
  results: RuleResult[];
  error?: string;
}

interface RuleConfig {
  codigo: string;
  descricao: string;
  categoria: 'classe';
  limite: number;
  limiteAlerta?: number;
  enabled: boolean;
}

// Classe Rules configuration
const CLASSE_RULES: RuleConfig[] = [
  {
    codigo: 'CLASSE_FIDC_67',
    descricao: 'Mínimo de 67% do investimento em FIDCs (para fundos FIDC)',
    categoria: 'classe',
    limite: 0.67, // 67%
    limiteAlerta: 0.70, // Alerta se cair abaixo de 70% (margem de segurança)
    enabled: true,
  },
  {
    codigo: 'CLASSE_FIP_90',
    descricao: 'Mínimo de 90% em empresas-alvo de participações (para fundos FIP)',
    categoria: 'classe',
    limite: 0.90, // 90%
    limiteAlerta: 0.92, // Alerta se cair abaixo de 92% (margem de segurança)
    enabled: true,
  },
  {
    codigo: 'CLASSE_FII_67',
    descricao: 'Mínimo de 67% do investimento em imóveis (para fundos FII)',
    categoria: 'classe',
    limite: 0.67, // 67%
    limiteAlerta: 0.70, // Alerta se cair abaixo de 70% (margem de segurança)
    enabled: true,
  },
];

/** Carência para mínimos de alocação. No FII, a regra fica OK durante a integralização; a dispensa permanece registrada nos detalhes. */
const CARECIA_MINIMO_DIAS_UTEIS = 180;

/** FIP: a dispensa regulatória é contada em dias corridos desde o início de atividade. */
const CARECIA_FIP_DIAS_CORRIDOS = 180;

const MIN_ALOC_MAX_EVENTOS_12M = 2;
const MIN_ALOC_MAX_DIAS_VIOLACAO_12M = 30;

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

async function carregarSerieMinAloc12mClasse(
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
    console.warn(`[rules-classe] Erro ao carregar série min aloc 12m: ${error.message}`);
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

function carenciaMinimoAlocacaoInfo(dataInicioAtividade: unknown, fundoDtposicao: string): {
  diasUteisDesdeInicio: number | null;
  emCarenciaIntegralizacao: boolean;
} {
  const fundStart = parseDateOnly(dataInicioAtividade);
  const positionDate = parseDateOnly(fundoDtposicao);
  const diasUteisDesdeInicio =
    fundStart && positionDate ? businessDaysBetween(fundStart, positionDate) : null;
  const emCarenciaIntegralizacao =
    diasUteisDesdeInicio != null && diasUteisDesdeInicio <= CARECIA_MINIMO_DIAS_UTEIS;
  return { diasUteisDesdeInicio, emCarenciaIntegralizacao };
}

function carenciaFipInfo(dataInicioAtividade: unknown, fundoDtposicao: string): {
  diasCorridosDesdeInicio: number | null;
  emCarenciaIntegralizacao: boolean;
} {
  const fundStart = parseDateOnly(dataInicioAtividade);
  const positionDate = parseDateOnly(fundoDtposicao);
  if (!fundStart || !positionDate) {
    return { diasCorridosDesdeInicio: null, emCarenciaIntegralizacao: false };
  }

  const startUtc = Date.UTC(fundStart.getFullYear(), fundStart.getMonth(), fundStart.getDate());
  const positionUtc = Date.UTC(positionDate.getFullYear(), positionDate.getMonth(), positionDate.getDate());
  const diasCorridosDesdeInicio = Math.floor((positionUtc - startUtc) / 86_400_000);

  return {
    diasCorridosDesdeInicio,
    emCarenciaIntegralizacao:
      diasCorridosDesdeInicio >= 0 && diasCorridosDesdeInicio <= CARECIA_FIP_DIAS_CORRIDOS,
  };
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

type ClasseMinCustom = {
  tipo_fundo: string;
  limite: number;
  limite_alerta: number;
  /** Seções adicionais a somar no numerador além do padrão (fidc + cotas FIDC + prov 999/C) */
  secoes_contribuicao: string[];
};

/** Mescla todas as regras classe_min associadas (ex.: CLASSE_FIDC_67 + _com_titulos_privados). */
function mergeClasseMinRules(
  regrasRows: { parametros: Record<string, unknown> }[] | null | undefined,
): Map<string, ClasseMinCustom> {
  const byTipo = new Map<string, ClasseMinCustom>();
  for (const row of regrasRows ?? []) {
    const p = row.parametros;
    if (p?.tipo_regra !== 'classe_min') continue;
    const tipo = String(p.tipo_fundo ?? 'FIDC').toUpperCase();
    const limite = Number(p.limite ?? (tipo === 'FIP' ? 0.90 : 0.67));
    const limiteAlerta = Number(p.limite_alerta ?? (tipo === 'FIP' ? 0.92 : 0.70));
    const secoes = Array.isArray(p.secoes_contribuicao)
      ? (p.secoes_contribuicao as string[])
      : [];
    const existing = byTipo.get(tipo);
    if (!existing) {
      byTipo.set(tipo, {
        tipo_fundo: tipo,
        limite,
        limite_alerta: limiteAlerta,
        secoes_contribuicao: [...secoes],
      });
      continue;
    }
    existing.limite = Math.max(existing.limite, limite);
    if (limiteAlerta > 0) {
      existing.limite_alerta = existing.limite_alerta > 0
        ? Math.max(existing.limite_alerta, limiteAlerta)
        : limiteAlerta;
    }
    existing.secoes_contribuicao = [...new Set([...existing.secoes_contribuicao, ...secoes])];
  }
  return byTipo;
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

// Save results to database
async function saveResults(
  fundo_cnpj: string,
  fundo_isin: string,
  fundo_dtposicao: string,
  categoria: string,
  results: RuleResult[]
) {
  const records = results.map((r) => ({
    fundo_cnpj,
    fundo_isin,
    fundo_dtposicao,
    regra_categoria: categoria,
    regra_codigo: r.regra_codigo,
    regra_descricao: r.regra_descricao,
    status: r.status,
    valor_atual: r.valor_atual,
    valor_limite: r.valor_limite,
    detalhes: r.detalhes || null,
  }));

  // Delete previous results for this category to avoid stale data
  await supabase
    .from('enquadramento_resultado')
    .delete()
    .eq('fundo_cnpj', fundo_cnpj)
    .eq('fundo_isin', fundo_isin)
    .eq('fundo_dtposicao', fundo_dtposicao)
    .eq('regra_categoria', categoria);

  if (results.length === 0) return;

  // Upsert to handle re-runs
  const { error } = await supabase
    .from('enquadramento_resultado')
    .upsert(records, {
      onConflict: 'fundo_cnpj,fundo_isin,fundo_dtposicao,regra_codigo',
    });

  if (error) {
    console.error('Error saving results:', error);
    throw error;
  }
}

/**
 * Edge Function: rules-classe
 * 
 * Verifies Classe rules (e.g. FIDC percentage) for a fund at a specific date.
 */
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { fundo_cnpj, fundo_isin: fundo_isin_req, fundo_dtposicao }: RuleCheckRequest = await req.json();
    const fundo_isin = fundo_isin_req ?? '';

    if (!fundo_cnpj || !fundo_dtposicao) {
      return new Response(
        JSON.stringify({ success: false, error: 'fundo_cnpj and fundo_dtposicao are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Limpa o CNPJ de qualquer máscara ou espaço
    const cleanCnpj = fundo_cnpj.replace(/\D/g, '');
    
    console.log(`[rules-classe] Checking fund ${fundo_cnpj} (clean: ${cleanCnpj}) isin=${fundo_isin || '(none)'} for date ${fundo_dtposicao}`);

    // 1. Check if the fund is a FIDC — use pickBestFundChar to handle multi-class CNPJs
    console.log(`[rules-classe] Searching characteristics for CNPJ: ${cleanCnpj}`);
    const { data: fundCharRows, error: charError } = await supabase
      .from('fundos_caracteristicas')
      .select('nivel1_categoria, nome_comercial, cnpj_classe, cnpj_fundo, data_inicio_atividade, isin')
      .or(`cnpj_classe.eq.${cleanCnpj},cnpj_fundo.eq.${cleanCnpj}`)
      .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo')
      .limit(10);
    const fundChar = pickBestFundChar(fundCharRows, fundo_isin || null, null);

    if (charError) {
      console.error('[rules-classe] Error fetching fund characteristics:', charError);
      return new Response(
        JSON.stringify({ success: false, error: `Error fetching fund characteristics: ${charError.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!fundChar) {
      console.log(`[rules-classe] ATENÇÃO: Nenhum registro encontrado para o CNPJ ${cleanCnpj} em fundos_caracteristicas.`);
    }

    console.log(`[rules-classe] Found characteristics:`, fundChar);

    // Busca parâmetros customizados de classe_min associados ao fundo via fundo_regras.
    // Quando encontrado, sobrescreve os defaults hardcoded de CLASSE_FIDC_67 / CLASSE_FIP_90 / CLASSE_FII_67
    // para este fundo específico (Abordagem B — regra relacional parametrizável).
    let classeMinByTipo = new Map<string, ClasseMinCustom>();
    try {
      const { data: fundRegraIdsRaw } = await (supabase as any)
        .from('fundo_regras')
        .select('regra_id, fundo_isin')
        .eq('fundo_cnpj', cleanCnpj)
        .in('fundo_isin', fundoRegrasIsinQueryValues(fundo_isin))
        .eq('ativo', true)
        .eq('status_aprovacao', 'ativo');

      const fundRegraIds = resolveFundoRegrasForIsin(
        fundRegraIdsRaw as { regra_id: string; fundo_isin?: string | null }[] | null,
        fundo_isin,
      );

      if (fundRegraIds.length > 0) {
        const ids = fundRegraIds.map(r => r.regra_id);
        const { data: regrasRows } = await (supabase as any)
          .from('regras_compliance')
          .select('parametros')
          .in('id', ids);
        classeMinByTipo = mergeClasseMinRules(
          regrasRows as { parametros: Record<string, unknown> }[] | null,
        );
        if (classeMinByTipo.size > 0) {
          console.log(`[rules-classe] Parâmetros classe_min custom para ${cleanCnpj}:`, Object.fromEntries(classeMinByTipo));
        }
      }
    } catch (e) {
      console.warn(`[rules-classe] Falha ao buscar classe_min custom para ${cleanCnpj}:`, e);
    }

    const results: RuleResult[] = [];

    // Only apply FIDC rules if the fund itself is a FIDC (inclui FIDC NP / FIDCNP)
    const nivel1Upper = fundChar?.nivel1_categoria?.toUpperCase();
    if (isFundoFidcNivel1(fundChar?.nivel1_categoria)) {
      const classeMinCustom = classeMinByTipo.get('FIDC') ?? null;
      console.log(`[rules-classe] Fund ${fundo_cnpj} is a FIDC. Running FIDC rules.`);

      // 2. Fetch all assets for this fund
      let assetsQuery = supabase
        .from('posicao_carteira')
        .select('*')
        .or(`fundo_cnpj.eq.${fundo_cnpj},fundo_cnpj.eq.${cleanCnpj}`)
        .eq('fundo_dtposicao', fundo_dtposicao);
      if (fundo_isin) assetsQuery = assetsQuery.eq('fundo_isin', fundo_isin);
      const { data: assets, error: assetsError } = await assetsQuery;

      if (assetsError) throw assetsError;
      if (!assets || assets.length === 0) {
        console.log(`[rules-classe] No position data found for FIDC ${fundo_cnpj} isin=${fundo_isin || '(none)'}`);
      } else {

      const patliqContext = await getPatliqContext(fundo_cnpj, fundo_dtposicao, assets[0].fundo_patliq || 0, {
        fundo_valorativos: assets[0].fundo_valorativos,
        fundo_valorreceber: assets[0].fundo_valorreceber,
        fundo_valorpagar: assets[0].fundo_valorpagar,
        fundo_vlcotasresgatar: assets[0].fundo_vlcotasresgatar,
      }, assets[0].nome_fundo ?? null, assets[0].fundo_isin ?? null);
      const patliq = patliqContext.patliqFinal;
      const patliqDetalhes = {
        patliq,
        patliq_xml: patliqContext.patliqXml,
        patliq_fidc: patliqContext.patliqFidc,
        patliq_csv: patliqContext.patliqCsv,
        patliq_divergente: patliqContext.patliqDivergente,
        patliq_origem_utilizada: patliqContext.origem,
      };
      
      // Collect unique CNPJs from investments (cotas, titprivado e fidc)
      const investmentCnpjs = assets
        .map(a => {
          if (a.section === 'cotas') return a.cnpjfundo;
          if ((a.section || '').toLowerCase() === 'fidc') return a.cnpjemissor || a.cnpjfundo;
          return a.cnpjemissor;
        })
        .filter((cnpj): cnpj is string => !!cnpj);
      
      const uniqueCnpjs = [...new Set(investmentCnpjs)];

      // 3. Identify which of these CNPJs are FIDCs
      let fidcCnpjs: string[] = [];
      const fidcNameMap = new Map<string, string>();
      
      if (uniqueCnpjs.length > 0) {
        console.log(`[rules-classe] Checking ${uniqueCnpjs.length} unique CNPJs for FIDC category`);
        const { data: fidcChars, error: fidcCharsError } = await supabase
          .from('fundos_caracteristicas')
          .select('cnpj_classe, nivel1_categoria, nome_comercial')
          .in('cnpj_classe', uniqueCnpjs)
          .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo');
        
        if (fidcCharsError) throw fidcCharsError;

        // Filter manually to be case-insensitive and handle nulls
        fidcChars?.forEach(f => {
          const cat = f.nivel1_categoria?.toUpperCase();
          if (cat === 'FIDC' || cat === 'FIDC NP') {
            fidcCnpjs.push(f.cnpj_classe);
            if (f.nome_comercial) fidcNameMap.set(f.cnpj_classe, f.nome_comercial);
          }
        });
        
        console.log(`[rules-classe] Identified ${fidcCnpjs.length} FIDCs:`, fidcCnpjs);
      }

      // 4. Calculate total investment in FIDCs (cotas, titprivado e fidc) — XML
      const contributionAssetsAll = assets
        .filter(a => {
          const s = (a.section || '').toLowerCase();
          if (s === 'fidc') return true; // section fidc = ativos FIDC por definição (valorfinanceiro)
          const assetCnpj = s === 'cotas' ? a.cnpjfundo : a.cnpjemissor;
          return assetCnpj && fidcCnpjs.includes(assetCnpj);
        });

      // PDD e ajustes (valorfinanceiro negativo) não são investimento em DC.
      // Somá-los no numerador gera % absurdas (ex.: -311% = PDD / PL).
      const contributionAssets = contributionAssetsAll.filter(a => (Number(a.valor_padrao) || 0) > 0);
      const pddFidcAssets = contributionAssetsAll.filter(a => (Number(a.valor_padrao) || 0) < 0);
      const totalPddFidc = pddFidcAssets.reduce((sum, a) => sum + (Number(a.valor_padrao) || 0), 0);

      let totalFidcInvestment = contributionAssets
        .reduce((sum, a) => sum + (a.valor_padrao || 0), 0);
      if (totalPddFidc < 0) {
        console.log(`[rules-classe] FIDC ${fundo_cnpj}: PDD/ajuste ${totalPddFidc} excluído do numerador dos 67% (${pddFidcAssets.length} linha(s))`);
      }

      // Provisões com codprov=999 e credeb=C são direitos creditórios de operações ainda
      // não liquidadas (NC). O XML as lança como <provisao> em vez de <fidc>, mas devem
      // compor o total de DC para fins do mínimo de 67%.
      const provisoesDC = assets.filter(a =>
        (a.section || '').toLowerCase() === 'provisao' &&
        a.credeb === 'C' &&
        String(a.codprov ?? '') === '999'
      );
      const totalProvisoesDC = provisoesDC.reduce((sum, a) => sum + (a.valor_padrao || 0), 0);
      if (totalProvisoesDC > 0) {
        totalFidcInvestment += totalProvisoesDC;
        console.log(`[rules-classe] FIDC ${fundo_cnpj}: +${totalProvisoesDC} via provisão codprov=999/credeb=C (${provisoesDC.length} lançamento(s))`);
      }

      // Complemento CSV: cotas de FIDC presentes SOMENTE no Finvest CSV
      let csvFidcAssets: any[] = [];
      try {
        const cnpj8 = fundo_cnpj.replace(/\D/g, '').slice(0, 8);
        const dtIso = `${fundo_dtposicao.slice(0,4)}-${fundo_dtposicao.slice(4,6)}-${fundo_dtposicao.slice(6,8)}`;
        const { data: csvRows } = await supabase
          .from('posicao_consolidada' as any)
          .select('valor_mercado, nome_ativo, categoria_detalhada, subcategoria, codigo_ativo, cnpj_ativo, secao_xml')
          .eq('fundo_cnpj', cnpj8)
          .eq('data_posicao', dtIso)
          .eq('status_consolidacao', 'somente_csv')
          .eq('secao_xml', 'cotas');

        const csvCotas = csvRows || [];
        const csvCnpjs = [...new Set((csvCotas as any[]).map((r: any) => r.cnpj_ativo).filter(Boolean))] as string[];
        let csvFidcCnpjs: string[] = [];
        if (csvCnpjs.length > 0) {
          const { data: csvChars } = await supabase
            .from('fundos_caracteristicas')
            .select('cnpj_classe, nivel1_categoria, nome_comercial')
            .in('cnpj_classe', csvCnpjs);
          csvChars?.forEach((f: any) => {
            const cat = f.nivel1_categoria?.toUpperCase();
            if (cat === 'FIDC' || cat === 'FIDC NP') {
              csvFidcCnpjs.push(f.cnpj_classe);
              if (f.nome_comercial) fidcNameMap.set(f.cnpj_classe, f.nome_comercial);
            }
          });
        }

        csvFidcAssets = (csvCotas as any[]).filter((r: any) =>
          r.cnpj_ativo && csvFidcCnpjs.includes(r.cnpj_ativo)
        );

        const totalCsv = csvFidcAssets.reduce((s: number, r: any) => s + (r.valor_mercado || 0), 0);
        if (totalCsv > 0) {
          totalFidcInvestment += totalCsv;
          console.log(`[rules-classe] FIDC ${fundo_cnpj}: +${totalCsv} via CSV somente_csv (${csvFidcAssets.length} cotas FIDC)`);
        }
      } catch (_) { /* não-crítico */ }

      // Seções adicionais configuradas pelo gestor na regra relacional (classe_min.secoes_contribuicao)
      // Cada seção selecionada tem seus ativos somados no numerador além do padrão fidc+cotas+prov999.
      const secoesAdicionais = classeMinCustom?.secoes_contribuicao ?? [];
      let totalSecoesAdicionais = 0;
      const secoesAdicionaisAtivos: Array<{ nome: string; cnpj: string | null; valor: number; percentual: number; tipo: string; secao: string }> = [];

      if (secoesAdicionais.length > 0) {
        for (const secao of secoesAdicionais) {
          let secaoAssets: any[];

          if (secao === 'cotas_fidc') {
            // Cotas de FIDCs já estão em contributionAssets — evita dupla contagem
            console.log(`[rules-classe] secao_adicional 'cotas_fidc' já está no padrão, pulando.`);
            continue;
          } else if (secao === 'outros') {
            // section provisao/outros não contadas anteriormente
            secaoAssets = assets.filter(a => {
              const s = (a.section || '').toLowerCase();
              return (s === 'outros' || s === 'provisao') &&
                !(s === 'provisao' && a.credeb === 'C' && String(a.codprov ?? '') === '999');
            });
          } else {
            secaoAssets = assets.filter(a => (a.section || '').toLowerCase() === secao);
          }

          const totalSecao = secaoAssets.reduce((sum: number, a: any) => sum + (a.valor_padrao || 0), 0);
          if (totalSecao > 0) {
            totalSecoesAdicionais += totalSecao;
            console.log(`[rules-classe] FIDC ${fundo_cnpj}: +${totalSecao} via secao_adicional '${secao}' (${secaoAssets.length} ativos)`);
            for (const a of secaoAssets) {
              secoesAdicionaisAtivos.push({
                nome: a.nome_comercial_ativo || a.nomecomercial || a.isin || a.codativo || `Ativo ${secao}`,
                cnpj: a.cnpjemissor || a.cnpjfundo || null,
                valor: a.valor_padrao || 0,
                percentual: patliq > 0 ? (a.valor_padrao || 0) / patliq : 0,
                tipo: `secao_adicional_${secao}`,
                secao,
              });
            }
          }
        }
        if (totalSecoesAdicionais > 0) {
          totalFidcInvestment += totalSecoesAdicionais;
        }
      }

      const percFidc = patliq > 0 ? totalFidcInvestment / patliq : 0;
      const carenciaFidc = carenciaMinimoAlocacaoInfo(fundChar?.data_inicio_atividade, fundo_dtposicao);

      // 5. Apply rules
      for (const rule of CLASSE_RULES) {
        if (!rule.enabled) continue;

        if (rule.codigo === 'CLASSE_FIDC_67') {
          // Usa parâmetros customizados do banco quando disponíveis (Abordagem B relacional)
          const limiteEfetivo = (classeMinCustom?.tipo_fundo === 'FIDC' ? classeMinCustom.limite : null) ?? rule.limite;
          const limiteAlertaEfetivo = (classeMinCustom?.tipo_fundo === 'FIDC' ? classeMinCustom.limite_alerta : null) ?? rule.limiteAlerta;

          const violouMinimoFidc = percFidc < limiteEfetivo;
          const violacaoMinimoBloqueia = violouMinimoFidc && !carenciaFidc.emCarenciaIntegralizacao;
          const abaixoMinimoEmCarencia = violouMinimoFidc && carenciaFidc.emCarenciaIntegralizacao;
          let status: 'ok' | 'alerta' | 'violacao' = 'ok';
          if (violacaoMinimoBloqueia) {
            status = 'violacao';
          } else if (abaixoMinimoEmCarencia) {
            status = 'alerta';
          } else if (!violouMinimoFidc && limiteAlertaEfetivo && percFidc < limiteAlertaEfetivo) {
            status = 'alerta';
          }

          const { fromYmd, toYmd } = rolling12mBoundsYmd(fundo_dtposicao);
          const dtAtual = fundo_dtposicao.replace(/\D/g, '').slice(0, 8);
          const serieMinAloc = await carregarSerieMinAloc12mClasse(
            fundo_cnpj,
            cleanCnpj,
            fundo_isin,
            rule.codigo,
            fromYmd,
            toYmd,
          );
          const contadoresMinAloc = calcularContadoresMinAloc12m(serieMinAloc, dtAtual, status);
          const maxEventos12m =
            Math.abs(limiteEfetivo - 0.5) < 0.001 ? 1 : MIN_ALOC_MAX_EVENTOS_12M;
          if (
            contadoresMinAloc.eventos_12m >= maxEventos12m ||
            contadoresMinAloc.dias_violacao_12m >= MIN_ALOC_MAX_DIAS_VIOLACAO_12M
          ) {
            status = 'violacao';
          }

          const fidcAtivosContabilizados = [
            ...contributionAssets.map(a => {
              const assetCnpj = a.section === 'cotas' ? a.cnpjfundo : (a.section || '').toLowerCase() === 'fidc' ? (a.cnpjemissor || a.cnpjfundo) : a.cnpjemissor;
              return {
                nome: (assetCnpj ? fidcNameMap.get(assetCnpj) : null) || a.nome_comercial_ativo || a.isin || a.codativo || "N/A",
                cnpj: assetCnpj,
                valor: a.valor_padrao,
                percentual: patliq > 0 ? (a.valor_padrao || 0) / patliq : 0,
                tipo: 'xml'
              };
            }),
            ...csvFidcAssets.map((r: any) => ({
              nome: (r.cnpj_ativo ? fidcNameMap.get(r.cnpj_ativo) : null) || r.categoria_detalhada || r.subcategoria || r.nome_ativo || "FIDC CSV",
              cnpj: r.cnpj_ativo,
              valor: r.valor_mercado || 0,
              percentual: patliq > 0 ? (r.valor_mercado || 0) / patliq : 0,
              tipo: 'csv'
            })),
            ...provisoesDC.map(a => ({
              nome: `Direito Creditório NC (prov. cód. ${a.codprov})`,
              cnpj: null,
              valor: a.valor_padrao,
              percentual: patliq > 0 ? (a.valor_padrao || 0) / patliq : 0,
              tipo: 'provisao_dc'
            })),
            ...secoesAdicionaisAtivos,
            ...pddFidcAssets.map(a => ({
              nome: a.nome_comercial_ativo || a.nomecomercial || a.isin || a.codativo || 'PDD / ajuste FIDC',
              cnpj: a.cnpjemissor || a.cnpjfundo || null,
              valor: a.valor_padrao,
              percentual: patliq > 0 ? (a.valor_padrao || 0) / patliq : 0,
              tipo: 'pdd_excluida',
            })),
          ];
          results.push({
            regra_codigo: rule.codigo,
            regra_descricao: classeMinCustom?.tipo_fundo === 'FIDC'
              ? `Mínimo de ${Math.round(limiteEfetivo * 100)}% do investimento em FIDCs (parâmetro customizado)`
              : rule.descricao,
            status,
            valor_atual: percFidc,
            valor_limite: limiteEfetivo,
            detalhes: {
              total_fidc: totalFidcInvestment,
              total_pdd_fidc: totalPddFidc < 0 ? totalPddFidc : undefined,
              pdd_excluida_do_numerador: totalPddFidc < 0,
              total_provisoes_dc: totalProvisoesDC > 0 ? totalProvisoesDC : undefined,
              total_secoes_adicionais: totalSecoesAdicionais > 0 ? totalSecoesAdicionais : undefined,
              secoes_contribuicao_ativas: secoesAdicionais.length > 0 ? secoesAdicionais : undefined,
              ...patliqDetalhes,
              nome_fundo: fundChar.nome_comercial || assets[0].nome_fundo,
              data_inicio_atividade: fundChar?.data_inicio_atividade ?? null,
              dias_uteis_desde_inicio_atividade: carenciaFidc.diasUteisDesdeInicio,
              carencia_dias_uteis_minimo_alocacao: CARECIA_MINIMO_DIAS_UTEIS,
              em_carencia_minimo_alocacao: carenciaFidc.emCarenciaIntegralizacao,
              violacao_min_suprimida_por_carencia: abaixoMinimoEmCarencia,
              abaixo_limite_em_carencia: abaixoMinimoEmCarencia,
              limite_alerta_efetivo: limiteAlertaEfetivo,
              parametros_origem: classeMinCustom?.tipo_fundo === 'FIDC' ? 'relacional' : 'automatico',
              regra_min_alocacao_fidc: true,
              regra_cotas_50_art_caput: Math.abs(limiteEfetivo - 0.5) < 0.001,
              eventos_12m: contadoresMinAloc.eventos_12m,
              dias_violacao_12m: contadoresMinAloc.dias_violacao_12m,
              max_eventos_12m: maxEventos12m,
              max_dias_violacao_12m: MIN_ALOC_MAX_DIAS_VIOLACAO_12M,
              ativos_contabilizados: fidcAtivosContabilizados
            },
          });
        }
      }
      }
    }
    
    // Only apply FIP rules if the fund is a FIP
    if (fundChar?.nivel1_categoria?.toUpperCase() === 'FIP') {
      const classeMinCustom = classeMinByTipo.get('FIP') ?? null;
      console.log(`[rules-classe] Fund ${fundo_cnpj} is a FIP. Running FIP rules.`);

      // Fetch all assets for this fund (if not already fetched)
      let fipAssetsQuery = supabase
        .from('posicao_carteira')
        .select('*')
        .eq('fundo_cnpj', cleanCnpj)
        .eq('fundo_dtposicao', fundo_dtposicao);
      if (fundo_isin) fipAssetsQuery = fipAssetsQuery.eq('fundo_isin', fundo_isin);
      const { data: fipAssets, error: fipAssetsError } = await fipAssetsQuery;

      if (fipAssetsError) throw fipAssetsError;
      if (!fipAssets || fipAssets.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'No position data found for FIP' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const fipPatliqContext = await getPatliqContext(fundo_cnpj, fundo_dtposicao, fipAssets[0].fundo_patliq || 0, {
        fundo_valorativos: fipAssets[0].fundo_valorativos,
        fundo_valorreceber: fipAssets[0].fundo_valorreceber,
        fundo_valorpagar: fipAssets[0].fundo_valorpagar,
        fundo_vlcotasresgatar: fipAssets[0].fundo_vlcotasresgatar,
      }, fipAssets[0].nome_fundo ?? null, fipAssets[0].fundo_isin ?? null);
      const fipPatliq = fipPatliqContext.patliqFinal;
      const fipPatliqDetalhes = {
        patliq: fipPatliq,
        patliq_xml: fipPatliqContext.patliqXml,
        patliq_csv: fipPatliqContext.patliqCsv,
        patliq_divergente: fipPatliqContext.patliqDivergente,
        patliq_origem_utilizada: fipPatliqContext.origem,
      };
      
      // Calculate total investment in participações (empresas-alvo) — XML
      const fipContributionAssets = fipAssets
        .filter(a => a.section === 'participacoes' || a.section === 'acoes');

      let totalParticipacoes = fipContributionAssets
        .reduce((sum, a) => sum + (a.valor_padrao || 0), 0);

      // Complemento CSV: MUTUO, empréstimos e participações presentes SOMENTE no Finvest CSV
      const isFipParticipacaoCsv = (r: any): boolean => {
        const sub = (r.subcategoria || '').toUpperCase();
        const cat = (r.categoria_detalhada || '').toUpperCase();
        const nome = (r.nome_ativo || '').toUpperCase();
        const check = (s: string) =>
          s.includes('MUTUO') || s.includes('MÚTUO') || s.includes('EMPRÉSTIMO') ||
          s.includes('EMPRESTIMO') || s.includes('PARTICIPAÇÃO') || s.includes('PARTICIPACAO') ||
          s.includes('CRÉDITO SOCIEDADE') || s.includes('CREDITO SOCIEDADE');
        return check(sub) || check(cat) || check(nome);
      };

      let csvParticipacoes: any[] = [];
      try {
        const cnpj8 = fundo_cnpj.replace(/\D/g, '').slice(0, 8);
        const dtIso = `${fundo_dtposicao.slice(0,4)}-${fundo_dtposicao.slice(4,6)}-${fundo_dtposicao.slice(6,8)}`;
        const { data: csvRows } = await supabase
          .from('posicao_consolidada' as any)
          .select('valor_mercado, nome_ativo, categoria_detalhada, subcategoria, codigo_ativo, cnpj_ativo, secao_xml')
          .eq('fundo_cnpj', cnpj8)
          .eq('data_posicao', dtIso)
          .eq('status_consolidacao', 'somente_csv');

        csvParticipacoes = (csvRows || []).filter((r: any) =>
          r.secao_xml === 'participacoes' || r.secao_xml === 'acoes' || isFipParticipacaoCsv(r)
        );

        const totalCsv = csvParticipacoes.reduce((s: number, r: any) => s + (r.valor_mercado || 0), 0);
        if (totalCsv > 0) {
          totalParticipacoes += totalCsv;
          console.log(`[rules-classe] FIP ${fundo_cnpj}: +${totalCsv} via CSV somente_csv (${csvParticipacoes.length} ativos: MUTUO, participações)`);
        }
      } catch (_) { /* não-crítico */ }

      let percParticipacoes = fipPatliq > 0 ? totalParticipacoes / fipPatliq : 0;
      let totalParticipacoesAjustado = totalParticipacoes;
      let bonus5pctCapSubscr = 0;
      let vlCapSubscr: number | undefined;
      const carenciaFip = carenciaFipInfo(fundChar?.data_inicio_atividade, fundo_dtposicao);

      const posDate = fundo_dtposicao.length >= 8
        ? `${fundo_dtposicao.slice(0, 4)}-${fundo_dtposicao.slice(4, 6)}-${fundo_dtposicao.slice(6, 8)}`
        : '';

      const { data: informeRow } = await supabase
        .from('fip_informe_quadrimestral')
        .select('vl_cap_subscr')
        .eq('cnpj_fundo_classe', cleanCnpj)
        .lte('dt_comptc', posDate || '9999-12-31')
        .order('dt_comptc', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (informeRow?.vl_cap_subscr != null && informeRow.vl_cap_subscr > 0) {
        vlCapSubscr = Number(informeRow.vl_cap_subscr);
        bonus5pctCapSubscr = vlCapSubscr * 0.05;
        totalParticipacoesAjustado = totalParticipacoes + bonus5pctCapSubscr;
        percParticipacoes = fipPatliq > 0 ? totalParticipacoesAjustado / fipPatliq : 0;
        console.log(`[rules-classe] FIP ${fundo_cnpj}: aplicado bônus 5% cap subscrito=${bonus5pctCapSubscr}, novo %=${(percParticipacoes * 100).toFixed(2)}%`);
      }

      console.log(`[rules-classe] FIP ${fundo_cnpj}: ${(percParticipacoes * 100).toFixed(2)}% em participações (${totalParticipacoesAjustado} / ${fipPatliq})`);

      // Apply FIP rule
      for (const rule of CLASSE_RULES) {
        if (!rule.enabled) continue;

        if (rule.codigo === 'CLASSE_FIP_90') {
          const limiteEfetivoFip = (classeMinCustom?.tipo_fundo === 'FIP' ? classeMinCustom.limite : null) ?? rule.limite;
          const limiteAlertaEfetivoFip = (classeMinCustom?.tipo_fundo === 'FIP' ? classeMinCustom.limite_alerta : null) ?? rule.limiteAlerta;
          const violouMinimoFip = percParticipacoes < limiteEfetivoFip;
          const abaixoMinimoEmCarencia = violouMinimoFip && carenciaFip.emCarenciaIntegralizacao;
          const status = statusLimiteMinimo(
            percParticipacoes,
            limiteEfetivoFip,
            limiteAlertaEfetivoFip,
            carenciaFip.emCarenciaIntegralizacao,
          );

          const percSemBonus = fipPatliq > 0 ? totalParticipacoes / fipPatliq : 0;
          const ativosContabilizados = [
            ...fipContributionAssets.map(a => ({
              nome: a.nomecomercial || a.nome_comercial_ativo || a.isin || a.codativo || "N/A",
              cnpj: a.cnpjpart || a.cnpjfundo || a.cnpjemissor,
              valor: a.valor_padrao,
              percentual: fipPatliq > 0 ? (a.valor_padrao || 0) / fipPatliq : 0,
              tipo: 'xml'
            })),
            ...csvParticipacoes.map((r: any) => ({
              nome: r.categoria_detalhada || r.subcategoria || r.nome_ativo || r.codigo_ativo || "Ativo CSV",
              cnpj: r.cnpj_ativo,
              valor: r.valor_mercado || 0,
              percentual: fipPatliq > 0 ? (r.valor_mercado || 0) / fipPatliq : 0,
              tipo: 'csv'
            }))
          ];
          const detalhes: Record<string, unknown> = {
            total_participacoes: totalParticipacoes,
            ...fipPatliqDetalhes,
            perc_participacoes_sem_bonus: percSemBonus,
            limite_alerta: limiteAlertaEfetivoFip,
            nome_fundo: fundChar.nome_comercial || fipAssets[0].nome_fundo,
            data_inicio_atividade: fundChar?.data_inicio_atividade ?? null,
            dias_corridos_desde_inicio_atividade: carenciaFip.diasCorridosDesdeInicio,
            carencia_dias_corridos_minimo_alocacao: CARECIA_FIP_DIAS_CORRIDOS,
            em_carencia_minimo_alocacao: carenciaFip.emCarenciaIntegralizacao,
            violacao_min_suprimida_por_carencia: abaixoMinimoEmCarencia,
            abaixo_limite_em_carencia: abaixoMinimoEmCarencia,
            ativos_contabilizados: ativosContabilizados
          };
          if (vlCapSubscr != null && vlCapSubscr > 0) {
            detalhes.vl_cap_subscr = vlCapSubscr;
            detalhes.bonus_5pct_cap_subscrito = bonus5pctCapSubscr;
            detalhes.total_participacoes_ajustado = totalParticipacoesAjustado;
          }

          results.push({
            regra_codigo: rule.codigo,
            regra_descricao: classeMinCustom?.tipo_fundo === 'FIP'
              ? `Mínimo de ${Math.round(limiteEfetivoFip * 100)}% em participações (parâmetro customizado)`
              : rule.descricao,
            status,
            valor_atual: percParticipacoes,
            valor_limite: limiteEfetivoFip,
            detalhes: { ...detalhes, parametros_origem: classeMinCustom?.tipo_fundo === 'FIP' ? 'relacional' : 'automatico' },
          });
        }
      }
    }
    
    // Only apply FII rules if the fund is a FII
    if (fundChar?.nivel1_categoria?.toUpperCase() === 'FII') {
      const classeMinCustom = classeMinByTipo.get('FII') ?? null;
      console.log(`[rules-classe] Fund ${fundo_cnpj} is a FII. Running FII rules.`);

      // Fetch all assets for this fund
      let fiiAssetsQuery = supabase
        .from('posicao_carteira')
        .select('*')
        .or(`fundo_cnpj.eq.${fundo_cnpj},fundo_cnpj.eq.${cleanCnpj}`)
        .eq('fundo_dtposicao', fundo_dtposicao);
      if (fundo_isin) fiiAssetsQuery = fiiAssetsQuery.eq('fundo_isin', fundo_isin);
      const { data: fiiAssets, error: fiiAssetsError } = await fiiAssetsQuery;

      if (fiiAssetsError) throw fiiAssetsError;
      
      if (!fiiAssets || fiiAssets.length === 0) {
        console.log(`[rules-classe] No position data found for FII ${fundo_cnpj}`);
      } else {
        const fiiPatliqContext = await getPatliqContext(fundo_cnpj, fundo_dtposicao, fiiAssets[0].fundo_patliq || 0, {
          fundo_valorativos: fiiAssets[0].fundo_valorativos,
          fundo_valorreceber: fiiAssets[0].fundo_valorreceber,
          fundo_valorpagar: fiiAssets[0].fundo_valorpagar,
          fundo_vlcotasresgatar: fiiAssets[0].fundo_vlcotasresgatar,
        }, fiiAssets[0].nome_fundo ?? null, fiiAssets[0].fundo_isin ?? null);
        const fiiPatliq = fiiPatliqContext.patliqFinal;
        const fiiPatliqDetalhes = {
          patliq: fiiPatliq,
          patliq_xml: fiiPatliqContext.patliqXml,
          patliq_csv: fiiPatliqContext.patliqCsv,
          patliq_divergente: fiiPatliqContext.patliqDivergente,
          patliq_origem_utilizada: fiiPatliqContext.origem,
        };

        // ── Helper: identifica instrumento de renda fixa imobiliária no XML ───
        // Per CVM Res. 175: CRI, LCI, LIG, CCI, LH e CEPAC contam para os 67%
        const isImobRfXml = (a: any): boolean => {
          const cod = (a.codativo || '').trim().toUpperCase();
          const isin = (a.isin || '').trim().toUpperCase();
          const nome = ((a.nomecomercial || a.nome_comercial_ativo || '') as string).toUpperCase();

          // Casos clássicos por código curto no XML
          if (['CRI', 'LCI', 'LIG', 'CCI', 'LH', 'CEPAC'].includes(cod)) return true;

          // Em alguns XMLs ANBIMA, codativo vem em formato interno (ex.: 25F0010202)
          // e o tipo do papel aparece no ISIN/nome.
          const hasImobToken = (s: string) =>
            s.includes('CRI') || s.includes('LCI') || s.includes('LIG') ||
            s.includes('CCI') || s.includes('CEPAC') ||
            s.includes('LETRA HIPOTEC') || s.includes('HIPOTECARIA') ||
            s.includes('CERTIFICADO DE RECEBIV');

          if (hasImobToken(isin) || hasImobToken(nome)) return true;

          return false;
        };

        // ── Helper: identifica instrumento imobiliário no CSV ─────────────────
        const isImobRfCsv = (r: any): boolean => {
          const sub = (r.subcategoria || '').toUpperCase();
          const cat = (r.categoria_detalhada || '').toUpperCase();
          const nome = (r.nome_ativo || '').toUpperCase();
          const check = (s: string) =>
            s.includes('CRI') || s.includes('LCI') || s.includes('LIG') || s.includes('CCI') ||
            s.includes('LH ') || s.includes('LETRA HIPOTECÁRIA') || s.includes('LETRA HIPOTECARIA') ||
            s.includes('CERTIFICADO DE RECEBÍVEL') || s.includes('CERTIFICADO DE RECEBIVEL') ||
            s.includes('LETRA DE CRÉDITO IMOB') || s.includes('LETRA DE CREDITO IMOB');
          return check(sub) || check(cat) || check(nome);
        };

        // ── Nome de exibição para ativo XML ───────────────────────────────────
        const nomeXml = (a: any): string => {
          if (a.nomecomercial) return a.nomecomercial;
          if (a.logradouro) {
            let n = a.logradouro;
            if (a.numero) n += `, ${a.numero}`;
            if (a.cidade) n += ` — ${a.cidade}`;
            return n;
          }
          return a.isin || a.codativo || 'Ativo XML';
        };

        // ── 1. Imóveis diretos (XML) ──────────────────────────────────────────
        const imoveisXml = fiiAssets.filter(a => a.section?.toLowerCase() === 'imoveis');

        // ── 2. Renda fixa imobiliária (XML): CRI, LCI, LIG etc. em titprivado ─
        const rfImobXml = fiiAssets.filter(a =>
          a.section?.toLowerCase() === 'titprivado' && isImobRfXml(a)
        );

        // ── 3. Ativos SOMENTE no CSV: imóveis diretos + RF imobiliária ─────────
        let csvImobAssets: any[] = [];
        try {
          const cnpj8 = fundo_cnpj.replace(/\D/g, '').slice(0, 8);
          const dtIso = `${fundo_dtposicao.slice(0,4)}-${fundo_dtposicao.slice(4,6)}-${fundo_dtposicao.slice(6,8)}`;
          const { data: csvRows } = await supabase
            .from('posicao_consolidada' as any)
            .select('valor_mercado, nome_ativo, categoria_detalhada, subcategoria, codigo_ativo, cnpj_ativo, secao_xml')
            .eq('fundo_cnpj', cnpj8)
            .eq('data_posicao', dtIso)
            .eq('status_consolidacao', 'somente_csv')
            .in('secao_xml', ['imoveis', 'titprivado']);

          csvImobAssets = (csvRows || []).filter((r: any) =>
            r.secao_xml === 'imoveis' || isImobRfCsv(r)
          );

          if (csvImobAssets.length > 0) {
            const totalCsv = csvImobAssets.reduce((s: number, r: any) => s + (r.valor_mercado || 0), 0);
            console.log(`[rules-classe] FII ${fundo_cnpj}: +${totalCsv} via CSV somente_csv (${csvImobAssets.length} ativos)`);
          }
        } catch (_) { /* não-crítico */ }

        // ── Totais ─────────────────────────────────────────────────────────────
        const totalImoveisXml = [...imoveisXml, ...rfImobXml].reduce((s, a) => s + (a.valor_padrao || 0), 0);
        const totalImoveisCsv = csvImobAssets.reduce((s: number, r: any) => s + (r.valor_mercado || 0), 0);
        const totalImoveis = totalImoveisXml + totalImoveisCsv;
        const percImoveis = fiiPatliq > 0 ? totalImoveis / fiiPatliq : 0;

        console.log(`[rules-classe] FII ${fundo_cnpj}: ${(percImoveis * 100).toFixed(2)}% imob. ` +
          `(imóveisXML=${imoveisXml.length}, rfImobXML=${rfImobXml.length}, CSV=${csvImobAssets.length}, PL=${fiiPatliq})`);

        const carenciaFii = carenciaMinimoAlocacaoInfo(fundChar?.data_inicio_atividade, fundo_dtposicao);

        // ── Ativos contabilizados: XML imóveis + XML RF imob + CSV ─────────────
        const ativosContabilizados = [
          ...imoveisXml.map((a: any) => ({
            nome: nomeXml(a),
            cnpj: a.cnpjemp || a.cnpjpart || a.cnpjemissor || null,
            valor: a.valor_padrao || 0,
            percentual: fiiPatliq > 0 ? (a.valor_padrao || 0) / fiiPatliq : 0,
            tipo: 'imovel_direto',
          })),
          ...rfImobXml.map((a: any) => ({
            nome: a.isin || a.codativo || 'CRI/LCI',
            cnpj: a.cnpjemissor || null,
            valor: a.valor_padrao || 0,
            percentual: fiiPatliq > 0 ? (a.valor_padrao || 0) / fiiPatliq : 0,
            tipo: a.codativo || 'rf_imob',
          })),
          ...csvImobAssets.map((r: any) => ({
            nome: r.categoria_detalhada || r.subcategoria || r.nome_ativo || r.codigo_ativo || 'Ativo CSV',
            cnpj: r.cnpj_ativo || null,
            valor: r.valor_mercado || 0,
            percentual: fiiPatliq > 0 ? (r.valor_mercado || 0) / fiiPatliq : 0,
            tipo: r.secao_xml === 'imoveis' ? 'imovel_csv' : 'rf_imob_csv',
          })),
        ];

        // Apply FII rule
        for (const rule of CLASSE_RULES) {
          if (!rule.enabled) continue;

          if (rule.codigo === 'CLASSE_FII_67') {
            const limiteEfetivoFii = (classeMinCustom?.tipo_fundo === 'FII' ? classeMinCustom.limite : null) ?? rule.limite;
            const limiteAlertaEfetivoFii = (classeMinCustom?.tipo_fundo === 'FII' ? classeMinCustom.limite_alerta : null) ?? rule.limiteAlerta;
            const violouMinimoImob = percImoveis < limiteEfetivoFii;
            const abaixoMinimoEmCarencia = violouMinimoImob && carenciaFii.emCarenciaIntegralizacao;
            const status = statusLimiteMinimo(
              percImoveis,
              limiteEfetivoFii,
              limiteAlertaEfetivoFii,
              carenciaFii.emCarenciaIntegralizacao,
            );

            results.push({
              regra_codigo: rule.codigo,
              regra_descricao: classeMinCustom?.tipo_fundo === 'FII'
                ? `Mínimo de ${Math.round(limiteEfetivoFii * 100)}% do investimento em imóveis (parâmetro customizado)`
                : rule.descricao,
              status,
              valor_atual: percImoveis,
              valor_limite: limiteEfetivoFii,
              detalhes: {
                total_imoveis: totalImoveis,
                total_imoveis_diretos: imoveisXml.reduce((s: number, a: any) => s + (a.valor_padrao || 0), 0),
                total_rf_imob: rfImobXml.reduce((s: number, a: any) => s + (a.valor_padrao || 0), 0) + totalImoveisCsv,
                ...fiiPatliqDetalhes,
                nome_fundo: fundChar.nome_comercial || fiiAssets[0].nome_fundo,
                data_inicio_atividade: fundChar?.data_inicio_atividade ?? null,
                dias_uteis_desde_inicio_atividade: carenciaFii.diasUteisDesdeInicio,
                carencia_dias_uteis_minimo_alocacao: CARECIA_MINIMO_DIAS_UTEIS,
                em_carencia_minimo_alocacao: carenciaFii.emCarenciaIntegralizacao,
                violacao_min_suprimida_por_carencia: abaixoMinimoEmCarencia,
                abaixo_limite_em_carencia: abaixoMinimoEmCarencia,
                limite_alerta_efetivo: limiteAlertaEfetivoFii,
                parametros_origem: classeMinCustom?.tipo_fundo === 'FII' ? 'relacional' : 'automatico',
                ativos_contabilizados: ativosContabilizados,
              },
            });
          }
        }
      }
    } else if (!isFundoFidcNivel1(fundChar?.nivel1_categoria) && nivel1Upper !== 'FIP' && nivel1Upper !== 'FII') {
      console.log(`[rules-classe] Fund ${fundo_cnpj} is not a FIDC, FIP or FII (${fundChar?.nivel1_categoria}). Skipping class rules.`);
    }

    // Save results (even if empty, to clear previous runs for this category)
    await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, 'classe', results);

    const response: RuleCheckResponse = {
      success: true,
      results,
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[rules-classe] Unexpected error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
