import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Table2,
  Droplets,
  Upload,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";

type MatrizAnbimaRow = {
  id: string;
  data_ref: string;
  periodo: string;
  classe: string;
  segmento_investidor: string;
  tipo_metodologia: string;
  metrica: string;
  prazo: number;
  valor: number;
};

const MATRIZ_FILTERS_PAGE = 1000;

/** Ordena períodos MM/AAAA do mais recente para o mais antigo (evita sort lexicográfico). */
function sortPeriodosDesc(a: string, b: string): number {
  const parse = (p: string) => {
    const parts = p.split("/").map((x) => parseInt(x, 10));
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return 0;
    return parts[1] * 100 + parts[0];
  };
  return parse(b) - parse(a);
}

export default function Liquidez() {
  const [periodoFilter, setPeriodoFilter] = useState<string>("all");
  const [classeFilter, setClasseFilter] = useState<string>("all");
  const [segmentoFilter, setSegmentoFilter] = useState<string>("all");
  const [tipoMetodologiaFilter, setTipoMetodologiaFilter] = useState<string>("all");
  const [metricaFilter, setMetricaFilter] = useState<string>("all");
  const [prazoFilter, setPrazoFilter] = useState<string>("all");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: rows, isLoading } = useQuery({
    queryKey: ["matriz-anbima", periodoFilter, classeFilter, segmentoFilter, tipoMetodologiaFilter, metricaFilter, prazoFilter],
    queryFn: async () => {
      const buildQuery = () => {
        let q = supabase
          .from("matriz_anbima")
          .select("*")
          .order("periodo", { ascending: false })
          .order("classe", { ascending: true })
          .order("segmento_investidor", { ascending: true })
          .order("prazo", { ascending: true });

        if (periodoFilter !== "all") q = q.eq("periodo", periodoFilter);
        if (classeFilter !== "all") q = q.eq("classe", classeFilter);
        if (segmentoFilter !== "all") q = q.eq("segmento_investidor", segmentoFilter);
        if (tipoMetodologiaFilter !== "all") q = q.eq("tipo_metodologia", tipoMetodologiaFilter);
        if (metricaFilter !== "all") q = q.eq("metrica", metricaFilter);
        if (prazoFilter !== "all") q = q.eq("prazo", parseInt(prazoFilter, 10));
        return q;
      };

      const rowsAcc: MatrizAnbimaRow[] = [];
      let from = 0;
      for (;;) {
        const { data, error } = await buildQuery().range(from, from + MATRIZ_FILTERS_PAGE - 1);
        if (error) throw error;
        if (!data?.length) break;
        rowsAcc.push(...((data || []) as MatrizAnbimaRow[]));
        if (data.length < MATRIZ_FILTERS_PAGE) break;
        from += MATRIZ_FILTERS_PAGE;
      }
      return rowsAcc;
    },
  });

  const { data: filterOptions } = useQuery({
    queryKey: ["matriz-anbima-filters"],
    queryFn: async () => {
      // PostgREST limita a 1000 linhas por requisição: sem paginar, o DISTINCT de períodos
      // no cliente fica incompleto (~um mês de dados por “página”).
      const data: Array<{
        periodo: string;
        classe: string;
        segmento_investidor: string;
        tipo_metodologia: string;
        metrica: string;
        prazo: number;
      }> = [];
      let from = 0;
      for (;;) {
        const { data: chunk, error } = await supabase
          .from("matriz_anbima")
          .select("periodo, classe, segmento_investidor, tipo_metodologia, metrica, prazo")
          .range(from, from + MATRIZ_FILTERS_PAGE - 1);
        if (error) throw error;
        if (!chunk?.length) break;
        data.push(...chunk);
        if (chunk.length < MATRIZ_FILTERS_PAGE) break;
        from += MATRIZ_FILTERS_PAGE;
      }

      const periodos = [...new Set(data.map((r) => r.periodo))].sort(sortPeriodosDesc);
      const classes = [...new Set(data.map((r) => r.classe))].sort();
      const segmentos = [...new Set(data.map((r) => r.segmento_investidor))].sort();
      const tiposMetodologia = [...new Set(data.map((r) => r.tipo_metodologia))].sort();
      const metricas = [...new Set(data.map((r) => r.metrica))].sort();
      const prazos = [...new Set(data.map((r) => r.prazo))].sort((a, b) => a - b);

      return { periodos, classes, segmentos, tiposMetodologia, metricas, prazos };
    },
  });

  const formatValor = (v: number) => {
    if (v >= 1) return "100%";
    if (v < 0.01) return (v * 100).toFixed(2) + "%";
    return (v * 100).toFixed(2) + "%";
  };

  const formatData = (d: string) => {
    if (!d) return "-";
    const [y, m, day] = d.split("-");
    return `${day}/${m}/${y}`;
  };

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Droplets className="w-7 h-7 text-blue-600" />
              Matriz ANBIMA
            </h1>
            <p className="text-muted-foreground mt-1">
              Parâmetros de referência (probabilidade/média de resgates por grupo) para comparar com o comportamento do passivo.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => navigate("/enquadramento/importar")}
            className="shrink-0"
          >
            <Upload className="w-4 h-4 mr-2" />
            Importar nova planilha
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Table2 className="w-5 h-5" />
              Dados importados
            </CardTitle>
            <CardDescription>
              Tabela de parâmetros ANBIMA por classe, segmento e prazo. Para atualizar os dados, use a opção Importar XML na aba Matriz ANBIMA.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {filterOptions && (
              <div className="flex flex-wrap gap-3">
                <Select value={periodoFilter} onValueChange={setPeriodoFilter}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue placeholder="Período" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos períodos</SelectItem>
                    {filterOptions.periodos.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={classeFilter} onValueChange={setClasseFilter}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Classe" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas classes</SelectItem>
                    {filterOptions.classes.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={segmentoFilter} onValueChange={setSegmentoFilter}>
                  <SelectTrigger className="w-[160px]">
                    <SelectValue placeholder="Segmento" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos segmentos</SelectItem>
                    {filterOptions.segmentos.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={tipoMetodologiaFilter} onValueChange={setTipoMetodologiaFilter}>
                  <SelectTrigger className="w-[220px]">
                    <SelectValue placeholder="Tipo Metodologia" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os tipos</SelectItem>
                    {filterOptions.tiposMetodologia.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t.length > 35 ? t.slice(0, 35) + "…" : t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={metricaFilter} onValueChange={setMetricaFilter}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue placeholder="Métrica" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas métricas</SelectItem>
                    {filterOptions.metricas.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={prazoFilter} onValueChange={setPrazoFilter}>
                  <SelectTrigger className="w-[120px]">
                    <SelectValue placeholder="Prazo" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos prazos</SelectItem>
                    {filterOptions.prazos.map((p) => (
                      <SelectItem key={p} value={String(p)}>
                        {p} d.u.
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    void queryClient.invalidateQueries({ queryKey: ["matriz-anbima"] });
                    void queryClient.invalidateQueries({ queryKey: ["matriz-anbima-filters"] });
                  }}
                  disabled={isLoading}
                >
                  <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
                </Button>
              </div>
            )}

            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            ) : !rows || rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center border rounded-lg bg-muted/30">
                <Table2 className="w-12 h-12 text-muted-foreground mb-4" />
                <p className="font-medium">Nenhum dado importado</p>
                <p className="text-sm text-muted-foreground mt-1 mb-4">
                  Faça o upload do CSV da Matriz ANBIMA em Importar XML (aba Matriz ANBIMA).
                </p>
                <Button onClick={() => navigate("/enquadramento/importar")}>
                  <ExternalLink className="w-4 h-4 mr-2" />
                  Ir para Importações
                </Button>
              </div>
            ) : (
              <ScrollArea className="h-[500px] w-full rounded-md border">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-muted/95 backdrop-blur supports-[backdrop-filter]:bg-muted/60">
                    <TableRow>
                      <TableHead>Data Ref.</TableHead>
                      <TableHead>Período</TableHead>
                      <TableHead>Classe</TableHead>
                      <TableHead>Segmento</TableHead>
                      <TableHead>Tipo Metodologia</TableHead>
                      <TableHead>Métrica</TableHead>
                      <TableHead className="text-right">Prazo (d.u.)</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap">{formatData(r.data_ref)}</TableCell>
                        <TableCell>{r.periodo}</TableCell>
                        <TableCell>{r.classe}</TableCell>
                        <TableCell>{r.segmento_investidor}</TableCell>
                        <TableCell className="max-w-[200px] truncate" title={r.tipo_metodologia}>
                          {r.tipo_metodologia}
                        </TableCell>
                        <TableCell>{r.metrica}</TableCell>
                        <TableCell className="text-right">{r.prazo}</TableCell>
                        <TableCell className="text-right font-mono">{formatValor(r.valor)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
            )}

            {rows && rows.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {rows.length} registro(s) exibido(s)
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
