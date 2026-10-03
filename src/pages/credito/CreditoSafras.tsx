/**
 * Performance de Safras (P3) — cohorts por data_aquisicao + curvas de maturidade (MOB).
 * Over90 = 91–180 + 180+ (buckets canônicos).
 */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { supabase } from "@/integrations/supabase/client";
import { BUCKET_COLORS, BUCKET_LABELS, BUCKETS_CANONICOS } from "@/lib/creditoBuckets";
import { formatBRL, formatPct, formatDateBR } from "@/lib/creditoIndicadores";
import {
  CURVA_COLORS,
  formatSafraLabel,
  type SafraBucket,
  type SafraCurva,
  type SafraResumo,
  type SafraVolumeOrigem,
} from "@/lib/creditoSafras";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Layers, AlertTriangle, Info, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
  BarChart,
  Bar,
} from "recharts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (t: string) => any };

const fmtPctDirect = (v: number | null, decimals = 2) =>
  v == null ? "—" : `${(v || 0).toFixed(decimals)}%`;

function ResumoCards({
  resumo,
  volumeOrigem,
}: {
  resumo: SafraResumo[];
  volumeOrigem: SafraVolumeOrigem[];
}) {
  const totalExposicao = resumo.reduce((acc, r) => acc + (r.exposicao || 0), 0);
  const piorSafra = [...resumo].sort((a, b) => (b.pct_over90 || 0) - (a.pct_over90 || 0))[0];
  const volumeTotal = volumeOrigem.reduce((acc, v) => acc + (v.volume_originado || 0), 0);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase text-muted-foreground">Safras Ativas</CardTitle>
        </CardHeader>
        <CardContent className="text-lg font-bold">{resumo.length}</CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase text-muted-foreground">Exposição (data-base)</CardTitle>
        </CardHeader>
        <CardContent className="text-lg font-bold">{formatBRL(totalExposicao)}</CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase text-muted-foreground">Volume Originado</CardTitle>
        </CardHeader>
        <CardContent className="text-lg font-bold">{formatBRL(volumeTotal)}</CardContent>
      </Card>
      <Card className={piorSafra && piorSafra.pct_over90 > 0.10 ? "border-red-400" : ""}>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase text-muted-foreground">Pior Safra (Over90)</CardTitle>
        </CardHeader>
        <CardContent>
          {piorSafra ? (
            <>
              <p className="text-lg font-bold text-red-600">{formatPct(piorSafra.pct_over90)}</p>
              <p className="text-xs text-muted-foreground mt-1">{formatSafraLabel(piorSafra.safra_label)}</p>
            </>
          ) : (
            <p className="text-lg font-bold">—</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CurvaMaturidadeChart({
  curva,
  safrasSelecionadas,
}: {
  curva: SafraCurva[];
  safrasSelecionadas: string[];
}) {
  const chartData = useMemo(() => {
    const mobSet = new Set<number>();
    curva.forEach((r) => {
      if (safrasSelecionadas.includes(r.safra_label)) mobSet.add(r.mob_meses);
    });
    const mobs = Array.from(mobSet).sort((a, b) => a - b);

    return mobs.map((mob) => {
      const point: Record<string, number | string> = { mob: mob };
      safrasSelecionadas.forEach((safra) => {
        const row = curva.find((c) => c.safra_label === safra && c.mob_meses === mob);
        point[safra] = row?.pct_over90 ?? NaN;
      });
      return point;
    });
  }, [curva, safrasSelecionadas]);

  if (safrasSelecionadas.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">
        Nenhuma safra com data de aquisição disponível.
      </p>
    );
  }

  return (
    <div className="h-[320px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="mob"
            tick={{ fontSize: 11 }}
            label={{ value: "MOB (meses)", position: "insideBottom", offset: -4, fontSize: 11 }}
          />
          <YAxis
            tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
            domain={[0, "auto"]}
            width={48}
            tick={{ fontSize: 10 }}
          />
          <Tooltip
            formatter={(value: number, name: string) => [
              Number.isNaN(value) ? "—" : formatPct(value),
              formatSafraLabel(name),
            ]}
            labelFormatter={(mob) => `MOB ${mob} meses`}
          />
          <Legend formatter={(value) => formatSafraLabel(value)} />
          {safrasSelecionadas.map((safra, idx) => (
            <Line
              key={safra}
              type="monotone"
              dataKey={safra}
              name={safra}
              stroke={CURVA_COLORS[idx % CURVA_COLORS.length]}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function VolumeOriginadoChart({ volume }: { volume: SafraVolumeOrigem[] }) {
  const data = [...volume]
    .sort((a, b) => a.safra_label.localeCompare(b.safra_label))
    .slice(-12)
    .map((v) => ({
      name: formatSafraLabel(v.safra_label),
      volume: v.volume_originado,
    }));

  return (
    <div className="h-[220px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={50} />
          <YAxis
            tickFormatter={(v) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${Math.round(v / 1_000)}K`)}
            width={52}
            tick={{ fontSize: 10 }}
          />
          <Tooltip formatter={(value: number) => formatBRL(value)} />
          <Bar dataKey="volume" name="Volume originado" fill="#6366f1" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function TabelaSafras({ rows }: { rows: SafraResumo[] }) {
  const sorted = [...rows].sort((a, b) => b.safra_label.localeCompare(a.safra_label));

  return (
    <Table>
      <TableHeader className="bg-muted/30">
        <TableRow>
          <TableHead>Safra</TableHead>
          <TableHead className="text-right">MOB máx.</TableHead>
          <TableHead className="text-right">Ativos</TableHead>
          <TableHead className="text-right">Exposição</TableHead>
          <TableHead className="text-right">% Atraso</TableHead>
          <TableHead className="text-right font-bold">Over90</TableHead>
          <TableHead className="text-right">Over180</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((r) => (
          <TableRow key={r.safra_label} className={r.pct_over90 > 0.10 ? "bg-red-50/40" : ""}>
            <TableCell className="font-medium">
              <Badge variant="outline" className="text-xs font-normal">
                {formatSafraLabel(r.safra_label)}
              </Badge>
            </TableCell>
            <TableCell className="text-right text-muted-foreground">{r.mob_max}</TableCell>
            <TableCell className="text-right">{r.qtd_ativos.toLocaleString("pt-BR")}</TableCell>
            <TableCell className="text-right font-medium">{formatBRL(r.exposicao)}</TableCell>
            <TableCell className="text-right">{formatPct(r.pct_atraso)}</TableCell>
            <TableCell className={cn("text-right font-bold", r.pct_over90 > 0.10 && "text-red-600")}>
              {formatPct(r.pct_over90)}
            </TableCell>
            <TableCell className={cn("text-right", r.pct_over180 > 0 && "text-red-700")}>
              {formatPct(r.pct_over180)}
            </TableCell>
          </TableRow>
        ))}
        {sorted.length === 0 && (
          <TableRow>
            <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
              Nenhuma safra encontrada. Verifique se o estoque possui DATA_AQUISICAO preenchida.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function MatrizBucketSafra({
  buckets,
  safraLabel,
}: {
  buckets: SafraBucket[];
  safraLabel: string;
}) {
  const rows = BUCKETS_CANONICOS.map((bucket) => {
    const match = buckets.find((b) => b.bucket_canonico === bucket);
    return {
      bucket,
      ordem: match?.bucket_ordem ?? BUCKETS_CANONICOS.indexOf(bucket),
      pct: match?.pct_safra ?? 0,
      exposicao: match?.exposicao ?? 0,
    };
  });

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">
        Distribuição por bucket — safra {formatSafraLabel(safraLabel)}
      </p>
      <div className="grid grid-cols-6 gap-1">
        {rows.map((r) => (
          <div
            key={r.bucket}
            className="rounded border p-2 text-center"
            style={{ backgroundColor: `${BUCKET_COLORS[r.ordem]}15` }}
          >
            <p className="text-[10px] text-muted-foreground truncate">{BUCKET_LABELS[r.ordem]}</p>
            <p className="text-sm font-bold" style={{ color: BUCKET_COLORS[r.ordem] }}>
              {fmtPctDirect(r.pct)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CreditoSafras() {
  const [selectedFundo, setSelectedFundo] = useState<string>("");
  const [selectedData, setSelectedData] = useState<string>("");
  const [selectedSafraDetalhe, setSelectedSafraDetalhe] = useState<string>("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

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
        return Array.from(new Set((data ?? []).map((d) => d.reference_date).filter(Boolean))) as string[];
      } catch {
        return [] as string[];
      }
    },
  });

  const { data: fundosRaw = [], refetch: refetchFundos } = useQuery({
    queryKey: ["safras-fundos"],
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_credito_safras_resumo")
        .select("doc_fundo, nome_fundo")
        .limit(500);
      if (error) throw error;
      const uniq = new Map<string, string>();
      (data ?? []).forEach((r: SafraResumo) => uniq.set(r.doc_fundo, r.nome_fundo));
      return Array.from(uniq.entries()).map(([doc_fundo, nome_fundo]) => ({ doc_fundo, nome_fundo }));
    },
  });

  const efFundo = selectedFundo || fundosRaw[0]?.doc_fundo || "";

  const { data: datasDisponiveis = [], refetch: refetchDatas } = useQuery({
    queryKey: ["safras-datas", efFundo],
    enabled: !!efFundo,
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_credito_safras_resumo")
        .select("data_referencia")
        .eq("doc_fundo", efFundo)
        .order("data_referencia", { ascending: false });
      if (error) throw error;
      return Array.from(new Set((data ?? []).map((r: SafraResumo) => r.data_referencia))) as string[];
    },
  });

  const allDatas = useMemo(() => {
    const set = new Set([...datasDisponiveis, ...estoqueImportDates]);
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [datasDisponiveis, estoqueImportDates]);

  const efData = selectedData || allDatas[0] || "";
  const hasEstoqueForDate = efData ? estoqueImportDates.includes(efData) : false;
  const hasSafrasForDate = efData ? datasDisponiveis.includes(efData) : false;

  const handleAtualizar = async () => {
    setIsRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ["safras-fundos"] });
      await queryClient.invalidateQueries({ queryKey: ["safras-datas"] });
      await queryClient.invalidateQueries({ queryKey: ["safras-resumo"] });
      await queryClient.invalidateQueries({ queryKey: ["safras-curva"] });
      await queryClient.invalidateQueries({ queryKey: ["safras-volume"] });
      await queryClient.invalidateQueries({ queryKey: ["safras-buckets"] });
      await queryClient.invalidateQueries({ queryKey: ["estoque-fidc-import-dates"] });
      await refetchFundos();
      if (efFundo) await refetchDatas();
      toast({
        title: "Dados atualizados",
        description: "Estoque FIDC recarregado. Selecione a data-base mais recente se necessário.",
      });
    } catch (err) {
      toast({
        title: "Erro ao atualizar",
        description: err instanceof Error ? err.message : "Erro desconhecido",
        variant: "destructive",
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  const { data: resumo = [], isLoading: loadingResumo } = useQuery({
    queryKey: ["safras-resumo", efFundo, efData],
    enabled: !!efFundo && !!efData,
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_credito_safras_resumo")
        .select("*")
        .eq("doc_fundo", efFundo)
        .eq("data_referencia", efData)
        .order("safra_label", { ascending: false });
      if (error) throw error;
      return (data ?? []) as SafraResumo[];
    },
  });

  const { data: curva = [], isLoading: loadingCurva } = useQuery({
    queryKey: ["safras-curva", efFundo],
    enabled: !!efFundo,
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_credito_safras_curva")
        .select("*")
        .eq("doc_fundo", efFundo)
        .order("safra_label", { ascending: true })
        .order("mob_meses", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SafraCurva[];
    },
  });

  const { data: volumeOrigem = [] } = useQuery({
    queryKey: ["safras-volume", efFundo],
    enabled: !!efFundo,
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_credito_safras_volume_origem")
        .select("*")
        .eq("doc_fundo", efFundo)
        .order("safra_label", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SafraVolumeOrigem[];
    },
  });

  const { data: bucketsSafra = [] } = useQuery({
    queryKey: ["safras-buckets", efFundo, efData, selectedSafraDetalhe],
    enabled: !!efFundo && !!efData && !!selectedSafraDetalhe,
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_credito_safras_por_bucket")
        .select("*")
        .eq("doc_fundo", efFundo)
        .eq("data_referencia", efData)
        .eq("safra_label", selectedSafraDetalhe)
        .order("bucket_ordem", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SafraBucket[];
    },
  });

  const safrasParaCurva = useMemo(() => {
    const labels = Array.from(new Set(curva.map((c) => c.safra_label))).sort();
    return labels.slice(-8);
  }, [curva]);

  const efSafraDetalhe = selectedSafraDetalhe || resumo[0]?.safra_label || "";

  const isLoading = loadingResumo || loadingCurva;

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3 border-b border-border pb-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight uppercase flex items-center gap-2">
              <Layers className="h-5 w-5 text-primary" />
              Performance de Safras
            </h1>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mt-1">
              Cohorts por data_aquisicao · Curvas de maturidade (MOB) · Over90 canônico
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
            <Select value={efFundo} onValueChange={(v) => { setSelectedFundo(v); setSelectedData(""); setSelectedSafraDetalhe(""); }}>
              <SelectTrigger className="w-[300px] h-8 text-xs">
                <SelectValue placeholder="Selecione o fundo" />
              </SelectTrigger>
              <SelectContent>
                {fundosRaw.map((f) => (
                  <SelectItem key={f.doc_fundo} value={f.doc_fundo}>
                    {f.nome_fundo || f.doc_fundo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {allDatas.length > 0 && (
              <Select value={efData} onValueChange={setSelectedData}>
                <SelectTrigger className="w-[180px] h-8 text-xs">
                  <SelectValue placeholder="Data-base" />
                </SelectTrigger>
                <SelectContent>
                  {allDatas.map((d) => (
                    <SelectItem key={d} value={d}>
                      {formatDateBR(d)}
                      {estoqueImportDates.includes(d) && !datasDisponiveis.includes(d) && (
                        <span className="ml-1 text-amber-500 text-[10px]">●</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={handleAtualizar}
              disabled={isRefreshing}
              title="Recarregar dados após importar estoque FIDC"
            >
              {isRefreshing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              {isRefreshing ? "Atualizando..." : "Atualizar dados"}
            </Button>
          </div>
        </div>

        {efData && hasEstoqueForDate && !hasSafrasForDate && (
          <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            Estoque importado para {formatDateBR(efData)}, mas nenhuma safra encontrada.
            Confira se o CSV inclui <strong>DATA_AQUISICAO</strong> preenchida.
          </div>
        )}

        {!efFundo && (
          <Card className="border-amber-200 bg-amber-50/50">
            <CardContent className="pt-6 text-center">
              <p className="text-sm text-amber-700 font-medium">Nenhum dado de safra encontrado.</p>
              <p className="text-xs text-amber-600 mt-1">
                Importe estoque FIDC com campo DATA_AQUISICAO preenchido para habilitar esta análise.
              </p>
            </CardContent>
          </Card>
        )}

        {isLoading && efFundo && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isLoading && efFundo && (
          <div className="space-y-5">
            <ResumoCards resumo={resumo} volumeOrigem={volumeOrigem} />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Curva de Maturidade — Over90 por MOB</CardTitle>
                  <CardDescription className="text-xs">
                    Evolução do Over90 conforme meses na carteira (MOB). Últimas {safrasParaCurva.length} safras.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <CurvaMaturidadeChart curva={curva} safrasSelecionadas={safrasParaCurva} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Volume Originado por Safra</CardTitle>
                  <CardDescription className="text-xs">
                    Exposição na origem (MOB = 0) — últimas 12 safras.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <VolumeOriginadoChart volume={volumeOrigem} />
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div>
                    <CardTitle className="text-sm">Resumo por Safra — {formatDateBR(efData)}</CardTitle>
                    <CardDescription className="text-xs">
                      Snapshot na data-base selecionada. MOB = meses entre aquisição e data_referencia.
                    </CardDescription>
                  </div>
                  {resumo.length > 0 && (
                    <Select value={efSafraDetalhe} onValueChange={setSelectedSafraDetalhe}>
                      <SelectTrigger className="w-[160px] h-8 text-xs">
                        <SelectValue placeholder="Detalhar safra" />
                      </SelectTrigger>
                      <SelectContent>
                        {resumo.map((r) => (
                          <SelectItem key={r.safra_label} value={r.safra_label}>
                            {formatSafraLabel(r.safra_label)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {efSafraDetalhe && bucketsSafra.length > 0 && (
                  <MatrizBucketSafra buckets={bucketsSafra} safraLabel={efSafraDetalhe} />
                )}
                <TabelaSafras rows={resumo} />
              </CardContent>
            </Card>

            <Card className="bg-muted/30 border-dashed">
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground leading-relaxed flex items-start gap-2">
                  <Info className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    <strong>Metodologia:</strong> Safra = mês de <code>DATA_AQUISICAO</code> do recebível.
                    MOB (months on book) = meses entre aquisição e data_referencia.
                    Over90 = buckets 91–180 + 180+ (taxonomia canônica).
                    Ativos sem data de aquisição são excluídos.
                    Curvas agregam todas as observações históricas por MOB — não substituem análise de recovery em caixa.
                  </span>
                </p>
              </CardContent>
            </Card>

            {resumo.length === 0 && (
              <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                Nenhuma safra na data selecionada. Confira se o CSV Frontis inclui DATA_AQUISICAO preenchida.
              </div>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
