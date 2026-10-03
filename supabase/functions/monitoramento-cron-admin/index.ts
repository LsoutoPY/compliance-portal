/**
 * Edge Function: monitoramento-cron-admin
 *
 * Administração do cron de monitoramento via frontend.
 * Ações (requer perfil completo + ativo):
 *   get_status  — config + jobs pg_cron + últimos logs
 *   save_config — salva monitoramento_cron_config
 *   sync_cron   — recria jobs pg_cron com apply_monitoramento_cron_jobs
 *   run_now     — dispara batch-monitoramento (modo diario, auto_continue)
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
  cron_meio_dia_ativo: boolean;
  cron_meio_dia_hora: number;
  cron_meio_dia_minuto: number;
  cron_tarde_ativo: boolean;
  cron_tarde_hora: number;
  cron_tarde_minuto: number;
  modos: string[];
  batch_limit: number;
  auto_continue: boolean;
  timeout_ms: number;
  dias_semana: number[];
  dias_retroativos?: number;
  cron_horarios?: Array<{ id: string; label: string; ativo: boolean; hora: number; minuto: number }>;
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

    const body = await req.json() as { action: Action; config?: Partial<CronConfig> };
    const { action, config } = body;

    if (action === 'get_status') {
      const [{ data: cfg }, { data: jobs }, { data: logs }] = await Promise.all([
        admin.from('monitoramento_cron_config').select('*').eq('id', 1).maybeSingle(),
        admin.rpc('get_monitoramento_cron_status'),
        admin.from('monitoramento_job_log')
          .select('id, modo, status, inicio, fim, processados, total_pares, erros, data_inicio')
          .order('inicio', { ascending: false })
          .limit(10),
      ]);

      const { data: ultimaData } = await admin
        .from('posicao_carteira')
        .select('fundo_dtposicao')
        .order('fundo_dtposicao', { ascending: false })
        .limit(1)
        .maybeSingle();

      let paresMonitorados = 0;
      if (ultimaData?.fundo_dtposicao) {
        const { data: pares } = await admin.rpc('get_pares_fundo_monitorado', {
          p_dtposicao: ultimaData.fundo_dtposicao,
        });
        paresMonitorados = (pares ?? []).length;
      }

      return new Response(JSON.stringify({
        success: true,
        config: cfg,
        cron_jobs: jobs ?? [],
        recent_logs: logs ?? [],
        ultima_data: ultimaData?.fundo_dtposicao ?? null,
        pares_monitorados: paresMonitorados,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'save_config' && config) {
      const { error } = await admin
        .from('monitoramento_cron_config')
        .update({ ...config, updated_at: new Date().toISOString() })
        .eq('id', 1);
      if (error) throw error;

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'sync_cron') {
      const { data: cfg, error: cfgErr } = await admin
        .from('monitoramento_cron_config')
        .select('*')
        .eq('id', 1)
        .single();
      if (cfgErr || !cfg) throw new Error('Config não encontrada. Rode a migration 20260716.');

      const cronBody = {
        mode: 'diario',
        modos: cfg.modos ?? ['enquadramento', 'liquidez'],
        batch_limit: cfg.batch_limit ?? 5,
        auto_continue: cfg.auto_continue !== false,
        dias_retroativos: cfg.dias_retroativos ?? 1,
      };

      const functionUrl = `${supabaseUrl}/functions/v1/batch-monitoramento`;
      const { data: result, error: applyErr } = await admin.rpc('apply_monitoramento_cron_jobs', {
        p_function_url: functionUrl,
        p_service_role: serviceKey,
        p_body_json: cronBody,
        p_timeout_ms: cfg.timeout_ms ?? 120000,
      });
      if (applyErr) throw new Error('Erro ao aplicar cron: ' + applyErr.message);

      const { data: jobs } = await admin.rpc('get_monitoramento_cron_status');

      return new Response(JSON.stringify({ success: true, apply_result: result, cron_jobs: jobs }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'run_now') {
      const { data: cfg } = await admin
        .from('monitoramento_cron_config')
        .select('*')
        .eq('id', 1)
        .maybeSingle();

      const res = await fetch(`${supabaseUrl}/functions/v1/batch-monitoramento`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'diario',
          modos: cfg?.modos ?? ['enquadramento', 'liquidez'],
          batch_limit: cfg?.batch_limit ?? 5,
          auto_continue: cfg?.auto_continue !== false,
          dias_retroativos: cfg?.dias_retroativos ?? 1,
        }),
      });

      const data = await res.json().catch(() => ({}));
      return new Response(JSON.stringify({ success: res.ok, batch: data }), {
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
