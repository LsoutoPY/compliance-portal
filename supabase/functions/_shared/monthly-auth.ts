import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

export async function requireRiskUser(req: Request): Promise<string> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) throw new Error("AUTH_REQUIRED");
  const service = serviceClient();
  const { data, error } = await service.auth.getUser(bearer);
  if (error || !data.user) throw new Error("AUTH_REQUIRED");
  const userId = data.user.id;
  const [{ data: profile }, { data: portalProfile }] = await Promise.all([
    service.from("profiles").select("role").eq("id", userId).maybeSingle(),
    service.from("user_profiles").select("access_type,is_active").eq("id", userId).maybeSingle(),
  ]);
  if (!portalProfile?.is_active) throw new Error("RISK_ROLE_REQUIRED");
  if (profile?.role === "compliance" ||
      (profile?.role !== "risco" && !(portalProfile?.access_type === "completo" && portalProfile?.is_active))) {
    throw new Error("RISK_ROLE_REQUIRED");
  }
  return userId;
}

export const monthlyCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function monthlyError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = message === "AUTH_REQUIRED" ? 401 : message === "RISK_ROLE_REQUIRED" ? 403 : 400;
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...monthlyCors, "Content-Type": "application/json" },
  });
}
