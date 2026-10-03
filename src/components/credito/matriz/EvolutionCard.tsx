/**
 * Card de evolução temporal com toggle Gráfico / Tabela e seletor de período.
 * Usado na aba Saúde do FIDC para Provisões e Inadimplência.
 */
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PillGroup } from "./PillGroup";
import { Skeleton } from "@/components/ui/skeleton";
import {
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PERIODOS_SERIE, type PeriodoSerie, formatBRL, formatPct } from "@/lib/creditoMatriz";

type ViewMode = "grafico" | "tabela";

export type EvolutionDataPoint = {
  mes_label: string;
  valor_brl: number | null;
  pct: number | null;
};

type Props = {
  title: string;
  data: EvolutionDataPoint[];
  period: PeriodoSerie;
  onPeriodChange: (p: PeriodoSerie) => void;
  isLoading?: boolean;
  emptyMessage?: string;
  barLabel?: string;
  lineLabel?: string;
  barColor?: string;
  lineColor?: string;
};

export function EvolutionCard({
  title,
  data,
  period,
  onPeriodChange,
  isLoading,
  emptyMessage = "Sem dados históricos disponíveis.",
  barLabel = "R$",
  lineLabel = "%",
  barColor = "#2563eb",
  lineColor = "#f59e0b",
}: Props) {
  const [view, setView] = useState<ViewMode>("grafico");

  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
          <div className="flex items-center gap-2">
            <PillGroup
              options={[
                { value: "grafico", label: "Gráfico" },
                { value: "tabela", label: "Tabela" },
              ]}
              value={view}
              onChange={setView}
            />
            <PillGroup
              options={PERIODOS_SERIE}
              value={period}
              onChange={onPeriodChange}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : data.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-center px-4 text-muted-foreground text-sm">
            {emptyMessage}
          </div>
        ) : view === "grafico" ? (
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="mes_label"
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
              />
              <YAxis
                yAxisId="left"
                tickFormatter={(v) => formatBRL(v)}
                tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={false}
                width={72}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tickFormatter={(v) => formatPct(v)}
                tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={false}
                width={40}
              />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "6px",
                  fontSize: 12,
                }}
                formatter={(value: number, name: string) => {
                  if (name === barLabel) return [formatBRL(value), name];
                  return [formatPct(value), name];
                }}
              />
              <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="left" dataKey="valor_brl" name={barLabel} fill={barColor} radius={[2, 2, 0, 0]} maxBarSize={24} />
              <Line yAxisId="right" dataKey="pct" name={lineLabel} stroke={lineColor} dot={false} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="overflow-auto max-h-52">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="text-xs uppercase">Mês</TableHead>
                  <TableHead className="text-xs uppercase text-right">{barLabel}</TableHead>
                  <TableHead className="text-xs uppercase text-right">{lineLabel}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((row) => (
                  <TableRow key={row.mes_label}>
                    <TableCell className="text-xs">{row.mes_label}</TableCell>
                    <TableCell className="text-xs text-right font-mono">
                      {row.valor_brl != null ? formatBRL(row.valor_brl) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-right font-mono">
                      {row.pct != null ? formatPct(row.pct) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
