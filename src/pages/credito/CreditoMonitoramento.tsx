import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Search, Loader2, RefreshCw, ChevronDown, CircleDollarSign, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  formatBRL, formatPct, formatPctPoints, formatDateBR,
  mapIndicadorRow, INDICADOR_EXTENDED_SELECT, INDICADOR_BASE_SELECT,
  isMissingColumnError, type IndicadorCreditoExtended,
} from "@/lib/creditoIndicadores";
import {
  buildAlertasExecutivos,
  severidadeStyles,
  type AlertaRisco,
  type ConcentracaoParte,
} from "@/lib/creditoAlertas";
import {
  computeScoreBreakdown,
  formatScorePontos,
  type ScoreFundoDetalhe,
} from "@/lib/creditoScore";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (t: string) => any };

function ScoreBadge({ faixa }: { faixa: string }) {
  const variant =
    faixa === "Excelente" ? "default" :
    faixa === "Bom" ? "secondary" :
    faixa === "Atencao" ? "outline" : "destructive";
  return <Badge variant={variant}>{faixa}</Badge>;
}

function AlertasExecutivosBanner({
  alertas,
  concentracao,
}: {
  alertas: AlertaRisco[];
  concentracao: ConcentracaoParte[];
}) {
  const cards = buildAlertasExecutivos(alertas, concentracao).slice(0, 5);
  if (cards.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          Alertas de Risco ({cards.length})
        </CardTitle>
        <CardDescription className="text-xs">
          Sinais automáticos de concentração, cobertura e deterioração da carteira.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {cards.map((card) => {
          const st = severidadeStyles(card.severidade);
          return (
            <div
              key={card.id}
              className={cn(
                "flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 rounded-md border p-3",
                st.border,
                st.bg,
                st.texto,
              )}
            >
              <div className="space-y-1 min-w-0">
                <p className={cn("text-sm font-semibold", st.titulo)}>{card.titulo}</p>
                {card.labelParte && card.nomeParte && (
                  <p className="text-xs">
                    <span className="font-medium">{card.labelParte}:</span>{" "}
                    {card.nomeParte}
                  </p>
                )}
                {card.valorDestaque && (
                  <p className={cn("text-base font-bold tracking-tight", st.titulo)}>
                    {card.valorDestaque}
                  </p>
                )}
                {card.limiteRecomendado && (
                  <p className={cn("text-xs", st.muted)}>{card.limiteRecomendado}</p>
                )}
              </div>
              <Badge variant="outline" className="text-[10px] shrink-0 self-start max-w-[220px] truncate">
                {card.fundo}
              </Badge>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ScoreCell({ score }: { score: ScoreFundoDetalhe | undefined }) {
  if (!score) return <>—</>;

  const breakdown = computeScoreBreakdown(score);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted/60 transition-colors cursor-pointer group"
          title="Ver composição do score"
        >
          <span className="font-bold">{Math.round(score.score_qualidade)}</span>
          <ScoreBadge faixa={score.faixa_score} />
          <ChevronDown className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <div className="space-y-3">
          <div className="flex items-baseline justify-between border-b pb-2">
            <span className="text-xs uppercase text-muted-foreground font-medium">Score</span>
            <div className="text-right">
              <span className="text-2xl font-bold">{Math.round(score.score_qualidade)}</span>
              <div className="mt-0.5">
                <ScoreBadge faixa={score.faixa_score} />
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            {breakdown.map((item) => (
              <div key={item.key} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{item.label}</span>
                <span
                  className={cn(
                    "font-bold tabular-nums",
                    item.pontos < 0 ? "text-red-600" : item.pontos > 0 ? "text-green-600" : "text-muted-foreground",
                  )}
                >
                  {formatScorePontos(item.pontos)} pts
                </span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Impacto vs. teto de cada componente. Pesos em <code>credito_score_parametros</code>.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TopConcentracaoTable({
  titulo,
  rows,
  labelColuna,
}: {
  titulo: string;
  rows: ConcentracaoParte[];
  labelColuna: string;
}) {
  const sorted = [...rows].sort((a, b) => (b.exposicao_over90 || 0) - (a.exposicao_over90 || 0));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{titulo}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead>{labelColuna}</TableHead>
                <TableHead className="text-right">R$</TableHead>
                <TableHead className="text-right">% Over90</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((c) => (
                <TableRow key={c.doc_parte}>
                  <TableCell className="font-medium max-w-[180px] truncate" title={c.nome_parte || c.doc_parte}>
                    {c.nome_parte || c.doc_parte}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatBRL(c.exposicao_over90)}
                  </TableCell>
                  <TableCell className="text-right font-bold tabular-nums">
                    {formatPct(c.pct_do_over90)}
                  </TableCell>
                </TableRow>
              ))}
              {sorted.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground py-6">
                    Sem dados
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

async function fetchIndicadores(date: string): Promise<IndicadorCreditoExtended[]> {
  const { data, error } = await supabase
    .from("credito_estoque_indicadores")
    .select(INDICADOR_EXTENDED_SELECT)
    .eq("data_referencia", date)
    .order("criado_em", { ascending: false })
    .order("nome_fundo", { ascending: true });

  if (error) {
    if (!isMissingColumnError(error, ["pl", "coverage_npl", "aderencia_pdd", "delta_over90"])) {
      throw error;
    }
    const fallback = await supabase
      .from("credito_estoque_indicadores")
      .select(INDICADOR_BASE_SELECT)
      .eq("data_referencia", date)
      .order("criado_em", { ascending: false })
      .order("nome_fundo", { ascending: true });
    if (fallback.error) throw fallback.error;
    return (fallback.data || []).map((r) => mapIndicadorRow(r as Record<string, unknown>));
  }
  return (data || []).map((r) => mapIndicadorRow(r as Record<string, unknown>));
}

export default function CreditoMonitoramento() {
  const [search, setSearch] = useState("");
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [isCalculating, setIsCalculating] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: calculatedDates = [], isLoading: loadingDates } = useQuery({
    queryKey: ["credito-indicadores-dates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("credito_estoque_indicadores")
        .select("data_referencia")
        .order("data_referencia", { ascending: false })
        .limit(5000);
      if (error) throw error;
      return Array.from(new Set((data || []).map((d) => d.data_referencia).filter(Boolean))) as string[];
    },
  });

  const { data: estoqueImportDates = [] } = useQuery({
    queryKey: ["estoque-fidc-import-dates"],
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("importacoes_estoque_fidc")
          .select("reference_date")
          .in("status", ["success", "partial_success"])
          .order("reference_date", { ascending: false })
          .limit(500);
        if (error) return [] as string[];
        return Array.from(new Set((data || []).map((d) => d.reference_date).filter(Boolean))) as string[];
      } catch {
        return [] as string[];
      }
    },
  });

  const allDates = useMemo(() => {
    const set = new Set([...calculatedDates, ...estoqueImportDates]);
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [calculatedDates, estoqueImportDates]);

  const effectiveDate = selectedDate || allDates[0] || "";

  const { data: indicadores = [], isLoading } = useQuery({
    queryKey: ["credito-indicadores", effectiveDate],
    enabled: !!effectiveDate,
    queryFn: () => fetchIndicadores(effectiveDate),
  });

  const consolidado = useMemo(
    () => indicadores.find((i) => i.nome_fundo === "CONSOLIDADO") ?? null,
    [indicadores],
  );

  const latestImportId = useMemo(
    () => consolidado?.import_id ?? indicadores[0]?.import_id ?? null,
    [consolidado, indicadores],
  );

  const rows = useMemo(() => {
    const base = indicadores.filter(
      (i) => i.nome_fundo !== "CONSOLIDADO" && (!latestImportId || i.import_id === latestImportId),
    );
    if (!search.trim()) return base;
    const term = search.toLowerCase();
    return base.filter(
      (r) =>
        r.nome_fundo.toLowerCase().includes(term) ||
        (r.doc_fundo || "").includes(term.replace(/\D/g, "")),
    );
  }, [indicadores, search, latestImportId]);

  const hasEstoqueForDate = effectiveDate ? estoqueImportDates.includes(effectiveDate) : false;
  const isDateCalculated = effectiveDate ? calculatedDates.includes(effectiveDate) : false;

  const { data: alertas = [] } = useQuery({
    queryKey: ["credito-alertas-risco", effectiveDate],
    enabled: !!effectiveDate,
    queryFn: async () => {
      try {
        const { data, error } = await db
          .from("vw_credito_alertas_risco")
          .select("*")
          .eq("data_referencia", effectiveDate)
          .limit(50);
        if (error) return [] as AlertaRisco[];
        return (data ?? []) as AlertaRisco[];
      } catch {
        return [] as AlertaRisco[];
      }
    },
  });

  const { data: scores = [] } = useQuery({
    queryKey: ["credito-score-fundo"],
    queryFn: async () => {
      try {
        const { data, error } = await db.from("vw_credito_score_fundo").select("*");
        if (error) return [] as ScoreFundoDetalhe[];
        return (data ?? []) as ScoreFundoDetalhe[];
      } catch {
        return [] as ScoreFundoDetalhe[];
      }
    },
  });

  const scoreByFundo = useMemo(() => {
    const m = new Map<string, ScoreFundoDetalhe>();
    scores.forEach((s) => m.set(s.nome_fundo, s));
    return m;
  }, [scores]);

  const { data: concentracao = [] } = useQuery({
    queryKey: ["credito-concentracao", effectiveDate],
    enabled: !!effectiveDate,
    queryFn: async () => {
      try {
        const { data, error } = await db
          .from("vw_credito_concentracao_over90")
          .select("*")
          .eq("data_referencia", effectiveDate)
          .lte("ranking", 10)
          .order("ranking", { ascending: true });
        if (error) return [] as ConcentracaoParte[];
        return (data ?? []) as ConcentracaoParte[];
      } catch {
        return [] as ConcentracaoParte[];
      }
    },
  });

  const handleCalcular = async () => {
    if (!effectiveDate) {
      toast({ title: "Selecione uma data antes de calcular.", variant: "destructive" });
      return;
    }
    if (!hasEstoqueForDate) {
      toast({
        title: "Sem dados de estoque",
        description: `Não há importação de estoque FIDC para ${formatDateBR(effectiveDate)}.`,
        variant: "destructive",
      });
      return;
    }
    setIsCalculating(true);
    try {
      const { data, error } = await supabase.functions.invoke("calcular-credito", {
        body: { data_referencia: effectiveDate },
      });
      if (error) throw new Error(error.message || "Falha ao invocar calcular-credito");
      if (!data?.success) throw new Error(data?.error || "Erro desconhecido no cálculo");
      toast({
        title: "Indicadores calculados",
        description: `${data.fundos_calculados} fundo(s) para ${formatDateBR(effectiveDate)}.`,
      });
      await queryClient.invalidateQueries({ queryKey: ["credito-indicadores"] });
      await queryClient.invalidateQueries({ queryKey: ["credito-indicadores-dates"] });
      await queryClient.invalidateQueries({ queryKey: ["credito-alertas-risco"] });
      await queryClient.invalidateQueries({ queryKey: ["credito-concentracao"] });
      await queryClient.invalidateQueries({ queryKey: ["credito-score-fundo"] });
    } catch (err) {
      toast({
        title: "Erro no cálculo",
        description: err instanceof Error ? err.message : "Erro desconhecido",
        variant: "destructive",
      });
    } finally {
      setIsCalculating(false);
    }
  };

  const topCedentes = concentracao.filter((c) => c.tipo_parte === "cedente").slice(0, 10);
  const topSacados = concentracao.filter((c) => c.tipo_parte === "sacado").slice(0, 10);

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight uppercase flex items-center gap-2">
              <CircleDollarSign className="h-5 w-5 text-primary" />
              Monitoramento - Risco de Crédito
            </h1>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mt-1">
              Buckets canônicos · Over90 = 91–180 + 180+ · Recovery Rate indisponível (sem fluxo de caixa)
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
            <Select value={effectiveDate} onValueChange={setSelectedDate} disabled={loadingDates || allDates.length === 0}>
              <SelectTrigger className="w-[180px] h-8 text-xs">
                <SelectValue placeholder="Data-base" />
              </SelectTrigger>
              <SelectContent>
                {allDates.map((d) => (
                  <SelectItem key={d} value={d}>
                    {formatDateBR(d)}
                    {!calculatedDates.includes(d) && <span className="ml-1 text-amber-500 text-[10px]">●</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant={isDateCalculated ? "outline" : "default"}
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={handleCalcular}
              disabled={isCalculating || !effectiveDate}
              title={
                !hasEstoqueForDate
                  ? "Nenhum estoque importado para esta data"
                  : isDateCalculated
                  ? "Recalcular indicadores para esta data"
                  : "Calcular indicadores para esta data"
              }
            >
              {isCalculating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {isCalculating ? "Calculando..." : isDateCalculated ? "Recalcular" : "Calcular"}
            </Button>
          </div>
        </div>

        {effectiveDate && hasEstoqueForDate && !isDateCalculated && (
          <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              <span className="font-semibold">Estoque disponível</span> — clique em{" "}
              <strong>Calcular</strong> para gerar aging e PDD em {formatDateBR(effectiveDate)}.
            </span>
          </div>
        )}

        {alertas.length > 0 && (
          <AlertasExecutivosBanner alertas={alertas} concentracao={concentracao} />
        )}

        {/* Camada executiva — KPIs topo */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Carteira</CardTitle></CardHeader>
            <CardContent className="text-lg font-bold">{formatBRL(consolidado?.carteira_total || 0)}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Over90</CardTitle></CardHeader>
            <CardContent>
              <p className="text-lg font-bold">{formatPct(consolidado?.over90 || 0)}</p>
              {consolidado?.delta_over90 != null && (
                <p className="text-[10px] text-muted-foreground">{formatPctPoints(consolidado.delta_over90)} vs ant.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Over180</CardTitle></CardHeader>
            <CardContent>
              <p className="text-lg font-bold">{formatPct(consolidado?.over180 || 0)}</p>
              {consolidado?.delta_over180 != null && (
                <p className="text-[10px] text-muted-foreground">{formatPctPoints(consolidado.delta_over180)} vs ant.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Aderência PDD</CardTitle></CardHeader>
            <CardContent className="text-lg font-bold">{formatPct(consolidado?.aderencia_pdd || 0)}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Gap (R$)</CardTitle></CardHeader>
            <CardContent className="text-lg font-bold">{formatBRL(consolidado?.gap_total || 0)}</CardContent>
          </Card>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por fundo ou CNPJ..."
            className="pl-9 h-8 text-xs"
          />
        </div>

        {isLoading ? (
          <div className="py-16 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <Tabs defaultValue="risco" className="space-y-3">
            <TabsList className="h-8">
              <TabsTrigger value="contabil" className="text-xs">Contábil</TabsTrigger>
              <TabsTrigger value="risco" className="text-xs">Risco</TabsTrigger>
              <TabsTrigger value="executivo" className="text-xs">Executivo</TabsTrigger>
            </TabsList>

            <TabsContent value="contabil">
              <div className="bg-card border border-border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader className="bg-muted/30">
                    <TableRow>
                      <TableHead>Fundo</TableHead>
                      <TableHead className="text-right">PDD Atual</TableHead>
                      <TableHead className="text-right">PDD Modelo</TableHead>
                      <TableHead className="text-right">Coverage Reg.</TableHead>
                      <TableHead className="text-right">Aderência PDD</TableHead>
                      <TableHead className="text-right">Gap (R$)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={`${r.nome_fundo}-cont`}>
                        <TableCell className="font-medium">{r.nome_fundo}</TableCell>
                        <TableCell className="text-right">{formatBRL(r.pdd_atual_total)}</TableCell>
                        <TableCell className="text-right">{formatBRL(r.pdd_modelo_total)}</TableCell>
                        <TableCell className="text-right">{formatPct(r.coverage_vencidos)}</TableCell>
                        <TableCell className="text-right">{formatPct(r.aderencia_pdd)}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={r.gap_total > 0 ? "destructive" : "outline"}>{formatBRL(r.gap_total)}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="risco">
              <div className="bg-card border border-border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader className="bg-muted/30">
                    <TableRow>
                      <TableHead>Fundo</TableHead>
                      <TableHead className="text-right">Over90</TableHead>
                      <TableHead className="text-right">Over180</TableHead>
                      <TableHead className="text-right">Coverage NPL</TableHead>
                      <TableHead className="text-right">PDD/PL</TableHead>
                      <TableHead className="text-right">Score</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => {
                      const sc = scoreByFundo.get(r.nome_fundo);
                      return (
                        <TableRow key={`${r.nome_fundo}-risco`}>
                          <TableCell className="font-medium">{r.nome_fundo}</TableCell>
                          <TableCell className="text-right">{formatPct(r.over90)}</TableCell>
                          <TableCell className="text-right">{formatPct(r.over180)}</TableCell>
                          <TableCell className={`text-right ${r.coverage_npl < 0.8 ? "text-red-600 font-bold" : ""}`}>
                            {formatPct(r.coverage_npl)}
                          </TableCell>
                          <TableCell className="text-right">{formatPct(r.pdd_sobre_pl)}</TableCell>
                          <TableCell className="text-right">
                            <ScoreCell score={sc} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {(topCedentes.length > 0 || topSacados.length > 0) && (
                <div className="grid md:grid-cols-2 gap-4 mt-4">
                  <TopConcentracaoTable
                    titulo="Top Cedentes Over90"
                    labelColuna="Cedente"
                    rows={topCedentes}
                  />
                  <TopConcentracaoTable
                    titulo="Top Sacados Over90"
                    labelColuna="Sacado"
                    rows={topSacados}
                  />
                </div>
              )}
            </TabsContent>

            <TabsContent value="executivo">
              <div className="bg-card border border-border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader className="bg-muted/30">
                    <TableRow>
                      <TableHead>Fundo</TableHead>
                      <TableHead className="text-right">Δ Over90</TableHead>
                      <TableHead className="text-right">Δ Over180</TableHead>
                      <TableHead className="text-right">Impacto Prov. PL</TableHead>
                      <TableHead className="text-right">Score</TableHead>
                      <TableHead className="text-right">Faixa</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => {
                      const sc = scoreByFundo.get(r.nome_fundo);
                      return (
                        <TableRow key={`${r.nome_fundo}-exec`}>
                          <TableCell className="font-medium">{r.nome_fundo}</TableCell>
                          <TableCell className={`text-right ${(r.delta_over90 ?? 0) > 0.02 ? "text-red-600 font-bold" : ""}`}>
                            {formatPctPoints(r.delta_over90)}
                          </TableCell>
                          <TableCell className={`text-right ${(r.delta_over180 ?? 0) > 0 ? "text-red-600" : ""}`}>
                            {formatPctPoints(r.delta_over180)}
                          </TableCell>
                          <TableCell className={`text-right ${r.impacto_stress_pl > 0.005 ? "text-red-600 font-bold" : ""}`}>
                            {formatPct(r.impacto_stress_pl)}
                          </TableCell>
                          <TableCell className="text-right">
                            <ScoreCell score={sc} />
                          </TableCell>
                          <TableCell className="text-right">{sc ? <ScoreBadge faixa={sc.faixa_score} /> : "—"}</TableCell>
                        </TableRow>
                      );
                    })}
                    {rows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                          {effectiveDate && hasEstoqueForDate && !isDateCalculated
                            ? 'Clique em "Calcular" para processar os dados.'
                            : "Nenhum dado para a data selecionada."}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <p className="text-[10px] text-muted-foreground mt-2">
                Recovery Rate não disponível nesta versão — requer dados transacionais de liquidação.
                Melhoria de faixa ≠ recuperação econômica.
              </p>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </Layout>
  );
}
