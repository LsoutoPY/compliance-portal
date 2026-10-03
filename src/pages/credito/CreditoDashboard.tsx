import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { supabase } from "@/integrations/supabase/client";
import { BUCKET_COLORS } from "@/lib/creditoBuckets";
import {
  formatBRL,
  formatPct,
  formatDateBR,
  mapIndicadorRow,
  INDICADOR_EXTENDED_SELECT,
  INDICADOR_BASE_SELECT,
  INDICADOR_EXTENDED_COLUMNS,
  isMissingColumnError,
  type IndicadorCreditoExtended,
} from "@/lib/creditoIndicadores";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, BarChart3 } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  ComposedChart,
  CartesianGrid,
} from "recharts";

type BucketResumo = {
  import_id: string;
  criado_em?: string;
  nome_fundo: string;
  data_referencia: string;
  bucket_atraso: string;
  exposicao: number;
};

const CHART_BUCKET_COLORS = [
  BUCKET_COLORS[0],
  BUCKET_COLORS[1],
  BUCKET_COLORS[2],
  BUCKET_COLORS[3],
  BUCKET_COLORS[4],
  BUCKET_COLORS[5],
];

export default function CreditoDashboard() {
  const [selectedDate, setSelectedDate] = useState<string>("");

  const { data: availableDates = [] } = useQuery({
    queryKey: ["credito-dashboard-dates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("credito_estoque_indicadores")
        .select("data_referencia")
        .order("data_referencia", { ascending: false })
        .limit(5000);
      if (error) throw error;
      return Array.from(new Set((data || []).map((d) => d.data_referencia).filter(Boolean)));
    },
  });

  const effectiveDate = selectedDate || availableDates[0] || "";

  const { data: indicadores = [], isLoading: loadingIndicadores } = useQuery({
    queryKey: ["credito-dashboard-indicadores", effectiveDate],
    enabled: !!effectiveDate,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("credito_estoque_indicadores")
        .select(INDICADOR_EXTENDED_SELECT)
        .eq("data_referencia", effectiveDate)
        .order("criado_em", { ascending: false })
        .order("nome_fundo", { ascending: true });

      if (error) {
        if (!isMissingColumnError(error, [...INDICADOR_EXTENDED_COLUMNS])) {
          throw error;
        }

        const fallback = await supabase
          .from("credito_estoque_indicadores")
          .select(INDICADOR_BASE_SELECT)
          .eq("data_referencia", effectiveDate)
          .order("criado_em", { ascending: false })
          .order("nome_fundo", { ascending: true });

        if (fallback.error) throw fallback.error;
        return (fallback.data || []).map((r) => mapIndicadorRow(r as Record<string, unknown>));
      }

      return (data || []).map((r) => mapIndicadorRow(r as Record<string, unknown>));
    },
  });

  const { data: resumoBucket = [], isLoading: loadingBuckets } = useQuery({
    queryKey: ["credito-dashboard-buckets", effectiveDate],
    enabled: !!effectiveDate,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("credito_estoque_resumo_bucket")
        .select("import_id, criado_em, nome_fundo, data_referencia, bucket_atraso, exposicao, pdd_atual")
        .eq("data_referencia", effectiveDate);
      if (error) throw error;
      return (data || []) as (BucketResumo & { pdd_atual: number })[];
    },
  });

  const consolidado = useMemo(
    () => indicadores.find((i) => i.nome_fundo === "CONSOLIDADO") ?? null,
    [indicadores]
  );
  const latestImportId = useMemo(() => consolidado?.import_id ?? indicadores[0]?.import_id ?? null, [consolidado, indicadores]);
  const fundos = useMemo(
    () => indicadores.filter((i) => i.nome_fundo !== "CONSOLIDADO" && (!latestImportId || i.import_id === latestImportId)),
    [indicadores, latestImportId]
  );

  const topCarteira = useMemo(
    () =>
      [...fundos]
        .sort((a, b) => (b.carteira_total || 0) - (a.carteira_total || 0))
        .slice(0, 5)
        .map((f) => ({
          name: f.nome_fundo.length > 28 ? `${f.nome_fundo.slice(0, 28)}...` : f.nome_fundo,
          carteira: f.carteira_total || 0,
        })),
    [fundos]
  );

  const bucketData = useMemo(() => {
    const order = ["Adimplente", "1-30", "31-60", "61-90", "91-180", "180+"];
    const consolidatedBuckets = resumoBucket.filter(
      (r) => r.nome_fundo === "CONSOLIDADO" && (!latestImportId || r.import_id === latestImportId)
    );
    
    let data: { name: string; value: number; pdd: number; coverage: number }[] = [];

    if (consolidatedBuckets.length > 0) {
      data = consolidatedBuckets.map((r) => ({
        name: r.bucket_atraso,
        value: r.exposicao || 0,
        pdd: r.pdd_atual || 0,
        coverage: r.exposicao ? (r.pdd_atual || 0) / r.exposicao : 0,
      }));
    } else {
      const grouped = new Map<string, { exposicao: number; pdd: number }>();
      resumoBucket
        .filter((r) => !latestImportId || r.import_id === latestImportId)
        .forEach((r) => {
        const curr = grouped.get(r.bucket_atraso) || { exposicao: 0, pdd: 0 };
        curr.exposicao += r.exposicao || 0;
        curr.pdd += r.pdd_atual || 0;
        grouped.set(r.bucket_atraso, curr);
      });
      data = Array.from(grouped.entries()).map(([name, val]) => ({
        name,
        value: val.exposicao,
        pdd: val.pdd,
        coverage: val.exposicao ? val.pdd / val.exposicao : 0,
      }));
    }

    return data.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }, [resumoBucket, latestImportId]);

  const isLoading = loadingIndicadores || loadingBuckets;

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight uppercase flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              Dashboard - Risco de Credito
            </h1>
            <p className="text-xs text-muted-foreground uppercase tracking-wide">
              Visão executiva · buckets canônicos · Over90 = 91–180 + 180+
            </p>
          </div>
          <div className="w-[220px]">
            <Select value={effectiveDate} onValueChange={setSelectedDate} disabled={availableDates.length === 0}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Data-base" />
              </SelectTrigger>
              <SelectContent>
                {availableDates.map((d) => (
                  <SelectItem key={d} value={d}>
                    {formatDateBR(d)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Fundos</CardTitle></CardHeader>
            <CardContent className="text-lg font-bold">{fundos.length}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Carteira Total</CardTitle></CardHeader>
            <CardContent className="text-lg font-bold">{formatBRL(consolidado?.carteira_total || 0)}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Over90</CardTitle></CardHeader>
            <CardContent className="text-lg font-bold">{formatPct(consolidado?.over90 || 0)}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Coverage NPL</CardTitle></CardHeader>
            <CardContent className="text-lg font-bold">{formatPct(consolidado?.coverage_npl || 0)}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Aderência PDD</CardTitle></CardHeader>
            <CardContent className="text-lg font-bold">{formatPct(consolidado?.aderencia_pdd || 0)}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Gap Total</CardTitle></CardHeader>
            <CardContent className="text-lg font-bold">{formatBRL(consolidado?.gap_total || 0)}</CardContent>
          </Card>
        </div>

        {isLoading ? (
          <div className="py-16 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Top 5 Fundos por Carteira</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-[280px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={topCarteira} margin={{ top: 8, right: 16, left: 8, bottom: 50 }}>
                      <XAxis
                        dataKey="name"
                        tick={{ fontSize: 10 }}
                        interval={0}
                        angle={-25}
                        textAnchor="end"
                        height={55}
                      />
                      <YAxis
                        tickFormatter={(v) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${Math.round(v / 1_000)}K`)}
                        width={48}
                        domain={[0, "auto"]}
                        tickCount={5}
                        allowDecimals={false}
                      />
                      <Tooltip formatter={(value: number) => formatBRL(value)} />
                      <Bar dataKey="carteira" fill="#111827" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Exposição por Bucket e Cobertura Regulatória</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-[280px] w-full flex flex-col gap-4">
                  <div className="flex-1">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart
                        layout="vertical"
                        data={bucketData}
                        margin={{ top: 5, right: 20, bottom: 5, left: 40 }}
                      >
                        <CartesianGrid stroke="#f5f5f5" horizontal={false} />
                        <XAxis type="number" tickFormatter={(v) => `${(v / 1000000).toFixed(1)}M`} fontSize={10} />
                        <YAxis dataKey="name" type="category" width={80} fontSize={11} />
                        <Tooltip
                          formatter={(value: number, name: string) => {
                            if (name === "Cobertura") return formatPct(value);
                            return formatBRL(value);
                          }}
                        />
                        <Bar dataKey="value" name="Exposição" barSize={20} radius={[0, 4, 4, 0]}>
                          {bucketData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={CHART_BUCKET_COLORS[index % CHART_BUCKET_COLORS.length]} />
                          ))}
                        </Bar>
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="h-[80px] border-t pt-2">
                    <p className="text-xs font-medium text-muted-foreground mb-1 text-center">Cobertura por Faixa (%)</p>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={bucketData}>
                        <XAxis dataKey="name" hide />
                        <Tooltip formatter={(value: number) => formatPct(value)} />
                        <Bar dataKey="coverage" fill="#8884d8" radius={[4, 4, 0, 0]}>
                          {bucketData.map((entry, index) => (
                            <Cell
                              key={`cell-${index}`}
                              fill={entry.coverage < 0.2 && ["61-90", "91-180", "180+"].includes(entry.name) ? "#ef4444" : "#3b82f6"}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </Layout>
  );
}
