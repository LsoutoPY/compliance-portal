import { stockXml2026_1 } from "../_shared/liquidity-stock-xml-methodology.ts";
import type { StockReceivable, XmlPositionLine } from "../_shared/liquidity-stock-xml.ts";
import { monthlyCors, monthlyError, requireRiskUser, serviceClient } from "../_shared/monthly-auth.ts";

function digits(value: unknown): string { return String(value ?? "").replace(/\D/g, ""); }
async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: monthlyCors });
  if (req.method !== "POST") return monthlyError(new Error("Método não permitido."));
  const service = serviceClient();
  let ingestLogId: string | null = null;
  try {
    const userId = await requireRiskUser(req);
    const body = await req.json();
    const cnpj = digits(body.cnpj);
    const competencia = String(body.competencia ?? "");
    if (!/^\d{14}$/.test(cnpj) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia)) {
      throw new Error("Informe CNPJ e competência AAAA-MM válidos.");
    }
    const referenceDate = new Date(Date.UTC(Number(competencia.slice(0, 4)), Number(competencia.slice(5, 7)), 0))
      .toISOString().slice(0, 10);
    const referenceMonth = `${competencia}-01`;
    const { data: fund, error: fundError } = await service.from("funds")
      .select("id,short_name,cnpj_fundo_master").eq("cnpj_fundo_master", cnpj).maybeSingle();
    if (fundError || !fund) throw new Error("Fundo não cadastrado.");
    if (!stockXml2026_1.appliesTo({ cnpj })) throw new Error("Metodologia não se aplica a este fundo.");
    const { data: method, error: methodError } = await service.from("liquidity_monthly_methodologies")
      .select("code,version").eq("code", stockXml2026_1.id).eq("version", stockXml2026_1.version)
      .eq("active", true).maybeSingle();
    if (methodError || !method) throw new Error("Metodologia de estoque + XML não instalada ou inativa.");
    const { data: log, error: logError } = await service.from("ingest_runs")
      .insert({ dataset: "calculate_liquidity_stock_xml", competencia: referenceMonth, source: "csv", status: "running" })
      .select("id").single();
    if (logError || !log) throw logError ?? new Error("Falha ao criar log de cálculo.");
    ingestLogId = log.id;

    const { data: imports, error: importError } = await service.from("importacoes_estoque_fidc")
      .select("id,file_name,reference_date,fund_document,imported_rows,created_at,status")
      .eq("reference_date", referenceDate).eq("status", "success")
      .order("created_at", { ascending: false }).limit(1000);
    if (importError) throw importError;
    if (imports?.length === 1000) throw new Error("Há muitas importações na data-base; seleção automática insegura.");
    const stockImport = imports?.find((entry) => digits(entry.fund_document) === cnpj);
    if (!stockImport) throw new Error("Estoque concluído do fundo e da data-base não encontrado.");
    const stockWithIds: Array<Record<string, unknown>> = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await service.from("estoque_fidc")
        .select("id,doc_fundo,doc_sacado,doc_cedente,data_referencia,data_vencimento_ajustada,situacao_recebivel,tipo_recebivel,valor_presente,valor_pdd,valor_aquisicao,taxa_cessao")
        .eq("import_id", stockImport.id).order("id").range(offset, offset + 999);
      if (error) throw error;
      stockWithIds.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
    const stock = stockWithIds.map(({ id: _id, ...row }) => row) as unknown as StockReceivable[];
    const { data: lastXml, error: lastXmlError } = await service.from("posicao_carteira")
      .select("arquivo_nome,created_at").eq("fundo_cnpj", cnpj)
      .eq("fundo_dtposicao", referenceDate.replace(/-/g, ""))
      .order("created_at", { ascending: false }).order("arquivo_nome", { ascending: false }).limit(1);
    if (lastXmlError) throw lastXmlError;
    const xmlFileName = lastXml?.[0]?.arquivo_nome;
    if (!xmlFileName) throw new Error("XML da posição não encontrado para fundo e data-base.");
    const { data: xmlWithIds, error: xmlError } = await service.from("posicao_carteira")
      .select("id,fundo_cnpj,fundo_dtposicao,fundo_isin,fundo_nome,section,cnpjfundo,fundo_patliq,txadm,saldo,valor_padrao")
      .eq("fundo_cnpj", cnpj).eq("fundo_dtposicao", referenceDate.replace(/-/g, ""))
      .eq("arquivo_nome", xmlFileName).order("id").limit(1000);
    if (xmlError) throw xmlError;
    if (xmlWithIds?.length === 1000) throw new Error("XML excede o limite de 999 linhas para seleção segura.");
    const xml = (xmlWithIds ?? []).map(({ id: _id, ...row }) => row) as XmlPositionLine[];
    const inputs = { cnpj, referenceDate, stockImport: { id: stockImport.id,
      fileName: stockImport.file_name, importedRows: stockImport.imported_rows }, xmlFileName, stock, xml };
    const errors = stockXml2026_1.validate(inputs);
    if (errors.length) throw new Error(errors.join(" "));
    const result = stockXml2026_1.compute(inputs, undefined);
    const normalizedStockSha256 = await sha256(stockWithIds);
    const normalizedXmlSha256 = await sha256(xmlWithIds);
    const inputSha256 = await sha256({ methodology: result.methodology, stockImportId: stockImport.id,
      normalizedStockSha256, xmlFileName, normalizedXmlSha256 });
    const sourceManifest = { methodology: result.methodology, source: "estoque_xml",
      stock: { import_id: stockImport.id, file_name: stockImport.file_name, reference_date: referenceDate,
        imported_rows: stockImport.imported_rows, normalized_sha256: normalizedStockSha256,
        original_file_sha256: null },
      xml: { file_name: xmlFileName, reference_date: referenceDate, rows: xml.length,
        normalized_sha256: normalizedXmlSha256 } };
    const { data: inserted, error: runError } = await service.from("liquidity_monthly_runs")
      .upsert({ fund_id: fund.id, cnpj, reference_month: referenceMonth,
        methodology_code: stockXml2026_1.id, methodology_version: stockXml2026_1.version,
        input_sha256: inputSha256, source_manifest: sourceManifest, result, calculated_by: userId },
      { onConflict: "cnpj,reference_month,methodology_code,methodology_version,input_sha256", ignoreDuplicates: true })
      .select("id,calculated_at,result,source_manifest,input_sha256").maybeSingle();
    if (runError) throw runError;
    let run = inserted;
    if (!run) {
      const existing = await service.from("liquidity_monthly_runs")
        .select("id,calculated_at,result,source_manifest,input_sha256")
        .eq("cnpj", cnpj).eq("reference_month", referenceMonth)
        .eq("methodology_code", stockXml2026_1.id).eq("methodology_version", stockXml2026_1.version)
        .eq("input_sha256", inputSha256).single();
      if (existing.error) throw existing.error;
      run = existing.data;
    }
    const { error: finishError } = await service.from("ingest_runs")
      .update({ rows_seen: stock.length + xml.length, rows_upserted: 1, status: "ok", finished_at: new Date().toISOString() })
      .eq("id", ingestLogId);
    if (finishError) throw finishError;
    return new Response(JSON.stringify({ run }), { headers: { ...monthlyCors, "Content-Type": "application/json" } });
  } catch (error) {
    if (ingestLogId) await service.from("ingest_runs")
      .update({ status: "error", error_message: String(error), finished_at: new Date().toISOString() })
      .eq("id", ingestLogId);
    return monthlyError(error);
  }
});
