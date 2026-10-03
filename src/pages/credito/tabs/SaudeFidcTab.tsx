import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertTriangle, Info } from "lucide-react";
import { KpiCard } from "@/components/credito/matriz/KpiCard";
import { SectionHeader } from "@/components/credito/matriz/SectionHeader";
import { EvolutionCard, type EvolutionDataPoint } from "@/components/credito/matriz/EvolutionCard";
import {
  formatBRL, formatPct, formatTaxa, anualizarTaxaPctPoints,
  corSeveridade, type PeriodoSerie, type VisaoGeralKpis,
} from "@/lib/creditoMatriz";
import {
  computeScoreBreakdown, formatScorePontos, SCORE_DIMENSION_DOCS,
  type ScoreFundoDetalhe,
} from "@/lib/creditoScore";
import { buildAlertasExecutivos, severidadeStyles, type AlertaRisco, type ConcentracaoParte } from "@/lib/creditoAlertas";
import { useCreditoSerieMensal } from "@/hooks/useCreditoMatrizData";

type Props = {
  score: ScoreFundoDetalhe | null;
  alertas: AlertaRisco[];
  concentracao: ConcentracaoParte[];
  isLoadingScore: boolean;
  fund: string;
  /** Mesma fonte da aba Visão Geral — KPIs atuais na data-base */
  visaoGeral: VisaoGeralKpis | null;
  isLoadingVg: boolean;
  /** Taxa média mensal (pontos percentuais) da aba Safra, se disponível */
  taxaMediaMensal?: number | null;
};

function ScoreDimensionRow({ item }: { item: ReturnType<typeof computeScoreBreakdown>[0] }) {
  const doc = SCORE_DIMENSION_DOCS[item.key];
  return (
    <div className="flex items-center justify-between text-xs gap-2">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-muted-foreground flex items-center gap-1 cursor-help">
              {item.label}
              <Info className="h-3 w-3 shrink-0 opacity-60" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-xs text-xs leading-relaxed">
            <p className="font-semibold mb-1">{doc?.titulo ?? item.label}</p>
            <p>{doc?.formula}</p>
            <p className="mt-1 text-muted-foreground">Peso: {doc?.peso} · {doc?.referencia}</p>
            <p className="mt-1 italic">{doc?.interpretacaoZero}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span
        className={cn(
          "font-bold tabular-nums font-mono shrink-0",
          item.pontos < 0 ? "text-red-400" : item.pontos > 0 ? "text-emerald-400" : "text-muted-foreground",
        )}
      >
        {formatScorePontos(item.pontos)} pts
      </span>
    </div>
  );
}

function ScoreCard({ score }: { score: ScoreFundoDetalhe | null }) {
  if (!score) return null;
  const breakdown = computeScoreBreakdown(score);
  const faixaCls = score.faixa_score === "Excelente"
    ? "text-emerald-400"
    : score.faixa_score === "Bom"
      ? "text-blue-400"
      : score.faixa_score === "Atencao"
        ? "text-yellow-400"
        : "text-red-400";

  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Score de qualidade</CardTitle>
        <p className="text-[10px] text-muted-foreground">
          0–100 pts · pesos em credito_score_parametros · passe o mouse nas dimensões
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <span className={cn("text-4xl font-bold font-mono tabular-nums", faixaCls)}>
            {Math.round(score.score_qualidade)}
          </span>
          <div>
            <Badge variant="outline" className={cn("text-xs", faixaCls)}>
              {score.faixa_score}
            </Badge>
            <p className="text-[10px] text-muted-foreground mt-0.5">/ 100 pontos</p>
          </div>
        </div>
        <div className="space-y-1.5 border-t pt-2">
          {breakdown.map((item) => (
            <ScoreDimensionRow key={item.key} item={item} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AlertasBanner({ alertas, concentracao }: { alertas: AlertaRisco[]; concentracao: ConcentracaoParte[] }) {
  const cards = buildAlertasExecutivos(alertas, concentracao).slice(0, 5);
  if (cards.length === 0) return null;

  return (
    <div className="space-y-2">
      <SectionHeader title={`Alertas ativos (${cards.length})`} />
      {cards.map((card) => {
        const st = severidadeStyles(card.severidade);
        return (
          <div
            key={card.id}
            className={cn(
              "flex items-start justify-between gap-2 rounded-md border p-3",
              st.border, st.bg, st.texto,
            )}
          >
            <div className="space-y-0.5 min-w-0">
              <p className={cn("text-sm font-semibold", st.titulo)}>{card.titulo}</p>
              {card.labelParte && (
                <p className="text-xs">{card.labelParte}: <span className="font-medium">{card.nomeParte}</span></p>
              )}
              {card.valorDestaque && (
                <p className={cn("text-base font-bold tabular-nums font-mono", st.titulo)}>{card.valorDestaque}</p>
              )}
            </div>
            <Badge variant="outline" className="text-[10px] shrink-0">{card.fundo}</Badge>
          </div>
        );
      })}
    </div>
  );
}

function RetornoMedioCard({ taxaMensal }: { taxaMensal: number | null | undefined }) {
  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Retorno médio do crédito</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[10px] uppercase text-muted-foreground tracking-widest">Taxa média a.m.</p>
            <p className="text-xl font-bold font-mono text-blue-400 mt-0.5">
              {taxaMensal != null ? formatTaxa(taxaMensal) : "—"}
            </p>
            <p className="text-xs text-muted-foreground">ponderada por VP</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground tracking-widest">Taxa média a.a.</p>
            <p className="text-xl font-bold font-mono text-blue-400 mt-0.5">
              {taxaMensal != null ? formatTaxa(anualizarTaxaPctPoints(taxaMensal), 2) : "—"}
            </p>
            <p className="text-xs text-muted-foreground">composta (1+taxa/100)^12−1</p>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground border-t pt-2">
          Proxy: média ponderada de TX_RECEBIVEL / taxa_cessao sobre VP (pontos percentuais).
        </p>
      </CardContent>
    </Card>
  );
}

export function SaudeFidcTab({
  score, alertas, concentracao, isLoadingScore, fund,
  visaoGeral, isLoadingVg, taxaMediaMensal,
}: Props) {
  const [periodoProvisoes, setPeriodoProvisoes] = useState<PeriodoSerie>("12m");
  const [periodoInad, setPeriodoInad] = useState<PeriodoSerie>("12m");

  const { data: serieMensal = [], isLoading: isLoadingSerie } = useCreditoSerieMensal(fund, periodoProvisoes);
  const { data: serieInad = [], isLoading: isLoadingInad } = useCreditoSerieMensal(fund, periodoInad);

  const provisoesData = useMemo<EvolutionDataPoint[]>(
    () =>
      serieMensal.map((r) => ({
        mes_label: r.mes_referencia.substring(0, 7),
        valor_brl: r.provisao_total ?? null,
        pct: r.inadimplencia_pct ?? null,
      })),
    [serieMensal],
  );

  const inadData = useMemo<EvolutionDataPoint[]>(
    () =>
      serieInad.map((r) => ({
        mes_label: r.mes_referencia.substring(0, 7),
        valor_brl: r.provisao_total != null && r.over90_pct != null
          ? (r.provisao_total * r.over90_pct) / (r.inadimplencia_pct ?? 1)
          : null,
        pct: r.over90_pct ?? null,
      })),
    [serieInad],
  );

  const vg = visaoGeral;

  return (
    <div className="space-y-6">
      {/* KPIs atuais — mesma fonte da Visão Geral (data-base selecionada) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="Over90"
          value={vg?.pct_over90 != null ? formatPct(vg.pct_over90) : "—"}
          sub={vg ? formatBRL(vg.vp_over90) : undefined}
          variant={corSeveridade(vg?.pct_over90 ?? 0)}
          isLoading={isLoadingVg}
        />
        <KpiCard
          label="Inadimplência"
          value={vg?.pct_vencido != null ? formatPct(vg.pct_vencido) : "—"}
          sub={vg ? formatBRL(vg.vp_vencido) : undefined}
          variant={corSeveridade(vg?.pct_vencido ?? 0)}
          isLoading={isLoadingVg}
        />
        <KpiCard
          label="Provisão total"
          value={vg?.pdd_total != null ? formatBRL(vg.pdd_total) : "—"}
          sub={vg ? formatPct(vg.pct_pdd_carteira) : undefined}
          variant="neutral"
          isLoading={isLoadingVg}
        />
        <KpiCard
          label="Score de qualidade"
          value={score != null ? Math.round(score.score_qualidade) : "—"}
          sub={score?.faixa_score}
          variant={
            score == null
              ? "neutral"
              : score.score_qualidade >= 75
                ? "ok"
                : score.score_qualidade >= 60
                  ? "atencao"
                  : "critico"
          }
          isLoading={isLoadingScore}
        />
      </div>

      {/* Score + Alertas */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {isLoadingScore ? (
          <Skeleton className="h-48 w-full" />
        ) : score ? (
          <ScoreCard score={score} />
        ) : (
          <Card className="border-dashed border-border">
            <CardContent className="flex items-center justify-center h-48 text-muted-foreground text-sm">
              Execute Calcular para gerar o score de qualidade.
            </CardContent>
          </Card>
        )}
        <div>
          <AlertasBanner alertas={alertas} concentracao={concentracao} />
        </div>
      </div>

      {/* Evolution Cards — histórico mensal (snapshot ou fallback dos indicadores) */}
      <EvolutionCard
        title="Provisões da carteira"
        data={provisoesData}
        period={periodoProvisoes}
        onPeriodChange={setPeriodoProvisoes}
        isLoading={isLoadingSerie}
        emptyMessage={
          fund === "TODOS"
            ? "Selecione um fundo para ver a evolução mensal."
            : "Sem histórico neste período. Clique em Calcular em datas anteriores para montar a série (1 ponto por mês)."
        }
        barLabel="PDD (R$)"
        lineLabel="Inadimplência %"
        barColor="#f59e0b"
        lineColor="#dc2626"
      />
      <EvolutionCard
        title="Inadimplência da carteira"
        data={inadData}
        period={periodoInad}
        onPeriodChange={setPeriodoInad}
        isLoading={isLoadingInad}
        emptyMessage={
          fund === "TODOS"
            ? "Selecione um fundo para ver a evolução mensal."
            : "Sem histórico neste período. Clique em Calcular em datas anteriores para montar a série (1 ponto por mês)."
        }
        barLabel="Over90 (R$)"
        lineLabel="Over90 %"
        barColor="#dc2626"
        lineColor="#7c3aed"
      />

      <RetornoMedioCard taxaMensal={taxaMediaMensal} />
    </div>
  );
}

