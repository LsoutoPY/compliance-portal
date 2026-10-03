/**
 * Edge Function: importar-fundo-regras
 * Importação em lote de vínculos fundo × regra via planilha XLSX.
 * dry_run=true → preview; dry_run=false → grava com status pendente (aguarda aprovação).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const BUCKET = "fundo-regras-imports";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

type ImportAviso = {
  linha: number;
  campo?: string;
  problema: string;
  valor_original?: string;
};

type LinhaPreview = {
  linha: number;
  fundo_cnpj: string;
  fundo_isin: string;
  fundo_nome: string | null;
  codigo_regra: string;
  regra_id: string | null;
  dt_inicio_vigencia: string | null;
  dt_fim_vigencia: string | null;
  rejeitada: boolean;
  avisos: ImportAviso[];
};

function normalizeCnpj14(cnpj: string): string {
  return String(cnpj ?? "").replace(/\D/g, "").padStart(14, "0").slice(-14);
}

function normalizeHeaderKey(h: string): string {
  return String(h ?? "")
    .replace(/\r\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

const HEADER_ALIASES: Record<string, string[]> = {
  FUNDO_CNPJ: ["FUNDO_CNPJ", "CNPJ_FUNDO", "CNPJ", "CNPJ_DO_FUNDO"],
  FUNDO_NOME: ["FUNDO_NOME", "NOME_FUNDO", "NOME", "FUNDO"],
  FUNDO_ISIN: ["FUNDO_ISIN", "ISIN", "SUBCLASSE"],
  CODIGO_REGRA: ["CODIGO_REGRA", "CODIGO", "REGRA", "COD_REGRA", "CODIGO_DA_REGRA"],
  DT_INICIO: ["DT_INICIO_VIGENCIA", "DATA_INICIO", "INICIO_VIGENCIA", "VIGENCIA_INICIO"],
  DT_FIM: ["DT_FIM_VIGENCIA", "DATA_FIM", "FIM_VIGENCIA", "VIGENCIA_FIM"],
};

function mapHeaders(keys: string[]): Record<string, string> {
  const headerMap: Record<string, string> = {};
  for (const k of keys) {
    const norm = normalizeHeaderKey(k);
    for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(norm)) {
        headerMap[canonical] = k;
        break;
      }
    }
  }
  return headerMap;
}

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

function parseDataCampo(v: unknown): { date: string | null; invalid: boolean; valorOriginal: string } {
  const raw = String(v ?? "").trim();
  if (!raw) return { date: null, invalid: false, valorOriginal: raw };
  if (/^(pendente|n\/a|na|null|-)$/i.test(raw)) return { date: null, invalid: false, valorOriginal: raw };

  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(EXCEL_EPOCH_MS + v * 86400000);
    if (!Number.isNaN(d.getTime())) {
      const iso = d.toISOString().slice(0, 10);
      return { date: iso, invalid: false, valorOriginal: raw };
    }
  }

  const br = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (br) {
    const dd = br[1].padStart(2, "0");
    const mm = br[2].padStart(2, "0");
    return { date: `${br[3]}-${mm}-${dd}`, invalid: false, valorOriginal: raw };
  }

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return { date: raw, invalid: false, valorOriginal: raw };

  return { date: null, invalid: true, valorOriginal: raw };
}

function parseXlsx(buffer: ArrayBuffer): { rows: Record<string, unknown>[]; sheetName: string } {
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0] ?? "Sheet1";
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: true,
    defval: null,
  });
  return { rows, sheetName };
}

function normalizeCodigoRegra(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "_");
}

type FundoItem = { cnpj: string; isin: string; nome: string };

function buildFundoIndex(fundos: FundoItem[]) {
  const byCnpjIsin = new Map<string, FundoItem>();
  const byNome = new Map<string, FundoItem[]>();
  for (const f of fundos) {
    byCnpjIsin.set(`${f.cnpj}|${f.isin}`, f);
    const nomeKey = f.nome.trim().toUpperCase();
    if (!nomeKey) continue;
    const list = byNome.get(nomeKey) ?? [];
    list.push(f);
    byNome.set(nomeKey, list);
  }
  return { byCnpjIsin, byNome };
}

function resolveFundo(
  row: Record<string, unknown>,
  headerMap: Record<string, string>,
  fundoIndex: ReturnType<typeof buildFundoIndex>,
  linha: number,
): { cnpj: string; isin: string; nome: string | null; avisos: ImportAviso[] } {
  const avisos: ImportAviso[] = [];
  const cnpjRaw = String(row[headerMap.FUNDO_CNPJ ?? ""] ?? "").trim();
  const nomeRaw = String(row[headerMap.FUNDO_NOME ?? ""] ?? "").trim();
  const isinRaw = String(row[headerMap.FUNDO_ISIN ?? ""] ?? "").trim().toUpperCase();

  if (cnpjRaw) {
    const cnpj = normalizeCnpj14(cnpjRaw);
    if (cnpj.length !== 14) {
      avisos.push({ linha, campo: "fundo_cnpj", problema: "cnpj_invalido", valor_original: cnpjRaw });
      return { cnpj: "", isin: "", nome: null, avisos };
    }
    const hit = fundoIndex.byCnpjIsin.get(`${cnpj}|${isinRaw}`);
    if (hit) return { cnpj, isin: isinRaw, nome: hit.nome, avisos };
    if (isinRaw) {
      avisos.push({ linha, campo: "fundo", problema: "fundo_nao_encontrado", valor_original: `${cnpjRaw} / ${isinRaw}` });
      return { cnpj, isin: isinRaw, nome: null, avisos };
    }
    const anySubclass = [...fundoIndex.byCnpjIsin.values()].find((f) => f.cnpj === cnpj);
    if (anySubclass) {
      avisos.push({ linha, campo: "fundo_isin", problema: "isin_recomendado", valor_original: cnpjRaw });
      return { cnpj, isin: "", nome: anySubclass.nome, avisos };
    }
    avisos.push({ linha, campo: "fundo", problema: "fundo_nao_encontrado", valor_original: cnpjRaw });
    return { cnpj, isin: isinRaw, nome: null, avisos };
  }

  if (nomeRaw) {
    const matches = fundoIndex.byNome.get(nomeRaw.toUpperCase()) ?? [];
    if (matches.length === 1) {
      return { cnpj: matches[0].cnpj, isin: matches[0].isin, nome: matches[0].nome, avisos };
    }
    if (matches.length > 1) {
      avisos.push({ linha, campo: "fundo_nome", problema: "nome_ambiguo", valor_original: nomeRaw });
      return { cnpj: "", isin: "", nome: nomeRaw, avisos };
    }
    avisos.push({ linha, campo: "fundo_nome", problema: "fundo_nao_encontrado", valor_original: nomeRaw });
    return { cnpj: "", isin: "", nome: nomeRaw, avisos };
  }

  avisos.push({ linha, campo: "fundo", problema: "fundo_obrigatorio" });
  return { cnpj: "", isin: "", nome: null, avisos };
}

function parseLinha(
  row: Record<string, unknown>,
  headerMap: Record<string, string>,
  linha: number,
  fundoIndex: ReturnType<typeof buildFundoIndex>,
  regrasByCodigo: Map<string, string>,
  existentesKeys: Set<string>,
): LinhaPreview {
  const avisos: ImportAviso[] = [];
  const fundo = resolveFundo(row, headerMap, fundoIndex, linha);
  avisos.push(...fundo.avisos);

  const codigoRaw = String(row[headerMap.CODIGO_REGRA ?? ""] ?? "").trim();
  const codigo = normalizeCodigoRegra(codigoRaw);
  if (!codigo) {
    avisos.push({ linha, campo: "codigo_regra", problema: "codigo_obrigatorio" });
  } else if (!regrasByCodigo.has(codigo)) {
    avisos.push({ linha, campo: "codigo_regra", problema: "regra_nao_encontrada", valor_original: codigoRaw });
  }

  const dtInicioParsed = parseDataCampo(row[headerMap.DT_INICIO ?? ""]);
  const dtFimParsed = parseDataCampo(row[headerMap.DT_FIM ?? ""]);
  if (dtInicioParsed.invalid) {
    avisos.push({ linha, campo: "dt_inicio_vigencia", problema: "data_invalida", valor_original: dtInicioParsed.valorOriginal });
  }
  if (dtFimParsed.invalid) {
    avisos.push({ linha, campo: "dt_fim_vigencia", problema: "data_invalida", valor_original: dtFimParsed.valorOriginal });
  }
  if (dtInicioParsed.date && dtFimParsed.date && dtInicioParsed.date > dtFimParsed.date) {
    avisos.push({ linha, campo: "vigencia", problema: "inicio_maior_que_fim" });
  }

  const regraId = codigo ? regrasByCodigo.get(codigo) ?? null : null;
  const existKey = fundo.cnpj && regraId ? `${fundo.cnpj}|${fundo.isin}|${regraId}` : "";
  if (existKey && existentesKeys.has(existKey)) {
    avisos.push({ linha, campo: "vinculo", problema: "vinculo_ja_existe" });
  }

  const bloqueantes = new Set([
    "fundo_obrigatorio", "cnpj_invalido", "fundo_nao_encontrado", "nome_ambiguo",
    "codigo_obrigatorio", "regra_nao_encontrada", "data_invalida", "inicio_maior_que_fim", "vinculo_ja_existe",
  ]);

  return {
    linha,
    fundo_cnpj: fundo.cnpj,
    fundo_isin: fundo.isin,
    fundo_nome: fundo.nome,
    codigo_regra: codigo,
    regra_id: regraId,
    dt_inicio_vigencia: dtInicioParsed.date,
    dt_fim_vigencia: dtFimParsed.date,
    rejeitada: avisos.some((a) => bloqueantes.has(a.problema)),
    avisos,
  };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ success: false, error: "Não autorizado." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ success: false, error: "Sessão inválida." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const formData = await req.formData();
    const file = formData.get("file");
    const dryRun = String(formData.get("dry_run") ?? "false") === "true";
    const linhasJson = formData.get("linhas_confirmadas");

    if (!file || !(file instanceof File)) {
      return new Response(JSON.stringify({ success: false, error: 'Campo "file" (XLSX) obrigatório.' }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const buffer = await file.arrayBuffer();
    const { rows, sheetName } = parseXlsx(buffer);
    if (rows.length === 0) {
      return new Response(JSON.stringify({ success: false, error: "Planilha vazia." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const headerMap = mapHeaders(Object.keys(rows[0] ?? {}));
    if (!headerMap.CODIGO_REGRA) {
      return new Response(JSON.stringify({ success: false, error: "Coluna codigo_regra não encontrada." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!headerMap.FUNDO_CNPJ && !headerMap.FUNDO_NOME) {
      return new Response(JSON.stringify({ success: false, error: "Informe coluna fundo_cnpj ou fundo_nome." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const [{ data: regrasData }, { data: fundosRpc }, { data: existentes }] = await Promise.all([
      supabase.from("regras_compliance").select("id, codigo"),
      supabase.rpc("get_fundos_para_regras"),
      supabase.from("fundo_regras").select("fundo_cnpj, fundo_isin, regra_id, status_aprovacao").neq("status_aprovacao", "rejeitado"),
    ]);

    const regrasByCodigo = new Map(
      (regrasData ?? []).map((r: { id: string; codigo: string }) => [normalizeCodigoRegra(r.codigo), r.id]),
    );

    const fundos: FundoItem[] = (fundosRpc ?? []).map((f: { fundo_cnpj: string; fundo_isin?: string; fundo_nome?: string; nome_fundo?: string }) => ({
      cnpj: normalizeCnpj14(f.fundo_cnpj),
      isin: f.fundo_isin ?? "",
      nome: String(f.nome_fundo ?? f.fundo_nome ?? f.fundo_cnpj).trim(),
    }));

    const existentesKeys = new Set<string>();
    for (const e of existentes ?? []) {
      const cnpj = normalizeCnpj14((e as { fundo_cnpj: string }).fundo_cnpj);
      const isin = (e as { fundo_isin?: string }).fundo_isin ?? "";
      const regraId = (e as { regra_id: string }).regra_id;
      existentesKeys.add(`${cnpj}|${isin}|${regraId}`);
    }

    const fundoIndex = buildFundoIndex(fundos);

    let linhasConfirmadas: LinhaPreview[] | null = null;
    if (linhasJson) {
      linhasConfirmadas = JSON.parse(String(linhasJson)) as LinhaPreview[];
    }

    const parsed: LinhaPreview[] =
      linhasConfirmadas ??
      rows.map((row, i) => parseLinha(row, headerMap, i + 2, fundoIndex, regrasByCodigo, existentesKeys));

    const validas = parsed.filter((l) => !l.rejeitada);
    const rejeitadas = parsed.filter((l) => l.rejeitada);
    const allAvisos = parsed.flatMap((l) => l.avisos);

    if (dryRun) {
      return new Response(
        JSON.stringify({
          success: true,
          dry_run: true,
          sheet: sheetName,
          preview: {
            total: parsed.length,
            validas: validas.length,
            rejeitadas: rejeitadas.length,
            linhas: parsed,
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const importId = crypto.randomUUID();
    const storagePath = `${importId}/${file.name}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, new Uint8Array(buffer), {
        contentType: file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        upsert: false,
      });
    if (uploadError) console.warn("[importar-fundo-regras] Storage:", uploadError.message);

    const { error: impError } = await supabase.from("fundo_regras_importacoes").insert({
      id: importId,
      arquivo_nome: file.name,
      status: "concluido",
      total_linhas: parsed.length,
      linhas_aceitas: validas.length,
      linhas_rejeitadas: rejeitadas.length,
      avisos: allAvisos,
      arquivo_storage_path: uploadError ? null : storagePath,
      criado_por: userData.user.id,
    });
    if (impError) throw new Error(`Erro ao registrar importação: ${impError.message}`);

    const inserts = validas.map((l) => ({
      fundo_cnpj: l.fundo_cnpj,
      fundo_isin: l.fundo_isin ?? "",
      regra_id: l.regra_id!,
      ativo: false,
      status_aprovacao: "pendente",
      origem: "importacao",
      dt_inicio_vigencia: l.dt_inicio_vigencia,
      dt_fim_vigencia: l.dt_fim_vigencia,
      import_id: importId,
    }));

    if (inserts.length > 0) {
      const { error: insError } = await supabase.from("fundo_regras").insert(inserts);
      if (insError) throw new Error(`Erro ao gravar vínculos: ${insError.message}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        import_id: importId,
        aceitas: validas.length,
        rejeitadas: rejeitadas.length,
        pendentes_aprovacao: validas.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[importar-fundo-regras]", err);
    return new Response(
      JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
