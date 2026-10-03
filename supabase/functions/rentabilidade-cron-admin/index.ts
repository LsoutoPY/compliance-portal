/**
 * Edge Function: rentabilidade-cron-admin
 *
 * Administração do cron de envio automático do Relatório de Rentabilidade.
 * Ações (requer perfil completo + ativo):
 *   get_status  — config + jobs pg_cron + últimos envios
 *   save_config — salva rentabilidade_cron_config
 *   sync_cron   — recria jobs pg_cron com apply_rentabilidade_cron_jobs
 *   run_now     — dispara send-rentabilidade-report-auto (origem="auto", respeita dedup)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Action = 'get_status' | 'save_config' | 'sync_cron' | 'run_now';

interface CronConfig {
  cron_horarios: Array<{ id: string; label: string; ativo: boolean; hora: number; minuto: number }>;
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

    const admin = createClient(supabaseUrl, serviceKey);
    const isServiceRoleRequest = authHeader === `Bearer ${serviceKey}`;
    if (!isServiceRoleRequest) {
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
      await assertCanManage(caller.id, admin);
    }

    const body = await req.json() as { action: Action; config?: Partial<CronConfig>; data_referencia?: string };
    const { action, config } = body;

    if (action === 'get_status') {
      const [{ data: cfg }, { data: jobs }, { data: envios }] = await Promise.all([
        admin.from('rentabilidade_cron_config').select('*').eq('id', 1).maybeSingle(),
        admin.rpc('get_rentabilidade_cron_status'),
        admin
          .from('envios_relatorio_rentabilidade')
          .select('id, data_referencia, destinatarios, status, origem, status_cobertura, qtd_fundos, qtd_faltantes, erro_mensagem, created_at')
          .order('created_at', { ascending: false })
          .limit(15),
      ]);

      return new Response(JSON.stringify({
        success: true,
        config: cfg,
        cron_jobs: jobs ?? [],
        recent_envios: envios ?? [],
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'save_config' && config) {
      const { error } = await admin
        .from('rentabilidade_cron_config')
        .update({ ...config, updated_at: new Date().toISOString() })
        .eq('id', 1);
      if (error) throw error;

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'sync_cron') {
      const { data: cfg, error: cfgErr } = await admin
        .from('rentabilidade_cron_config')
        .select('*')
        .eq('id', 1)
        .single();
      if (cfgErr || !cfg) throw new Error('Config não encontrada. Rode a migration 20260804.');

      const functionUrl = `${supabaseUrl}/functions/v1/send-rentabilidade-report-auto`;
      const { data: result, error: applyErr } = await admin.rpc('apply_rentabilidade_cron_jobs', {
        p_function_url: functionUrl,
        p_service_role: serviceKey,
        p_body_json: { origem: 'auto' },
        p_timeout_ms: cfg.timeout_ms ?? 120000,
      });
      if (applyErr) throw new Error('Erro ao aplicar cron: ' + applyErr.message);

      const workerUrl = `${supabaseUrl}/functions/v1/process-rentabilidade-snapshot-v2-queue`;
      const { data: workerResult, error: workerErr } = await admin.rpc(
        'apply_rentabilidade_snapshot_v2_worker_job',
        {
          p_function_url: workerUrl,
          p_service_role: serviceKey,
          p_timeout_ms: 60000,
          p_worker_slots: 3,
        },
      );
      if (workerErr) throw new Error('Erro ao aplicar worker V2: ' + workerErr.message);

      const { data: jobs } = await admin.rpc('get_rentabilidade_cron_status');

      return new Response(JSON.stringify({ success: true, apply_result: result, worker_result: workerResult, cron_jobs: jobs }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'run_now') {
      const res = await fetch(`${supabaseUrl}/functions/v1/send-rentabilidade-report-auto`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ origem: 'auto', data_referencia: body.data_referencia }),
      });

      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      const ok = res.ok && !data.error;
      return new Response(JSON.stringify({ success: ok, result: data, http_status: res.status }), {
        status: ok ? 200 : (res.status >= 400 ? res.status : 502),
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
