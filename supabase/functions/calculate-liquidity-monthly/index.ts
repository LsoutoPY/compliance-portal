import { calculateMonthlyFidc, type MonthlyMethodology } from "../_shared/liquidity-monthly.ts";
import { resolveLiquidityMethodology } from "../_shared/liquidity-methodology.ts";
import { ManualUploadAdapter } from "../_shared/liquidity-source-adapter.ts";
import { monthlyCors, monthlyError, requireRiskUser, serviceClient } from "../_shared/monthly-auth.ts";

async function hashInput(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: monthlyCors });
  if (req.method !== "POST") return monthlyError(new Error("Método não permitido."));
  let ingestLogId: string | null = null;
  const service = serviceClient();
  try {
    const userId = await requireRiskUser(req);
    const body = await req.json();
    const cnpj = String(body.cnpj ?? "").replace(/\D/g, "");
    const competencia = String(body.competencia ?? "");
    const methodologyCode = String(body.methodology_code ?? "cvpar_fidc_mensal");
    const methodologyVersion = String(body.methodology_version ?? "2026.2");
    if (!/^\d{14}$/.test(cnpj) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia)) {
      throw new Error("Informe CNPJ e competência AAAA-MM válidos.");
    }
    const { data: ingestLog, error: ingestLogError } = await service.from("ingest_runs")
      .insert({ dataset: "calculate_liquidity_monthly", competencia: `${competencia}-01`, source: "cvm", status: "running" })
      .select("id").single();
    if (ingestLogError || !ingestLog) throw ingestLogError ?? new Error("Falha ao criar log de cálculo.");
    ingestLogId = ingestLog.id;
    const { data: fund, error: fundError } = await service.from("funds")
      .select("id,short_name,min_subordination_index")
      .eq("cnpj_fundo_master", cnpj)
      .maybeSingle();
    if (fundError || !fund) throw new Error("Fundo não cadastrado em funds.");
    const { data: configured, error: configuredError } = await service.from("liquidity_monthly_methodologies")
      .select("code,version,configuration")
      .eq("code", methodologyCode)
      .eq("version", methodologyVersion)
      .eq("active", true)
      .maybeSingle();
    if (configuredError || !configured) throw new Error("Metodologia ativa não encontrada.");
    const settings = configured.configuration as Record<string, unknown>;
    const methodology: MonthlyMethodology = {
      code: configured.code,
      version: configured.version,
      creditExtraFields: Array.isArray(settings.creditExtraFields)
        ? settings.creditExtraFields.filter((value): value is string => typeof value === "string")
        : [],
      grossUpPdd: settings.grossUpPdd === true,
      includeMezzanineInSubordination: settings.includeMezzanineInSubordination === true,
    };
    const referenceMonth = `${competencia}-01`;
    const { data: filings, error: filingError } = await service.from("fund_monthly_cvm_filing")
      .select("id,tabela,payload,imported_at,registry_sync_log_id,source_sha256,source_storage_path,source_origin")
      .eq("cnpj", cnpj)
      .eq("competencia", referenceMonth);
    if (filingError) throw filingError;
    if (!filings?.length) throw new Error("Informe mensal ausente. Use Atualizar dados antes de calcular.");
    const lastDate = new Date(Date.UTC(Number(competencia.slice(0, 4)), Number(competencia.slice(5, 7)), 0))
      .toISOString().slice(0, 10);
    const { data: snapshots, error: positionError } = await service.from("liquidity_position_snapshots")
      .select("id,file_sha256,summary,reference_date,imported_at,file_name,imported_by")
      .eq("cnpj", cnpj)
      .gte("reference_date", referenceMonth)
      .lte("reference_date", lastDate)
      .order("reference_date", { ascending: false })
      .order("imported_at", { ascending: false })
      .limit(1);
    if (positionError) throw positionError;
    const snapshot = snapshots?.[0] ?? null;
    const { tables, position } = ManualUploadAdapter.fromRecords(filings, snapshot);
    const registered = resolveLiquidityMethodology(methodology.code, methodology.version);
    const result = registered
      ? registered.compute({ tables, referenceMonth, cnpj, position, minimumSubordination: fund.min_subordination_index }, methodology)
      : calculateMonthlyFidc(tables, referenceMonth, cnpj, methodology, position, fund.min_subordination_index);
    if (filings.some((filing) => !filing.source_sha256 || !filing.source_storage_path)) {
      result.gaps.unshift("Informe CVM legado sem ZIP original arquivado e hash de origem; reimporte a competência para fechar a trilha de auditoria.");
    }
    if (new Set(filings.map((filing) => filing.source_sha256).filter(Boolean)).size > 1) {
      result.gaps.unshift("Competência contém tabelas de ZIPs diferentes; reimporte o mês inteiro antes de validar o relatório.");
    }
    const sourceManifest = {
      cvm: filings.map((filing) => ({ id: filing.id, tabela: filing.tabela, imported_at: filing.imported_at,
        registry_sync_log_id: filing.registry_sync_log_id, source_sha256: filing.source_sha256,
        source_storage_path: filing.source_storage_path, source_origin: filing.source_origin }))
        .sort((a, b) => a.tabela.localeCompare(b.tabela)),
      position: snapshot ? { id: snapshot.id, reference_date: snapshot.reference_date, file_sha256: snapshot.file_sha256 } : null,
      methodology,
      minimum_subordination_index: fund.min_subordination_index,
    };
    const inputSha256 = await hashInput({
      methodology,
      minimumSubordination: fund.min_subordination_index,
      tables: Object.fromEntries(Object.keys(tables).sort().map((key) => [key, tables[key]])),
      position,
    });
    const { data: inserted, error: runError } = await service.from("liquidity_monthly_runs")
      .upsert({
        fund_id: fund.id,
        cnpj,
        reference_month: referenceMonth,
        methodology_code: methodology.code,
        methodology_version: methodology.version,
        input_sha256: inputSha256,
        source_manifest: sourceManifest,
        result,
        calculated_by: userId,
      }, { onConflict: "cnpj,reference_month,methodology_code,methodology_version,input_sha256", ignoreDuplicates: true })
      .select("id,calculated_at,result,source_manifest,input_sha256")
      .maybeSingle();
    if (runError) throw runError;
    let run = inserted;
    if (!run) {
      const existing = await service.from("liquidity_monthly_runs")
        .select("id,calculated_at,result,source_manifest,input_sha256")
        .eq("cnpj", cnpj)
        .eq("reference_month", referenceMonth)
        .eq("methodology_code", methodology.code)
        .eq("methodology_version", methodology.version)
        .eq("input_sha256", inputSha256)
        .single();
      if (existing.error) throw existing.error;
      run = existing.data;
    }
    const { error: logError } = await service.from("ingest_runs")
      .update({ rows_seen: filings.length, rows_upserted: 1, status: "ok", finished_at: new Date().toISOString() })
      .eq("id", ingestLogId);
    if (logError) throw logError;
    return new Response(JSON.stringify({ run }), {
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
