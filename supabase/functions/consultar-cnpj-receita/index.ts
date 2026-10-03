import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RECEITA_WS_BASE = "https://receitaws.com.br/v1/cnpj";

interface ConsultaCnpjRequest {
  cnpj?: string;
}

interface ConsultaCnpjResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  code?: "INVALID_CNPJ" | "NOT_FOUND" | "RATE_LIMIT" | "TIMEOUT" | "UPSTREAM";
}

function cleanCnpj(cnpj: string): string {
  return String(cnpj).replace(/\D/g, "").slice(0, 14);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { cnpj }: ConsultaCnpjRequest = await req.json().catch(() => ({}));
    const digits = cleanCnpj(cnpj ?? "");

    if (digits.length !== 14) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Informe um CNPJ válido com 14 dígitos.",
          code: "INVALID_CNPJ",
        } satisfies ConsultaCnpjResponse),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(`[consultar-cnpj-receita] Consultando CNPJ ${digits}`);

    let upstream: Response;
    try {
      upstream = await fetch(`${RECEITA_WS_BASE}/${digits}`, {
        headers: { Accept: "application/json" },
      });
    } catch (netErr) {
      console.error("[consultar-cnpj-receita] Erro de rede:", netErr);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Falha de conexão com a ReceitaWS.",
          code: "UPSTREAM",
        } satisfies ConsultaCnpjResponse),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (upstream.status === 429) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Limite de consultas excedido (3/min). Aguarde e tente novamente.",
          code: "RATE_LIMIT",
        } satisfies ConsultaCnpjResponse),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (upstream.status === 504) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Consulta indisponível no momento (timeout da ReceitaWS). Tente novamente em instantes.",
          code: "TIMEOUT",
        } satisfies ConsultaCnpjResponse),
        { status: 504, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const payload = await upstream.json().catch(() => null) as Record<string, unknown> | null;

    if (!payload) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Resposta inválida da ReceitaWS.",
          code: "UPSTREAM",
        } satisfies ConsultaCnpjResponse),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const status = String(payload.status ?? "").toUpperCase();
    if (status === "ERROR") {
      const msg = String(payload.message ?? "CNPJ não encontrado.");
      return new Response(
        JSON.stringify({
          success: false,
          error: msg,
          code: "NOT_FOUND",
        } satisfies ConsultaCnpjResponse),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!upstream.ok || status !== "OK") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Não foi possível consultar o CNPJ na Receita Federal.",
          code: "UPSTREAM",
        } satisfies ConsultaCnpjResponse),
        { status: upstream.ok ? 502 : upstream.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, data: payload } satisfies ConsultaCnpjResponse),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Erro desconhecido";
    console.error("[consultar-cnpj-receita]", msg);
    return new Response(
      JSON.stringify({ success: false, error: msg, code: "UPSTREAM" } satisfies ConsultaCnpjResponse),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
