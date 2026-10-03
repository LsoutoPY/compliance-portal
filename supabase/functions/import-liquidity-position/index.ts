import { parseCvparPositionCsv } from "../_shared/cvpar-position-csv.ts";
import { monthlyCors, monthlyError, requireRiskUser, serviceClient } from "../_shared/monthly-auth.ts";

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: monthlyCors });
  if (req.method !== "POST") return monthlyError(new Error("Método não permitido."));
  let ingestLogId: string | null = null;
  const service = serviceClient();
  try {
    const userId = await requireRiskUser(req);
    const { data: ingestLog, error: ingestLogError } = await service.from("ingest_runs")
      .insert({ dataset: "cvpar_carteira_diaria_csv", source: "csv", status: "running" })
      .select("id").single();
    if (ingestLogError || !ingestLog) throw ingestLogError ?? new Error("Falha ao criar log de ingestão.");
    ingestLogId = ingestLog.id;
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".csv")) {
      throw new Error("Envie a Carteira Diária em CSV.");
    }
    if (file.size > 5_000_000) throw new Error("CSV acima do limite de 5 MB.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder("windows-1252").decode(bytes);
    const summary = parseCvparPositionCsv(text, file.name);
    const { data: fund, error: fundError } = await service.from("funds")
      .select("id")
      .eq("cnpj_fundo_master", summary.cnpj)
      .maybeSingle();
    if (fundError || !fund) throw new Error("CNPJ da carteira não está cadastrado em funds.");
    const fileHash = await sha256(bytes);
    const storagePath = `${summary.cnpj}/${summary.referenceDate}/${fileHash}.csv`;
    const { error: storageError } = await service.storage.from("liquidity-position-source")
      .upload(storagePath, bytes, { contentType: "text/csv", upsert: true });
    if (storageError) throw storageError;
    const { data, error } = await service.from("liquidity_position_snapshots")
      .upsert({
        cnpj: summary.cnpj,
        reference_date: summary.referenceDate,
        file_name: file.name,
        file_sha256: fileHash,
        storage_path: storagePath,
        summary,
        imported_by: userId,
      }, { onConflict: "cnpj,reference_date,file_sha256" })
      .select("id,cnpj,reference_date,file_sha256,summary")
      .single();
    if (error) throw error;
    const { error: logError } = await service.from("ingest_runs")
      .update({ competencia: summary.referenceDate, rows_seen: 1, rows_upserted: 1, status: "ok", finished_at: new Date().toISOString() })
      .eq("id", ingestLogId);
    if (logError) throw logError;
    return new Response(JSON.stringify({ snapshot: data }), {
      headers: { ...monthlyCors, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (ingestLogId) {
      await service.from("ingest_runs")
        .update({ status: "error", error_message: String(error), finished_at: new Date().toISOString() })
        .eq("id", ingestLogId);
    }
    return monthlyError(error);
  }
});
