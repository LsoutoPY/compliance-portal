// Baixa o zip RCVM175 (registro de fundos/classes/subclasses) da CVM,
// extrai os CSVs e upserta em fund_master.
//
// curl -X POST https://<project>.supabase.co/functions/v1/import-cvm-registro \
//   -H "Authorization: Bearer <service_role>"

import { createClient } from "npm:@supabase/supabase-js@2";
import JSZip from "npm:jszip@3.10.1";
import { withCors } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Datasets RCVM175 disponíveis no portal CVM
const DATASETS = [
  {
    fonte: "cvm_registro_classe" as const,
    tipo: "fundo" as const,
    url: "https://dados.cvm.gov.br/dados/FI/CAD/DADOS/registro_fundo_classe.zip",
    idCol: "CD_FUNDO",
    cnpjCol: "CNPJ_FUNDO",
    denomCol: "DENOM_SOCIAL",
    nomeComercialCol: "NOME_COMERCIAL",
    tipoFundoCol: "TP_FUNDO",
    classeAnbimaCol: "CLASSE_ANBIMA",
    situacaoCol: "SIT",
    dataRegCol: "DT_REG",
    dataInicioCol: "DT_INI_ATIV",
    dataCancelCol: "DT_CANCEL",
    adminCnpjCol: "CNPJ_ADMIN",
    adminNomeCol: "ADMIN",
    gestorCnpjCol: "CNPJ_GESTOR",
    gestorNomeCol: "GESTOR",
    custodianteCol: "CUSTODIANTE",
    auditorCol: "AUDITOR",
    publicoAlvoCol: "PUBLICO_ALVO",
    condominioCol: "CONDOMINIO",
    plCol: "VL_PATRIM_LIQ",
    plDataCol: "DT_PATRIM_LIQ",
  },
];

const CADFI_URL =
  "https://dados.cvm.gov.br/dados/FI/CAD/DADOS/cad_fi.csv";

function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder("iso-8859-1").decode(bytes);
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(";");
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(";");
    const row: Record<string, string> = {};
    header.forEach((h, idx) => (row[h.trim()] = cols[idx]?.trim() ?? ""));
    rows.push(row);
  }
  return rows;
}

function normalizeCnpj(v: string | undefined): string | null {
  if (!v) return null;
  const d = v.replace(/\D/g, "");
  if (d.length === 14) return d;
  return d.length > 0 ? d : null;
}

function toNum(v: string | undefined): number | null {
  if (!v || v.trim() === "") return null;
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function toDate(v: string | undefined): string | null {
  if (!v || v.trim() === "") return null;
  // CVM format: DD/MM/YYYY or YYYY-MM-DD
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(v.trim())) {
    const [d, m, y] = v.trim().split("/");
    return `${y}-${m}-${d}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(v.trim())) return v.trim().slice(0, 10);
  return null;
}

async function fetchZipCsv(url: string): Promise<Record<string, string>[]> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "compliance-portal-sync/1.0" },
  });
  if (!resp.ok) throw new Error(`fetch ${url} => ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const rows: Record<string, string>[] = [];
  for (const [name, file] of Object.entries(zip.files)) {
    if (!name.endsWith(".csv") || file.dir) continue;
    const bytes = await file.async("uint8array");
    rows.push(...parseCsv(decodeLatin1(bytes)));
  }
  return rows;
}

async function fetchCadFi(): Promise<Record<string, string>[]> {
  const resp = await fetch(CADFI_URL, {
    headers: { "User-Agent": "compliance-portal-sync/1.0" },
  });
  if (!resp.ok) throw new Error(`fetch cad_fi.csv => ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return parseCsv(decodeLatin1(bytes));
}

Deno.serve(withCors(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const runId = crypto.randomUUID();
    await supabase.from("ingest_runs").insert({
      id: runId,
      dataset: "cvm_registro",
      source: "cvm",
      status: "running",
    });

    const allRows: Record<string, unknown>[] = [];

    // RCVM175
    for (const ds of DATASETS) {
      const raw = await fetchZipCsv(ds.url);
      for (const r of raw) {
        const idCvm = r[ds.idCol]?.trim();
        if (!idCvm) continue;
        allRows.push({
          id_cvm: idCvm,
          cnpj: normalizeCnpj(r[ds.cnpjCol]),
          tipo_registro: ds.tipo,
          denominacao_social: r[ds.denomCol]?.trim() || null,
          nome_comercial: r[ds.nomeComercialCol]?.trim() || null,
          tipo_fundo: r[ds.tipoFundoCol]?.trim() || null,
          classe_anbima: r[ds.classeAnbimaCol]?.trim() || null,
          situacao: r[ds.situacaoCol]?.trim() || null,
          data_registro: toDate(r[ds.dataRegCol]),
          data_inicio_atividade: toDate(r[ds.dataInicioCol]),
          data_cancelamento: toDate(r[ds.dataCancelCol]),
          administrador_cnpj: normalizeCnpj(r[ds.adminCnpjCol]),
          administrador_nome: r[ds.adminNomeCol]?.trim() || null,
          gestor_cnpj: normalizeCnpj(r[ds.gestorCnpjCol]),
          gestor_nome: r[ds.gestorNomeCol]?.trim() || null,
          custodiante_nome: r[ds.custodianteCol]?.trim() || null,
          auditor_nome: r[ds.auditorCol]?.trim() || null,
          publico_alvo: r[ds.publicoAlvoCol]?.trim() || null,
          condominio: r[ds.condominioCol]?.trim() || null,
          patrimonio_liquido: toNum(r[ds.plCol]),
          data_patrimonio_liquido: toDate(r[ds.plDataCol]),
          fonte: ds.fonte,
          raw_payload: r,
          last_synced_at: new Date().toISOString(),
        });
      }
    }

    // CAD_FI (legacy)
    const cadFiRows = await fetchCadFi();
    for (const r of cadFiRows) {
      const cnpj = normalizeCnpj(r["CNPJ_FUNDO"]);
      if (!cnpj) continue;
      allRows.push({
        id_cvm: cnpj,
        cnpj,
        tipo_registro: "fundo",
        denominacao_social: r["DENOM_SOCIAL"]?.trim() || null,
        nome_comercial: r["NOME_COMERCIAL"]?.trim() || null,
        tipo_fundo: r["TP_FUNDO"]?.trim() || null,
        situacao: r["SIT"]?.trim() || null,
        data_registro: toDate(r["DT_REG"]),
        data_inicio_atividade: toDate(r["DT_INI_ATIV"]),
        data_cancelamento: toDate(r["DT_CANCEL"]),
        administrador_cnpj: normalizeCnpj(r["CNPJ_ADMIN"]),
        administrador_nome: r["ADMIN"]?.trim() || null,
        gestor_cnpj: normalizeCnpj(r["CNPJ_GESTOR"]),
        gestor_nome: r["GESTOR"]?.trim() || null,
        custodiante_nome: r["CUSTODIANTE"]?.trim() || null,
        auditor_nome: r["AUDITOR"]?.trim() || null,
        patrimonio_liquido: toNum(r["VL_PATRIM_LIQ"]),
        data_patrimonio_liquido: toDate(r["DT_PATRIM_LIQ"]),
        fonte: "cvm_cad_fi",
        raw_payload: r,
        last_synced_at: new Date().toISOString(),
      });
    }

    // Dedupe by (fonte, id_cvm)
    const unique = new Map<string, Record<string, unknown>>();
    for (const row of allRows) {
      const key = `${row.fonte}||${row.id_cvm}`;
      unique.set(key, row);
    }
    const payload = Array.from(unique.values());

    // Upsert in batches of 500
    let upserted = 0;
    for (let i = 0; i < payload.length; i += 500) {
      const batch = payload.slice(i, i + 500);
      const { error } = await supabase
        .from("fund_master")
        .upsert(batch, { onConflict: "fonte,id_cvm" });
      if (error) throw error;
      upserted += batch.length;
    }

    await supabase.from("ingest_runs").update({
      status: "ok",
      rows_seen: allRows.length,
      rows_upserted: upserted,
      finished_at: new Date().toISOString(),
    }).eq("id", runId);

    return Response.json({ ok: true, rows_seen: allRows.length, rows_upserted: upserted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}));
