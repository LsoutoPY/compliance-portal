import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BTG_TOKEN_URL = 'https://funds.btgpactual.com/connect/token';
const BTG_REPORT_URL = 'https://funds.btgpactual.com/reports/Portfolio';
const BTG_TICKET_URL = 'https://funds.btgpactual.com/reports/Ticket?ticketId=';

const TYPE_REPORT_XML41 = 3;

/** Fundos BTG (par QI — alinhado a fundos_btg.py). */
const BTG_FUNDOS: Array<{ cnpj: string; nome: string }> = [
  { cnpj: '22003335000104', nome: 'QI CP FC FIM' },
  { cnpj: '51555966000126', nome: 'MOMENTUM PREV FC FIM' },
  { cnpj: '45653388000168', nome: 'QI CP PLUS FC FIDC' },
  { cnpj: '33913629000181', nome: 'TAMBAÚ QI FIM CP' },
  { cnpj: '34218601000197', nome: 'CARPE DIEM BR QI FIM' },
  { cnpj: '65794271000101', nome: 'CVPAR BC FII' },
];

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 90_000;
const MAX_WALL_MS = 130_000;

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface ImportBtgRequest {
  data_inicial?: string;
  data_final?: string;
  fundos_cnpjs?: string[] | null;
  apenas_faltantes?: boolean;
  type_report?: number;
}

interface BtgJobResult {
  cnpj: string;
  nome: string;
  data: string;
  status: 'ok' | 'skipped' | 'error';
  filename?: string;
  records?: number;
  error?: string;
}

interface ImportBtgResponse {
  success: boolean;
  summary: {
    totalJobs: number;
    skipped: number;
    successFiles: number;
    errorFiles: number;
    totalRecords: number;
    partial?: boolean;
  };
  jobs: BtgJobResult[];
  importResults?: unknown[];
  log: string[];
  error?: string;
}

function logPush(log: string[], msg: string) {
  console.log(`[import-btg-xml] ${msg}`);
  log.push(msg);
}

function parseDateInput(raw: string): Date | null {
  const s = raw.trim();
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return new Date(+br[3], +br[2] - 1, +br[1]);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return new Date(+compact[1], +compact[2] - 1, +compact[3]);
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
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function sanitizeFilename(nome: string): string {
  return nome.replace(/[^\w\s.-]/g, '_').replace(/\s+/g, '_').slice(0, 80);
}

async function gerarToken(clientId: string, clientSecret: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const resp = await fetch(BTG_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Token BTG HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const json = await resp.json();
  if (!json.access_token) throw new Error('Token BTG: access_token ausente na resposta');
  return json.access_token as string;
}

async function posicaoJaExiste(cnpj: string, yyyymmdd: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('posicao_carteira')
    .select('fundo_cnpj')
    .eq('fundo_cnpj', cnpj)
    .eq('fundo_dtposicao', yyyymmdd)
    .eq('section', 'header')
    .limit(1);
  if (error) {
    console.error('[import-btg-xml] Erro ao checar posição existente:', error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pareceXml(texto: string): boolean {
  const t = texto.trimStart();
  return t.startsWith('<') || t.startsWith('<?xml');
}

interface BtgTicketPayload {
  totalPages?: number | null;
  page?: number | null;
  result?: string | null;
  files?: unknown[] | null;
}

type BtgDownloadOutcome =
  | { status: 'ok'; content: string; filename: string }
  | { status: 'no_records' };

function parseBtgTicketPayload(content: string): BtgTicketPayload | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed) as BtgTicketPayload;
  } catch {
    return null;
  }
}

function btgResultLabel(content: string): string {
  const payload = parseBtgTicketPayload(content);
  return String(payload?.result ?? '').trim();
}

function descreverRespostaTicket(content: string, contentType: string): string {
  const trimmed = content.trim();
  if (!trimmed) return 'corpo vazio';

  const payload = parseBtgTicketPayload(content);
  if (payload) {
    const parts = [
      payload.result ? `result=${payload.result}` : null,
      payload.files?.length ? `files=${payload.files.length}` : null,
    ].filter(Boolean);
    if (parts.length) return parts.join(' — ');
    return trimmed.slice(0, 280);
  }

  const ct = contentType.toLowerCase();
  if (ct.includes('html')) return 'página HTML (possível erro de autenticação ou URL)';
  return `${contentType || 'texto'}: ${trimmed.slice(0, 280)}`;
}

function isBtgProcessando(content: string): boolean {
  const r = btgResultLabel(content).toLowerCase();
  return r === 'processando' || /process|pending|wait|queue|gerando|progress/i.test(r);
}

function isBtgNoRecords(content: string): boolean {
  const r = btgResultLabel(content).toLowerCase();
  return r === 'no records' || r === 'sem registros' || r.includes('no record');
}

function extrairXmlDoPayload(payload: BtgTicketPayload): string | null {
  if (!payload.files || !Array.isArray(payload.files)) return null;

  for (const item of payload.files) {
    if (typeof item === 'string') {
      const s = item.trim();
      if (s.startsWith('<')) return item;
      try {
        const bin = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
        const decoded = new TextDecoder('utf-8').decode(bin);
        if (decoded.trim().startsWith('<')) return decoded;
      } catch {
        /* não é base64 */
      }
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      for (const key of ['content', 'fileContent', 'data', 'xml', 'file', 'base64']) {
        const v = o[key];
        if (typeof v === 'string' && v.trim().startsWith('<')) return v;
      }
    }
  }
  return null;
}

async function baixarRelatorioBtg(
  token: string,
  cnpj: string,
  nomeFundo: string,
  dataRef: Date,
  tipoRelatorio: number,
): Promise<BtgDownloadOutcome> {
  const dataRefStr = formatIsoDate(dataRef);
  const authHeaders = { 'X-SecureConnect-Token': token };
  const payload = {
    contract: {
      startDate: dataRefStr,
      endDate: dataRefStr,
      typeReport: tipoRelatorio,
      fundName: cnpj,
    },
    pageSize: 100,
    webhookEndpoint: '',
  };

  const postResp = await fetch(BTG_REPORT_URL, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!postResp.ok) {
    const txt = await postResp.text();
    throw new Error(`POST Portfolio HTTP ${postResp.status}: ${txt.slice(0, 200)}`);
  }

  const postJson = await postResp.json();
  const ticket = postJson.ticket as string | undefined;
  if (!ticket) throw new Error('Nenhum ticket retornado pela API BTG');

  const started = Date.now();
  let ultimaResposta = '';
  let polls = 0;

  while (Date.now() - started <= POLL_TIMEOUT_MS) {
    // Igual ao Python: concatena ticket sem encode extra
    const ticketResp = await fetch(BTG_TICKET_URL + ticket, {
      headers: { ...authHeaders, Accept: 'application/xml, text/xml, */*' },
      method: 'GET',
    });

    // BTG pode devolver 202/204 enquanto gera o arquivo
    if (ticketResp.status === 202 || ticketResp.status === 204 || ticketResp.status === 404) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (ticketResp.status !== 200) {
      ultimaResposta = `HTTP ${ticketResp.status}: ${(await ticketResp.text()).slice(0, 200)}`;
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const contentType = ticketResp.headers.get('content-type') || '';
    const bytes = new Uint8Array(await ticketResp.arrayBuffer());
    const content = new TextDecoder('utf-8').decode(bytes);
    ultimaResposta = descreverRespostaTicket(content, contentType);

    if (pareceXml(content)) {
      const filename = `${sanitizeFilename(nomeFundo)}_${dataRefStr}.xml`;
      return { status: 'ok', content, filename };
    }

    const payload = parseBtgTicketPayload(content);
    if (payload) {
      if (isBtgNoRecords(content)) {
        return { status: 'no_records' };
      }
      if (isBtgProcessando(content)) {
        polls++;
        if (polls === 1 || polls % 3 === 0) {
          console.log(
            `[import-btg-xml]   Aguardando BTG processar... (~${polls * (POLL_INTERVAL_MS / 1000)}s)`,
          );
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const fromFiles = extrairXmlDoPayload(payload);
      if (fromFiles) {
        const filename = `${sanitizeFilename(nomeFundo)}_${dataRefStr}.xml`;
        return { status: 'ok', content: fromFiles, filename };
      }
      if (payload.result) {
        throw new Error(`BTG ticket: result=${payload.result}`);
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timeout (${POLL_TIMEOUT_MS / 1000}s) aguardando XML. Última resposta: ${ultimaResposta || 'nenhuma'}`,
  );
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
  if (!resp.ok) {
    throw new Error(json.error || `import-xml HTTP ${resp.status}`);
  }
  return json;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const log: string[] = [];
  const wallStart = Date.now();

  try {
    const body: ImportBtgRequest = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

    const clientId = Deno.env.get('BTG_CLIENT_ID');
    const clientSecret = Deno.env.get('BTG_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Configure BTG_CLIENT_ID e BTG_CLIENT_SECRET nos secrets da Edge Function.',
        } satisfies Pick<ImportBtgResponse, 'success' | 'error'>),
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

    const typeReport = body.type_report ?? TYPE_REPORT_XML41;
    const apenasFaltantes = body.apenas_faltantes !== false;

    let fundos = BTG_FUNDOS;
    if (body.fundos_cnpjs?.length) {
      const set = new Set(body.fundos_cnpjs.map((c) => c.replace(/\D/g, '').padStart(14, '0')));
      fundos = BTG_FUNDOS.filter((f) => set.has(f.cnpj));
      if (fundos.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'Nenhum fundo BTG corresponde aos CNPJs informados.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    const dias = iterBusinessDays(dataIni, dataFim);
    logPush(log, `Período: ${dataIniStr} a ${dataFimStr} (${dias.length} dia(s) útil(is))`);
    logPush(log, `Fundos: ${fundos.length} | typeReport: ${typeReport} | apenas_faltantes: ${apenasFaltantes}`);

    const token = await gerarToken(clientId, clientSecret);
    logPush(log, 'Token BTG obtido.');

    const jobs: BtgJobResult[] = [];
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

        const jobBase: BtgJobResult = { cnpj: fundo.cnpj, nome: fundo.nome, data: iso, status: 'error' };

        if (apenasFaltantes && (await posicaoJaExiste(fundo.cnpj, yyyymmdd))) {
          logPush(log, `[skip] ${fundo.nome} ${iso} — XML já importado`);
          jobs.push({ ...jobBase, status: 'skipped' });
          skipped++;
          continue;
        }

        logPush(log, `Baixando ${fundo.nome} (${fundo.cnpj}) — ${iso}...`);

        try {
          const downloaded = await baixarRelatorioBtg(token, fundo.cnpj, fundo.nome, dia, typeReport);

          if (downloaded.status === 'no_records') {
            logPush(log, `  [skip] Sem posição na BTG (No records) — ${iso}`);
            jobs.push({ ...jobBase, status: 'skipped', error: 'No records' });
            skipped++;
            continue;
          }

          const importResp = await importarXmlViaFuncao(downloaded.content, downloaded.filename) as {
            success?: boolean;
            summary?: { totalRecords?: number; successFiles?: number };
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

    const totalJobs = jobs.length;
    const response: ImportBtgResponse = {
      success: successFiles > 0,
      summary: {
        totalJobs,
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logPush(log, `ERRO FATAL: ${msg}`);
    return new Response(
      JSON.stringify({ success: false, error: msg, log } satisfies Partial<ImportBtgResponse>),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
