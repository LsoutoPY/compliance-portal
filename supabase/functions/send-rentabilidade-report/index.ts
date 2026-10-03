/**
 * Envio manual do relatorio de rentabilidade.
 *
 * O navegador envia apenas a data e os destinatarios. HTML, Excel e metricas
 * sao montados aqui, exclusivamente a partir dos snapshots V2 persistidos.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import type { FundoXmlCoverageRow } from "../send-rentabilidade-report-auto/calc.ts";
import { buildDetailedReport } from "../send-rentabilidade-report-auto/buildDetailedReport.ts";
import { fetchSnapshotReportData } from "../send-rentabilidade-report-auto/snapshotReportData.ts";
import { getSmtpConfig, MAX_ATTACHMENT_BASE64_CHARS, sendEmailViaSmtp, smtpConfigError } from "./smtp.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface SendReportRequest {
  dataReferencia?: string;
  emailDestinatarios?: string[];
  fundosFaltantes?: FundoXmlCoverageRow[];
}

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function normalizeCnpj(value: string | null | undefined) {
  return value?.replace(/\D/g, "") ?? "";
}

function fundKey(cnpj: string | null | undefined, isin: string | null | undefined) {
  const normalizedIsin = isin?.trim().toUpperCase();
  return normalizedIsin ? `${normalizeCnpj(cnpj)}|ISIN:${normalizedIsin}` : normalizeCnpj(cnpj);
}

async function resolveCoverage(
  supabase: ReturnType<typeof createClient>,
  dataReferencia: string,
  includedKeys: Set<string>,
): Promise<FundoXmlCoverageRow[]> {
  const { data, error } = await supabase.rpc("get_pares_fundo_monitorado", {
    p_dtposicao: dataReferencia.replace(/-/g, ""),
  });
  if (error) throw new Error(`Falha ao ler classes XML monitoradas: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((pair) => !includedKeys.has(fundKey(String(pair.fundo_cnpj ?? ""), String(pair.fundo_isin ?? ""))))
    .map((pair) => ({
      fundo_key: fundKey(String(pair.fundo_cnpj ?? ""), String(pair.fundo_isin ?? "")),
      nome_fundo: String(pair.nome_fundo ?? pair.fundo_cnpj ?? "Sem nome"),
      cnpj_fundo: normalizeCnpj(String(pair.fundo_cnpj ?? "")),
      fundo_isin: pair.fundo_isin ? String(pair.fundo_isin) : null,
      ultima_data_iso: dataReferencia,
      administrador: "",
    }));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return response({ error: "Metodo nao permitido" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return response({ error: "Nao autorizado" }, 401);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: authData, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !authData.user) return response({ error: "Nao autorizado" }, 401);

    const body = (await req.json().catch(() => ({}))) as SendReportRequest;
    const dataReferencia = body.dataReferencia?.trim();
    const emailDestinatarios = [...new Set((body.emailDestinatarios ?? []).map((email) => email.trim()).filter(Boolean))];
    if (!dataReferencia || !/^\d{4}-\d{2}-\d{2}$/.test(dataReferencia) || emailDestinatarios.length === 0) {
      return response({ error: "dataReferencia valida e ao menos um destinatario sao obrigatorios" }, 422);
    }
    if (!getSmtpConfig()) return response({ error: smtpConfigError() }, 500);

    const { fundos, ativosMap } = await fetchSnapshotReportData(supabase, dataReferencia);
    const { data: ignoredRows, error: ignoredError } = await supabase
      .from("rentabilidade_relatorio_fundos_ignorados")
      .select("fundo_key")
      .eq("ativo", true);
    if (ignoredError) throw new Error(`Falha ao ler lista de fundos ignorados: ${ignoredError.message}`);
    const ignoredKeys = new Set((ignoredRows ?? []).map((row: { fundo_key: string }) => row.fundo_key));
    const fundosIncluidos = fundos.filter((fundo) => !ignoredKeys.has(fundo.fundo_key));
    if (fundosIncluidos.length === 0) {
      return response({ error: "Nenhum snapshot V2 pronto para a data selecionada" }, 409);
    }
    // A tela calcula a cobertura em consulta propria e envia a lista ao
    // backend para que a previa e o e-mail tenham exatamente o mesmo banner.
    const faltantesBase = body.fundosFaltantes?.length
      ? body.fundosFaltantes
      : await resolveCoverage(supabase, dataReferencia, new Set(fundosIncluidos.map((fundo) => fundo.fundo_key)));
    const faltantes = faltantesBase
      .filter((fundo) => !ignoredKeys.has(fundo.fundo_key));
    const statusCobertura = faltantes.length === 0 ? "completo" : "parcial";
    const { html, excelBase64, excelFilename } = await buildDetailedReport({
      supabase, fundos: fundosIncluidos, ativosMap, dataReferencia, faltantes,
    });
    const attachments = excelBase64.length <= MAX_ATTACHMENT_BASE64_CHARS
      ? [{ filename: excelFilename, content: excelBase64 }]
      : [];
    const dataFormatada = new Date(`${dataReferencia}T00:00:00`).toLocaleDateString("pt-BR");
    const subject = statusCobertura === "parcial"
      ? `Relatorio Diario de Rentabilidade - ${dataFormatada} (parcial - faltam ${faltantes.length} fundo(s))`
      : `Relatorio Diario de Rentabilidade - ${dataFormatada}`;
    const sendResult = await sendEmailViaSmtp({ to: emailDestinatarios, subject, html, attachments });
    const { error: logError } = await supabase.from("envios_relatorio_rentabilidade").insert({
      data_referencia: dataReferencia,
      destinatarios: emailDestinatarios,
      enviado_por: authData.user.id,
      email_id: sendResult.messageId,
      status: "enviado",
      origem: "manual",
      status_cobertura: statusCobertura,
      qtd_fundos: fundosIncluidos.length,
      qtd_faltantes: faltantes.length,
      fundos_incluidos: fundosIncluidos.map((fundo) => fundo.fundo_key).sort(),
    });
    if (logError) console.error("[send-rentabilidade-report] E-mail enviado, falha no log:", logError.message);
    return response({
      success: true,
      data_referencia: dataReferencia,
      qtd_fundos: fundosIncluidos.length,
      qtd_faltantes: faltantes.length,
      status_cobertura: statusCobertura,
      email_id: sendResult.messageId,
      log_warning: logError?.message ?? null,
    });
  } catch (error) {
    console.error("[send-rentabilidade-report] Erro:", error);
    return response({ error: "Erro ao enviar relatorio", details: error instanceof Error ? error.message : String(error) }, 500);
  }
});
