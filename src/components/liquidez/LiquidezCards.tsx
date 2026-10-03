import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  BarChart3,
  Calendar,
  Zap,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { LiquidezStressChoqueResult } from "@/lib/liquidezStressChoque";
import type { LiquidezTimelineItem, LiquidezTimelineStatus } from "@/lib/liquidezTimeline";
import {
  countLiquidezTimelineByStatus,
  filterLiquidezTimelineByMonth,
  filterLiquidezTimelineByYear,
  formatLiquidezMonthLabel,
  formatLiquidezTimelineSummary,
  getLiquidezTimelineYears,
  getMonthsWithLiquidezTimelineData,
  groupLiquidezTimelineByMonth,
  LIQUIDEZ_MONTH_OPTIONS,
} from "@/lib/liquidezTimeline";

const formatBRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);

/**
 * Limiar OK por prazo do fundo (racional ANBIMA):
 * - Prazo D+60 a D+120: limiar ok = 1,10
 * - Prazo > D+120: limiar ok = 1,05
 * - Prazo ≤ D+60 ou sem info: limiar ok = 1,10
 */
function getLimiarOk(prazoFundoDias: number | null | undefined): number {
  if (prazoFundoDias == null) return 1.1;
  return prazoFundoDias > 120 ? 1.05 : 1.1;
}

/* ─── Card 2 — Frequência de Status (substitui Termômetro) ─── */
export function LiquidezFrequencia({ items }: { items: LiquidezTimelineItem[] }) {
  const rangeSummary = useMemo(() => formatLiquidezTimelineSummary(items), [items]);
  const stats = useMemo(() => {
    const total = items.length;
    if (total === 0) {
      return { ok: 0, alerta: 0, violacao: 0, pendente: 0, total: 0, counts: { ok: 0, alerta: 0, violacao: 0, pendente: 0 } };
    }
    const counts = items.reduce(
      (acc, item) => {
        acc[item.status]++;
        return acc;
      },
      { ok: 0, alerta: 0, violacao: 0, pendente: 0 },
    );
    return {
      ok: (counts.ok / total) * 100,
      alerta: (counts.alerta / total) * 100,
      violacao: (counts.violacao / total) * 100,
      pendente: (counts.pendente / total) * 100,
      total,
      counts,
    };
  }, [items]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="w-4 h-4" /> Frequência de Status
          </CardTitle>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <Info className="w-3 h-3 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-[260px] text-xs">
                Considera apenas datas em que existe posição importada (posicao_carteira), não o calendário completo.
                Pendente = posição sem registro de cálculo em liquidez_monitoramento_risco.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <CardDescription className="text-[10px]">
          Últimos 12 meses
          {rangeSummary ? ` · ${rangeSummary}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-2">
        {stats.total === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">Sem dados históricos</p>
        ) : (
          <>
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" /> OK
                </span>
                <span className="font-mono font-bold">{stats.ok.toFixed(0)}%</span>
              </div>
              <div className="h-2 w-full bg-muted/30 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full transition-all duration-500" style={{ width: `${stats.ok}%` }} />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-500" /> Alerta
                </span>
                <span className="font-mono font-bold">{stats.alerta.toFixed(0)}%</span>
              </div>
              <div className="h-2 w-full bg-muted/30 rounded-full overflow-hidden">
                <div className="h-full bg-amber-500 rounded-full transition-all duration-500" style={{ width: `${stats.alerta}%` }} />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-red-500" /> Violação
                </span>
                <span className="font-mono font-bold">{stats.violacao.toFixed(0)}%</span>
              </div>
              <div className="h-2 w-full bg-muted/30 rounded-full overflow-hidden">
                <div className="h-full bg-red-500 rounded-full transition-all duration-500" style={{ width: `${stats.violacao}%` }} />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-slate-400" /> Pendente
                  {stats.counts.pendente > 0 && (
                    <span className="text-[10px] text-muted-foreground">({stats.counts.pendente} {stats.counts.pendente === 1 ? "dia" : "dias"})</span>
                  )}
                </span>
                <span className="font-mono font-bold">{stats.pendente.toFixed(0)}%</span>
              </div>
              <div className="h-2 w-full bg-muted/30 rounded-full overflow-hidden">
                <div className="h-full bg-slate-400 rounded-full transition-all duration-500" style={{ width: `${stats.pendente}%` }} />
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Card 3 — Heatmap Liquidez (substitui Timeline) ─── */

type HeatmapViewMode = "ano" | "mes";

function liquidezDotColor(s: LiquidezTimelineStatus): string {
  if (s === "pendente") return "bg-slate-300 hover:bg-slate-400";
  if (s === "ok") return "bg-emerald-500 hover:bg-emerald-600";
  if (s === "alerta") return "bg-amber-400 hover:bg-amber-500";
  return "bg-red-500 hover:bg-red-600";
}

function LiquidezTimelineDot({ item, size = "md" }: { item: LiquidezTimelineItem; size?: "sm" | "md" }) {
  return (
    <TooltipProvider>
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "shrink-0 rounded-full border border-background cursor-pointer transition-all hover:scale-150",
              size === "sm" ? "w-1.5 h-1.5" : "w-2.5 h-2.5",
              liquidezDotColor(item.status),
            )}
          />
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs font-mono">
          {item.dateStr.slice(6, 8)}/{item.dateStr.slice(4, 6)}/{item.dateStr.slice(0, 4)}
          <br />
          <span className="uppercase font-bold text-[10px]">
            {item.status === "pendente" ? "pendente de cálculo" : item.status}
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function LiquidezTimelineDotsRow({ items }: { items: LiquidezTimelineItem[] }) {
  if (items.length === 0) {
    return <span className="text-[9px] text-muted-foreground/60">—</span>;
  }

  return (
    <ScrollArea className="w-full whitespace-nowrap">
      <div className="flex items-center gap-0.5 py-0.5">
        {items.map((item) => (
          <LiquidezTimelineDot key={item.dateStr} item={item} size="sm" />
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}

export function LiquidezHeatmap({
  items,
  activeDateStr,
}: {
  items: LiquidezTimelineItem[];
  activeDateStr?: string;
}) {
  const availableYears = useMemo(() => getLiquidezTimelineYears(items), [items]);

  const [selectedYear, setSelectedYear] = useState(() =>
    activeDateStr?.length === 8
      ? parseInt(activeDateStr.slice(0, 4), 10)
      : new Date().getFullYear(),
  );
  const [viewMode, setViewMode] = useState<HeatmapViewMode>("ano");
  const [selectedMonth, setSelectedMonth] = useState(() =>
    activeDateStr?.length === 8
      ? parseInt(activeDateStr.slice(4, 6), 10)
      : new Date().getMonth() + 1,
  );

  useEffect(() => {
    if (activeDateStr?.length !== 8) return;
    setSelectedYear(parseInt(activeDateStr.slice(0, 4), 10));
    setSelectedMonth(parseInt(activeDateStr.slice(4, 6), 10));
  }, [activeDateStr]);

  useEffect(() => {
    setSelectedMonth((prev) => {
      const months = getMonthsWithLiquidezTimelineData(items, selectedYear);
      if (months.includes(prev)) return prev;
      return months.length > 0 ? months[months.length - 1] : prev;
    });
  }, [selectedYear, items]);

  const yearItems = useMemo(
    () => filterLiquidezTimelineByYear(items, selectedYear),
    [items, selectedYear],
  );

  const monthItems = useMemo(
    () => filterLiquidezTimelineByMonth(yearItems, selectedYear, selectedMonth),
    [yearItems, selectedYear, selectedMonth],
  );

  const monthsInYear = useMemo(
    () => getMonthsWithLiquidezTimelineData(items, selectedYear),
    [items, selectedYear],
  );

  const monthGroups = useMemo(() => {
    const grouped = groupLiquidezTimelineByMonth(yearItems);
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [yearItems]);

  const rangeSummary = useMemo(() => formatLiquidezTimelineSummary(yearItems), [yearItems]);
  const yearCounts = useMemo(() => countLiquidezTimelineByStatus(yearItems), [yearItems]);

  return (
    <Card>
      <CardHeader className="pb-2 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Calendar className="w-4 h-4" /> Liquidez Status – {selectedYear}
          </CardTitle>
          {availableYears.length > 0 && (
            <Select
              value={String(selectedYear)}
              onValueChange={(v) => setSelectedYear(parseInt(v, 10))}
            >
              <SelectTrigger className="h-7 w-[88px] text-[10px] font-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableYears.map((year) => (
                  <SelectItem key={year} value={String(year)} className="text-xs">
                    {year}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            value={viewMode}
            onValueChange={(v) => setViewMode(v as HeatmapViewMode)}
            className="w-auto"
          >
            <TabsList className="h-7">
              <TabsTrigger value="ano" className="text-[10px] px-2.5 h-6">Ano</TabsTrigger>
              <TabsTrigger value="mes" className="text-[10px] px-2.5 h-6">Mês</TabsTrigger>
            </TabsList>
          </Tabs>

          {viewMode === "mes" && monthsInYear.length > 0 && (
            <Select
              value={String(selectedMonth)}
              onValueChange={(v) => setSelectedMonth(parseInt(v, 10))}
            >
              <SelectTrigger className="h-7 w-[120px] text-[10px] font-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIQUIDEZ_MONTH_OPTIONS.filter((m) => monthsInYear.includes(m.value)).map((m) => (
                  <SelectItem key={m.value} value={String(m.value)} className="text-xs">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <CardDescription className="text-[10px]">
          {rangeSummary ?? `Sem posição em ${selectedYear}`}
          {yearItems.length > 0 && yearCounts.pendente > 0
            ? ` · ${yearCounts.pendente} pendentes no ano`
            : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {yearItems.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            Sem posição importada em {selectedYear} para este fundo.
          </p>
        ) : viewMode === "ano" ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {monthGroups.map(([yearMonth, monthItemsGroup]) => {
              const counts = countLiquidezTimelineByStatus(monthItemsGroup);
              return (
                <div
                  key={yearMonth}
                  className="rounded-md border border-border/50 bg-muted/10 p-2 space-y-1.5 min-w-0"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[10px] font-bold uppercase text-muted-foreground">
                      {formatLiquidezMonthLabel(yearMonth)}
                    </span>
                    <span className="text-[9px] text-muted-foreground font-mono">
                      {monthItemsGroup.length}d
                    </span>
                  </div>
                  <LiquidezTimelineDotsRow items={monthItemsGroup} />
                  <div className="flex flex-wrap gap-1">
                    {counts.ok > 0 && (
                      <Badge variant="outline" className="text-[8px] h-4 px-1 border-emerald-200 text-emerald-700">
                        {counts.ok} ok
                      </Badge>
                    )}
                    {counts.alerta > 0 && (
                      <Badge variant="outline" className="text-[8px] h-4 px-1 border-amber-200 text-amber-700">
                        {counts.alerta} soft
                      </Badge>
                    )}
                    {counts.violacao > 0 && (
                      <Badge variant="outline" className="text-[8px] h-4 px-1 border-red-200 text-red-700">
                        {counts.violacao} hard
                      </Badge>
                    )}
                    {counts.pendente > 0 && (
                      <Badge variant="outline" className="text-[8px] h-4 px-1 border-slate-200 text-slate-600">
                        {counts.pendente} pend.
                      </Badge>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <ScrollArea className="w-full whitespace-nowrap">
            <div className="relative pt-6 pb-2 min-w-max px-1">
              <div className="absolute top-[29px] left-4 right-4 h-[2px] bg-muted/50 z-0" />
              <div className="relative z-10 flex items-center gap-1 px-3">
                {monthItems.map((item) => (
                  <LiquidezTimelineDot key={item.dateStr} item={item} />
                ))}
              </div>
              <div className="mt-2 px-3 text-[9px] text-muted-foreground uppercase">
                {LIQUIDEZ_MONTH_OPTIONS.find((m) => m.value === selectedMonth)?.label} {selectedYear}
                {" · "}
                {monthItems.length} {monthItems.length === 1 ? "data" : "datas"}
              </div>
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Card 4 — Stress Liquidez ─── */
export function LiquidezStress({
  choqueResult,
  totalPL,
  maiorCotista,
}: {
  choqueResult: LiquidezStressChoqueResult;
  totalPL: number;
  maiorCotista?: { nome: string; valor: number } | null;
}) {
  const { choque, piso20, somaCotistasTop3, nCotistasTop3, binding } = choqueResult;
  const choquePct = totalPL > 0 ? (choque / totalPL) * 100 : 0;
  const top3Pct  = totalPL > 0 ? (somaCotistasTop3 / totalPL) * 100 : 0;
  const maiorPct = totalPL > 0 && maiorCotista ? (maiorCotista.valor / totalPL) * 100 : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Zap className="w-4 h-4" /> Stress Liquidez
        </CardTitle>
        <CardDescription className="text-[10px]">
          Top 3 cotistas · teto em 20% do PL
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {maiorCotista && maiorCotista.valor > 0 && (
          <Row
            label={`Maior cotista${maiorCotista.nome ? ` · ${maiorCotista.nome}` : ""}`}
            value={`${formatBRL(maiorCotista.valor)} (${maiorPct.toFixed(1)}% do PL)`}
          />
        )}
        <Row label="20% do PL (piso / teto do choque)" value={formatBRL(piso20)} />
        <Row
          label={`Top ${nCotistasTop3} cotistas (soma bruta)`}
          value={`${formatBRL(somaCotistasTop3)} (${top3Pct.toFixed(1)}%)`}
        />
        <div className="flex justify-between items-center text-xs pt-2 border-t">
          <span className="font-bold">
            Choque ({binding === "cap20" ? "teto 20% ativado" : "20% PL"})
          </span>
          <span className="font-mono font-bold text-primary">
            {formatBRL(choque)} ({choquePct.toFixed(1)}%)
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-bold">{value}</span>
    </div>
  );
}

/* ─── Score Liquidez (sticky header) ─── */
export function LiquidezScore({ score }: { score: number }) {
  const zona = score >= 80 ? "ok" : score >= 60 ? "soft" : "hard";
  return (
    <div className={cn(
      "flex items-center gap-1.5 px-2.5 py-1 rounded-lg border font-bold",
      zona === "ok" && "bg-emerald-500 text-white border-emerald-600",
      zona === "soft" && "bg-amber-500 text-white border-amber-600",
      zona === "hard" && "bg-red-500 text-white border-red-600",
    )}>
      <span className="text-[10px] uppercase">Score</span>
      <span className="font-mono text-sm">{score}</span>
    </div>
  );
}
