/**
 * Edge Function: import-xml-auto
 *
 * Orquestra importação automática de XMLs BTG e/ou Finvest.
 * Disparada pelo pg_cron (xml_import_cron_config) ou manualmente via
 * xml-import-cron-admin (run_now).
 *
 * Período: calculado a partir de dias_calendario_retroativos (data final = ontem).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

type Fonte = 'btg' | 'finvest';

interface AutoRequest {
  origem?: 'auto' | 'manual';
  fonte?: Fonte | 'ambos';
  data_inicial?: string;
  data_final?: string;
  apenas_faltantes?: boolean;
}

interface ImportSummary {
  totalJobs?: number;
  successFiles?: number;
  errorFiles?: number;
  skipped?: number;
  totalRecords?: number;
  partial?: boolean;
}

interface ImportJobError {
  nome?: string;
  data?: string;
  error?: string;
  status?: string;
}

function summarizeImportErrors(data: Record<string, unknown>, errorFiles: number): string {
  if (typeof data.error === 'string' && data.error.trim()) return data.error.trim();

  const jobs = Array.isArray(data.jobs) ? data.jobs as ImportJobError[] : [];
  const details = jobs
    .filter((job) => job.status === 'error' && job.error)
    .slice(0, 3)
    .map((job) => `${job.nome ?? 'fundo'}${job.data ? ` ${job.data}` : ''}: ${job.error}`);

  return details.length > 0
    ? `${errorFiles} falha(s): ${details.join(' | ')}`
    : `${errorFiles} falha(s) na importação.`;
}

function formatBrDate(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function dateRangeFromDiasRetroativos(dias: number): { data_inicial: string; data_final: string } {
  const n = Math.max(1, Math.min(30, Math.floor(dias)));
  const fim = new Date();
  fim.setHours(12, 0, 0, 0);
  fim.setDate(fim.getDate() - 1);

  const ini = new Date(fim);
  ini.setDate(ini.getDate() - (n - 1));

  return { data_inicial: formatBrDate(ini), data_final: formatBrDate(fim) };
}

function parseBrDate(raw: string): Date | null {
  const m = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1], 12, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function invokeImport(
  supabaseUrl: string,
  serviceKey: string,
  functionName: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey);

  try {
    const body = (await req.json().catch(() => ({}))) as AutoRequest;
    const origem = body.origem === 'manual' ? 'manual' : 'auto';
    const fonteReq = body.fonte ?? 'ambos';

    const { data: cfg } = await admin
      .from('xml_import_cron_config')
      .select('dias_calendario_retroativos, apenas_faltantes')
      .eq('id', 1)
      .maybeSingle();

    const diasRetroativos = cfg?.dias_calendario_retroativos ?? 3;
    const apenasFaltantes = body.apenas_faltantes ?? cfg?.apenas_faltantes !== false;

    const defaultRange = dateRangeFromDiasRetroativos(diasRetroativos);
    const dataInicial = body.data_inicial?.trim() || defaultRange.data_inicial;
    const dataFinal = body.data_final?.trim() || defaultRange.data_final;

    const iniDate = parseBrDate(dataInicial);
    const fimDate = parseBrDate(dataFinal);
    if (!iniDate || !fimDate) {
      return new Response(
        JSON.stringify({ success: false, error: 'Datas inválidas. Use DD/MM/AAAA.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (iniDate > fimDate) {
      return new Response(
        JSON.stringify({ success: false, error: 'data_inicial não pode ser posterior a data_final.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const fontes: Fonte[] = fonteReq === 'ambos'
      ? ['btg', 'finvest']
      : [fonteReq === 'finvest' ? 'finvest' : 'btg'];

    const results: Record<string, unknown> = {};
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const fonte of fontes) {
      const functionName = fonte === 'btg' ? 'import-btg-xml' : 'import-sinqia-xml';

      const { data: logRow, error: logErr } = await admin
        .from('xml_import_log')
        .insert({
          fonte,
          origem,
          status: 'running',
          data_inicial: dataInicial,
          data_final: dataFinal,
        })
        .select('id')
        .single();

      const logId = logErr ? null : logRow?.id as string;

      console.log(`[import-xml-auto] ${fonte.toUpperCase()} ${dataInicial} → ${dataFinal} (origem=${origem})`);

      const importResult = await invokeImport(supabaseUrl, serviceKey, functionName, {
        data_inicial: dataInicial,
        data_final: dataFinal,
        apenas_faltantes: apenasFaltantes,
      });

      const summary = (importResult.data.summary ?? {}) as ImportSummary;
      const errorFiles = summary.errorFiles ?? 0;
      const skipped = summary.skipped ?? 0;
      const successFiles = summary.successFiles ?? 0;
      const totalJobs = summary.totalJobs ?? successFiles + skipped + errorFiles;
      const hasUsableResult = successFiles > 0 || skipped > 0 || totalJobs === 0;
      const success = importResult.ok && (hasUsableResult || importResult.data.success === true);
      const partial = success && (errorFiles > 0 || summary.partial === true);
      const errorDetail = errorFiles > 0
        ? summarizeImportErrors(importResult.data, errorFiles)
        : null;

      const mensagem = partial
        ? `${successFiles} XML(s) importado(s), ${skipped} ignorado(s); ${errorDetail ?? 'processamento parcial.'}`
        : !success
          ? errorDetail ?? (importResult.data.error as string | undefined) ?? `Falha HTTP ${importResult.status}.`
        : successFiles > 0
          ? `${successFiles} XML(s) importado(s), ${skipped} ignorado(s).`
          : totalJobs === 0
            ? 'Nenhum dia útil no período — nada a importar.'
            : `Nenhum XML novo — ${skipped} ignorado(s).`;

      if (logId) {
        await admin.from('xml_import_log').update({
          status: success ? 'success' : 'error',
          success_files: summary.successFiles ?? null,
          error_files: summary.errorFiles ?? null,
          skipped: summary.skipped ?? null,
          total_records: summary.totalRecords ?? null,
          mensagem: success ? mensagem : null,
          erro_mensagem: success ? null : mensagem,
          fim: new Date().toISOString(),
        }).eq('id', logId);
      }

      results[fonte] = {
        ...importResult.data,
        orchestrator: { success, partial, http_status: importResult.status },
      };

      if (!success) {
        errors.push(`${fonte.toUpperCase()}: ${mensagem}`);
      } else if (partial) {
        warnings.push(`${fonte.toUpperCase()}: ${mensagem}`);
      }
    }

    const allOk = errors.length === 0;

    return new Response(
      JSON.stringify({
        success: allOk,
        origem,
        data_inicial: dataInicial,
        data_final: dataFinal,
        apenas_faltantes: apenasFaltantes,
        dias_calendario_retroativos: diasRetroativos,
        results,
        partial: warnings.length > 0,
        warnings,
        error: allOk ? undefined : errors.join(' | '),
      }),
      {
        status: allOk ? 200 : 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro desconhecido';
    console.error('[import-xml-auto]', err);
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
