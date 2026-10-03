import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
  categoria: 'pl' | 'concentration' | 'liquidity';
  limite: number;
  limiteAlerta?: number;
  enabled: boolean;
}

// PL Rules configuration
const PL_RULES: RuleConfig[] = [
  {
    codigo: 'PL_MIN',
    descricao: 'Patrimônio Líquido mínimo de R$ 1.000.000,00',
    categoria: 'pl',
    limite: 1000000,
    limiteAlerta: 1200000, // Alert if PL is below R$ 1.2M (20% margin)
    enabled: true,
  },
];

const LIMITE_PL = 1000000;
const JANELA_DIAS = 180;

/** Converte YYYYMMDD para Date */
function parseYyyyMmDd(dt: string): Date {
  if (!dt || dt.length < 8) return new Date(NaN);
  const y = parseInt(dt.slice(0, 4), 10);
  const m = parseInt(dt.slice(4, 6), 10) - 1;
  const d = parseInt(dt.slice(6, 8), 10);
  return new Date(y, m, d);
}

/** Converte YYYY-MM-DD para Date */
function parseIsoDate(s: string): Date {
  if (!s) return new Date(NaN);
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date(NaN) : d;
}

/** Calcula dias entre duas datas (apenas parte inteira do dia) */
function diasEntre(d1: Date, d2: Date): number {
  const ms = d2.getTime() - d1.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/** Retorna YYYYMMDD de (data - N dias) */
function subDiasYyyyMmDd(dt: string, dias: number): string {
  const d = parseYyyyMmDd(dt);
  if (isNaN(d.getTime())) return dt;
  d.setDate(d.getDate() - dias);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
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

function calcPlFidcHeader(valorativos: number, valorreceber: number): number {
  return valorativos + valorreceber;
}

function resolvePatliqFromRow(
  row: PatliqHeaderFields & { fundo_patliq?: number | null },
  isFidc: boolean,
  usaVaVr = false,
): number | null {
  const patliqXml = Number(row.fundo_patliq ?? 0) || 0;
  const va = Number(row.fundo_valorativos ?? 0) || 0;
  const vr = Number(row.fundo_valorreceber ?? 0) || 0;
  const vp = Number(row.fundo_valorpagar ?? 0) || 0;
  const vlc = Number(row.fundo_vlcotasresgatar ?? 0) || 0;

  if (isFidc && usaVaVr) {
    const plFidc = calcPlFidcHeader(va, vr);
    // Quando pl_formula='va_vr', sempre usa va+vr e ignora fundo_patliq do XML.
    if (plFidc > 0) return plFidc;
    return patliqXml || null;
  }

  if (isFidc && !usaVaVr) {
    const plHeader = calcPlHeaderAnbima(va, vr, vp, vlc);
    if (
      plHeader > 0 &&
      vr > PL_RECEBER_MIN_DIFF &&
      plHeader - patliqXml > PL_RECEBER_MIN_DIFF &&
      plHeader > patliqXml * 1.05
    ) {
      return plHeader;
    }
  }

  return patliqXml || null;
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

/** Maior sequência de dias consecutivos com PL < limite. positions ordenadas por dt asc. PL null quebra a sequência. */
function maxConsecutiveDaysBelow(positions: { dt: string; pl: number | null }[], limite: number): number {
  if (!positions.length) return 0;
  let max = 0;
  let current = 0;
  let prevDt: string | null = null;
  for (const p of positions) {
    const pl = p.pl;
    const below = pl != null && pl < limite;
    const isConsecutive = prevDt != null && p.dt > prevDt && diasEntre(parseYyyyMmDd(prevDt), parseYyyyMmDd(p.dt)) === 1;
    if (below) {
      if (isConsecutive) {
        current++;
      } else {
        current = 1;
      }
      max = Math.max(max, current);
    } else {
      current = 0;
    }
    prevDt = p.dt;
  }
  return max;
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
 * Edge Function: rules-pl
 * 
 * Verifies Patrimônio Líquido (PL) rules for a fund at a specific date.
 * 
 * Rules implemented:
 * - PL_MIN: Minimum PL of R$ 1,000,000.00
 */
serve(async (req: Request) => {
  // Handle CORS preflight
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

    console.log(`[rules-pl] Checking fund ${fundo_cnpj} isin=${fundo_isin || '(none)'} for date ${fundo_dtposicao}`);

    // Fetch fund data for the specified date
    // We need the fundo_patliq (Patrimônio Líquido) value
    let posQuery = supabase
      .from('posicao_carteira')
      .select('fundo_patliq, nome_fundo, fundo_isin, fundo_valorativos, fundo_valorreceber, fundo_valorpagar, fundo_vlcotasresgatar')
      .eq('fundo_cnpj', fundo_cnpj)
      .eq('fundo_dtposicao', fundo_dtposicao);
    if (fundo_isin) posQuery = posQuery.eq('fundo_isin', fundo_isin);
    const { data: posicaoData, error: fetchError } = await posQuery.limit(1).single();

    if (fetchError) {
      console.error('[rules-pl] Error fetching fund data:', fetchError);
      return new Response(
        JSON.stringify({ success: false, error: `Error fetching fund data: ${fetchError.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!posicaoData) {
      return new Response(
        JSON.stringify({ success: false, error: 'No data found for the specified fund and date' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const results: RuleResult[] = [];
    const nomeFundo = posicaoData.nome_fundo ?? null;
    const fundoIsinEffective = (fundo_isin_req || posicaoData.fundo_isin || '').trim() || null;
    const patliqContext = await getPatliqContext(fundo_cnpj, fundo_dtposicao, posicaoData.fundo_patliq ?? 0, {
      fundo_valorativos: posicaoData.fundo_valorativos,
      fundo_valorreceber: posicaoData.fundo_valorreceber,
      fundo_valorpagar: posicaoData.fundo_valorpagar,
      fundo_vlcotasresgatar: posicaoData.fundo_vlcotasresgatar,
    }, nomeFundo, fundoIsinEffective);
    const patliq = patliqContext.patliqFinal;
    const cleanCnpj = fundo_cnpj.replace(/\D/g, '').padStart(14, '0').slice(-14);

    // Buscar data_inicio_atividade em fundos_caracteristicas
    let dataInicioAtividade: string | null = null;
    const fundChar = await fetchFundCharacteristics(cleanCnpj, fundoIsinEffective, nomeFundo, 'data_inicio_atividade');
    if (fundChar?.data_inicio_atividade) {
      dataInicioAtividade = String(fundChar.data_inicio_atividade);
    }

    let diasDesdeInicio: number | null = null;
    let periodoGraca = false;
    if (dataInicioAtividade) {
      const dtInicio = parseIsoDate(dataInicioAtividade);
      const dtPosicao = parseYyyyMmDd(fundo_dtposicao);
      if (!isNaN(dtInicio.getTime()) && !isNaN(dtPosicao.getTime())) {
        diasDesdeInicio = diasEntre(dtInicio, dtPosicao);
        periodoGraca = diasDesdeInicio < 90;
      }
    }

    // Check each PL rule
    for (const rule of PL_RULES) {
      if (!rule.enabled) continue;

      if (rule.codigo === 'PL_MIN') {
        let status: 'ok' | 'alerta' | 'violacao';
        const detalhes: Record<string, unknown> = {
          patliq,
          patliq_xml: patliqContext.patliqXml,
          patliq_fidc: patliqContext.patliqFidc,
          patliq_csv: patliqContext.patliqCsv,
          patliq_divergente: patliqContext.patliqDivergente,
          patliq_origem_utilizada: patliqContext.origem,
          limite_alerta: rule.limiteAlerta,
          nome_fundo: posicaoData.nome_fundo,
          data_inicio_atividade: dataInicioAtividade ?? null,
          dias_desde_inicio: diasDesdeInicio ?? null,
          periodo_graça: periodoGraca,
        };

        if (patliq === null || patliq === undefined) {
          status = 'violacao';
        } else if (periodoGraca) {
          status = 'ok';
        } else {
          const isFidc = isFundoFidcNivel1(fundChar?.nivel1_categoria);
          const usaVaVrHist = isFidc && (fundChar as any)?.pl_formula === 'va_vr';
          const dtMin = subDiasYyyyMmDd(fundo_dtposicao, JANELA_DIAS);
          let histQuery = supabase
            .from('posicao_carteira')
            .select('fundo_dtposicao, fundo_patliq, fundo_valorativos, fundo_valorreceber, fundo_valorpagar, fundo_vlcotasresgatar')
            .eq('fundo_cnpj', fundo_cnpj)
            .gte('fundo_dtposicao', dtMin)
            .lte('fundo_dtposicao', fundo_dtposicao)
            .order('fundo_dtposicao', { ascending: true });
          if (fundo_isin) histQuery = histQuery.eq('fundo_isin', fundo_isin);
          else if (fundoIsinEffective) histQuery = histQuery.eq('fundo_isin', fundoIsinEffective);
          const { data: historicoData } = await histQuery;

          const byDate = new Map<string, number | null>();
          (historicoData || []).forEach((r: any) => {
            const dt = r.fundo_dtposicao;
            if (dt && !byDate.has(dt)) {
              byDate.set(dt, resolvePatliqFromRow(r, isFidc, usaVaVrHist));
            }
          });
          byDate.set(fundo_dtposicao, patliq);
          const positions = Array.from(byDate.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([dt, pl]) => ({ dt, pl }));

          const maxConsec = maxConsecutiveDaysBelow(positions, LIMITE_PL);
          detalhes.dias_consecutivos_abaixo_1m = maxConsec;

          if (positions.length === 0) {
            if (patliq < rule.limite) status = 'violacao';
            else if (rule.limiteAlerta && patliq < rule.limiteAlerta) status = 'alerta';
            else status = 'ok';
          } else if (maxConsec >= 90) {
            status = 'violacao';
          } else if (patliq < rule.limite) {
            status = 'alerta';
          } else if (rule.limiteAlerta && patliq < rule.limiteAlerta) {
            status = 'alerta';
          } else {
            status = 'ok';
          }
        }

        results.push({
          regra_codigo: rule.codigo,
          regra_descricao: rule.descricao,
          status,
          valor_atual: patliq,
          valor_limite: rule.limite,
          detalhes,
        });
      }
    }

    // Save results to database
    const fundoIsinSave = fundoIsinEffective ?? fundo_isin;
    await saveResults(fundo_cnpj, fundoIsinSave, fundo_dtposicao, 'pl', results);

    const response: RuleCheckResponse = {
      success: true,
      results,
    };

    console.log(`[rules-pl] Completed check for ${fundo_cnpj}. Results:`, results);

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[rules-pl] Unexpected error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
