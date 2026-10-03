import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// --- Tipos inline (boilerplate obrigatório: Supabase não suporta imports relativos) ---

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

interface EstoqueFidcRow {
  id: string;
  import_id: string;
  doc_fundo: string | null;
  nome_fundo: string | null;
  data_referencia: string | null;
  nome_cedente: string | null;
  doc_cedente: string | null;
  nome_sacado: string | null;
  doc_sacado: string | null;
  valor_nominal: number | null;
  valor_presente: number | null;
  valor_aquisicao: number | null;
  valor_pdd: number | null;
  coobrigacao: string | null;
  situacao_recebivel: string | null;
  seu_numero: string | null;
  nu_documento: string | null;
}

interface MembroGrupo {
  cnpj: string;
  nome: string;
}

interface GrupoConcentracao {
  chave: string;
  identificador: string;
  nome: string;
  exposicao: number;
  pdd_abatido?: number;
  is_grupo_economico?: boolean;
  membros?: MembroGrupo[];
}

interface GrupoEconomicoEntry {
  grupo_id: string;
  grupo_nome: string;
}

/** cnpj (14 dígitos) → entrada do grupo econômico */
type GrupoEconomicoMap = Map<string, GrupoEconomicoEntry>;

interface ExcecaoSacadoConfig {
  chave?: string;
  documento?: string | null;
  nome?: string | null;
  modo?: 'ignorar' | 'limite_customizado';
  limite_max?: number | null;
}

// Situações que indicam recebível não apto para cálculo de concentração
const SITUACOES_EXCLUIDAS = ['INADIMPLENTE', 'LITIGIOSO', 'PROTESTADO', 'COBRAN'];

const TIPOS_CONCENTRACAO = [
  'CONCENTRACAO_DEVEDOR',
  'CONCENTRACAO_CEDENTE',
  'CONCENTRACAO_SEM_COOBRIGACAO',
] as const;

type TipoConcentracao = typeof TIPOS_CONCENTRACAO[number];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// --- Funções utilitárias ---

function normalizarCnpj(cnpj: string | null | undefined): string {
  return (cnpj || '').replace(/\D/g, '');
}

function normalizarChaveContraparte(documento: string | null | undefined, nome: string | null | undefined): string {
  return normalizarCnpj(documento) || (nome || '').trim().toUpperCase() || 'SEM_IDENTIFICADOR';
}

/**
 * Carrega todos os registros ativos de grupos_economicos_cnpj e retorna
 * um Map de cnpj → { grupo_id, grupo_nome }.
 * Se a tabela estiver vazia ou ocorrer erro, retorna Map vazio (degradação segura).
 */
async function carregarGruposEconomicos(): Promise<GrupoEconomicoMap> {
  const map: GrupoEconomicoMap = new Map();
  try {
    const { data, error } = await supabase
      .from('grupos_economicos_cnpj')
      .select('cnpj, grupo_id, grupo_nome')
      .eq('ativo', true);
    if (error) {
      console.warn('[rules-fidc-concentracao] Aviso ao carregar grupos econômicos:', error.message);
      return map;
    }
    for (const row of (data || []) as any[]) {
      const cnpjLimpo = normalizarCnpj(row.cnpj);
      if (cnpjLimpo) {
        map.set(cnpjLimpo, { grupo_id: row.grupo_id, grupo_nome: row.grupo_nome });
      }
    }
  } catch (err) {
    console.warn('[rules-fidc-concentracao] Erro inesperado ao carregar grupos econômicos:', err);
  }
  return map;
}

/**
 * Resolve a chave e nome de agrupamento para um cedente/sacado.
 * Se o CNPJ estiver mapeado em grupoMap, usa grupo_id como chave
 * e grupo_nome como nome — consolidando todas as empresas do grupo.
 * Caso contrário, comportamento padrão por CNPJ/nome individual.
 */
function resolverGrupo(
  documento: string | null | undefined,
  nome: string | null | undefined,
  grupoMap: GrupoEconomicoMap,
): { chave: string; nome: string; isGrupoEconomico: boolean } {
  const cnpjLimpo = normalizarCnpj(documento);
  const entrada = cnpjLimpo ? grupoMap.get(cnpjLimpo) : undefined;
  if (entrada) {
    return { chave: entrada.grupo_id, nome: entrada.grupo_nome, isGrupoEconomico: true };
  }
  return {
    chave: normalizarChaveContraparte(documento, nome),
    nome: (nome || '').trim() || documento || 'Sem identificação',
    isGrupoEconomico: false,
  };
}

/**
 * Normaliza o campo coobrigação para boolean.
 * Retorna null quando o valor é indeterminado ou ausente.
 */
function normalizarCoobrigacao(valor: string | null | undefined): boolean | null {
  const v = (valor || '').toString().toUpperCase().trim();
  if (['SIM', 'S', 'COM', 'TRUE', '1', 'YES', 'COM COOBRIGAÇÃO', 'COM COOBRIGACAO'].includes(v)) {
    return true;
  }
  if ([
    'NÃO', 'NAO', 'N', 'SEM', 'FALSE', '0', 'NO',
    'SEM COOBRIGAÇÃO', 'SEM COOBRIGACAO',
    'NÃO POSSUI', 'NAO POSSUI',
  ].includes(v)) {
    return false;
  }
  return null;
}

/** Retorna o valor de exposição bruta de acordo com o parâmetro base_calculo. */
function getExposicao(row: EstoqueFidcRow, baseCalculo: string): number {
  switch (baseCalculo) {
    case 'valor_nominal':   return row.valor_nominal   ?? 0;
    case 'valor_aquisicao': return row.valor_aquisicao ?? 0;
    default:                return row.valor_presente  ?? 0;
  }
}

/**
 * Retorna a exposição líquida considerando PDD quando configurado.
 * exposicao_liquida = max(base_calculo - valor_pdd, 0) se usarAbatimentoPdd=true
 */
function getExposicaoLiquida(row: EstoqueFidcRow, baseCalculo: string, usarAbatimentoPdd: boolean): number {
  const base = getExposicao(row, baseCalculo);
  if (!usarAbatimentoPdd) return base;
  const pdd = row.valor_pdd ?? 0;
  return Math.max(base - pdd, 0);
}

/** Retorna o valor de PDD efetivamente abatido na exposição (quando usarAbatimentoPdd=true). */
function getPddAbatido(row: EstoqueFidcRow, baseCalculo: string, usarAbatimentoPdd: boolean): number {
  if (!usarAbatimentoPdd) return 0;
  const base = getExposicao(row, baseCalculo);
  const pdd = row.valor_pdd ?? 0;
  return Math.min(base, pdd);
}

/** Filtra recebíveis inválidos para o cálculo (sem doc_fundo, sem data, sem valor, inadimplentes). */
function filtrarRecebiveis(
  rows: EstoqueFidcRow[],
  baseCalculo: string,
  usarAbatimentoPdd: boolean,
): { validos: EstoqueFidcRow[]; excluidos: number } {
  let excluidos = 0;
  const validos = rows.filter((r) => {
    if (!r.doc_fundo) { excluidos++; return false; }
    if (!r.data_referencia) { excluidos++; return false; }
    const valor = getExposicaoLiquida(r, baseCalculo, usarAbatimentoPdd);
    if (valor <= 0) { excluidos++; return false; }
    const situacao = (r.situacao_recebivel || '').toUpperCase().trim();
    if (SITUACOES_EXCLUIDAS.some((s) => situacao.includes(s))) { excluidos++; return false; }
    return true;
  });
  return { validos, excluidos };
}

/**
 * Remove duplicatas usando seu_numero como chave preferencial,
 * com fallback para nu_documento. Registros sem nenhuma chave são
 * mantidos mas contados em baixaQualidade.
 */
function deduplicarEstoque(
  rows: EstoqueFidcRow[],
): { dedup: EstoqueFidcRow[]; baixaQualidade: number } {
  const seen = new Set<string>();
  const dedup: EstoqueFidcRow[] = [];
  let baixaQualidade = 0;

  for (const r of rows) {
    const chave = (r.seu_numero || '').trim() || (r.nu_documento || '').trim();
    if (!chave) {
      baixaQualidade++;
      dedup.push(r);
      continue;
    }
    const key = `${normalizarCnpj(r.doc_fundo)}|${r.data_referencia}|${chave}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedup.push(r);
    }
  }
  return { dedup, baixaQualidade };
}

/** Agrupa exposição por sacado (considerando grupo econômico) e retorna ordenado do maior para o menor. */
function calcularConcentracaoPorSacado(
  rows: EstoqueFidcRow[],
  baseCalculo: string,
  usarAbatimentoPdd: boolean,
  grupoMap: GrupoEconomicoMap,
): GrupoConcentracao[] {
  const grupos = new Map<string, GrupoConcentracao>();
  for (const r of rows) {
    const { chave: chaveGrupo, nome, isGrupoEconomico } = resolverGrupo(r.doc_sacado, r.nome_sacado, grupoMap);
    const exposicao = getExposicaoLiquida(r, baseCalculo, usarAbatimentoPdd);
    const pddAbatido = getPddAbatido(r, baseCalculo, usarAbatimentoPdd);
    const cnpjLimpo = normalizarCnpj(r.doc_sacado);

    const existing = grupos.get(chaveGrupo);
    if (existing) {
      existing.exposicao += exposicao;
      existing.pdd_abatido = (existing.pdd_abatido ?? 0) + pddAbatido;
      if (!existing.identificador && r.doc_sacado) existing.identificador = r.doc_sacado;
      if (cnpjLimpo && existing.membros && !existing.membros.some((m) => m.cnpj === cnpjLimpo)) {
        existing.membros.push({ cnpj: cnpjLimpo, nome: r.nome_sacado?.trim() || cnpjLimpo });
      }
    } else {
      grupos.set(chaveGrupo, {
        chave: chaveGrupo,
        identificador: isGrupoEconomico ? chaveGrupo : (r.doc_sacado || chaveGrupo),
        nome,
        exposicao,
        pdd_abatido: pddAbatido,
        is_grupo_economico: isGrupoEconomico,
        membros: cnpjLimpo ? [{ cnpj: cnpjLimpo, nome: r.nome_sacado?.trim() || cnpjLimpo }] : [],
      });
    }
  }
  return Array.from(grupos.values()).sort((a, b) => b.exposicao - a.exposicao);
}

/** Agrupa exposição por cedente (considerando grupo econômico) e retorna ordenado do maior para o menor. */
function calcularConcentracaoPorCedente(
  rows: EstoqueFidcRow[],
  baseCalculo: string,
  usarAbatimentoPdd: boolean,
  grupoMap: GrupoEconomicoMap,
): GrupoConcentracao[] {
  const grupos = new Map<string, GrupoConcentracao>();
  for (const r of rows) {
    const { chave: chaveGrupo, nome, isGrupoEconomico } = resolverGrupo(r.doc_cedente, r.nome_cedente, grupoMap);
    const exposicao = getExposicaoLiquida(r, baseCalculo, usarAbatimentoPdd);
    const pddAbatido = getPddAbatido(r, baseCalculo, usarAbatimentoPdd);
    const cnpjLimpo = normalizarCnpj(r.doc_cedente);

    const existing = grupos.get(chaveGrupo);
    if (existing) {
      existing.exposicao += exposicao;
      existing.pdd_abatido = (existing.pdd_abatido ?? 0) + pddAbatido;
      if (!existing.identificador && r.doc_cedente) existing.identificador = r.doc_cedente;
      if (cnpjLimpo && existing.membros && !existing.membros.some((m) => m.cnpj === cnpjLimpo)) {
        existing.membros.push({ cnpj: cnpjLimpo, nome: r.nome_cedente?.trim() || cnpjLimpo });
      }
    } else {
      grupos.set(chaveGrupo, {
        chave: chaveGrupo,
        identificador: isGrupoEconomico ? chaveGrupo : (r.doc_cedente || chaveGrupo),
        nome,
        exposicao,
        pdd_abatido: pddAbatido,
        is_grupo_economico: isGrupoEconomico,
        membros: cnpjLimpo ? [{ cnpj: cnpjLimpo, nome: r.nome_cedente?.trim() || cnpjLimpo }] : [],
      });
    }
  }
  return Array.from(grupos.values()).sort((a, b) => b.exposicao - a.exposicao);
}

/** Soma exposição de todos os recebíveis sem coobrigação. */
function calcularSemCoobrigacao(
  rows: EstoqueFidcRow[],
  baseCalculo: string,
  usarAbatimentoPdd: boolean,
  grupoMap: GrupoEconomicoMap,
): { total: number; qtd: number; indeterminados: number; gruposCedente: GrupoConcentracao[] } {
  let total = 0;
  let qtd = 0;
  let indeterminados = 0;
  const rowsSemCoobrigacao: EstoqueFidcRow[] = [];

  for (const r of rows) {
    const coobr = normalizarCoobrigacao(r.coobrigacao);
    if (coobr === false) {
      total += getExposicaoLiquida(r, baseCalculo, usarAbatimentoPdd);
      qtd++;
      rowsSemCoobrigacao.push(r);
    } else if (coobr === null) {
      indeterminados++;
    }
  }

  return {
    total,
    qtd,
    indeterminados,
    gruposCedente: calcularConcentracaoPorCedente(rowsSemCoobrigacao, baseCalculo, usarAbatimentoPdd, grupoMap),
  };
}

/** Avalia se o percentual apurado está dentro dos limites da regra. */
function avaliarRegra(
  percentual: number,
  limiteMin: number | null,
  limiteMax: number | null,
): RuleStatus {
  if (limiteMax != null && percentual > limiteMax) return 'violacao';
  if (limiteMin != null && percentual < limiteMin) return 'violacao';
  return 'ok';
}

/**
 * Normaliza limites armazenados no parametros JSONB.
 * Valores >= 2 são tratados como percentual inteiro (ex: 5 → 0.05).
 */
function normalizarLimite(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return n >= 2 ? n / 100 : n;
}

function getExcecoesSacadoDoFundo(
  params: Record<string, unknown>,
  fundoCnpj: string,
): ExcecaoSacadoConfig[] {
  const mapa = params.excecoes_sacado_por_fundo as Record<string, ExcecaoSacadoConfig[]> | undefined;
  if (!mapa) return [];
  const cleanKey = normalizarCnpj(fundoCnpj);
  if (!cleanKey) return [];
  // Busca direta
  const direct = mapa[cleanKey];
  if (direct && Array.isArray(direct)) return direct;
  // Fallback: chave pode estar formatada (ex: 54.969.186/0001-10)
  for (const key of Object.keys(mapa)) {
    if (normalizarCnpj(key) === cleanKey) return (mapa[key] as ExcecaoSacadoConfig[]) || [];
  }
  return [];
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
function pickBestFundChar<T extends { nome_comercial?: string | null; isin?: string | null; nivel1_categoria?: string | null; pl_formula?: string | null }>(
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
    .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo')
    .limit(50);
  return pickBestFundChar(fundCharRows, fundoIsin, nomeFundo);
}

async function resolvePlAtualXml(
  fundoCnpj: string,
  fundoDtposicao: string,
  fundoIsinOverride?: string,
): Promise<{ patliq: number; origem_pl_utilizada: string }> {
  const cleanCnpj = normalizarCnpj(fundoCnpj);
  let posQuery = supabase
    .from('posicao_carteira')
    .select('fundo_patliq, fundo_valorativos, fundo_valorreceber, fundo_valorpagar, fundo_vlcotasresgatar, nome_fundo, fundo_isin')
    .eq('fundo_cnpj', fundoCnpj)
    .eq('fundo_dtposicao', fundoDtposicao);
  if (fundoIsinOverride) posQuery = posQuery.eq('fundo_isin', fundoIsinOverride);
  const { data: posicaoRows } = await posQuery.limit(1);
  const row = (posicaoRows?.[0] as PatliqHeaderFields & { fundo_patliq?: number | null; nome_fundo?: string | null; fundo_isin?: string | null }) ?? {};
  const patliqXml: number = Number(row.fundo_patliq ?? 0) || 0;
  const nomeFundo: string | null = row.nome_fundo ?? null;
  const fundoIsinFromRow: string | null = row.fundo_isin ?? null;
  const effectiveIsin = fundoIsinOverride || fundoIsinFromRow || undefined;

  const fundChar = await fetchFundCharacteristics(cleanCnpj, effectiveIsin, nomeFundo);

  const va = Number(row.fundo_valorativos ?? 0) || 0;
  const vr = Number(row.fundo_valorreceber ?? 0) || 0;
  const vp = Number(row.fundo_valorpagar ?? 0) || 0;
  const vlc = Number(row.fundo_vlcotasresgatar ?? 0) || 0;

  const isFidc = isFundoFidcNivel1(fundChar?.nivel1_categoria);
  const usaVaVr = isFidc && fundChar?.pl_formula === 'va_vr';

  // Aplica va+vr SOMENTE quando pl_formula = 'va_vr' (modo Nexum JR).
  if (usaVaVr) {
    const plFidc = calcPlFidcHeader(va, vr);
    if (plFidc > 0) {
      // Quando pl_formula='va_vr', sempre usa va+vr e ignora fundo_patliq do XML.
      return { patliq: plFidc, origem_pl_utilizada: 'fidc_header' };
    }
  } else if (isFidc) {
    const plHeader = calcPlHeaderAnbima(va, vr, vp, vlc);
    if (
      plHeader > 0 &&
      vr > PL_RECEBER_MIN_DIFF &&
      plHeader - patliqXml > PL_RECEBER_MIN_DIFF &&
      plHeader > patliqXml * 1.05
    ) {
      return { patliq: plHeader, origem_pl_utilizada: 'fidc_header' };
    }
  }

  return { patliq: patliqXml, origem_pl_utilizada: 'pl_atual_xml' };
}

/** Limites YYYYMMDD do mês imediatamente anterior à data de posição. */
function getPreviousMonthBounds(fundoDtposicao: string): {
  start: string;
  end: string;
  competencia: string;
} {
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

/** Última data com posição importada no intervalo (fechamento operacional do mês). */
async function findLatestPosicaoDateInRange(
  fundoCnpj: string,
  start: string,
  end: string,
  fundoIsin?: string,
): Promise<string | null> {
  let query = supabase
    .from('posicao_carteira')
    .select('fundo_dtposicao')
    .eq('fundo_cnpj', fundoCnpj)
    .gte('fundo_dtposicao', start)
    .lte('fundo_dtposicao', end)
    .order('fundo_dtposicao', { ascending: false })
    .limit(1);
  if (fundoIsin) query = query.eq('fundo_isin', fundoIsin);
  const { data } = await query;
  return (data?.[0] as { fundo_dtposicao?: string } | undefined)?.fundo_dtposicao ?? null;
}

type PatliqByOrigemResult = {
  patliq: number;
  origem_pl_utilizada: string;
  origem_pl_fallback: boolean;
  pl_sub_origem?: string;
  data_pl_referencia?: string;
  competencia_pl_referencia?: string;
  competencia_informe_pl?: string;
  motivo_fallback?: string;
};

/**
 * PL de fechamento do mês anterior via posicao_carteira (default recomendado).
 * Usa a última data importada no mês anterior; aplica pl_formula (ex.: va_vr) da subclasse.
 */
async function resolvePlMesAnteriorPosicao(
  fundoCnpj: string,
  fundoDtposicao: string,
  fundoIsin?: string,
): Promise<PatliqByOrigemResult> {
  const { start, end, competencia } = getPreviousMonthBounds(fundoDtposicao);
  const refDate = await findLatestPosicaoDateInRange(fundoCnpj, start, end, fundoIsin);

  if (refDate) {
    const resolved = await resolvePlAtualXml(fundoCnpj, refDate, fundoIsin);
    return {
      patliq: resolved.patliq,
      origem_pl_utilizada: 'pl_mes_anterior_posicao',
      pl_sub_origem: resolved.origem_pl_utilizada,
      origem_pl_fallback: false,
      data_pl_referencia: refDate,
      competencia_pl_referencia: competencia,
    };
  }

  // Sem posição no mês anterior → PL do dia (com ajuste FIDC se aplicável)
  const fallback = await resolvePlAtualXml(fundoCnpj, fundoDtposicao, fundoIsin);
  return {
    patliq: fallback.patliq,
    origem_pl_utilizada: 'pl_mes_anterior_posicao',
    pl_sub_origem: fallback.origem_pl_utilizada,
    origem_pl_fallback: true,
    competencia_pl_referencia: competencia,
    motivo_fallback: `Sem posição importada entre ${start} e ${end}`,
  };
}

/**
 * Busca o PL do fundo conforme a origem configurada na regra.
 * - pl_mes_anterior_posicao (default): última posicao_carteira do mês anterior + pl_formula
 * - pl_atual_xml: PL do dia da verificação
 * - pl_mes_anterior_informe_mensal: fidc_informe_mensal_import (legado); fallback posição do dia
 */
async function getPatliqByOrigem(
  fundoCnpj: string,
  fundoDtposicao: string,
  origemPl: string,
  fundoIsin?: string,
): Promise<PatliqByOrigemResult> {
  if (origemPl === 'pl_mes_anterior_posicao') {
    return resolvePlMesAnteriorPosicao(fundoCnpj, fundoDtposicao, fundoIsin);
  }

  if (origemPl === 'pl_atual_xml') {
    const resolved = await resolvePlAtualXml(fundoCnpj, fundoDtposicao, fundoIsin);
    return {
      patliq: resolved.patliq,
      origem_pl_utilizada: resolved.origem_pl_utilizada,
      origem_pl_fallback: false,
    };
  }

  if (origemPl !== 'pl_mes_anterior_informe_mensal') {
    const resolved = await resolvePlAtualXml(fundoCnpj, fundoDtposicao, fundoIsin);
    return {
      patliq: resolved.patliq,
      origem_pl_utilizada: resolved.origem_pl_utilizada,
      origem_pl_fallback: false,
    };
  }

  const { patliq: patliqXml, origem_pl_utilizada: origemXml } = await resolvePlAtualXml(
    fundoCnpj,
    fundoDtposicao,
    fundoIsin,
  );

  // Derivar competência imediatamente anterior (YYYYMM)
  const { competencia } = getPreviousMonthBounds(fundoDtposicao);
  const cleanCnpj = normalizarCnpj(fundoCnpj);

  const { data: informeRows } = await supabase
    .from('fidc_informe_mensal_import')
    .select('pl, cnpj_fundo_classe')
    .eq('competencia_yyyymm', competencia)
    .eq('origem_tabela', 'TAB_IV_PARTE_A')
    .eq('cnpj_fundo_classe', cleanCnpj)
    .not('pl', 'is', null)
    .order('linha_arquivo', { ascending: true })
    .limit(5);

  const matchRow = (informeRows || [])[0] as { pl?: number | null } | undefined;

  if (matchRow && matchRow.pl != null && Number(matchRow.pl) > 0) {
    return {
      patliq: Number(matchRow.pl),
      origem_pl_utilizada: 'pl_mes_anterior_informe_mensal',
      origem_pl_fallback: false,
      competencia_informe_pl: competencia,
    };
  }

  return {
    patliq: patliqXml,
    origem_pl_utilizada: origemXml,
    origem_pl_fallback: true,
    competencia_informe_pl: competencia,
    motivo_fallback: 'Informe mensal não encontrado',
  };
}

/**
 * Persiste resultados em enquadramento_resultado usando delete + upsert.
 * O delete garante que resultados de execuções anteriores para a mesma
 * categoria não persistam quando regras são removidas ou alteradas.
 */
async function saveResults(
  fundo_cnpj: string,
  fundo_isin: string,
  fundo_dtposicao: string,
  results: RuleResult[],
): Promise<void> {
  const CATEGORIA = 'fidc-concentracao';

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

// --- Handler principal ---

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

    const LOG_PREFIX = '[rules-fidc-concentracao]';
    const executionLogs: string[] = [];
    const log = (msg: string) => {
      console.log(`${LOG_PREFIX} ${msg}`);
      executionLogs.push(msg);
    };

    log(`Iniciando para fundo ${fundo_cnpj} em ${fundo_dtposicao}`);

    const cleanCnpj = normalizarCnpj(fundo_cnpj);

    // 2. Carregar regras de concentração FIDC ativas associadas ao fundo
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

    const fundRules = resolveFundoRegrasForIsin(fundRulesRaw, fundo_isin);

    if (rulesError) {
      log(`Erro ao carregar regras: ${rulesError.message}`);
    }

    const regrasFidc = (fundRules || []).filter((fr: any) => {
      const rule = Array.isArray(fr.regras_compliance) ? fr.regras_compliance[0] : fr.regras_compliance;
      const params = rule?.parametros as Record<string, unknown> | undefined;
      return params?.tipo_regra && TIPOS_CONCENTRACAO.includes(params.tipo_regra as TipoConcentracao);
    });

    log(`Regras de concentração FIDC encontradas: ${regrasFidc.length}`);

    if (regrasFidc.length === 0) {
      await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, []);
      return new Response(
        JSON.stringify({ success: true, results: [] } as RuleCheckResponse),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 3. Carregar mapa de grupos econômicos (único fetch, compartilhado por todas as regras)
    const grupoMap = await carregarGruposEconomicos();
    log(`Grupos econômicos carregados: ${grupoMap.size} CNPJs mapeados`);

    // 4. Encontrar o import de estoque FIDC mais recente válido para o fundo/período.
    // Sem janela fixa: o estoque pode ser importado em qualquer frequência (diária, semanal
    // ou sob demanda), portanto buscamos simplesmente o import mais recente com
    // reference_date <= data_posicao, independentemente de quando foi gerado.
    const dtIso = `${fundo_dtposicao.slice(0, 4)}-${fundo_dtposicao.slice(4, 6)}-${fundo_dtposicao.slice(6, 8)}`;

    const { data: imports } = await supabase
      .from('importacoes_estoque_fidc')
      .select('id, fund_document, reference_date, status')
      .in('status', ['success', 'partial_success'])
      .lte('reference_date', dtIso)
      .order('reference_date', { ascending: false })
      .limit(50);

    log(`Imports disponíveis até ${dtIso}: ${imports?.length ?? 0}`);

    // CNPJ pode estar formatado (12.345.678/0001-99) ou só dígitos — normaliza ambos
    const matchingImport = (imports || []).find((imp: any) => {
      const impCnpj = normalizarCnpj(imp.fund_document);
      return impCnpj === cleanCnpj;
    }) as any;

    if (!matchingImport) {
      log(`Nenhum import de estoque FIDC encontrado para ${fundo_cnpj} no período`);
      const results: RuleResult[] = regrasFidc.map((fr: any) => {
        const rule = Array.isArray(fr.regras_compliance) ? fr.regras_compliance[0] : fr.regras_compliance;
        return {
          regra_codigo: rule.codigo,
          regra_descricao: rule.descricao,
          status: 'alerta' as RuleStatus,
          valor_atual: null,
          valor_limite: null,
          detalhes: {
              sem_dados: true,
              motivo: `Nenhum estoque FIDC encontrado para o fundo até a data ${dtIso}`,
            logs: [...executionLogs],
          },
        };
      });
      await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, results);
      return new Response(
        JSON.stringify({ success: true, results } as RuleCheckResponse),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    log(`Import selecionado: ${matchingImport.id} (ref: ${matchingImport.reference_date})`);

    // 4. Carregar os recebíveis do import selecionado
    const { data: estoqueRaw, error: estoqueError } = await supabase
      .from('estoque_fidc')
      .select([
        'id', 'import_id', 'doc_fundo', 'nome_fundo', 'data_referencia',
        'nome_cedente', 'doc_cedente', 'nome_sacado', 'doc_sacado',
        'valor_nominal', 'valor_presente', 'valor_aquisicao', 'valor_pdd',
        'coobrigacao', 'situacao_recebivel', 'seu_numero', 'nu_documento',
      ].join(', '))
      .eq('import_id', matchingImport.id);

    if (estoqueError) {
      throw new Error(`Erro ao carregar estoque_fidc: ${estoqueError.message}`);
    }

    log(`Recebíveis carregados do import: ${estoqueRaw?.length ?? 0}`);

    const rowsAll = (estoqueRaw || []) as EstoqueFidcRow[];

    // 5. Avaliar cada regra de concentração
    const results: RuleResult[] = [];

    for (const fr of regrasFidc as any[]) {
      const rule = Array.isArray(fr.regras_compliance) ? fr.regras_compliance[0] : fr.regras_compliance;
      if (!rule) continue;

      const params = rule.parametros as Record<string, unknown>;
      const tipoRegra = params.tipo_regra as TipoConcentracao;
      const baseCalculo = (params.base_calculo as string) || 'valor_presente';
      // Compatibilidade retroativa: regras antigas sem esses campos usam defaults seguros
      const usarAbatimentoPdd: boolean = (params.usar_abatimento_pdd as boolean) ?? true;
      const origemPl: string = (params.origem_pl as string) || 'pl_mes_anterior_posicao';
      const limiteMin = normalizarLimite(params.limite_min);
      const limiteMax = normalizarLimite(params.limite_max);

      log(`Processando ${rule.codigo} (${tipoRegra}) | base=${baseCalculo} | pdd=${usarAbatimentoPdd} | pl=${origemPl} | min=${limiteMin} | max=${limiteMax}`);

      // Buscar PL conforme origem configurada na regra
      const {
        patliq,
        origem_pl_utilizada,
        origem_pl_fallback,
        pl_sub_origem,
        data_pl_referencia,
        competencia_pl_referencia,
        competencia_informe_pl,
        motivo_fallback,
      } = await getPatliqByOrigem(fundo_cnpj, fundo_dtposicao, origemPl, fundo_isin || undefined);

      log(
        `${rule.codigo}: PL=${patliq} (origem=${origem_pl_utilizada}, sub=${pl_sub_origem ?? '-'}, ` +
        `ref=${data_pl_referencia ?? '-'}, fallback=${origem_pl_fallback})`,
      );

      // Filtrar e deduplicar — feito por regra para respeitar base_calculo e PDD da regra
      const { validos, excluidos } = filtrarRecebiveis(rowsAll, baseCalculo, usarAbatimentoPdd);
      const { dedup, baixaQualidade } = deduplicarEstoque(validos);

      log(`${rule.codigo}: ${dedup.length} válidos | ${excluidos} excluídos | ${baixaQualidade} sem chave de dedup`);

      // Campos de auditoria comuns a todos os payloads desta regra
      const auditoriaPl = {
        usar_abatimento_pdd: usarAbatimentoPdd,
        origem_pl_configurada: origemPl,
        origem_pl_utilizada,
        origem_pl_fallback,
        ...(pl_sub_origem ? { pl_sub_origem } : {}),
        ...(data_pl_referencia ? { data_pl_referencia } : {}),
        ...(competencia_pl_referencia ? { competencia_pl_referencia } : {}),
        ...(competencia_informe_pl ? { competencia_informe_pl } : {}),
        ...(motivo_fallback ? { motivo_fallback } : {}),
      };

      // PL zero ou nulo → sem dados para calcular (não divide por zero)
      if (patliq <= 0) {
        log(`${rule.codigo}: PL zero ou nulo — resultado marcado como sem_dados`);
        results.push({
          regra_codigo: rule.codigo,
          regra_descricao: rule.descricao,
          status: 'alerta',
          valor_atual: null,
          valor_limite: limiteMax ?? limiteMin,
          detalhes: {
            sem_dados: true,
            motivo: 'PL do fundo é zero ou nulo para a data de posição',
            patliq,
            ...auditoriaPl,
            data_referencia_estoque: matchingImport.reference_date,
            base_calculo: baseCalculo,
            total_recebiveis: rowsAll.length,
            recebiveis_excluidos: excluidos,
            recebiveis_baixa_qualidade: baixaQualidade,
            logs: [...executionLogs],
          },
        });
        continue;
      }

      if (tipoRegra === 'CONCENTRACAO_DEVEDOR') {
        const grupos = calcularConcentracaoPorSacado(dedup, baseCalculo, usarAbatimentoPdd, grupoMap);
        const excecoes = getExcecoesSacadoDoFundo(params, cleanCnpj);
        const excecaoMap = new Map<string, ExcecaoSacadoConfig>();
        excecoes.forEach((item) => {
          const chave = String(
            item.chave ||
            normalizarChaveContraparte(item.documento || null, item.nome || null)
          );
          if (chave) excecaoMap.set(chave, item);
        });

        const sacadosIgnorados: typeof grupos = [];
        const gruposAvaliados = grupos
          .map((grupo) => {
            const excecao = excecaoMap.get(grupo.chave);
            if (excecao?.modo === 'ignorar') {
              sacadosIgnorados.push(grupo);
              return null;
            }
            const limiteAplicavel = excecao?.modo === 'limite_customizado'
              ? normalizarLimite(excecao.limite_max)
              : limiteMax;
            const percentualGrupo = grupo.exposicao / patliq;
            const statusGrupo = avaliarRegra(percentualGrupo, limiteMin, limiteAplicavel);
            return {
              ...grupo,
              limiteAplicavel,
              percentualGrupo,
              statusGrupo,
              modoExcecao: excecao?.modo || null,
            };
          })
          .filter((item): item is NonNullable<typeof item> => item !== null);

        const exposicaoTotal = gruposAvaliados.reduce((s, g) => s + g.exposicao, 0);
        const violador = gruposAvaliados.find((g) => g.statusGrupo === 'violacao') ?? null;
        const maiorGrupo = violador ?? gruposAvaliados[0] ?? null;
        const valorApurado = maiorGrupo?.exposicao ?? 0;
        const percentual = maiorGrupo?.percentualGrupo ?? 0;
        const status = violador ? 'violacao' : 'ok';
        const qtdDesenquadrados = gruposAvaliados.filter((g) => g.statusGrupo === 'violacao').length;

        log(`${rule.codigo}: maior devedor considerado="${maiorGrupo?.nome ?? '-'}" ${(percentual * 100).toFixed(2)}% → ${status} | exceções=${excecoes.length} | desenquadrados=${qtdDesenquadrados}`);

        results.push({
          regra_codigo: rule.codigo,
          regra_descricao: rule.descricao,
          status,
          valor_atual: percentual,
          valor_limite: maiorGrupo?.limiteAplicavel ?? limiteMax ?? limiteMin,
          detalhes: {
            patliq,
            ...auditoriaPl,
            total_investido: exposicaoTotal,
            categoria_alvo: 'Maior Devedor',
            limite_min: limiteMin,
            limite_max: limiteMax,
            data_referencia_estoque: matchingImport.reference_date,
            base_calculo: baseCalculo,
            total_recebiveis: rowsAll.length,
            recebiveis_excluidos: excluidos,
            recebiveis_baixa_qualidade: baixaQualidade,
            total_grupos: gruposAvaliados.length,
            qtd_desenquadrados: qtdDesenquadrados,
            qtd_excecoes_configuradas: excecoes.length,
            qtd_sacados_ignorados: excecoes.filter((e) => e.modo === 'ignorar').length,
            principal_ofensor: maiorGrupo
              ? {
                  nome: maiorGrupo.nome,
                  identificador: maiorGrupo.identificador,
                  exposicao: maiorGrupo.exposicao,
                  percentual_pl: percentual * 100,
                  limite_aplicavel: maiorGrupo.limiteAplicavel,
                  modo_excecao: maiorGrupo.modoExcecao,
                }
              : null,
            grupos_economicos_aplicados: grupoMap.size,
            // ativos_contabilizados usa o mesmo formato do RulesSheet para renderização automática
            ativos_contabilizados: gruposAvaliados.slice(0, 10).map((g) => ({
              nome: g.nome,
              cnpj: g.identificador,
              valor: g.exposicao,
              pdd_abatido: g.pdd_abatido ?? 0,
              percentual: g.exposicao / patliq,
              limite_aplicavel: g.limiteAplicavel,
              modo_excecao: g.modoExcecao,
              is_grupo_economico: g.is_grupo_economico ?? false,
              membros: g.membros ?? [],
            })),
            sacados_com_excecao: sacadosIgnorados.length > 0
              ? sacadosIgnorados.map((g) => ({
                  nome: g.nome,
                  cnpj: g.identificador,
                  valor: g.exposicao,
                  pdd_abatido: g.pdd_abatido ?? 0,
                  percentual: g.exposicao / patliq,
                  modo_excecao: 'ignorar' as const,
                  is_grupo_economico: g.is_grupo_economico ?? false,
                  membros: g.membros ?? [],
                }))
              : [],
          },
        });

      } else if (tipoRegra === 'CONCENTRACAO_CEDENTE') {
        const grupos = calcularConcentracaoPorCedente(dedup, baseCalculo, usarAbatimentoPdd, grupoMap);
        const exposicaoTotal = grupos.reduce((s, g) => s + g.exposicao, 0);
        const maiorGrupo = grupos[0] ?? null;
        const valorApurado = maiorGrupo?.exposicao ?? 0;
        const percentual = valorApurado / patliq;
        const status = avaliarRegra(percentual, limiteMin, limiteMax);
        const qtdDesenquadrados = limiteMax != null
          ? grupos.filter((g) => g.exposicao / patliq > limiteMax).length
          : 0;

        log(`${rule.codigo}: maior cedente="${maiorGrupo?.nome ?? '-'}" ${(percentual * 100).toFixed(2)}% → ${status} | desenquadrados=${qtdDesenquadrados}`);

        results.push({
          regra_codigo: rule.codigo,
          regra_descricao: rule.descricao,
          status,
          valor_atual: percentual,
          valor_limite: limiteMax ?? limiteMin,
          detalhes: {
            patliq,
            ...auditoriaPl,
            total_investido: exposicaoTotal,
            categoria_alvo: 'Maior Cedente/Emissor',
            limite_min: limiteMin,
            limite_max: limiteMax,
            data_referencia_estoque: matchingImport.reference_date,
            base_calculo: baseCalculo,
            total_recebiveis: rowsAll.length,
            recebiveis_excluidos: excluidos,
            recebiveis_baixa_qualidade: baixaQualidade,
            total_grupos: grupos.length,
            qtd_desenquadrados: qtdDesenquadrados,
            principal_ofensor: maiorGrupo
              ? {
                  nome: maiorGrupo.nome,
                  identificador: maiorGrupo.identificador,
                  exposicao: maiorGrupo.exposicao,
                  percentual_pl: percentual * 100,
                }
              : null,
            grupos_economicos_aplicados: grupoMap.size,
            ativos_contabilizados: grupos.slice(0, 10).map((g) => ({
              nome: g.nome,
              cnpj: g.identificador,
              valor: g.exposicao,
              pdd_abatido: g.pdd_abatido ?? 0,
              percentual: g.exposicao / patliq,
              limite_aplicavel: limiteMax,
              is_grupo_economico: g.is_grupo_economico ?? false,
              membros: g.membros ?? [],
            })),
          },
        });

      } else if (tipoRegra === 'CONCENTRACAO_SEM_COOBRIGACAO') {
        const { total, qtd, indeterminados, gruposCedente } = calcularSemCoobrigacao(dedup, baseCalculo, usarAbatimentoPdd, grupoMap);
        const percentual = total / patliq;
        const status = avaliarRegra(percentual, limiteMin, limiteMax);
        const principalCedente = gruposCedente[0] ?? null;

        log(`${rule.codigo}: sem coobrigação total=${total} (${qtd} ativos) ${(percentual * 100).toFixed(2)}% | indeterminados=${indeterminados} → ${status}`);

        results.push({
          regra_codigo: rule.codigo,
          regra_descricao: rule.descricao,
          status,
          valor_atual: percentual,
          valor_limite: limiteMax ?? limiteMin,
          detalhes: {
            patliq,
            ...auditoriaPl,
            total_investido: total,
            categoria_alvo: 'Sem Coobrigação',
            limite_min: limiteMin,
            limite_max: limiteMax,
            data_referencia_estoque: matchingImport.reference_date,
            base_calculo: baseCalculo,
            total_recebiveis: rowsAll.length,
            recebiveis_excluidos: excluidos,
            recebiveis_baixa_qualidade: baixaQualidade,
            qtd_ativos_sem_coobrigacao: qtd,
            qtd_ativos_coobrigacao_indeterminada: indeterminados,
            total_grupos: gruposCedente.length,
            principal_ofensor: principalCedente
              ? {
                  nome: principalCedente.nome,
                  identificador: principalCedente.identificador,
                  exposicao: principalCedente.exposicao,
                  percentual_pl: (principalCedente.exposicao / patliq) * 100,
                }
              : null,
            grupos_economicos_aplicados: grupoMap.size,
            ativos_contabilizados: gruposCedente.slice(0, 10).map((g) => ({
              nome: g.nome,
              cnpj: g.identificador,
              valor: g.exposicao,
              pdd_abatido: g.pdd_abatido ?? 0,
              percentual: g.exposicao / patliq,
              is_grupo_economico: g.is_grupo_economico ?? false,
              membros: g.membros ?? [],
            })),
          },
        });

      } else {
        log(`tipo_regra desconhecido ignorado: ${tipoRegra}`);
      }
    }

    await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, results);
    log(`${results.length} resultado(s) persistido(s)`);

    return new Response(
      JSON.stringify({ success: true, results } as RuleCheckResponse),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (error) {
    console.error('[rules-fidc-concentracao] Erro inesperado:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
