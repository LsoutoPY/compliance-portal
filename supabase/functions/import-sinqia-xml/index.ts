import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SINQIA_AUTH_URL =
  'https://sistema09.finvestdigital.com.br/auth/realms/sinqia/protocol/openid-connect/token';
const SINQIA_API_BASE = 'https://sistema09.finvestdigital.com.br/api/v1';
const EXPORT_ID_XML_ANBIMA = 706;

/* Catálogo migrado para public.finvest_fundos (20260904090000).
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
const FUNDOS_SUBSTITUI_ISIN = new Set(['53292014', '57845499', '55633981']);

const STATUS_EM_ANDAMENTO = new Set(['AVAILABLE', 'WAITING_TASKS', 'WAITING_DEPS', 'RUNNING']);
const STATUS_EM_ANDAMENTO_PT = new Set(['EXECUTANDO', 'PENDENTE', 'AGUARDANDO']);
const STATUS_ERRO = new Set([
  'ERROR', 'ERRO', 'FAILED', 'FAILURE', 'CANCELLED', 'CANCELED', 'CANCELADO', 'FALHA', 'COM_ERRO',
]);

const POLL_TASK_TIMEOUT_MS = 90_000;
const MAX_WALL_MS = 130_000;

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

type FundoFinvest = { codigo: string; nome: string };

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

interface ImportSinqiaRequest {
  data_inicial?: string;
  data_final?: string;
  fundos_codigos?: string[] | null;
  apenas_faltantes?: boolean;
  change_invalid_isin?: boolean;
  output?: string;
}

interface SinqiaJobResult {
  codigo: string;
  nome: string;
  data: string;
  status: 'ok' | 'skipped' | 'error';
  filename?: string;
  records?: number;
  error?: string;
}

interface ImportSinqiaResponse {
  success: boolean;
  summary: {
    totalJobs: number;
    skipped: number;
    successFiles: number;
    errorFiles: number;
    totalRecords: number;
    partial?: boolean;
  };
  jobs: SinqiaJobResult[];
  importResults?: unknown[];
  log: string[];
  error?: string;
}

function logPush(log: string[], msg: string) {
  console.log(`[import-sinqia-xml] ${msg}`);
  log.push(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseDateInput(raw: string): Date | null {
  const s = raw.trim();
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return new Date(+br[3], +br[2] - 1, +br[1]);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
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

function ontemBr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function iterBusinessDays(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cur <= last) {
    if (cur.getDay() !== 0 && cur.getDay() !== 6) out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function sanitizeFilename(nome: string): string {
  return nome.replace(/[^\w\s.-]/g, '_').replace(/\s+/g, '_').slice(0, 80);
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

function parseJson(raw: Uint8Array): Record<string, unknown> | null {
  if (!raw?.length) return null;
  const text = new TextDecoder().decode(raw).trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function core(obj: Record<string, unknown> | null): Record<string, unknown> {
  if (!obj) return {};
  const data = obj.data;
  if (Array.isArray(data) && data[0] && typeof data[0] === 'object') return data[0] as Record<string, unknown>;
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return obj;
}

function normStatus(val: unknown): string {
  return String(val ?? '').trim().toUpperCase().replace(/\s+/g, '_');
}

function ehXml(raw: Uint8Array): boolean {
  if (!raw?.length) return false;
  const head = new TextDecoder().decode(raw.slice(0, 500)).trimStart().toLowerCase();
  return head.startsWith('<?xml') || head.includes('arquivoposicao');
}

function erroAplicacao(obj: Record<string, unknown> | null): string | null {
  const meta = obj?.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  const tipo = m.type;
  const msg = m.message;
  if (msg && typeof tipo === 'number' && tipo < 0) return String(msg);
  return null;
}

function taskEmExecucao(obj: Record<string, unknown> | null): boolean {
  const c = core(obj);
  const status = normStatus(c.status);
  if (STATUS_EM_ANDAMENTO.has(status) || STATUS_EM_ANDAMENTO_PT.has(status)) return true;
  const progress = c.progress;
  return progress != null && Number(progress) < 100;
}

function taskConcluida(obj: Record<string, unknown> | null): boolean {
  const c = core(obj);
  const status = normStatus(c.status);
  if (STATUS_ERRO.has(status)) return false;
  if (STATUS_EM_ANDAMENTO.has(status) || STATUS_EM_ANDAMENTO_PT.has(status)) return false;
  const progress = c.progress;
  if (progress != null) return Number(progress) >= 100;
  return Boolean(status);
}

function taskComErro(obj: Record<string, unknown> | null): boolean {
  return STATUS_ERRO.has(normStatus(core(obj).status));
}

interface FixieConfig {
  proxyUrlWithAuth: string;
  username: string;
  password: string;
  hostLabel: string;
}

interface ProxyContext {
  client: Deno.HttpClient;
  hostLabel: string;
  username: string;
  passwordLen: number;
}

const FIXIE_IP_PREFIXES = ['52.87.82.', '52.5.155.'];

function sanitizeSecret(s: string): string {
  return s.trim().replace(/^["']+|["']+$/g, '').replace(/\r/g, '');
}

function formatErr(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  if (err.cause instanceof Error) parts.push(`causa: ${err.cause.message}`);
  return parts.join(' | ');
}

/** Parse credenciais Fixie — alinhado a sinqia_export_xml.py (SINQIA_PROXY > FIXIE_URL > HTTPS_PROXY). */
function parseFixieConfig(): FixieConfig {
  const envUser = sanitizeSecret(Deno.env.get('FIXIE_USERNAME') ?? '');
  const envPass = sanitizeSecret(Deno.env.get('FIXIE_PASSWORD') ?? '');
  const envHost = sanitizeSecret(Deno.env.get('FIXIE_HOST') ?? '').replace(/^https?:\/\//, '');

  // Preferir secrets separados — evita typo/escape na URL inteira no dashboard Supabase
  if (envHost && envUser && envPass) {
    const hostLabel = envHost.includes(':') ? envHost : `${envHost}:80`;
    const [hostname, port = '80'] = hostLabel.split(':');
    const proxyUrlWithAuth = `http://${envUser}:${envPass}@${hostname}:${port}`;
    return { proxyUrlWithAuth, username: envUser, password: envPass, hostLabel };
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
    throw new Error(
      'Configure Fixie: FIXIE_URL ou FIXIE_USERNAME + FIXIE_PASSWORD + FIXIE_HOST nos secrets.',
    );
  }

  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    raw = `http://${raw}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('FIXIE_URL inválida. Formato: http://fixie:TOKEN@criterium.usefixie.com:80');
  }

  const username = decodeURIComponent(parsed.username) || envUser;
  const password = decodeURIComponent(parsed.password) || envPass;
  const hostname = parsed.hostname;
  const port = parsed.port || '80';
  const hostLabel = `${hostname}:${port}`;

  if (!username || !password) {
    throw new Error(
      'Credenciais Fixie ausentes. Defina FIXIE_USERNAME + FIXIE_PASSWORD + FIXIE_HOST nos secrets.',
    );
  }

  const proxyUrlWithAuth = `http://${username}:${password}@${hostname}:${port}`;
  return { proxyUrlWithAuth, username, password, hostLabel };
}

function isFixieIp(ip: string): boolean {
  return FIXIE_IP_PREFIXES.some((p) => ip.startsWith(p));
}

/** Proxy Fixie via Deno.createHttpClient — obrigatório no Supabase (HTTPS_PROXY vaza IP AWS). */
function initFixieProxy(): ProxyContext {
  if (typeof Deno.createHttpClient !== 'function') {
    throw new Error('Deno.createHttpClient indisponível neste runtime Supabase.');
  }

  const { proxyUrlWithAuth, username, hostLabel, password } = parseFixieConfig();
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

  return {
    client,
    hostLabel,
    username,
    passwordLen: password.length,
  };
}

function closeProxy(proxy: ProxyContext | null) {
  proxy?.client.close();
}

async function proxiedFetch(
  url: string,
  init: RequestInit,
  proxy: ProxyContext,
): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: init.redirect ?? 'manual',
    client: proxy.client,
  });
}

/** Diagnóstico Fixie — falha não bloqueia; Sinqia é o teste definitivo. */
async function testFixieProxy(proxy: ProxyContext, log: string[]): Promise<void> {
  try {
    const resp = await proxiedFetch('http://welcome.usefixie.com/', { method: 'GET' }, proxy);
    const body = (await resp.text()).slice(0, 80);
    if (resp.ok) {
      logPush(log, `Fixie OK (HTTP ${resp.status}) — ${body || 'proxy autenticado'}`);
    } else {
      logPush(log, `Aviso Fixie welcome HTTP ${resp.status}: ${body}`);
    }
  } catch (err) {
    logPush(log, `Aviso: teste welcome.usefixie.com falhou (${formatErr(err)})`);
  }

  try {
    const ipResp = await proxiedFetch('https://api.ipify.org?format=json', { method: 'GET' }, proxy);
    if (ipResp.ok) {
      const ipJson = await ipResp.json() as { ip?: string };
      const ip = ipJson.ip ?? '?';
      logPush(log, `IP de saída via Fixie: ${ip}`);
      if (ip !== '?' && !isFixieIp(ip)) {
        logPush(
          log,
          `AVISO: IP ${ip} não é Fixie (esperado 52.87.82.x ou 52.5.155.x) — Finvest retornará 403.`,
        );
      }
    } else {
      logPush(log, `Aviso: ipify HTTP ${ipResp.status}`);
    }
  } catch (err) {
    logPush(log, `Aviso: consulta IP externo falhou (${formatErr(err)})`);
  }
}

async function gerarToken(
  clientId: string,
  clientSecret: string,
  proxy: ProxyContext,
): Promise<string> {
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
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    accept?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
  const idPrc = opts.idPrc ?? '1';
  const params = new URLSearchParams({ idPrc });
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) params.set(k, v);
  }
  let url = `${SINQIA_API_BASE}${path}?${params.toString()}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: opts.accept ?? 'application/json',
  };
  let payload: string | undefined;
  if (opts.body != null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }

  const doFetch = async (targetUrl: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
    try {
      return await proxiedFetch(targetUrl, {
        method,
        headers,
        body: payload,
        redirect: 'manual',
        signal: controller.signal,
      }, proxy);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let resp = await doFetch(url);
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get('Location');
      if (loc) resp = await doFetch(forcarHttps(loc));
    }
    const body = new Uint8Array(await resp.arrayBuffer());
    return { status: resp.status, headers: resp.headers, body };
  } catch (err) {
    console.error('[import-sinqia-xml] apiCall erro:', err);
    return { status: -1, headers: new Headers(), body: new Uint8Array() };
  }
}

function resumoRespostaApi(status: number, body: Uint8Array, maxLen = 280): string {
  const texto = new TextDecoder().decode(body).trim();
  if (!texto) return `HTTP ${status} (corpo vazio)`;
  const parsed = parseJson(body);
  const meta = parsed?.metadata;
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    if (m.message) return `HTTP ${status}: ${String(m.message).slice(0, maxLen)}`;
  }
  if (parsed?.message) return `HTTP ${status}: ${String(parsed.message).slice(0, maxLen)}`;
  if (parsed?.error) return `HTTP ${status}: ${String(parsed.error).slice(0, maxLen)}`;
  return `HTTP ${status}: ${texto.slice(0, maxLen)}`;
}

async function tentarDownloadFile(
  token: string,
  idPrc: string,
  taskId: string,
  proxy: ProxyContext,
  tentativas = 4,
): Promise<Uint8Array | null> {
  for (let i = 0; i < tentativas; i++) {
    const { status, body } = await apiCall('GET', `/files/${taskId}`, token, proxy, {
      idPrc,
      accept: 'application/xml, application/octet-stream, */*',
      timeoutMs: 15_000,
    });
    if (status === 200 && ehXml(body)) return body;
    if (status !== 400 && status !== 404 && status !== -1) break;
    await sleep(350);
  }
  return null;
}

async function acompanharTask(
  token: string,
  idPrc: string,
  taskId: string,
  proxy: ProxyContext,
): Promise<Uint8Array> {
  const deadline = Date.now() + POLL_TASK_TIMEOUT_MS;
  let tentativa = 0;

  while (Date.now() < deadline) {
    tentativa++;
    const { status, body } = await apiCall('GET', `/tasks/${taskId}`, token, proxy, {
      idPrc,
      accept: 'application/json, application/xml, */*',
      timeoutMs: 12_000,
    });

    if (status === 200 && ehXml(body)) return body;

    const parsed = parseJson(body);
    const erroNeg = erroAplicacao(parsed);
    if (erroNeg) throw new Error(erroNeg);

    if (parsed && taskComErro(parsed)) {
      throw new Error(`Tarefa Sinqia com erro (${normStatus(core(parsed).status)})`);
    }

    if (status === 410 || (parsed && taskConcluida(parsed))) {
      const file = await tentarDownloadFile(token, idPrc, taskId, proxy);
      if (file) return file;
    }

    if (status === -1 || parsed === null && status !== 200) {
      await sleep(800);
      continue;
    }

    if (parsed && taskEmExecucao(parsed)) {
      const wait = tentativa <= 15 ? 400 : tentativa <= 30 ? 1000 : 2000;
      await sleep(wait);
      continue;
    }

    if (parsed && taskConcluida(parsed)) {
      const file = await tentarDownloadFile(token, idPrc, taskId, proxy);
      if (file) return file;
      break;
    }

    await sleep(400);
  }

  const last = await tentarDownloadFile(token, idPrc, taskId, proxy, 3);
  if (last) return last;
  throw new Error(`Timeout (${POLL_TASK_TIMEOUT_MS / 1000}s) aguardando XML Sinqia`);
}

async function exportarFundoSinqia(
  token: string,
  idPrc: string,
  portfolio: string,
  nome: string,
  dataIso: string,
  changeInvalidIsin: boolean,
  proxy: ProxyContext,
): Promise<{ content: string; filename: string }> {
  const payload = {
    portfolio: Number(portfolio),
    output: 'V401',
    date: dataIso,
    showRules: true,
    generateFiex: false,
    onlyAnbimaRules: false,
    adjustFinancial: false,
    exportTax: true,
    negativeBalance: false,
    changeInvalidIsin,
    useSecurityDecimals: false,
  };

  const { status, headers, body } = await apiCall(
    'POST',
    `/exports/${EXPORT_ID_XML_ANBIMA}`,
    token,
    proxy,
    { idPrc, body: payload },
  );
  if (![200, 201, 202].includes(status)) {
    throw new Error(`POST /exports/706 — ${resumoRespostaApi(status, body)}`);
  }

  const location = headers.get('Location') || headers.get('location') || '';
  const match = location.match(/\/tasks\/([^/?#]+)/);
  if (!match) throw new Error('Header Location ausente ou inválido na exportação Sinqia');
  const taskId = match[1];

  const xmlBytes = await acompanharTask(token, idPrc, taskId, proxy);
  const content = new TextDecoder('utf-8').decode(xmlBytes);
  const filename = `${sanitizeFilename(nome)}_${dataIso}.xml`;
  return { content, filename };
}

async function posicaoJaExistePorNome(nomeFundo: string, yyyymmdd: string): Promise<boolean> {
  const { data: byNome } = await supabase
    .from('posicao_carteira')
    .select('fundo_cnpj')
    .eq('fundo_dtposicao', yyyymmdd)
    .eq('section', 'header')
    .eq('nome_fundo', nomeFundo)
    .limit(1);
  if (byNome?.length) return true;

  const { data: byFundoNome } = await supabase
    .from('posicao_carteira')
    .select('fundo_cnpj')
    .eq('fundo_dtposicao', yyyymmdd)
    .eq('section', 'header')
    .eq('fundo_nome', nomeFundo)
    .limit(1);
  return (byFundoNome?.length ?? 0) > 0;
}

async function importarXmlViaFuncao(content: string, filename: string): Promise<unknown> {
  const formData = new FormData();
  const blob = new Blob([content], { type: 'application/xml' });
  formData.append('files', blob, filename);

  const resp = await fetch(`${supabaseUrl}/functions/v1/import-xml`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${supabaseServiceKey}` },
    body: formData,
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error || `import-xml HTTP ${resp.status}`);
  return json;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const log: string[] = [];
  const wallStart = Date.now();
  let proxyCtx: ProxyContext | null = null;

  try {
    const body: ImportSinqiaRequest = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

    const clientId = Deno.env.get('SINQIA_CLIENT_ID');
    const clientSecret = Deno.env.get('SINQIA_CLIENT_SECRET');
    const idPrc = Deno.env.get('SINQIA_ID_PRC') || '1';

    if (!clientId || !clientSecret) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Configure SINQIA_CLIENT_ID e SINQIA_CLIENT_SECRET nos secrets da Edge Function.',
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const dataIniStr = body.data_inicial?.trim() || ontemBr();
    const dataFimStr = body.data_final?.trim() || dataIniStr;
    const dataIni = parseDateInput(dataIniStr);
    const dataFim = parseDateInput(dataFimStr);
    if (!dataIni || !dataFim) {
      return new Response(
        JSON.stringify({ success: false, error: 'Datas inválidas. Use DD/MM/AAAA.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (dataIni > dataFim) {
      return new Response(
        JSON.stringify({ success: false, error: 'Data inicial não pode ser posterior à data final.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const apenasFaltantes = body.apenas_faltantes !== false;
    const forceIsin = body.change_invalid_isin === true;

    let fundos = await carregarFundosFinvestAtivos();
    if (fundos.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Nenhum fundo Finvest ativo está cadastrado.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (body.fundos_codigos?.length) {
      const set = new Set(body.fundos_codigos.map((c) => c.trim()));
      fundos = fundos.filter((f) => set.has(f.codigo));
      if (fundos.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'Nenhum fundo Sinqia corresponde aos códigos informados.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    const dias = iterBusinessDays(dataIni, dataFim);
    logPush(log, `Período: ${dataIniStr} a ${dataFimStr} (${dias.length} dia(s) útil(is))`);
    logPush(log, `Fundos: ${fundos.length} | output: V401 | idPrc: ${idPrc} | apenas_faltantes: ${apenasFaltantes}`);

    proxyCtx = initFixieProxy();
    logPush(
      log,
      `Proxy Fixie (Deno client) — host=${proxyCtx.hostLabel}, user=${proxyCtx.username}, token=${proxyCtx.passwordLen} chars`,
    );

    await testFixieProxy(proxyCtx, log);

    const token = await gerarToken(clientId, clientSecret, proxyCtx);
    logPush(log, 'Token Sinqia obtido.');

    const probe = await apiCall('GET', '/exports', token, proxyCtx, { idPrc, timeoutMs: 15_000 });
    if (probe.status === 403) {
      logPush(
        log,
        `Aviso: GET /exports retornou 403 — ${resumoRespostaApi(probe.status, probe.body)}`,
      );
      logPush(
        log,
        '403 na API = IP não liberado na Finvest. Esperado saída Fixie 52.87.82.133 ou 52.5.155.132.',
      );
    } else if (probe.status >= 200 && probe.status < 300) {
      logPush(log, `GET /exports OK (HTTP ${probe.status}) — API Sinqia acessível via Fixie.`);
    } else {
      logPush(log, `GET /exports HTTP ${probe.status} — ${resumoRespostaApi(probe.status, probe.body, 120)}`);
    }

    const jobs: SinqiaJobResult[] = [];
    const importResults: unknown[] = [];
    let skipped = 0;
    let successFiles = 0;
    let errorFiles = 0;
    let totalRecords = 0;
    let partial = false;

    outer:
    for (const dia of dias) {
      const yyyymmdd = formatYyyymmdd(dia);
      const iso = formatIsoDate(dia);

      for (const fundo of fundos) {
        if (Date.now() - wallStart > MAX_WALL_MS) {
          logPush(log, 'Limite de tempo atingido — execute novamente para continuar.');
          partial = true;
          break outer;
        }

        const jobBase: SinqiaJobResult = {
          codigo: fundo.codigo,
          nome: fundo.nome,
          data: iso,
          status: 'error',
        };

        if (apenasFaltantes && (await posicaoJaExistePorNome(fundo.nome, yyyymmdd))) {
          logPush(log, `[skip] ${fundo.nome} ${iso} — XML já importado`);
          jobs.push({ ...jobBase, status: 'skipped' });
          skipped++;
          continue;
        }

        const changeIsin = forceIsin || FUNDOS_SUBSTITUI_ISIN.has(fundo.codigo);
        logPush(log, `Baixando ${fundo.nome} (${fundo.codigo}) — ${iso}${changeIsin ? ' [ISIN]' : ''}...`);

        try {
          const downloaded = await exportarFundoSinqia(
            token,
            idPrc,
            fundo.codigo,
            fundo.nome,
            iso,
            changeIsin,
            proxyCtx,
          );

          const importResp = await importarXmlViaFuncao(downloaded.content, downloaded.filename) as {
            success?: boolean;
            summary?: { totalRecords?: number };
            results?: Array<{ success: boolean; records: number; error?: string }>;
          };

          importResults.push(importResp);
          const fileResult = importResp.results?.[0];
          const ok = importResp.success && fileResult?.success;

          if (ok) {
            const recs = fileResult?.records ?? importResp.summary?.totalRecords ?? 0;
            totalRecords += recs;
            successFiles++;
            logPush(log, `  OK — ${downloaded.filename} (${recs} registros)`);
            jobs.push({
              ...jobBase,
              status: 'ok',
              filename: downloaded.filename,
              records: recs,
            });
          } else {
            const errMsg = fileResult?.error || 'Falha no import-xml';
            logPush(log, `  ERRO — ${errMsg}`);
            jobs.push({ ...jobBase, status: 'error', error: errMsg, filename: downloaded.filename });
            errorFiles++;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logPush(log, `  ERRO — ${msg}`);
          jobs.push({ ...jobBase, status: 'error', error: msg });
          errorFiles++;
        }
      }
    }

    const response: ImportSinqiaResponse = {
      success: successFiles > 0,
      summary: {
        totalJobs: jobs.length,
        skipped,
        successFiles,
        errorFiles,
        totalRecords,
        partial,
      },
      jobs,
      importResults,
      log,
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = formatErr(err);
    logPush(log, `ERRO FATAL: ${msg}`);
    return new Response(
      JSON.stringify({
        success: false,
        error: msg.includes('407') || msg.includes('proxy authentication')
          ? `${msg} — Atualize FIXIE_URL no Supabase com a Proxy URL exata do painel Fixie (copie/cole, sem aspas).`
          : msg,
        log,
      } satisfies Partial<ImportSinqiaResponse>),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } finally {
    closeProxy(proxyCtx);
  }
});
