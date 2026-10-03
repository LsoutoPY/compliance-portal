import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

/** Renova a sessão quando possível e devolve um access token válido. */
export async function getFreshAccessToken(): Promise<string> {
  const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
  const refreshed = refreshData.session?.access_token;
  if (refreshed) return refreshed;

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new Error("Sessão expirada. Faça logout e login novamente.");
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (token) return token;

  if (refreshError) {
    throw new Error(refreshError.message || "Sessão expirada. Faça logout e login novamente.");
  }

  throw new Error("Sessão expirada. Faça logout e login novamente.");
}

export async function extractFunctionError(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError && error.context) {
    try {
      const body = (await error.context.json()) as {
        details?: unknown;
        error?: unknown;
        message?: unknown;
      };
      const msg = body.details ?? body.error ?? body.message;
      if (typeof msg === "string" && msg.trim()) return msg;
      if (msg != null) return JSON.stringify(msg);
    } catch {
      /* ignore */
    }
  }

  const ctx = (error as { context?: Response })?.context;
  if (ctx) {
    try {
      const body = (await ctx.json()) as {
        details?: unknown;
        error?: unknown;
        message?: unknown;
      };
      const msg = body.details ?? body.error ?? body.message;
      if (typeof msg === "string" && msg.trim()) return msg;
      if (msg != null) return JSON.stringify(msg);
    } catch {
      /* ignore */
    }
  }

  return error instanceof Error ? error.message : String(error);
}

export function formatInvokeError(details: unknown, error: unknown): string {
  const msg = details ?? error;
  if (typeof msg === "string" && msg.trim()) return msg;
  if (msg != null) return JSON.stringify(msg);
  return "Erro desconhecido ao invocar edge function";
}

/** Invoca edge function com JWT atualizado (evita 401 no 2º envio). */
export async function invokeAuthenticatedFunction<T = unknown>(
  functionName: string,
  body?: Record<string, unknown> | FormData,
): Promise<{ data: T | null; error: Error | null }> {
  try {
    const accessToken = await getFreshAccessToken();
    const { data, error } = await supabase.functions.invoke<T>(functionName, {
      body,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: SUPABASE_ANON_KEY,
      },
    });

    if (error) {
      const msg = await extractFunctionError(error);
      if (
        msg.includes("401") ||
        msg.toLowerCase().includes("não autorizado") ||
        msg.toLowerCase().includes("invalid jwt")
      ) {
        return { data: null, error: new Error("Sessão expirada. Faça logout e login novamente.") };
      }
      return { data: null, error: new Error(msg) };
    }

    return { data: data ?? null, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
