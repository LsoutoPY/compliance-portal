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
  fundo_isin?: string;     // ISIN discriminator for multi-class funds (optional)
  fundo_dtposicao: string; // YYYYMMDD
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

  let deleteQuery = supabase
    .from('enquadramento_resultado')
    .delete()
    .in('fundo_cnpj', cnpjVariants)
    .eq('fundo_isin', fundo_isin)
    .eq('fundo_dtposicao', ymd8)
    .eq('regra_categoria', categoria);
  await deleteQuery;

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
  descricao: string;
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

/** Todas as associações Art. 5º ativas — por tipo_regra ou código legado TRIB_FIQ_LP_90. */
async function resolveTodasRegrasArt5Associadas(
  cnpjVariants: string[],
  fundoIsin?: string | null,
): Promise<RegraAssocTrib[]> {
  const { data, error } = await supabase
    .from('fundo_regras')
    .select('fundo_isin, regra_id, regras_compliance (codigo, descricao, parametros)')
    .in('fundo_cnpj', cnpjVariants)
    .in('fundo_isin', fundoRegrasIsinQueryValues(fundoIsin))
    .eq('ativo', true)
    .eq('status_aprovacao', 'ativo');

  if (error) {
    console.warn(`[rules-tributario] Erro ao consultar fundo_regras: ${error.message}`);
    return [];
  }

  const resolved = resolveFundoRegrasForIsin(
    (data || []) as { fundo_isin?: string | null; regra_id: string; regras_compliance: unknown }[],
    fundoIsin,
  );

  const regras: RegraAssocTrib[] = [];
  const vistos = new Set<string>();

  for (const fr of resolved) {
    const rule = Array.isArray((fr as any).regras_compliance)
      ? (fr as any).regras_compliance[0]
      : (fr as any).regras_compliance;
    const r = rule as { codigo?: string; descricao?: string; parametros?: Record<string, unknown> } | null;
    if (!r?.codigo) continue;
    if (vistos.has(r.codigo)) continue;
    const p = (r.parametros ?? {}) as Record<string, unknown>;
    if (p.tipo_regra === 'tributario_fiq_art5' || r.codigo === CODIGO_REGRA) {
      regras.push({ codigo: r.codigo, descricao: r.descricao ?? r.codigo, parametros: p });
      vistos.add(r.codigo);
    }
  }
  return regras;
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

/** Normaliza string: lowercase, sem acento, sem espaço duplo */
function normStr(s: string): string {
  return String(s)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ');
}

// ============================================================
// Constantes de negócio — IN RFB 1.585/2015
// ============================================================

/**
 * Mapeamento tributacao_alvo → classificação LP/CP para fins IN 1585 Art. 5º
 *
 * 'longo prazo'     → LP explícito (ANBIMA/regulamento)
 * 'aliquota de 15%' → LP: FIDCs e estruturados têm alíquota fixa 15% retida na fonte
 *                     (Lei 8.981/95 e MP 2.158-35). O administrador os trata como LP
 *                     porque a alíquota final já é a menor possível (= LP tributário).
 * 'isento'          → LP: ativos isentos de IR (ex: LCI, LCA, CRI, CRA)
 * 'curto prazo'     → CP explícito
 * null              → inconclusivo → fallback por prazo_pagamento_resgate_dias
 */
const TRIBUTACAO_ALVO_MAP: Record<string, 'lp' | 'cp' | null> = {
  'longo prazo':     'lp',
  'aliquota de 15%': 'lp',
  'isento':          'lp',
  'curto prazo':     'cp',
  'especifica':      null,  // inconclusivo → fallback
  'indefinido':      null,  // inconclusivo → fallback
  'nao aplicavel':   null,  // inconclusivo → fallback
  'outros':          null,  // inconclusivo → fallback
  'previdenciario':  null,  // regra própria de previdência → fallback
};

/** Padrão se a regra não listar tipos: FII (Art. 4º §5º VIII). */
const TIPOS_EXCLUIDOS_PADRAO = ['FII'];

function normNivel1Categoria(raw: string): string {
  return String(raw).trim().toUpperCase().replace(/[\s-]/g, '');
}

function buildTiposExcluidosSet(
  parametros: Record<string, unknown> | null,
): Set<string> {
  // Usa APENAS tipos_excluidos_denominador (campo novo, gerenciado pelo formulário).
  // NÃO cai em tipos_excluidos: esse campo legado do seed tinha FIDC, FIA, FIP etc.
  // como lista informativa, não como lista de exclusão do cálculo.
  const raw = parametros?.tipos_excluidos_denominador;
  if (!Array.isArray(raw)) {
    return new Set(TIPOS_EXCLUIDOS_PADRAO.map((t) => normNivel1Categoria(t)));
  }
  // Lista vazia [] = usuário não marcou nenhum → não excluir por tipo
  const lista = raw.map((t) => String(t).trim()).filter(Boolean);
  return new Set(lista.map((t) => normNivel1Categoria(t)));
}

function isCotaTipoExcluida(nivel1Raw: string, excluidos: Set<string>): boolean {
  const n = normNivel1Categoria(nivel1Raw);
  if (!n || excluidos.size === 0) return false;
  // Correspondência EXATA — sem prefixo, evita FII excluir FIC FIM, FIC FIDC NP etc.
  return excluidos.has(n);
}

/**
 * Tipos que dependem da verificação §3º Art. 5º antes de serem LP/CP.
 * FIA e FIP só contam como LP se LP_base >= 50% do PL total do FIQ.
 */
const TIPOS_REGRA_S3 = new Set([
  'FIA',
  'FIP', 'FIP-IE', 'FIP-PD&I', 'FIPIE', 'FIPPD&I',
  'FIEE',
  'FIAGROFIP',
]);

const CODIGO_REGRA         = 'TRIB_FIQ_LP_90';
const LIMITE_MM            = 90;
const ALERTA_MM            = 92;
const JANELA_DU            = 10;
/** Metodologia MM-10d: SMA das últimas 10 posições (IN 1585 Art. 5º §2º). */
const VERSAO_REGRA_MM      = 'sma10-v2';
const MM_METODOLOGIA       = 'sma_10_posicoes';
const MAX_EVENTOS_ANO      = 3;
const MAX_DIAS_VIOLACAO_ANO = 45;

/** Prazo mínimo (dias corridos até vencimento) para título RF contar como LP tributário */
const PRAZO_LP_TITULO_DIAS = 366;

const SECTIONS_COTAS   = new Set(['cotas']);
const SECTIONS_TITULOS = new Set(['titpublico', 'titprivado']);
const SECTIONS_TERMO   = new Set(['termorf']);

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

/**
 * Art. 5º — FIQ exclusivamente: composição CIC, categoria não-FIM, carteira só cotas.
 * Art. 4º — Multimercado/RF ou títulos RF/termo diretos na posição.
 */
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

  // Multimercados / Renda Fixa etc. → sempre Art. 4º (prevalece sobre composição CIC)
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
      motivo: 'Sem cadastro ANBIMA — Art. 4º (conservador; não aplicar regra FIQ)',
    };
  }

  return {
    art5: false,
    motivo: `composição ${fundChar.composicao_fundo ?? '—'} / ${fundChar.nivel1_categoria ?? '—'} — Art. 4º`,
  };
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
    regra_descricao: 'FIQ: mínimo 90% MM-10d em cotas LP tributário (IN RFB 1585/2015 Art. 5º)',
    status: 'alerta',
    valor_atual: null,
    valor_limite: 0.90,
    detalhes: {
      norma_nao_aplicavel: true,
      motivo,
      regra_sugerida: 'TRIB_FIM_LP_365',
      nivel1_categoria: fundChar?.nivel1_categoria ?? null,
      composicao_fundo: fundChar?.composicao_fundo ?? null,
      patliq: totalPL,
    },
  };
}

async function loadExistingAtivos(
  fundo_cnpj: string,
  fundo_dtposicao: string,
): Promise<unknown[] | null> {
  const cnpjVariants = cnpjStorageVariants(fundo_cnpj);
  const ymd8 = normalizeDtPos(fundo_dtposicao);

  const { data, error } = await supabase
    .from('enquadramento_resultado')
    .select('detalhes')
    .in('fundo_cnpj', cnpjVariants)
    .eq('fundo_dtposicao', ymd8)
    .eq('regra_codigo', CODIGO_REGRA)
    .limit(1);

  if (error) {
    console.warn(`[rules-tributario] Erro ao carregar ativos existentes: ${error.message}`);
    return null;
  }

  const ativos = (data?.[0]?.detalhes as Record<string, unknown> | null)?.ativos_contabilizados;
  return Array.isArray(ativos) && ativos.length > 0 ? ativos : null;
}

async function enrichFromHistoricoSnapshot(
  fundo_cnpj: string,
  dtRef: string,
  result: RuleResult,
): Promise<RuleResult> {
  const cleanCnpj = String(fundo_cnpj).replace(/\D/g, '').padStart(14, '0');
  const { data: hist } = await supabase
    .from('enquadramento_tributario_historico' as any)
    .select(
      'p_dia, mm_10d, valor_lp, valor_cp, valor_excluido, pl_total, eventos_ano, dias_violacao_ano',
    )
    .eq('fundo_cnpj', cleanCnpj)
    .eq('data_referencia', dtRef)
    .maybeSingle();

  if (!hist) return result;

  const p_dia = Number(hist.p_dia);
  const mm_10d = Number(hist.mm_10d);
  if (!Number.isFinite(p_dia) || !Number.isFinite(mm_10d)) return result;

  const valorLP = Number(hist.valor_lp) || 0;
  const valorCP = Number(hist.valor_cp) || 0;
  const valorExcluido = Number(hist.valor_excluido) || 0;
  const totalPL = Number(hist.pl_total) || 0;
  const eventos_ano = Number(hist.eventos_ano) || 0;
  const dias_violacao_ano = Number(hist.dias_violacao_ano) || 0;
  const denominador = totalPL > 0 ? totalPL : (p_dia > 0 ? valorLP / (p_dia / 100) : valorLP + valorCP);

  let status: RuleStatus;
  if (mm_10d >= ALERTA_MM) {
    status = 'ok';
  } else if (mm_10d >= LIMITE_MM) {
    status = 'alerta';
  } else {
    status = eventos_ano >= MAX_EVENTOS_ANO || dias_violacao_ano >= MAX_DIAS_VIOLACAO_ANO
      ? 'violacao'
      : 'alerta';
  }

  const avisoNorma = result.detalhes?.norma_nao_aplicavel
    ? (result.detalhes.motivo as string)
    : null;

  return {
    regra_codigo: CODIGO_REGRA,
    regra_descricao: result.regra_descricao,
    status,
    valor_atual: mm_10d / 100,
    valor_limite: LIMITE_MM / 100,
    detalhes: {
      p_dia,
      mm_10d,
      valor_lp: valorLP,
      valor_cp: valorCP,
      valor_excluido: valorExcluido,
      patliq: totalPL,
      pl_total: totalPL,
      denominador,
      eventos_ano,
      dias_violacao_ano,
      snapshot_historico: true,
      ...(avisoNorma ? { aviso_norma: avisoNorma } : {}),
    },
  };
}

async function saveNaoAplicavelResult(
  fundo_cnpj: string,
  fundo_isin: string,
  fundo_dtposicao: string,
  dtRef: string,
  motivo: string,
  fundChar: FundCharProprio | null,
  totalPL: number,
): Promise<RuleResult> {
  const ativosExistentes = await loadExistingAtivos(fundo_cnpj, fundo_dtposicao);
  let resultado = buildNaoAplicavelResult(motivo, fundChar, totalPL);
  resultado = await enrichFromHistoricoSnapshot(fundo_cnpj, dtRef, resultado);

  if (ativosExistentes) {
    resultado = {
      ...resultado,
      detalhes: {
        ...resultado.detalhes,
        ativos_contabilizados: ativosExistentes,
        snapshot_ativos: true,
      },
    };
  }

  await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, 'tributario', [resultado]);
  return resultado;
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

// ============================================================
// Tipos internos
// ============================================================
type ClassTribInterna = 'lp' | 'cp' | 'excluido' | 'pendente_s3';
type ClassTrib        = 'lp' | 'cp' | 'excluido';

interface CharInfo {
  nivel1_categoria:             string | null;
  nome_comercial:               string | null;   // nome do fundo investido para exibição
  prazo_pagamento_resgate_dias: number | null;
  aberto_estatutariamente:      string | null;
  tributacao_alvo:              string | null;   // coluna existente — fonte primária
}

interface ItemPassagem1 {
  cnpj:           string;
  nome:           string;
  valor:          number;
  classificacao:  ClassTribInterna;
  motivo:         string;
  char:           CharInfo | null;
  section?:       string | null;
}

interface CotaClassificada {
  cnpj:              string;
  nome:              string;
  valor:             number;
  classificacao:     ClassTrib;
  motivo:            string;
  prazo_resgate_dias: number | null;
  is_fechado:        boolean;
  section?:          string | null;
}

interface ContadoresAno {
  eventos_ano:       number;
  dias_violacao_ano: number;
}

// ============================================================
// Títulos públicos / privados (RF) — classificação por vencimento
// ============================================================

function parseDataYmd(raw: string | null | undefined): Date | null {
  const ymd = normalizeDtPos(raw);
  if (ymd.length !== 8) return null;
  const d = new Date(
    `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T12:00:00Z`,
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Dias corridos da data de posição até o vencimento (negativo = já vencido). */
function diasCorridosAteVencimento(
  dtvencimento: string | null | undefined,
  dtRefIso: string,
): number | null {
  const dVenc = parseDataYmd(dtvencimento);
  const dRef  = parseDataYmd(dtRefIso.replace(/-/g, ''));
  if (!dVenc || !dRef) return null;
  const MS_DIA = 24 * 60 * 60 * 1000;
  return Math.round((dVenc.getTime() - dRef.getTime()) / MS_DIA);
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

function classificarTituloRendaFixa(
  row: Record<string, unknown>,
  section: string,
  dtRefIso: string,
): { classificacao: ClassTrib; motivo: string } {
  const dias = diasCorridosAteVencimento(
    row.dtvencimento as string | null | undefined,
    dtRefIso,
  );
  const vencFmt = row.dtvencimento
    ? String(row.dtvencimento).replace(/(\d{4})(\d{2})(\d{2})/, '$3/$2/$1')
    : '—';

  if (dias == null) {
    return {
      classificacao: 'cp',
      motivo: `${section} CP conservador — sem dtvencimento válido`,
    };
  }

  if (dias > PRAZO_LP_TITULO_DIAS) {
    return {
      classificacao: 'lp',
      motivo: `${section} LP — venc. ${vencFmt} (${dias}d corridos > ${PRAZO_LP_TITULO_DIAS}d)`,
    };
  }

  return {
    classificacao: 'cp',
    motivo: `${section} CP — venc. ${vencFmt} (${dias}d corridos ≤ ${PRAZO_LP_TITULO_DIAS}d)`,
  };
}

// ============================================================
// Classificação tributária — Passagem 1 (cotas)
// ============================================================

/**
 * Hierarquia de decisão:
 *
 * P1. tributacao_alvo  → fonte mais confiável (ANBIMA/regulamento)
 *     'Longo Prazo'    → LP
 *     'Alíquota de 15%'→ LP (FIDC/estruturado com alíquota fixa = tratado como LP)
 *     'Isento'         → LP
 *     'Curto Prazo'    → CP
 *     demais valores   → inconclusivo, cai no P4
 *
 * P2. DI/Selic D+0 (prazo_pagamento_resgate_dias = 0) → CP
 *     Só quando tributacao_alvo não definiu LP/CP (fundos DI/Selic sem cadastro LP)
 *
 * P0. Tipos excluídos na regra (ex.: FII) → excluido — prevalece sobre tributacao_alvo
 *
 * P3. Tipo com regra §3º — FIA, FIP, FIEE → pendente_s3 (Passagem 2)
 *
 * P5. Status aberto/fechado + prazo_pagamento_resgate_dias (fallback)
 */
function classificarCotaPassagem1(
  cnpj: string,
  nome: string,
  char: CharInfo | null,
  tiposExcluidos: Set<string>,
): { classificacao: ClassTribInterna; motivo: string } {

  const nivel1Raw  = (char?.nivel1_categoria ?? '').trim();
  const nivel1     = nivel1Raw.toUpperCase().replace(/[\s-]/g, '');
  const isFechado  = String(char?.aberto_estatutariamente ?? '').toLowerCase().includes('fechado');
  const prazo      = toNum(char?.prazo_pagamento_resgate_dias);
  const tipoLabel  = nivel1Raw ? `${nivel1Raw} ` : '';

  // ── P0: tipos excluídos na regra (ex.: FII — Art. 4º §5º VIII) ──
  // Deve vir ANTES de tributacao_alvo: FII costuma ter "Longo Prazo" no cadastro,
  // mas não entra no numerador LP do Art. 5º quando marcado como excluído.
  if (isCotaTipoExcluida(nivel1Raw, tiposExcluidos)) {
    return {
      classificacao: 'excluido',
      motivo: `${tipoLabel}excluído (${nivel1Raw || 'tipo'}) — não conta como LP`,
    };
  }

  // ── P1: tributacao_alvo (ANBIMA / regulamento) ────────────
  // Prevail sobre prazo D+0 cadastral (ANBIMA usa 0 em fundos LP líquidos)
  const tributacaoRaw = char?.tributacao_alvo ?? '';
  if (tributacaoRaw) {
    const tributacaoNorm = normStr(tributacaoRaw);
    const mappedClass = TRIBUTACAO_ALVO_MAP[tributacaoNorm] ?? null;

    if (mappedClass === 'lp') {
      return {
        classificacao: 'lp',
        motivo: `${tipoLabel}LP — tributacao_alvo: "${tributacaoRaw}" (ANBIMA/regulamento)`,
      };
    }

    if (mappedClass === 'cp') {
      return {
        classificacao: 'cp',
        motivo: `${tipoLabel}CP — tributacao_alvo: "${tributacaoRaw}" (ANBIMA/regulamento)`,
      };
    }

    console.warn(
      `[rules-tributario] tributacao_alvo="${tributacaoRaw}" inconclusivo para ${cnpj} ` +
      `— usando fallback por prazo`,
    );
  }

  // ── P2: DI/Selic D+0 → CP (só sem tributacao_alvo conclusivo) ──
  if (prazo === 0) {
    return {
      classificacao: 'cp',
      motivo: `${tipoLabel}CP — DI/Selic D+0`,
    };
  }

  // ── P3: tipos com regra §3º (FIA / FIP) ──────────────────
  // Precisam da Passagem 2 para saber se LP_base >= 50% do PL.
  // tributacao_alvo não resolveu → manter como pendente_s3.
  if (TIPOS_REGRA_S3.has(nivel1)) {
    return {
      classificacao: 'pendente_s3',
      motivo: `${tipoLabel}aguardando §3º Art. 5º (LP_base >= 50% do PL?)`,
    };
  }

  // ── P4: sem tributacao_alvo conclusivo → fallback por prazo ─

  // Sem cadastro nenhum → CP conservador
  if (!char) {
    return {
      classificacao: 'cp',
      motivo: `CP conservador — sem cadastro em fundos_caracteristicas (${cnpj})`,
    };
  }

  // Fechado sem prazo cadastrado (null) → LP — prazo 0 já tratado como D+0 acima
  if (isFechado && prazo == null) {
    return {
      classificacao: 'lp',
      motivo: `${tipoLabel}LP — fechado sem prazo determinado`,
    };
  }

  // Fechado com prazo > 365 dias corridos → LP
  if (isFechado && prazo != null && prazo > 365) {
    return {
      classificacao: 'lp',
      motivo: `${tipoLabel}LP — fechado prazo ${prazo}d corridos`,
    };
  }

  // Aberto com prazo > 365 dias corridos → LP
  if (!isFechado && prazo != null && prazo > 365) {
    return {
      classificacao: 'lp',
      motivo: `${tipoLabel}LP — aberto prazo ${prazo}d corridos`,
    };
  }

  // Prazo ≤ 365 dias → CP
  if (prazo != null && prazo <= 365) {
    return {
      classificacao: 'cp',
      motivo: `${tipoLabel}CP — prazo ${prazo}d corridos ≤ 365d`,
    };
  }

  // Aberto sem prazo cadastrado → CP conservador
  return {
    classificacao: 'cp',
    motivo: `${tipoLabel}CP conservador — aberto sem prazo cadastrado`,
  };
}

// ============================================================
// Passagem 2 — Resolver FIA/FIP via §3º Art. 5º
// ============================================================
interface ResultadoPassagem2 {
  cotasFinais:    CotaClassificada[];
  lpBase:         number;
  pctLpBase:      number;
  fiaFipContamLP: boolean;
}

function resolverPassagem2(
  itens: ItemPassagem1[],
  totalPL: number,
): ResultadoPassagem2 {

  const lpBase = itens
    .filter((i) => i.classificacao === 'lp')
    .reduce((s, i) => s + i.valor, 0);

  const valorExcluido = itens
    .filter((i) => i.classificacao === 'excluido')
    .reduce((s, i) => s + i.valor, 0);

  const plBase    = totalPL - valorExcluido;
  const pctLpBase = plBase > 0 ? (lpBase / plBase) * 100 : 0;

  // §3º: FIA/FIP contam como LP somente se LP_base >= 50% do PL
  const fiaFipContamLP = pctLpBase >= 50;

  const cotasFinais: CotaClassificada[] = itens.map((item) => {
    const prazo     = toNum(item.char?.prazo_pagamento_resgate_dias);
    const isFechado = String(item.char?.aberto_estatutariamente ?? '')
      .toLowerCase().includes('fechado');
    const tipoLabel = item.char?.nivel1_categoria
      ? `${item.char.nivel1_categoria} `
      : '';

    if (item.classificacao === 'pendente_s3') {
      return {
        cnpj:              item.cnpj,
        nome:              item.nome,
        valor:             item.valor,
        classificacao:     fiaFipContamLP ? 'lp' : 'cp',
        motivo:            fiaFipContamLP
          ? `${tipoLabel}LP — §3º satisfeito (LP_base ${pctLpBase.toFixed(1)}% ≥ 50% do PL)`
          : `${tipoLabel}CP — §3º não satisfeito (LP_base ${pctLpBase.toFixed(1)}% < 50% do PL)`,
        prazo_resgate_dias: prazo,
        is_fechado:         isFechado,
        section:           item.section ?? null,
      };
    }

    return {
      cnpj:              item.cnpj,
      nome:              item.nome,
      valor:             item.valor,
      classificacao:     item.classificacao as ClassTrib,
      motivo:            item.motivo,
      prazo_resgate_dias: prazo,
      is_fechado:         isFechado,
      section:           item.section ?? null,
    };
  });

  return { cotasFinais, lpBase, pctLpBase, fiaFipContamLP };
}

// ============================================================
// Contadores do ano-calendário
// ============================================================
function calcularContadoresAno(
  registrosAno: { data_referencia: string; mm_10d?: number | null; em_violacao?: boolean }[],
): ContadoresAno {
  if (!registrosAno.length) return { eventos_ano: 0, dias_violacao_ano: 0 };

  const sorted = [...registrosAno].sort((a, b) =>
    a.data_referencia.localeCompare(b.data_referencia),
  );

  let eventos_ano       = 0;
  let dias_violacao_ano = 0;
  let emBloco           = false;

  for (const r of sorted) {
    const mm = r.mm_10d != null ? Number(r.mm_10d) : NaN;
    const violacao = Number.isFinite(mm)
      ? mm < LIMITE_MM
      : !!r.em_violacao;

    if (violacao) {
      dias_violacao_ano += 1;
      if (!emBloco) { eventos_ano += 1; emBloco = true; }
    } else {
      emBloco = false;
    }
  }

  return { eventos_ano, dias_violacao_ano };
}

/**
 * MM-10d — SMA dos p_dia: posição atual + até (JANELA_DU − 1) anteriores.
 * Janela incompleta (fundo novo): divide pelo nº de posições disponíveis.
 */
function calcularMm10dSma(
  pDiaAtual: number,
  pDiaAnteriores: number[],
): { mm_10d: number; n_dias_janela: number; janela_p_dia: number[] } {
  const valores = [
    pDiaAtual,
    ...pDiaAnteriores.slice(0, Math.max(0, JANELA_DU - 1)),
  ].filter((v) => Number.isFinite(v));

  const n = valores.length;
  if (n === 0) {
    return { mm_10d: 0, n_dias_janela: 0, janela_p_dia: [] };
  }

  const soma = valores.reduce((s, v) => s + v, 0);
  return { mm_10d: soma / n, n_dias_janela: n, janela_p_dia: valores };
}

/**
 * Subtrai N dias úteis de uma data ISO (YYYY-MM-DD).
 * Considera apenas fins de semana — não exclui feriados.
 */
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

    console.log(`[rules-tributario] Verificando ${fundo_cnpj} isin=${fundo_isin || '(none)'} em ${fundo_dtposicao}`);

    const cleanCnpj  = String(fundo_cnpj).replace(/\D/g, '').padStart(14, '0');
    const cnpjVariants = [...new Set([fundo_cnpj, cleanCnpj, formatCnpj(cleanCnpj)])].filter(Boolean);

    const todasRegras = await resolveTodasRegrasArt5Associadas(cnpjVariants, fundo_isin);

    if (todasRegras.length === 0) {
      console.log(
        `[rules-tributario] ${fundo_cnpj} — nenhuma regra Art. 5º associada, ignorando.`,
      );
      await clearCategoryResults(fundo_cnpj, fundo_isin, fundo_dtposicao, 'tributario');
      return new Response(
        JSON.stringify({
          success: true,
          results: [],
          motivo: 'Regra FIQ não associada manualmente ao fundo',
        } as RuleCheckResponse),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const dtVariants = expandFundoDtposicaoQueryVariants(fundo_dtposicao);
    const ymd8       = normalizeDtPos(fundo_dtposicao);
    const dtRef      = `${ymd8.slice(0, 4)}-${ymd8.slice(4, 6)}-${ymd8.slice(6, 8)}`;
    const anoCorrente = ymd8.slice(0, 4);

    // ── Busca de posição (CNPJ formatado + limpo numa query só) ──
    // cnpjVariants já calculado acima (gate fundo_regras)

    // ── Cadastro ANBIMA do próprio fundo + defasagem ──
    const fundChar = await loadFundCharProprio(cnpjVariants);
    const defasagem = Number(fundChar?.defasagem_dias_trib ?? 0) || 0;

    // Calcular data efetiva para busca da posição
    const dtEfetiva = defasagem > 0
      ? subtrairDiasUteis(dtRef, defasagem)
      : dtRef;
    const dtVariantsEfetivas = defasagem > 0
      ? expandFundoDtposicaoQueryVariants(dtEfetiva.replace(/-/g, ''))
      : dtVariants;

    if (defasagem > 0) {
      console.log(
        `[rules-tributario] Defasagem D-${defasagem}: ` +
        `usando posição de ${dtEfetiva} para calcular p do dia ${dtRef}`,
      );
    }

    let posQuery = supabase
      .from('posicao_carteira' as any)
      .select(
        'id, section, fundo_patliq, valor_padrao, cnpjfundo, cnpjemissor, ' +
        'nomecomercial, dtvencimento, codativo, idinternoativo, isin',
      )
      .in('fundo_cnpj', cnpjVariants)
      .in('fundo_dtposicao', dtVariantsEfetivas);
    if (fundo_isin) posQuery = (posQuery as any).eq('fundo_isin', fundo_isin);
    const { data: posicoes, error: posError } = await posQuery;

    if (posError) throw posError;

    if (!posicoes || posicoes.length === 0) {
      console.warn(`[rules-tributario] Nenhuma posição para ${fundo_cnpj} em ${fundo_dtposicao}`);
      return new Response(
        JSON.stringify({ success: false, error: 'Nenhuma posição encontrada' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const rows    = posicoes as any[];
    const totalPL = Number(rows[0]?.fundo_patliq ?? 0) || 0;

    const normSection = (s: string) => (s || '').toLowerCase().trim();

    const cotaRows = rows.filter((r: any) => SECTIONS_COTAS.has(normSection(r.section)));
    const tituloRows = rows.filter((r: any) => SECTIONS_TITULOS.has(normSection(r.section)));
    const termoRows = rows.filter((r: any) => SECTIONS_TERMO.has(normSection(r.section)));

    if (cotaRows.length === 0 && tituloRows.length === 0 && termoRows.length === 0) {
      console.log(`[rules-tributario] ${fundo_cnpj} sem cotas/RF elegíveis.`);
      const resultado = await saveNaoAplicavelResult(
        fundo_cnpj, fundo_isin, fundo_dtposicao, dtRef,
        'Sem cotas ou títulos RF na posição', fundChar, totalPL,
      );
      return new Response(
        JSON.stringify({ success: true, results: [resultado], motivo: 'Sem ativos elegíveis' } as any),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { art5, motivo: motivoNorma } = elegibilidadeNormaTributaria(
      fundChar,
      tituloRows,
      termoRows,
    );

    const carteiraSoCotas =
      cotaRows.length > 0 && tituloRows.length === 0 && termoRows.length === 0;

    // Regra associada + carteira só cotas → Art. 5º FIQ (mesmo se nivel1 indicar Art. 4º)
    const aplicarArt5 = art5 || carteiraSoCotas;

    if (!aplicarArt5) {
      console.log(`[rules-tributario] ${fundo_cnpj} → ${motivoNorma}`);
      const resultado = await saveNaoAplicavelResult(
        fundo_cnpj, fundo_isin, fundo_dtposicao, dtRef, motivoNorma, fundChar, totalPL,
      );
      return new Response(
        JSON.stringify({ success: true, results: [resultado], motivo: motivoNorma } as any),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (!art5 && carteiraSoCotas) {
      console.log(
        `[rules-tributario] ${fundo_cnpj} — carteira só cotas; aplicando Art. 5º FIQ (${motivoNorma})`,
      );
    }

    if (cotaRows.length === 0) {
      console.log(`[rules-tributario] ${fundo_cnpj} sem posições section=cotas — não é FIQ.`);
      const resultado = await saveNaoAplicavelResult(
        fundo_cnpj, fundo_isin, fundo_dtposicao, dtRef,
        'Art. 5º exige cotas de fundos na carteira', fundChar, totalPL,
      );
      return new Response(
        JSON.stringify({ success: true, results: [resultado], motivo: 'Art. 5º exige cotas de fundos' } as any),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log(
      `[rules-tributario] FIQ confirmado (${motivoNorma}) | PL=${totalPL} | cotas=${cotaRows.length} linhas`,
    );

    // ── Carregar fundos_caracteristicas dos fundos investidos ──
    // Inclui tributacao_alvo (fonte primária de classificação)
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
      nivel1_categoria:             c.nivel1_categoria ?? null,
      nome_comercial:               c.nome_comercial ?? null,
      prazo_pagamento_resgate_dias: c.prazo_pagamento_resgate_dias != null
        ? Number(c.prazo_pagamento_resgate_dias) : null,
      aberto_estatutariamente:      c.aberto_estatutariamente ?? null,
      tributacao_alvo:              c.tributacao_alvo ?? null,
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
          String(c.cnpj_fundo  ?? '').replace(/\D/g, '').padStart(14, '0'),
        ]) {
          if (key && key !== '00000000000000' && !charMap.has(key)) {
            charMap.set(key, entry);
          }
        }
      }
    }

    // Log de diagnóstico: mostra tributacao_alvo de cada fundo investido
    for (const [cnpj, char] of charMap) {
      console.log(
        `[rules-tributario] char ${cnpj}: nivel1=${char.nivel1_categoria} | ` +
        `prazo=${char.prazo_pagamento_resgate_dias} | ` +
        `tributacao_alvo="${char.tributacao_alvo}" | ` +
        `aberto=${char.aberto_estatutariamente}`,
      );
    }

    // ── Histórico compartilhado (carregado uma única vez para todas as regras) ──
    const { data: historicoRecente } = await supabase
      .from('enquadramento_tributario_historico' as any)
      .select('data_referencia, p_dia')
      .eq('fundo_cnpj', cleanCnpj)
      .lt('data_referencia', dtRef)
      .order('data_referencia', { ascending: false })
      .limit(JANELA_DU - 1);

    const historico = (historicoRecente ?? []) as { data_referencia: string; p_dia: number }[];
    const pDiaAnteriores = historico.map((h) => Number(h.p_dia));

    const { data: registrosAno } = await supabase
      .from('enquadramento_tributario_historico' as any)
      .select('data_referencia, mm_10d, em_violacao')
      .eq('fundo_cnpj', cleanCnpj)
      .gte('data_referencia', `${anoCorrente}-01-01`)
      .lt('data_referencia', dtRef)
      .order('data_referencia', { ascending: true });

    // ── Loop: calcula resultado independente para cada regra associada ──
    const todosResultados: RuleResult[] = [];
    let histErrorMsg: string | null = null;

    for (let idxRegra = 0; idxRegra < todasRegras.length; idxRegra++) {
      const regraAssoc      = todasRegras[idxRegra];
      const isPrimeiraRegra = idxRegra === 0;
      const codigoRegraAtivo = regraAssoc.codigo;
      const regraParams      = regraAssoc.parametros;

      const limiteMm = Number(regraParams?.limite_mm) || LIMITE_MM;
      const alertaMm = Number(regraParams?.alerta_mm) || ALERTA_MM;
      const denominadorCarteiraElegivel = regraParams?.denominador_carteira_elegivel === true;
      const tiposExcluidosSet = buildTiposExcluidosSet(regraParams);
      const rawExcl = regraParams?.tipos_excluidos_denominador ?? regraParams?.tipos_excluidos;
      const tiposExcluidosLista = Array.isArray(rawExcl) && rawExcl.length > 0
        ? rawExcl.map((t: unknown) => String(t).trim()).filter(Boolean)
        : [...TIPOS_EXCLUIDOS_PADRAO];

      console.log(
        `[rules-tributario] Regra [${idxRegra + 1}/${todasRegras.length}] ` +
        `código=${codigoRegraAtivo} | denomElegivel=${denominadorCarteiraElegivel} | ` +
        `excluidos=[${[...tiposExcluidosSet].join(', ')}]`,
      );

      // ── Passagem 1: classificar cada cota com os excluídos desta regra ──
      const itensPasso1: ItemPassagem1[] = [];

      for (const row of cotaRows) {
        const valor = Number(row.valor_padrao ?? 0) || 0;
        if (valor === 0) continue;

        const cnpjRaw = row.cnpjfundo || row.cnpjemissor;
        const cnpj14  = cnpjRaw
          ? String(cnpjRaw).replace(/\D/g, '').padStart(14, '0')
          : '';
        const char    = cnpj14 ? (charMap.get(cnpj14) ?? null) : null;
        const nome    = char?.nome_comercial?.trim()
          || (cnpj14 ? formatCnpj(cnpj14) : 'Fundo investido');

        const { classificacao, motivo } = classificarCotaPassagem1(cnpj14, nome, char, tiposExcluidosSet);

        if (isPrimeiraRegra) {
          console.log(
            `[rules-tributario] P1 ${nome} (${cnpj14}): ` +
            `tributacao_alvo="${char?.tributacao_alvo ?? '-'}" → ${classificacao} | ${motivo}`,
          );
        }

        itensPasso1.push({
          cnpj: cnpj14, nome, valor, classificacao, motivo, char, section: 'cotas',
        });
      }

      for (const row of tituloRows) {
        const valor = Number(row.valor_padrao ?? 0) || 0;
        if (valor === 0) continue;
        const section = normSection(row.section);
        const nome = nomeTituloRendaFixa(row, section);
        itensPasso1.push({
          cnpj: '',
          nome,
          valor,
          classificacao: 'cp',
          motivo: `${section} CP — título direto não é cota de fundo LP (Art. 5º IN 1585)`,
          char: null,
          section,
        });
      }

      // ── Passagem 2: resolver FIA/FIP via §3º ──────────────────
      const { cotasFinais, lpBase, pctLpBase, fiaFipContamLP } =
        resolverPassagem2(itensPasso1, totalPL);

      const temPendentesS3 = itensPasso1.some((i) => i.classificacao === 'pendente_s3');
      if (temPendentesS3 && isPrimeiraRegra) {
        console.log(
          `[rules-tributario] §3º: LP_base=${lpBase.toFixed(0)} ` +
          `(${pctLpBase.toFixed(1)}%) → FIA/FIP = ${fiaFipContamLP ? 'LP ✓' : 'CP ✗'}`,
        );
      }

      // ── Calcular p_dia com denominador específico desta regra ──
      const valorLP = cotasFinais
        .filter((c) => c.classificacao === 'lp')
        .reduce((s, c) => s + c.valor, 0);

      const valorCP = cotasFinais
        .filter((c) => c.classificacao === 'cp')
        .reduce((s, c) => s + c.valor, 0);

      const valorExcluido = cotasFinais
        .filter((c) => c.classificacao === 'excluido')
        .reduce((s, c) => s + c.valor, 0);

      const somaClassificados = cotasFinais.reduce((s, c) => s + c.valor, 0);
      const baseElegivel = valorLP + valorCP;
      const denominador = denominadorCarteiraElegivel
        ? (baseElegivel > 0 ? baseElegivel : Math.max(0, totalPL - valorExcluido))
        : totalPL;
      const denominadorTipo = denominadorCarteiraElegivel ? 'carteira_elegivel' : 'pl_total';
      const p_dia = denominador > 0 ? (valorLP / denominador) * 100 : 0;

      console.log(
        `[rules-tributario] [${codigoRegraAtivo}] p_dia=${p_dia.toFixed(4)}% | ` +
        `LP=${valorLP.toFixed(0)} | CP=${valorCP.toFixed(0)} | ` +
        `Excluído=${valorExcluido.toFixed(0)} | denominador(${denominadorTipo})=${denominador.toFixed(0)} | ` +
        `PL_xml=${totalPL.toFixed(0)} | Soma=${somaClassificados.toFixed(0)}`,
      );

      // ── Média móvel ─────────────────────────────────────────────
      // O histórico gravado usa sempre o denominador pl_total (regra padrão).
      // Regras com denominador_carteira_elegivel=true têm metodologia diferente:
      // o histórico seria incompatível → sempre partimos do zero para essas regras.
      // A mm_10d vai crescer à medida que o usuário roda as verificações diárias.
      const historicoCompativel = !denominadorCarteiraElegivel;
      const historicoParaEstaRegra = historicoCompativel ? pDiaAnteriores : [];
      const registrosAnoParaEstaRegra = historicoCompativel ? (registrosAno ?? []) : [];
      const { mm_10d, n_dias_janela, janela_p_dia } = calcularMm10dSma(p_dia, historicoParaEstaRegra);
      const em_violacao = mm_10d < limiteMm;

      console.log(
        `[rules-tributario] [${codigoRegraAtivo}] mm_10d=${mm_10d.toFixed(4)}% ` +
        `(SMA ${n_dias_janela}/${JANELA_DU} | hist=${historicoParaEstaRegra.length}) | em_violacao=${em_violacao}`,
      );

      // ── Contadores do ano-calendário ──────────────────────────
      const todosAno = [
        ...registrosAnoParaEstaRegra,
        { data_referencia: dtRef, mm_10d, em_violacao },
      ];
      const { eventos_ano, dias_violacao_ano } = calcularContadoresAno(todosAno);

      // ── Gravar histórico e cache apenas para a primeira regra ──
      if (isPrimeiraRegra) {
        console.log(`[rules-tributario] eventos_ano=${eventos_ano} | dias_violacao_ano=${dias_violacao_ano}`);

        const { error: he } = await supabase
          .from('enquadramento_tributario_historico' as any)
          .upsert(
            {
              fundo_cnpj:       cleanCnpj,
              data_referencia:  dtRef,
              p_dia,
              mm_10d,
              em_violacao,
              eventos_ano,
              dias_violacao_ano,
              valor_lp:         valorLP,
              valor_cp:         valorCP,
              valor_excluido:   valorExcluido,
              pl_total:         totalPL,
              regra_versao:     VERSAO_REGRA_MM,
            },
            { onConflict: 'fundo_cnpj,data_referencia' },
          );

        if (he) {
          histErrorMsg = he.message;
          console.error(`[rules-tributario] FALHA histórico ${cleanCnpj} ${dtRef}:`, he.message);
        } else {
          console.log(
            `[rules-tributario] Histórico gravado ${cleanCnpj} ${dtRef} ` +
            `p_dia=${p_dia.toFixed(2)}% mm_10d=${mm_10d.toFixed(2)}%`,
          );
        }

        const cacheRows = cotasFinais
          .filter((c) => c.cnpj && c.cnpj !== '00000000000000')
          .map((c) => ({
            fundo_cnpj:       c.cnpj,
            data_referencia:  dtRef,
            classificacao:    c.classificacao,
            motivo:           c.motivo,
            prazo_medio_trib: c.prazo_resgate_dias,
          }));

        if (cacheRows.length > 0) {
          const { error: cacheError } = await supabase
            .from('fundo_classificacao_tributaria' as any)
            .upsert(cacheRows, { onConflict: 'fundo_cnpj,data_referencia' });
          if (cacheError) {
            console.error('[rules-tributario] Erro cache classificação:', cacheError.message);
          }
        }
      }

      // ── Determinar status ─────────────────────────────────────
      let status: RuleStatus;
      if (mm_10d >= alertaMm) {
        status = 'ok';
      } else if (mm_10d >= limiteMm) {
        status = 'alerta';
      } else {
        status = eventos_ano >= MAX_EVENTOS_ANO || dias_violacao_ano >= MAX_DIAS_VIOLACAO_ANO
          ? 'violacao'
          : 'alerta';
      }

      const pctExcluido      = totalPL > 0 ? (valorExcluido / totalPL) * 100 : 0;
      const alertaEstrutural = pctExcluido > 10;

      const descricaoStatus =
        status === 'ok'
          ? `FIQ em conformidade: MM-10d = ${mm_10d.toFixed(2)}% (mín. ${limiteMm}%)`
          : status === 'alerta'
          ? `FIQ atenção: MM-10d = ${mm_10d.toFixed(2)}% (mín. ${limiteMm}%, alerta ${alertaMm}%)`
          : `FIQ em violação: MM-10d = ${mm_10d.toFixed(2)}% < ${limiteMm}% (IN RFB 1585 Art. 5º)`;

      const qtdTitulos = cotasFinais.filter(
        (c) => c.section && SECTIONS_TITULOS.has(c.section),
      ).length;

      const ativos_contabilizados = cotasFinais.map((c) => ({
        nome:       `[${c.classificacao.toUpperCase()}] ${c.nome}`,
        cnpj:       c.cnpj || null,
        valor:      c.valor,
        percentual: totalPL > 0 ? c.valor / totalPL : 0,
        tipo:       c.classificacao,
        motivo:     c.motivo,
        section:    c.section ?? null,
      }));

      const resultado: RuleResult = {
        regra_codigo:    codigoRegraAtivo,
        regra_descricao: regraAssoc.descricao,
        status,
        valor_atual:  mm_10d / 100,
        valor_limite: limiteMm / 100,
        detalhes: {
          p_dia,
          mm_10d,
          limite_mm: limiteMm,
          alerta_mm: alertaMm,
          denominador_carteira_elegivel: denominadorCarteiraElegivel,
          denominador_tipo: denominadorTipo,
          denominador_base_elegivel: baseElegivel,
          tipos_excluidos_denominador: tiposExcluidosLista,
          mm_metodologia:    MM_METODOLOGIA,
          regra_versao:      VERSAO_REGRA_MM,
          n_dias_janela,
          janela_p_dia,
          n_dias_historico:  historicoParaEstaRegra.length,
          fundo_novo:        historicoParaEstaRegra.length === 0,
          eventos_ano,
          dias_violacao_ano,
          fia_fip_presentes: temPendentesS3,
          lp_base_pct:       temPendentesS3 ? pctLpBase  : null,
          fia_fip_contam_lp: temPendentesS3 ? fiaFipContamLP : null,
          patliq:            totalPL,
          pl_total:          totalPL,
          denominador,
          valor_lp:          valorLP,
          valor_cp:          valorCP,
          valor_excluido:    valorExcluido,
          qtd_cotas:         cotasFinais.filter((c) => c.section === 'cotas').length,
          qtd_titulos_rf:    qtdTitulos,
          alerta_estrutural: alertaEstrutural,
          pct_excluido:      pctExcluido,
          descricao_status:        descricaoStatus,
          ativos_contabilizados,
          historico_gravado:       isPrimeiraRegra ? !histErrorMsg : null,
          historico_erro:          isPrimeiraRegra ? (histErrorMsg ?? null) : null,
          data_referencia:         dtRef,
          defasagem_dias:          defasagem,
          dt_posicao_efetiva:      dtEfetiva,
        },
      };

      todosResultados.push(resultado);
      console.log(
        `[rules-tributario] [${codigoRegraAtivo}] Concluído: status=${status} | ` +
        `mm_10d=${mm_10d.toFixed(2)}% | p_dia=${p_dia.toFixed(2)}%`,
      );
    }

    await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, 'tributario', todosResultados);

    return new Response(
      JSON.stringify({ success: true, results: todosResultados } as RuleCheckResponse),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('[rules-tributario] Erro inesperado:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message } as RuleCheckResponse),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
