/**
 * Edge Function: xml-import-cron-admin
 *
 * Administração do cron de importação automática de XMLs BTG e Finvest.
 * Ações (requer perfil completo + ativo):
 *   get_status  — config + jobs pg_cron + últimos logs
 *   save_config — salva xml_import_cron_config
 *   sync_cron   — recria jobs pg_cron com apply_xml_import_cron_jobs
 *   run_now     — dispara import-xml-auto (origem="manual")
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Action = 'get_status' | 'save_config' | 'sync_cron' | 'run_now';
type Fonte = 'btg' | 'finvest' | 'ambos';

interface CronHorario {
  id: string;
  label: string;
  ativo: boolean;
  hora: number;
  minuto: number;
}

interface CronConfig {
  btg_cron_horarios: CronHorario[];
  finvest_cron_horarios: CronHorario[];
  dias_calendario_retroativos: number;
  apenas_faltantes: boolean;
  dias_semana: number[];
  timeout_ms: number;
}

async function assertCanManage(callerId: string, admin: ReturnType<typeof createClient>) {
  const { data: profile, error } = await admin
    .from('user_profiles')
    .select('access_type, is_active')
    .eq('id', callerId)
    .maybeSingle();

  if (error) throw new Error('Erro ao verificar permissão: ' + error.message);
  if (!profile?.is_active || profile.access_type !== 'completo') {
    throw new Error('Sem permissão. Apenas usuários com acesso completo.');
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ success: false, error: 'Não autenticado.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: authError } = await supabaseUser.auth.getUser();
    if (authError || !caller) {
      return new Response(JSON.stringify({ success: false, error: 'Sessão inválida.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);
    await assertCanManage(caller.id, admin);

    const body = await req.json() as {
      action: Action;
      config?: Partial<CronConfig>;
      fonte?: Fonte;
      data_inicial?: string;
      data_final?: string;
      apenas_faltantes?: boolean;
    };
    const { action, config } = body;

    if (action === 'get_status') {
      const [{ data: cfg }, { data: jobs }, { data: logs }] = await Promise.all([
        admin.from('xml_import_cron_config').select('*').eq('id', 1).maybeSingle(),
        admin.rpc('get_xml_import_cron_status'),
        admin
          .from('xml_import_log')
          .select('id, fonte, origem, status, data_inicial, data_final, success_files, error_files, skipped, total_records, mensagem, erro_mensagem, inicio, fim')
          .order('inicio', { ascending: false })
          .limit(20),
      ]);

      return new Response(JSON.stringify({
        success: true,
        config: cfg,
        cron_jobs: jobs ?? [],
        recent_logs: logs ?? [],
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'save_config' && config) {
      const { error } = await admin
        .from('xml_import_cron_config')
        .update({ ...config, updated_at: new Date().toISOString() })
        .eq('id', 1);
      if (error) throw error;

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'sync_cron') {
      const { data: cfg, error: cfgErr } = await admin
        .from('xml_import_cron_config')
        .select('*')
        .eq('id', 1)
        .single();
      if (cfgErr || !cfg) throw new Error('Config não encontrada. Rode a migration 20260821.');

      const functionUrl = `${supabaseUrl}/functions/v1/import-xml-auto`;
      const { data: result, error: applyErr } = await admin.rpc('apply_xml_import_cron_jobs', {
        p_function_url: functionUrl,
        p_service_role: serviceKey,
        p_timeout_ms: cfg.timeout_ms ?? 180000,
      });
      if (applyErr) throw new Error('Erro ao aplicar cron: ' + applyErr.message);

      const { data: jobs } = await admin.rpc('get_xml_import_cron_status');

      return new Response(JSON.stringify({ success: true, apply_result: result, cron_jobs: jobs }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'run_now') {
      const res = await fetch(`${supabaseUrl}/functions/v1/import-xml-auto`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          origem: 'manual',
          fonte: body.fonte ?? 'ambos',
          data_inicial: body.data_inicial,
          data_final: body.data_final,
          apenas_faltantes: body.apenas_faltantes,
        }),
      });

      const data = await res.json().catch(() => ({}));
      return new Response(JSON.stringify({ success: res.ok && data?.success !== false, result: data }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: false, error: 'Ação inválida.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = (err as Error)?.message ?? 'Erro interno';
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
