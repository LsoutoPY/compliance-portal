/**
 * Edge Function: import-passivo-de-para
 *
 * Importa planilha de relacionamento De-Para de cotistas.
 * Colunas esperadas: Nº, Nome Clt., CPF_CNPJ, Conta XP, Conta BTG, Status
 *
 * Request: multipart/form-data ou application/json
 *   - de_para_json: JSON string com array de objetos (parseado no frontend a partir do XLSX)
 *   - file: (alternativo) arquivo XLSX - frontend parseia e envia como de_para_json
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

/** Extrai CPF ou CNPJ embutido no nome do cotista, ex: "NOME ( 068.556.108-97 )" ou "FUNDO ( 61.846.544/0001-63 )" */
function extractCpfCnpjFromCotista(cotista: string): string | null {
  if (!cotista) return null;
  const match = cotista.match(/\(\s*([\d]{3}\.[\d]{3}\.[\d]{3}-[\d]{2}|[\d]{2}\.[\d]{3}\.[\d]{3}\/[\d]{4}-[\d]{2})\s*\)/);
  if (match) return match[1].replace(/\D/g, '');
  return null;
}

/** Extrai número após "P/C" (ex: "XP...P/C497092" -> "497092") */
function extractContaXp(val: string | null | undefined): string | null {
  if (!val) return null;
  const s = String(val).trim();
  const match = s.match(/P\/C\s*(\d+)/i) || s.match(/P\/C(\d+)/i);
  if (match) return match[1];
  if (/^\d+$/.test(s)) return s;
  return null;
}

/** Normaliza valor para coluna - remove P/C prefix se existir, retorna só número */
function normalizeContaXp(val: string | null | undefined): string | null {
  const extracted = extractContaXp(val);
  return extracted || (val ? String(val).trim() || null : null);
}

function sanitizeText(val: string | null | undefined): string | null {
  const cleaned = String(val ?? "")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

interface DeParaRow {
  codigo_cliente: number;
  nome_cliente: string | null;
  cpf_cnpj: string | null;
  conta_xp: string | null;
  conta_btg: string | null;
  status: string | null;
}

interface DeParaLookup {
  exactMap: Map<string, number>;
  nomeEntries: Array<{ normalized: string; compact: string; codigo: number }>;
}

function parseDeParaFromJson(data: unknown[]): DeParaRow[] {
  const rows: DeParaRow[] = [];
  const normalizeHeader = (h: string) =>
    String(h ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;

    const keys = Object.keys(obj);
    const headerMap: Record<string, string> = {};
    for (const k of keys) {
      const n = normalizeHeader(k);
      if (n.includes("numero") || n === "n" || n === "no" || n === "codigo") headerMap["codigo"] = k;
      else if (n.includes("nome") && n.includes("clt")) headerMap["nome"] = k;
      else if (n.includes("cpf") || n.includes("cnpj") || n.includes("documento")) headerMap["cpf_cnpj"] = k;
      else if (n.includes("conta") && n.includes("xp")) headerMap["conta_xp"] = k;
      else if (n.includes("conta") && n.includes("btg")) headerMap["conta_btg"] = k;
      else if (n.includes("status")) headerMap["status"] = k;
    }

    const codigoRaw = obj[headerMap["codigo"] ?? "Nº"] ?? obj["Nº"] ?? obj["No"] ?? obj["codigo"];
    const codigo = codigoRaw != null ? parseInt(String(codigoRaw).replace(/\D/g, ""), 10) : NaN;
    if (isNaN(codigo) || codigo <= 0) continue;

    const nome = sanitizeText(String(obj[headerMap["nome"] ?? "Nome Clt."] ?? obj["Nome Clt."] ?? ""));
    const cpfCnpj = sanitizeText(String(obj[headerMap["cpf_cnpj"] ?? "CPF_CNPJ"] ?? obj["CPF_CNPJ"] ?? obj["CPF/CNPJ"] ?? ""));
    const contaXpRaw = obj[headerMap["conta_xp"] ?? "Conta XP"] ?? obj["Conta XP"] ?? "";
    const contaXp = normalizeContaXp(String(contaXpRaw ?? "")) || null;
    const contaBtgRaw = obj[headerMap["conta_btg"] ?? "Conta BTG"] ?? obj["Conta BTG"] ?? "";
    const contaBtg = normalizeContaNumero(String(contaBtgRaw ?? "")) || null;
    const status = sanitizeText(String(obj[headerMap["status"] ?? "Status"] ?? obj["Status"] ?? ""));

    rows.push({
      codigo_cliente: codigo,
      nome_cliente: nome,
      cpf_cnpj: cpfCnpj,
      conta_xp: contaXp,
      conta_btg: contaBtg,
      status,
    });
  }
  return rows;
}

function normalizeContaNumero(val: string | null | undefined): string | null {
  if (!val) return null;
  const digits = String(val).replace(/\D/g, "");
  if (!digits) return null;
  const withoutLeadingZeros = digits.replace(/^0+/, "");
  return withoutLeadingZeros || "0";
}

function normalizeNomeForMatch(name: string): string {
  return (name || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/["'`´]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactNome(name: string): string {
  return normalizeNomeForMatch(name).replace(/\s+/g, "");
}

function tokenizeNome(name: string): string[] {
  const stopWords = new Set([
    "DE", "DO", "DA", "DOS", "DAS", "E", "EM", "NO", "NA", "PARA", "COM",
    "CORRETORA", "INVESTIMENTOS", "BANCO", "DTVM", "CTVM", "S", "A", "SA",
  ]);
  return normalizeNomeForMatch(name)
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !stopWords.has(w));
}

function nomeSimilarity(a: string, b: string): number {
  const aCompact = compactNome(a);
  const bCompact = compactNome(b);
  if (!aCompact || !bCompact) return 0;
  if (aCompact === bCompact) return 1;
  if (aCompact.length >= 6 && bCompact.includes(aCompact)) return 0.92;
  if (bCompact.length >= 6 && aCompact.includes(bCompact)) return 0.92;

  const tokA = tokenizeNome(a);
  const tokB = tokenizeNome(b);
  if (tokA.length === 0 || tokB.length === 0) return 0;

  let overlap = 0;
  for (const t of tokA) {
    if (tokB.includes(t)) {
      overlap++;
      continue;
    }
    for (const tb of tokB) {
      if (tb.startsWith(t) || t.startsWith(tb)) {
        overlap += 0.7;
        break;
      }
    }
  }
  return overlap / Math.min(tokA.length, tokB.length);
}

/** Extrai número de conta do cotista. Suporta: P/C, C/C, CC, e sequência de dígitos no final (BTG) */
function extractContaFromCotista(cotista: string): string | null {
  if (!cotista) return null;
  const s = String(cotista).trim();
  let match = s.match(/P\/C\s*(\d+)/i) || s.match(/P\/C(\d+)/i);
  if (match) return normalizeContaNumero(match[1]);
  match = s.match(/C\/C\s*(\d+)/i) || s.match(/C\/C(\d+)/i);
  if (match) return normalizeContaNumero(match[1]);
  match = s.match(/\bCC\s*(\d+)/i);
  if (match) return normalizeContaNumero(match[1]);
  match = s.match(/(\d{6,})$/);
  if (match) return normalizeContaNumero(match[1]);
  return null;
}

async function buildDeParaLookup(): Promise<DeParaLookup> {
  const { data } = await supabase
    .from("passivo_cotista_de_para")
    .select("codigo_cliente, nome_cliente, conta_xp, conta_btg, cpf_cnpj");

  const exactMap = new Map<string, number>();
  const nomeEntries: Array<{ normalized: string; compact: string; codigo: number }> = [];
  for (const row of (data || []) as { codigo_cliente: number; nome_cliente: string | null; conta_xp: string | null; conta_btg: string | null; cpf_cnpj: string | null }[]) {
    const contaXp = normalizeContaNumero(row.conta_xp);
    if (contaXp) exactMap.set("xp:" + contaXp, row.codigo_cliente);

    const contaBtg = normalizeContaNumero(row.conta_btg);
    if (contaBtg) exactMap.set("btg:" + contaBtg, row.codigo_cliente);

    const cpfCnpj = row.cpf_cnpj ? String(row.cpf_cnpj).replace(/\D/g, '') : null;
    if (cpfCnpj && cpfCnpj.length >= 11) exactMap.set("cpf:" + cpfCnpj, row.codigo_cliente);

    if (row.nome_cliente) {
      const normalized = normalizeNomeForMatch(row.nome_cliente);
      const compact = compactNome(row.nome_cliente);
      if (normalized) exactMap.set("nome:" + normalized, row.codigo_cliente);
      if (normalized && compact) nomeEntries.push({ normalized, compact, codigo: row.codigo_cliente });
    }
  }
  return { exactMap, nomeEntries };
}

function resolveCodigoClt(cotista: string, deParaLookup: DeParaLookup): number | null {
  const { exactMap, nomeEntries } = deParaLookup;
  if (!cotista) return null;

  const conta = extractContaFromCotista(cotista);
  if (conta) {
    const byXp = exactMap.get("xp:" + conta);
    if (byXp) return byXp;
    const byBtg = exactMap.get("btg:" + conta);
    if (byBtg) return byBtg;
  }

  // 1.5) CPF/CNPJ embutido no nome do cotista: "NOME ( 068.556.108-97 )"
  const cpfCnpj = extractCpfCnpjFromCotista(cotista);
  if (cpfCnpj) {
    const byCpf = exactMap.get("cpf:" + cpfCnpj);
    if (byCpf) return byCpf;
  }

  const normalizedCotista = normalizeNomeForMatch(cotista);
  const byNome = exactMap.get("nome:" + normalizedCotista);
  if (byNome) return byNome;

  const contaDireta = normalizeContaNumero(cotista);
  if (contaDireta) {
    const byBtgDireto = exactMap.get("btg:" + contaDireta);
    if (byBtgDireto) return byBtgDireto;
  }

  let bestCodigo: number | null = null;
  let bestScore = 0;
  let secondBest = 0;
  for (const entry of nomeEntries) {
    const score = nomeSimilarity(normalizedCotista, entry.normalized);
    if (score > bestScore) {
      secondBest = bestScore;
      bestScore = score;
      bestCodigo = entry.codigo;
    } else if (score > secondBest) {
      secondBest = score;
    }
  }

  if (bestCodigo != null && bestScore >= 0.78 && (bestScore - secondBest) >= 0.06) {
    return bestCodigo;
  }
  return null;
}

serve(async (req: Request) => {
  console.log("[import-passivo-de-para] Recebendo requisição:", req.method);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get("content-type") || "";
    let deParaJsonStr: string | null = null;

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      deParaJsonStr = formData.get("de_para_json") as string | null;
    } else if (contentType.includes("application/json")) {
      const body = await req.json();
      deParaJsonStr = typeof body.de_para_json === "string" ? body.de_para_json : JSON.stringify(body);
    }

    if (!deParaJsonStr) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Envie os dados em 'de_para_json' (o frontend parseia o XLSX e envia o JSON).",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let rows: DeParaRow[] = [];
    try {
      const parsed = JSON.parse(deParaJsonStr) as unknown[];
      rows = parseDeParaFromJson(Array.isArray(parsed) ? parsed : [parsed]);
      console.log("[import-passivo-de-para] Recebidos", rows.length, "registros via JSON");
    } catch (e) {
      console.warn("[import-passivo-de-para] Erro ao parsear de_para_json:", e);
      return new Response(
        JSON.stringify({ success: false, error: "JSON inválido em de_para_json." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (rows.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Nenhum registro válido encontrado. Verifique as colunas: Nº, Nome Clt., CPF_CNPJ, Conta XP, Conta BTG, Status.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let upserted = 0;
    for (const r of rows) {
      const { error } = await supabase
        .from("passivo_cotista_de_para")
        .upsert(
          {
            codigo_cliente: r.codigo_cliente,
            nome_cliente: r.nome_cliente,
            cpf_cnpj: r.cpf_cnpj,
            conta_xp: r.conta_xp,
            conta_btg: r.conta_btg,
            status: r.status,
            atualizado_em: new Date().toISOString(),
          },
          { onConflict: "codigo_cliente" }
        );

      if (!error) upserted++;
      else console.warn("[import-passivo-de-para] Erro ao upsert codigo", r.codigo_cliente, error.message);
    }

    console.log("[import-passivo-de-para] Upsert concluído:", upserted, "/", rows.length);

    // Reprocessa códigos no passivo existente para refletir o De-Para atualizado
    let passivoReprocessado = 0;
    let passivoAtualizado = 0;
    try {
      const deParaLookup = await buildDeParaLookup();

      // ── passivo_fundos ──────────────────────────────────────────────────────
      const { data: passivoRows } = await supabase
        .from("passivo_fundos")
        .select("id, cotista, codigo_clt");

      const updates: Array<{ id: string; codigo_clt: number | null }> = [];
      for (const row of (passivoRows || []) as { id: string; cotista: string; codigo_clt: number | null }[]) {
        passivoReprocessado++;
        const novoCodigo = resolveCodigoClt(row.cotista, deParaLookup);
        if ((row.codigo_clt ?? null) !== (novoCodigo ?? null)) {
          updates.push({ id: row.id, codigo_clt: novoCodigo });
        }
      }

      const BATCH = 500;
      for (let i = 0; i < updates.length; i += BATCH) {
        const batch = updates.slice(i, i + BATCH);
        const { error } = await supabase
          .from("passivo_fundos")
          .upsert(batch, { onConflict: "id" });
        if (!error) passivoAtualizado += batch.length;
      }
      console.log(`[import-passivo-de-para] Passivo reprocessado: ${passivoAtualizado}/${passivoReprocessado}`);

      // ── resgates_movimentacoes ──────────────────────────────────────────────
      let resgatesReprocessado = 0;
      let resgatesAtualizado   = 0;
      try {
        const { data: resgateRows } = await supabase
          .from("resgates_movimentacoes")
          .select("id, cotista, codigo_clt");

        const resgateUpdates: Array<{ id: string; codigo_clt: number | null }> = [];
        for (const row of (resgateRows || []) as { id: string; cotista: string; codigo_clt: number | null }[]) {
          resgatesReprocessado++;
          const novoCodigo = resolveCodigoClt(row.cotista, deParaLookup);
          if ((row.codigo_clt ?? null) !== (novoCodigo ?? null)) {
            resgateUpdates.push({ id: row.id, codigo_clt: novoCodigo });
          }
        }

        for (let i = 0; i < resgateUpdates.length; i += BATCH) {
          const batch = resgateUpdates.slice(i, i + BATCH);
          const { error } = await supabase
            .from("resgates_movimentacoes")
            .upsert(batch, { onConflict: "id" });
          if (!error) resgatesAtualizado += batch.length;
        }
        console.log(`[import-passivo-de-para] Resgates reprocessados: ${resgatesAtualizado}/${resgatesReprocessado}`);
      } catch (e2) {
        console.warn("[import-passivo-de-para] Falha ao reprocessar resgates_movimentacoes:", e2);
      }
    } catch (e) {
      console.warn("[import-passivo-de-para] Falha ao reprocessar passivo_fundos:", e);
    }

    return new Response(
      JSON.stringify({
        success: true,
        recordsInserted: upserted,
        totalProcessed: rows.length,
        message: `De-Para importado: ${upserted} registros atualizados/incluídos. Passivo reprocessado automaticamente.`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[import-passivo-de-para] Erro:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Erro desconhecido",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
