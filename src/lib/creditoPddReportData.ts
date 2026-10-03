import { supabase } from "@/integrations/supabase/client";
import type { CoberturaPddRow } from "./creditoMatriz";
import { buildPddReport, type PddResumo } from "./creditoPddReport";

// Views ainda não constam no schema gerado; mantém o cliente autenticado e suas RLS.
const db = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;

async function fetchPages<T>(view: string, columns: string, fund: string, date: string, buckets = false): Promise<T[]> {
  const rows: T[] = [];
  let expectedCount: number | null = null;
  while (true) {
    let query = db.from(view).select(columns, { count: "exact" })
      .eq("data_referencia", date).order("doc_fundo", { ascending: true });
    if (fund !== "TODOS") query = query.eq("doc_fundo", fund);
    if (buckets) query = query.order("faixa_prazo_ordem", { ascending: true });
    const { data, error, count } = await query.range(rows.length, rows.length + 499);
    if (error) throw new Error(`Não foi possível consultar os dados de PDD: ${error.message}`);
    if (expectedCount !== null && count !== expectedCount) {
      throw new Error("O estoque mudou durante a exportação. Tente novamente.");
    }
    expectedCount = count;
    const page = (data ?? []) as unknown as T[];
    rows.push(...page);
    if (count !== null && rows.length === count) break;
    if (!page.length) {
      if (count !== null && rows.length !== count) throw new Error("A consulta de PDD retornou dados incompletos. Tente novamente.");
      break;
    }
    if (count !== null && rows.length > count) throw new Error("O estoque mudou durante a exportação. Tente novamente.");
  }
  return rows;
}

/** Consulta atualizada e paginada, sem depender do limite de linhas da tela. */
export async function fetchPddReport(fund: string, date: string) {
  const [resumos, coberturas] = await Promise.all([
    fetchPages<PddResumo>("vw_credito_matriz_visao_geral",
      "doc_fundo,nome_fundo,data_referencia,vp_total,pdd_total,vp_a_vencer,vp_vencido,vp_writeoff", fund, date),
    fetchPages<CoberturaPddRow>("vw_credito_matriz_cobertura_pdd", "*", fund, date, true),
  ]);
  return buildPddReport({ fund, date, resumos, coberturas });
}
