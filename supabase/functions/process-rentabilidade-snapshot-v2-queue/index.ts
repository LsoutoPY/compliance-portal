/** Processa exatamente uma classe pendente por chamada. */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.headers.get("Authorization") !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) return response({ error: "Nao autorizado" }, 401);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: reconciled, error: reconcileError } = await supabase.rpc("reconcile_rentabilidade_snapshot_v2_queue", {
    p_limit: 100,
  });
  if (reconcileError) {
    console.error("[rentabilidade-snapshot-v2-queue] Falha na reconciliação:", reconcileError.message);
  }
  const { error: finalizeError } = await supabase.rpc("finalize_rentabilidade_snapshot_v2_queue_from_snapshot");
  if (finalizeError) {
    console.error("[rentabilidade-snapshot-v2-queue] Falha ao finalizar snapshots já persistidos:", finalizeError.message);
  }
  const { data: claimed, error: claimError } = await supabase.rpc("claim_rentabilidade_snapshot_reprocess_v2");
  if (claimError) return response({ error: "Falha ao reservar item da fila", details: claimError.message }, 500);
  const item = (claimed ?? [])[0] as {
    id: string; data_referencia: string; fundo_cnpj: string; fundo_isin: string; fundo_nome: string | null; attempts: number;
  } | undefined;
  if (!item) return response({ success: true, skipped: true, motivo: "fila_vazia", reconciled: Number(reconciled ?? 0) });

  try {
    const result = await fetch(`${SUPABASE_URL}/functions/v1/rebuild-rentabilidade-snapshot-v2`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fundo_cnpj: item.fundo_cnpj,
        fundo_isin: item.fundo_isin,
        fundo_nome: item.fundo_nome,
        data_referencia: item.data_referencia,
        origem: "xml_queue_v2",
      }),
    });
    const payload = await result.json().catch(() => ({})) as Record<string, unknown>;
    if (!result.ok || payload.error) throw new Error(String(payload.details ?? payload.error ?? `HTTP ${result.status}`));
    const { error: finishError } = await supabase.rpc("finish_rentabilidade_snapshot_reprocess_v2", { p_id: item.id, p_success: true });
    if (finishError) throw new Error(`Snapshot calculado, mas a fila nao foi finalizada: ${finishError.message}`);
    return response({ success: true, item_id: item.id, fundo_key: payload.fundo_key, data_referencia: item.data_referencia, attempts: item.attempts, reconciled: Number(reconciled ?? 0) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase.rpc("finish_rentabilidade_snapshot_reprocess_v2", { p_id: item.id, p_success: false, p_error: message });
    return response({ success: false, item_id: item.id, error: message, attempts: item.attempts }, 502);
  }
});
