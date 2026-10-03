/**
 * Edge Function: propagar-cadastro-partes
 *
 * Cruza cadastro vigente de um fundo origem com cedentes do estoque do fundo destino
 * e permite copiar limites/validade para o destino (dry_run + confirmação).
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

function cleanDoc(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

function normalizeDoc(docRaw: unknown): string {
  const digits = cleanDoc(docRaw);
  if (!digits) return "";
  if (digits.length <= 11) return digits.padStart(11, "0");
  return digits.padStart(14, "0");
}

interface ParteOrigem {
  id: string;
  doc_cnpj_cpf: string;
  nome: string | null;
  limite_operacao: number | null;
  dt_validade: string | null;
  dt_analise: string | null;
  escopo_limite: string;
  grupo_chave: string | null;
  consultoria: string | null;
  observacoes: string | null;
  tipo_parte: string;
  status: string;
}

interface LinhaSugerida {
  origem_id: string;
  doc_cnpj_cpf: string;
  nome: string | null;
  limite_operacao: number | null;
  dt_validade: string | null;
  dt_analise: string | null;
  escopo_limite: string;
  grupo_chave: string | null;
  consultoria: string | null;
  observacoes: string | null;
  tipo_parte: string;
  valor_presente_estoque: number;
  selecionada: boolean;
}

async function findLatestEstoqueImport(fundCnpj: string) {
  const { data: imports, error } = await supabase
    .from("importacoes_estoque_fidc")
    .select("id, fund_document, fund_name, reference_date")
    .in("status", ["success", "partial_success"])
    .order("reference_date", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Erro ao buscar imports de estoque: ${error.message}`);
  return (imports ?? []).find((imp) => normalizeDoc(imp.fund_document) === fundCnpj) ?? null;
}

async function loadCedentesEstoque(importId: string) {
  const { data: rows, error } = await supabase
    .from("estoque_fidc")
    .select("doc_cedente, nome_cedente, valor_presente")
    .eq("import_id", importId);
  if (error) throw new Error(`Erro ao carregar estoque: ${error.message}`);

  const map = new Map<string, { nome: string | null; vp: number }>();
  for (const r of rows ?? []) {
    const doc = normalizeDoc(r.doc_cedente);
    if (doc.length !== 14) continue;
    const vp = Number(r.valor_presente) || 0;
    const cur = map.get(doc);
    if (!cur) {
      map.set(doc, { nome: r.nome_cedente ?? null, vp });
    } else {
      cur.vp += vp;
      if (!cur.nome && r.nome_cedente) cur.nome = r.nome_cedente;
    }
  }
  return map;
}

function buildPreview(
  origemPartes: ParteOrigem[],
  estoqueMap: Map<string, { nome: string | null; vp: number }>,
  destinoDocs: Set<string>,
) {
  const sugeridas: LinhaSugerida[] = [];
  const ja_cadastradas: { doc_cnpj_cpf: string; nome: string | null; valor_presente_estoque: number }[] = [];

  for (const p of origemPartes) {
    if (p.status !== "ativo" || p.tipo_parte !== "cedente") continue;
    const est = estoqueMap.get(p.doc_cnpj_cpf);
    if (!est) continue;

    if (destinoDocs.has(p.doc_cnpj_cpf)) {
      ja_cadastradas.push({
        doc_cnpj_cpf: p.doc_cnpj_cpf,
        nome: p.nome,
        valor_presente_estoque: est.vp,
      });
      continue;
    }

    sugeridas.push({
      origem_id: p.id,
      doc_cnpj_cpf: p.doc_cnpj_cpf,
      nome: p.nome,
      limite_operacao: p.limite_operacao,
      dt_validade: p.dt_validade,
      dt_analise: p.dt_analise,
      escopo_limite: p.escopo_limite,
      grupo_chave: p.grupo_chave,
      consultoria: p.consultoria,
      observacoes: p.observacoes,
      tipo_parte: p.tipo_parte,
      valor_presente_estoque: est.vp,
      selecionada: true,
    });
  }

  sugeridas.sort((a, b) => (a.nome ?? "").localeCompare(b.nome ?? "", "pt-BR"));
  ja_cadastradas.sort((a, b) => (a.nome ?? "").localeCompare(b.nome ?? "", "pt-BR"));

  return { sugeridas, ja_cadastradas };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const fundoDestino = cleanDoc(body.fundo_destino_cnpj);
    const fundoOrigem = cleanDoc(body.fundo_origem_cnpj);
    const dryRun = body.dry_run !== false;
    const linhasConfirmadas = (body.linhas_confirmadas ?? []) as LinhaSugerida[];

    if (fundoDestino.length !== 14 || fundoOrigem.length !== 14) {
      return new Response(
        JSON.stringify({ success: false, error: "fundo_destino_cnpj e fundo_origem_cnpj devem ter 14 dígitos." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (fundoDestino === fundoOrigem) {
      return new Response(
        JSON.stringify({ success: false, error: "Fundo origem e destino devem ser diferentes." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const estoqueImport = await findLatestEstoqueImport(fundoDestino);
    if (!estoqueImport) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Nenhum estoque FIDC importado encontrado para o fundo destino.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const estoqueMap = await loadCedentesEstoque(estoqueImport.id);

    const { data: origemPartes, error: origemErr } = await supabase
      .from("fidc_cadastro_partes")
      .select(
        "id, doc_cnpj_cpf, nome, limite_operacao, dt_validade, dt_analise, escopo_limite, grupo_chave, consultoria, observacoes, tipo_parte, status",
      )
      .eq("fundo_cnpj", fundoOrigem)
      .eq("vigente", true);
    if (origemErr) throw new Error(`Erro ao carregar cadastro origem: ${origemErr.message}`);

    const { data: destinoPartes, error: destErr } = await supabase
      .from("fidc_cadastro_partes")
      .select("doc_cnpj_cpf")
      .eq("fundo_cnpj", fundoDestino)
      .eq("vigente", true);
    if (destErr) throw new Error(`Erro ao carregar cadastro destino: ${destErr.message}`);

    const destinoDocs = new Set((destinoPartes ?? []).map((p) => p.doc_cnpj_cpf));
    const preview = buildPreview((origemPartes ?? []) as ParteOrigem[], estoqueMap, destinoDocs);

    if (dryRun) {
      return new Response(
        JSON.stringify({
          success: true,
          dry_run: true,
          preview: {
            fundo_origem_cnpj: fundoOrigem,
            fundo_destino_cnpj: fundoDestino,
            estoque_reference_date: estoqueImport.reference_date,
            estoque_fund_name: estoqueImport.fund_name,
            total_origem: (origemPartes ?? []).length,
            total_estoque_cedentes: estoqueMap.size,
            sugeridas: preview.sugeridas,
            ja_cadastradas: preview.ja_cadastradas,
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const paraInserir = linhasConfirmadas.filter((l) => l.doc_cnpj_cpf && l.selecionada !== false);
    if (paraInserir.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "Nenhuma linha selecionada para propagar." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const importId = crypto.randomUUID();
    const consultoria = paraInserir.find((l) => l.consultoria)?.consultoria ?? null;
    const origemLabel = fundoOrigem.slice(0, 8);

    const { error: impError } = await supabase.from("cadastro_partes_importacoes").insert({
      id: importId,
      fundo_cnpj: fundoDestino,
      filename: `Propagação desde ${origemLabel}`,
      data_base: estoqueImport.reference_date,
      consultoria,
      total_linhas: paraInserir.length,
      aceitas: paraInserir.length,
      rejeitadas: 0,
      avisos: [{
        problema: "propagado_de_outro_fundo",
        valor_original: fundoOrigem,
        campo: "fundo_origem",
        linha: 0,
      }],
    });
    if (impError) throw new Error(`Erro ao registrar propagação: ${impError.message}`);

    const insertedIds: string[] = [];
    const fundoIsin = String(body.fundo_isin ?? "").trim();

    for (const linha of paraInserir) {
      const { data: anteriores } = await supabase
        .from("fidc_cadastro_partes")
        .select("id")
        .eq("fundo_cnpj", fundoDestino)
        .eq("fundo_isin", fundoIsin)
        .eq("tipo_parte", "cedente")
        .eq("doc_cnpj_cpf", linha.doc_cnpj_cpf)
        .eq("vigente", true);

      const newId = crypto.randomUUID();
      const obsPropag = `Propagado do fundo ${fundoOrigem}`;
      const observacoes = [linha.observacoes, obsPropag].filter(Boolean).join(" | ");

      const { error: insError } = await supabase.from("fidc_cadastro_partes").insert({
        id: newId,
        fundo_cnpj: fundoDestino,
        fundo_isin: fundoIsin,
        tipo_parte: "cedente",
        doc_cnpj_cpf: linha.doc_cnpj_cpf,
        nome: linha.nome,
        escopo_limite: linha.escopo_limite ?? "individual",
        grupo_chave: linha.grupo_chave,
        limite_operacao: linha.limite_operacao,
        dt_analise: linha.dt_analise,
        dt_validade: linha.dt_validade,
        consultoria: linha.consultoria,
        status: "ativo",
        observacoes: observacoes || null,
        vigente: true,
        import_id: importId,
      });
      if (insError) throw new Error(`Erro ao inserir parte ${linha.doc_cnpj_cpf}: ${insError.message}`);

      insertedIds.push(newId);
      for (const ant of anteriores ?? []) {
        await supabase
          .from("fidc_cadastro_partes")
          .update({ vigente: false, substituido_por: newId })
          .eq("id", ant.id);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        import_id: importId,
        inseridas: insertedIds.length,
        fundo_origem_cnpj: fundoOrigem,
        fundo_destino_cnpj: fundoDestino,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[propagar-cadastro-partes]", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
