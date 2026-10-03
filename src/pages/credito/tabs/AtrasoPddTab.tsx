import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as ChartTooltip,
  ResponsiveContainer,
  LabelList,
  Cell,
} from "recharts";
import { TableCell } from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PillGroup } from "@/components/credito/matriz/PillGroup";
import { MatrizTable, type MatrizColDef } from "@/components/credito/matriz/MatrizTable";
import { SectionHeader } from "@/components/credito/matriz/SectionHeader";
import { BadgeSeveridade } from "@/components/credito/matriz/BadgeSeveridade";
import { formatBRL, formatPct, FAIXA_PRAZO_COLORS } from "@/lib/creditoMatriz";
import type { MatrizPrazoRow, CoberturaPddRow } from "@/lib/creditoMatriz";

type Props = {
  matrizRows: MatrizPrazoRow[];
  coberturaRows: CoberturaPddRow[];
  isLoadingMatriz: boolean;
  isLoadingCobertura: boolean;
  errorMatriz: Error | null;
  errorCobertura: Error | null;
};

type ViewMode = "grafico" | "tabela";

// ─── colunas da tabela matriz ─────────────────────────────────────────────

const matrizCols: MatrizColDef<MatrizPrazoRow>[] = [
  {
    key: "faixa",
    header: "Prazo / Faixa",
    cell: (r) => (
      <div className="flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 rounded-full shrink-0"
          style={{ background: FAIXA_PRAZO_COLORS[r.faixa_prazo_ordem] }}
        />
        <span className="font-medium text-sm">{r.faixa_prazo}</span>
      </div>
    ),
    cellClass: "min-w-[160px]",
  },
  {
    key: "adimplente_vp",
    header: (
      <span>
        Adimplente
        <span className="block text-[9px] text-muted-foreground font-normal">VP</span>
      </span>
    ),
    cell: (r) => (
      <span className={cn("font-mono text-emerald-400", r.vp_adimplente === 0 && "text-muted-foreground/40")}>
        {r.vp_adimplente > 0 ? formatBRL(r.vp_adimplente) : "—"}
      </span>
    ),
    cellClass: "text-right",
    headerClass: "text-right",
  },
  {
    key: "adimplente_pct",
    header: <span className="text-[10px]">%</span>,
    cell: (r) => (
      <span className={cn("font-mono text-xs text-muted-foreground", r.pct_adimplente === 0 && "opacity-30")}>
        {r.vp_adimplente > 0 ? formatPct(r.pct_adimplente) : "—"}
      </span>
    ),
    cellClass: "text-right",
    headerClass: "text-right",
  },
  {
    key: "inad_badge",
    header: (
      <div>
        <span>Inadimplente</span>
        <span className="block text-[9px] text-muted-foreground font-normal">VP</span>
      </div>
    ),
    cell: (r) => (
      <span className={cn("font-mono text-red-400", r.vp_inadimplente === 0 && "text-muted-foreground/40")}>
        {r.vp_inadimplente > 0 ? formatBRL(r.vp_inadimplente) : "—"}
      </span>
    ),
    cellClass: "text-right",
    headerClass: "text-right",
  },
  {
    key: "inad_pct",
    header: <span className="text-[10px]">%</span>,
    cell: (r) => (
      <span className={cn("font-mono text-xs text-muted-foreground", r.pct_inadimplente === 0 && "opacity-30")}>
        {r.vp_inadimplente > 0 ? formatPct(r.pct_inadimplente) : "—"}
      </span>
    ),
    cellClass: "text-right",
    headerClass: "text-right",
  },
  {
    key: "pdd_vp",
    header: (
      <span>
        PDD
        <span className="block text-[9px] text-muted-foreground font-normal">Provisão</span>
      </span>
    ),
    cell: (r) => (
      <span className="font-mono text-amber-400">
        {r.vp_pdd > 0 ? formatBRL(r.vp_pdd) : "—"}
      </span>
    ),
    cellClass: "text-right",
    headerClass: "text-right",
  },
  {
    key: "pdd_pct",
    header: <span className="text-[10px]">%</span>,
    cell: (r) => (
      <span className="font-mono text-xs text-muted-foreground">
        {r.vp_pdd > 0 ? formatPct(r.pct_pdd) : "—"}
      </span>
    ),
    cellClass: "text-right",
    headerClass: "text-right",
  },
];

// ─── Painel de Cobertura PDD ──────────────────────────────────────────────

function CoberturaPddPanel({
  rows,
  isLoading,
  error,
}: {
  rows: CoberturaPddRow[];
  isLoading: boolean;
  error: Error | null;
}) {
  const [view, setView] = useState<ViewMode>("grafico");

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }

  const chartData = rows.map((r) => ({
    faixa: r.faixa_prazo,
    vp: r.vp_total_faixa,
    pdd: r.vp_pdd_faixa,
    cobertura: r.cobertura_pdd,
    ordem: r.faixa_prazo_ordem,
  }));

  const coberturaCols: MatrizColDef<CoberturaPddRow>[] = [
    {
      key: "faixa",
      header: "Faixa",
      cell: (r) => <span className="text-sm">{r.faixa_prazo}</span>,
    },
    {
      key: "vp",
      header: "VP Total",
      cell: (r) => <span className="font-mono">{formatBRL(r.vp_total_faixa)}</span>,
      cellClass: "text-right",
      headerClass: "text-right",
    },
    {
      key: "pdd",
      header: "PDD",
      cell: (r) => <span className="font-mono text-amber-400">{formatBRL(r.vp_pdd_faixa)}</span>,
      cellClass: "text-right",
      headerClass: "text-right",
    },
    {
      key: "cobertura",
      header: (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 cursor-help justify-end w-full">
                % Cobertura
                <Info className="h-3 w-3 shrink-0 opacity-60" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[280px] text-xs leading-relaxed">
              <p className="font-semibold mb-1">% Cobertura de PDD</p>
              <p>
                Indica quanto da provisão para devedores duvidosos (PDD) cobre o valor presente (VP)
                dos recebíveis na faixa de prazo.
              </p>
              <p className="mt-1.5 font-mono text-[11px]">PDD da faixa ÷ VP Total da faixa</p>
              <p className="mt-2 text-muted-foreground">
                ≥ 80% — provisão robusta · 50–80% — atenção · &lt; 50% — cobertura insuficiente
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ),
      cell: (r) => (
        <span
          className={cn(
            "font-mono font-semibold",
            r.cobertura_pdd >= 0.8
              ? "text-emerald-400"
              : r.cobertura_pdd >= 0.5
                ? "text-yellow-400"
                : "text-red-400",
          )}
        >
          {formatPct(r.cobertura_pdd)}
        </span>
      ),
      cellClass: "text-right",
      headerClass: "text-right",
    },
  ];

  return (
    <div>
      <SectionHeader
        title="Cobertura de PDD por faixa"
        description="Proporção da PDD em relação ao VP em cada faixa de prazo"
        actions={
          <PillGroup
            options={[
              { value: "grafico", label: "Gráfico" },
              { value: "tabela", label: "Tabela" },
            ]}
            value={view}
            onChange={setView}
          />
        }
      />
      {view === "grafico" ? (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 60, left: 4, bottom: 0 }}>
            <XAxis
              type="number"
              tickFormatter={(v) => formatBRL(v)}
              tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="faixa"
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              width={120}
              tickLine={false}
            />
            <ChartTooltip
              contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: 11 }}
              formatter={(v: number, name: string) => [formatBRL(v), name]}
            />
            <Bar dataKey="vp" name="VP" radius={[0, 3, 3, 0]} maxBarSize={18} fill="#334155">
              {chartData.map((d) => (
                <Cell key={d.faixa} fill={d.ordem === 0 ? "#16a34a33" : "#33415533"} />
              ))}
            </Bar>
            <Bar dataKey="pdd" name="PDD" radius={[0, 3, 3, 0]} maxBarSize={18}>
              {chartData.map((d) => (
                <Cell key={d.faixa} fill={FAIXA_PRAZO_COLORS[d.ordem]} />
              ))}
              <LabelList
                dataKey="cobertura"
                position="right"
                formatter={(v: number) => v > 0 ? `${(v * 100).toFixed(0)}%` : ""}
                style={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <MatrizTable
          columns={coberturaCols}
          rows={rows}
          getKey={(r) => r.faixa_prazo}
          isLoading={isLoading}
        />
      )}
    </div>
  );
}

// ─── Aba principal ────────────────────────────────────────────────────────

export function AtrasoPddTab({
  matrizRows,
  coberturaRows,
  isLoadingMatriz,
  isLoadingCobertura,
  errorMatriz,
  errorCobertura,
}: Props) {
  if (errorMatriz) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>Erro ao carregar dados de atraso: {errorMatriz.message}</AlertDescription>
      </Alert>
    );
  }

  // Linha de Total para a tabela
  const totalVpAdimplente = matrizRows.reduce((s, r) => s + r.vp_adimplente, 0);
  const totalVpInadimplente = matrizRows.reduce((s, r) => s + r.vp_inadimplente, 0);
  const totalVpPdd = matrizRows.reduce((s, r) => s + r.vp_pdd, 0);
  const totalVp = matrizRows[0]?.vp_total ?? 0;

  // Badge de inadimplência no cabeçalho
  const pctInad = totalVp > 0 ? totalVpInadimplente / totalVp : 0;

  return (
    <div className="space-y-6">
      {/* Tabela matriz */}
      <div>
        <SectionHeader
          title="Carteira por faixa de prazo"
          description="Distribuição do VP por faixa de atraso com cobertura de PDD"
          actions={
            <BadgeSeveridade pct={pctInad} />
          }
        />
        <MatrizTable
          columns={matrizCols}
          rows={matrizRows}
          getKey={(r) => r.faixa_prazo}
          isLoading={isLoadingMatriz}
          emptyMessage="Sem dados de atraso para a data selecionada. Execute Calcular para gerar os indicadores."
          totalRow={
            matrizRows.length > 0 ? (
              <>
                <TableCell className="font-semibold text-sm">Total</TableCell>
                <TableCell className="text-right font-mono font-semibold text-emerald-400">
                  {formatBRL(totalVpAdimplente)}
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground text-xs">
                  {formatPct(totalVp > 0 ? totalVpAdimplente / totalVp : 0)}
                </TableCell>
                <TableCell className="text-right font-mono font-semibold text-red-400">
                  {formatBRL(totalVpInadimplente)}
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground text-xs">
                  {formatPct(totalVp > 0 ? totalVpInadimplente / totalVp : 0)}
                </TableCell>
                <TableCell className="text-right font-mono font-semibold text-amber-400">
                  {formatBRL(totalVpPdd)}
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground text-xs">
                  {formatPct(totalVp > 0 ? totalVpPdd / totalVp : 0)}
                </TableCell>
              </>
            ) : undefined
          }
        />
      </div>

      {/* Cobertura PDD */}
      <CoberturaPddPanel rows={coberturaRows} isLoading={isLoadingCobertura} error={errorCobertura} />
    </div>
  );
}
