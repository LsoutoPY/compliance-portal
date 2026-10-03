// Baixa o Informe Diário de Fundos (CVM), filtra pelos CNPJs em funds,
// e upserta em fund_daily_cvm.
//
// O ZIP mensal tem todos os FI do Brasil — processa em streaming para
// não estourar a memória da Edge Function.

import { createClient } from "npm:@supabase/supabase-js@2";
import { withCors } from "../_shared/cors.ts";
import { forEachZipCsvRow } from "../_shared/streamCvmZip.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function normalizeCnpj(v: string | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

function toNum(v: string | undefined): number | null {
  if (!v || v.trim() === "") return null;
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function toDate(v: string | undefined): string | null {
  if (!v || v.trim() === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(v.trim())) {
    const [d, m, y] = v.trim().split("/");
    return `${y}-${m}-${d}`;
  }
  return null;
}

Deno.serve(withCors(async (req) => {
  try {
    const { competencia } = await req.json();
    if (!/^\d{4}-\d{2}$/.test(competencia)) {
      return Response.json({ error: "competencia deve ser AAAA-MM" }, { status: 400 });
    }
    const [ano, mes] = competencia.split("-");
    const url = `https://dados.cvm.gov.br/dados/FI/DOC/INF_DIARIO/DADOS/inf_diario_fi_${ano}${mes}.zip`;

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const runId = crypto.randomUUID();
    await supabase.from("ingest_runs").insert({
      id: runId,
      dataset: "cvm_informe_diario",
      competencia: `${competencia}-01`,
      source: "cvm",
      status: "running",
    });

    const { data: fundsData, error: fundsErr } = await supabase
      .from("funds")
      .select("cnpj_fundo_master")
      .not("cnpj_fundo_master", "is", null);
    if (fundsErr) throw fundsErr;
    const allowedCnpjs = new Set(
      (fundsData ?? []).map((f: { cnpj_fundo_master: string }) => normalizeCnpj(f.cnpj_fundo_master)),
    );

    const resp = await fetch(url, {
      headers: { "User-Agent": "risco-cvpar-portal/1.0" },
    });
    if (!resp.ok) throw new Error(`fetch ${url} => ${resp.status}`);

    let rowsSeen = 0;
    let upserted = 0;
    let batch: Record<string, unknown>[] = [];

    async function flush() {
      if (batch.length === 0) return;
      const { error } = await supabase
        .from("fund_daily_cvm")
        .upsert(batch, { onConflict: "cnpj,data" });
      if (error) throw error;
      upserted += batch.length;
      batch = [];
    }

    await forEachZipCsvRow(resp, async (r) => {
      rowsSeen += 1;
      const cnpj = normalizeCnpj(r["CNPJ_FUNDO"] || r["CNPJ_FUNDO_CLASSE"]);
      if (!allowedCnpjs.has(cnpj)) return;
      const data = toDate(r["DT_COMPTC"]);
      if (!cnpj || !data) return;
      batch.push({
        cnpj,
        data,
        pl: toNum(r["VL_PATRIM_LIQ"]),
        valor_cota: toNum(r["VL_QUOTA"]),
        captacao_dia: toNum(r["CAPTC_DIA"]),
        resgate_dia: toNum(r["RESG_DIA"]),
        nr_cotistas: r["NR_COTST"] ? parseInt(r["NR_COTST"], 10) : null,
        imported_at: new Date().toISOString(),
      });
      if (batch.length >= 200) await flush();
    });
    await flush();

    await supabase.from("ingest_runs").update({
      status: "ok",
      rows_seen: rowsSeen,
      rows_upserted: upserted,
      finished_at: new Date().toISOString(),
    }).eq("id", runId);

    return Response.json({ ok: true, rows_seen: rowsSeen, rows_upserted: upserted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}));
