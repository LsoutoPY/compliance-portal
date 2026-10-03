import { cn } from "@/lib/utils";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Info } from "lucide-react";
import { KpiCard } from "@/components/credito/matriz/KpiCard";
import { MatrizTable, type MatrizColDef } from "@/components/credito/matriz/MatrizTable";
import { SectionHeader } from "@/components/credito/matriz/SectionHeader";
import {
  formatBRL, formatPct, formatTaxa, formatPrazoDias,
  corSeveridade, SEVERITY_CLASSES,
} from "@/lib/creditoMatriz";
import type { SafraEmissaoRow, SafraEmissaoMetricas } from "@/lib/creditoMatriz";

type Props = {
  safras: SafraEmissaoRow[];
  metricas: SafraEmissaoMetricas | null;
  isLoadingSafras: boolean;
  isLoadingMetricas: boolean;
  errorSafras: Error | null;
};

function safraStatusBadge(status: SafraEmissaoRow["status_cohort"]) {
  const cls = SEVERITY_CLASSES[status === "critico" ? "critico" : status === "atencao" ? "atencao" : "ok"];
  const labels = { ok: "Saudável", atencao: "Atenção", critico: "Crítico" };
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold", cls.badge)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", cls.dot)} />
      {labels[status]}
    </span>
  );
}

const safraCols: MatrizColDef<SafraEmissaoRow>[] = [
  {
    key: "safra",
    header: "Safra (emissão)",
    cell: (r) => <span className="font-mono font-medium">{r.safra_label}</span>,
    cellClass: "min-w-[110px]",
  },
  {
    key: "qtd",
    header: "Qtd",
    cell: (r) => <span className="font-mono text-right">{r.qtd_titulos.toLocaleString("pt-BR")}</span>,
    cellClass: "text-right",
    headerClass: "text-right",
  },
  {
    key: "vn",
    header: "VN",
    cell: (r) => <span className="font-mono">{formatBRL(r.vn_total)}</span>,
    cellClass: "text-right",
    headerClass: "text-right",
  },
  {
    key: "taxa",
    header: "Taxa Média",
    cell: (r) => (
      <span className="font-mono text-blue-400">
        {formatTaxa(r.taxa_media_cessao)}
      </span>
    ),
    cellClass: "text-right",
    headerClass: "text-right",
  },
  {
    key: "pct_vencido",
    header: "% Vencido",
    cell: (r) => (
      <span className={cn(
        "font-mono font-semibold",
        corSeveridade(r.pct_vencido_cohort) === "critico"
          ? "text-red-400"
          : corSeveridade(r.pct_vencido_cohort) === "atencao"
            ? "text-yellow-400"
            : "text-emerald-400",
      )}>
        {formatPct(r.pct_vencido_cohort)}
      </span>
    ),
    cellClass: "text-right",
    headerClass: "text-right",
  },
  {
    key: "status",
    header: "Status",
    cell: (r) => safraStatusBadge(r.status_cohort),
    cellClass: "text-right",
    headerClass: "text-right",
  },
];

export function SafraTab({ safras, metricas, isLoadingSafras, isLoadingMetricas, errorSafras }: Props) {
  if (errorSafras) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>Erro ao carregar safras: {errorSafras.message}</AlertDescription>
      </Alert>
    );
  }

  const chartData = safras.map((s) => ({
    safra: s.safra_label,
    taxa: s.taxa_media_cessao,
    pct_vencido: s.pct_vencido_cohort * 100,
  }));

  return (
    <div className="space-y-6">
      {/* Cards de métricas */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <KpiCard
          label="Prazo médio de recebimento"
          value={formatPrazoDias(metricas?.prazo_medio_recebimento_dias)}
          sub={
            metricas?.prazo_medio_recebimento_dias != null
              ? `${Math.round(metricas.prazo_medio_recebimento_dias)} dias (só A VENCER)`
              : undefined
          }
          variant="neutral"
          isLoading={isLoadingMetricas}
        />
        <KpiCard
          label="Taxa média (mensal)"
          value={formatTaxa(metricas?.taxa_media_mensal)}
          sub="% a.m. ponderada por VP"
          variant="info"
          isLoading={isLoadingMetricas}
          tooltip={
            <div className="space-y-2">
              <p className="font-semibold">Taxa média mensal ponderada</p>
              <p>Considera apenas títulos com taxa informada e pondera cada taxa pelo seu valor presente (VP).</p>
              <p className="rounded bg-muted px-2 py-1 font-mono text-[11px]">Σ (taxa mensal × VP) ÷ Σ (VP com taxa)</p>
              <p className="text-muted-foreground">Títulos sem taxa não entram no denominador, evitando diluir a média.</p>
            </div>
          }
        />
        <KpiCard
          label="Taxa média (anualizada)"
          value={formatTaxa(metricas?.taxa_media_anualizada, 2)}
          sub="% a.a. composta"
          variant="info"
          isLoading={isLoadingMetricas}
          tooltip={
            <div className="space-y-2">
              <p className="font-semibold">Taxa anualizada composta</p>
              <p>Converte a taxa mensal ponderada em taxa efetiva anual, com capitalização mensal.</p>
              <p className="rounded bg-muted px-2 py-1 font-mono text-[11px]">[(1 + taxa mensal ÷ 100)¹² − 1] × 100</p>
              <p className="text-muted-foreground">Exemplo: 0,2506% a.m. resulta em aproximadamente 3,05% a.a.</p>
            </div>
          }
        />
      </div>

      {/* Prazo médio de pagamento — indisponível sem histórico de liquidação */}
      <div className="rounded-lg border border-dashed bg-muted/30 px-4 py-3">
        <p className="text-xs text-muted-foreground leading-relaxed flex items-start gap-2">
          <Info className="h-4 w-4 shrink-0 mt-0.5 opacity-60" />
          <span>
            <strong className="text-foreground/80">Prazo médio de pagamento</strong> requer histórico de liquidação/settlement real.
            O estoque importado é um snapshot posicional na data de referência — a coluna{" "}
            <code className="text-xs">prazo</code> do CSV reflete apenas o prazo original do título na emissão,
            não o tempo efetivo até quitação. Indisponível nesta versão.
          </span>
        </p>
      </div>

      {/* LineChart taxa por safra */}
      {(isLoadingSafras || safras.length > 0) && (
        <div>
          <SectionHeader
            title="Evolução da taxa de cessão por safra"
            description="Taxa média de cessão (% a.m.) por mês de emissão"
          />
          {isLoadingSafras ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="safra"
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  yAxisId="left"
                  tickFormatter={(v) => `${Number(v).toFixed(2)}%`}
                  tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                  width={52}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tickFormatter={(v) => `${v.toFixed(1)}%`}
                  tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: 12 }}
                  formatter={(v: number, name: string) => [`${v.toFixed(4)}%`, name]}
                />
                <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="taxa"
                  name="Taxa média (% a.m.)"
                  stroke="#2563eb"
                  dot={false}
                  strokeWidth={2}
                  connectNulls
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="pct_vencido"
                  name="% Vencido"
                  stroke="#dc2626"
                  dot={false}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* Tabela vintage */}
      <div>
        <SectionHeader
          title="Tabela vintage — por mês de emissão"
          description="Cada linha representa um cohort (títulos emitidos no mês)"
        />
        <MatrizTable
          columns={safraCols}
          rows={safras}
          getKey={(r) => r.safra_label}
          isLoading={isLoadingSafras}
          emptyMessage="Sem dados de emissão disponíveis. Verifique se o campo DATA_EMISSAO está preenchido no CSV importado."
          totalRow={
            safras.length > 0 ? (
              <>
                <TableCell className="font-semibold text-sm">Total</TableCell>
                <TableCell className="text-right font-mono font-semibold">
                  {safras.reduce((s, r) => s + r.qtd_titulos, 0).toLocaleString("pt-BR")}
                </TableCell>
                <TableCell className="text-right font-mono font-semibold">
                  {formatBRL(safras.reduce((s, r) => s + r.vn_total, 0))}
                </TableCell>
                <TableCell className="text-right text-muted-foreground text-xs">—</TableCell>
                <TableCell className="text-right text-muted-foreground text-xs">—</TableCell>
                <TableCell />
              </>
            ) : undefined
          }
        />
      </div>
    </div>
  );
}
