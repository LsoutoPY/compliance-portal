import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { format, parse, differenceInDays, isSameMonth, startOfMonth } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Loader2, Calendar, CheckCircle2, XCircle, AlertTriangle, TrendingUp, AlertOctagon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";

interface EnquadramentoTimelineProps {
  fundoCnpj: string;
  /** ISIN da subclasse do fundo. Quando fornecido, filtra resultados por subclasse. */
  fundoIsin?: string | null;
  /** Data atualmente exibida na carteira (YYYYMMDD) — destaca a barra ativa. */
  activeDate?: string | null;
  /** Prefixo da rota de carteira. Padrão: módulo de enquadramento. */
  carteiraBasePath?: string;
}

interface DayStatus {
  date: Date;
  dateStr: string;
  status: "enquadrado" | "desenquadrado";
  statusDetail?: "ok" | "alerta" | "violacao";
}

const PAGE_SIZE = 1000;

function cnpjQueryVariants(cnpj: string): string[] {
  const clean = cnpj.replace(/\D/g, "").padStart(14, "0");
  const formatted = clean.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    "$1.$2.$3/$4-$5",
  );
  return [...new Set([cnpj, clean, formatted])].filter(Boolean);
}

function normalizeIsin(isin: string | null | undefined): string {
  return (isin ?? "").trim().toUpperCase();
}

function worstStatus(a: string | undefined, b: string): string {
  if (b === "violacao" || !a) return b;
  if (b === "alerta" && a !== "violacao") return b;
  return a;
}

async function fetchFundPositionDates(
  cnpjVariants: string[],
  targetIsin: string,
): Promise<string[]> {
  const dates = new Set<string>();
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("posicao_carteira")
      .select("fundo_dtposicao, fundo_isin")
      .in("fundo_cnpj", cnpjVariants)
      .order("fundo_dtposicao", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw error;
    if (!data?.length) break;

    for (const row of data) {
      if (!row.fundo_dtposicao) continue;
      if (targetIsin && normalizeIsin(row.fundo_isin) !== targetIsin) continue;
      dates.add(row.fundo_dtposicao);
    }
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return [...dates].sort((a, b) => a.localeCompare(b));
}

async function fetchEnquadramentoStatusRows(
  cnpjVariants: string[],
  dateSet: Set<string>,
): Promise<Array<{ fundo_dtposicao: string; fundo_isin: string; status: string }>> {
  const rows: Array<{ fundo_dtposicao: string; fundo_isin: string; status: string }> = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("enquadramento_resultado" as any)
      .select("fundo_dtposicao, fundo_isin, status")
      .in("fundo_cnpj", cnpjVariants)
      .order("fundo_dtposicao", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1) as {
      data: Array<{ fundo_dtposicao: string; fundo_isin: string; status: string }> | null;
      error: unknown;
    };

    if (error) throw error;
    if (!data?.length) break;

    for (const row of data) {
      if (dateSet.has(row.fundo_dtposicao)) rows.push(row);
    }
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return rows;
}

export function EnquadramentoTimeline({
  fundoCnpj,
  fundoIsin,
  activeDate,
  carteiraBasePath = "/enquadramento/carteira",
}: EnquadramentoTimelineProps) {
  const navigate = useNavigate();

  const buildCarteiraPath = (dateStr: string) => {
    const isinSuffix = fundoIsin
      ? `?isin=${encodeURIComponent(fundoIsin)}`
      : "";
    return `${carteiraBasePath}/${fundoCnpj}/${dateStr}${isinSuffix}#monitoramento-compliance`;
  };

  const handleDateClick = (dateStr: string) => {
    navigate(buildCarteiraPath(dateStr));
  };

  const { data: timelineData = [], isLoading } = useQuery({
    queryKey: ["enquadramento-timeline", fundoCnpj, fundoIsin],
    enabled: !!fundoCnpj,
    staleTime: 30_000,
    queryFn: async () => {
      const cnpjVariants = cnpjQueryVariants(fundoCnpj);
      const targetIsin = normalizeIsin(fundoIsin);

      // 1. Todas as datas com posição (paginado — evita limite de 1000 linhas do Supabase)
      const uniqueDates = await fetchFundPositionDates(cnpjVariants, targetIsin);
      if (uniqueDates.length === 0) return [];

      const dateSet = new Set(uniqueDates);

      // 2. Resultados de enquadramento (paginado — múltiplas regras por dia)
      const enquadramentoData = await fetchEnquadramentoStatusRows(cnpjVariants, dateSet);

      // Mapa "data|isin" -> pior status; fallback para isin='' (registros pré-migração)
      const statusByDateIsin = new Map<string, string>();
      enquadramentoData.forEach((item) => {
        const isinKey = normalizeIsin(item.fundo_isin);
        const key = `${item.fundo_dtposicao}|${isinKey}`;
        statusByDateIsin.set(key, worstStatus(statusByDateIsin.get(key), item.status));
      });

      const worstStatusByDate = new Map<string, string>();
      uniqueDates.forEach((dateStr) => {
        const exactKey = `${dateStr}|${targetIsin}`;
        const legacyKey = `${dateStr}|`;
        const status =
          statusByDateIsin.get(exactKey) ??
          (targetIsin ? statusByDateIsin.get(legacyKey) : undefined);

        if (!targetIsin) {
          // Sem ISIN: agrega todos os registros da data (comportamento legado)
          enquadramentoData
            .filter((item) => item.fundo_dtposicao === dateStr)
            .forEach((item) => {
              worstStatusByDate.set(dateStr, worstStatus(worstStatusByDate.get(dateStr), item.status));
            });
        } else if (status) {
          worstStatusByDate.set(dateStr, status);
        }
      });

      return uniqueDates.map((dateStr) => {
        const status = worstStatusByDate.get(dateStr);
        const desenquadrado = status === "violacao" || status === "alerta";
        return {
          date: parse(dateStr, "yyyyMMdd", new Date()),
          dateStr,
          status: desenquadrado ? "desenquadrado" : "enquadrado",
          statusDetail: (status || "ok") as "ok" | "alerta" | "violacao",
        };
      }) as DayStatus[];
    },
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-4 bg-muted/10 rounded-lg border border-dashed">
        <Loader2 className="h-8 w-8 animate-spin text-primary/50" />
        <span className="text-sm text-muted-foreground font-medium">Construindo linha do tempo...</span>
      </div>
    );
  }

  if (timelineData.length === 0) {
    return null;
  }

  // Agrupar por meses para visualização
  const monthsGrouped: { monthLabel: string; days: DayStatus[] }[] = [];
  let currentMonth: { monthLabel: string; days: DayStatus[] } | null = null;

  timelineData.forEach((day) => {
    const monthKey = format(day.date, "MMMM yyyy", { locale: ptBR });
    if (!currentMonth || currentMonth.monthLabel !== monthKey) {
      if (currentMonth) monthsGrouped.push(currentMonth);
      currentMonth = { monthLabel: monthKey, days: [] };
    }
    currentMonth.days.push(day);
  });
  if (currentMonth) monthsGrouped.push(currentMonth);

  // Agrupar períodos de desenquadramento para a lista
  const desenquadramentoPeriodos: { inicio: string; fim: string; dias: number; tipo: string }[] = [];
  let periodoAtual: { inicio: string; fim: string; tipo: string } | null = null;

  timelineData.forEach((d) => {
    if (d.status === "desenquadrado") {
      if (!periodoAtual) {
        periodoAtual = { inicio: d.dateStr, fim: d.dateStr, tipo: d.statusDetail || "alerta" };
      } else {
        periodoAtual.fim = d.dateStr;
        // Se piorar o status no meio do periodo, atualiza o tipo
        if (d.statusDetail === "violacao") periodoAtual.tipo = "violacao";
      }
    } else {
      if (periodoAtual) {
        const inicio = parse(periodoAtual.inicio, "yyyyMMdd", new Date());
        const fim = parse(periodoAtual.fim, "yyyyMMdd", new Date());
        desenquadramentoPeriodos.push({
          ...periodoAtual,
          dias: differenceInDays(fim, inicio) + 1,
        });
        periodoAtual = null;
      }
    }
  });
  if (periodoAtual) {
    const inicio = parse(periodoAtual.inicio, "yyyyMMdd", new Date());
    const fim = parse(periodoAtual.fim, "yyyyMMdd", new Date());
    desenquadramentoPeriodos.push({
      ...periodoAtual,
      dias: differenceInDays(fim, inicio) + 1,
    });
  }

  // Estatísticas
  const totalDias = timelineData.length;
  const totalDesenquadrado = timelineData.filter((d) => d.status === "desenquadrado").length;
  const percAderencia = ((totalDias - totalDesenquadrado) / totalDias) * 100;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row gap-4">
        {/* Card Principal da Timeline */}
        <Card className="flex-1 border-border shadow-sm overflow-hidden">
          <CardHeader className="pb-4 border-b border-border/50 bg-muted/5">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-primary" />
                  Histórico de Enquadramento
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Visualização diária da conformidade do fundo. Clique em um dia para ver as regras.
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs font-medium">
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>{percAderencia.toFixed(1)}% Aderência</span>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <TooltipProvider delayDuration={100}>
              <ScrollArea className="w-full whitespace-nowrap">
                <div className="flex p-6 min-w-full">
                  {monthsGrouped.map((group, groupIdx) => (
                    <div key={group.monthLabel} className="flex flex-col gap-3 mr-8 last:mr-0">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70 pl-1">
                        {group.monthLabel}
                      </span>
                      <div className="flex items-end gap-[3px] h-[60px]">
                        {group.days.map((day) => {
                          const isViolation = day.statusDetail === "violacao";
                          const isAlert = day.statusDetail === "alerta";
                          const isOk = day.status === "enquadrado";
                          const isActive = !!activeDate && day.dateStr === activeDate;

                          return (
                            <Tooltip key={day.dateStr}>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  aria-label={`Ver regras em ${format(day.date, "dd/MM/yyyy", { locale: ptBR })}`}
                                  onClick={() => handleDateClick(day.dateStr)}
                                  className={cn(
                                    "w-[6px] rounded-full transition-all duration-200 hover:scale-y-110 hover:w-[8px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
                                    isOk && "h-[25%] bg-emerald-400/50 hover:bg-emerald-500 hover:h-[40%]",
                                    isAlert && "h-[60%] bg-amber-400 hover:bg-amber-500 hover:h-[75%] shadow-[0_0_8px_-2px_rgba(251,191,36,0.6)]",
                                    isViolation && "h-[100%] bg-red-500 hover:bg-red-600 shadow-[0_0_10px_-2px_rgba(239,68,68,0.6)]",
                                    isActive && "ring-2 ring-primary ring-offset-1 ring-offset-background",
                                  )}
                                />
                              </TooltipTrigger>
                              <TooltipContent side="top" className="p-0 border-none bg-transparent shadow-xl">
                                <div className={cn(
                                  "flex flex-col gap-1 p-3 rounded-lg border text-xs min-w-[140px]",
                                  isOk ? "bg-card border-border" : 
                                  isViolation ? "bg-red-50 border-red-200 text-red-900" : 
                                  "bg-amber-50 border-amber-200 text-amber-900"
                                )}>
                                  <div className="font-bold border-b border-black/5 pb-1 mb-1">
                                    {format(day.date, "dd 'de' MMMM, yyyy", { locale: ptBR })}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {isOk ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : 
                                     isViolation ? <XCircle className="h-4 w-4 text-red-600" /> : 
                                     <AlertTriangle className="h-4 w-4 text-amber-600" />}
                                    <span className="font-semibold uppercase tracking-wide">
                                      {isOk ? "Enquadrado" : isViolation ? "Violação" : "Alerta"}
                                    </span>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground pt-1">
                                    Clique para ver as regras deste dia
                                  </span>
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <ScrollBar orientation="horizontal" className="h-2.5" />
              </ScrollArea>
            </TooltipProvider>
          </CardContent>
        </Card>

        {/* Card Lateral de Resumo de Problemas */}
        <Card className="w-full md:w-[300px] border-border shadow-sm flex flex-col">
          <CardHeader className="pb-3 bg-muted/5 border-b border-border/50">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <AlertOctagon className="h-4 w-4" />
              Ocorrências
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 p-0">
            {desenquadramentoPeriodos.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center p-6 text-center text-muted-foreground min-h-[150px]">
                <CheckCircle2 className="h-8 w-8 text-emerald-500/30 mb-2" />
                <p className="text-xs">Nenhum período de desenquadramento registrado.</p>
              </div>
            ) : (
              <ScrollArea className="h-[230px] md:h-full max-h-[350px]">
                <div className="divide-y divide-border/40">
                  {desenquadramentoPeriodos.map((p, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => handleDateClick(p.inicio)}
                      className="w-full p-3 hover:bg-muted/30 transition-colors flex items-start gap-3 text-left cursor-pointer focus-visible:outline-none focus-visible:bg-muted/40"
                    >
                      <div className={cn(
                        "mt-0.5 w-1.5 h-1.5 rounded-full shrink-0",
                        p.tipo === "violacao" ? "bg-red-500 shadow-[0_0_6px_-1px_rgba(239,68,68,0.8)]" : "bg-amber-500"
                      )} />
                      <div className="space-y-1 flex-1">
                        <div className="flex items-center justify-between">
                          <span className={cn(
                            "text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded",
                            p.tipo === "violacao" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
                          )}>
                            {p.tipo === "violacao" ? "Violação" : "Alerta"}
                          </span>
                          <span className="text-xs font-mono text-muted-foreground">
                            {p.dias} dia{p.dias > 1 ? "s" : ""}
                          </span>
                        </div>
                        <p className="text-xs text-foreground font-medium">
                          {format(parse(p.inicio, "yyyyMMdd", new Date()), "dd/MM", { locale: ptBR })} 
                          <span className="text-muted-foreground mx-1">até</span>
                          {format(parse(p.fim, "yyyyMMdd", new Date()), "dd/MM", { locale: ptBR })}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
