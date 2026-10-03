import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ============================================================
// TRIB_FIDC_LP_365 — Art. 4º IN RFB 1.585/2015 para FIDC puro
// Fonte: estoque_fidc (recebíveis) + posicao_carteira (caixa, RF)
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

interface FundCharProprio {
  nivel1_categoria: string | null;
  composicao_fundo: string | null;
  nome_comercial: string | null;
  defasagem_dias_trib: number | null;
}

interface EstoqueRow {
  id: string;
  import_id: string;
  data_referencia: string;
  data_vencimento_ajustada: string | null;
  data_vencimento_original: string | null;
  valor_presente: number | null;
  valor_nominal: number | null;
  prazo: number | null;
  prazo_atual: number | null;
  tipo_recebivel: string | null;
  nome_sacado: string | null;
  situacao_recebivel: string | null;
  doc_fundo: string | null;
  seu_numero: string | null;
  nu_documento: string | null;
}

interface LoadEstoqueResult {
  rows: EstoqueRow[];
  dataReferenciaEstoque: string | null;
  importId: string | null;
  semEstoque: boolean;
  estoque_pos_data_posicao: boolean;
}

interface AtivoWam {
  nome: string;
  cnpj: string | null;
  valor: number;
  prazo_dias: number;
  section: string;
  motivo: string;
  excluido: boolean;
  qtd_linhas?: number;
}

const CODIGO_REGRA = 'TRIB_FIDC_LP_365';
const CATEGORIA = 'tributario-art4-fidc';
const LIMITE_DIAS = 365;
/** Faixa preventiva acima do limite: âmbar só enquanto LP “apertado” (ex.: 366–367d). */
const ALERTA_DIAS = 367;
const PRAZO_CAIXA = 1;
const PRAZO_COMPROMISSADA = 1;
const TOLERANCIA_CONCILIACAO = 0.02;

const SITUACOES_EXCLUIR = [
  'inadimplente', 'cobrança', 'cobranca', 'litigioso', 'judicial',
  'protestado', 'recuperação', 'recuperacao', 'perda', 'baixado',
];

const SECTIONS_CAIXA = new Set(['caixa']);
const SECTIONS_TITULOS = new Set(['titpublico', 'titprivado']);
const SECTIONS_TERMO = new Set(['termorf']);

function cnpjStorageVariants(cnpj: string): string[] {
  const clean = String(cnpj).replace(/\D/g, '').padStart(14, '0');
  const formatted = formatCnpj(clean);
  return [...new Set([cnpj, clean, formatted])].filter(Boolean);
}

function formatCnpj(digits: string): string {
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function normalizarCnpj(cnpj: string | null | undefined): string {
  return String(cnpj ?? '').replace(/\D/g, '').padStart(14, '0');
}

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

function parseIsoDate(s: string): Date {
  const trimmed = String(s).trim();
  if (/^\d{8}$/.test(trimmed)) {
    return new Date(
      `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}T12:00:00Z`,
    );
  }
  return new Date(`${trimmed.slice(0, 10)}T12:00:00Z`);
}

function diasCorridosEntre(inicio: Date, fim: Date): number {
  const ms = fim.getTime() - inicio.getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function situacaoExcluida(situacao: string | null | undefined): boolean {
  if (!situacao || !String(situacao).trim()) return false;
  const s = String(situacao).trim().toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return SITUACOES_EXCLUIR.some((ex) => {
    const exNorm = ex.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    return s.includes(exNorm);
  });
}

/** Vencidos entram no WAM com prazo 0d — não confundir com inadimplente/baixado. */
function isSituacaoVencida(situacao: string | null | undefined): boolean {
  if (!situacao || !String(situacao).trim()) return false;
  const s = String(situacao).trim().toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return s.includes('vencid');
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

function normNivel1(raw: string | null | undefined): string {
  return String(raw ?? '').toUpperCase().replace(/[\s_-]/g, '');
}

function isFundoFidcProprio(nivel1: string | null | undefined): boolean {
  const n = normNivel1(nivel1);
  return n === 'FIDC' || n === 'FIDCNP' || n.startsWith('FIDC');
}

function isComposicaoCic(raw: string | null | undefined): boolean {
  return String(raw ?? '').trim().toUpperCase() === 'CIC';
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

/** Art. 4º FIDC — tipo_regra + variante fidc (ou código legado TRIB_FIDC_LP_365). */
async function resolveRegraArt4FidcAssociada(
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
    console.warn(`[rules-tributario-art4-fidc] Erro ao consultar fundo_regras: ${error.message}`);
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
    if (p.tipo_regra === 'tributario_prazo_medio_art4' && p.variante === 'fidc') {
      return { codigo: r.codigo, parametros: p };
    }
    if (r.codigo === CODIGO_REGRA) {
      return { codigo: r.codigo, parametros: p };
    }
  }
  return null;
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

function buildNaoAplicavelResult(
  motivo: string,
  fundChar: FundCharProprio | null,
  totalPL: number,
  extra: Record<string, unknown> = {},
): RuleResult {
  return {
    regra_codigo: CODIGO_REGRA,
    regra_descricao: `FIDC: prazo médio tributário > ${LIMITE_DIAS}d (IN RFB 1585/2015 Art. 4º)`,
    status: 'alerta',
    valor_atual: null,
    valor_limite: 1,
    detalhes: {
      norma_nao_aplicavel: true,
      motivo,
      patliq: totalPL,
      nivel1_categoria: fundChar?.nivel1_categoria ?? null,
      composicao_fundo: fundChar?.composicao_fundo ?? null,
      ...extra,
    },
  };
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

function prazoWamTitulo(
  row: Record<string, unknown>,
  section: string,
  dtRefIso: string,
): { prazo: number; motivo: string; metodo_prazo: 'vencimento' } {
  if (row.possui_compromisso === true || row.possui_compromisso === 'true') {
    return { prazo: PRAZO_COMPROMISSADA, motivo: `${section} compromissada → ${PRAZO_COMPROMISSADA}d`, metodo_prazo: 'vencimento' };
  }

  const dtVencRaw = row.dtvencimento as string | null | undefined;
  if (!dtVencRaw) {
    return { prazo: PRAZO_CAIXA, motivo: `${section} CP conservador — sem vencimento → ${PRAZO_CAIXA}d`, metodo_prazo: 'vencimento' };
  }

  const dtRef = parseIsoDate(dtRefIso);
  const ymd = String(dtVencRaw).replace(/\D/g, '').slice(0, 8);
  const dtVenc = parseIsoDate(ymd);
  const dias = diasCorridosEntre(dtRef, dtVenc);
  const vencFmt = ymd.length === 8
    ? `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}`
    : dtVencRaw;

  return {
    prazo: Math.max(0, dias),
    motivo: `${section} — venc. ${vencFmt} (${Math.max(0, dias)}d corridos)`,
    metodo_prazo: 'vencimento',
  };
}

// ──────────────────────────────────────────────────────────────
// Helpers para fluxos intermediários (Art. 4º §2º inciso II)
// Cópia inline de src/lib/tributarioPrazoRf.ts
// ──────────────────────────────────────────────────────────────

interface FluxoRf {
  data_pagamento: string;
  valor_nominal: number;
}

function parseDataFluxoRf(raw: string): Date | null {
  const s = String(raw ?? '').trim().replace(/\D/g, '').slice(0, 8);
  if (s.length !== 8) return null;
  const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function calcularWamFluxosRf(
  fluxos: FluxoRf[],
  dtRefIso: string,
): { prazo: number; fluxos_considerados: number } | null {
  const dtRef = parseDataFluxoRf(dtRefIso.replace(/-/g, ''));
  if (!dtRef) return null;
  const MS_DIA = 24 * 60 * 60 * 1000;
  const futuros = fluxos.map((f) => {
    const dtPag = parseDataFluxoRf(f.data_pagamento);
    if (!dtPag) return null;
    const dias = Math.round((dtPag.getTime() - dtRef.getTime()) / MS_DIA);
    return dias > 0 ? { dias, valor_nominal: f.valor_nominal } : null;
  }).filter((x): x is { dias: number; valor_nominal: number } => x !== null);
  if (futuros.length === 0) return null;
  const somaNominal = futuros.reduce((s, f) => s + f.valor_nominal, 0);
  if (somaNominal <= 0) return null;
  return {
    prazo: futuros.reduce((s, f) => s + f.valor_nominal * f.dias, 0) / somaNominal,
    fluxos_considerados: futuros.length,
  };
}

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

function resolvePrazoTituloRfFidc(
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
    const wam = calcularWamFluxosRf(fluxos, dtRefIso);
    if (!wam) continue;
    return {
      prazo: wam.prazo,
      metodo_prazo: 'fluxo_nominal',
      qtd_fluxos: wam.fluxos_considerados,
      motivo: `${section} — ${wam.fluxos_considerados} fluxo(s) nominal(is) (Art. 4º §2º II) → ${wam.prazo.toFixed(2)}d`,
    };
  }
  return prazoWamTitulo(row, section, dtRefIso);
}

async function carregarFluxosRfFidc(chaves: string[]): Promise<Map<string, FluxoRf[]>> {
  const mapa = new Map<string, FluxoRf[]>();
  if (chaves.length === 0) return mapa;
  const { data, error } = await supabase
    .from('titulo_rf_fluxo' as any)
    .select('chave_ativo, data_pagamento, valor_nominal')
    .in('chave_ativo', chaves);
  if (error) {
    console.warn(`[rules-tributario-art4-fidc] Aviso fluxos RF: ${error.message}`);
    return mapa;
  }
  for (const row of (data ?? []) as any[]) {
    const chave = String(row.chave_ativo ?? '');
    if (!chave) continue;
    if (!mapa.has(chave)) mapa.set(chave, []);
    mapa.get(chave)!.push({ data_pagamento: String(row.data_pagamento ?? ''), valor_nominal: Number(row.valor_nominal ?? 0) });
  }
  return mapa;
}

function prazoRecebivelEstoque(
  row: EstoqueRow,
  dtRefEstoqueIso: string,
): { prazo: number; motivo: string; vencido: boolean } | null {
  const prazoAtual = row.prazo_atual != null ? Number(row.prazo_atual) : null;
  const vencidoPorSituacao = isSituacaoVencida(row.situacao_recebivel);

  if (vencidoPorSituacao || (prazoAtual != null && prazoAtual < 0)) {
    const diasAtraso = prazoAtual != null && prazoAtual < 0 ? Math.abs(prazoAtual) : null;
    return {
      prazo: 0,
      vencido: true,
      motivo: diasAtraso != null
        ? `Recebível vencido — ${diasAtraso}d de atraso → 0d no WAM`
        : `Recebível vencido (${row.situacao_recebivel ?? 'situação'}) → 0d no WAM`,
    };
  }

  if (prazoAtual != null && prazoAtual >= 0) {
    return {
      prazo: prazoAtual,
      vencido: false,
      motivo: `Recebível — prazo_atual ${prazoAtual}d (Frontis)`,
    };
  }

  const prazo = row.prazo != null ? Number(row.prazo) : null;
  if (prazo != null && prazo >= 0) {
    return {
      prazo,
      vencido: false,
      motivo: `Recebível — prazo ${prazo}d (Frontis)`,
    };
  }

  const dataVenc = row.data_vencimento_ajustada || row.data_vencimento_original;
  if (dataVenc) {
    const dtRef = parseIsoDate(dtRefEstoqueIso);
    const dtVenc = parseIsoDate(String(dataVenc));
    if (!Number.isNaN(dtVenc.getTime())) {
      const dias = diasCorridosEntre(dtRef, dtVenc);
      if (dias < 0) {
        return {
          prazo: 0,
          vencido: true,
          motivo: `Recebível vencido — venc. ${String(dataVenc).slice(0, 10)} → 0d no WAM`,
        };
      }
      return {
        prazo: dias,
        vencido: false,
        motivo: `Recebível — venc. ${String(dataVenc).slice(0, 10)} (${dias}d corridos)`,
      };
    }
  }

  return null;
}

function deduplicarEstoque(rows: EstoqueRow[]): EstoqueRow[] {
  const seen = new Set<string>();
  const dedup: EstoqueRow[] = [];

  for (const r of rows) {
    const chave = (r.seu_numero || '').trim() || (r.nu_documento || '').trim();
    if (!chave) {
      dedup.push(r);
      continue;
    }
    const key = `${normalizarCnpj(r.doc_fundo)}|${r.data_referencia}|${chave}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedup.push(r);
    }
  }

  return dedup;
}

async function buscarImportEstoque(
  cleanCnpj: string,
  dtPosicaoIso: string,
): Promise<{ id: string; reference_date: string } | null> {
  const matchFund = (imports: Array<{ id: string; fund_document: string | null; reference_date: string }>) =>
    imports.find((imp) => normalizarCnpj(imp.fund_document) === cleanCnpj) ?? null;

  const { data: importsAtePosicao } = await supabase
    .from('importacoes_estoque_fidc')
    .select('id, fund_document, reference_date, status')
    .in('status', ['success', 'partial_success'])
    .lte('reference_date', dtPosicaoIso)
    .order('reference_date', { ascending: false })
    .limit(100);

  const matchAte = matchFund(importsAtePosicao || []);
  if (matchAte) {
    return { id: matchAte.id, reference_date: String(matchAte.reference_date).slice(0, 10) };
  }

  const { data: importsRecentes } = await supabase
    .from('importacoes_estoque_fidc')
    .select('id, fund_document, reference_date, status')
    .in('status', ['success', 'partial_success'])
    .order('reference_date', { ascending: false })
    .limit(200);

  const matchRecente = matchFund(importsRecentes || []);
  if (!matchRecente) return null;

  return {
    id: matchRecente.id,
    reference_date: String(matchRecente.reference_date).slice(0, 10),
  };
}

async function loadEstoqueRecebiveis(
  cleanCnpj: string,
  dtPosicaoIso: string,
): Promise<LoadEstoqueResult> {
  const empty: LoadEstoqueResult = {
    rows: [],
    dataReferenciaEstoque: null,
    importId: null,
    semEstoque: true,
    estoque_pos_data_posicao: false,
  };

  const matchingImport = await buscarImportEstoque(cleanCnpj, dtPosicaoIso);
  if (!matchingImport) {
    console.log(`[rules-tributario-art4-fidc] Nenhum import de estoque para ${cleanCnpj}`);
    return empty;
  }

  const estoquePosDataPosicao = matchingImport.reference_date > dtPosicaoIso;
  console.log(
    `[rules-tributario-art4-fidc] Import ${matchingImport.id} ref=${matchingImport.reference_date}` +
    (estoquePosDataPosicao ? ' (mais recente disponível — posterior à posição)' : ''),
  );

  const { data: estoqueRaw, error } = await supabase
    .from('estoque_fidc')
    .select(
      'id, import_id, data_referencia, data_vencimento_ajustada, data_vencimento_original, ' +
      'valor_presente, valor_nominal, prazo, prazo_atual, tipo_recebivel, nome_sacado, ' +
      'situacao_recebivel, doc_fundo, seu_numero, nu_documento',
    )
    .eq('import_id', matchingImport.id);

  if (error) {
    console.error(`[rules-tributario-art4-fidc] Erro estoque_fidc: ${error.message}`);
    return empty;
  }

  const rowsFund = ((estoqueRaw || []) as EstoqueRow[]).filter((r) => {
    const doc = normalizarCnpj(r.doc_fundo);
    return !doc || doc === '00000000000000' || doc === cleanCnpj;
  });

  const dtRefEstoque = matchingImport.reference_date;
  const dedup = deduplicarEstoque(rowsFund);

  const elegiveis: EstoqueRow[] = [];
  for (const r of dedup) {
    if (situacaoExcluida(r.situacao_recebivel)) continue;
    const valor = Number(r.valor_presente ?? r.valor_nominal ?? 0) || 0;
    if (valor <= 0) continue;
    const prazoInfo = prazoRecebivelEstoque(r, dtRefEstoque);
    if (!prazoInfo) continue;
    elegiveis.push(r);
  }

  console.log(
    `[rules-tributario-art4-fidc] Estoque: ${elegiveis.length}/${dedup.length} recebíveis no WAM` +
    ` (inclui vencidos com prazo 0d; exclui inadimplente/baixado)`,
  );

  return {
    rows: elegiveis,
    dataReferenciaEstoque: dtRefEstoque,
    importId: matchingImport.id,
    semEstoque: elegiveis.length === 0,
    estoque_pos_data_posicao: estoquePosDataPosicao,
  };
}

async function loadPatliqFallback(
  cnpjVariants: string[],
  dtVariants: string[],
): Promise<number> {
  const { data: plNaData } = await supabase
    .from('posicao_carteira' as any)
    .select('fundo_patliq')
    .in('fundo_cnpj', cnpjVariants)
    .in('fundo_dtposicao', dtVariants)
    .limit(1)
    .maybeSingle();

  const pl1 = Number(plNaData?.fundo_patliq ?? 0) || 0;
  if (pl1 > 0) return pl1;

  const { data: plRecente } = await supabase
    .from('posicao_carteira' as any)
    .select('fundo_patliq')
    .in('fundo_cnpj', cnpjVariants)
    .order('fundo_dtposicao', { ascending: false })
    .limit(1)
    .maybeSingle();

  return Number(plRecente?.fundo_patliq ?? 0) || 0;
}

function agruparRecebiveisPorTipo(
  rows: EstoqueRow[],
  dtRefEstoqueIso: string,
): AtivoWam[] {
  const grupos = new Map<string, { valor: number; somaPrazo: number; qtd: number; qtdVencidos: number }>();

  for (const r of rows) {
    const valor = Number(r.valor_presente ?? r.valor_nominal ?? 0) || 0;
    const prazoInfo = prazoRecebivelEstoque(r, dtRefEstoqueIso);
    if (!prazoInfo || valor <= 0) continue;

    const tipo = (r.tipo_recebivel || 'Recebível').trim() || 'Recebível';
    const acc = grupos.get(tipo) ?? { valor: 0, somaPrazo: 0, qtd: 0, qtdVencidos: 0 };
    acc.valor += valor;
    acc.somaPrazo += valor * prazoInfo.prazo;
    acc.qtd += 1;
    if (prazoInfo.vencido) acc.qtdVencidos += 1;
    grupos.set(tipo, acc);
  }

  const ativos: AtivoWam[] = [];
  for (const [tipo, acc] of grupos) {
    const prazoMedioTipo = acc.valor > 0 ? acc.somaPrazo / acc.valor : 0;
    const detVencidos = acc.qtdVencidos > 0
      ? ` (${acc.qtdVencidos} vencido${acc.qtdVencidos !== 1 ? 's' : ''} a 0d)`
      : '';
    ativos.push({
      nome: tipo,
      cnpj: null,
      valor: acc.valor,
      prazo_dias: Math.round(prazoMedioTipo * 100) / 100,
      section: 'estoque',
      motivo: `${acc.qtd} recebível(is)${detVencidos} — prazo médio ${prazoMedioTipo.toFixed(1)}d`,
      excluido: false,
      qtd_linhas: acc.qtd,
    });
  }

  return ativos.sort((a, b) => b.valor - a.valor);
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
    console.warn(`[rules-tributario-art4-fidc] Erro ao carregar série anual: ${error.message}`);
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

    console.log(`[rules-tributario-art4-fidc] Verificando ${fundo_cnpj} isin=${fundo_isin || '(none)'} em ${fundo_dtposicao}`);

    const cleanCnpj = String(fundo_cnpj).replace(/\D/g, '').padStart(14, '0');
    const cnpjVariants = cnpjStorageVariants(fundo_cnpj);

    const regraAssoc = await resolveRegraArt4FidcAssociada(cnpjVariants, fundo_isin);
    const codigoRegraAtivo = regraAssoc?.codigo ?? CODIGO_REGRA;
    const regraParams = regraAssoc?.parametros ?? null;
    const limiteDiasRegra = Number(regraParams?.limite_dias) || LIMITE_DIAS;
    const alertaDiasRegra = Number(regraParams?.alerta_dias) || ALERTA_DIAS;

    if (!regraAssoc) {
      console.log(
        `[rules-tributario-art4-fidc] ${fundo_cnpj} — regra Art. 4º FIDC não associada, ignorando.`,
      );
      await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, CATEGORIA, []);
      return new Response(
        JSON.stringify({
          success: true,
          results: [],
          motivo: 'Regra FIDC Art. 4º não associada manualmente ao fundo',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const ymd8 = normalizeDtPos(fundo_dtposicao);
    const dtRef = `${ymd8.slice(0, 4)}-${ymd8.slice(4, 6)}-${ymd8.slice(6, 8)}`;
    const dtVariants = expandFundoDtposicaoQueryVariants(fundo_dtposicao);

    const fundChar = await loadFundCharProprio(cnpjVariants);
    const defasagem = Number(fundChar?.defasagem_dias_trib ?? 0) || 0;
    const dtEfetiva = defasagem > 0 ? subtrairDiasUteis(dtRef, defasagem) : dtRef;
    const dtVariantsEfetivas = defasagem > 0
      ? expandFundoDtposicaoQueryVariants(dtEfetiva.replace(/-/g, ''))
      : dtVariants;

    if (defasagem > 0) {
      console.log(
        `[rules-tributario-art4-fidc] Defasagem D-${defasagem}: posição ${dtEfetiva} → ref ${dtRef}`,
      );
    }

    let posQuery = supabase
      .from('posicao_carteira' as any)
      .select(
        'section, fundo_patliq, valor_padrao, saldo, dtvencimento, nomecomercial, ' +
        'codativo, idinternoativo, isin, possui_compromisso',
      )
      .in('fundo_cnpj', cnpjVariants)
      .in('fundo_dtposicao', dtVariantsEfetivas);
    if (fundo_isin) posQuery = (posQuery as any).eq('fundo_isin', fundo_isin);
    const { data: posicoes, error: posError } = await posQuery;

    if (posError) throw posError;

    const rows = (posicoes || []) as Record<string, unknown>[];
    let totalPL = rows.length > 0 ? Number(rows[0]?.fundo_patliq ?? 0) || 0 : 0;
    if (totalPL <= 0) {
      totalPL = await loadPatliqFallback(cnpjVariants, dtVariantsEfetivas);
    }
    const normSection = (s: unknown) => String(s ?? '').toLowerCase().trim();

    if (fundChar && isComposicaoCic(fundChar.composicao_fundo)) {
      const resultado = buildNaoAplicavelResult(
        'FIQ (composição CIC) — use TRIB_FIQ_LP_90 (Art. 5º)',
        fundChar,
        totalPL,
        { regra_sugerida: 'TRIB_FIQ_LP_90' },
      );
      await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, CATEGORIA, [resultado]);
      return new Response(
        JSON.stringify({ success: true, results: [resultado] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (fundChar && !isFundoFidcProprio(fundChar.nivel1_categoria)) {
      const resultado = buildNaoAplicavelResult(
        `Fundo ${fundChar.nivel1_categoria ?? '—'} não é FIDC — use TRIB_FIM_LP_365 se aplicável`,
        fundChar,
        totalPL,
        { regra_sugerida: 'TRIB_FIM_LP_365' },
      );
      await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, CATEGORIA, [resultado]);
      return new Response(
        JSON.stringify({ success: true, results: [resultado] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const {
      rows: estoqueRows,
      dataReferenciaEstoque,
      importId,
      semEstoque,
      estoque_pos_data_posicao,
    } = await loadEstoqueRecebiveis(cleanCnpj, dtEfetiva);

    const dtRefEstoque = dataReferenciaEstoque ?? dtEfetiva;
    const ativos: AtivoWam[] = [];

    if (estoqueRows.length > 0) {
      ativos.push(...agruparRecebiveisPorTipo(estoqueRows, dtRefEstoque));
    }

    // Carregar cronogramas de amortização para títulos RF não-FIDC presentes na posição
    const tituloRowsPos = rows.filter((r) => SECTIONS_TITULOS.has(normSection(r.section)));
    const chavesRfFidc = new Set<string>();
    for (const r of tituloRowsPos) {
      for (const c of resolveChavesAtivoRf(r)) chavesRfFidc.add(c);
    }
    const fluxosMapFidc = await carregarFluxosRfFidc(Array.from(chavesRfFidc));
    const qtdComFluxoFidc = tituloRowsPos.filter((r) =>
      resolveChavesAtivoRf(r).some((c) => (fluxosMapFidc.get(c)?.length ?? 0) > 0)
    ).length;
    if (qtdComFluxoFidc > 0) {
      console.log(`[rules-tributario-art4-fidc] ${fundo_cnpj} — ${qtdComFluxoFidc} título(s) RF com cronograma (inciso II)`);
    }

    for (const row of rows) {
      const section = normSection(row.section);
      if (section === 'fidc') continue;

      let valor = 0;
      let prazo = 0;
      let motivo = '';
      let nome = '';
      let metodo_prazo: 'vencimento' | 'fluxo_nominal' = 'vencimento';
      let qtd_fluxos: number | undefined;

      if (SECTIONS_CAIXA.has(section)) {
        valor = Number(row.saldo ?? row.valor_padrao ?? 0) || 0;
        prazo = PRAZO_CAIXA;
        motivo = `Caixa → ${PRAZO_CAIXA}d (Art. 4º §3º analogia CP)`;
        nome = String(row.nomecomercial ?? 'Caixa').trim() || 'Caixa';
      } else if (SECTIONS_TITULOS.has(section)) {
        valor = Number(row.valor_padrao ?? 0) || 0;
        if (valor <= 0) continue;
        const prazoInfo = resolvePrazoTituloRfFidc(row, section, dtEfetiva, fluxosMapFidc);
        prazo = prazoInfo.prazo;
        motivo = prazoInfo.motivo;
        metodo_prazo = prazoInfo.metodo_prazo;
        qtd_fluxos = prazoInfo.qtd_fluxos;
        nome = nomeTituloRendaFixa(row, section);
      } else if (SECTIONS_TERMO.has(section)) {
        valor = Number(row.valor_padrao ?? 0) || 0;
        if (valor <= 0) continue;
        prazo = PRAZO_COMPROMISSADA;
        motivo = `${section} termo/compromissada → ${PRAZO_COMPROMISSADA}d`;
        nome = nomeTituloRendaFixa(row, section);
      } else {
        continue;
      }

      if (valor <= 0) continue;

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

    const elegiveis = ativos.filter((a) => !a.excluido);
    const valorElegivel = elegiveis.reduce((s, a) => s + a.valor, 0);
    const patliqExibicao = totalPL > 0 ? totalPL : valorElegivel;

    if (valorElegivel <= 0) {
      const resultado = buildNaoAplicavelResult(
        semEstoque
          ? 'Sem estoque FIDC importado e sem caixa/títulos RF na posição'
          : 'Nenhum ativo elegível para cálculo do prazo médio',
        fundChar,
        patliqExibicao,
        { sem_estoque: semEstoque, import_id: importId },
      );
      await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, CATEGORIA, [resultado]);
      return new Response(
        JSON.stringify({ success: true, results: [resultado] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const somaPonderada = elegiveis.reduce((s, a) => s + a.valor * a.prazo_dias, 0);
    const prazoMedio = somaPonderada / valorElegivel;

    const divergenciaPl = patliqExibicao > 0
      ? Math.abs(valorElegivel - patliqExibicao) / patliqExibicao
      : 0;
    const conciliacaoOk = divergenciaPl <= TOLERANCIA_CONCILIACAO;

    const status: RuleStatus = prazoMedio <= limiteDiasRegra
      ? 'violacao'
      : prazoMedio <= alertaDiasRegra
      ? 'alerta'
      : 'ok';

    const avisos_dados: string[] = [];
    if (!conciliacaoOk) {
      avisos_dados.push(
        `Divergência PL vs estoque: ${(divergenciaPl * 100).toFixed(1)}% (tolerância ${TOLERANCIA_CONCILIACAO * 100}%)`,
      );
    }
    if (semEstoque && elegiveis.every((a) => a.section !== 'estoque')) {
      avisos_dados.push('Sem estoque FIDC importado — cálculo só com caixa/títulos da posição');
    }
    if (estoque_pos_data_posicao) {
      avisos_dados.push('Estoque FIDC com data posterior à posição da carteira');
    }

    const descricaoStatus = prazoMedio > limiteDiasRegra
      ? `FIDC LP tributário: prazo médio = ${prazoMedio.toFixed(2)}d (> ${limiteDiasRegra}d)`
      : `FIDC CP tributário: prazo médio = ${prazoMedio.toFixed(2)}d ≤ ${limiteDiasRegra}d (IN RFB 1585 Art. 4º)`;

    const qtdVencidosEstoque = estoqueRows.filter((r) => {
      const p = prazoRecebivelEstoque(r, dtRefEstoque);
      return p?.vencido === true;
    }).length;

    const ano = parseInt(ymd8.slice(0, 4), 10);
    const dataContagem = dataReferenciaEstoque ?? dtRef;
    const serieAno = await carregarSerieAnoArt4(cleanCnpj, fundo_isin, codigoRegraAtivo, ano);
    const { eventos_ano, dias_violacao_ano } = calcularContadoresAnoArt4(
      serieAno,
      limiteDiasRegra,
      dataContagem,
      prazoMedio,
    );

    const ativos_contabilizados = ativos.map((a: any) => ({
      nome: a.nome,
      cnpj: a.cnpj,
      valor: a.valor,
      percentual: patliqExibicao > 0 ? a.valor / patliqExibicao : (valorElegivel > 0 ? a.valor / valorElegivel : 0),
      prazo_dias: a.excluido ? null : a.prazo_dias,
      contribuicao_dias: a.excluido ? null : (a.valor / valorElegivel) * a.prazo_dias,
      tipo: a.excluido ? 'excluido' : 'contabilizado',
      motivo: a.motivo,
      section: a.section,
      qtd_linhas: a.qtd_linhas ?? undefined,
      metodo_prazo: a.metodo_prazo ?? 'vencimento',
      qtd_fluxos: a.qtd_fluxos ?? undefined,
    }));

    const somaRecebiveis = elegiveis
      .filter((a) => a.section === 'estoque')
      .reduce((s, a) => s + a.valor, 0);
    const somaCaixa = elegiveis
      .filter((a) => a.section === 'caixa')
      .reduce((s, a) => s + a.valor, 0);
    const somaTitulos = elegiveis
      .filter((a) => SECTIONS_TITULOS.has(a.section) || SECTIONS_TERMO.has(a.section))
      .reduce((s, a) => s + a.valor, 0);

    const resultado: RuleResult = {
      regra_codigo: codigoRegraAtivo,
      regra_descricao: `FIDC: prazo médio tributário > ${limiteDiasRegra}d (IN RFB 1585/2015 Art. 4º)`,
      status,
      valor_atual: prazoMedio / limiteDiasRegra,
      valor_limite: 1,
      detalhes: {
        prazo_medio_dias: Math.round(prazoMedio * 100) / 100,
        limite_dias: limiteDiasRegra,
        alerta_dias: alertaDiasRegra,
        avisos_dados: avisos_dados.length > 0 ? avisos_dados : null,
        patliq: patliqExibicao,
        pl_total: patliqExibicao,
        pl_xml: totalPL > 0 ? totalPL : null,
        valor_elegivel: valorElegivel,
        valor_excluido: 0,
        total_valor_carteira: valorElegivel,
        qtd_recebiveis_estoque: estoqueRows.length,
        qtd_vencidos_estoque: qtdVencidosEstoque,
        incluir_vencidos_prazo_zero: true,
        qtd_grupos_recebivel: elegiveis.filter((a) => a.section === 'estoque').length,
        qtd_caixa: elegiveis.filter((a) => a.section === 'caixa').length,
        qtd_titulos_rf: elegiveis.filter((a) => SECTIONS_TITULOS.has(a.section)).length,
        soma_recebiveis: somaRecebiveis,
        soma_caixa: somaCaixa,
        soma_titulos_rf: somaTitulos,
        data_referencia_estoque: dataReferenciaEstoque,
        import_id_estoque: importId,
        estoque_pos_data_posicao,
        sem_estoque: semEstoque,
        conciliacao_ok: conciliacaoOk,
        divergencia_pl_pct: Math.round(divergenciaPl * 10000) / 100,
        defasagem_dias: defasagem,
        data_referencia: dataReferenciaEstoque ?? dtRef,
        dt_posicao_efetiva: dtEfetiva,
        dt_posicao_xml: dtRef,
        descricao_status: descricaoStatus,
        classificacao_tributaria: prazoMedio > limiteDiasRegra ? 'lp' : 'cp',
        is_lp_tributario: prazoMedio > limiteDiasRegra,
        norma_aplicada: 'Art. 4º',
        fonte_recebiveis: 'estoque_fidc',
        motivo_norma: `${fundChar?.nivel1_categoria ?? 'FIDC'} — prazo médio via estoque de direitos creditórios`,
        composicao_fundo: fundChar?.composicao_fundo ?? null,
        nivel1_categoria: fundChar?.nivel1_categoria ?? null,
        eventos_ano,
        dias_violacao_ano,
        max_eventos_ano: MAX_EVENTOS_ANO_ART4,
        max_dias_violacao_ano: MAX_DIAS_VIOLACAO_ANO_ART4,
        ativos_contabilizados,
      },
    };

    await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, CATEGORIA, [resultado]);

    console.log(
      `[rules-tributario-art4-fidc] Concluído: status=${status} | WAM=${prazoMedio.toFixed(2)}d | ` +
      `recebíveis=${estoqueRows.length} | valor=${valorElegivel.toFixed(0)}`,
    );

    return new Response(
      JSON.stringify({ success: true, results: [resultado] } as RuleCheckResponse),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('[rules-tributario-art4-fidc] Erro inesperado:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message } as RuleCheckResponse),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
