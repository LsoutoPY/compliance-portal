import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
  fundo_isin?: string;
  fundo_dtposicao: string;
}

interface RuleCheckResponse {
  success: boolean;
  results: RuleResult[];
  error?: string;
}

type ClasseAlvo = 'senior' | 'mezanino';
type ComposicaoNumerador = 'jr' | 'jr_mez';

interface SeriesConfig {
  jr: string[];
  mez: string[];
  senior: string[];
}

interface SubordinacaoParams {
  classe_alvo: ClasseAlvo;
  limite_min: number;
  limite_alerta: number;
  composicao_numerador: ComposicaoNumerador;
  origem_pl: string;
  series: SeriesConfig;
  observacao?: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const CATEGORIA = 'fidc-estrutura';
const LOG_PREFIX = '[rules-fidc-estrutura]';
const PL_RECEBER_MIN_DIFF = 50_000;

function normalizarCnpj(cnpj: string | null | undefined): string {
  return String(cnpj ?? '').replace(/\D/g, '').padStart(14, '0').slice(-14);
}

function parseIsinList(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((v) => String(v ?? '').trim()).filter(Boolean))];
  }
  return [];
}

function normalizeSeries(raw: unknown): SeriesConfig {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    jr: parseIsinList(s.jr),
    mez: parseIsinList(s.mez),
    senior: parseIsinList(s.senior),
  };
}

function parseSubordinacaoParams(parametros: Record<string, unknown>): SubordinacaoParams | null {
  if (parametros.tipo_regra !== 'fidc_subordinacao') return null;
  const limiteMin = Number(parametros.limite_min);
  const limiteAlerta = Number(parametros.limite_alerta);
  return {
    classe_alvo: parametros.classe_alvo === 'mezanino' ? 'mezanino' : 'senior',
    limite_min: Number.isFinite(limiteMin) ? limiteMin : 0.1,
    limite_alerta: Number.isFinite(limiteAlerta) ? limiteAlerta : 0.12,
    composicao_numerador: parametros.composicao_numerador === 'jr' ? 'jr' : 'jr_mez',
    origem_pl: parametros.origem_pl === 'pl_atual_xml' ? 'pl_atual_xml' : 'pl_mes_anterior_posicao',
    series: normalizeSeries(parametros.series),
    observacao: parametros.observacao ? String(parametros.observacao) : undefined,
  };
}

function getTargetIsins(params: SubordinacaoParams): string[] {
  return params.classe_alvo === 'mezanino' ? params.series.mez : params.series.senior;
}

function shouldRunOnIsin(fundoIsin: string, params: SubordinacaoParams): boolean {
  if (!fundoIsin) return false;
  return getTargetIsins(params).includes(fundoIsin);
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

function pickBestFundChar<T extends { nome_comercial?: string | null; isin?: string | null }>(
  rows: T[] | null | undefined,
  fundoIsin?: string | null,
  nomeFundo?: string | null,
): T | null {
  if (!rows || rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  if (fundoIsin) {
    const upper = fundoIsin.toUpperCase().trim();
    const byIsin = rows.find((r) => String(r.isin ?? '').toUpperCase().trim() === upper);
    if (byIsin) return byIsin;
  }
  if (nomeFundo) {
    const upper = nomeFundo.toUpperCase().trim();
    const byName = rows.find((r) => String(r.nome_comercial ?? '').toUpperCase().trim() === upper);
    if (byName) return byName;
  }
  return rows[0];
}

async function fetchFundCharacteristics(
  cleanCnpj: string,
  fundoIsin?: string | null,
  nomeFundo?: string | null,
): Promise<{ nivel1_categoria?: string | null; pl_formula?: string | null; nome_comercial?: string | null; isin?: string | null } | null> {
  const baseFields = 'nivel1_categoria, pl_formula, nome_comercial, isin';
  if (fundoIsin) {
    const { data: byIsin } = await supabase
      .from('fundos_caracteristicas')
      .select(baseFields)
      .or(`cnpj_classe.eq.${cleanCnpj},cnpj_fundo.eq.${cleanCnpj}`)
      .eq('isin', fundoIsin)
      .limit(1)
      .maybeSingle();
    if (byIsin) return byIsin;
  }
  const { data: fundCharRows } = await supabase
    .from('fundos_caracteristicas')
    .select(baseFields)
    .or(`cnpj_classe.eq.${cleanCnpj},cnpj_fundo.eq.${cleanCnpj}`)
    .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo,estrutura.eq.Subclasse')
    .limit(50);
  return pickBestFundChar(fundCharRows, fundoIsin, nomeFundo);
}

async function resolvePlAtualXml(
  fundoCnpj: string,
  fundoDtposicao: string,
  fundoIsin: string,
): Promise<{ patliq: number; origem_pl_utilizada: string; nome_fundo?: string | null }> {
  const cleanCnpj = normalizarCnpj(fundoCnpj);
  const { data: posicaoRows } = await supabase
    .from('posicao_carteira')
    .select('fundo_patliq, fundo_valorativos, fundo_valorreceber, fundo_valorpagar, fundo_vlcotasresgatar, nome_fundo, fundo_isin')
    .eq('fundo_cnpj', fundoCnpj)
    .eq('fundo_dtposicao', fundoDtposicao)
    .eq('fundo_isin', fundoIsin)
    .limit(1);

  const row = posicaoRows?.[0] as {
    fundo_patliq?: number | null;
    fundo_valorativos?: number | null;
    fundo_valorreceber?: number | null;
    fundo_valorpagar?: number | null;
    fundo_vlcotasresgatar?: number | null;
    nome_fundo?: string | null;
  } | undefined;

  if (!row) {
    return { patliq: 0, origem_pl_utilizada: 'sem_posicao', nome_fundo: null };
  }

  const patliqXml = Number(row.fundo_patliq ?? 0) || 0;
  const nomeFundo = row.nome_fundo ?? null;
  const fundChar = await fetchFundCharacteristics(cleanCnpj, fundoIsin, nomeFundo);
  const va = Number(row.fundo_valorativos ?? 0) || 0;
  const vr = Number(row.fundo_valorreceber ?? 0) || 0;
  const vp = Number(row.fundo_valorpagar ?? 0) || 0;
  const vlc = Number(row.fundo_vlcotasresgatar ?? 0) || 0;
  const isFidc = isFundoFidcNivel1(fundChar?.nivel1_categoria);
  const usaVaVr = isFidc && fundChar?.pl_formula === 'va_vr';

  if (usaVaVr) {
    const plFidc = calcPlFidcHeader(va, vr);
    if (plFidc > 0) {
      return { patliq: plFidc, origem_pl_utilizada: 'fidc_header_va_vr', nome_fundo: nomeFundo };
    }
  } else if (isFidc) {
    const plHeader = calcPlHeaderAnbima(va, vr, vp, vlc);
    if (
      plHeader > 0 &&
      vr > PL_RECEBER_MIN_DIFF &&
      plHeader - patliqXml > PL_RECEBER_MIN_DIFF &&
      plHeader > patliqXml * 1.05
    ) {
      return { patliq: plHeader, origem_pl_utilizada: 'fidc_header_anbima', nome_fundo: nomeFundo };
    }
  }

  return { patliq: patliqXml, origem_pl_utilizada: 'pl_atual_xml', nome_fundo: nomeFundo };
}

function getPreviousMonthBounds(fundoDtposicao: string): { start: string; end: string; competencia: string } {
  const year = parseInt(fundoDtposicao.slice(0, 4), 10);
  const month = parseInt(fundoDtposicao.slice(4, 6), 10);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const competencia = `${prevYear}${String(prevMonth).padStart(2, '0')}`;
  const lastDay = new Date(prevYear, prevMonth, 0).getDate();
  return {
    start: `${competencia}01`,
    end: `${competencia}${String(lastDay).padStart(2, '0')}`,
    competencia,
  };
}

async function findLatestPosicaoDateInRange(
  fundoCnpj: string,
  start: string,
  end: string,
  fundoIsin: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('posicao_carteira')
    .select('fundo_dtposicao')
    .eq('fundo_cnpj', fundoCnpj)
    .eq('fundo_isin', fundoIsin)
    .gte('fundo_dtposicao', start)
    .lte('fundo_dtposicao', end)
    .order('fundo_dtposicao', { ascending: false })
    .limit(1);
  return (data?.[0] as { fundo_dtposicao?: string } | undefined)?.fundo_dtposicao ?? null;
}

async function resolvePlByOrigem(
  fundoCnpj: string,
  fundoDtposicao: string,
  fundoIsin: string,
  origemPl: string,
): Promise<{
  patliq: number;
  origem_pl_utilizada: string;
  data_pl_referencia?: string;
  competencia_pl_referencia?: string;
  origem_pl_fallback?: boolean;
  motivo_fallback?: string;
  nome_fundo?: string | null;
}> {
  if (origemPl === 'pl_atual_xml') {
    const r = await resolvePlAtualXml(fundoCnpj, fundoDtposicao, fundoIsin);
    return { ...r, origem_pl_utilizada: 'pl_atual_xml' };
  }

  const { start, end, competencia } = getPreviousMonthBounds(fundoDtposicao);
  const refDate = await findLatestPosicaoDateInRange(fundoCnpj, start, end, fundoIsin);
  if (refDate) {
    const r = await resolvePlAtualXml(fundoCnpj, refDate, fundoIsin);
    return {
      ...r,
      origem_pl_utilizada: 'pl_mes_anterior_posicao',
      data_pl_referencia: refDate,
      competencia_pl_referencia: competencia,
    };
  }

  const fallback = await resolvePlAtualXml(fundoCnpj, fundoDtposicao, fundoIsin);
  return {
    ...fallback,
    origem_pl_utilizada: 'pl_mes_anterior_posicao',
    origem_pl_fallback: true,
    competencia_pl_referencia: competencia,
    motivo_fallback: `Sem posição importada entre ${start} e ${end}`,
  };
}

function sumPlForIsins(plMap: Map<string, number>, isins: string[]): number {
  return isins.reduce((sum, isin) => sum + (plMap.get(isin) ?? 0), 0);
}

function calcSubordinacao(
  params: SubordinacaoParams,
  plMap: Map<string, number>,
): {
  pl_jr: number;
  pl_mez: number;
  pl_sr: number;
  pl_classe: number;
  numerador: number;
  indice: number;
  status: RuleStatus;
  excesso_cobertura: number;
} {
  const pl_jr = sumPlForIsins(plMap, params.series.jr);
  const pl_mez = sumPlForIsins(plMap, params.series.mez);
  const pl_sr = sumPlForIsins(plMap, params.series.senior);
  const pl_classe = pl_jr + pl_mez + pl_sr;
  const numerador = params.composicao_numerador === 'jr' ? pl_jr : pl_jr + pl_mez;
  const indice = pl_classe > 0 ? numerador / pl_classe : 0;

  let status: RuleStatus = 'ok';
  if (pl_classe <= 0) {
    status = 'alerta';
  } else if (indice < params.limite_min) {
    status = 'violacao';
  } else if (indice < params.limite_alerta) {
    status = 'alerta';
  }

  const excesso_cobertura = Math.max(0, numerador - params.limite_min * pl_classe);
  return { pl_jr, pl_mez, pl_sr, pl_classe, numerador, indice, status, excesso_cobertura };
}

async function saveResults(
  fundo_cnpj: string,
  fundo_isin: string,
  fundo_dtposicao: string,
  results: RuleResult[],
): Promise<void> {
  await supabase
    .from('enquadramento_resultado')
    .delete()
    .eq('fundo_cnpj', fundo_cnpj)
    .eq('fundo_isin', fundo_isin)
    .eq('fundo_dtposicao', fundo_dtposicao)
    .eq('regra_categoria', CATEGORIA);

  if (results.length === 0) return;

  const records = results.map((r) => ({
    fundo_cnpj,
    fundo_isin,
    fundo_dtposicao,
    regra_categoria: CATEGORIA,
    regra_codigo: r.regra_codigo,
    regra_descricao: r.regra_descricao,
    status: r.status,
    valor_atual: r.valor_atual,
    valor_limite: r.valor_limite,
    detalhes: r.detalhes || null,
  }));

  const { error } = await supabase
    .from('enquadramento_resultado')
    .upsert(records, { onConflict: 'fundo_cnpj,fundo_isin,fundo_dtposicao,regra_codigo' });

  if (error) throw error;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body: RuleCheckRequest = await req.json();
    const { fundo_cnpj, fundo_isin: fundo_isin_req, fundo_dtposicao } = body;
    const fundo_isin = fundo_isin_req ?? '';

    if (!fundo_cnpj || !fundo_dtposicao) {
      return new Response(
        JSON.stringify({ success: false, error: 'fundo_cnpj and fundo_dtposicao are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (!fundo_isin) {
      console.log(`${LOG_PREFIX} ISIN vazio — subordinação exige subclasse alvo`);
      await saveResults(normalizarCnpj(fundo_cnpj), fundo_isin, fundo_dtposicao, []);
      return new Response(
        JSON.stringify({ success: true, results: [] } as RuleCheckResponse),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const cleanCnpj = normalizarCnpj(fundo_cnpj);
    console.log(`${LOG_PREFIX} Verificando ${fundo_cnpj} isin=${fundo_isin} em ${fundo_dtposicao}`);

    const { data: fundRulesRaw, error: rulesError } = await supabase
      .from('fundo_regras')
      .select(`
        id, fundo_cnpj, fundo_isin, regra_id, ativo,
        regras_compliance (id, codigo, descricao, parametros)
      `)
      .eq('fundo_cnpj', cleanCnpj)
      .in('fundo_isin', fundoRegrasIsinQueryValues(fundo_isin))
      .eq('ativo', true)
      .eq('status_aprovacao', 'ativo');

    if (rulesError) throw rulesError;

    const fundRules = resolveFundoRegrasForIsin(fundRulesRaw, fundo_isin);
    const regrasEstrutura = (fundRules || []).filter((fr: any) => {
      const rule = Array.isArray(fr.regras_compliance) ? fr.regras_compliance[0] : fr.regras_compliance;
      return rule?.parametros?.tipo_regra === 'fidc_subordinacao';
    });

    if (regrasEstrutura.length === 0) {
      await saveResults(cleanCnpj, fundo_isin, fundo_dtposicao, []);
      return new Response(
        JSON.stringify({ success: true, results: [] } as RuleCheckResponse),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const results: RuleResult[] = [];

    for (const fr of regrasEstrutura as any[]) {
      const rule = Array.isArray(fr.regras_compliance) ? fr.regras_compliance[0] : fr.regras_compliance;
      if (!rule?.codigo) continue;

      const params = parseSubordinacaoParams((rule.parametros ?? {}) as Record<string, unknown>);
      if (!params) continue;

      if (!shouldRunOnIsin(fundo_isin, params)) {
        console.log(
          `${LOG_PREFIX} Skip ${rule.codigo}: isin ${fundo_isin} não é alvo (${params.classe_alvo})`,
        );
        continue;
      }

      const allIsins = [...new Set([
        ...params.series.jr,
        ...params.series.mez,
        ...params.series.senior,
      ])];

      if (allIsins.length === 0) {
        results.push({
          regra_codigo: rule.codigo,
          regra_descricao: rule.descricao ?? rule.codigo,
          status: 'alerta',
          valor_atual: null,
          valor_limite: params.limite_min,
          detalhes: {
            sem_dados: true,
            motivo: 'Nenhum ISIN configurado em series',
            classe_alvo: params.classe_alvo,
          },
        });
        continue;
      }

      const plPorIsin: Array<Record<string, unknown>> = [];
      const plMap = new Map<string, number>();

      for (const isin of allIsins) {
        const plResolved = await resolvePlByOrigem(
          fundo_cnpj,
          fundo_dtposicao,
          isin,
          params.origem_pl,
        );
        plMap.set(isin, plResolved.patliq);

        let papel: 'jr' | 'mez' | 'senior' = 'senior';
        if (params.series.jr.includes(isin)) papel = 'jr';
        else if (params.series.mez.includes(isin)) papel = 'mez';

        plPorIsin.push({
          isin,
          papel,
          pl: plResolved.patliq,
          nome: plResolved.nome_fundo ?? null,
          origem_pl: plResolved.origem_pl_utilizada,
          data_pl_referencia: plResolved.data_pl_referencia ?? null,
          competencia_pl_referencia: plResolved.competencia_pl_referencia ?? null,
          origem_pl_fallback: plResolved.origem_pl_fallback ?? false,
        });
      }

      const calc = calcSubordinacao(params, plMap);

      results.push({
        regra_codigo: rule.codigo,
        regra_descricao: rule.descricao ?? rule.codigo,
        status: calc.status,
        valor_atual: calc.indice,
        valor_limite: params.limite_min,
        detalhes: {
          pl_jr: calc.pl_jr,
          pl_mez: calc.pl_mez,
          pl_sr: calc.pl_sr,
          pl_classe: calc.pl_classe,
          numerador: calc.numerador,
          indice_calculado: calc.indice,
          limite_minimo: params.limite_min,
          limite_alerta: params.limite_alerta,
          excesso_cobertura: calc.excesso_cobertura,
          classe_alvo: params.classe_alvo,
          composicao_numerador: params.composicao_numerador,
          composicao_denominador: 'pl_classe',
          origem_pl: params.origem_pl,
          observacao: params.observacao ?? null,
          pl_por_isin: plPorIsin,
          series: params.series,
        },
      });
    }

    await saveResults(cleanCnpj, fundo_isin, fundo_dtposicao, results);

    return new Response(
      JSON.stringify({ success: true, results } as RuleCheckResponse),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error(`${LOG_PREFIX} Erro:`, error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
