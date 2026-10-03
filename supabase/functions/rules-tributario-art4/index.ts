import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ============================================================
// Boilerplate obrigatório (autocontido — sem imports de _shared)
// ============================================================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

function cnpjStorageVariants(cnpj: string): string[] {
  const clean = String(cnpj).replace(/\D/g, '').padStart(14, '0');
  const formatted = formatCnpj(clean);
  return [...new Set([cnpj, clean, formatted])].filter(Boolean);
}

async function saveResults(
  fundo_cnpj: string,
  fundo_isin: string,
  fundo_dtposicao: string,
  categoria: string,
  results: RuleResult[],
) {
  const cleanCnpj = String(fundo_cnpj).replace(/\D/g, '').padStart(14, '0');
  const ymd8 = normalizeDtPos(fundo_dtposicao);
  const cnpjVariants = cnpjStorageVariants(fundo_cnpj);

  await supabase
    .from('enquadramento_resultado')
    .delete()
    .in('fundo_cnpj', cnpjVariants)
    .eq('fundo_isin', fundo_isin)
    .eq('fundo_dtposicao', ymd8)
    .eq('regra_categoria', categoria);

  if (results.length === 0) return;

  const records = results.map((r) => ({
    fundo_cnpj: cleanCnpj,
    fundo_isin,
    fundo_dtposicao: ymd8,
    regra_categoria: categoria,
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

interface RegraAssocTrib {
  codigo: string;
  parametros: Record<string, unknown>;
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

/** Art. 4º FIM — tipo_regra + variante fim (ou código legado TRIB_FIM_LP_365). */
async function resolveRegraArt4FimAssociada(
  cnpjVariants: string[],
  fundoIsin?: string | null,
): Promise<RegraAssocTrib | null> {
  const { data, error } = await supabase
    .from('fundo_regras')
    .select('fundo_isin, regra_id, regras_compliance (codigo, parametros)')
    .in('fundo_cnpj', cnpjVariants)
    .in('fundo_isin', fundoRegrasIsinQueryValues(fundoIsin))
    .eq('ativo', true)
    .eq('status_aprovacao', 'ativo');

  if (error) {
    console.warn(`[rules-tributario-art4] Erro ao consultar fundo_regras: ${error.message}`);
    return null;
  }

  const resolved = resolveFundoRegrasForIsin(
    (data || []) as { fundo_isin?: string | null; regra_id: string; regras_compliance: unknown }[],
    fundoIsin,
  );

  for (const fr of resolved) {
    const rule = Array.isArray((fr as any).regras_compliance)
      ? (fr as any).regras_compliance[0]
      : (fr as any).regras_compliance;
    const r = rule as { codigo?: string; parametros?: Record<string, unknown> } | null;
    if (!r?.codigo) continue;
    const p = (r.parametros ?? {}) as Record<string, unknown>;
    if (p.tipo_regra === 'tributario_prazo_medio_art4' && p.variante !== 'fidc') {
      return { codigo: r.codigo, parametros: p };
    }
    if (r.codigo === CODIGO_REGRA) {
      return { codigo: r.codigo, parametros: p };
    }
  }
  return null;
}

async function clearCategoryResults(
  fundo_cnpj: string,
  fundo_isin: string,
  fundo_dtposicao: string,
  categoria: string,
): Promise<void> {
  await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, categoria, []);
}

function buildNaoAplicavelResult(
  motivo: string,
  fundChar: FundCharProprio | null,
  totalPL: number,
): RuleResult {
  return {
    regra_codigo: CODIGO_REGRA,
    regra_descricao: `FIM: prazo médio tributário > ${LIMITE_DIAS}d (IN RFB 1585/2015 Art. 4º)`,
    status: 'alerta',
    valor_atual: null,
    valor_limite: 1,
    detalhes: {
      norma_nao_aplicavel: true,
      motivo,
      regra_sugerida: 'TRIB_FIQ_LP_90',
      nivel1_categoria: fundChar?.nivel1_categoria ?? null,
      composicao_fundo: fundChar?.composicao_fundo ?? null,
      patliq: totalPL,
    },
  };
}

// ============================================================
// Utilitários
// ============================================================
function normalizeDtPos(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw).trim().replace(/\D/g, '').slice(0, 8);
}

function expandFundoDtposicaoQueryVariants(raw: string | null | undefined): string[] {
  const ymd = normalizeDtPos(raw);
  const set = new Set<string>();
  const r = String(raw ?? '').trim();
  if (r) set.add(r);
  if (ymd.length === 8) {
    set.add(ymd);
    set.add(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`);
    set.add(`${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}`);
  }
  return Array.from(set);
}

function formatCnpj(digits: string): string {
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normStr(s: string): string {
  return String(s)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ');
}

function subtrairDiasUteis(dtIso: string, n: number): string {
  if (n <= 0) return dtIso;
  const d = new Date(dtIso + 'T12:00:00Z');
  let restante = n;
  while (restante > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) restante--;
  }
  return d.toISOString().slice(0, 10);
}

function parseDataYmd(raw: string | null | undefined): Date | null {
  const ymd = normalizeDtPos(raw);
  if (ymd.length !== 8) return null;
  const d = new Date(
    `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T12:00:00Z`,
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function diasCorridosAteVencimento(
  dtvencimento: string | null | undefined,
  dtRefIso: string,
): number | null {
  const dVenc = parseDataYmd(dtvencimento);
  const dRef = parseDataYmd(dtRefIso.replace(/-/g, ''));
  if (!dVenc || !dRef) return null;
  const ms = dVenc.getTime() - dRef.getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

// ============================================================
// Constantes — IN RFB 1.585/2015 Art. 4º
// ============================================================
const CODIGO_REGRA = 'TRIB_FIM_LP_365';
const LIMITE_DIAS = 365;
/** Faixa preventiva: âmbar entre 365d e este patamar (ex.: 367d). */
const ALERTA_DIAS = 367;
const PRAZO_COTA_LP = 366;
const PRAZO_COTA_CP = 1;
const PRAZO_COMPROMISSADA = 1;

/** Categorias ANBIMA nivel1 → Art. 4º (prazo médio), não Art. 5º FIQ. */
const NIVEL1_ART4 = new Set([
  'MULTIMERCADOS',
  'RENDAFIXA',
  'CAMBIAL',
  'ACOES',
  'ACOESINDICEATIVO',
  'ACOESINDICEPASSIVO',
  'ACOESINDICE',
  'ACOESSETORIAIS',
  'ACOESDIVIDENDOS',
  'ACOESESG',
  'ACOESLONGONLY',
  'ACOESLONGSHORT',
  'ACOESSMALLCAPS',
  'FIP',
  'FIPIE',
  'FIPPDI',
  'FII',
  'FIAGRO',
  'PREVIDENCIA',
  'ETF',
]);

interface FundCharProprio {
  nivel1_categoria: string | null;
  composicao_fundo: string | null;
  nome_comercial: string | null;
  defasagem_dias_trib: number | null;
}

function normNivel1(raw: string | null | undefined): string {
  return String(raw ?? '').toUpperCase().replace(/[\s_-]/g, '');
}

function isComposicaoCic(raw: string | null | undefined): boolean {
  return String(raw ?? '').trim().toUpperCase() === 'CIC';
}

function isNivel1Art4(raw: string | null | undefined): boolean {
  const n1 = normNivel1(raw);
  if (!n1) return false;
  if (NIVEL1_ART4.has(n1)) return true;
  for (const cat of NIVEL1_ART4) {
    if (n1.startsWith(cat)) return true;
  }
  return false;
}

function elegibilidadeNormaTributaria(
  fundChar: FundCharProprio | null,
  tituloRows: unknown[],
  termoRows: unknown[],
): { art5: boolean; motivo: string } {
  if (tituloRows.length > 0 || termoRows.length > 0) {
    return {
      art5: false,
      motivo: 'Carteira com títulos RF ou compromissada diretos — Art. 4º (prazo médio WAM)',
    };
  }

  if (fundChar && isNivel1Art4(fundChar.nivel1_categoria)) {
    return {
      art5: false,
      motivo: `${fundChar.nivel1_categoria} — Art. 4º (prazo médio)`,
    };
  }

  if (fundChar && isComposicaoCic(fundChar.composicao_fundo)) {
    return {
      art5: true,
      motivo: `FIQ (composição CIC) — Art. 5º MM-10d`,
    };
  }

  if (!fundChar) {
    return {
      art5: false,
      motivo: 'Sem cadastro ANBIMA — Art. 4º (conservador)',
    };
  }

  return {
    art5: false,
    motivo: `composição ${fundChar.composicao_fundo ?? '—'} / ${fundChar.nivel1_categoria ?? '—'} — Art. 4º`,
  };
}

async function loadFundCharProprio(cnpjVariants: string[]): Promise<FundCharProprio | null> {
  const { data: byClasse } = await supabase
    .from('fundos_caracteristicas' as any)
    .select('nivel1_categoria, composicao_fundo, nome_comercial, defasagem_dias_trib')
    .in('cnpj_classe', cnpjVariants)
    .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo')
    .limit(1)
    .maybeSingle();

  if (byClasse) {
    return {
      nivel1_categoria: byClasse.nivel1_categoria ?? null,
      composicao_fundo: byClasse.composicao_fundo ?? null,
      nome_comercial: byClasse.nome_comercial ?? null,
      defasagem_dias_trib: byClasse.defasagem_dias_trib != null
        ? Number(byClasse.defasagem_dias_trib) : null,
    };
  }

  const { data: byFundo } = await supabase
    .from('fundos_caracteristicas' as any)
    .select('nivel1_categoria, composicao_fundo, nome_comercial, defasagem_dias_trib')
    .in('cnpj_fundo', cnpjVariants)
    .limit(1)
    .maybeSingle();

  if (!byFundo) return null;
  return {
    nivel1_categoria: byFundo.nivel1_categoria ?? null,
    composicao_fundo: byFundo.composicao_fundo ?? null,
    nome_comercial: byFundo.nome_comercial ?? null,
    defasagem_dias_trib: byFundo.defasagem_dias_trib != null
      ? Number(byFundo.defasagem_dias_trib) : null,
  };
}

const TRIBUTACAO_ALVO_MAP: Record<string, 'lp' | 'cp' | null> = {
  'longo prazo': 'lp',
  'aliquota de 15%': 'lp',
  'isento': 'lp',
  'curto prazo': 'cp',
  'especifica': null,
  'indefinido': null,
  'nao aplicavel': null,
  'outros': null,
  'previdenciario': null,
};

/** Art. 4º §5º — excluídos do prazo médio */
const TIPOS_EXCLUIDOS = new Set([
  'FII',
  'FIA',
  'FIP', 'FIP-IE', 'FIP-PD&I', 'FIPIE', 'FIPPD&I',
  'FIEE',
  'FIAGROFIP',
  'CCB',
  'COE',
]);

const SECTIONS_COTAS = new Set(['cotas']);
const SECTIONS_TITULOS = new Set(['titpublico', 'titprivado']);
const SECTIONS_TERMO = new Set(['termorf']);

interface CharInfo {
  nivel1_categoria: string | null;
  nome_comercial: string | null;
  prazo_pagamento_resgate_dias: number | null;
  aberto_estatutariamente: string | null;
  tributacao_alvo: string | null;
}

interface AtivoWam {
  nome: string;
  cnpj: string | null;
  valor: number;
  prazo_dias: number;
  section: string;
  motivo: string;
  excluido: boolean;
}

function nomeTituloRendaFixa(row: Record<string, unknown>, section: string): string {
  const parts = [
    row.nomecomercial,
    row.codativo,
    row.idinternoativo,
    row.isin,
  ].map((v) => String(v ?? '').trim()).filter(Boolean);
  const base = parts[0] || 'Título RF';
  return `${section.toUpperCase()} — ${base}`;
}

function isTipoExcluido(nivel1Raw: string, nome: string): boolean {
  const nivel1 = nivel1Raw.toUpperCase().replace(/[\s-]/g, '');
  if (TIPOS_EXCLUIDOS.has(nivel1Raw.toUpperCase()) || TIPOS_EXCLUIDOS.has(nivel1)) {
    return true;
  }
  const nomeU = nome.toUpperCase();
  if (/\bCOE\b/.test(nomeU) || nomeU.includes('CERTIFICADO DE OPERACOES ESTRUTURADAS')) {
    return true;
  }
  if (/\bCCB\b/.test(nomeU) || nomeU.includes('Cédula de Crédito Bancário'.normalize('NFD').replace(/\p{Diacritic}/gu, ''))) {
    return true;
  }
  return false;
}

/** Prazo WAM de uma cota de fundo investido (Art. 4º §3º e §4º). */
function prazoWamCota(char: CharInfo | null, cnpj: string): { prazo: number; motivo: string } | null {
  const nivel1Raw = (char?.nivel1_categoria ?? '').trim();
  const nivel1 = nivel1Raw.toUpperCase().replace(/[\s-]/g, '');
  const tipoLabel = nivel1Raw ? `${nivel1Raw} ` : '';
  const prazoResgate = toNum(char?.prazo_pagamento_resgate_dias);
  const isFechado = String(char?.aberto_estatutariamente ?? '').toLowerCase().includes('fechado');

  if (isTipoExcluido(nivel1Raw, char?.nome_comercial ?? cnpj)) {
    return null;
  }

  // tributacao_alvo prevalece sobre prazo D+0 cadastral (ANBIMA usa 0 em fundos LP líquidos)
  const tributacaoRaw = char?.tributacao_alvo ?? '';
  if (tributacaoRaw) {
    const mapped = TRIBUTACAO_ALVO_MAP[normStr(tributacaoRaw)] ?? null;
    if (mapped === 'lp') {
      return { prazo: PRAZO_COTA_LP, motivo: `${tipoLabel}LP — tributacao_alvo "${tributacaoRaw}" → ${PRAZO_COTA_LP}d (Art. 4º §4º)` };
    }
    if (mapped === 'cp') {
      return { prazo: PRAZO_COTA_CP, motivo: `${tipoLabel}CP — tributacao_alvo "${tributacaoRaw}" → ${PRAZO_COTA_CP}d (Art. 4º §3º)` };
    }
  }

  if (prazoResgate === 0) {
    return { prazo: PRAZO_COTA_CP, motivo: `${tipoLabel}CP — DI/Selic D+0 → ${PRAZO_COTA_CP}d (Art. 4º §3º)` };
  }

  if (!char) {
    return { prazo: PRAZO_COTA_CP, motivo: `CP conservador — sem cadastro (${cnpj}) → ${PRAZO_COTA_CP}d` };
  }

  if (isFechado && prazoResgate == null) {
    return { prazo: PRAZO_COTA_LP, motivo: `${tipoLabel}LP — fechado sem prazo → ${PRAZO_COTA_LP}d` };
  }

  if (prazoResgate != null && prazoResgate > LIMITE_DIAS) {
    return { prazo: PRAZO_COTA_LP, motivo: `${tipoLabel}LP — prazo ${prazoResgate}d > ${LIMITE_DIAS}d → ${PRAZO_COTA_LP}d` };
  }

  return { prazo: PRAZO_COTA_CP, motivo: `${tipoLabel}CP — prazo ${prazoResgate ?? '?'}d → ${PRAZO_COTA_CP}d` };
}

function prazoWamTitulo(
  row: Record<string, unknown>,
  section: string,
  dtRefIso: string,
): { prazo: number; motivo: string; metodo_prazo: 'vencimento' } {
  if (row.possui_compromisso === true || row.possui_compromisso === 'true') {
    return { prazo: PRAZO_COMPROMISSADA, motivo: `${section} compromissada → ${PRAZO_COMPROMISSADA}d`, metodo_prazo: 'vencimento' };
  }

  const dias = diasCorridosAteVencimento(row.dtvencimento as string, dtRefIso);
  const vencFmt = row.dtvencimento
    ? String(row.dtvencimento).replace(/(\d{4})(\d{2})(\d{2})/, '$3/$2/$1')
    : '—';

  if (dias == null) {
    return { prazo: PRAZO_COTA_CP, motivo: `${section} CP conservador — sem vencimento → ${PRAZO_COTA_CP}d`, metodo_prazo: 'vencimento' };
  }

  return {
    prazo: Math.max(0, dias),
    motivo: `${section} — venc. ${vencFmt} (${dias}d corridos)`,
    metodo_prazo: 'vencimento',
  };
}

// ──────────────────────────────────────────────────────────────
// Helpers para fluxos intermediários (Art. 4º §2º inciso II)
// Cópia inline de src/lib/tributarioPrazoRf.ts (edge functions não
// suportam imports de _shared — regra do projeto).
// ──────────────────────────────────────────────────────────────

interface FluxoRf {
  data_pagamento: string;
  valor_nominal: number;
  tipo_fluxo?: string;
}

function parseDataFluxoRf(raw: string): Date | null {
  const s = String(raw ?? '').trim().replace(/\D/g, '').slice(0, 8);
  if (s.length !== 8) return null;
  const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function calcularWamFluxos(
  fluxos: FluxoRf[],
  dtRefIso: string,
): { prazo: number; fluxos_considerados: number; soma_nominal: number } | null {
  const dtRef = parseDataFluxoRf(dtRefIso.replace(/-/g, ''));
  if (!dtRef) return null;
  const MS_DIA = 24 * 60 * 60 * 1000;

  const futuros = fluxos.map((f) => {
    const dtPag = parseDataFluxoRf(f.data_pagamento);
    if (!dtPag) return null;
    const dias = Math.round((dtPag.getTime() - dtRef.getTime()) / MS_DIA);
    if (dias <= 0) return null;
    return { dias, valor_nominal: f.valor_nominal };
  }).filter((x): x is { dias: number; valor_nominal: number } => x !== null);

  if (futuros.length === 0) return null;

  const somaNominal = futuros.reduce((s, f) => s + f.valor_nominal, 0);
  if (somaNominal <= 0) return null;

  const somaPond = futuros.reduce((s, f) => s + f.valor_nominal * f.dias, 0);
  return {
    prazo: somaPond / somaNominal,
    fluxos_considerados: futuros.length,
    soma_nominal: somaNominal,
  };
}

/** Gera a lista de chaves canônicas para resolver posicao_carteira → titulo_rf_fluxo. */
function resolveChavesAtivoRf(row: Record<string, unknown>): string[] {
  const chaves: string[] = [];
  const limpa = (v: unknown) => String(v ?? '').trim().toUpperCase();
  const isin = limpa(row.isin);
  if (isin) chaves.push(`isin:${isin}`);
  const cetip = limpa(row.codativo);
  if (cetip) chaves.push(`cetip:${cetip}`);
  const interno = limpa(row.idinternoativo);
  if (interno && interno !== cetip) chaves.push(`cetip:${interno}`);
  return chaves;
}

/**
 * Resolve o prazo WAM de um título RF:
 * - Se houver fluxos no mapa → inciso II (WAM por fluxos nominais)
 * - Caso contrário → inciso I (dtvencimento, comportamento anterior)
 */
function resolvePrazoTituloRf(
  row: Record<string, unknown>,
  section: string,
  dtRefIso: string,
  fluxosMap: Map<string, FluxoRf[]>,
): { prazo: number; motivo: string; metodo_prazo: 'vencimento' | 'fluxo_nominal'; qtd_fluxos?: number } {
  if (row.possui_compromisso === true || row.possui_compromisso === 'true') {
    return { prazo: PRAZO_COMPROMISSADA, motivo: `${section} compromissada → ${PRAZO_COMPROMISSADA}d`, metodo_prazo: 'vencimento' };
  }

  const chaves = resolveChavesAtivoRf(row);
  for (const chave of chaves) {
    const fluxos = fluxosMap.get(chave);
    if (!fluxos || fluxos.length === 0) continue;
    const wam = calcularWamFluxos(fluxos, dtRefIso);
    if (!wam) continue;
    return {
      prazo: wam.prazo,
      metodo_prazo: 'fluxo_nominal',
      qtd_fluxos: wam.fluxos_considerados,
      motivo: `${section} — ${wam.fluxos_considerados} fluxo(s) nominal(is) (Art. 4º §2º II) → ${wam.prazo.toFixed(2)}d`,
    };
  }

  // Fallback: inciso I
  return prazoWamTitulo(row, section, dtRefIso);
}

/**
 * Busca os fluxos de titulo_rf_fluxo para um conjunto de chaves_ativo.
 * Retorna mapa chave_ativo → FluxoRf[].
 */
async function carregarFluxosRf(
  chaves: string[],
): Promise<Map<string, FluxoRf[]>> {
  const mapa = new Map<string, FluxoRf[]>();
  if (chaves.length === 0) return mapa;

  const { data, error } = await supabase
    .from('titulo_rf_fluxo' as any)
    .select('chave_ativo, data_pagamento, valor_nominal, tipo_fluxo')
    .in('chave_ativo', chaves);

  if (error) {
    console.warn(`[rules-tributario-art4] Aviso ao carregar fluxos RF: ${error.message}`);
    return mapa;
  }

  for (const row of (data ?? []) as any[]) {
    const chave = String(row.chave_ativo ?? '');
    if (!chave) continue;
    if (!mapa.has(chave)) mapa.set(chave, []);
    mapa.get(chave)!.push({
      data_pagamento: String(row.data_pagamento ?? ''),
      valor_nominal: Number(row.valor_nominal ?? 0),
      tipo_fluxo: row.tipo_fluxo ?? undefined,
    });
  }
  return mapa;
}

// ============================================================
// Contadores anuais (episódios CP tributário — prazo ≤ limite)
// ============================================================
const MAX_EVENTOS_ANO_ART4 = 3;
const MAX_DIAS_VIOLACAO_ANO_ART4 = 45;

interface Art4SerieDia {
  data_referencia: string;
  prazo_medio: number;
  limite_dias: number;
}

function ymdToIso(ymd: string): string {
  if (ymd.length !== 8) return ymd;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function prazoMedioFromDetalhesArt4(
  d: Record<string, unknown>,
  valorAtual: number | null | undefined,
  limiteDias: number,
): number | null {
  const pm = Number(d.prazo_medio_dias ?? d.prazo_medio_carteira);
  if (Number.isFinite(pm) && pm > 0) return pm;
  if (valorAtual != null && limiteDias > 0) {
    const v = Number(valorAtual) * limiteDias;
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

async function carregarSerieAnoArt4(
  cleanCnpj: string,
  fundo_isin: string,
  codigoRegra: string,
  ano: number,
): Promise<Art4SerieDia[]> {
  const { data, error } = await supabase
    .from('enquadramento_resultado')
    .select('fundo_dtposicao, detalhes, valor_atual')
    .eq('fundo_cnpj', cleanCnpj)
    .eq('fundo_isin', fundo_isin)
    .eq('regra_codigo', codigoRegra)
    .gte('fundo_dtposicao', `${ano}0101`)
    .lte('fundo_dtposicao', `${ano}1231`)
    .order('fundo_dtposicao');

  if (error) {
    console.warn(`[rules-tributario-art4] Erro ao carregar série anual: ${error.message}`);
    return [];
  }

  return (data ?? [])
    .map((row) => {
      const d = (row.detalhes ?? {}) as Record<string, unknown>;
      const limite_dias = Number(d.limite_dias ?? LIMITE_DIAS);
      const ymd = normalizeDtPos(String(row.fundo_dtposicao));
      const prazo_medio = prazoMedioFromDetalhesArt4(
        d,
        row.valor_atual as number | null,
        limite_dias,
      );
      if (prazo_medio == null) return null;
      return {
        data_referencia: ymdToIso(ymd),
        prazo_medio,
        limite_dias,
      };
    })
    .filter((r): r is Art4SerieDia => r != null);
}

function calcularContadoresAnoArt4(
  registrosAno: Art4SerieDia[],
  limiteDias: number,
  dataAtual: string,
  prazoAtual: number,
): { eventos_ano: number; dias_violacao_ano: number } {
  const map = new Map<string, Art4SerieDia>();
  for (const r of registrosAno) map.set(r.data_referencia, r);
  map.set(dataAtual, { data_referencia: dataAtual, prazo_medio: prazoAtual, limite_dias: limiteDias });

  const sorted = [...map.values()].sort((a, b) =>
    a.data_referencia.localeCompare(b.data_referencia),
  );

  let eventos_ano = 0;
  let dias_violacao_ano = 0;
  let emBloco = false;

  for (const r of sorted) {
    const lim = r.limite_dias || limiteDias;
    const violacao = r.prazo_medio <= lim;
    if (violacao) {
      dias_violacao_ano += 1;
      if (!emBloco) {
        eventos_ano += 1;
        emBloco = true;
      }
    } else {
      emBloco = false;
    }
  }

  return { eventos_ano, dias_violacao_ano };
}

// ============================================================
// Handler principal
// ============================================================
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { fundo_cnpj, fundo_isin: fundo_isin_req, fundo_dtposicao }: RuleCheckRequest = await req.json();
    const fundo_isin = fundo_isin_req ?? '';

    if (!fundo_cnpj || !fundo_dtposicao) {
      return new Response(
        JSON.stringify({ success: false, error: 'fundo_cnpj e fundo_dtposicao são obrigatórios' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log(`[rules-tributario-art4] Verificando ${fundo_cnpj} isin=${fundo_isin || '(none)'} em ${fundo_dtposicao}`);

    const cleanCnpj = String(fundo_cnpj).replace(/\D/g, '').padStart(14, '0');
    const cnpjVariants = [...new Set([fundo_cnpj, cleanCnpj, formatCnpj(cleanCnpj)])].filter(Boolean);

    const regraAssoc = await resolveRegraArt4FimAssociada(cnpjVariants, fundo_isin);
    const codigoRegraAtivo = regraAssoc?.codigo ?? CODIGO_REGRA;
    const regraParams = regraAssoc?.parametros ?? null;
    const limiteDiasRegra = Number(regraParams?.limite_dias) || LIMITE_DIAS;
    const alertaDiasRegra = Number(regraParams?.alerta_dias) || ALERTA_DIAS;

    if (!regraAssoc) {
      console.log(
        `[rules-tributario-art4] ${fundo_cnpj} — regra Art. 4º FIM não associada, ignorando.`,
      );
      await clearCategoryResults(fundo_cnpj, fundo_isin, fundo_dtposicao, 'tributario-art4');
      return new Response(
        JSON.stringify({
          success: true,
          results: [],
          motivo: 'Regra FIM não associada manualmente ao fundo',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const dtVariants = expandFundoDtposicaoQueryVariants(fundo_dtposicao);
    const ymd8 = normalizeDtPos(fundo_dtposicao);
    const dtRef = `${ymd8.slice(0, 4)}-${ymd8.slice(4, 6)}-${ymd8.slice(6, 8)}`;

    // cnpjVariants já calculado acima (gate fundo_regras)

    const fundChar = await loadFundCharProprio(cnpjVariants);
    const defasagem = Number(fundChar?.defasagem_dias_trib ?? 0) || 0;

    const dtEfetiva = defasagem > 0 ? subtrairDiasUteis(dtRef, defasagem) : dtRef;
    const dtVariantsEfetivas = defasagem > 0
      ? expandFundoDtposicaoQueryVariants(dtEfetiva.replace(/-/g, ''))
      : dtVariants;

    if (defasagem > 0) {
      console.log(
        `[rules-tributario-art4] Defasagem D-${defasagem}: posição ${dtEfetiva} → p_dia ${dtRef}`,
      );
    }

    let posQuery = supabase
      .from('posicao_carteira' as any)
      .select(
        'section, fundo_patliq, valor_padrao, cnpjfundo, cnpjemissor, nomecomercial, ' +
        'dtvencimento, codativo, idinternoativo, isin, possui_compromisso',
      )
      .in('fundo_cnpj', cnpjVariants)
      .in('fundo_dtposicao', dtVariantsEfetivas);
    if (fundo_isin) posQuery = (posQuery as any).eq('fundo_isin', fundo_isin);
    const { data: posicoes, error: posError } = await posQuery;

    if (posError) throw posError;

    if (!posicoes || posicoes.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Nenhuma posição encontrada' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const rows = posicoes as any[];
    const totalPL = Number(rows[0]?.fundo_patliq ?? 0) || 0;
    const normSection = (s: string) => (s || '').toLowerCase().trim();

    const cotaRows = rows.filter((r) => SECTIONS_COTAS.has(normSection(r.section)));
    const tituloRows = rows.filter((r) => SECTIONS_TITULOS.has(normSection(r.section)));
    const termoRows = rows.filter((r) => SECTIONS_TERMO.has(normSection(r.section)));

    const { art5, motivo: motivoNorma } = elegibilidadeNormaTributaria(
      fundChar,
      tituloRows,
      termoRows,
    );

    if (art5) {
      console.log(`[rules-tributario-art4] ${fundo_cnpj} → ${motivoNorma}`);
      const resultado = buildNaoAplicavelResult(motivoNorma, fundChar, totalPL);
      await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, 'tributario-art4', [resultado]);
      return new Response(
        JSON.stringify({
          success: true,
          results: [resultado],
          motivo: motivoNorma,
        } as any),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (cotaRows.length === 0 && tituloRows.length === 0 && termoRows.length === 0) {
      console.log(`[rules-tributario-art4] ${fundo_cnpj} sem ativos elegíveis para Art. 4º.`);
      const resultado = buildNaoAplicavelResult('Sem cotas ou títulos RF na posição', fundChar, totalPL);
      await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, 'tributario-art4', [resultado]);
      return new Response(
        JSON.stringify({ success: true, results: [resultado], motivo: 'Sem ativos elegíveis Art. 4º' } as any),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── fundos_caracteristicas dos investidos ──
    const cnpjsInvestidos = new Set<string>();
    for (const row of cotaRows) {
      const raw = row.cnpjfundo || row.cnpjemissor;
      if (!raw) continue;
      const c14 = String(raw).replace(/\D/g, '').padStart(14, '0');
      cnpjsInvestidos.add(c14);
      cnpjsInvestidos.add(formatCnpj(c14));
    }

    const charMap = new Map<string, CharInfo>();
    const buildEntry = (c: any): CharInfo => ({
      nivel1_categoria: c.nivel1_categoria ?? null,
      nome_comercial: c.nome_comercial ?? null,
      prazo_pagamento_resgate_dias: c.prazo_pagamento_resgate_dias != null
        ? Number(c.prazo_pagamento_resgate_dias) : null,
      aberto_estatutariamente: c.aberto_estatutariamente ?? null,
      tributacao_alvo: c.tributacao_alvo ?? null,
    });

    const cnpjArr = Array.from(cnpjsInvestidos);
    if (cnpjArr.length > 0) {
      const { data: charsByClasse } = await supabase
        .from('fundos_caracteristicas' as any)
        .select(
          'cnpj_classe, cnpj_fundo, nivel1_categoria, nome_comercial, ' +
          'prazo_pagamento_resgate_dias, aberto_estatutariamente, tributacao_alvo',
        )
        .in('cnpj_classe', cnpjArr)
        .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo');

      const { data: charsByFundo } = await supabase
        .from('fundos_caracteristicas' as any)
        .select(
          'cnpj_classe, cnpj_fundo, nivel1_categoria, nome_comercial, ' +
          'prazo_pagamento_resgate_dias, aberto_estatutariamente, tributacao_alvo',
        )
        .in('cnpj_fundo', cnpjArr)
        .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo');

      for (const c of [...(charsByClasse ?? []), ...(charsByFundo ?? [])] as any[]) {
        const entry = buildEntry(c);
        for (const key of [
          String(c.cnpj_classe ?? '').replace(/\D/g, '').padStart(14, '0'),
          String(c.cnpj_fundo ?? '').replace(/\D/g, '').padStart(14, '0'),
        ]) {
          if (key.length === 14) charMap.set(key, entry);
        }
      }
    }

    const lookupChar = (cnpj14: string): CharInfo | null => charMap.get(cnpj14) ?? null;

    const ativos: AtivoWam[] = [];

    for (const row of cotaRows) {
      const valor = Number(row.valor_padrao ?? 0) || 0;
      if (valor === 0) continue;

      const raw = row.cnpjfundo || row.cnpjemissor;
      const cnpj14 = raw ? String(raw).replace(/\D/g, '').padStart(14, '0') : '';
      const char = cnpj14 ? lookupChar(cnpj14) : null;
      const nome = char?.nome_comercial || String((row.nomecomercial ?? cnpj14) || 'Cota');

      const prazoInfo = prazoWamCota(char, cnpj14);
      if (!prazoInfo) {
        ativos.push({
          nome,
          cnpj: cnpj14 || null,
          valor,
          prazo_dias: 0,
          section: 'cotas',
          motivo: `${char?.nivel1_categoria ?? '?'} excluído Art. 4º §5º`,
          excluido: true,
        });
        continue;
      }

      ativos.push({
        nome,
        cnpj: cnpj14 || null,
        valor,
        prazo_dias: prazoInfo.prazo,
        section: 'cotas',
        motivo: prazoInfo.motivo,
        excluido: false,
      });
    }

    // Buscar cronogramas de amortização (titulo_rf_fluxo) para os títulos RF da posição
    const chavesRf = new Set<string>();
    for (const row of tituloRows) {
      for (const c of resolveChavesAtivoRf(row)) chavesRf.add(c);
    }
    const fluxosMap = await carregarFluxosRf(Array.from(chavesRf));
    const qtdComFluxo = tituloRows.filter((r) =>
      resolveChavesAtivoRf(r).some((c) => (fluxosMap.get(c)?.length ?? 0) > 0)
    ).length;
    if (qtdComFluxo > 0) {
      console.log(`[rules-tributario-art4] ${fundo_cnpj} — ${qtdComFluxo} título(s) RF com cronograma (inciso II)`);
    }

    for (const row of tituloRows) {
      const valor = Number(row.valor_padrao ?? 0) || 0;
      if (valor === 0) continue;
      const section = normSection(row.section);
      const nome = nomeTituloRendaFixa(row, section);
      const { prazo, motivo, metodo_prazo, qtd_fluxos } = resolvePrazoTituloRf(row, section, dtEfetiva, fluxosMap);

      ativos.push({
        nome,
        cnpj: null,
        valor,
        prazo_dias: prazo,
        section,
        motivo,
        excluido: false,
        metodo_prazo,
        qtd_fluxos,
      } as any);
    }

    for (const row of termoRows) {
      const valor = Number(row.valor_padrao ?? 0) || 0;
      if (valor === 0) continue;
      const section = normSection(row.section);
      const nome = nomeTituloRendaFixa(row, section);
      ativos.push({
        nome,
        cnpj: null,
        valor,
        prazo_dias: PRAZO_COMPROMISSADA,
        section,
        motivo: `${section} termo/compromissada → ${PRAZO_COMPROMISSADA}d`,
        excluido: false,
      });
    }

    const elegiveis = ativos.filter((a) => !a.excluido);
    const excluidos = ativos.filter((a) => a.excluido);
    const valorElegivel = elegiveis.reduce((s, a) => s + a.valor, 0);
    const valorExcluido = excluidos.reduce((s, a) => s + a.valor, 0);

    if (valorElegivel <= 0) {
      console.log(`[rules-tributario-art4] ${fundo_cnpj} — todos os ativos excluídos do WAM.`);
      const resultado = buildNaoAplicavelResult('Todos os ativos excluídos do WAM (Art. 4º §5º)', fundChar, totalPL);
      await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, 'tributario-art4', [resultado]);
      return new Response(
        JSON.stringify({ success: true, results: [resultado], motivo: 'Ativos excluídos Art. 4º §5º' } as any),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const somaPonderada = elegiveis.reduce((s, a) => s + a.valor * a.prazo_dias, 0);
    const prazoMedio = somaPonderada / valorElegivel;

    const status: RuleStatus = prazoMedio <= limiteDiasRegra
      ? 'violacao'
      : prazoMedio <= alertaDiasRegra
      ? 'alerta'
      : 'ok';

    const descricaoStatus = prazoMedio > limiteDiasRegra
      ? `FIM LP tributário: prazo médio = ${prazoMedio.toFixed(2)}d (> ${limiteDiasRegra}d)`
      : `FIM CP tributário: prazo médio = ${prazoMedio.toFixed(2)}d ≤ ${limiteDiasRegra}d (IN RFB 1585 Art. 4º)`;

    const ano = parseInt(ymd8.slice(0, 4), 10);
    const serieAno = await carregarSerieAnoArt4(cleanCnpj, fundo_isin, codigoRegraAtivo, ano);
    const { eventos_ano, dias_violacao_ano } = calcularContadoresAnoArt4(
      serieAno,
      limiteDiasRegra,
      dtRef,
      prazoMedio,
    );

    const ativos_contabilizados = ativos.map((a: any) => ({
      nome: a.nome,
      cnpj: a.cnpj,
      valor: a.valor,
      percentual: totalPL > 0 ? a.valor / totalPL : 0,
      prazo_dias: a.excluido ? null : a.prazo_dias,
      contribuicao_dias: a.excluido ? null : (a.valor / valorElegivel) * a.prazo_dias,
      tipo: a.excluido ? 'excluido' : 'contabilizado',
      motivo: a.motivo,
      section: a.section,
      // Campos para rastreabilidade do método de cálculo (inciso I ou II)
      metodo_prazo: a.metodo_prazo ?? 'vencimento',
      qtd_fluxos: a.qtd_fluxos ?? undefined,
    }));

    const somaCotas = cotaRows.reduce((s, r) => s + (Number(r.valor_padrao ?? 0) || 0), 0);
    const somaTitulos = tituloRows.reduce((s, r) => s + (Number(r.valor_padrao ?? 0) || 0), 0);
    const totalCarteira = somaCotas + somaTitulos;

    const resultado: RuleResult = {
      regra_codigo: codigoRegraAtivo,
      regra_descricao: `FIM: prazo médio tributário > ${limiteDiasRegra}d (IN RFB 1585/2015 Art. 4º)`,
      status,
      valor_atual: prazoMedio / limiteDiasRegra,
      valor_limite: 1,
      detalhes: {
        prazo_medio_dias: Math.round(prazoMedio * 100) / 100,
        limite_dias: limiteDiasRegra,
        alerta_dias: alertaDiasRegra,
        patliq: totalPL,
        pl_total: totalPL,
        valor_elegivel: valorElegivel,
        valor_excluido: valorExcluido,
        pct_cotas_carteira: totalCarteira > 0 ? (somaCotas / totalCarteira) * 100 : 0,
        qtd_cotas: cotaRows.length,
        qtd_titulos_rf: tituloRows.length,
        qtd_titulos_fluxo_intermediario: qtdComFluxo,
        qtd_termo: termoRows.length,
        defasagem_dias: defasagem,
        dt_posicao_efetiva: dtEfetiva,
        data_referencia: dtRef,
        descricao_status: descricaoStatus,
        classificacao_tributaria: prazoMedio > limiteDiasRegra ? 'lp' : 'cp',
        norma_aplicada: 'Art. 4º',
        motivo_norma: motivoNorma,
        composicao_fundo: fundChar?.composicao_fundo ?? null,
        nivel1_categoria: fundChar?.nivel1_categoria ?? null,
        eventos_ano,
        dias_violacao_ano,
        max_eventos_ano: MAX_EVENTOS_ANO_ART4,
        max_dias_violacao_ano: MAX_DIAS_VIOLACAO_ANO_ART4,
        ativos_contabilizados,
      },
    };

    await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, 'tributario-art4', [resultado]);

    console.log(
      `[rules-tributario-art4] Concluído: status=${status} | WAM=${prazoMedio.toFixed(2)}d`,
    );

    return new Response(
      JSON.stringify({ success: true, results: [resultado] } as RuleCheckResponse),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('[rules-tributario-art4] Erro inesperado:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message } as RuleCheckResponse),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
