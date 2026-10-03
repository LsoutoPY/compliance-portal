/**
 * Envio automatico do relatorio de rentabilidade.
 *
 * Esta funcao nao calcula rentabilidade. Ela somente le o snapshot V2 ja
 * persistido, monta o mesmo HTML/Excel e envia. O worker incremental e a
 * unica parte autorizada a ler posicao_carteira para calcular retornos.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import type { FundoXmlCoverageRow } from "./calc.ts";
import { buildDetailedReport } from "./buildDetailedReport.ts";
import { getSmtpConfig, MAX_ATTACHMENT_BASE64_CHARS, sendEmailViaSmtp, smtpConfigError } from "./smtp.ts";
import { fetchSnapshotReportData } from "./snapshotReportData.ts";
import {
  addDaysIso,
  chooseAutomaticProcessingDate,
  resolveProximaDataReferencia,
  selectPartialRetryCandidate,
  shouldSkipAutoSend,
  type EnvioLogRow,
} from "./scheduling.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_MIN_FUNDOS_PARCIAL = 25;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RequestBody {
  origem?: "auto" | "manual";
  data_referencia?: string;
  retry_parcial?: boolean;
  dry_run?: boolean;
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function todayIsoBRT() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function normalizeCnpj(value: string | null | undefined) {
  return value?.replace(/\D/g, "") ?? "";
}

function fundKey(cnpj: string | null | undefined, isin: string | null | undefined) {
  const normalizedIsin = isin?.trim().toUpperCase();
  return normalizedIsin ? `${normalizeCnpj(cnpj)}|ISIN:${normalizedIsin}` : normalizeCnpj(cnpj);
}

async function fetchNextAvailableDateAfter(
  supabase: ReturnType<typeof createClient>,
  afterDateIso: string,
  hojeIso: string,
): Promise<string | null> {
  let cursor = addDaysIso(afterDateIso, 1);
  for (let steps = 0; cursor <= hojeIso && steps < 90; steps++) {
    const { data, error } = await supabase.rpc("get_pares_fundo_monitorado", {
      p_dtposicao: cursor.replace(/-/g, ""),
    });
    if (!error && data?.length) return cursor;
    cursor = addDaysIso(cursor, 1);
  }
  return null;
}

interface ParFundoXml {
  fundo_cnpj: string;
  fundo_isin: string | null;
  nome_fundo: string | null;
}

async function fetchParesComXml(
  supabase: ReturnType<typeof createClient>,
  dataReferencia: string,
): Promise<ParFundoXml[]> {
  const { data, error } = await supabase.rpc("get_pares_fundo_monitorado", {
    p_dtposicao: dataReferencia.replace(/-/g, ""),
  });
  if (error) throw new Error(`Falha ao ler classes XML monitoradas: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((pair) => ({
      fundo_cnpj: normalizeCnpj(String(pair.fundo_cnpj ?? "")),
      fundo_isin: pair.fundo_isin ? String(pair.fundo_isin).trim().toUpperCase() : null,
      nome_fundo: pair.nome_fundo ? String(pair.nome_fundo) : null,
    }))
    .filter((pair) => Boolean(pair.fundo_cnpj));
}

async function fetchFundosSemXml(
  supabase: ReturnType<typeof createClient>,
  dataReferencia: string,
  paresComXml: ParFundoXml[],
): Promise<FundoXmlCoverageRow[]> {
  const { data, error } = await supabase.rpc("get_rentabilidade_xml_coverage_v2", {
    p_data_referencia: dataReferencia,
    p_janela_dias: 10,
  });
  if (error) throw new Error(`Falha ao ler cobertura XML V2: ${error.message}`);
  const paresKeys = new Set(paresComXml.map((pair) => fundKey(pair.fundo_cnpj, pair.fundo_isin)));
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((fundo) => !paresKeys.has(fundKey(String(fundo.fundo_cnpj ?? ""), fundo.fundo_isin ? String(fundo.fundo_isin) : null)))
    .map((fundo) => ({
      fundo_key: fundKey(String(fundo.fundo_cnpj ?? ""), fundo.fundo_isin ? String(fundo.fundo_isin) : null),
      nome_fundo: String(fundo.nome_fundo ?? fundo.fundo_cnpj ?? "Sem nome"),
      cnpj_fundo: normalizeCnpj(String(fundo.fundo_cnpj ?? "")),
      fundo_isin: fundo.fundo_isin ? String(fundo.fundo_isin) : null,
      ultima_data_iso: String(fundo.ultima_data_iso ?? dataReferencia),
      administrador: "",
    }));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Metodo nao permitido" }, 405);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    const body: RequestBody = await req.json().catch(() => ({}));
    const origem = body.origem === "manual" ? "manual" : "auto";
    let retryParcial = body.retry_parcial === true;
    const authHeader = req.headers.get("Authorization");
    const isServiceRoleRequest = authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
    if (body.dry_run && !isServiceRoleRequest) return jsonResponse({ error: "Dry-run restrito ao service_role" }, 401);

    let userId: string | null = null;
    if (origem === "manual") {
      if (!authHeader) return jsonResponse({ error: "Nao autorizado" }, 401);
      const { data: authData, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
      if (authError || !authData.user) return jsonResponse({ error: "Nao autorizado" }, 401);
      userId = authData.user.id;
    }

    const hoje = todayIsoBRT();
    let dataReferencia = body.data_referencia?.trim() || "";
    if (!dataReferencia && origem === "auto") {
      const { data: enviosLog, error } = await supabase
        .from("envios_relatorio_rentabilidade")
        .select("data_referencia, origem, status, status_cobertura, fundos_incluidos, created_at");
      if (error) throw new Error(`Erro ao buscar historico de envios: ${error.message}`);
      const automaticEnviosLog = (enviosLog ?? []) as EnvioLogRow[];
      const resolved = resolveProximaDataReferencia(automaticEnviosLog, hoje);
      const nextAvailable = resolved.data ?? await fetchNextAvailableDateAfter(supabase, resolved.lastClosed ?? "2026-01-01", hoje);
      const selected = chooseAutomaticProcessingDate(nextAvailable, selectPartialRetryCandidate(automaticEnviosLog, hoje));
      if (!selected.data) return jsonResponse({ success: true, skipped: true, motivo: resolved.motivo ?? "sem_proxima_data_disponivel", hoje, lastClosed: resolved.lastClosed });
      dataReferencia = selected.data;
      retryParcial = selected.retryParcial;
    }
    if (!dataReferencia) dataReferencia = hoje;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataReferencia)) return jsonResponse({ error: "data_referencia invalida" }, 422);

    const paresComXml = await fetchParesComXml(supabase, dataReferencia);
    const { error: reconcileError } = await supabase.rpc("reconcile_rentabilidade_snapshot_v2_queue", {
      p_data_referencia: dataReferencia,
      p_limit: 500,
    });
    if (reconcileError) throw new Error(`Falha ao reconciliar fila V2: ${reconcileError.message}`);
    const { error: finalizeError } = await supabase.rpc("finalize_rentabilidade_snapshot_v2_queue_from_snapshot", {
      p_data_referencia: dataReferencia,
    });
    if (finalizeError) throw new Error(`Falha ao finalizar fila V2: ${finalizeError.message}`);
    const [snapshotData, queueData] = await Promise.all([
      fetchSnapshotReportData(supabase, dataReferencia),
      supabase
        .from("rentabilidade_snapshot_reprocess_item_v2")
        .select("fundo_cnpj, fundo_isin, status")
        .eq("data_referencia", dataReferencia)
        .in("status", ["pending", "running"]),
    ]);
    if (queueData.error) throw new Error(`Falha ao ler fila V2: ${queueData.error.message}`);
    const { fundos, ativosMap } = snapshotData;
    const fundosIncluidos = fundos.map((fundo) => fundo.fundo_key).sort();
    const snapshotKeys = new Set(fundosIncluidos);
    const queueKeys = new Set(
      (queueData.data ?? []).map((item: { fundo_cnpj: string; fundo_isin: string | null }) => fundKey(item.fundo_cnpj, item.fundo_isin)),
    );
    const calculosPendentes = paresComXml.filter((pair) => {
      const key = fundKey(pair.fundo_cnpj, pair.fundo_isin);
      return !snapshotKeys.has(key) || queueKeys.has(key);
    });
    if (calculosPendentes.length > 0) {
      return jsonResponse({
        success: true,
        skipped: true,
        motivo: "aguardando_snapshots_v2",
        data_referencia: dataReferencia,
        qtd_calculos_pendentes: calculosPendentes.length,
        fundos_pendentes: calculosPendentes.slice(0, 10).map((pair) => pair.nome_fundo ?? pair.fundo_cnpj),
      });
    }
    const faltantes = await fetchFundosSemXml(supabase, dataReferencia, paresComXml);
    const statusCobertura = faltantes.length === 0 ? "completo" : "parcial";

    if (fundos.length === 0) {
      if (retryParcial) await supabase.from("envios_relatorio_rentabilidade").insert({
        data_referencia: dataReferencia, destinatarios: [], status: "agendado", origem: "auto", status_cobertura: "parcial",
        erro_mensagem: "Aguardando calculo dos snapshots V2", qtd_fundos: 0, qtd_faltantes: faltantes.length, fundos_incluidos: [],
      });
      return jsonResponse({ success: true, skipped: true, motivo: "aguardando_snapshots_v2", data_referencia: dataReferencia, qtd_faltantes: faltantes.length });
    }

    let minFundosParcial = DEFAULT_MIN_FUNDOS_PARCIAL;
    if (origem === "auto" && statusCobertura === "parcial") {
      const { data: config, error: configError } = await supabase
        .from("rentabilidade_cron_config")
        .select("min_fundos_parcial")
        .eq("id", 1)
        .maybeSingle();
      if (configError) throw new Error(`Falha ao ler mínimo de fundos para envio parcial: ${configError.message}`);
      const configuredMinimum = Number(config?.min_fundos_parcial);
      if (Number.isInteger(configuredMinimum) && configuredMinimum >= 1) minFundosParcial = configuredMinimum;

      if (fundos.length < minFundosParcial) {
        const motivo = `Aguardando mínimo para envio parcial: ${fundos.length}/${minFundosParcial} fundo(s) com snapshot V2 pronto.`;
        if (!body.dry_run) {
          const { error: auditError } = await supabase.from("envios_relatorio_rentabilidade").insert({
            data_referencia: dataReferencia,
            destinatarios: [],
            status: "agendado",
            origem: "auto",
            status_cobertura: "parcial",
            erro_mensagem: motivo,
            qtd_fundos: fundos.length,
            qtd_faltantes: faltantes.length,
            fundos_incluidos: fundosIncluidos,
          });
          if (auditError) console.error("[send-rentabilidade-report-auto] Falha ao auditar envio adiado:", auditError.message);
        }
        return jsonResponse({
          success: true,
          skipped: true,
          motivo: "aguardando_minimo_fundos",
          data_referencia: dataReferencia,
          qtd_fundos: fundos.length,
          qtd_faltantes: faltantes.length,
          min_fundos_parcial: minFundosParcial,
          details: motivo,
        });
      }
    }

    if (body.dry_run) return jsonResponse({
      success: true, dry_run: true, data_referencia: dataReferencia, retry_parcial: retryParcial,
      qtd_fundos: fundos.length, qtd_ativos: [...ativosMap.values()].reduce((total, ativos) => total + ativos.length, 0),
      qtd_faltantes: faltantes.length, status_cobertura: statusCobertura,
    });

    if (!getSmtpConfig()) return jsonResponse({ error: smtpConfigError() }, 500);
    if (origem === "auto") {
      const { data: ultimoAuto } = await supabase
        .from("envios_relatorio_rentabilidade")
        .select("status_cobertura, fundos_incluidos, qtd_faltantes")
        .eq("data_referencia", dataReferencia).eq("origem", "auto").eq("status", "enviado")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const dedup = shouldSkipAutoSend(ultimoAuto as EnvioLogRow | null, fundosIncluidos, statusCobertura, faltantes.length);
      if (dedup.skip) {
        // Registra a verificação para que a próxima execução possa rotacionar
        // para outra data parcial, em vez de selecionar sempre a mesma.
        const { error: auditError } = await supabase.from("envios_relatorio_rentabilidade").insert({
          data_referencia: dataReferencia,
          destinatarios: [],
          status: "agendado",
          origem: "auto",
          status_cobertura: statusCobertura,
          erro_mensagem: dedup.motivo ?? "Sem mudança desde o último envio",
          qtd_fundos: fundos.length,
          qtd_faltantes: faltantes.length,
          fundos_incluidos: fundosIncluidos,
        });
        if (auditError) console.error("[send-rentabilidade-report-auto] Falha ao auditar deduplicação:", auditError.message);
        return jsonResponse({ success: true, skipped: true, motivo: dedup.motivo, data_referencia: dataReferencia, qtd_fundos: fundos.length, qtd_faltantes: faltantes.length, status_cobertura: statusCobertura });
      }
    }

    const { data: destRows } = await supabase.from("email_destinatarios").select("email").eq("tipo", "rentabilidade").eq("ativo", true);
    const destinatarios = (destRows ?? []).map((row: { email: string }) => row.email).filter(Boolean);
    if (destinatarios.length === 0) return jsonResponse({ error: "Nenhum destinatario cadastrado para Rentabilidade" }, 422);

    const { html, excelBase64, excelFilename } = await buildDetailedReport({ supabase, fundos, dataReferencia, ativosMap, faltantes });
    const dataFormatada = new Date(`${dataReferencia}T00:00:00`).toLocaleDateString("pt-BR");
    const subject = statusCobertura === "parcial"
      ? `Relatorio Diario de Rentabilidade - ${dataFormatada} (parcial - faltam ${faltantes.length} fundo(s))`
      : `Relatorio Diario de Rentabilidade - ${dataFormatada}`;
    const attachments = excelBase64.length <= MAX_ATTACHMENT_BASE64_CHARS ? [{ filename: excelFilename, content: excelBase64 }] : [];
    const sent = await sendEmailViaSmtp({ to: destinatarios, subject, html, attachments });
    await supabase.from("envios_relatorio_rentabilidade").insert({
      data_referencia: dataReferencia, destinatarios, enviado_por: userId, email_id: sent.messageId, status: "enviado", origem,
      status_cobertura: statusCobertura, qtd_fundos: fundos.length, qtd_faltantes: faltantes.length, fundos_incluidos: fundosIncluidos,
    });
    return jsonResponse({ success: true, data_referencia: dataReferencia, qtd_fundos: fundos.length, qtd_faltantes: faltantes.length, status_cobertura: statusCobertura, destinatarios: destinatarios.length, email_id: sent.messageId });
  } catch (error) {
    console.error("[send-rentabilidade-report-auto] Erro:", error);
    return jsonResponse({ error: "Erro ao enviar relatorio automatico", details: error instanceof Error ? error.message : String(error) }, 500);
  }
});
