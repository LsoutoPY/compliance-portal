// Importação dedicada ao módulo mensal; preserva o endpoint legado do Frame.
// Baixa o Informe Mensal de FIDC da CVM, filtra por funds.cnpj_fundo_master
// e grava em fund_monthly_cvm_filing. payload = array de linhas da tabela.
//
// Recebe um token de usuário de Risco; nunca aceita service_role no frontend.

import { createClient } from "npm:@supabase/supabase-js@2";
import JSZip from "npm:jszip@3.10.1";
import { withCors } from "../_shared/cors.ts";
import { groupCvmMonthlyZipEntries, normalizeCnpj } from "../_shared/cvm-monthly-csv.ts";
import { requireRiskUser } from "../_shared/monthly-auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(withCors(async (req) => {
  let syncLogId: string | null = null;
  let ingestLogId: string | null = null;
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  try {
    await requireRiskUser(req);
    const multipart = req.headers.get("content-type")?.includes("multipart/form-data") ?? false;
    const form = multipart ? await req.formData() : null;
    const input = multipart ? null : await req.json();
    const competencia = String(form?.get("competencia") ?? input?.competencia ?? "");
    const uploadedFile = form?.get("file");
    if (!/^\d{4}-\d{2}$/.test(competencia)) {
      return new Response(JSON.stringify({ error: "competencia deve ser AAAA-MM" }), { status: 400 });
    }
    if (multipart && (!(uploadedFile instanceof File) || !uploadedFile.name.toLowerCase().endsWith(".zip") || uploadedFile.size > 15_000_000)) {
      return new Response(JSON.stringify({ error: "Envie um ZIP FIDC de até 15 MB." }), { status: 400 });
    }
    const yyyymm = competencia.replace("-", "");

    const { data: fundsRows, error: fundsErr } = await supabase
      .from("funds")
      .select("id, short_name, cnpj_fundo_master")
      .not("cnpj_fundo_master", "is", null);
    if (fundsErr) throw fundsErr;
    const cnpjSet = new Set(
      (fundsRows ?? []).map((f) => normalizeCnpj(f.cnpj_fundo_master as string)).filter(Boolean) as string[],
    );

    const url =
      `https://dados.cvm.gov.br/dados/FIDC/DOC/INF_MENSAL/DADOS/inf_mensal_fidc_${yyyymm}.zip`;
    const sourceOrigin = uploadedFile instanceof File ? `upload:${uploadedFile.name}` : url;
    const { data: syncLog, error: syncLogError } = await supabase
      .from("registry_sync_log")
      .insert({ dataset: "cvm_inf_mensal_fidc", source_url: sourceOrigin, status: "running" })
      .select()
      .single();
    if (syncLogError || !syncLog) throw syncLogError ?? new Error("Falha ao criar log de importação.");
    syncLogId = syncLog.id;
    const { data: ingestLog, error: ingestLogError } = await supabase.from("ingest_runs")
      .insert({ dataset: "cvm_informe_mensal_fidc", competencia: `${competencia}-01`, source: "cvm", status: "running" })
      .select("id").single();
    if (ingestLogError || !ingestLog) throw ingestLogError ?? new Error("Falha ao criar log de ingestão.");
    ingestLogId = ingestLog.id;
    let zipBytes: Uint8Array;
    if (uploadedFile instanceof File) {
      zipBytes = new Uint8Array(await uploadedFile.arrayBuffer());
    } else {
      const zipResp = await fetch(url);
      if (!zipResp.ok) throw new Error(`Falha ao baixar ${url}: HTTP ${zipResp.status}`);
      zipBytes = new Uint8Array(await zipResp.arrayBuffer());
    }
    if (zipBytes.byteLength > 50_000_000) throw new Error("ZIP mensal acima do limite de 50 MB.");
    const sourceSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(zipBytes).buffer))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const sourceStoragePath = `${yyyymm}/${sourceSha256}.zip`;
    const { error: storageError } = await supabase.storage.from("cvm-fidc-monthly-source")
      .upload(sourceStoragePath, zipBytes, { contentType: "application/zip", upsert: true });
    if (storageError) throw storageError;
    const { error: sourceLogError } = await supabase.from("registry_sync_log")
      .update({ source_url: `storage://cvm-fidc-monthly-source/${sourceStoragePath}` }).eq("id", syncLogId);
    if (sourceLogError) throw sourceLogError;
    const zip = await JSZip.loadAsync(zipBytes);

    const { tablesByCnpj, rowsSeen } = await groupCvmMonthlyZipEntries(zip.files, competencia, cnpjSet);
    const upsertBatch = Object.entries(tablesByCnpj).flatMap(([cnpj, tables]) =>
      Object.entries(tables).map(([tabela, payload]) => ({
        cnpj, competencia: `${competencia}-01`, tabela, payload,
        imported_at: new Date().toISOString(), registry_sync_log_id: syncLogId,
        source_sha256: sourceSha256, source_storage_path: sourceStoragePath, source_origin: sourceOrigin,
      }))
    );
    if (!upsertBatch.length) throw new Error("Nenhum fundo cadastrado foi encontrado no ZIP mensal.");
    await supabase.from("registry_sync_log").update({ rows_seen: rowsSeen }).eq("id", syncLogId);

    const { data: rowsUpserted, error: importError } = await supabase.rpc(
      "upsert_cvm_monthly_filing", {
        p_rows: upsertBatch, p_competencia: `${competencia}-01`, p_cnpjs: [...cnpjSet],
      },
    );
    if (importError) throw importError;

    const { error: finishError } = await supabase
      .from("registry_sync_log")
      .update({
        rows_upserted: rowsUpserted ?? 0,
        status: "ok",
        finished_at: new Date().toISOString(),
      })
      .eq("id", syncLogId);
    if (finishError) throw finishError;
    const { error: ingestFinishError } = await supabase.from("ingest_runs")
      .update({ rows_seen: rowsSeen, rows_upserted: rowsUpserted ?? 0, status: "ok", finished_at: new Date().toISOString() })
      .eq("id", ingestLogId);
    if (ingestFinishError) throw ingestFinishError;

    return new Response(
      JSON.stringify({
        competencia,
        rows_seen: rowsSeen,
        groups_upserted: rowsUpserted ?? 0,
        cnpjs_imported: Object.keys(tablesByCnpj).sort(),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    if (syncLogId) {
      await supabase.from("registry_sync_log")
        .update({ status: "error", error_message: String(err), finished_at: new Date().toISOString() })
        .eq("id", syncLogId);
    }
    if (ingestLogId) {
      await supabase.from("ingest_runs")
        .update({ status: "error", error_message: String(err), finished_at: new Date().toISOString() })
        .eq("id", ingestLogId);
    }
    const message = err instanceof Error ? err.message : String(err);
    const status = message === "AUTH_REQUIRED" ? 401 : message === "RISK_ROLE_REQUIRED" ? 403 : 500;
    return new Response(JSON.stringify({ error: message }), { status });
  }
}));
