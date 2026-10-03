import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Vértices da matriz ANBIMA (dias úteis) - inclui 252, 378, 504, 720, 1260 (>720 dias) para ativos de longo prazo
const VERTICES = [1, 2, 3, 4, 5, 10, 21, 42, 63, 126, 252, 378, 504, 720, 1260];

type RuleStatus = 'ok' | 'alerta' | 'violacao';

interface RowWithPrazo {
  id: string;
  nome: string;
  valor: number;
  prazos_em_dias: number | null;
  vertice: number;
  section: string;
  fonte?: string; // 'informe_mensal_fidc' | 'estoque_fidc' | 'informe_fidc_fallback' | 'fip_lookthrough'
  /** Quando o prazo veio do look-through (participações do FIP com data_liquidez_prevista) */
  look_through?: {
    resumo: string;
    fip_cnpj: string;
    detalhes?: Array<{ nome: string; valor: number; pct: number; data_liquidez: string; dias: number }>;
  };
}

/**
 * Categorias de fundos estruturados que NÃO têm come-cotas.
 * FIP, FIDC, FII, FIAGRO estruturado e equivalentes não são tributados via come-cotas.
 */
const NIVEL1_SEM_COME_COTAS = new Set([
  'FIP', 'FIDC', 'FIDCNP', 'FII', 'FIAGRO', 'FIAGROFIP',
]);

type CoverageStatus = 'ok' | 'alerta' | 'violacao' | 'indisponivel';

interface DespesaBreakdownItem {
  categoria: string;       // ex: 'taxa_administracao'
  mediaMonsal: number;     // média mensal da categoria em R$
  percentual: number;      // % sobre o total (0-100)
  mesesDisponivel: number; // quantos meses de histórico existem para essa categoria
}

interface FundoFechadoAnalise {
  prazoResgate: number;
  disponibilidade: number;
  dispPL: number;
  pl: number;
  status: RuleStatus;
  despesaOperacionalMensal: number | null;
  despesaBreakdown: DespesaBreakdownItem[] | null; // detalhamento por categoria
  darfEstimado: number;
  caixaLiquido: number;
  mesesCobertura: number | null;
  statusCoberturaDespesa: CoverageStatus;
  fonteDespesa: string | null;
  temComeCottas: boolean;
  cotaBaseComeCottas: number | null;
  rentSemestre: number | null;
}

interface DarfAbertoAnalise {
  darfEstimado: number;
  temComeCottas: boolean;
  cotaBaseComeCottas: number | null;
  rentSemestre: number | null;
}

/** Situações de recebível a excluir da liquidez (base conservadora) */
const SITUACOES_EXCLUIR_LIQUIDEZ = [
  'inadimplente', 'cobrança', 'cobranca', 'litigioso', 'judicial',
  'protestado', 'recuperação', 'recuperacao', 'perda', 'baixado',
];

function situacaoExcluidaLiquidez(situacao: string | null | undefined): boolean {
  if (!situacao || !String(situacao).trim()) return false;
  const s = String(situacao).trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return SITUACOES_EXCLUIR_LIQUIDEZ.some((ex) => {
    const exNorm = ex.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    return s.includes(exNorm);
  });
}

function getPrazoManualDias(row: any): number | null {
  const raw = Array.isArray(row?.ativos)
    ? row.ativos[0]?.prazo_liquidez_manual_dias
    : row?.ativos?.prazo_liquidez_manual_dias;

  if (raw == null || Number.isNaN(Number(raw))) return null;
  const value = Number(raw);
  return value >= 0 ? value : null;
}

function getPrazoDuracaoAnos(row: any): number | null {
  const raw = Array.isArray(row?.ativos)
    ? row.ativos[0]?.prazo_duracao_fundo_anos
    : row?.ativos?.prazo_duracao_fundo_anos;

  if (raw == null || Number.isNaN(Number(raw))) return null;
  const value = Number(raw);
  return value >= 0 ? value : null;
}

function getDataLiquidezPrevista(row: any): string | null {
  const raw = Array.isArray(row?.ativos)
    ? row.ativos[0]?.data_liquidez_prevista
    : row?.ativos?.data_liquidez_prevista;
  if (raw == null) return null;
  const value = String(raw).trim();
  return value.length > 0 ? value : null;
}

function getAtivoDescricao(row: any): string | null {
  const raw = Array.isArray(row?.ativos)
    ? row.ativos[0]?.descricao
    : row?.ativos?.descricao;
  if (raw == null) return null;
  const value = String(raw).trim();
  return value.length > 0 ? value : null;
}

function getAtivoNomeFrontend(row: any): string | null {
  const raw = Array.isArray(row?.ativos)
    ? row.ativos[0]?.nome_frontend
    : row?.ativos?.nome_frontend;
  if (raw == null) return null;
  const value = String(raw).trim();
  return value.length > 0 ? value : null;
}

/** Placeholder gravado em `ativos` quando o sync não encontrou nome no cadastro. */
function isNomePlaceholderAtivo(nome: string | null | undefined): boolean {
  if (!nome?.trim()) return true;
  const n = nome.trim();
  if (/^FUNDO CNPJ\s+\d/i.test(n)) return true;
  if (/^FIDC\s*-\s*\d/i.test(n)) return true;
  return false;
}

function pickNomeAtivo(...candidatos: (string | null | undefined)[]): string | null {
  for (const c of candidatos) {
    const v = c?.trim();
    if (v && !isNomePlaceholderAtivo(v)) return v;
  }
  for (const c of candidatos) {
    const v = c?.trim();
    if (v) return v;
  }
  return null;
}

function resolveNomeAtivoLinha(
  row: any,
  charMap: Map<string, { nome_comercial: string | null }>,
  registryNameMap: Map<string, string>,
  toCnpjKey: (v: string | number) => string,
  resolveChar?: (rowIsin: string | null, cnpjDigits: string | null) => { nome_comercial: string | null } | null,
  fallback = 'Ativo',
): string {
  const cnpjCota = row.cnpjfundo ? String(row.cnpjfundo).replace(/\D/g, '') : null;
  const cnpjEmissor = row.cnpjemissor ? String(row.cnpjemissor).replace(/\D/g, '') : null;
  const cnpjKey = cnpjCota || cnpjEmissor;
  const rowIsin = row.isin ? String(row.isin).trim() : null;
  const char = resolveChar?.(rowIsin, cnpjKey);
  const nomeChar =
    char?.nome_comercial ||
    (cnpjCota && charMap.get(cnpjCota)?.nome_comercial) ||
    (cnpjEmissor && charMap.get(cnpjEmissor)?.nome_comercial) ||
    null;
  const nomeRegistro = cnpjKey ? registryNameMap.get(toCnpjKey(cnpjKey)) : null;

  const picked = pickNomeAtivo(
    getAtivoNomeFrontend(row),
    row.nome_comercial_ativo,
    row.nome_ativo,
    nomeChar,
    nomeRegistro,
    getAtivoDescricao(row),
    row.nomecomercial,
  );

  return picked || cnpjKey || row.isin || row.id || fallback;
}

/** Normaliza nome de ativo: lowercase, sem acento, espaços normalizados */
function normNomeAtivo(s: string): string {
  return String(s).trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ');
}

/**
 * Compara dois nomes de fundo por interseção de tokens significativos.
 * Exclui palavras genéricas (fi, fic, fundo, cotas...) e exige que pelo menos
 * 60% dos tokens do nome mais curto estejam presentes no outro.
 * Mais robusto que includes() quando os nomes têm comprimentos diferentes.
 */
const STOPWORDS_FUNDO = new Set([
  'fi','fic','fim','fip','fidc','fii','fif','qi','cp','rf','rp','di',
  'de','em','do','da','e','o','a','cotas','fundo','investimento',
  'creditorios','direitos','cotas','gestao','capital','renda','fixa',
  'multimercado','acoes','credito','privado','longo','prazo','curto',
]);

function nomesSimilares(nomeCarteira: string, nomeExtraido: string): boolean {
  const tokens = (s: string) =>
    s.split(/\s+/).filter((t) => t.length >= 3 && !STOPWORDS_FUNDO.has(t));

  const ta = new Set(tokens(nomeCarteira));
  const tb = new Set(tokens(nomeExtraido));
  if (ta.size === 0 || tb.size === 0) return false;

  const intersecao = [...ta].filter((t) => tb.has(t)).length;
  const minSize = Math.min(ta.size, tb.size);
  return intersecao >= Math.ceil(minSize * 0.6);
}

const PREFIXO_RESG_COTAS = 'resgate de cotas do fundo ';

/**
 * Extrai o nome do fundo investido da coluna Descrição da planilha CaixaFluxoFinanceiro.
 * Padrão confirmado nos dados: "Resgate de cotas do fundo <NOME>".
 * Registra warning quando o prefixo não é encontrado para detectar variações futuras.
 */
function extrairNomeFundo(descricao: string): string {
  const n = normNomeAtivo(descricao);
  if (n.startsWith(PREFIXO_RESG_COTAS)) {
    return n.slice(PREFIXO_RESG_COTAS.length).trim();
  }
  console.warn(
    `[calculo-risco-liquidez] extrairNomeFundo: prefixo inesperado — "${descricao}" ` +
    `— usando texto completo como chave de match`
  );
  return n;
}

interface VerticeRow {
  vertice: number;
  ativoVertice: number;
  probabilidade: number;
  ativoAcumulado: number;
  /** Passivo estimado pela Matriz ANBIMA (probabilidade × PL) — exibido na coluna "Prob. Resgate Valor" */
  passivoNoVertice: number;
  resgatesSolicitados: number;
  /**
   * Passivo acumulado efetivo: soma de (resgates solicitados quando > 0, senão ANBIMA × PL) vértice a vértice.
   * Usado no Índice Acumulado.
   */
  passivoAcumulado: number;
  acumuladoLiquido: number;
  indice: number;
  status: RuleStatus;
  indiceAcumulado: number;
  estadoAcumulado: RuleStatus;
  posicaoPL: number;
  statusPosicao: RuleStatus;
  statusConsolidado: RuleStatus;
  /** Soma dos resgates confirmados de portfólio chegando neste vértice (já incluídos no ativoVertice) */
  resgAtivosVertice: number;
  /** Resgates sem match de ativo na carteira — exibir marcação laranja no frontend */
  resgAtivosWarnings: { descricao: string; valor: number }[];
  ativosNoVertice: {
    nome: string;
    valor: number;
    prazo: number;
    fonte?: string;
    look_through_resumo?: string;
    look_through_fip_cnpj?: string;
    look_through_posicao_data?: string; // YYYYMMDD da posição do FIP usada no look-through
    look_through_detalhes?: Array<{ nome: string; valor: number; pct: number; data_liquidez: string; dias: number }>;
  }[];
}

interface FidcLiquidezEstimadaItem {
  cnpj: string;
  nome: string;
  valor_aplicado: number;
  pl_fidc: number;
  ownership_pct: number;
  vertice_d42: number;
  vertice_d63: number;
  vertice_d126: number;
  vertice_d252: number;
  vertice_d378: number;
  vertice_d720: number;
  vertice_d1260: number;
  total_estimado: number;
  /** Parcela ilíquida: valor_aplicado − total_estimado → alocada em D+1260 (D+720+) */
  residual_d1260?: number;
  dt_comptc: string | null;
}

interface FidcInformeEntry {
  pl: number | null;
  bucket_a1: number; bucket_a2: number; bucket_a3: number; bucket_a4: number;
  bucket_a5: number; bucket_a6: number; bucket_a7: number; bucket_a8: number;
  bucket_a9: number; bucket_a10: number;
  dt_comptc: string | null;
  has_buckets: boolean;
}

/** Converte string YYYYMMDD em Date */
function parseYyyymmdd(s: string): Date {
  const ymd = normalizeDtPosYYYYMMDD(s);
  if (ymd.length !== 8) return new Date(NaN);
  const y = parseInt(ymd.slice(0, 4), 10);
  const m = parseInt(ymd.slice(4, 6), 10) - 1;
  const d = parseInt(ymd.slice(6, 8), 10);
  return new Date(y, m, d);
}

/**
 * Padroniza fundo_dtposicao (request, PostgREST, DD/MM/AAAA, ISO, número, Date) → YYYYMMDD.
 * Comparações lexicográficas entre dois resultados são válidas apenas após esta função.
 */
function normalizeDtPosYYYYMMDD(raw: string | number | Date | null | undefined): string {
  if (raw == null) return '';
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return '';
    const y = raw.getUTCFullYear();
    const m = String(raw.getUTCMonth() + 1).padStart(2, '0');
    const d = String(raw.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const s = String(Math.trunc(Math.abs(raw)));
    if (s.length === 8) return s;
    if (s.length < 8) return s.padStart(8, '0');
    return s.slice(0, 8);
  }
  const s0 = String(raw).trim();
  if (!s0) return '';
  const iso = s0.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  const br = s0.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (br) {
    const dd = br[1].padStart(2, '0');
    const mm = br[2].padStart(2, '0');
    return `${br[3]}${mm}${dd}`;
  }
  if (/^\d{8}$/.test(s0)) return s0;
  const digits = s0.replace(/\D/g, '');
  if (digits.length >= 8) {
    const head = digits.slice(0, 8);
    const yHead = parseInt(head.slice(0, 4), 10);
    if (yHead >= 1900 && yHead <= 2200) return head;
    const yEnd = parseInt(digits.slice(4, 8), 10);
    if (yEnd >= 1900 && yEnd <= 2200 && digits.length >= 8) {
      return `${digits.slice(4, 8)}${digits.slice(2, 4)}${digits.slice(0, 2)}`;
    }
    return head;
  }
  return '';
}

/** Variantes de data para bater com o formato gravado em posicao_carteira.fundo_dtposicao */
function expandFundoDtposicaoQueryVariants(raw: string | null | undefined): string[] {
  const ymd = normalizeDtPosYYYYMMDD(raw);
  const set = new Set<string>();
  const r = String(raw ?? '').trim();
  if (r) set.add(r);
  if (ymd.length === 8) {
    set.add(ymd);
    set.add(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`);
  }
  return [...set];
}

/**
 * Data de referência única da carteira (YYYYMMDD), alinhada ao pai.
 * Evita ref vazia — caso típico do bug em que look-through usava todas as datas do FIP-filho.
 */
function resolveYmdReferenciaCarteira(posicoes: any[] | null | undefined, requestFundoDt: string): string {
  const req = normalizeDtPosYYYYMMDD(requestFundoDt);
  for (const p of posicoes || []) {
    const d = normalizeDtPosYYYYMMDD(p.fundo_dtposicao);
    if (d.length === 8) return d;
  }
  return req;
}

/** Converte string YYYY-MM-DD em Date */
function parseIsoDate(s: string): Date {
  if (!s || s.length !== 10) return new Date(NaN);
  const y = parseInt(s.slice(0, 4), 10);
  const m = parseInt(s.slice(5, 7), 10) - 1;
  const d = parseInt(s.slice(8, 10), 10);
  return new Date(y, m, d);
}

/** YYYY-MM-DD → DD/MM/YYYY para textos de UI/export */
function formatIsoDateBr(iso: string): string {
  const s = String(iso).trim().slice(0, 10);
  if (s.length !== 10 || s[4] !== '-' || s[7] !== '-') return iso;
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
}

/** Calcula dias úteis entre duas datas (exclui fins de semana) */
function diasUteisEntreDatas(d1: Date, d2: Date): number {
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return 0;
  const start = d1 < d2 ? d1 : d2;
  const end = d1 < d2 ? d2 : d1;
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/**
 * Mapeia prazo em dias para o vértice ANBIMA (fórmula SES da planilha).
 * Prazos 0 (caixa D+0) vão para vértice D+1.
 */
function prazoParaVertice(prazos_em_dias: number | null): number | null {
  if (prazos_em_dias == null) return null;
  const p = prazos_em_dias === 0 ? 1 : prazos_em_dias; // 0 -> D+1
  if (p > 720) return 1260;   // D+1260 = prazos > 720 dias
  if (p >= 505) return 720;
  if (p >= 365) return 504;
  if (p >= 181) return 378;
  if (p === 123) return 252;
  if (p >= 63) return 126;
  if (p >= 42) return 63;
  if (p >= 23) return 42;
  if (p >= 10) return 21;
  if (p >= 5) return 10;
  if (p >= 4) return 5;
  if (p >= 3) return 4;
  if (p >= 2) return 3;
  if (p > 1) return 2;
  return 1;
}

/** Retorna o prazo para lookup na matriz (vértice já é o prazo) */
function verticeParaLookup(vertice: number): number {
  return vertice;
}

/**
 * Obtém probabilidade de resgate para um vértice.
 * - Vértice na matriz: usa valor direto.
 * - Vértice intermediário (ex: 62, 122): usa prob. do vértice anterior na matriz.
 * - Vértice acima de 126 (ex: 252, 378, 504, 720, 1260): usa 50% da prob. do vértice 126.
 */
function getProbabilidade(vertice: number, probMap: Map<number, number>): number {
  const direct = probMap.get(vertice);
  if (direct != null) return direct;

  if (vertice > 126) {
    const prob126 = probMap.get(126) ?? 0;
    return prob126 * 0.5;
  }

  // Vértice intermediário: usar prob. do maior vértice na matriz que seja < vertice
  const prazosMatriz = [1, 2, 3, 4, 5, 10, 21, 42, 63, 126];
  let anterior = 0;
  for (const p of prazosMatriz) {
    if (p < vertice) anterior = p;
    else break;
  }
  return probMap.get(anterior) ?? 0;
}

/**
 * Retorna candidatos de mês/ano para a data base do come-cotas (último útil de mai ou nov).
 * Prioridade: mês mais recente primeiro. Dois candidatos para fallback.
 */
function getComeCotasBaseCandidates(dtPosicao: Date): Array<{ year: number; month: number }> {
  const year = dtPosicao.getFullYear();
  const month = dtPosicao.getMonth() + 1; // 1-based
  // Dezembro → último foi Nov deste ano
  if (month >= 12) return [{ year, month: 11 }, { year, month: 5 }];
  // Jun–Nov → último foi Mai deste ano
  if (month >= 6)  return [{ year, month: 5 }, { year: year - 1, month: 11 }];
  // Jan–Mai → último foi Nov do ano anterior
  return [{ year: year - 1, month: 11 }, { year: year - 1, month: 5 }];
}

/** Determina status consolidado com base nos índices e prazo do fundo (F7) */
function getConsolidatedStatus(
  indiceVertice: number,
  indiceAcumulado: number,
  prazoFundo: number | null
): RuleStatus {
  const n = Math.abs(indiceVertice);
  const p = Math.abs(indiceAcumulado);
  const f7 = prazoFundo ?? 0;

  // HARD LIMIT: SE(OU(N12<=1;P12<=1);"HARD LIMIT"...)
  if (n <= 1 || p <= 1) return 'violacao';

  // SOFT LIMIT: SE(OU(E(N12>1;N12<SE($F$7<=60;1,2;SE($F$7<=126;1,1;1,05)));E(P12>1;P12<SE($F$7<=60;1,2;SE($F$7<=126;1,1;1,05)))));"SOFT LIMIT"...)
  let softLimitThreshold = 1.05;
  if (f7 <= 60) softLimitThreshold = 1.2;
  else if (f7 <= 126) softLimitThreshold = 1.1;

  if ((n > 1 && n < softLimitThreshold) || (p > 1 && p < softLimitThreshold)) {
    return 'alerta';
  }

  return 'ok';
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const {
      fundo_cnpj,
      fundo_isin = null,   // ISIN da subclasse do fundo analisado (opcional — precisão para FIDCs com múltiplas subclasses)
      fundo_dtposicao,
      classe = 'Multimercados',
      segmento_investidor = 'PRIVATE',
      metrica = 'media_simples',
      resgates_por_vertice = {},
      ignorar_resgates_solicitados = false,
    } = body;

    if (!fundo_cnpj || !fundo_dtposicao) {
      return new Response(
        JSON.stringify({ success: false, error: 'fundo_cnpj and fundo_dtposicao are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const cleanCnpj = String(fundo_cnpj).replace(/\D/g, '');

    const fundoDtVariants = expandFundoDtposicaoQueryVariants(String(fundo_dtposicao));

    // 1. Buscar posição da carteira (aceita fundo_dtposicao em YYYYMMDD ou ISO no request/banco)
    let posQuery = supabase
      .from('posicao_carteira')
      .select('*, ativos(prazo_liquidez_manual_dias, prazo_duracao_fundo_anos, nome_frontend, descricao, data_liquidez_prevista)')
      .eq('fundo_cnpj', fundo_cnpj);
    if (fundo_isin) posQuery = posQuery.eq('fundo_isin', String(fundo_isin).trim());
    posQuery = fundoDtVariants.length <= 1
      ? posQuery.eq('fundo_dtposicao', fundoDtVariants[0] ?? fundo_dtposicao)
      : posQuery.in('fundo_dtposicao', fundoDtVariants);
    const { data: posicoes, error: posError } = await posQuery;

    if (posError) throw posError;
    if (!posicoes || posicoes.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Nenhuma posição encontrada' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const ymdPosicaoCarteira = resolveYmdReferenciaCarteira(posicoes, String(fundo_dtposicao));
    const dtPosicao = parseYyyymmdd(ymdPosicaoCarteira.length === 8 ? ymdPosicaoCarteira : normalizeDtPosYYYYMMDD(fundo_dtposicao));
    if (ymdPosicaoCarteira.length !== 8) {
      console.warn(
        `[calculo-risco-liquidez] fundo_dtposicao da carteira não normalizou para YYYYMMDD (request=${fundo_dtposicao}) — look-through FIP não filtrará por data no banco`,
      );
    }

    const plHeaderXml = Number(posicoes[0]?.fundo_patliq ?? 0) || 0;
    let totalPL = plHeaderXml;

    const formatCnpj = (digits: string): string =>
      digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    const cleanCnpj14 = cleanCnpj.padStart(14, '0');
    const formattedCnpj = cleanCnpj14.length === 14 ? formatCnpj(cleanCnpj14) : cleanCnpj;

    let fundoIsinEfetivo: string | null = fundo_isin ? String(fundo_isin).trim().toUpperCase() : null;
    if ((!fundoIsinEfetivo || fundoIsinEfetivo.includes('*')) && posicoes?.[0]?.fundo_isin) {
      fundoIsinEfetivo = String(posicoes[0].fundo_isin).trim().toUpperCase();
    }
    if (fundoIsinEfetivo?.includes('*')) fundoIsinEfetivo = null;

    const rowMatchesCnpjFc = (
      row: { cnpj_classe?: string | number | null; cnpj_fundo?: string | number | null },
      fundoDigits: string,
    ): boolean => {
      const to14 = (v: unknown) => String(v ?? "").replace(/\D/g, "").padStart(14, "0");
      const t = to14(fundoDigits);
      if (!t) return false;
      return to14(row?.cnpj_classe) === t || to14(row?.cnpj_fundo) === t;
    };

    // 2. Características do fundo principal
    // Busca com CNPJ limpo E formatado para cobrir ambos os formatos de armazenamento.
    const normalizeCnpj = (v: unknown): string =>
      String(v ?? '').replace(/\D/g, '').padStart(14, '0');

    const toNumOrNull = (v: unknown): number | null => {
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    let fundCharRows: any[] = [];
    let fundCharByIsin: any | null = null;
    {
      // 2a. CNPJ + ISIN: aceita apenas se documento casa com o fundo analisado
      if (fundoIsinEfetivo) {
        const { data: byIsin } = await supabase
          .from('fundos_caracteristicas')
          .select('cnpj_classe, cnpj_fundo, prazo_pagamento_resgate_dias, aberto_estatutariamente, nome_comercial, nivel1_categoria, despesa_operacional_mensal, pl_formula')
          .eq('isin', fundoIsinEfetivo)
          .maybeSingle();
        if (byIsin && rowMatchesCnpjFc(byIsin as any, cleanCnpj14)) {
          fundCharByIsin = byIsin;
          console.log(
            `[calculo-risco-liquidez] Características resolvidas por CNPJ+ISIN (ISIN ${fundoIsinEfetivo}): prazo=${byIsin.prazo_pagamento_resgate_dias}`
          );
        }
      }

      // Sem match composto válido por ISIN
      if (!fundCharByIsin && fundoIsinEfetivo) {
        console.log(
          `[calculo-risco-liquidez] ISIN ${fundoIsinEfetivo} ignorado ou sem par CNPJ — fallback só por CNPJ`
        );
      }

      // 2b. Fallback CNPJ + filtro de estrutura (comportamento original).
      // Sempre executado para popular fundCharRows (usado por nivel1_categoria, isFundoFidc etc.).
      const cnpjVariants = [...new Set(
        [fundo_cnpj, cleanCnpj, cleanCnpj14, formattedCnpj].filter(Boolean)
      )];

      const seen = new Set<string>();
      const { data: byClasse } = await supabase
        .from('fundos_caracteristicas')
        .select('cnpj_classe, cnpj_fundo, prazo_pagamento_resgate_dias, aberto_estatutariamente, nome_comercial, nivel1_categoria, despesa_operacional_mensal, pl_formula')
        .in('cnpj_classe', cnpjVariants)
        .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo');
      const { data: byFundo } = await supabase
        .from('fundos_caracteristicas')
        .select('cnpj_classe, cnpj_fundo, prazo_pagamento_resgate_dias, aberto_estatutariamente, nome_comercial, nivel1_categoria, despesa_operacional_mensal, pl_formula')
        .in('cnpj_fundo', cnpjVariants)
        .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo');

      for (const r of [...(byClasse || []), ...(byFundo || [])] as any[]) {
        const key = normalizeCnpj(r.cnpj_classe) + '|' + normalizeCnpj(r.cnpj_fundo);
        if (!seen.has(key)) {
          seen.add(key);
          fundCharRows.push(r);
        }
      }
    }

    const fundCharCandidates = fundCharRows as Array<{
      cnpj_classe?: string | null;
      cnpj_fundo?: string | null;
      prazo_pagamento_resgate_dias?: number | string | null;
      aberto_estatutariamente?: string | null;
      nivel1_categoria?: string | null;
      despesa_operacional_mensal?: number | string | null;
    }>;

    const exactMatches = fundCharCandidates.filter((r) =>
      normalizeCnpj(r.cnpj_classe) === cleanCnpj14 || normalizeCnpj(r.cnpj_fundo) === cleanCnpj14
    );

    const withPrazo = (rows: typeof fundCharCandidates) =>
      rows.find((r) => toNumOrNull(r.prazo_pagamento_resgate_dias) != null) ?? null;

    const fundChar =
      fundCharByIsin ??          // ISIN exact match (subclasse específica) — maior prioridade
      withPrazo(exactMatches) ??
      withPrazo(fundCharCandidates) ??
      exactMatches[0] ??
      fundCharCandidates[0] ??
      null;

    let prazoFundoPrincipal = toNumOrNull(fundChar?.prazo_pagamento_resgate_dias);

    // Fallback: prazo preenchido no cardápio de ativos (Liq. Manual) ainda não espelhado em fundos_caracteristicas
    if (prazoFundoPrincipal == null && cleanCnpj.length >= 8) {
      const cnpjTryAtivo = [...new Set([cleanCnpj14, cleanCnpj, formattedCnpj].filter(Boolean))];
      for (const cnpjTry of cnpjTryAtivo) {
        const { data: ativoRow } = await supabase
          .from('ativos')
          .select('prazo_liquidez_manual_dias')
          .eq('tipo_ativo', 'FUNDO')
          .eq('cnpj', cnpjTry)
          .not('prazo_liquidez_manual_dias', 'is', null)
          .limit(1)
          .maybeSingle();
        const manual = toNumOrNull(ativoRow?.prazo_liquidez_manual_dias);
        if (manual != null) {
          prazoFundoPrincipal = manual;
          console.log(`[calculo-risco-liquidez] prazo do fundo via ativos.prazo_liquidez_manual_dias (${cnpjTry}) => D+${manual}`);
          break;
        }
      }
      if (prazoFundoPrincipal == null && fundo_isin) {
        const isinNorm = String(fundo_isin).trim();
        const { data: ativoByIsin } = await supabase
          .from('ativos')
          .select('prazo_liquidez_manual_dias')
          .eq('tipo_ativo', 'FUNDO')
          .eq('isin', isinNorm)
          .not('prazo_liquidez_manual_dias', 'is', null)
          .limit(1)
          .maybeSingle();
        const manualIsin = toNumOrNull(ativoByIsin?.prazo_liquidez_manual_dias);
        if (manualIsin != null) {
          prazoFundoPrincipal = manualIsin;
          console.log(`[calculo-risco-liquidez] prazo do fundo via ativos (ISIN ${isinNorm}) => D+${manualIsin}`);
        }
      }
    }

    const mainFundChar =
      fundChar || prazoFundoPrincipal != null
        ? { prazo_pagamento_resgate_dias: prazoFundoPrincipal }
        : null;
    const isFundoFechado = String(fundChar?.aberto_estatutariamente ?? '').toLowerCase().includes('fechado');
    const nivel1Upper = (fundChar?.nivel1_categoria ?? '').toString().toUpperCase().replace(/\s/g, '');
    const isFundoFidc = nivel1Upper === 'FIDC' || nivel1Upper === 'FIDCNP';
    // Fundos estruturados (FIP, FIDC, FII, FIAGRO...) não têm come-cotas
    const tem_come_cotas = !NIVEL1_SEM_COME_COTAS.has(nivel1Upper);

    // Para FIDC no módulo de liquidez, usa PL econômico do header.
    // pl_formula = 'va_vr' → valorativos + valorreceber (modo Nexum JR)
    // Demais FIDCs → valorativos + valorreceber - valorpagar
    if (isFundoFidc) {
      const valorativos = Number(posicoes[0]?.fundo_valorativos ?? 0) || 0;
      const valorreceber = Number(posicoes[0]?.fundo_valorreceber ?? 0) || 0;
      const valorpagar = Number(posicoes[0]?.fundo_valorpagar ?? 0) || 0;
      const usaVaVr = fundChar?.pl_formula === 'va_vr';
      const plFidcLiquidez = usaVaVr
        ? valorativos + valorreceber
        : valorativos + valorreceber - valorpagar;

      if (plFidcLiquidez > 0) {
        // Quando pl_formula='va_vr', sempre usa va+vr e ignora fundo_patliq do XML.
        totalPL = usaVaVr ? plFidcLiquidez : plFidcLiquidez;
      }

      console.log(
        `[calculo-risco-liquidez] PL FIDC (${cleanCnpj}) formula=${fundChar?.pl_formula ?? 'default'} => ` +
        `valorativos(${valorativos}) + valorreceber(${valorreceber})` +
        (usaVaVr ? '' : ` - valorpagar(${valorpagar})`) +
        ` = ${plFidcLiquidez}. PL utilizado=${totalPL} (header_xml=${plHeaderXml})`
      );
    }

    console.log(`[calculo-risco-liquidez] CNPJ=${cleanCnpj} | fundCharRows=${fundCharRows.length} | prazo=${prazoFundoPrincipal} | fechado=${isFundoFechado} | isFidc=${isFundoFidc} | fundChar=`, JSON.stringify(fundChar));

    // 3. Características dos fundos investidos (cotas/fidc) e nomes de emissores
    const cnpjsCotas = [...new Set(
      (posicoes || [])
        .filter((p: any) => ['cotas', 'fidc'].includes((p.section || '').toLowerCase()) && p.cnpjfundo)
        .map((p: any) => String(p.cnpjfundo).replace(/\D/g, ''))
    )] as string[];
    const cnpjsEmissores = [...new Set(
      (posicoes || [])
        .filter((p: any) => {
          const s = (p.section || '').toLowerCase();
          return !['despesas', 'provisao', 'caixa'].includes(s) && p.cnpjemissor;
        })
        .map((p: any) => String(p.cnpjemissor).replace(/\D/g, ''))
    )] as string[];

    // ISINs das cotas investidas — usados para lookup preciso de subclasses FIDC
    const isinsCotas = [...new Set(
      (posicoes || [])
        .filter((p: any) => ['cotas', 'fidc'].includes((p.section || '').toLowerCase()) && p.isin)
        .map((p: any) => String(p.isin).trim())
        .filter(Boolean)
    )] as string[];

    type CharInfo = {
      prazo_pagamento_resgate_dias: number | null;
      nome_comercial: string | null;
      aberto_estatutariamente: string | null;
      data_inicio_atividade: string | null;
    };

    // charMap: chave = CNPJ normalizado → dados da Classe/Fundo (fallback)
    const charMap = new Map<string, CharInfo>();
    // Registro completo por ISIN (validação CNPJ+ISIN na resolução por linha)
    const isinCharRowMap = new Map<string, Record<string, unknown>>();

    const registryNameMap = new Map<string, string>();
    const todosCnpjs = [...new Set([...cnpjsCotas, ...cnpjsEmissores])].filter(Boolean);
    const toCnpjKey = (v: string | number) => String(v).replace(/\D/g, '').padStart(14, '0');

    // 3a-i. Carrega subclasses por ISIN (pareamento com CNPJ da posição em resolveCharParaCotaFidc)
    if (isinsCotas.length > 0) {
      const { data: charsByIsin } = await supabase
        .from('fundos_caracteristicas')
        .select('isin, cnpj_classe, cnpj_fundo, prazo_pagamento_resgate_dias, nome_comercial, aberto_estatutariamente, data_inicio_atividade')
        .in('isin', isinsCotas);
      ;(charsByIsin || []).forEach((c: any) => {
        if (!c.isin) return;
        isinCharRowMap.set(String(c.isin).trim(), c);
      });
      console.log(`[calculo-risco-liquidez] isinCharRowMap: ${isinCharRowMap.size}/${isinsCotas.length} ISINs carregados`);
    }

    if (todosCnpjs.length > 0) {
      const formattedVariants = todosCnpjs
        .filter((c) => c.length === 14)
        .map((c) => formatCnpj(c));
      const allCnpjVariants = [...new Set([...todosCnpjs, ...formattedVariants])];

      const { data: charsByClasse } = await supabase
        .from('fundos_caracteristicas')
        .select('cnpj_classe, cnpj_fundo, prazo_pagamento_resgate_dias, nome_comercial, aberto_estatutariamente, data_inicio_atividade')
        .in('cnpj_classe', allCnpjVariants)
        .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo');
      const { data: charsByFundo } = await supabase
        .from('fundos_caracteristicas')
        .select('cnpj_classe, cnpj_fundo, prazo_pagamento_resgate_dias, nome_comercial, aberto_estatutariamente, data_inicio_atividade')
        .in('cnpj_fundo', allCnpjVariants)
        .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo');
      const chars = [...(charsByClasse || []), ...(charsByFundo || [])];
      ;(chars).forEach((c: any) => {
        const kClasse = c.cnpj_classe ? String(c.cnpj_classe).replace(/\D/g, '') : null;
        const kFundo = c.cnpj_fundo ? String(c.cnpj_fundo).replace(/\D/g, '') : null;
        const info: CharInfo = {
          prazo_pagamento_resgate_dias: c.prazo_pagamento_resgate_dias ?? null,
          nome_comercial: c.nome_comercial ?? null,
          aberto_estatutariamente: c.aberto_estatutariamente ?? null,
          data_inicio_atividade: c.data_inicio_atividade ?? null,
        };
        for (const k of [kClasse, kFundo]) {
          if (!k) continue;
          const existing = charMap.get(k);
          if (!existing || (info.prazo_pagamento_resgate_dias != null && existing.prazo_pagamento_resgate_dias == null)) {
            charMap.set(k, info);
          }
        }
      });

      const cnpjNumbers = todosCnpjs.map((c) => parseInt(c, 10)).filter((n) => !Number.isNaN(n));
      if (cnpjNumbers.length > 0) {
        const { data: regFundos } = await supabase
          .from('registro_fundo')
          .select('cnpj_fundo, denominacao_social')
          .in('cnpj_fundo', cnpjNumbers);
        ;(regFundos || []).forEach((r: any) => {
          if (r.denominacao_social) registryNameMap.set(toCnpjKey(r.cnpj_fundo), r.denominacao_social);
        });
        const { data: regClasses } = await supabase
          .from('registro_classe')
          .select('cnpj_classe, denominacao_social')
          .in('cnpj_classe', cnpjNumbers);
        ;(regClasses || []).forEach((r: any) => {
          if (r.denominacao_social) registryNameMap.set(toCnpjKey(r.cnpj_classe), r.denominacao_social);
        });
      }
    }

    const toCharInfoLinha = (c: Record<string, unknown> | null | undefined): CharInfo | null => {
      if (!c) return null;
      return {
        prazo_pagamento_resgate_dias: (c.prazo_pagamento_resgate_dias as number | string | null) ?? null,
        nome_comercial: (c.nome_comercial as string | null) ?? null,
        aberto_estatutariamente: (c.aberto_estatutariamente as string | null) ?? null,
        data_inicio_atividade: (c.data_inicio_atividade as string | null) ?? null,
      };
    };

    /** CNPJ+ISIN quando ambos disponíveis; senão apenas CNPJ em charMap */
    const resolveCharParaCotaFidc = (rowIsin: string | null, cnpjDigits: string | null): CharInfo | null => {
      if (rowIsin && isinCharRowMap.has(rowIsin)) {
        const full = isinCharRowMap.get(rowIsin)!;
        if (cnpjDigits && rowMatchesCnpjFc(full, cnpjDigits)) {
          return toCharInfoLinha(full as Record<string, unknown>);
        }
      }
      if (cnpjDigits) return charMap.get(cnpjDigits) ?? null;
      return null;
    };

    // 3b. FIDC Informe Mensal — buscar PL e buckets para FIDCs da carteira
    const fidcLiquidezEstimada: FidcLiquidezEstimadaItem[] = [];
    const fidcInformeMap = new Map<string, FidcInformeEntry>();

    const fidcCnpjsEmCarteira = [...new Set([
      ...(posicoes || [])
        .filter((p: any) => ['cotas', 'fidc'].includes((p.section || '').toLowerCase()))
        .map((p: any) => String(p.cnpjfundo || p.cnpjemissor || '').replace(/\D/g, '').padStart(14, '0'))
        .filter((c: string) => c.length === 14),
      ...(isFundoFidc ? [cleanCnpj14, formattedCnpj].filter(Boolean) : []),
    ])] as string[];

    if (fidcCnpjsEmCarteira.length > 0) {
      const dataRefIso = `${fundo_dtposicao.slice(0, 4)}-${fundo_dtposicao.slice(4, 6)}-${fundo_dtposicao.slice(6, 8)}`;
      const dtPosicaoMs = dtPosicao.getTime();

      const { data: fidcInfoRows } = await supabase
        .from('fidc_informe_mensal_import')
        .select('cnpj_fundo_classe, origem_tabela, pl, bucket_a1, bucket_a2, bucket_a3, bucket_a4, bucket_a5, bucket_a6, bucket_a7, bucket_a8, bucket_a9, bucket_a10, dt_comptc')
        .in('cnpj_fundo_classe', fidcCnpjsEmCarteira)
        .in('origem_tabela', ['TAB_IV_PARTE_A', 'TAB_V', 'TAB_VI'])
        .lte('dt_comptc', dataRefIso)
        .order('dt_comptc', { ascending: false });

      // Filtrar: só usar informe cuja dt_comptc está dentro de 35 dias da data da análise.
      // Os buckets A1 (até 30 dias) são relativos à dt_comptc; se dt_comptc está muito antiga, A1 já venceu.
      const MAX_DIAS_INFORME_ANTIGO = 35;
      const fidcInfoRowsFiltrados = (fidcInfoRows || []).filter((r: any) => {
        const dt = String(r.dt_comptc ?? '');
        if (!dt || dt.length < 10) return false;
        const dtMs = parseIsoDate(dt).getTime();
        if (Number.isNaN(dtMs)) return false;
        const diasDiff = (dtPosicaoMs - dtMs) / (24 * 60 * 60 * 1000);
        return diasDiff >= 0 && diasDiff <= MAX_DIAS_INFORME_ANTIGO;
      });

      if (fidcInfoRowsFiltrados.length > 0) {
        const num = (v: unknown) => Number(v ?? 0) || 0;

        // PL: linha TAB_IV_PARTE_A mais recente por CNPJ
        const plMap = new Map<string, { pl: number; dt: string }>();

        // Buckets: soma TAB_V + TAB_VI da data mais recente por CNPJ
        // Lógica: se dt > data existente → reinicia acumulador com nova linha
        //         se dt === data existente → soma (TAB_V + TAB_VI do mesmo mês)
        //         se dt < data existente → ignora (linha mais antiga)
        type BucketAcc = {
          dt: string;
          b1: number; b2: number; b3: number; b4: number; b5: number;
          b6: number; b7: number; b8: number; b9: number; b10: number;
        };
        const bucketAccMap = new Map<string, BucketAcc>();

        for (const r of fidcInfoRowsFiltrados) {
          const cnpj = String(r.cnpj_fundo_classe || '').replace(/\D/g, '').padStart(14, '0');
          if (cnpj.length !== 14) continue;
          const dt = String(r.dt_comptc ?? '');

          if (r.origem_tabela === 'TAB_IV_PARTE_A' && r.pl != null) {
            const ex = plMap.get(cnpj);
            if (!ex || dt > ex.dt) plMap.set(cnpj, { pl: num(r.pl), dt });
          }

          if (['TAB_V', 'TAB_VI'].includes(String(r.origem_tabela))) {
            const ex = bucketAccMap.get(cnpj);
            if (!ex || dt > ex.dt) {
              // Data mais recente encontrada: reiniciar acumulador
              bucketAccMap.set(cnpj, {
                dt,
                b1: num(r.bucket_a1), b2: num(r.bucket_a2), b3: num(r.bucket_a3),
                b4: num(r.bucket_a4), b5: num(r.bucket_a5), b6: num(r.bucket_a6),
                b7: num(r.bucket_a7), b8: num(r.bucket_a8), b9: num(r.bucket_a9),
                b10: num(r.bucket_a10),
              });
            } else if (dt === ex.dt) {
              // Mesma data: somar TAB_V + TAB_VI (ambas contribuem para o total)
              bucketAccMap.set(cnpj, {
                dt: ex.dt,
                b1: ex.b1 + num(r.bucket_a1), b2: ex.b2 + num(r.bucket_a2),
                b3: ex.b3 + num(r.bucket_a3), b4: ex.b4 + num(r.bucket_a4),
                b5: ex.b5 + num(r.bucket_a5), b6: ex.b6 + num(r.bucket_a6),
                b7: ex.b7 + num(r.bucket_a7), b8: ex.b8 + num(r.bucket_a8),
                b9: ex.b9 + num(r.bucket_a9), b10: ex.b10 + num(r.bucket_a10),
              });
            }
            // dt < ex.dt: linha mais antiga, ignorar
          }
        }

        for (const cnpj of fidcCnpjsEmCarteira) {
          const plData = plMap.get(cnpj);
          const bAcc = bucketAccMap.get(cnpj);
          fidcInformeMap.set(cnpj, {
            pl: plData?.pl ?? null,
            bucket_a1: bAcc?.b1 ?? 0,
            bucket_a2: bAcc?.b2 ?? 0,
            bucket_a3: bAcc?.b3 ?? 0,
            bucket_a4: bAcc?.b4 ?? 0,
            bucket_a5: bAcc?.b5 ?? 0,
            bucket_a6: bAcc?.b6 ?? 0,
            bucket_a7: bAcc?.b7 ?? 0,
            bucket_a8: bAcc?.b8 ?? 0,
            bucket_a9: bAcc?.b9 ?? 0,
            bucket_a10: bAcc?.b10 ?? 0,
            dt_comptc: bAcc?.dt ?? null,
            has_buckets: bAcc != null,
          });
        }
      }
    }

    // 3c. FIDC como fundo: ativos = caixa + duplicatas a vencer (estoque_fidc ou informe fallback)
    const rowsFromFidcAsFundo: RowWithPrazo[] = [];
    // estoqueRows é declarado no escopo externo para ser reutilizado no cálculo WAM (seção 9)
    let estoqueRows: Array<{
      id: string;
      data_referencia: string;
      data_vencimento_base: Date;
      nome_sacado: string | null;
      situacao_recebivel: string | null;
      valor: number;
    }> = [];

    if (isFundoFidc) {
      const dataRefIsoForEstoque = `${fundo_dtposicao.slice(0, 4)}-${fundo_dtposicao.slice(4, 6)}-${fundo_dtposicao.slice(6, 8)}`;
      const cnpjVariantsEstoque = [...new Set([cleanCnpj14, cleanCnpj, formattedCnpj].filter(Boolean))];

      // Tentar estoque_fidc (granular, por recebível) — inclui nome_sacado para detalhamento WAM
      const { data: estoqueAll } = await supabase
        .from('estoque_fidc')
        .select('id, import_id, data_referencia, data_vencimento_ajustada, data_vencimento_original, situacao_recebivel, valor_presente, valor_nominal, doc_fundo, nome_sacado')
        .in('doc_fundo', cnpjVariantsEstoque)
        .lte('data_referencia', dataRefIsoForEstoque)
        .order('data_referencia', { ascending: false });

      if (estoqueAll && estoqueAll.length > 0) {
        const importIds = [...new Set(estoqueAll.map((e: any) => e.import_id))];
        const { data: validImports } = await supabase
          .from('importacoes_estoque_fidc')
          .select('id')
          .in('id', importIds)
          .in('status', ['success', 'partial_success']);

        const validImportIds = new Set((validImports || []).map((i: any) => i.id));
        const filtered = estoqueAll.filter((e: any) => validImportIds.has(e.import_id));
        const mostRecentDataRef = filtered[0]?.data_referencia;
        const rowsForDate = filtered.filter((e: any) => e.data_referencia === mostRecentDataRef) || [];

        for (const r of rowsForDate) {
          const dataVenc = r.data_vencimento_ajustada || r.data_vencimento_original;
          if (!dataVenc) continue;
          const dtVenc = parseIsoDate(String(dataVenc));
          if (Number.isNaN(dtVenc.getTime())) continue;

          const diasAtraso = (parseIsoDate(String(r.data_referencia)).getTime() - dtVenc.getTime()) / (24 * 60 * 60 * 1000);
          if (diasAtraso >= 0) continue; // vencido: não entra

          if (situacaoExcluidaLiquidez(r.situacao_recebivel)) continue;

          const valor = Number(r.valor_presente ?? r.valor_nominal ?? 0) || 0;
          if (valor <= 0) continue;

          estoqueRows.push({
            id: r.id,
            data_referencia: String(r.data_referencia),
            data_vencimento_base: dtVenc,
            nome_sacado: r.nome_sacado ? String(r.nome_sacado) : null,
            situacao_recebivel: r.situacao_recebivel,
            valor,
          });
        }
      }

      if (estoqueRows.length > 0) {
        const verticeSums = new Map<number, number>();
        for (const r of estoqueRows) {
          const diasUteisAteVenc = diasUteisEntreDatas(dtPosicao, r.data_vencimento_base);
          const v = prazoParaVertice(diasUteisAteVenc);
          if (v == null) continue;
          verticeSums.set(v, (verticeSums.get(v) ?? 0) + r.valor);
        }
        for (const [vertice, valor] of verticeSums) {
          rowsFromFidcAsFundo.push({
            id: `estoque_fidc_v${vertice}`,
            nome: 'Recebíveis a vencer',
            valor,
            prazos_em_dias: vertice,
            vertice,
            section: 'fidc',
            fonte: 'estoque_fidc',
          });
        }
        console.log(`[calculo-risco-liquidez] FIDC-as-fund: estoque_fidc ${estoqueRows.length} recebíveis a vencer → ${rowsFromFidcAsFundo.length} vértices`);
      } else {
        // Fallback: fidc_informe_mensal_import (buckets A = a prazo)
        const fidcInformeDoFundo = fidcInformeMap.get(cleanCnpj14);
        if (fidcInformeDoFundo?.has_buckets) {
          const n = (v: unknown) => Number(v ?? 0) || 0;
          const bucketVertices: [number, number][] = [
            [n(fidcInformeDoFundo.bucket_a1), 42],
            [n(fidcInformeDoFundo.bucket_a2), 63],
            [n(fidcInformeDoFundo.bucket_a3) + n(fidcInformeDoFundo.bucket_a4), 126],
            [n(fidcInformeDoFundo.bucket_a5) + n(fidcInformeDoFundo.bucket_a6), 252],
            [n(fidcInformeDoFundo.bucket_a7), 378],
            [n(fidcInformeDoFundo.bucket_a8), 720],
            [n(fidcInformeDoFundo.bucket_a9) + n(fidcInformeDoFundo.bucket_a10), 1260],
          ];
          for (const [bv, v] of bucketVertices) {
            if (bv <= 0) continue;
            rowsFromFidcAsFundo.push({
              id: `informe_fidc_v${v}`,
              nome: 'Recebíveis a prazo (Informe)',
              valor: bv,
              prazos_em_dias: v,
              vertice: v,
              section: 'fidc',
              fonte: 'informe_fidc_fallback',
            });
          }
          console.log(`[calculo-risco-liquidez] FIDC-as-fund: fallback informe buckets → ${rowsFromFidcAsFundo.length} vértices`);
        }
      }
    }

    // 3b. Look-through de FIPs: buscar participações com data_liquidez_prevista
    // Permite que a cota do FIP no portfolio do fundo carteira herde o vencimento das investidas.
    const fipLookThroughMap = new Map<string, number>(); // cnpj14 → dias úteis ponderados
    /** Texto explicativo para UI/Excel (look-through participações → data investida) */
    const fipLookThroughMeta = new Map<string, {
      resumo: string;
      fip_cnpj: string;
      posicao_data: string; // data YYYYMMDD efetivamente usada para buscar as participações do FIP
      detalhes: Array<{ nome: string; valor: number; pct: number; data_liquidez: string; dias: number }>;
    }>();
    {
      const fipCnpjsArr: string[] = [];
      for (const pos of posicoes || []) {
        if ((pos.section || '').toLowerCase() !== 'cotas') continue;
        const cnpjRaw = pos.cnpjfundo || pos.cnpjemissor;
        if (!cnpjRaw) continue;
        const cnpj14lt = String(cnpjRaw).replace(/\D/g, '').padStart(14, '0');
        if (!fipCnpjsArr.includes(cnpj14lt)) fipCnpjsArr.push(cnpj14lt);
      }

      if (fipCnpjsArr.length > 0) {
        type LTRow = { fundo_dtposicao: string; valorfinanceiro: number; dlp: string | null; nome_investida: string | null };
        const byFip = new Map<string, LTRow[]>();

        // ISO variant da data de referência — para filtrar corretamente datas armazenadas como YYYY-MM-DD.
        // A comparação textual ".lte(YYYYMMDD)" falha quando o banco armazena ISO: "2026-05-13" < "20260427"
        // porque '-'(ASCII 45) < '0'(ASCII 48), deixando datas futuras passarem. Usar ambos os formatos
        // como pré-filtro; o filtro definitivo é feito em memória no Passo C.
        const isoRefLt = ymdPosicaoCarteira.length === 8
          ? `${ymdPosicaoCarteira.slice(0, 4)}-${ymdPosicaoCarteira.slice(4, 6)}-${ymdPosicaoCarteira.slice(6, 8)}`
          : null;

        // Passo A: join via ISIN — só posições do FIP com fundo_dtposicao ≤ data da carteira do fundo pai
        let partQueryA = supabase
          .from('posicao_carteira')
          .select('fundo_cnpj, fundo_dtposicao, valorfinanceiro, valor_padrao, isin, cnpjpart, nomecomercial, ativos(data_liquidez_prevista, nome_frontend, descricao)')
          .in('fundo_cnpj', fipCnpjsArr)
          .eq('section', 'participacoes');
        if (ymdPosicaoCarteira.length === 8 && isoRefLt) {
          // Filtra por YYYYMMDD E por ISO — cobre ambos os formatos de armazenamento em fundo_dtposicao
          partQueryA = partQueryA.or(`fundo_dtposicao.lte.${ymdPosicaoCarteira},fundo_dtposicao.lte.${isoRefLt}`);
        }
        const { data: partViaIsin } = await partQueryA;

        const valorPart = (p: { valor_padrao?: unknown; valorfinanceiro?: unknown }) =>
          Number(p.valor_padrao ?? p.valorfinanceiro ?? 0) || 0;

        for (const p of (partViaIsin || [])) {
          const cnpj = String(p.fundo_cnpj || '').replace(/\D/g, '').padStart(14, '0');
          const ativoInfo = Array.isArray(p.ativos) ? (p.ativos as any[])[0] : (p.ativos as any);
          const dlpRaw = ativoInfo?.data_liquidez_prevista;
          const nomeInv = ativoInfo?.nome_frontend || ativoInfo?.descricao || (p as any).nomecomercial || null;
          if (!byFip.has(cnpj)) byFip.set(cnpj, []);
          byFip.get(cnpj)!.push({
            fundo_dtposicao: String(p.fundo_dtposicao || ''),
            valorfinanceiro: valorPart(p as any),
            dlp: dlpRaw ? String(dlpRaw) : null,
            nome_investida: nomeInv ? String(nomeInv) : null,
          });
        }

        // Passo B: fallback por cnpjpart → ativos.cnpj (participações sem ISIN resolvido)
        const fipsSemDlp = fipCnpjsArr.filter(c => !(byFip.get(c) || []).some(r => r.dlp != null));
        if (fipsSemDlp.length > 0) {
          let partQueryB = supabase
            .from('posicao_carteira')
            .select('fundo_cnpj, fundo_dtposicao, valorfinanceiro, valor_padrao, cnpjpart, nomecomercial')
            .in('fundo_cnpj', fipsSemDlp)
            .eq('section', 'participacoes')
            .not('cnpjpart', 'is', null);
          if (ymdPosicaoCarteira.length === 8 && isoRefLt) {
            partQueryB = partQueryB.or(`fundo_dtposicao.lte.${ymdPosicaoCarteira},fundo_dtposicao.lte.${isoRefLt}`);
          }
          const { data: partSemIsin } = await partQueryB;

          const cnpjparts = [...new Set((partSemIsin || []).map(p => String(p.cnpjpart || '').replace(/\D/g, '')))].filter(Boolean);
          if (cnpjparts.length > 0) {
            const { data: ativosByCnpj } = await supabase
              .from('ativos')
              .select('cnpj, data_liquidez_prevista, nome_frontend, descricao')
              .in('cnpj', cnpjparts)
              .eq('tipo_ativo', 'PARTICIPACAO')
              .not('data_liquidez_prevista', 'is', null);

            const dlpByCnpj = new Map<string, string>();
            const nameByCnpj = new Map<string, string>();
            for (const a of (ativosByCnpj || [])) {
              if (a.cnpj && a.data_liquidez_prevista) {
                const k = String(a.cnpj).replace(/\D/g, '');
                dlpByCnpj.set(k, String(a.data_liquidez_prevista));
                const nome = (a as any).nome_frontend || (a as any).descricao;
                if (nome) nameByCnpj.set(k, String(nome));
              }
            }
            for (const p of (partSemIsin || [])) {
              const cnpj = String(p.fundo_cnpj || '').replace(/\D/g, '').padStart(14, '0');
              const cnpjpart = String(p.cnpjpart || '').replace(/\D/g, '');
              const nomeInvB = nameByCnpj.get(cnpjpart) || (p as any).nomecomercial || null;
              if (!byFip.has(cnpj)) byFip.set(cnpj, []);
              byFip.get(cnpj)!.push({
                fundo_dtposicao: String(p.fundo_dtposicao || ''),
                valorfinanceiro: valorPart(p as any),
                dlp: dlpByCnpj.get(cnpjpart) ?? null,
                nome_investida: nomeInvB ? String(nomeInvB) : null,
              });
            }
          }
        }

        // Passo C: carteira do FIP na data da análise = data canônica da posição do fundo carteira (ymdPosicaoCarteira).
        // PRIORIDADE: usa o snapshot na data EXATA do fundo-pai; fallback para a data mais recente ≤ ref
        // se o FIP não tiver posição nessa data exata (ex.: FIPs que reportam mensalmente).
        // O filtro de memória é o filtro DEFINITIVO — o filtro do banco é apenas pré-filtragem.
        const refDtPos = ymdPosicaoCarteira;
        for (const [cnpj, rows] of byFip) {
          // Filtro definitivo em memória: exclui qualquer data posterior à referência,
          // independente do formato em que veio do banco (YYYYMMDD ou YYYY-MM-DD).
          const rowsOnOrBefore =
            refDtPos.length === 8
              ? rows.filter((r) => {
                  const d = normalizeDtPosYYYYMMDD(r.fundo_dtposicao);
                  return d.length === 8 && d <= refDtPos;
                })
              : [];
          if (rowsOnOrBefore.length === 0) {
            if (refDtPos) {
              console.warn(
                `[calculo-risco-liquidez] look-through FIP ${cnpj}: sem participações com data ≤ ${refDtPos} — omitido (evita snapshot posterior à data da carteira)`,
              );
            }
            continue;
          }

          // Prefere snapshot na data EXATA do fundo-pai (mesma data de referência).
          // Isso garante que PAI e FILHO usem valores da mesma competência.
          // Se não houver snapshot exato (FIP que reporta em datas diferentes), usa o mais recente ≤ ref.
          const rowsExact = rowsOnOrBefore.filter(
            (r) => normalizeDtPosYYYYMMDD(r.fundo_dtposicao) === refDtPos,
          );
          const pool = rowsExact.length > 0 ? rowsExact : rowsOnOrBefore;

          const maxDt = pool.reduce((m, r) => {
            const d = normalizeDtPosYYYYMMDD(r.fundo_dtposicao);
            return d.length === 8 && d > m ? d : m;
          }, '');
          const latestRows = pool.filter(
            (r) => normalizeDtPosYYYYMMDD(r.fundo_dtposicao) === maxDt && r.dlp != null,
          );
          if (latestRows.length === 0) continue;

          const usouDataExata = rowsExact.length > 0;
          console.log(
            `[calculo-risco-liquidez] look-through FIP ${cnpj}: snapshot participações fundo_dtposicao=${maxDt}` +
            ` (ref carteira ${refDtPos || '—'}${usouDataExata ? ' — data exata ✓' : ' — fallback mais recente'})`,
          );

          let totalValor = 0;
          let weightedDias = 0;
          for (const r of latestRows) {
            const dtLiq = parseIsoDate(r.dlp!);
            if (Number.isNaN(dtLiq.getTime())) continue;
            const dias = Math.max(0, diasUteisEntreDatas(dtPosicao, dtLiq));
            totalValor += r.valorfinanceiro;
            weightedDias += r.valorfinanceiro * dias;
          }
          const diasFinal = totalValor > 0
            ? Math.round(weightedDias / totalValor)
            : Math.round(latestRows.reduce((s, r) => {
                const dtLiq = parseIsoDate(r.dlp!);
                return s + (Number.isNaN(dtLiq.getTime()) ? 0 : diasUteisEntreDatas(dtPosicao, dtLiq));
              }, 0) / latestRows.length);
          fipLookThroughMap.set(cnpj, Math.max(0, diasFinal));

          // Detalhes por investida para sub-linhas em Excel/UI/PDF
          const detalhesLt: Array<{ nome: string; valor: number; pct: number; data_liquidez: string; dias: number }> = [];
          for (const r of latestRows) {
            if (!r.dlp) continue;
            const dtD = parseIsoDate(r.dlp);
            if (Number.isNaN(dtD.getTime())) continue;
            detalhesLt.push({
              nome: r.nome_investida || `Investida (${r.dlp.slice(0, 10)})`,
              valor: r.valorfinanceiro,
              pct: totalValor > 0 ? Math.round((r.valorfinanceiro / totalValor) * 1000) / 10 : 0,
              data_liquidez: r.dlp,
              dias: Math.max(0, diasUteisEntreDatas(dtPosicao, dtD)),
            });
          }
          detalhesLt.sort((a, b) => a.data_liquidez.localeCompare(b.data_liquidez));

          const byDate = new Map<string, number>();
          for (const r of latestRows) {
            if (!r.dlp) continue;
            const dtKey = String(r.dlp).trim().slice(0, 10);
            if (dtKey.length !== 10) continue;
            byDate.set(dtKey, (byDate.get(dtKey) ?? 0) + r.valorfinanceiro);
          }
          const nomeFipLt = charMap.get(cnpj)?.nome_comercial?.trim() || `FIP ${cnpj}`;
          const partesData: string[] = [];
          for (const [dtIso, val] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            const pct = totalValor > 0 ? Math.round((val / totalValor) * 1000) / 10 : 0;
            const br = formatIsoDateBr(dtIso);
            partesData.push(byDate.size > 1 ? `${br} (${pct}% pela composição)` : br);
          }
          const posicaoDataBr = maxDt.length === 8
            ? `${maxDt.slice(6, 8)}/${maxDt.slice(4, 6)}/${maxDt.slice(0, 4)}`
            : maxDt;
          const resumoLt =
            `Look-through (carteira do FIP) · ${nomeFipLt}` +
            ` · posição ${posicaoDataBr}` +
            ` · data(s) prevista(s) investida(s): ${partesData.join('; ')}`;
          fipLookThroughMeta.set(cnpj, {
            resumo: resumoLt,
            fip_cnpj: cnpj,
            posicao_data: maxDt,
            detalhes: detalhesLt,
          });

          console.log(`[calculo-risco-liquidez] look-through FIP ${cnpj}: ${diasFinal} d.u. (${latestRows.length} participação(ões))`);
        }
      }
    }

    // 4. Construir rowsWithPrazo — inclui TODAS as seções de ativos (não apenas 5)
    const rowsWithPrazo: RowWithPrazo[] = [...rowsFromFidcAsFundo];
    const excludedSections = new Set(['despesas', 'provisao']);
    for (const row of posicoes || []) {
      const section = (row.section || '').toLowerCase();
      if (excludedSections.has(section) || !section) continue;

      // FIDC como fundo: section fidc já vem de estoque_fidc/informe — não processar aqui (evita dupla contagem)
      if (isFundoFidc && section === 'fidc') continue;

      const valor = section === 'caixa'
        ? (row.saldo ?? row.valor_padrao ?? 0)
        : (row.valor_padrao ?? row.valorfindisp ?? row.valorfinanceiro ?? row.valorcontabil ?? 0);
      if (valor === 0 && section !== 'caixa') continue;

      let lookThroughMetaForRow: { resumo: string; fip_cnpj: string; detalhes: Array<{ nome: string; valor: number; pct: number; data_liquidez: string; dias: number }> } | undefined;

      let prazos_em_dias: number | null = null;
      const prazoManualDias = getPrazoManualDias(row);
      const prazoDuracaoAnos = getPrazoDuracaoAnos(row);
      const dataLiquidezPrevista = getDataLiquidezPrevista(row);

      if (dataLiquidezPrevista != null) {
        // Prioridade máxima: data absoluta de liquidez cadastrada manualmente (ex.: saída de investida em FIP)
        const dtLiq = parseIsoDate(dataLiquidezPrevista);
        if (!Number.isNaN(dtLiq.getTime())) {
          prazos_em_dias = Math.max(0, diasUteisEntreDatas(dtPosicao, dtLiq));
        }
      } else if (prazoManualDias != null) {
        prazos_em_dias = prazoManualDias;
      } else if (section === 'cotas' || section === 'fidc') {
        const cnpjRaw = row.cnpjfundo || row.cnpjemissor;
        const cnpj = cnpjRaw ? String(cnpjRaw).replace(/\D/g, '') : null;
        const cnpj14 = cnpj ? cnpj.padStart(14, '0') : null;
        const fidcData = cnpj14 ? fidcInformeMap.get(cnpj14) : null;

        // FIDC com dados de bucket → expandir em múltiplos vértices proporcionais ao ownership
        if (fidcData?.has_buckets && fidcData.pl && fidcData.pl > 0) {
          const nomeFidc = resolveNomeAtivoLinha(
            row,
            charMap,
            registryNameMap,
            toCnpjKey,
            resolveCharParaCotaFidc,
            'FIDC',
          );

          // Passo B: ownership = valor_aplicado / PL_do_FIDC
          const ownership = valor / fidcData.pl;
          const n = (v: number) => Number(v) || 0;

          // Passo C: aplicar fraction a cada bucket → vértice correspondente
          // Mapeamento: a1→D+42 | a2→D+63 | a3+a4→D+126 | a5+a6→D+252 | a7→D+378 | a8→D+720 | a9+a10→D+1260
          const bucketVertices: [number, number][] = [
            [n(fidcData.bucket_a1),                                      42],
            [n(fidcData.bucket_a2),                                      63],
            [n(fidcData.bucket_a3) + n(fidcData.bucket_a4),             126],
            [n(fidcData.bucket_a5) + n(fidcData.bucket_a6),             252],
            [n(fidcData.bucket_a7),                                     378],
            [n(fidcData.bucket_a8),                                     720],
            [n(fidcData.bucket_a9) + n(fidcData.bucket_a10),           1260],
          ];

          for (const [bv, v] of bucketVertices) {
            const flowEstimado = ownership * bv;
            if (flowEstimado <= 0) continue;
            rowsWithPrazo.push({
              id: `${row.id}_v${v}`,
              nome: nomeFidc,
              valor: flowEstimado,
              prazos_em_dias: v,
              vertice: v,
              section: row.section || section,
              fonte: 'informe_mensal_fidc',
            });
          }

          const totalEstimado = bucketVertices.reduce((s, [bv]) => s + ownership * bv, 0);
          const residual = Math.max(0, valor - totalEstimado);

          fidcLiquidezEstimada.push({
            cnpj: cnpj14!,
            nome: nomeFidc,
            valor_aplicado: valor,
            pl_fidc: fidcData.pl,
            ownership_pct: ownership,
            vertice_d42:   ownership * n(fidcData.bucket_a1),
            vertice_d63:   ownership * n(fidcData.bucket_a2),
            vertice_d126:  ownership * (n(fidcData.bucket_a3) + n(fidcData.bucket_a4)),
            vertice_d252:  ownership * (n(fidcData.bucket_a5) + n(fidcData.bucket_a6)),
            vertice_d378:  ownership * n(fidcData.bucket_a7),
            vertice_d720:  ownership * n(fidcData.bucket_a8),
            vertice_d1260: ownership * (n(fidcData.bucket_a9) + n(fidcData.bucket_a10)),
            total_estimado: totalEstimado,
            ...(residual > 1 ? { residual_d1260: residual } : {}),
            dt_comptc: fidcData.dt_comptc,
          });

          if (totalEstimado <= 0) {
            // Informe com PL mas buckets A1–A10 zerados: não descartar a posição
            console.warn(
              `[calculo-risco-liquidez] FIDC cota ${cnpj14} (${nomeFidc}): buckets do informe zerados ` +
              `(valor_aplicado=${valor}) — fallback D+720 valor integral`
            );
            rowsWithPrazo.push({
              id: row.id,
              nome: nomeFidc,
              valor,
              prazos_em_dias: null,
              vertice: 720,
              section: row.section || section,
              fonte: 'informe_buckets_vazio_fallback',
            });
            continue;
          }

          // Residual: parte do valor_aplicado não coberta pelos buckets a prazo → D+1260 (D+720+)
          if (residual > 1) {
            console.log(
              `[calculo-risco-liquidez] FIDC cota ${cnpj14} (${nomeFidc}): residual R$ ${residual.toFixed(2)} ` +
              `(valor_aplicado=${valor}, total_estimado=${totalEstimado.toFixed(2)}) → D+1260`
            );
            rowsWithPrazo.push({
              id: `${row.id}_residual_1260`,
              nome: nomeFidc,
              valor: residual,
              prazos_em_dias: null,
              vertice: 1260,
              section: row.section || section,
              fonte: 'informe_mensal_fidc_residual',
            });
          }

          continue; // buckets + eventual residual — prazo já distribuído
        }

        // Fallback: sem dados de bucket → prazo pelo registro do fundo
        // Prioridade: ISIN da cota (subclasse exata) > CNPJ (Classe/Fundo genérico)
        const rowIsin = row.isin ? String(row.isin).trim() : null;
        const char = resolveCharParaCotaFidc(rowIsin, cnpj);
        const isAtivoFechado = String(char?.aberto_estatutariamente ?? '').toLowerCase().includes('fechado');

        // Detectar fundo fechado por regulação mesmo sem cadastro em fundos_caracteristicas
        const nomeParaDeteccaoVertice = String(
          row.nome_comercial_ativo || row.nome_ativo || row.nomecomercial || row.descricao || ''
        ).toUpperCase();
        const isFundoFechadoPorNomeVertice =
          nomeParaDeteccaoVertice.includes('IMOBILI') ||
          nomeParaDeteccaoVertice.includes('PARTICIPAC') ||
          nomeParaDeteccaoVertice.includes('PARTICIPAÇ') ||
          nomeParaDeteccaoVertice.includes('FIAGRO') ||
          nomeParaDeteccaoVertice.includes('FI-INFRA') ||
          nomeParaDeteccaoVertice.includes('INFRAESTRU');
        const isFechadoEfetivoVertice = isAtivoFechado || isFundoFechadoPorNomeVertice;

        // Look-through: cota de FIP com participações tendo data_liquidez_prevista
        const lookThroughDias = cnpj14 ? fipLookThroughMap.get(cnpj14) : undefined;
        if (lookThroughDias != null) {
          prazos_em_dias = lookThroughDias;
          lookThroughMetaForRow = cnpj14 ? fipLookThroughMeta.get(cnpj14) : undefined;
        } else if (isFechadoEfetivoVertice && prazoDuracaoAnos != null && char?.data_inicio_atividade) {
          const dataInicio = parseIsoDate(String(char.data_inicio_atividade));
          if (!Number.isNaN(dataInicio.getTime())) {
            const diasUteisTotaisPrazo = Math.round(prazoDuracaoAnos * 252);
            const diasUteisDecorridos = dtPosicao <= dataInicio
              ? 0
              : diasUteisEntreDatas(dataInicio, dtPosicao);
            prazos_em_dias = Math.max(0, diasUteisTotaisPrazo - diasUteisDecorridos);
          }
        } else if (char?.prazo_pagamento_resgate_dias != null) {
          prazos_em_dias = char.prazo_pagamento_resgate_dias;
        } else if (isFechadoEfetivoVertice) {
          // Fallback conservador: fundo fechado sem dados de prazo → 365 d.u.
          prazos_em_dias = 365;
        }
      } else if (section === 'acoes') {
        prazos_em_dias = 0;
      } else if (section === 'caixa') {
        prazos_em_dias = 0;
      } else if (section === 'titpublico' || section === 'titprivado' || section === 'termorf') {
        const prazoCampo = row.prazo_pagamento_resgate_dias;
        if (prazoCampo != null && !Number.isNaN(Number(prazoCampo))) {
          prazos_em_dias = Number(prazoCampo);
        } else if (row.dtvencimento) {
          const dtVencStr = String(row.dtvencimento).trim().replace(/[^0-9\-]/g, '');
          const dtVenc = dtVencStr.length === 10
            ? parseIsoDate(dtVencStr)
            : parseYyyymmdd(dtVencStr.replace(/-/g, '').slice(0, 8));
          if (!Number.isNaN(dtVenc.getTime())) {
            prazos_em_dias = diasUteisEntreDatas(dtPosicao, dtVenc);
          }
        }
      }

      // Cota de FIP: `data_liquidez_prevista` no cadastro (join `ativos`) tem prioridade máxima e
      // resolve o prazo antes do bloco `section === 'cotas'`, onde o look-through anexa metadados.
      // Sem este passo, o D+N fica correto mas a UI não recebe fonte/de detalhes das participações.
      if (section === 'cotas' && lookThroughMetaForRow === undefined) {
        const cnpjRawLt = row.cnpjfundo || row.cnpjemissor;
        const cnpjLt = cnpjRawLt ? String(cnpjRawLt).replace(/\D/g, '') : '';
        const cnpj14Lt = cnpjLt.length > 0 ? cnpjLt.padStart(14, '0') : '';
        if (cnpj14Lt && fipLookThroughMeta.has(cnpj14Lt)) {
          lookThroughMetaForRow = fipLookThroughMeta.get(cnpj14Lt)!;
        }
      }

      const verticeRaw = prazoParaVertice(prazos_em_dias);
      const vertice = verticeRaw ?? 720; // Sem prazo → último vértice (ilíquido)

      let nome: string;
      if (section === 'caixa') {
        nome = 'Caixa';
      } else {
        nome = resolveNomeAtivoLinha(row, charMap, registryNameMap, toCnpjKey, resolveCharParaCotaFidc);
      }

      rowsWithPrazo.push({
        id: row.id,
        nome,
        valor,
        prazos_em_dias,
        vertice,
        section: row.section || section,
        fonte: lookThroughMetaForRow ? 'fip_lookthrough' : undefined,
        look_through: lookThroughMetaForRow,
      });
    }

    // 4b. Construir resgates_por_vertice: apenas resgates importados (aba Resgates Solicitados / resgates_movimentacoes)
    const resgatesPorVerticeAuto: Record<string, number> = {};

    const dataRefIso = `${fundo_dtposicao.slice(0, 4)}-${fundo_dtposicao.slice(4, 6)}-${fundo_dtposicao.slice(6, 8)}`;

    // CNPJ variants usados tanto nos resgates_movimentacoes quanto em caixa_fluxo_financeiro
    const cnpjVariantsResgatesBase = [cleanCnpj, cleanCnpj14];
    if (formattedCnpj && formattedCnpj !== cleanCnpj) cnpjVariantsResgatesBase.push(formattedCnpj);
    if (fundChar) {
      const nc = normalizeCnpj(fundChar.cnpj_classe);
      const nf = normalizeCnpj(fundChar.cnpj_fundo);
      if (nc && nc !== cleanCnpj14 && !cnpjVariantsResgatesBase.includes(nc)) cnpjVariantsResgatesBase.push(nc);
      if (nf && nf !== cleanCnpj14 && !cnpjVariantsResgatesBase.includes(nf)) cnpjVariantsResgatesBase.push(nf);
    }
    const cnpjVariantsUnique = [...new Set(cnpjVariantsResgatesBase)].filter(Boolean);

    if (!ignorar_resgates_solicitados) {
      // Resgates importados (resgates_movimentacoes): recalcular vértice pela data de referência do fundo

      const { data: resgatesMovByCnpj } = await supabase
        .from('resgates_movimentacoes')
        .select('valor, data_impacto, vertice, fundo')
        .in('fundo_cnpj', cnpjVariantsUnique)
        .gte('data_impacto', dataRefIso);

      // Fallback: resgates com fundo_cnpj null — match por nome do fundo
      const fundNameNorm = (() => {
        const n = (posicoes?.[0] as any)?.nome_fundo || (posicoes?.[0] as any)?.fundo_nome || (fundChar as any)?.nome_comercial || '';
        return String(n).trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ');
      })();
      let resgatesMovNullCnpj: { valor: number; data_impacto: string; vertice: number | null; fundo: string }[] = [];
      if (fundNameNorm.length >= 4) {
        const { data: nullCnpjRows } = await supabase
          .from('resgates_movimentacoes')
          .select('valor, data_impacto, vertice, fundo')
          .is('fundo_cnpj', null)
          .gte('data_impacto', dataRefIso);
        if (nullCnpjRows && nullCnpjRows.length > 0) {
          const norm = (s: string) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ');
          resgatesMovNullCnpj = (nullCnpjRows as any[]).filter((r) => {
            const rn = norm(r.fundo || '');
            return rn.length >= 4 && (rn === fundNameNorm || rn.includes(fundNameNorm) || fundNameNorm.includes(rn));
          });
        }
      }

      const resgatesMov = [...(resgatesMovByCnpj || []), ...resgatesMovNullCnpj];

      for (const r of resgatesMov) {
        const valor = Number(r.valor) || 0;
        if (valor <= 0) continue;

        let vertice: number | null = null;
        if (r.data_impacto) {
          const dtImpacto = parseIsoDate(String(r.data_impacto));
          if (!Number.isNaN(dtImpacto.getTime())) {
            const diasUteis = diasUteisEntreDatas(dtPosicao, dtImpacto);
            vertice = prazoParaVertice(diasUteis >= 0 ? diasUteis : null);
          }
        }
        if (vertice == null && r.vertice != null) vertice = Number(r.vertice);
        if (vertice == null) continue;

        const key = String(vertice);
        resgatesPorVerticeAuto[key] = (resgatesPorVerticeAuto[key] ?? 0) + valor;
      }
    }

    // Mesclar com resgates_por_vertice do body (body pode sobrescrever/adicionar)
    const resgatesPorVerticeFinal: Record<string | number, number> = { ...resgatesPorVerticeAuto };
    for (const [k, v] of Object.entries(resgates_por_vertice)) {
      const num = Number(v) || 0;
      if (num > 0) resgatesPorVerticeFinal[k] = (resgatesPorVerticeFinal[k] ?? 0) + num;
    }

    // 4c. Resgates confirmados de portfólio (caixa_fluxo_financeiro)
    // Para cada entrada de "Resgate de portfólio investido":
    //   1. Adiciona ao rowsWithPrazo no vértice de liquidação (melhora ativo acumulado)
    //   2. Tenta match por nome na posicao_carteira (section='cotas') e deduz do vértice de origem
    // Sem match único → sem dedução, registra warning para marcação laranja no frontend.
    const resgAtivosMap = new Map<number, number>();
    const resgAtivosWarningsMap = new Map<number, { descricao: string; valor: number }[]>();

    {
      const { data: fluxosPortfolio } = await supabase
        .from('caixa_fluxo_financeiro')
        .select('descricao, financeiro, data_liquidacao')
        .in('fundo_cnpj', cnpjVariantsUnique)
        .gte('data_liquidacao', dataRefIso);

      // LOG DIAGNÓSTICO: mostra exatamente o que veio do banco antes de qualquer processamento
      console.log(
        `[calculo-risco-liquidez] caixa_fluxo RAW: ${fluxosPortfolio?.length ?? 0} registros. ` +
        `Amostra: ${JSON.stringify((fluxosPortfolio ?? []).slice(0, 5).map(f => ({ descricao: f.descricao, financeiro: f.financeiro, data_liquidacao: f.data_liquidacao })))}`
      );

      if (fluxosPortfolio && fluxosPortfolio.length > 0) {
        // Agregar múltiplos resgates do mesmo ativo antes de deduzir (garante cap correto por ativo)
        type GrupoResgate = {
          totalValor: number;
          entradas: { valor: number; verticeDestino: number; descricao: string }[];
        };
        const gruposPorNome = new Map<string, GrupoResgate>();

        for (const f of fluxosPortfolio) {
          const valor = Math.abs(Number(f.financeiro) || 0);
          if (valor <= 0) continue;

          const dtLiquidacao = parseIsoDate(String(f.data_liquidacao));
          if (isNaN(dtLiquidacao.getTime())) {
            console.warn(`[calculo-risco-liquidez] caixa_fluxo: data_liquidacao inválida (${f.data_liquidacao}), ignorado.`);
            continue;
          }

          const diasLiq = diasUteisEntreDatas(dtPosicao, dtLiquidacao);
          const verticeDestino = prazoParaVertice(diasLiq >= 0 ? diasLiq : null) ?? 1;
          const nomeExtraido = extrairNomeFundo(String(f.descricao ?? ''));
          console.log(`[calculo-risco-liquidez] caixa_fluxo linha: descricao="${f.descricao}" → extraído="${nomeExtraido}" | financeiro=${f.financeiro} | verticeDestino=D+${verticeDestino}`);

          // Sem descrição: dado importado antes da migration — pulsa sem criar entradas sem nome
          if (!nomeExtraido) {
            console.warn(
              `[calculo-risco-liquidez] caixa_fluxo: descricao nula/vazia para financeiro=${f.financeiro} ` +
              `data=${f.data_liquidacao} — reimporte o arquivo CaixaFluxoFinanceiro após aplicar a migration.`
            );
            continue;
          }

          const grupo = gruposPorNome.get(nomeExtraido) ?? { totalValor: 0, entradas: [] };
          grupo.totalValor += valor;
          grupo.entradas.push({ valor, verticeDestino, descricao: String(f.descricao ?? '') });
          gruposPorNome.set(nomeExtraido, grupo);
        }

        // Para cada grupo: match único → deduz com cap; 0 ou 2+ candidatos → warning
        const cotasDisponiveis = rowsWithPrazo
          .filter((r) => r.section === 'cotas')
          .map((r) => normNomeAtivo(r.nome));
        console.log(`[calculo-risco-liquidez] caixa_fluxo: cotas na carteira para match: ${JSON.stringify(cotasDisponiveis)}`);

        for (const [nomeExtraido, grupo] of gruposPorNome.entries()) {
          const candidatos = nomeExtraido.length >= 3
            ? rowsWithPrazo.filter(
                (r) => r.section === 'cotas' && nomesSimilares(normNomeAtivo(r.nome), nomeExtraido)
              )
            : [];

          console.log(`[calculo-risco-liquidez] caixa_fluxo: tentando match "${nomeExtraido}" → ${candidatos.length} candidato(s)`);

          if (candidatos.length === 1) {
            const ativoOrigem = candidatos[0];
            // Cap: dedução nunca ultrapassa o valor disponível no ativo
            const deducao = Math.min(grupo.totalValor, ativoOrigem.valor);
            ativoOrigem.valor = ativoOrigem.valor - deducao;
            console.log(
              `[calculo-risco-liquidez] caixa_fluxo: match "${nomeExtraido}" → ` +
              `"${normNomeAtivo(ativoOrigem.nome)}" deduzido R$${deducao.toFixed(2)} do vértice D+${ativoOrigem.vertice}`
            );
          } else {
            const motivo = candidatos.length === 0
              ? `ativo "${nomeExtraido}" não localizado na carteira`
              : `${candidatos.length} ativos similares — dedução ambígua: ${candidatos.map(c => normNomeAtivo(c.nome)).join(' | ')}`;
            console.warn(`[calculo-risco-liquidez] caixa_fluxo: sem match único para "${nomeExtraido}": ${motivo}`);
          }

          // Sempre adiciona entradas confirmadas ao rowsWithPrazo (destino) independente do match
          for (const entrada of grupo.entradas) {
            rowsWithPrazo.push({
              id: `resg_confirmado_${nomeExtraido}_${entrada.verticeDestino}`,
              nome: entrada.descricao || nomeExtraido,
              valor: entrada.valor,
              prazos_em_dias: entrada.verticeDestino,
              vertice: entrada.verticeDestino,
              section: 'resg_confirmado',
            });

            resgAtivosMap.set(
              entrada.verticeDestino,
              (resgAtivosMap.get(entrada.verticeDestino) ?? 0) + entrada.valor
            );

            if (candidatos.length !== 1) {
              const arr = resgAtivosWarningsMap.get(entrada.verticeDestino) ?? [];
              arr.push({ descricao: entrada.descricao, valor: entrada.valor });
              resgAtivosWarningsMap.set(entrada.verticeDestino, arr);
            }
          }
        }

        console.log(`[calculo-risco-liquidez] caixa_fluxo: ${fluxosPortfolio.length} resgates confirmados processados.`);
      }
    }

    // 5. Buscar matriz ANBIMA - sempre usa a data de referência mais recente (matriz atualizada mensalmente)
    const { data: matrizRows } = await supabase
      .from('matriz_anbima')
      .select('data_ref, periodo, prazo, valor')
      .eq('classe', classe)
      .eq('segmento_investidor', segmento_investidor)
      .eq('tipo_metodologia', 'Resgate Dados Consolidados')
      .eq('metrica', metrica)
      .order('data_ref', { ascending: false });

    const mostRecentDataRef = matrizRows?.[0]?.data_ref;
    const rowsForPeriod = (matrizRows || []).filter((r: any) => r.data_ref === mostRecentDataRef);
    const matrizPeriodo = rowsForPeriod[0]?.periodo ?? null;
    const probMap = new Map<number, number>();
    rowsForPeriod.forEach((r: any) => probMap.set(Number(r.prazo), Number(r.valor)));

    // 6. Montar tabela de vértices
    const verticesOrdenados = [...new Set(rowsWithPrazo.map((r) => r.vertice))].filter((v) => v != null).sort((a, b) => a - b);
    const prazoFundo = mainFundChar?.prazo_pagamento_resgate_dias ?? null;
    const maxVertice = Math.max(...verticesOrdenados, prazoFundo ?? 0, 126);
    const verticesBase = [...new Set([...VERTICES.filter((v) => v <= maxVertice), ...verticesOrdenados])];
    if (prazoFundo != null && prazoFundo > 0 && !verticesBase.includes(prazoFundo)) {
      verticesBase.push(prazoFundo);
    }
    // Garante que o último vértice com ativos esteja sempre presente
    const maxVerticeComAtivos = Math.max(...rowsWithPrazo.map((r) => r.vertice), 0);
    if (maxVerticeComAtivos > 0 && !verticesBase.includes(maxVerticeComAtivos)) {
      verticesBase.push(maxVerticeComAtivos);
    }
    const verticesCompletos = verticesBase.sort((a, b) => a - b);

    /**
     * Ativo acumulado até o vértice v.
     * Usa prazos_em_dias real quando disponível; se null, usa o vertice atribuído (720 = ilíquido).
     */
    const prazoEfetivo = (r: RowWithPrazo) => r.prazos_em_dias ?? r.vertice;

    const ativoAcumuladoAteVertice = (v: number) =>
      rowsWithPrazo
        .filter((r) => prazoEfetivo(r) <= v)
        .reduce((s, a) => s + a.valor, 0);

    /** Ativos com prazo efetivo no intervalo (vPrev, v] para o vértice v */
    const ativosNoVerticeRange = (v: number, vPrev: number) =>
      rowsWithPrazo.filter(
        (r) => prazoEfetivo(r) > vPrev && prazoEfetivo(r) <= v
      );

    let passivoAcum = 0;
    let indiceMinimo = 100;
    let worstStatus: RuleStatus = 'ok';

    const tabelaVertices: VerticeRow[] = [];
    let vPrev = -1;

    for (const v of verticesCompletos) {
      const ativoAcum = ativoAcumuladoAteVertice(v);
      const ativosNoV = ativosNoVerticeRange(v, vPrev);
      const ativoVertice = ativosNoV.reduce((s, a) => s + a.valor, 0);
      vPrev = v;

      const prob = getProbabilidade(v, probMap);
      // Valor ANBIMA — exibido na coluna "Prob. Resgate Valor", não muda
      const passivoNoVertice = totalPL * prob;

      const resgatesNoVertice = Number(resgatesPorVerticeFinal[String(v)] ?? resgatesPorVerticeFinal[v] ?? 0) || 0;

      // Passivo efetivo para cálculo: quando há resgates solicitados, substitui a estimativa ANBIMA;
      // quando não há, usa ANBIMA × PL. O valor ANBIMA (passivoNoVertice) permanece inalterado para exibição.
      const passivoEfetivoNoVertice = resgatesNoVertice > 0 ? resgatesNoVertice : passivoNoVertice;
      passivoAcum += passivoEfetivoNoVertice;

      const acumuladoLiquido = ativoAcum - passivoAcum;
      const indice = passivoEfetivoNoVertice > 0 ? Math.abs(ativoAcum / passivoEfetivoNoVertice) : 100;
      const indiceAcumulado = passivoAcum > 0 ? ativoAcum / passivoAcum : 100;
      const posicaoPL = totalPL > 0 ? ativoAcum / totalPL : 0;

      const _statusBruto = getConsolidatedStatus(
        indice,
        indiceAcumulado,
        mainFundChar?.prazo_pagamento_resgate_dias ?? 0
      );

      // Antes do prazo do fundo: HARD não é permitido — gestor ainda tem tempo de agir.
      // HARD só é escalado ao comitê no vértice do prazo ou além dele.
      const prazoFundoDias = mainFundChar?.prazo_pagamento_resgate_dias ?? null;
      const statusConsolidado: RuleStatus =
        _statusBruto === 'violacao' && prazoFundoDias != null && v < prazoFundoDias
          ? 'alerta'
          : _statusBruto;

      if (indiceAcumulado < indiceMinimo) indiceMinimo = indiceAcumulado;
      if (statusConsolidado === 'violacao') worstStatus = 'violacao';
      else if (statusConsolidado === 'alerta' && worstStatus !== 'violacao') worstStatus = 'alerta';

      tabelaVertices.push({
        vertice: v,
        ativoVertice,
        probabilidade: prob,
        ativoAcumulado: ativoAcum,
        passivoNoVertice,          // valor ANBIMA — exibido na coluna "Prob. Resgate Valor"
        resgatesSolicitados: resgatesNoVertice,
        passivoAcumulado: passivoAcum, // acumulado efetivo (resgates quando presentes, senão ANBIMA)
        acumuladoLiquido,
        indice,
        status: statusConsolidado,
        indiceAcumulado,
        estadoAcumulado: statusConsolidado,
        posicaoPL,
        statusPosicao: 'ok',
        statusConsolidado,
        resgAtivosVertice: resgAtivosMap.get(v) ?? 0,
        resgAtivosWarnings: resgAtivosWarningsMap.get(v) ?? [],
        ativosNoVertice: ativosNoV.map((a) => ({
          nome: a.nome,
          valor: a.valor,
          prazo: a.prazos_em_dias ?? v,
          fonte: a.fonte,
          look_through_resumo: a.look_through?.resumo,
          look_through_fip_cnpj: a.look_through?.fip_cnpj,
          look_through_posicao_data: a.look_through?.posicao_data,
          look_through_detalhes: a.look_through?.detalhes ?? [],
        })),
      });
    }

    if (indiceMinimo > 100) indiceMinimo = 1;

    // 7. Análise de come-cotas / DARF (fechado e aberto)
    let fundoFechadoAnalise: FundoFechadoAnalise | null = null;
    let darfAberto: DarfAbertoAnalise | null = null;

    if (isFundoFechado && mainFundChar?.prazo_pagamento_resgate_dias != null) {
      const prazoResgate = mainFundChar.prazo_pagamento_resgate_dias;
      const disponibilidade = rowsWithPrazo
        .filter((a) => prazoEfetivo(a) <= prazoResgate)
        .reduce((s, a) => s + a.valor, 0);
      const dispPL = totalPL > 0 ? disponibilidade / totalPL : 0;

      // 7a. DARF estimado de come-cotas (somente para fundos elegíveis)
      const cotaAtual = posicoes[0]?.fundo_valorcota != null ? Number(posicoes[0].fundo_valorcota) : null;
      let cotaBaseComeCottas: number | null = null;
      let darfEstimado = 0;
      let rentSemestre: number | null = null;

      if (tem_come_cotas && cotaAtual != null) {
        const candidates = getComeCotasBaseCandidates(dtPosicao);
        for (const { year, month } of candidates) {
          const monthStr = month.toString().padStart(2, '0');
          const dateFrom = `${year}${monthStr}01`;
          const dateTo   = `${year}${monthStr}31`;
          const { data: baseRow } = await supabase
            .from('posicao_carteira')
            .select('fundo_valorcota')
            .eq('fundo_cnpj', fundo_cnpj)
            .gte('fundo_dtposicao', dateFrom)
            .lte('fundo_dtposicao', dateTo)
            .not('fundo_valorcota', 'is', null)
            .order('fundo_dtposicao', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (baseRow?.fundo_valorcota != null) {
            cotaBaseComeCottas = Number(baseRow.fundo_valorcota);
            break;
          }
        }
        if (cotaBaseComeCottas != null && cotaBaseComeCottas > 0) {
          rentSemestre = (cotaAtual / cotaBaseComeCottas) - 1;
          if (rentSemestre > 0) {
            const lucroEstimado = totalPL * rentSemestre;
            darfEstimado = lucroEstimado * 0.15;
          }
        }
      }

      // 7b. Caixa líquido e cobertura de despesas (fundos fechados)
      // Despesa MENSAL ≠ saldo provisionado no XML (acumulado no ciclo).
      // Prioridade: Controle Taxas → despesas_fundo → XML taxas (15/34) c/ sanity cap → manual
      let despesaOperacionalMensal: number | null = null;
      let despesaBreakdown: DespesaBreakdownItem[] | null = null;
      let fonteDespesa: string | null = null;

      const manualDespesa = toNumOrNull(fundChar?.despesa_operacional_mensal);
      const mesRef = `${String(fundo_dtposicao).slice(0, 4)}-${String(fundo_dtposicao).slice(4, 6)}`;
      const mesAnoBr = `${String(fundo_dtposicao).slice(4, 6)}/${String(fundo_dtposicao).slice(0, 4)}`;
      const cnpjVariantsDespesas = [...new Set(
        [fundo_cnpj, cleanCnpj, cleanCnpj14, formattedCnpj].filter(Boolean)
      )];

      const buildBreakdownFromConferencia = (row: {
        ta_mensal?: number | null;
        tg_mensal?: number | null;
        tc_mensal?: number | null;
        tcons_mensal?: number | null;
      }): DespesaBreakdownItem[] => {
        const parts = [
          { categoria: 'taxa_administracao', mediaMonsal: toNumOrNull(row.ta_mensal) ?? 0, mesesDisponivel: 1 },
          { categoria: 'taxa_gestao', mediaMonsal: toNumOrNull(row.tg_mensal) ?? 0, mesesDisponivel: 1 },
          { categoria: 'taxa_custodia', mediaMonsal: toNumOrNull(row.tc_mensal) ?? 0, mesesDisponivel: 1 },
          { categoria: 'taxa_consultoria', mediaMonsal: toNumOrNull(row.tcons_mensal) ?? 0, mesesDisponivel: 1 },
        ].filter((p) => p.mediaMonsal > 0);
        const totalMedia = parts.reduce((s, p) => s + p.mediaMonsal, 0);
        return parts.map((p) => ({
          ...p,
          percentual: totalMedia > 0 ? (p.mediaMonsal / totalMedia) * 100 : 0,
        }));
      };

      // 1) Controle Taxas — apuração diária TA/TG/TC/TCons (mesma base da tela Controle Taxas)
      for (const cnpjVar of cnpjVariantsDespesas) {
        const { data: confRow } = await supabase
          .from('vw_conferencia_taxas_mes')
          .select('total_mensal, ta_mensal, tg_mensal, tc_mensal, tcons_mensal')
          .eq('fundo_cnpj', cnpjVar)
          .eq('mes_ref', mesRef)
          .maybeSingle();
        const confTotal = toNumOrNull(confRow?.total_mensal);
        if (confTotal != null && confTotal > 0) {
          despesaOperacionalMensal = confTotal;
          fonteDespesa = 'conferencia_taxas';
          despesaBreakdown = buildBreakdownFromConferencia(confRow ?? {});
          break;
        }
      }

      // 2) despesas_fundo — mês da data-base, depois média histórica
      if (despesaOperacionalMensal == null || despesaOperacionalMensal === 0) {
        const CATS_DESPESA = [
          'taxa_administracao', 'taxa_gestao', 'taxa_custodia',
          'taxa_anbima', 'taxa_cetip', 'taxa_selic',
          'tarifa_banco', 'outros_custos',
        ];
        let { data: despesasRows } = await supabase
          .from('despesas_fundo')
          .select('mes_ano, valor, categoria_despesa')
          .in('fundo_cnpj', cnpjVariantsDespesas)
          .in('categoria_despesa', CATS_DESPESA);

        if ((!despesasRows || despesasRows.length === 0) && cleanCnpj) {
          const cnpj8 = cleanCnpj.replace(/\D/g, '').slice(0, 8);
          if (cnpj8.length >= 8) {
            const { data: rowsByCodigo } = await supabase
              .from('despesas_fundo')
              .select('mes_ano, valor, categoria_despesa')
              .eq('fundo_codigo', cnpj8)
              .in('categoria_despesa', CATS_DESPESA);
            if (rowsByCodigo && rowsByCodigo.length > 0) {
              despesasRows = rowsByCodigo;
            }
          }
        }

        if ((!despesasRows || despesasRows.length === 0) && fundChar?.nome_comercial) {
          const nomeComercial = String(fundChar.nome_comercial).trim();
          const GENERICOS = new Set(['fi','fif','fic','fip','fidc','fii','qi','cp','resp','lp','de','em','cotas']);
          const tokens = nomeComercial.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length >= 2 && !GENERICOS.has(t));
          if (tokens.length >= 1) {
            const pattern = `%${tokens.slice(0, 2).join('%')}%`;
            const { data: rowsByName } = await supabase
              .from('despesas_fundo')
              .select('mes_ano, valor, categoria_despesa')
              .ilike('fundo_nome', pattern)
              .in('categoria_despesa', CATS_DESPESA);
            if (rowsByName && rowsByName.length > 0) {
              despesasRows = rowsByName;
            }
          }
        }

        if (despesasRows && despesasRows.length > 0) {
          const mesAtualRows = despesasRows.filter((r) => r.mes_ano === mesAnoBr);
          if (mesAtualRows.length > 0) {
            despesaOperacionalMensal = mesAtualRows.reduce(
              (s, r) => s + Math.abs(Number(r.valor) || 0), 0
            );
            fonteDespesa = 'despesas_fundo';
          } else {
            const byMonth: Record<string, number> = {};
            const byCatMonth: Record<string, Record<string, number>> = {};
            for (const row of despesasRows) {
              const mes = row.mes_ano as string;
              const cat = (row.categoria_despesa as string) || 'outros_custos';
              const abs = Math.abs(row.valor as number);
              byMonth[mes] = (byMonth[mes] ?? 0) + abs;
              if (!byCatMonth[cat]) byCatMonth[cat] = {};
              byCatMonth[cat][mes] = (byCatMonth[cat][mes] ?? 0) + abs;
            }
            const totalMeses = Object.keys(byMonth).length;
            if (totalMeses > 0) {
              despesaOperacionalMensal = Object.values(byMonth).reduce((a, b) => a + b, 0) / totalMeses;
              fonteDespesa = 'media_historica';
              const breakdownRaw = Object.entries(byCatMonth).map(([cat, mesMap]) => {
                const mesesCat = Object.keys(mesMap).length;
                const mediaCat = Object.values(mesMap).reduce((a, b) => a + b, 0) / mesesCat;
                return { categoria: cat, mediaMonsal: mediaCat, mesesDisponivel: mesesCat };
              });
              const totalMedia = breakdownRaw.reduce((s, r) => s + r.mediaMonsal, 0);
              despesaBreakdown = breakdownRaw
                .filter(r => r.mediaMonsal > 0)
                .sort((a, b) => b.mediaMonsal - a.mediaMonsal)
                .map(r => ({
                  ...r,
                  percentual: totalMedia > 0 ? (r.mediaMonsal / totalMedia) * 100 : 0,
                }));
            }
          }
        }
      }

      // 3) Fallback: provisões XML cod 15+34 (saldo do ciclo — só se plausível vs PL)
      if (despesaOperacionalMensal == null || despesaOperacionalMensal === 0) {
        const tetoMensalPlausivel = totalPL > 0 ? totalPL * 0.05 : null; // max 5% PL/mês
        for (const cnpjVar of cnpjVariantsDespesas) {
          const { data: provRow } = await supabase
            .from('vw_provisoes_taxas_mes')
            .select('total_taxas, tc, ta_tg_agregado')
            .eq('fundo_cnpj', cnpjVar)
            .eq('mes_ref', mesRef)
            .maybeSingle();
          const provTotal = toNumOrNull(provRow?.total_taxas);
          if (
            provTotal != null && provTotal > 0 &&
            (tetoMensalPlausivel == null || provTotal <= tetoMensalPlausivel)
          ) {
            despesaOperacionalMensal = provTotal;
            fonteDespesa = 'provisoes_xml';
            const parts = [
              { categoria: 'taxa_administracao', mediaMonsal: toNumOrNull(provRow?.ta_tg_agregado) ?? 0, mesesDisponivel: 1 },
              { categoria: 'taxa_custodia', mediaMonsal: toNumOrNull(provRow?.tc) ?? 0, mesesDisponivel: 1 },
            ].filter((p) => p.mediaMonsal > 0);
            const totalMedia = parts.reduce((s, p) => s + p.mediaMonsal, 0);
            despesaBreakdown = parts.map((p) => ({
              ...p,
              percentual: totalMedia > 0 ? (p.mediaMonsal / totalMedia) * 100 : 0,
            }));
            break;
          }
        }
      }

      // 4) Manual — só quando nenhuma fonte automática retornou valor
      if ((despesaOperacionalMensal == null || despesaOperacionalMensal === 0)
        && manualDespesa != null && manualDespesa > 0) {
        despesaOperacionalMensal = manualDespesa;
        fonteDespesa = 'manual';
      }

      const caixaLiquido = disponibilidade - darfEstimado;

      let mesesCobertura: number | null = null;
      let statusCoberturaDespesa: CoverageStatus = 'indisponivel';
      if (despesaOperacionalMensal != null && despesaOperacionalMensal > 0) {
        mesesCobertura = caixaLiquido / despesaOperacionalMensal;
        statusCoberturaDespesa = mesesCobertura >= 7 ? 'ok' : mesesCobertura >= 3 ? 'alerta' : 'violacao';
      }

      fundoFechadoAnalise = {
        prazoResgate,
        disponibilidade,
        dispPL,
        pl: totalPL,
        status: dispPL >= 0.03 ? 'ok' : dispPL >= 0.02 ? 'alerta' : 'violacao',
        despesaOperacionalMensal,
        despesaBreakdown,
        darfEstimado,
        caixaLiquido,
        mesesCobertura,
        statusCoberturaDespesa,
        fonteDespesa,
        temComeCottas: tem_come_cotas,
        cotaBaseComeCottas,
        rentSemestre,
      };

      // Trilha fechada: semáforo principal = cobertura operacional (não Disp./PL)
      const cs = fundoFechadoAnalise.statusCoberturaDespesa;
      if (cs === 'ok' || cs === 'alerta' || cs === 'violacao') {
        worstStatus = cs;
      }
    }

    // 7b. Fundo aberto: DARF estimado de come-cotas
    if (!isFundoFechado) {
      const cotaAtualAberto = posicoes[0]?.fundo_valorcota != null ? Number(posicoes[0].fundo_valorcota) : null;
      let cotaBaseComeCottasAberto: number | null = null;
      let darfEstimadoAberto = 0;
      let rentSemestreAberto: number | null = null;

      if (tem_come_cotas && cotaAtualAberto != null) {
        const candidates = getComeCotasBaseCandidates(dtPosicao);
        for (const { year, month } of candidates) {
          const monthStr = month.toString().padStart(2, '0');
          const dateFrom = `${year}${monthStr}01`;
          const dateTo   = `${year}${monthStr}31`;
          const { data: baseRow } = await supabase
            .from('posicao_carteira')
            .select('fundo_valorcota')
            .eq('fundo_cnpj', fundo_cnpj)
            .gte('fundo_dtposicao', dateFrom)
            .lte('fundo_dtposicao', dateTo)
            .not('fundo_valorcota', 'is', null)
            .order('fundo_dtposicao', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (baseRow?.fundo_valorcota != null) {
            cotaBaseComeCottasAberto = Number(baseRow.fundo_valorcota);
            break;
          }
        }
        if (cotaBaseComeCottasAberto != null && cotaBaseComeCottasAberto > 0) {
          rentSemestreAberto = (cotaAtualAberto / cotaBaseComeCottasAberto) - 1;
          if (rentSemestreAberto > 0) {
            darfEstimadoAberto = totalPL * rentSemestreAberto * 0.15;
          }
        }
      }

      darfAberto = {
        darfEstimado: darfEstimadoAberto,
        temComeCottas: tem_come_cotas,
        cotaBaseComeCottas: cotaBaseComeCottasAberto,
        rentSemestre: rentSemestreAberto,
      };
    }

    // 8. ativosComPrazo para rules-liquidity (inclui caixa com prazos_em_dias 0)
    const ativosComPrazo = rowsWithPrazo.map((r) => ({
      id: r.id,
      nome: r.nome,
      valor: r.valor,
      prazos_em_dias: r.prazos_em_dias,
      vertice: r.vertice,
      section: r.section,
    }));

    // 9a. Pré-calcular WAM dos FIDCs investidos via estoque_fidc (data_vencimento_ajustada)
    // Para cada FIDC presente na carteira como investimento (section fidc ou cotas),
    // calcula o prazo médio ponderado dos recebíveis a vencer usando data_vencimento_ajustada.
    // Resultado: fidcWamMap  cnpj14 → prazo médio ponderado (dias úteis)
    const fidcWamMap = new Map<string, number>();
    {
      // doc_fundo no estoque_fidc é gravado como vem do CSV (ex: "12.345.678/0001-99")
      // → gerar todas as variantes para cobrir qualquer formato de armazenamento
      const formatCnpjFidc = (digits: string): string =>
        digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

      // variant14 → cnpj14 canônico (para normalizar depois da query)
      const variantToCnpj14 = new Map<string, string>();
      const allVariants = new Set<string>();

      for (const row of posicoes || []) {
        const section = (row.section || '').toLowerCase();
        if (section !== 'fidc' && section !== 'cotas') continue;
        const cnpjRaw = row.cnpjfundo || row.cnpjemissor;
        if (!cnpjRaw) continue;
        const rawStr = String(cnpjRaw);
        const digits = rawStr.replace(/\D/g, '');
        const cnpj14 = digits.padStart(14, '0');
        const formatted = cnpj14.length === 14 ? formatCnpjFidc(cnpj14) : rawStr;

        for (const v of [rawStr, digits, cnpj14, formatted].filter(Boolean)) {
          allVariants.add(v);
          variantToCnpj14.set(v, cnpj14);
        }
      }

      if (allVariants.size > 0) {
        const cnpjList = [...allVariants];
        const dataRefIsoWam = `${fundo_dtposicao.slice(0, 4)}-${fundo_dtposicao.slice(4, 6)}-${fundo_dtposicao.slice(6, 8)}`;

        console.log(`[calculo-risco-liquidez] WAM fidcWamMap: buscando estoque_fidc para ${variantToCnpj14.size} variantes, ref=${dataRefIsoWam}`);

        const { data: estoqueWamAll, error: estoqueWamErr } = await supabase
          .from('estoque_fidc')
          .select('id, import_id, data_referencia, data_vencimento_ajustada, data_vencimento_original, situacao_recebivel, valor_presente, valor_nominal, doc_fundo')
          .in('doc_fundo', cnpjList)
          .lte('data_referencia', dataRefIsoWam)
          .order('data_referencia', { ascending: false });

        if (estoqueWamErr) {
          console.error('[calculo-risco-liquidez] WAM fidcWamMap query error:', estoqueWamErr.message);
        }

        console.log(`[calculo-risco-liquidez] WAM fidcWamMap: estoque_fidc retornou ${estoqueWamAll?.length ?? 0} linhas`);

        if (estoqueWamAll && estoqueWamAll.length > 0) {
          // Validar apenas imports com status de sucesso
          const importIds = [...new Set(estoqueWamAll.map((e: any) => e.import_id))];
          const { data: validImportsWam } = await supabase
            .from('importacoes_estoque_fidc')
            .select('id')
            .in('id', importIds)
            .in('status', ['success', 'partial_success']);

          const validImportIdsWam = new Set((validImportsWam || []).map((i: any) => i.id));
          const filteredWam = estoqueWamAll.filter((e: any) => validImportIdsWam.has(e.import_id));

          console.log(`[calculo-risco-liquidez] WAM fidcWamMap: ${filteredWam.length} linhas válidas após filtro de import`);

          // Normalizar doc_fundo → cnpj14 canônico
          const normalizarDocFundo = (docFundo: unknown): string =>
            String(docFundo || '').replace(/\D/g, '').padStart(14, '0');

          // Para cada FIDC, manter apenas a data_referencia mais recente ≤ data da posição
          const cnpjToMostRecent = new Map<string, string>();
          for (const r of filteredWam) {
            const c = normalizarDocFundo(r.doc_fundo);
            const existing = cnpjToMostRecent.get(c);
            if (!existing || String(r.data_referencia) > existing) cnpjToMostRecent.set(c, String(r.data_referencia));
          }

          // Calcular WAM ponderado por valor_presente para cada FIDC
          const cnpjAccum = new Map<string, { somaValor: number; somaContrib: number }>();
          for (const r of filteredWam) {
            const c = normalizarDocFundo(r.doc_fundo);
            if (String(r.data_referencia) !== cnpjToMostRecent.get(c)) continue;
            const dataVenc = r.data_vencimento_ajustada || r.data_vencimento_original;
            if (!dataVenc) continue;
            const dtVenc = parseIsoDate(String(dataVenc));
            if (Number.isNaN(dtVenc.getTime())) continue;
            if (situacaoExcluidaLiquidez(r.situacao_recebivel)) continue;
            const valor = Number(r.valor_presente ?? r.valor_nominal ?? 0) || 0;
            if (valor <= 0) continue;
            const dias = Math.max(0, diasUteisEntreDatas(dtPosicao, dtVenc));
            const acc = cnpjAccum.get(c) ?? { somaValor: 0, somaContrib: 0 };
            acc.somaValor += valor;
            acc.somaContrib += valor * dias;
            cnpjAccum.set(c, acc);
          }

          for (const [c, acc] of cnpjAccum) {
            if (acc.somaValor > 0) {
              const wamDias = acc.somaContrib / acc.somaValor;
              fidcWamMap.set(c, wamDias);
              console.log(`[calculo-risco-liquidez] WAM estoque_fidc ${c}: ${Math.round(wamDias)} d.u. (${acc.somaValor.toFixed(0)} valor)`);
            }
          }
        }
      }
    }

    // 9. Prazo Médio Ponderado da Carteira (WAM)
    // Lógica específica por tipo de ativo:
    //   - titpublico / titprivado / termorf → dtvencimento − data_posicao em DIAS ÚTEIS
    //                                         (ou WAM por fluxos nominais quando disponível — inciso II)
    //   - acoes                             → 0
    //   - cotas / fidc (FIDC com estoque_fidc) → WAM dos recebíveis via data_vencimento_ajustada
    //   - cotas / fidc (demais fundos)         → prazo_pagamento_resgate_dias do fundo (charMap)
    // Peso = valor / totalPL

    // Carregar cronogramas de amortização intermediária (titulo_rf_fluxo)
    // para os títulos RF presentes na posição, usando dias ÚTEIS (liquidez).
    const titulosRfParaFluxo = (posicoes || []).filter((r: any) => {
      const s = (r.section || '').toLowerCase();
      return s === 'titpublico' || s === 'titprivado' || s === 'termorf';
    });
    const chavesRfLiq = new Set<string>();
    for (const r of titulosRfParaFluxo) {
      const limpa = (v: unknown) => String(v ?? '').trim().toUpperCase();
      const isin = limpa(r.isin);
      if (isin) chavesRfLiq.add(`isin:${isin}`);
      const cetip = limpa(r.codativo);
      if (cetip) chavesRfLiq.add(`cetip:${cetip}`);
      const interno = limpa(r.idinternoativo);
      if (interno && interno !== cetip) chavesRfLiq.add(`cetip:${interno}`);
    }
    const fluxosLiqMap = new Map<string, { data_pagamento: string; valor_nominal: number }[]>();
    if (chavesRfLiq.size > 0) {
      const { data: fluxosLiq, error: fluxosLiqErr } = await supabase
        .from('titulo_rf_fluxo' as any)
        .select('chave_ativo, data_pagamento, valor_nominal')
        .in('chave_ativo', Array.from(chavesRfLiq));
      if (fluxosLiqErr) {
        console.warn(`[calculo-risco-liquidez] Aviso fluxos RF: ${fluxosLiqErr.message}`);
      } else {
        for (const fl of (fluxosLiq ?? []) as any[]) {
          const chave = String(fl.chave_ativo ?? '');
          if (!chave) continue;
          if (!fluxosLiqMap.has(chave)) fluxosLiqMap.set(chave, []);
          fluxosLiqMap.get(chave)!.push({
            data_pagamento: String(fl.data_pagamento ?? ''),
            valor_nominal: Number(fl.valor_nominal ?? 0),
          });
        }
        const qtdComFluxoLiq = titulosRfParaFluxo.filter((r: any) => {
          const limpa = (v: unknown) => String(v ?? '').trim().toUpperCase();
          const chaves = [
            limpa(r.isin) ? `isin:${limpa(r.isin)}` : null,
            limpa(r.codativo) ? `cetip:${limpa(r.codativo)}` : null,
          ].filter(Boolean) as string[];
          return chaves.some((c) => (fluxosLiqMap.get(c)?.length ?? 0) > 0);
        }).length;
        if (qtdComFluxoLiq > 0) {
          console.log(`[calculo-risco-liquidez] WAM-RF: ${qtdComFluxoLiq} título(s) com cronograma intermediário (inciso II)`);
        }
      }
    }

    /** Resolve prazo WAM de um título RF em dias úteis, usando fluxos se disponíveis. */
    function resolveWamRfUteis(row: any, dtRef: Date): number | null {
      const limpa = (v: unknown) => String(v ?? '').trim().toUpperCase();
      const chaves = [
        limpa(row.isin) ? `isin:${limpa(row.isin)}` : null,
        limpa(row.codativo) ? `cetip:${limpa(row.codativo)}` : null,
        limpa(row.idinternoativo) ? `cetip:${limpa(row.idinternoativo)}` : null,
      ].filter(Boolean) as string[];
      for (const chave of chaves) {
        const fluxos = fluxosLiqMap.get(chave);
        if (!fluxos || fluxos.length === 0) continue;
        // WAM em dias úteis
        const futuros = fluxos.map((f) => {
          const s = String(f.data_pagamento ?? '').replace(/\D/g, '').slice(0, 8);
          if (s.length !== 8) return null;
          const dtPag = new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T12:00:00Z`);
          const du = diasUteisEntreDatas(dtRef, dtPag);
          return du > 0 ? { du, vn: f.valor_nominal } : null;
        }).filter((x): x is { du: number; vn: number } => x !== null);
        if (futuros.length === 0) continue;
        const somaNominal = futuros.reduce((s, f) => s + f.vn, 0);
        if (somaNominal <= 0) continue;
        return futuros.reduce((s, f) => s + f.vn * f.du, 0) / somaNominal;
      }
      return null; // fallback para lógica original de dtvencimento
    }

    interface WamAtivoItem {
      id: string;
      nome: string;
      section: string;
      valor: number;
      prazos_em_dias: number | null;
      peso_pl: number;
      contribuicao_dias: number;
    }
    const wamAtivos: WamAtivoItem[] = [];
    const WAM_SECTIONS = new Set(['titpublico', 'titprivado', 'termorf', 'acoes', 'cotas', 'fidc']);

    for (const row of posicoes || []) {
      const section = (row.section || '').toLowerCase();
      if (!WAM_SECTIONS.has(section)) continue;

      // FIDC como fundo: a linha section=fidc do XML é o total agregado dos recebíveis.
      // O WAM será calculado a partir de estoqueRows (individuais) após este loop.
      if (isFundoFidc && section === 'fidc') continue;

      const valor = section === 'caixa'
        ? (row.saldo ?? row.valor_padrao ?? 0)
        : (row.valor_padrao ?? row.valorfindisp ?? row.valorfinanceiro ?? row.valorcontabil ?? 0);
      if (!valor || valor === 0) continue;

      let prazos_wam: number | null = null;

      if (section === 'titpublico' || section === 'titprivado' || section === 'termorf') {
        // Prioridade: WAM por fluxos nominais (inciso II) se disponível; caso contrário dtvencimento (inciso I)
        const wamFluxo = resolveWamRfUteis(row, dtPosicao);
        if (wamFluxo !== null) {
          prazos_wam = Math.max(0, wamFluxo);
        } else if (row.dtvencimento) {
          // Fallback inciso I: dias úteis até vencimento final
          const dtVencStr = String(row.dtvencimento).trim().replace(/[^0-9\-]/g, '');
          const dtVenc = dtVencStr.length === 10
            ? parseIsoDate(dtVencStr)
            : parseYyyymmdd(dtVencStr.replace(/-/g, '').slice(0, 8));
          if (!Number.isNaN(dtVenc.getTime())) {
            prazos_wam = Math.max(0, diasUteisEntreDatas(dtPosicao, dtVenc));
          }
        }
      } else if (section === 'acoes') {
        prazos_wam = 0;
      } else if (section === 'participacoes') {
        const dataLiqPrevWam = getDataLiquidezPrevista(row);
        if (dataLiqPrevWam != null) {
          const dtLiqWam = parseIsoDate(dataLiqPrevWam);
          if (!Number.isNaN(dtLiqWam.getTime())) {
            prazos_wam = Math.max(0, diasUteisEntreDatas(dtPosicao, dtLiqWam));
          }
        }
        // sem data_liquidez_prevista → prazos_wam permanece null (excluído do WAM)
      } else if (section === 'cotas' || section === 'fidc') {
        const prazoManualDiasWam = getPrazoManualDias(row);
        const dataLiqPrevWamCota = getDataLiquidezPrevista(row);
        if (dataLiqPrevWamCota != null) {
          // Prioridade 1: data absoluta de liquidez
          const dtLiqWamCota = parseIsoDate(dataLiqPrevWamCota);
          if (!Number.isNaN(dtLiqWamCota.getTime())) {
            prazos_wam = Math.max(0, diasUteisEntreDatas(dtPosicao, dtLiqWamCota));
          }
        } else if (prazoManualDiasWam != null) {
          // Prioridade 2: override em dias
          prazos_wam = prazoManualDiasWam;
        } else {
          const cnpjRaw = row.cnpjfundo || row.cnpjemissor;
          const cnpj = cnpjRaw ? String(cnpjRaw).replace(/\D/g, '') : null;
          const cnpj14 = cnpj ? cnpj.padStart(14, '0') : null;
          // Prioridade: ISIN da cota (subclasse exata) > CNPJ (Classe/Fundo genérico)
          const rowIsinWam = row.isin ? String(row.isin).trim() : null;
          const char = resolveCharParaCotaFidc(rowIsinWam, cnpj);
          const isAtivoFechado = String(char?.aberto_estatutariamente ?? '').toLowerCase().includes('fechado');
          const prazoDuracaoAnosWam = getPrazoDuracaoAnos(row);

          // Detectar se o fundo investido é fechado por regulação, mesmo sem registro em fundos_caracteristicas.
          // FII, FIP, FIAGRO e FI-Infra são sempre fundos fechados por regulação CVM/ANBIMA.
          const nomeParaDeteccao = String(
            row.nome_comercial_ativo || row.nome_ativo || row.nomecomercial || row.descricao || ''
          ).toUpperCase();
          const isFundoFechadoPorNome =
            nomeParaDeteccao.includes('IMOBILI') ||   // FII / Fundo Imobiliário
            nomeParaDeteccao.includes('PARTICIPAC') || // FIP
            nomeParaDeteccao.includes('PARTICIPAÇ') ||
            nomeParaDeteccao.includes('FIAGRO') ||
            nomeParaDeteccao.includes('FI-INFRA') ||
            nomeParaDeteccao.includes('INFRAESTRU');
          const isFechadoEfetivo = isAtivoFechado || isFundoFechadoPorNome;

          if (cnpj14 && fipLookThroughMap.has(cnpj14)) {
            // Prioridade 2: look-through FIP via participações com data_liquidez_prevista
            prazos_wam = fipLookThroughMap.get(cnpj14)!;
          } else if (cnpj14 && fidcWamMap.has(cnpj14)) {
            // Prioridade 3: WAM dos recebíveis do FIDC via estoque_fidc (data_vencimento_ajustada)
            prazos_wam = fidcWamMap.get(cnpj14)!;
          } else if (isFechadoEfetivo && prazoDuracaoAnosWam != null && char?.data_inicio_atividade) {
            // Prioridade 3: fundo fechado → calcula prazo remanescente pela duração
            const dataInicio = parseIsoDate(String(char.data_inicio_atividade));
            if (!Number.isNaN(dataInicio.getTime())) {
              const diasUteisTotaisPrazo = Math.round(prazoDuracaoAnosWam * 252);
              const diasUteisDecorridos = dtPosicao <= dataInicio
                ? 0
                : diasUteisEntreDatas(dataInicio, dtPosicao);
              prazos_wam = Math.max(0, diasUteisTotaisPrazo - diasUteisDecorridos);
            }
          } else if (char?.prazo_pagamento_resgate_dias != null) {
            // Prioridade 4: prazo de resgate cadastrado em fundos_caracteristicas
            prazos_wam = char.prazo_pagamento_resgate_dias;
          } else if (isFechadoEfetivo) {
            // Prioridade 5: fundo fechado sem dados de prazo → fallback conservador de 365 d.u.
            // Aplica tanto a fundos com aberto_estatutariamente='fechado' quanto a tipos que são
            // sempre fechados por regulação (FII, FIP, FIAGRO) mesmo sem cadastro em fundos_caracteristicas.
            prazos_wam = 365;
          }
        }
      }

      const nomeWam = resolveNomeAtivoLinha(row, charMap, registryNameMap, toCnpjKey, resolveCharParaCotaFidc);

      const isRfSection = section === 'titpublico' || section === 'titprivado' || section === 'termorf';
      const temFluxoRf = isRfSection && resolveWamRfUteis(row, dtPosicao) !== null;

      wamAtivos.push({
        id: String(row.id),
        nome: String(nomeWam),
        section: row.section || section,
        valor,
        prazos_em_dias: prazos_wam,
        peso_pl: totalPL > 0 ? valor / totalPL : 0,
        contribuicao_dias: totalPL > 0 ? (valor / totalPL) * (prazos_wam ?? 0) : 0,
        ...(temFluxoRf ? { metodo_prazo_rf: 'fluxo_nominal' } : {}),
      } as any);
    }

    // 9b. FIDC como fundo: adicionar recebíveis do estoque_fidc ao wamAtivos
    // Cada sacado vira uma linha, com WAM ponderado pelos seus próprios recebíveis.
    // Fallback: usar rowsFromFidcAsFundo (vértices agregados do informe) se não houver estoque.
    if (isFundoFidc) {
      if (estoqueRows.length > 0) {
        // Agrupar por nome_sacado → WAM ponderado por valor_presente
        const sacadoAccum = new Map<string, { somaValor: number; somaContrib: number; idx: number }>();
        let sacadoIdx = 0;
        for (const r of estoqueRows) {
          const nomeSacado = r.nome_sacado?.trim() || 'Sacado não identificado';
          const diasAteVenc = Math.max(0, diasUteisEntreDatas(dtPosicao, r.data_vencimento_base));
          const acc = sacadoAccum.get(nomeSacado) ?? { somaValor: 0, somaContrib: 0, idx: sacadoIdx++ };
          acc.somaValor += r.valor;
          acc.somaContrib += r.valor * diasAteVenc;
          sacadoAccum.set(nomeSacado, acc);
        }

        for (const [nomeSacado, acc] of sacadoAccum) {
          const prazosWamSacado = acc.somaValor > 0 ? acc.somaContrib / acc.somaValor : 0;
          wamAtivos.push({
            id: `sacado_wam_${acc.idx}`,
            nome: nomeSacado,
            section: 'fidc',
            valor: acc.somaValor,
            prazos_em_dias: prazosWamSacado,
            peso_pl: totalPL > 0 ? acc.somaValor / totalPL : 0,
            contribuicao_dias: totalPL > 0 ? (acc.somaValor / totalPL) * prazosWamSacado : 0,
          });
        }
        console.log(`[calculo-risco-liquidez] WAM FIDC-as-fund: ${sacadoAccum.size} sacados adicionados ao wamAtivos`);
      } else if (rowsFromFidcAsFundo.length > 0) {
        // Fallback: vértices do informe (aproximação)
        for (const r of rowsFromFidcAsFundo) {
          wamAtivos.push({
            id: r.id,
            nome: r.nome,
            section: 'fidc',
            valor: r.valor,
            prazos_em_dias: r.prazos_em_dias,
            peso_pl: totalPL > 0 ? r.valor / totalPL : 0,
            contribuicao_dias: totalPL > 0 ? (r.valor / totalPL) * (r.prazos_em_dias ?? 0) : 0,
          });
        }
        console.log(`[calculo-risco-liquidez] WAM FIDC-as-fund fallback: ${rowsFromFidcAsFundo.length} vértices do informe`);
      }
    }

    const prazoMedioCarteira = totalPL > 0 && wamAtivos.length > 0
      ? wamAtivos.reduce((sum, a) => sum + a.contribuicao_dias, 0)
      : null;

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          totalPL,
          isFundoFechado,
          fundoFechadoAnalise,
          darfAberto,
          ativosComPrazo,
          tabelaVertices,
          indiceMinimo,
          worstStatus,
          mainFundChar,
          matrizPeriodo: matrizPeriodo ?? undefined,
          matrizDataRef: mostRecentDataRef ?? undefined,
          fidcLiquidezEstimada,
          prazoMedioCarteira,
          wamAtivos,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[calculo-risco-liquidez] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
