/**
 * Hooks TanStack Query para o módulo Matriz de Risco de Crédito.
 * Todas as queries usam as views criadas em 20260813_credito_matriz_views.sql.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { creditoMatrizKeys } from "@/lib/creditoMatrizKeys";
import type {
  MatrizPrazoRow,
  CoberturaPddRow,
  VisaoGeralKpis,
  ConcentracaoCedenteRow,
  FundoResumoCredito,
  ConcentracaoParteCarteira,
  EnquadramentoCreditoRow,
  SafraEmissaoRow,
  SafraEmissaoMetricas,
  SerieMensalRow,
  PeriodoSerie,
} from "@/lib/creditoMatriz";
import type { ScoreFundoDetalhe } from "@/lib/creditoScore";
import type { JanelaVencimento, VencimentoRecebivel } from "@/lib/creditoVencimentos";
import type { AlertaRisco, ConcentracaoParte } from "@/lib/creditoAlertas";

// Permite acessar views sem tipo gerado
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (t: string) => any };

/** Carrega apenas a janela aberta, sem truncar o estoque no limite da API. */
export function useCreditoVencimentos(fund: string, date: string, janela: JanelaVencimento) {
  return useQuery({
    queryKey: [...creditoMatrizKeys.all, "vencimentos", fund, date, janela.key],
    enabled: !!(fund && date),
    queryFn: async ({ signal }): Promise<VencimentoRecebivel[]> => {
      const rows: VencimentoRecebivel[] = [];
      let total: number | null = null;
      do {
        let query = db.from("vw_credito_matriz_base")
          .select("id,doc_fundo,nome_fundo,doc_cedente,nome_cedente,nome_sacado,chave_ativo,data_vencimento_base,valor_base,valor_nominal", { count: "exact" })
          .eq("data_referencia", date)
          .eq("nao_classificavel", false)
          .gte("dias_ate_vencimento", janela.min)
          .order("data_vencimento_base", { ascending: true })
          .order("id", { ascending: true })
          .range(rows.length, rows.length + 499)
          .abortSignal(signal);
        if (fund !== "TODOS") query = query.eq("doc_fundo", fund);
        if (janela.max !== null) query = query.lte("dias_ate_vencimento", janela.max);
        const { data, error, count } = await query;
        if (error) throw error;
        const page = (data ?? []) as VencimentoRecebivel[];
        total = count;
        if (!page.length) {
          if (total !== null && rows.length < total) throw new Error("Estoque alterado durante a consulta. Atualize os detalhes.");
          break;
        }
        rows.push(...page);
      } while (total === null || rows.length < total);
      return rows;
    },
    staleTime: 3 * 60 * 1000,
  });
}

/** Views novas podem não estar disponíveis enquanto a migration aguarda aplicação. */
function isMissingViewError(error: unknown): boolean {
  const message = String((error as { message?: string } | null)?.message ?? "").toLowerCase();
  return message.includes("could not find the table") || message.includes("schema cache");
}

// ─── Datas disponíveis ────────────────────────────────────────────────────

export function useCreditoMatrizDatas() {
  return useQuery({
    queryKey: creditoMatrizKeys.dates(),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("importacoes_estoque_fidc")
        .select("reference_date")
        .in("status", ["success", "partial_success"])
        .order("reference_date", { ascending: false });
      if (error) throw error;
      const unique = Array.from(
        new Set((data ?? []).map((d) => d.reference_date as string).filter(Boolean)),
      );
      return unique;
    },
    staleTime: 5 * 60 * 1000,
  });
}

// ─── Fundos disponíveis para a data ──────────────────────────────────────

export function useCreditoMatrizFundos(date: string) {
  return useQuery({
    queryKey: [...creditoMatrizKeys.all, "fundos", date],
    enabled: !!date,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("importacoes_estoque_fidc")
        .select("fund_document, fund_name")
        .eq("reference_date", date)
        .in("status", ["success", "partial_success"])
        .order("fund_name", { ascending: true });
      if (error) throw error;
      // dedup por fund_document
      const seen = new Set<string>();
      return (data ?? []).filter((d) => {
        if (!d.fund_document || seen.has(d.fund_document)) return false;
        seen.add(d.fund_document);
        return true;
      }) as { fund_document: string; fund_name: string | null }[];
    },
    staleTime: 5 * 60 * 1000,
  });
}

// ─── Visão Geral ──────────────────────────────────────────────────────────

export function useCreditoMatrizVisaoGeral(fund: string, date: string) {
  return useQuery({
    queryKey: creditoMatrizKeys.visaoGeral(fund, date),
    enabled: !!(fund && date),
    queryFn: async () => {
      let q = db
        .from("vw_credito_matriz_visao_geral")
        .select("*")
        .eq("data_referencia", date);
      if (fund !== "TODOS") q = q.eq("doc_fundo", fund);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as VisaoGeralKpis[];
    },
    staleTime: 3 * 60 * 1000,
  });
}

export function useCreditoMatrizFundoResumo(fund: string, date: string) {
  return useQuery({
    queryKey: creditoMatrizKeys.fundoResumo(fund, date),
    enabled: !!(fund && date),
    queryFn: async () => {
      let q = db.from("vw_credito_matriz_fundo_resumo").select("*").eq("data_referencia", date);
      if (fund !== "TODOS") q = q.eq("doc_fundo", fund);
      const { data, error } = await q;
      if (error && !isMissingViewError(error)) throw error;
      if (error) {
        let fallback = db
          .from("credito_estoque_indicadores")
          .select("doc_fundo, nome_fundo, data_referencia, pl")
          .eq("data_referencia", date)
          .neq("nome_fundo", "CONSOLIDADO");
        if (fund !== "TODOS") fallback = fallback.eq("doc_fundo", fund);
        const { data: indicadores, error: fallbackError } = await fallback;
        if (fallbackError) return [] as FundoResumoCredito[];
        return (indicadores ?? []).map((row: { doc_fundo: string; nome_fundo: string; data_referencia: string; pl: number | null }) => ({
          doc_fundo: row.doc_fundo,
          data_referencia: row.data_referencia,
          nome_fundo: row.nome_fundo,
          qtd_classes: 0,
          pl_total: row.pl,
          rentabilidade_dia_pct: null,
          rentabilidade_mes_pct: null,
          rentabilidade_ano_pct: null,
          rentabilidade_12m_pct: null,
        })) as FundoResumoCredito[];
      }
      return (data ?? []) as FundoResumoCredito[];
    },
    staleTime: 3 * 60 * 1000,
  });
}

// ─── Matriz Atraso & PDD ─────────────────────────────────────────────────

export function useCreditoMatrizPrazo(fund: string, date: string) {
  return useQuery({
    queryKey: creditoMatrizKeys.matrizPrazo(fund, date),
    enabled: !!(fund && date),
    queryFn: async () => {
      let q = db
        .from("vw_credito_matriz_prazo")
        .select("*")
        .eq("data_referencia", date)
        .order("faixa_prazo_ordem", { ascending: true });
      if (fund !== "TODOS") q = q.eq("doc_fundo", fund);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as MatrizPrazoRow[];
    },
    staleTime: 3 * 60 * 1000,
  });
}

// ─── Cobertura de PDD ────────────────────────────────────────────────────

export function useCreditoMatrizCoberturaPdd(fund: string, date: string) {
  return useQuery({
    queryKey: creditoMatrizKeys.coberturaPdd(fund, date),
    enabled: !!(fund && date),
    queryFn: async () => {
      let q = db
        .from("vw_credito_matriz_cobertura_pdd")
        .select("*")
        .eq("data_referencia", date)
        .order("faixa_prazo_ordem", { ascending: true });
      if (fund !== "TODOS") q = q.eq("doc_fundo", fund);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as CoberturaPddRow[];
    },
    staleTime: 3 * 60 * 1000,
  });
}

// ─── Concentração por cedente ─────────────────────────────────────────────

export function useCreditoMatrizConcentracao(fund: string, date: string) {
  return useQuery({
    queryKey: creditoMatrizKeys.concentracao(fund, date),
    enabled: !!(fund && date),
    queryFn: async () => {
      let q = db
        .from("vw_credito_concentracao_cedente")
        .select("*")
        .eq("data_referencia", date)
        .lte("ranking", 5)
        .order("ranking", { ascending: true });
      if (fund !== "TODOS") q = q.eq("doc_fundo", fund);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ConcentracaoCedenteRow[];
    },
    staleTime: 3 * 60 * 1000,
  });
}

export function useCreditoMatrizConcentracaoPartes(fund: string, date: string) {
  return useQuery({
    queryKey: creditoMatrizKeys.concentracaoPartes(fund, date),
    enabled: !!(fund && date),
    queryFn: async () => {
      let q = db
        .from("vw_credito_matriz_concentracao_parte")
        .select("*")
        .eq("data_referencia", date)
        .lte("ranking", 10)
        .order("ranking", { ascending: true });
      if (fund !== "TODOS") q = q.eq("doc_fundo", fund);
      const { data, error } = await q;
      if (error && !isMissingViewError(error)) throw error;
      if (error) return [] as ConcentracaoParteCarteira[];
      return (data ?? []) as ConcentracaoParteCarteira[];
    },
    staleTime: 3 * 60 * 1000,
  });
}

export function useCreditoMatrizEnquadramento(fund: string, date: string) {
  return useQuery({
    queryKey: creditoMatrizKeys.enquadramento(fund, date),
    enabled: !!(fund && date),
    queryFn: async () => {
      const dataPosicao = date.replaceAll("-", "");
      const cnpjLimpo = fund.replace(/\D/g, "").padStart(14, "0");
      const cnpjFormatado = cnpjLimpo.replace(
        /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
        "$1.$2.$3/$4-$5",
      );
      const cnpjVariantes = [...new Set([fund, cnpjLimpo, cnpjFormatado])].filter(Boolean);

      // Mesma fonte oficial usada pelo módulo de Enquadramento. Esta aba apenas consulta
      // resultados já persistidos; nunca dispara a verificação ou recalcula regras.
      let query = db
        .from("enquadramento_resultado")
        .select("fundo_cnpj, fundo_dtposicao, regra_categoria, regra_codigo, regra_descricao, status, valor_atual, valor_limite, detalhes, verificado_em")
        .eq("fundo_dtposicao", dataPosicao)
        .in("regra_categoria", ["fidc-concentracao", "classe"])
        .order("verificado_em", { ascending: false });
      if (fund !== "TODOS") query = query.in("fundo_cnpj", cnpjVariantes);

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map((row: Omit<EnquadramentoCreditoRow, "doc_fundo" | "data_referencia"> & { fundo_cnpj: string; fundo_dtposicao: string }) => ({
        ...row,
        doc_fundo: row.fundo_cnpj.replace(/\D/g, ""),
        data_referencia: `${row.fundo_dtposicao.slice(0, 4)}-${row.fundo_dtposicao.slice(4, 6)}-${row.fundo_dtposicao.slice(6, 8)}`,
      })) as EnquadramentoCreditoRow[];
    },
    staleTime: 3 * 60 * 1000,
  });
}

// ─── Safras por emissão ───────────────────────────────────────────────────

export function useCreditoMatrizSafras(fund: string, date: string) {
  return useQuery({
    queryKey: creditoMatrizKeys.safrasEmissao(fund, date),
    enabled: !!(fund && date),
    queryFn: async () => {
      let q = db
        .from("vw_credito_safras_emissao_serie")
        .select("*")
        .eq("data_referencia", date)
        .order("safra_emissao", { ascending: true });
      if (fund !== "TODOS") q = q.eq("doc_fundo", fund);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as SafraEmissaoRow[];
    },
    staleTime: 3 * 60 * 1000,
  });
}

export function useCreditoMatrizSafrasMetricas(fund: string, date: string) {
  return useQuery({
    queryKey: creditoMatrizKeys.safrasMetricas(fund, date),
    enabled: !!(fund && date),
    queryFn: async () => {
      let q = db
        .from("vw_credito_safras_emissao_metricas")
        .select("*")
        .eq("data_referencia", date);
      if (fund !== "TODOS") q = q.eq("doc_fundo", fund);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as SafraEmissaoMetricas[];
    },
    staleTime: 3 * 60 * 1000,
  });
}

// ─── Série mensal (EvolutionCards Saúde do FIDC) ──────────────────────────

/** Retorna o número de meses a filtrar dado o período selecionado */
function periodToMonths(period: PeriodoSerie): number | null {
  if (period === "6m")  return 6;
  if (period === "12m") return 12;
  if (period === "24m") return 24;
  return null; // "all"
}

function cutoffDateStr(period: PeriodoSerie, asMonthStart = false): string | null {
  const months = periodToMonths(period);
  if (!months) return null;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const iso = cutoff.toISOString();
  return asMonthStart ? iso.substring(0, 7) + "-01" : iso.substring(0, 10);
}

const VENCIDO_BUCKETS = ["1-30", "31-60", "61-90", "91-180", "180+"];

type IndicadorSerieRow = {
  data_referencia: string;
  doc_fundo: string | null;
  nome_fundo: string | null;
  pdd_atual_total: number | null;
  over90: number | null;
  over180: number | null;
  carteira_total: number | null;
};

/** Fallback quando credito_snapshot_mensal_fundo ainda não foi populado. */
async function fetchSerieMensalFromIndicadores(
  fund: string,
  period: PeriodoSerie,
): Promise<SerieMensalRow[]> {
  let indQ = db
    .from("credito_estoque_indicadores")
    .select("data_referencia, doc_fundo, nome_fundo, pdd_atual_total, over90, over180, carteira_total")
    .neq("nome_fundo", "CONSOLIDADO")
    .order("data_referencia", { ascending: true });

  if (fund !== "TODOS") indQ = indQ.eq("doc_fundo", fund);

  const cutoff = cutoffDateStr(period, false);
  if (cutoff) indQ = indQ.gte("data_referencia", cutoff);

  const { data: indicadores, error: indErr } = await indQ;
  if (indErr) throw indErr;
  if (!indicadores?.length) return [];

  const rows = indicadores as IndicadorSerieRow[];
  const dates = [...new Set(rows.map((i) => i.data_referencia))];

  let resQ = db
    .from("credito_estoque_resumo_bucket")
    .select("doc_fundo, data_referencia, bucket_atraso, exposicao")
    .in("bucket_atraso", VENCIDO_BUCKETS)
    .in("data_referencia", dates);

  if (fund !== "TODOS") resQ = resQ.eq("doc_fundo", fund);

  const { data: resumos, error: resErr } = await resQ;
  if (resErr) throw resErr;

  const vencidoMap = new Map<string, number>();
  for (const r of resumos ?? []) {
    const key = `${r.doc_fundo}||${r.data_referencia}`;
    vencidoMap.set(key, (vencidoMap.get(key) ?? 0) + (r.exposicao ?? 0));
  }

  // Um ponto por fundo/mês: usa a data-base mais recente calculada no mês.
  const byMonth = new Map<string, IndicadorSerieRow>();
  for (const ind of rows) {
    const mes = ind.data_referencia.substring(0, 7) + "-01";
    const key = `${ind.doc_fundo ?? ""}||${mes}`;
    const existing = byMonth.get(key);
    if (!existing || ind.data_referencia > existing.data_referencia) {
      byMonth.set(key, ind);
    }
  }

  return [...byMonth.values()]
    .sort((a, b) => a.data_referencia.localeCompare(b.data_referencia))
    .map((ind) => {
      const mes = ind.data_referencia.substring(0, 7) + "-01";
      const vencKey = `${ind.doc_fundo}||${ind.data_referencia}`;
      const vpVencido = vencidoMap.get(vencKey) ?? 0;
      const carteira = ind.carteira_total ?? 0;
      return {
        mes_referencia: mes,
        doc_fundo: ind.doc_fundo ?? "",
        nome_fundo: ind.nome_fundo,
        provisao_total: ind.pdd_atual_total,
        inadimplencia_pct: carteira > 0 ? vpVencido / carteira : null,
        over90_pct: ind.over90,
        over180_pct: ind.over180,
        writeoff_total: null,
        retorno_medio_credito: null,
        vp_total: carteira,
        qtd_titulos: null,
        calc_version: "indicadores_fallback",
        snapshot_updated_at: ind.data_referencia,
        is_stale: null,
      } satisfies SerieMensalRow;
    });
}

export function useCreditoSerieMensal(fund: string, period: PeriodoSerie) {
  return useQuery({
    queryKey: creditoMatrizKeys.serieMensal(fund, period),
    enabled: !!fund,
    queryFn: async () => {
      let q = db
        .from("vw_credito_serie_mensal")
        .select("*")
        .order("mes_referencia", { ascending: true });

      if (fund !== "TODOS") q = q.eq("doc_fundo", fund);

      const cutoffStr = cutoffDateStr(period, true);
      if (cutoffStr) q = q.gte("mes_referencia", cutoffStr);

      const { data, error } = await q;
      if (error) {
        return fetchSerieMensalFromIndicadores(fund, period);
      }
      if (data?.length) return data as SerieMensalRow[];
      return fetchSerieMensalFromIndicadores(fund, period);
    },
    staleTime: 5 * 60 * 1000,
  });
}

// ─── Score e alertas (Saúde do FIDC) ─────────────────────────────────────

export function useCreditoScoreAlertas(fund: string, date: string) {
  const scoreQuery = useQuery({
    queryKey: creditoMatrizKeys.score(fund, date),
    enabled: !!(fund && date && fund !== "TODOS"),
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_credito_score_fundo")
        .select("*")
        .eq("doc_fundo", fund)
        .maybeSingle();
      if (error) throw error;
      return data as ScoreFundoDetalhe | null;
    },
    staleTime: 3 * 60 * 1000,
  });

  const alertasQuery = useQuery({
    queryKey: creditoMatrizKeys.alertas(fund, date),
    enabled: !!(fund && date && fund !== "TODOS"),
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_credito_alertas_risco")
        .select("*")
        .eq("doc_fundo", fund)
        .eq("data_referencia", date)
        .order("severidade", { ascending: false });
      if (error) throw error;
      return (data ?? []) as AlertaRisco[];
    },
    staleTime: 3 * 60 * 1000,
  });

  const concentracaoQuery = useQuery({
    queryKey: [...creditoMatrizKeys.all, "concentracao-over90", fund, date],
    enabled: !!(fund && date && fund !== "TODOS"),
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_credito_concentracao_over90")
        .select("*")
        .eq("doc_fundo", fund)
        .eq("data_referencia", date)
        .eq("tipo_parte", "cedente")
        .lte("ranking", 3)
        .order("ranking", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ConcentracaoParte[];
    },
    staleTime: 3 * 60 * 1000,
  });

  return {
    score: scoreQuery.data ?? null,
    alertas: alertasQuery.data ?? [],
    concentracao: concentracaoQuery.data ?? [],
    isLoading: scoreQuery.isLoading || alertasQuery.isLoading,
    error: scoreQuery.error ?? alertasQuery.error,
  };
}

// ─── Mutation: calcular-credito ───────────────────────────────────────────

export function useCalcularCredito() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (params: { data_referencia: string; doc_fundo?: string }) => {
      const { data, error } = await supabase.functions.invoke("calcular-credito", {
        body: params,
      });
      if (error) throw error;
      if (data && !data.success) throw new Error(data.error ?? "Erro ao calcular");
      return data;
    },
    onSuccess: (data, vars) => {
      queryClient.invalidateQueries({ queryKey: creditoMatrizKeys.all });
      const snap = data?.snapshot_mensal as { success?: boolean; error?: string } | undefined;
      toast({
        title: "Indicadores calculados",
        description: snap && !snap.success
          ? `Cálculo concluído para ${vars.data_referencia}, mas o histórico mensal não foi atualizado (${snap.error ?? "erro desconhecido"}).`
          : `Cálculo concluído para ${vars.data_referencia}.`,
        variant: snap && !snap.success ? "destructive" : "default",
      });
    },
    onError: (err) => {
      toast({
        title: "Erro ao calcular",
        description: err instanceof Error ? err.message : "Tente novamente.",
        variant: "destructive",
      });
    },
  });
}
