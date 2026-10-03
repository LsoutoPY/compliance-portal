import { format, subMonths } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { normalizeIsinLiquidez } from "@/lib/liquidezFundosCaracteristicas";

export type LiquidezTimelineStatus = "ok" | "alerta" | "violacao" | "pendente";

export type LiquidezTimelineItem = {
  dateStr: string;
  status: LiquidezTimelineStatus;
};

const PAGE_SIZE = 1000;

function cnpjQueryVariants(cnpj: string): string[] {
  const clean = cnpj.replace(/\D/g, "").padStart(14, "0");
  const formatted = clean.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    "$1.$2.$3/$4-$5",
  );
  return [...new Set([cnpj, clean, formatted])].filter(Boolean);
}

function mapDbStatus(status: string | null | undefined): LiquidezTimelineStatus | null {
  if (status === "ok" || status === "alerta" || status === "violacao" || status === "pendente") {
    return status;
  }
  return null;
}

async function fetchFundPositionDates(
  cnpjVariants: string[],
  targetIsin: string,
  minDateStr: string,
): Promise<string[]> {
  const dates = new Set<string>();
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("posicao_carteira")
      .select("fundo_dtposicao, fundo_isin")
      .in("fundo_cnpj", cnpjVariants)
      .gte("fundo_dtposicao", minDateStr)
      .order("fundo_dtposicao", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw error;
    if (!data?.length) break;

    for (const row of data) {
      if (!row.fundo_dtposicao) continue;
      if (targetIsin && normalizeIsinLiquidez(row.fundo_isin) !== targetIsin) continue;
      dates.add(row.fundo_dtposicao);
    }
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return [...dates].sort((a, b) => a.localeCompare(b));
}

async function fetchLiquidezStatusByDate(
  cnpjClean: string,
  minDateStr: string,
): Promise<Map<string, LiquidezTimelineStatus>> {
  const statusByDate = new Map<string, LiquidezTimelineStatus>();
  let offset = 0;

  while (true) {
    const { data, error } = await (supabase as any)
      .from("liquidez_monitoramento_risco")
      .select("dt_posicao, status")
      .eq("fundo_cnpj", cnpjClean)
      .gte("dt_posicao", minDateStr)
      .order("dt_posicao", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1) as {
      data: Array<{ dt_posicao: string; status: string }> | null;
      error: unknown;
    };

    if (error) throw error;
    if (!data?.length) break;

    for (const row of data) {
      const mapped = mapDbStatus(row.status);
      if (mapped) statusByDate.set(row.dt_posicao, mapped);
    }
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return statusByDate;
}

/** Histórico de status de liquidez nos últimos 12 meses (todas as datas de posição). */
export async function fetchLiquidezTimelineData(
  fundoCnpj: string,
  fundoIsin?: string | null,
): Promise<LiquidezTimelineItem[]> {
  const cnpjVariants = cnpjQueryVariants(fundoCnpj);
  const cnpjClean = fundoCnpj.replace(/\D/g, "").padStart(14, "0");
  const targetIsin = normalizeIsinLiquidez(fundoIsin);
  const minDateStr = format(subMonths(new Date(), 12), "yyyyMMdd");

  const [positionDates, statusByDate] = await Promise.all([
    fetchFundPositionDates(cnpjVariants, targetIsin, minDateStr),
    fetchLiquidezStatusByDate(cnpjClean, minDateStr),
  ]);

  if (positionDates.length === 0) return [];

  return positionDates.map((dateStr) => ({
    dateStr,
    status: statusByDate.get(dateStr) ?? "pendente",
  }));
}

export function mergeLiquidezTimelineStatus(
  items: LiquidezTimelineItem[],
  dateStr: string | undefined,
  liveStatus: "ok" | "alerta" | "violacao" | null | undefined,
): LiquidezTimelineItem[] {
  if (!liveStatus || !dateStr) return items;

  const map = new Map(items.map((item) => [item.dateStr, item.status]));
  map.set(dateStr, liveStatus);

  return [...map.entries()]
    .map(([d, status]) => ({ dateStr: d, status }))
    .sort((a, b) => a.dateStr.localeCompare(b.dateStr));
}

function formatDateStrBr(dateStr: string): string {
  return `${dateStr.slice(6, 8)}/${dateStr.slice(4, 6)}/${dateStr.slice(2, 4)}`;
}

/** Resumo legível do intervalo coberto (primeira → última data de posição). */
export function formatLiquidezTimelineSummary(items: LiquidezTimelineItem[]): string | null {
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => a.dateStr.localeCompare(b.dateStr));
  const n = items.length;
  return `${n} ${n === 1 ? "data de posição" : "datas de posição"} · ${formatDateStrBr(sorted[0].dateStr)} a ${formatDateStrBr(sorted[sorted.length - 1].dateStr)}`;
}

export function countLiquidezTimelineByStatus(items: LiquidezTimelineItem[]) {
  return items.reduce(
    (acc, item) => {
      acc[item.status]++;
      return acc;
    },
    { ok: 0, alerta: 0, violacao: 0, pendente: 0 },
  );
}

export function getLiquidezTimelineYears(items: LiquidezTimelineItem[]): number[] {
  const years = new Set<number>();
  for (const item of items) {
    years.add(parseInt(item.dateStr.slice(0, 4), 10));
  }
  return [...years].sort((a, b) => b - a);
}

export function filterLiquidezTimelineByYear(
  items: LiquidezTimelineItem[],
  year: number,
): LiquidezTimelineItem[] {
  const prefix = String(year);
  return items.filter((item) => item.dateStr.startsWith(prefix));
}

export function filterLiquidezTimelineByMonth(
  items: LiquidezTimelineItem[],
  year: number,
  month: number,
): LiquidezTimelineItem[] {
  const prefix = `${year}${String(month).padStart(2, "0")}`;
  return items.filter((item) => item.dateStr.startsWith(prefix));
}

export function groupLiquidezTimelineByMonth(
  items: LiquidezTimelineItem[],
): Map<string, LiquidezTimelineItem[]> {
  const groups = new Map<string, LiquidezTimelineItem[]>();
  for (const item of items) {
    const key = item.dateStr.slice(0, 6);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => a.dateStr.localeCompare(b.dateStr));
  }
  return groups;
}

export function getDefaultLiquidezTimelineYear(
  items: LiquidezTimelineItem[],
  activeDateStr?: string,
): number {
  if (activeDateStr?.length === 8) {
    return parseInt(activeDateStr.slice(0, 4), 10);
  }
  const years = getLiquidezTimelineYears(items);
  if (years.length === 0) return new Date().getFullYear();
  return years.includes(new Date().getFullYear()) ? new Date().getFullYear() : years[0];
}

export function getMonthsWithLiquidezTimelineData(
  items: LiquidezTimelineItem[],
  year: number,
): number[] {
  const months = new Set<number>();
  for (const item of items) {
    if (!item.dateStr.startsWith(String(year))) continue;
    months.add(parseInt(item.dateStr.slice(4, 6), 10));
  }
  return [...months].sort((a, b) => a - b);
}

export function getDefaultLiquidezTimelineMonth(
  items: LiquidezTimelineItem[],
  year: number,
  activeDateStr?: string,
): number {
  const available = getMonthsWithLiquidezTimelineData(items, year);
  if (available.length === 0) return 1;
  if (activeDateStr?.length === 8) {
    const activeYear = parseInt(activeDateStr.slice(0, 4), 10);
    const activeMonth = parseInt(activeDateStr.slice(4, 6), 10);
    if (activeYear === year && available.includes(activeMonth)) return activeMonth;
  }
  return available[available.length - 1];
}

export function formatLiquidezMonthLabel(yearMonth: string): string {
  const month = parseInt(yearMonth.slice(4, 6), 10);
  const date = new Date(`${yearMonth.slice(0, 4)}-${String(month).padStart(2, "0")}-01T12:00:00`);
  return date.toLocaleString("pt-BR", { month: "short" }).replace(".", "").toUpperCase();
}

export const LIQUIDEZ_MONTH_OPTIONS = [
  { value: 1, label: "Janeiro" },
  { value: 2, label: "Fevereiro" },
  { value: 3, label: "Março" },
  { value: 4, label: "Abril" },
  { value: 5, label: "Maio" },
  { value: 6, label: "Junho" },
  { value: 7, label: "Julho" },
  { value: 8, label: "Agosto" },
  { value: 9, label: "Setembro" },
  { value: 10, label: "Outubro" },
  { value: 11, label: "Novembro" },
  { value: 12, label: "Dezembro" },
] as const;
