import { format, parse } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchPosicaoAvailableDates } from "@/lib/posicaoAvailableDates";

export type RelatorioStatusKey = "ok" | "alerta" | "violacao" | "pendente" | "breach" | "sem_dados";

export const formatCnpj = (cnpj: string | null) => {
  if (!cnpj) return "";
  const clean = String(cnpj).replace(/\D/g, "");
  if (clean.length !== 14) return cnpj;
  return clean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
};

export const formatBRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(v);

export const formatPerc = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

export const formatPctDisplay = (v: number | null, digits = 2) => {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
};

export const normalizeCnpj = (cnpj: string) => String(cnpj ?? "").replace(/\D/g, "");

export const yyyymmddToIso = (raw: string) => {
  const d = raw.replace(/-/g, "");
  if (d.length !== 8) return raw;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
};

export const formatDateToDB = (d: Date) => format(d, "yyyyMMdd");

export function monthLabelFromYyyymm(mes: string): string {
  try {
    return format(parse(`${mes}01`, "yyyyMMdd", new Date()), "MMMM yyyy", { locale: ptBR });
  } catch {
    return mes;
  }
}

export function usePosicaoAvailableDatesQuery() {
  return useQuery({
    queryKey: ["relatorio-posicao-dates"],
    queryFn: fetchPosicaoAvailableDates,
  });
}

export function usePosicaoMonthlyMonths() {
  return useQuery({
    queryKey: ["relatorio-posicao-months"],
    queryFn: async () => {
      const dates = await fetchPosicaoAvailableDates();
      const months = new Map<string, string>();
      for (const d of dates) {
        if (d.length === 8) {
          const key = d.slice(0, 6);
          if (!months.has(key)) months.set(key, d);
        }
      }
      return Array.from(months.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([mes, ultimaDt]) => ({ mes, ultimaDt }));
    },
  });
}

export function useRiscoMercadoMonthlyMonths() {
  return useQuery({
    queryKey: ["relatorio-risco-mercado-months"],
    queryFn: async () => {
      const PAGE = 1000;
      const seen = new Set<string>();
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("posicao_diaria")
          .select("data_posicao")
          .order("data_posicao", { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) break;
        if (!data?.length) break;
        for (const row of data) {
          if (row.data_posicao) seen.add(row.data_posicao);
        }
        if (data.length < PAGE) break;
        from += PAGE;
      }

      const months = new Map<string, string>();
      for (const iso of [...seen].sort((a, b) => b.localeCompare(a))) {
        const key = iso.slice(0, 7).replace("-", "");
        if (!months.has(key)) months.set(key, iso);
      }
      return Array.from(months.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([mes, ultimaIso]) => ({ mes, ultimaIso }));
    },
  });
}

export const STATUS_PRIORITY: Record<string, number> = {
  violacao: 0,
  breach: 0,
  alerta: 1,
  pendente: 2,
  sem_dados: 3,
  ok: 4,
};

/** Limites YYYYMMDD do mês (mes = YYYYMM). */
export function monthBoundsYyyymm(mes: string): { start: string; end: string } {
  const year = parseInt(mes.slice(0, 4), 10);
  const month = parseInt(mes.slice(4, 6), 10);
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${mes}01`,
    end: `${mes}${String(lastDay).padStart(2, "0")}`,
  };
}

function cnpjVariants(cnpj: string): string[] {
  const clean = normalizeCnpj(cnpj);
  const formatted =
    clean.length === 14
      ? clean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
      : cnpj;
  return [...new Set([cnpj, clean, formatted].filter(Boolean))];
}

/**
 * Primeira data do mês em que o fundo registrou violação ou alerta em enquadramento_resultado.
 */
export async function fetchPrimeiraDataEnquadramentoMes(
  fundoCnpj: string,
  mesYyyymm: string,
  statusDetail: "violacao" | "alerta",
  fundoIsin?: string | null,
): Promise<string | null> {
  const { start, end } = monthBoundsYyyymm(mesYyyymm);
  const statuses = statusDetail === "violacao" ? ["violacao"] : ["alerta"];
  const variants = cnpjVariants(fundoCnpj);

  let q = supabase
    .from("enquadramento_resultado" as any)
    .select("fundo_dtposicao, status, fundo_cnpj, fundo_isin")
    .in("fundo_cnpj", variants)
    .gte("fundo_dtposicao", start)
    .lte("fundo_dtposicao", end)
    .in("status", statuses)
    .order("fundo_dtposicao", { ascending: true });
  if (fundoIsin) q = (q as any).eq("fundo_isin", fundoIsin);

  const { data, error } = await q as {
    data: Array<{ fundo_dtposicao: string; status: string; fundo_cnpj: string }> | null;
    error: unknown;
  };

  if (error || !data?.length) return null;

  // Agrupa por data e mantém a mais antiga com evento relevante
  const seen = new Set<string>();
  for (const row of data) {
    if (row.fundo_dtposicao && !seen.has(row.fundo_dtposicao)) {
      seen.add(row.fundo_dtposicao);
      return row.fundo_dtposicao;
    }
  }
  return data[0]?.fundo_dtposicao ?? null;
}
