/**
 * Edge Function: import-sinqia-passivo
 *
 * Busca posição de cotistas na API Finvest/Sinqia (POST /investors/positions),
 * converte para o formato FINVEST e importa via import-passivo-fundos.
 *
 * Request: POST application/json
 *   { data_posicao?: "YYYYMMDD" | "YYYY-MM-DD" | "DD/MM/YYYY" }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const SINQIA_AUTH_URL =
  'https://sistema09.finvestdigital.com.br/auth/realms/sinqia/protocol/openid-connect/token';
const SINQIA_API_BASE = 'https://sistema09.finvestdigital.com.br/api/v1';

const FIXIE_IP_PREFIXES = ['52.87.82.', '52.5.155.'];

/* Catálogo migrado para public.finvest_fundos (20260904090000). */
/*
  { codigo: '36517586', nome: 'NEXUM FIDC' },
  { codigo: '36517588', nome: 'NEXUM FIDC SR' },
  { codigo: '50168059', nome: 'FIF QI PLUS' },
  { codigo: '52611664', nome: 'FICFIDC QI JS NP' },
  { codigo: '53114587', nome: 'FICFIDC QI PREC' },
  { codigo: '53292014', nome: 'FIP QI TURBI' },
  { codigo: '53505712', nome: 'FIDC QI LOANS' },
  { codigo: '57845499', nome: 'FIP TURBI 2.0' },
  { codigo: '58062253', nome: 'FIF QI T2.0' },
  { codigo: '54738727', nome: 'FICFIDC OPORT NP' },
  { codigo: '54969186', nome: 'FIDC SX CORP JR' },
  { codigo: '55633981', nome: 'FICFIF QI RM95' },
  { codigo: '57284621', nome: 'FICFIDC BIAJU' },
  { codigo: '58197958', nome: 'FIF QI FLUSS' },
  { codigo: '58580017', nome: 'FII SPOT ONE' },
  { codigo: '61272053', nome: 'FII QI RL 2' },
  { codigo: '51479676', nome: 'FICFIF QI ALVORADA' },
  { codigo: '66664564', nome: 'FIF QI APOLLO' },
];
*/

type FundoFinvest = { codigo: string; nome: string };

// Denominações validadas para conciliar a API Sinqia com o histórico de passivo.
// O código Finvest permanece a chave de consulta; apenas o nome gravado no passivo é canônico.
const NOME_PASSIVO_POR_CODIGO: Record<string, string> = {
  '36517586': 'FIDC NEXUM JR',
  '36517588': 'FIDC NEXUM SR',
  '51479676': 'FICFIF QI ALVORA',
};

// NEXUM JR e SR compartilham o CNPJ real 36517586000103. O código Finvest 36517588
// NÃO é CNPJ — gerar 36517588000100 escondia a SR no universo monitorado.
const CNPJ_PASSIVO_POR_CODIGO: Record<string, string> = {
  '36517586': '36517586000103',
  '36517588': '36517586000103',
};

const ALIAS_NOME_PASSIVO: Record<string, string> = {
  'NEXUM FIDC': 'FIDC NEXUM JR',
  'FIDC NEXUM': 'FIDC NEXUM JR',
  'NEXUM FIDC SR': 'FIDC NEXUM SR',
  'FIDC NEXUM SR': 'FIDC NEXUM SR',
  'FICFIF QI ALVORADA': 'FICFIF QI ALVORA',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function carregarFundosFinvestAtivos(): Promise<FundoFinvest[]> {
  const { data, error } = await supabase
    .from('finvest_fundos')
    .select('codigo, nome')
    .eq('ativo', true)
    .order('nome', { ascending: true });

  if (error) {
    throw new Error(`Não foi possível carregar o cadastro de fundos Finvest: ${error.message}`);
  }
  return (data ?? []) as FundoFinvest[];
}

interface ProxyContext {
  client: Deno.HttpClient;
  hostLabel: string;
  username: string;
  passwordLen: number;
}

interface FinvestPassivoRow {
  fundo: string;
  cotista: string;
  valor: number;
  cnpj_fundo: string;
}

interface SinqiaPortfolioCatalogEntry {
  nome: string;
  cnpj: string;
}

/** CNPJ matriz (filial 0001) a partir do código Finvest/Sinqia (8 primeiros dígitos). */
function calcCnpjCheckDigits(base12: string): string {
  const weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const weights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number.parseInt(base12[i], 10) * weights1[i];
  let d1 = sum % 11;
  d1 = d1 < 2 ? 0 : 11 - d1;
  const base13 = base12 + String(d1);
  sum = 0;
  for (let i = 0; i < 13; i++) sum += Number.parseInt(base13[i], 10) * weights2[i];
  let d2 = sum % 11;
  d2 = d2 < 2 ? 0 : 11 - d2;
  return `${d1}${d2}`;
}

function cnpjFromSinqiaCodigo(codigo: string): string {
  const root = codigo.replace(/\D/g, '').padStart(8, '0').slice(-8);
  if (CNPJ_PASSIVO_POR_CODIGO[root]) return CNPJ_PASSIVO_POR_CODIGO[root];
  const base12 = `${root}0001`;
  return base12 + calcCnpjCheckDigits(base12);
}

function normalizeNomePassivoApi(name: string): string {
  const n = name
    .normalize('NFC')
    .replace(/\uFFFD/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  return ALIAS_NOME_PASSIVO[n] ?? n;
}

function temDiscriminadorJrSr(name: string): boolean {
  return /\b(JR|SR|JUNIOR|SENIOR)\b/i.test(name);
}

function buildSinqiaPortfolioCatalog(fundos: FundoFinvest[]): Map<string, SinqiaPortfolioCatalogEntry> {
  const map = new Map<string, SinqiaPortfolioCatalogEntry>();
  for (const f of fundos) {
    map.set(f.codigo, {
      nome: NOME_PASSIVO_POR_CODIGO[f.codigo] ?? f.nome,
      cnpj: cnpjFromSinqiaCodigo(f.codigo),
    });
  }
  return map;
}

function extractPortfolioCodigo(item: Record<string, unknown>): string {
  const raw = pickField(item, [
    'portfolioId',
    'portfolio_id',
    'idPortfolio',
    'id_portfolio',
    'carteiraId',
    'carteira_id',
    'portfolio',
    'codigoCarteira',
    'codigo_carteira',
  ]);
  if (raw == null || raw === '') return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length >= 8) return digits.slice(0, 8);
  return digits.padStart(8, '0');
}

interface ImportSinqiaPassivoRequest {
  data_posicao?: string;
}

interface ImportSinqiaPassivoResponse {
  success: boolean;
  message?: string;
  error?: string;
  recordsInserted?: number;
  positionsFetched?: number;
  fundsCount?: number;
  log: string[];
}

function logPush(log: string[], msg: string) {
  console.log(`[import-sinqia-passivo] ${msg}`);
  log.push(msg);
}

function sanitizeSecret(v: string): string {
  return v.trim().replace(/^["']+|["']+$/g, '');
}

function parseFixieConfig() {
  const envUser = sanitizeSecret(Deno.env.get('FIXIE_USERNAME') ?? '');
  const envPass = sanitizeSecret(Deno.env.get('FIXIE_PASSWORD') ?? '');
  const envHost = sanitizeSecret(Deno.env.get('FIXIE_HOST') ?? '').replace(/^https?:\/\//, '');

  if (envHost && envUser && envPass) {
    const hostLabel = envHost.includes(':') ? envHost : `${envHost}:80`;
    const [hostname, port = '80'] = hostLabel.split(':');
    return {
      proxyUrlWithAuth: `http://${envUser}:${envPass}@${hostname}:${port}`,
      username: envUser,
      password: envPass,
      hostLabel,
    };
  }

  let raw = '';
  for (const key of ['SINQIA_PROXY', 'FIXIE_URL', 'HTTPS_PROXY', 'https_proxy']) {
    const v = sanitizeSecret(Deno.env.get(key) ?? '');
    if (v) {
      raw = v;
      break;
    }
  }
  if (!raw) {
    throw new Error('Configure Fixie: FIXIE_USERNAME + FIXIE_PASSWORD + FIXIE_HOST nos secrets.');
  }
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) raw = `http://${raw}`;

  const parsed = new URL(raw);
  const username = decodeURIComponent(parsed.username) || envUser;
  const password = decodeURIComponent(parsed.password) || envPass;
  const hostname = parsed.hostname;
  const port = parsed.port || '80';
  if (!username || !password) {
    throw new Error('Credenciais Fixie ausentes nos secrets.');
  }
  return {
    proxyUrlWithAuth: `http://${username}:${password}@${hostname}:${port}`,
    username,
    password: password,
    hostLabel: `${hostname}:${port}`,
  };
}

function initFixieProxy(): ProxyContext {
  if (typeof Deno.createHttpClient !== 'function') {
    throw new Error('Deno.createHttpClient indisponível neste runtime Supabase.');
  }
  const { proxyUrlWithAuth, username, password, hostLabel } = parseFixieConfig();
  const parsed = new URL(proxyUrlWithAuth);
  const client = Deno.createHttpClient({
    proxy: {
      url: `http://${parsed.hostname}:${parsed.port || '80'}`,
      basicAuth: {
        username: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
      },
    },
  });
  return { client, hostLabel, username, passwordLen: password.length };
}

function closeProxy(proxy: ProxyContext | null) {
  proxy?.client.close();
}

async function proxiedFetch(url: string, init: RequestInit, proxy: ProxyContext): Promise<Response> {
  return fetch(url, { ...init, redirect: init.redirect ?? 'manual', client: proxy.client });
}

function forcarHttps(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.toString();
  } catch {
    return url;
  }
}

function parseJson(raw: Uint8Array): Record<string, unknown> | unknown[] | null {
  if (!raw?.length) return null;
  const text = new TextDecoder().decode(raw).trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isFixieIp(ip: string): boolean {
  return FIXIE_IP_PREFIXES.some((p) => ip.startsWith(p));
}

async function testFixieProxy(proxy: ProxyContext, log: string[]): Promise<void> {
  try {
    const ipResp = await proxiedFetch('https://api.ipify.org?format=json', { method: 'GET' }, proxy);
    if (ipResp.ok) {
      const ipJson = await ipResp.json() as { ip?: string };
      const ip = ipJson.ip ?? '?';
      logPush(log, `IP de saída via Fixie: ${ip}`);
      if (ip !== '?' && !isFixieIp(ip)) {
        logPush(log, `AVISO: IP ${ip} não é Fixie — Finvest pode retornar 403.`);
      }
    }
  } catch (err) {
    logPush(log, `Aviso: consulta IP externo falhou (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function gerarToken(clientId: string, clientSecret: string, proxy: ProxyContext): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const resp = await proxiedFetch(SINQIA_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, proxy);
  if (!resp.ok) {
    throw new Error(`Token Sinqia HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const json = await resp.json();
  if (!json.access_token) throw new Error('Token Sinqia: access_token ausente');
  return json.access_token as string;
}

async function apiCall(
  method: string,
  path: string,
  token: string,
  proxy: ProxyContext,
  opts: {
    idPrc?: string;
    body?: Record<string, unknown>;
    accept?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; body: Uint8Array }> {
  const idPrc = opts.idPrc ?? Deno.env.get('SINQIA_ID_PRC') ?? '1';
  const url = `${SINQIA_API_BASE}${path}?idPrc=${encodeURIComponent(idPrc)}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: opts.accept ?? 'application/json',
  };
  let payload: string | undefined;
  if (opts.body != null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 90_000);
  try {
    let resp = await proxiedFetch(url, { method, headers, body: payload, signal: controller.signal }, proxy);
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get('Location');
      if (loc) resp = await proxiedFetch(forcarHttps(loc), { method, headers, body: payload, signal: controller.signal }, proxy);
    }
    return { status: resp.status, body: new Uint8Array(await resp.arrayBuffer()) };
  } finally {
    clearTimeout(timer);
  }
}

function parseDateInput(raw: string): Date | null {
  const s = raw.trim();
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return new Date(+br[3], +br[2] - 1, +br[1]);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  const ymd = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (ymd) return new Date(+ymd[1], +ymd[2] - 1, +ymd[3]);
  return null;
}

function formatIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatYyyymmdd(d: Date): string {
  return formatIsoDate(d).replace(/-/g, '');
}

function ontem(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

function toFloat(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim().replace(/\s/g, '').replace(/^R\$/, '');
  if (!text) return null;
  let normalized = text;
  if (text.includes(',') && text.includes('.')) {
    normalized = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (text.includes(',')) {
    normalized = text.replace(/\./g, '').replace(',', '.');
  }
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

function pickField(item: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (item[key] != null && item[key] !== '') return item[key];
  }
  return null;
}

function extractPositionsArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    for (const key of ['content', 'data', 'items', 'positions', 'investorPositions', 'results']) {
      if (Array.isArray(o[key])) return o[key] as Record<string, unknown>[];
    }
  }
  return [];
}

function getTotalPages(data: unknown): number | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  for (const key of ['totalPages', 'total_pages', 'pageCount']) {
    const n = Number(o[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function getCurrentPage(data: unknown): number {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 0;
  const o = data as Record<string, unknown>;
  for (const key of ['page', 'pageNumber', 'number']) {
    const n = Number(o[key]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function resolveNomeFundoPassivo(
  item: Record<string, unknown>,
  catalogEntry: SinqiaPortfolioCatalogEntry | undefined,
): string {
  const candidatos = [
    pickField(item, ['className', 'shareClassName', 'quotaClass', 'fundClass', 'classeNome', 'subclasse', 'securityName']),
    pickField(item, ['portfolioName', 'portfolio_name', 'namePortfolio', 'nomeCarteira']),
    catalogEntry?.nome,
  ]
    .map((v) => normalizeNomePassivoApi(String(v ?? '').trim()))
    .filter(Boolean);

  const comClasse = candidatos.find(temDiscriminadorJrSr);
  return comClasse ?? candidatos[0] ?? '';
}

function mapPositionToPassivoRow(
  item: Record<string, unknown>,
  portfolioCatalog: Map<string, SinqiaPortfolioCatalogEntry>,
): FinvestPassivoRow | null {
  const portfolioCodigo = extractPortfolioCodigo(item);
  const catalogEntry = portfolioCodigo ? portfolioCatalog.get(portfolioCodigo) : undefined;

  const fundo = resolveNomeFundoPassivo(item, catalogEntry);

  const cotistaNome = String(
    pickField(item, ['investorName', 'investor_name', 'nomeInvestidor', 'nomeCotista']) ?? '',
  ).trim();
  const cpf = String(
    pickField(item, ['investorCPFCNPJ', 'investorCpfCnpj', 'investor_cpfcnpj', 'cpfCnpj']) ?? '',
  ).trim();
  const cotista = cpf ? `${cotistaNome} ( ${cpf} )` : cotistaNome;
  const valor = toFloat(
    pickField(item, ['netValue', 'net_value', 'invValue', 'inv_value', 'grossValue', 'gross_value', 'valorLiquido']),
  );

  const cnpjFromApi = String(
    pickField(item, ['portfolioCNPJ', 'portfolio_cnpj', 'cnpjPortfolio', 'cnpj']) ?? '',
  ).trim();
  const cnpj_fundo = (portfolioCodigo && CNPJ_PASSIVO_POR_CODIGO[portfolioCodigo])
    || catalogEntry?.cnpj
    || cnpjFromApi;

  if (!fundo || !cotista || valor == null || valor <= 0) return null;
  return { fundo, cotista, valor, cnpj_fundo };
}

function isNotAcceptableResponse(status: number, body: Uint8Array): boolean {
  if (status === 406) return true;
  const text = new TextDecoder().decode(body);
  return status === 500 && /406|not acceptable/i.test(text);
}

async function postInvestorPositions(
  token: string,
  proxy: ProxyContext,
  portfolioIds: number[],
  positionDate: string,
  opts: { page?: number; size?: number; accept?: string } = {},
): Promise<{ status: number; body: Uint8Array }> {
  const body: Record<string, unknown> = {
    portfolios: portfolioIds,
    positionDate,
    showZeroPositions: 'false',
  };
  if (opts.page != null && opts.size != null) {
    body.page = opts.page;
    body.size = opts.size;
  }
  return apiCall('POST', '/investors/positions', token, proxy, {
    body,
    accept: opts.accept ?? 'application/json',
  });
}

async function fetchAllInvestorPositions(
  token: string,
  proxy: ProxyContext,
  portfolioIds: number[],
  positionDate: string,
  log: string[],
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  const pageSize = 5000;
  let page = 0;
  let usePagination = false;

  while (page < 50) {
    let result = await postInvestorPositions(token, proxy, portfolioIds, positionDate, {
      ...(usePagination ? { page, size: pageSize } : {}),
      accept: 'application/json',
    });

    if (isNotAcceptableResponse(result.status, result.body)) {
      logPush(log, 'Accept application/json rejeitado — tentando */* sem paginação.');
      result = await postInvestorPositions(token, proxy, portfolioIds, positionDate, {
        accept: '*/*',
      });
    }

    if (result.status === 403) {
      const texto = new TextDecoder().decode(result.body).slice(0, 200);
      throw new Error(`POST /investors/positions HTTP 403 — IP não liberado ou sem permissão. ${texto}`);
    }
    if (result.status >= 400) {
      const texto = new TextDecoder().decode(result.body).slice(0, 300);
      throw new Error(`POST /investors/positions HTTP ${result.status}: ${texto}`);
    }

    const parsed = parseJson(result.body);
    const batch = extractPositionsArray(parsed);
    all.push(...batch);
    logPush(log, `Lote ${page + 1}: ${batch.length} posição(ões) (total acumulado: ${all.length})`);

    const totalPages = getTotalPages(parsed);
    const currentPage = getCurrentPage(parsed);

    if (totalPages != null && currentPage + 1 < totalPages) {
      usePagination = true;
      page = currentPage + 1;
      continue;
    }
    if (batch.length >= pageSize) {
      usePagination = true;
      page++;
      continue;
    }
    break;
  }

  return all;
}

async function invokeImportPassivoFundos(
  rows: FinvestPassivoRow[],
  dataPosicao: string,
): Promise<{ success: boolean; message?: string; error?: string; recordsInserted?: number }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const formData = new FormData();
  formData.append('finvest_passivo_json', JSON.stringify(rows));
  formData.append('data_posicao', dataPosicao);

  const resp = await fetch(`${supabaseUrl}/functions/v1/import-passivo-fundos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${supabaseServiceKey}` },
    body: formData,
  });

  const json = await resp.json().catch(() => ({ success: false, error: `HTTP ${resp.status}` }));
  if (!resp.ok && !json.error) {
    json.error = `import-passivo-fundos HTTP ${resp.status}`;
  }
  return json;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const log: string[] = [];
  let proxy: ProxyContext | null = null;

  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ success: false, error: 'Use POST.' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const clientId = Deno.env.get('SINQIA_CLIENT_ID') ?? '';
    const clientSecret = Deno.env.get('SINQIA_CLIENT_SECRET') ?? '';
    if (!clientId || !clientSecret) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Configure SINQIA_CLIENT_ID e SINQIA_CLIENT_SECRET nos secrets.',
        log,
      }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const body = await req.json().catch(() => ({})) as ImportSinqiaPassivoRequest;
    const refDate = body.data_posicao ? parseDateInput(body.data_posicao) : ontem();
    if (!refDate) {
      return new Response(JSON.stringify({ success: false, error: 'data_posicao inválida.', log }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const positionDate = formatIsoDate(refDate);
    const dataPosicao = formatYyyymmdd(refDate);
    const fundos = await carregarFundosFinvestAtivos();
    const portfolioIds = fundos.map((f) => Number.parseInt(f.codigo, 10)).filter((n) => Number.isFinite(n));
    if (portfolioIds.length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'Nenhum fundo Finvest ativo está cadastrado.', log }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    proxy = initFixieProxy();
    logPush(log, `Proxy Fixie (Deno client) — host=${proxy.hostLabel}, user=${proxy.username}`);
    logPush(log, `Data posição: ${positionDate} (${dataPosicao}) — ${portfolioIds.length} carteiras Finvest`);

    await testFixieProxy(proxy, log);

    const token = await gerarToken(clientId, clientSecret, proxy);
    logPush(log, 'Token Sinqia obtido.');

    const positions = await fetchAllInvestorPositions(token, proxy, portfolioIds, positionDate, log);
    if (positions.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: `Nenhuma posição retornada para ${positionDate}. Verifique se a data possui posição na Finvest.`,
        positionsFetched: 0,
        fundsCount: portfolioIds.length,
        log,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const portfolioCatalog = buildSinqiaPortfolioCatalog(fundos);
    const passivoRows: FinvestPassivoRow[] = [];
    for (const item of positions) {
      const row = mapPositionToPassivoRow(item, portfolioCatalog);
      if (row) passivoRows.push(row);
    }

    const porFundo = new Map<string, number>();
    const porCodigo = new Map<string, number>();
    for (const item of positions) {
      const codigo = extractPortfolioCodigo(item) || '(sem código)';
      porCodigo.set(codigo, (porCodigo.get(codigo) ?? 0) + 1);
    }
    for (const row of passivoRows) {
      porFundo.set(row.fundo, (porFundo.get(row.fundo) ?? 0) + 1);
    }
    for (const [codigo, n] of [...porCodigo.entries()].sort()) {
      const nome = portfolioCatalog.get(codigo)?.nome ?? codigo;
      logPush(log, `Carteira ${codigo} (${nome}): ${n} posição(ões) brutas da API`);
    }
    for (const [fundo, n] of [...porFundo.entries()].sort()) {
      logPush(log, `Passivo ${fundo}: ${n} cotista(s)`);
    }
    if ((porCodigo.get('36517588') ?? 0) === 0) {
      logPush(log, 'AVISO: carteira 36517588 (FIDC NEXUM SR) não veio na API. Se a SR estiver misturada na 36517586, o nome da classe da resposta será usado.');
    }

    logPush(log, `${passivoRows.length} cotista(s) mapeado(s) de ${positions.length} registro(s) da API.`);

    if (passivoRows.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'API retornou dados, mas nenhum registro válido (fundo/cotista/valor).',
        positionsFetched: positions.length,
        log,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const importResult = await invokeImportPassivoFundos(passivoRows, dataPosicao);
    logPush(log, importResult.success
      ? `Importação concluída: ${importResult.recordsInserted ?? '?'} registro(s).`
      : `Erro na importação: ${importResult.error ?? 'desconhecido'}`);

    const response: ImportSinqiaPassivoResponse = {
      success: !!importResult.success,
      message: importResult.message,
      error: importResult.error,
      recordsInserted: importResult.recordsInserted,
      positionsFetched: positions.length,
      fundsCount: portfolioIds.length,
      log,
    };

    return new Response(JSON.stringify(response), {
      status: importResult.success ? 200 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logPush(log, `Erro: ${msg}`);
    return new Response(JSON.stringify({ success: false, error: msg, log }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } finally {
    closeProxy(proxy);
  }
});
