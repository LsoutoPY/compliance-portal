import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  PieChart,
  Pie,
  Cell,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { KpiCard } from "@/components/credito/matriz/KpiCard";
import { SectionHeader } from "@/components/credito/matriz/SectionHeader";
import { formatBRL, formatPct, corSeveridade, FAIXAS_VENCIMENTO } from "@/lib/creditoMatriz";
import type { VisaoGeralKpis, ConcentracaoCedenteRow } from "@/lib/creditoMatriz";
import { JANELAS_VENCIMENTO } from "@/lib/creditoVencimentos";
import { VencimentosDetalhePanel } from "@/components/credito/matriz/VencimentosDetalhePanel";

type Props = {
  fund: string;
  date: string;
  visaoGeral: VisaoGeralKpis | null;
  concentracao: ConcentracaoCedenteRow[];
  plTotal: number | null;
  isLoadingVg: boolean;
  isLoadingConc: boolean;
  isLoadingPl: boolean;
  errorVg: Error | null;
  errorConc: Error | null;
};

const COMPOSICAO_COLORS = ["#16a34a", "#eab308", "#ea580c", "#991b1b"];

const COMPOSICAO_LABELS = [
  "Adimplente",
  "Vencido ≤ 90d",
  "Vencido 91-180d",
  "Write-off > 180d",
] as const;

function formatBRLCompact(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${Math.round(v / 1_000)}k`;
  return formatBRL(v);
}

function truncateNome(nome: string, max = 28): string {
  if (!nome || nome.length <= max) return nome || "—";
  return `${nome.slice(0, max - 1)}…`;
}

function buildComposicao(vg: VisaoGeralKpis | null, vpTotal: number) {
  if (!vg || vpTotal <= 0) return { segments: [], pctAdimplente: 0 };

  const adimplente = vg.vp_comp_adimplente ?? vg.vp_a_vencer ?? 0;
  const segments = [
    { name: COMPOSICAO_LABELS[0], value: adimplente, color: COMPOSICAO_COLORS[0] },
    { name: COMPOSICAO_LABELS[1], value: vg.vp_comp_vencido_ate_90 ?? 0, color: COMPOSICAO_COLORS[1] },
    { name: COMPOSICAO_LABELS[2], value: vg.vp_comp_vencido_91_180 ?? 0, color: COMPOSICAO_COLORS[2] },
    { name: COMPOSICAO_LABELS[3], value: vg.vp_writeoff ?? 0, color: COMPOSICAO_COLORS[3] },
  ]
    .filter((s) => s.value > 0)
    .map((s) => ({ ...s, pct: s.value / vpTotal }));

  return { segments, pctAdimplente: adimplente / vpTotal };
}

function buildVencimentoData(vg: VisaoGeralKpis | null, plTotal: number | null) {
  if (!vg) return [];

  const janelas: { name: string; janela: number }[] = FAIXAS_VENCIMENTO.map((f) => ({
    name: f.label,
    janela: (vg[f.key as keyof VisaoGeralKpis] as number) ?? 0,
  }));

  const somaJanelas = janelas.reduce((s, d) => s + d.janela, 0);
  const acima6m = vg.vp_vence_acima_6_meses ?? Math.max(0, (vg.vp_a_vencer ?? 0) - somaJanelas);
  if (acima6m > 0) janelas.push({ name: "> 6 meses", janela: acima6m });

  let acumulado = 0;
  return janelas.map((d) => {
    acumulado += d.janela;
    return {
      ...d,
      acumulado,
      pctCarteira: vg.vp_total > 0 ? d.janela / vg.vp_total : 0,
      pctPl: plTotal && plTotal > 0 ? d.janela / plTotal : null,
    };
  });
}

type ProjecaoRow = ReturnType<typeof buildVencimentoData>[number];
type ProjecaoProps = { data: ProjecaoRow[]; onSelect: (row: ProjecaoRow) => void };

function ProjecaoResumo({ data, onSelect }: ProjecaoProps) {
  return (
    <div className="mt-3 overflow-x-auto rounded-md border">
      <table className="w-full min-w-[720px] text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Janela</th>
            <th className="px-3 py-2 text-right font-medium">VP</th>
            <th className="px-3 py-2 text-right font-medium">% carteira</th>
            <th className="px-3 py-2 text-right font-medium">% PL</th>
            <th className="px-3 py-2 text-right font-medium">Acumulado</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.name} className="cursor-pointer border-t border-border/70 hover:bg-muted/50" onClick={() => onSelect(row)}>
              <td className="px-3 font-medium">
                <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded text-left text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Ver vencimentos: ${row.name}`} onClick={(event) => { event.stopPropagation(); onSelect(row); }}>
                  {row.name}<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{formatBRL(row.janela)}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{formatPct(row.pctCarteira, 1)}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{row.pctPl != null ? formatPct(row.pctPl, 1) : "—"}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{formatBRL(row.acumulado)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResumoBox({
  label,
  valor,
  pct,
  variant,
}: {
  label: string;
  valor: number;
  pct: number;
  variant: "ok" | "critico";
}) {
  return (
    <div
      className={cn(
        "flex-1 rounded-md border px-3 py-2.5 min-w-0",
        variant === "ok"
          ? "border-blue-500/40 bg-blue-500/5"
          : "border-red-500/40 bg-red-500/5",
      )}
    >
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">{label}</p>
      <p className="text-lg font-bold font-mono tabular-nums mt-0.5 truncate">{formatBRL(valor)}</p>
      <p
        className={cn(
          "text-xs font-mono mt-0.5",
          variant === "ok" ? "text-blue-400/90" : "text-red-400/90",
        )}
      >
        {formatPct(pct, 1)} da carteira
      </p>
    </div>
  );
}

function ComposicaoCard({
  vg,
  vpTotal,
  segments,
  pctAdimplente,
  isLoading,
}: {
  vg: VisaoGeralKpis | null;
  vpTotal: number;
  segments: ReturnType<typeof buildComposicao>["segments"];
  pctAdimplente: number;
  isLoading: boolean;
}) {
  const vpAVencer = vg?.vp_a_vencer ?? 0;
  const vpVencido = Math.max(0, vpTotal - vpAVencer);
  const pctVencido = vpTotal > 0 ? vpVencido / vpTotal : 0;

  return (
    <div className="rounded-lg border border-border p-4 h-full flex flex-col">
      <SectionHeader
        title="Composição da carteira por severidade"
        description="Adimplente / Vencido ≤90d / Vencido 91-180d / Write-off >180d — soma 100%"
      />

      {isLoading ? (
        <Skeleton className="flex-1 min-h-[320px] w-full rounded-md" />
      ) : segments.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-12 flex-1">Sem dados de composição.</p>
      ) : (
        <div className="flex flex-col flex-1 gap-4">
          {/* Caixas A VENCER / VENCIDO */}
          <div className="flex gap-3">
            <ResumoBox label="A vencer" valor={vpAVencer} pct={pctAdimplente} variant="ok" />
            <ResumoBox label="Vencido" valor={vpVencido} pct={pctVencido} variant="critico" />
          </div>

          {/* Donut com rótulo central */}
          <div className="relative flex-1 min-h-[200px]">
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={segments}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={58}
                  outerRadius={82}
                  paddingAngle={2}
                  stroke="hsl(var(--background))"
                  strokeWidth={2}
                >
                  {segments.map((seg) => (
                    <Cell key={seg.name} fill={seg.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "6px",
                    fontSize: 12,
                  }}
                  formatter={(value: number, _name: string, props: { payload?: { pct?: number } }) => [
                    `${formatBRL(value)} (${formatPct(props.payload?.pct ?? 0, 1)})`,
                    "VP",
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none pb-1">
              <span className="text-2xl font-bold font-mono tabular-nums text-emerald-400">
                {formatPct(pctAdimplente, 1)}
              </span>
              <span className="text-[11px] text-muted-foreground">adimplente</span>
            </div>
          </div>

          {/* Legenda abaixo */}
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 pt-1">
            {segments.map((seg) => (
              <div key={seg.name} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: seg.color }} />
                {seg.name} ({formatPct(seg.pct, 1)})
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ConcentracaoCedenteCard({
  rows,
  isLoading,
  error,
}: {
  rows: ConcentracaoCedenteRow[];
  isLoading: boolean;
  error: Error | null;
}) {
  const top5 = rows.slice(0, 5);
  const pctTop5 = top5.reduce((s, r) => s + r.pct_vp_total, 0);
  const maxPct = top5[0]?.pct_vp_total ?? 1;

  return (
    <div className="rounded-lg border border-border p-4 h-full flex flex-col">
      <SectionHeader
        title="Concentração por cedente"
        description={`Top ${top5.length} cedente${top5.length !== 1 ? "s" : ""} por valor presente`}
      />

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : isLoading ? (
        <Skeleton className="flex-1 min-h-[320px] w-full rounded-md" />
      ) : top5.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-12 flex-1">Sem dados de cedentes.</p>
      ) : (
        <div className="flex flex-col flex-1 gap-3">
          <div className="space-y-3 flex-1">
            {top5.map((r, i) => {
              const isCritico = i === 0 && r.pct_vp_total >= 0.25;
              const barPct = maxPct > 0 ? (r.pct_vp_total / maxPct) * 100 : 0;
              return (
                <div key={r.doc_cedente} className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-medium text-foreground" title={r.nome_cedente}>
                      {truncateNome(r.nome_cedente)}
                    </span>
                    <span
                      className={cn(
                        "font-mono font-semibold shrink-0 tabular-nums",
                        isCritico ? "text-red-400" : "text-foreground",
                      )}
                    >
                      {formatPct(r.pct_vp_total, 1)}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
                    <div
                      className={cn("h-full rounded-full transition-all", isCritico ? "bg-red-500" : "bg-blue-500")}
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground border-t border-border pt-3 text-center">
            Top 5 concentram <span className="font-mono font-semibold text-foreground">{formatPct(pctTop5, 1)}</span> do VP total
          </p>
        </div>
      )}
    </div>
  );
}

function ProjecaoVencimentosChart({ data, onSelect }: ProjecaoProps) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tickFormatter={formatBRLCompact}
          tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "6px",
            fontSize: 12,
          }}
          formatter={(value: number, name: string) => [
            formatBRL(value),
            name === "janela" ? "Nessa janela" : "Acumulado",
          ]}
        />
        <Legend
          iconSize={10}
          wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          formatter={(value) => (value === "janela" ? "Nessa janela" : "Acumulado")}
        />
        <Bar dataKey="janela" name="janela" fill="#2563eb" radius={[3, 3, 0, 0]} maxBarSize={40}
          cursor="pointer" onClick={(_entry, index) => { if (data[index]) onSelect(data[index]); }} />
        <Line
          type="monotone"
          dataKey="acumulado"
          name="acumulado"
          stroke="#16a34a"
          strokeWidth={2}
          dot={{ r: 3, fill: "#16a34a" }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function VisaoGeralTab({
  fund,
  date,
  visaoGeral,
  concentracao,
  plTotal,
  isLoadingVg,
  isLoadingConc,
  isLoadingPl,
  errorVg,
  errorConc,
}: Props) {
  const [selecionada, setSelecionada] = useState<ProjecaoRow | null>(null);
  const vg = visaoGeral;
  const vpTotal = vg?.vp_total ?? 0;
  const { segments: composicaoData, pctAdimplente } = useMemo(
    () => buildComposicao(vg, vpTotal),
    [vg, vpTotal],
  );
  const vencimentoData = useMemo(() => buildVencimentoData(vg, plTotal), [vg, plTotal]);
  const janelaSelecionada = JANELAS_VENCIMENTO.find((j) => j.label === selecionada?.name);

  if (errorVg) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>Erro ao carregar visão geral: {errorVg.message}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {/* KPIs resumo */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard
          label="VP Total"
          value={isLoadingVg ? <Skeleton className="h-7 w-28" /> : formatBRL(vpTotal)}
          variant="neutral"
        />
        <KpiCard
          label="VP Adimplente"
          value={formatBRL(vg?.vp_a_vencer ?? 0)}
          sub={`${vg?.qtd_a_vencer ?? 0} títulos`}
          variant="ok"
          isLoading={isLoadingVg}
        />
        <KpiCard
          label="VP Vencido"
          value={formatBRL(vg?.vp_vencido ?? 0)}
          sub={formatPct(vg?.pct_vencido)}
          variant={corSeveridade(vg?.pct_vencido ?? 0)}
          isLoading={isLoadingVg}
        />
        <KpiCard
          label="PDD Total"
          value={formatBRL(vg?.pdd_total ?? 0)}
          sub={formatPct(vg?.pct_pdd_carteira)}
          variant={corSeveridade(vg?.pct_pdd_carteira ?? 0)}
          isLoading={isLoadingVg}
        />
        <KpiCard
          label="PL do fundo / classe"
          value={plTotal != null ? formatBRL(plTotal) : "—"}
          sub={plTotal && vpTotal > 0 ? `${formatPct(vpTotal / plTotal, 1)} em crédito` : "Snapshot de rentabilidade"}
          variant="neutral"
          isLoading={isLoadingPl}
        />
      </div>

      {/* Composição | Concentração — lado a lado */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ComposicaoCard
          vg={vg}
          vpTotal={vpTotal}
          segments={composicaoData}
          pctAdimplente={pctAdimplente}
          isLoading={isLoadingVg}
        />
        <ConcentracaoCedenteCard
          rows={concentracao}
          isLoading={isLoadingConc}
          error={errorConc}
        />
      </div>

      {/* Projeção de vencimentos — largura total */}
      <div className="rounded-lg border border-border p-4">
        <SectionHeader
          title="Projeção de vencimentos"
          description="Valor presente dos recebíveis a vencer por prazo — barra = janela, linha = acumulado. Clique em uma barra ou janela da tabela para ver cedentes, vencimentos e valores."
        />
        {isLoadingVg ? (
          <Skeleton className="h-[240px] w-full rounded-md" />
        ) : vencimentoData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-12">Sem projeção disponível.</p>
        ) : (
          <>
            <ProjecaoVencimentosChart data={vencimentoData} onSelect={setSelecionada} />
            <ProjecaoResumo data={vencimentoData} onSelect={setSelecionada} />
          </>
        )}
      </div>
      {selecionada && janelaSelecionada && date && (
        <VencimentosDetalhePanel
          key={`${fund}:${date}:${janelaSelecionada.key}`}
          fund={fund} date={date} janela={janelaSelecionada}
          vpProjetado={vencimentoData.find((r) => r.name === selecionada.name)?.janela ?? 0}
          onClose={() => setSelecionada(null)}
        />
      )}
    </div>
  );
}
