import { useState, useMemo, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Calendar as CalendarIcon,
  Download,
  Users,
  RefreshCw,
  FileDown,
} from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { format, parse, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import {
  fetchRiscoConsolidado,
  exportRiscoConsolidadoExcel,
  exportRiscoConsolidadoPdf,
} from "@/lib/riscoConsolidadoExport";
import type { LinhaConsolidada } from "@/types/risco-mercado";
import { RelatorioKpiCards } from "./RelatorioKpiCards";
import { RelatorioComiteChart } from "./RelatorioComiteChart";
import { RelatorioStatusBadge } from "./RelatorioStatusBadge";
import { RelatorioSortableHead } from "./RelatorioSortableHead";
import { sortRelatorioRows, useRelatorioSort } from "./useRelatorioSort";
import {
  formatCnpj,
  formatBRL,
  formatPctDisplay,
  monthLabelFromYyyymm,
  STATUS_PRIORITY,
  yyyymmddToIso,
  usePosicaoAvailableDatesQuery,
  useRiscoMercadoMonthlyMonths,
} from "./relatorioUtils";

type MercadoFundRow = LinhaConsolidada & {
  status: "ok" | "alerta" | "breach" | "sem_dados";
};

type MercadoSortKey =
  | "nome_fundo"
  | "fundo_cnpj"
  | "pl"
  | "exposicao"
  | "var_hist_pct"
  | "var_param_pct"
  | "consumo_pct"
  | "status";

const MERCADO_STATUS_ORDER: Record<string, number> = {
  breach: 0,
  alerta: 1,
  sem_dados: 2,
  ok: 3,
};

function sortMercadoRows(rows: MercadoFundRow[], key: MercadoSortKey, direction: "none" | "asc" | "desc") {
  return sortRelatorioRows(
    rows,
    key,
    direction,
    (row, k) => {
      switch (k as MercadoSortKey) {
        case "nome_fundo":
          return row.nome_fundo;
        case "fundo_cnpj":
          return row.fundo_cnpj;
        case "pl":
          return row.pl;
        case "exposicao":
          return row.exposicao;
        case "var_hist_pct":
          return row.var_hist_pct;
        case "var_param_pct":
          return row.var_param_pct;
        case "consumo_pct":
          return row.consumo_pct;
        case "status":
          return row.status;
        default:
          return null;
      }
    },
    MERCADO_STATUS_ORDER,
    "status",
  );
}

function deriveMercadoStatus(linha: LinhaConsolidada): MercadoFundRow["status"] {
  if (linha.var_hist_pct == null && linha.var_param_pct == null) return "sem_dados";
  const consumo = linha.consumo_pct;
  if (consumo == null) return "ok";
  if (consumo >= 100) return "breach";
  if (consumo >= 85) return "alerta";
  return "ok";
}

function useRiscoConsolidadoReport(isoDate: string | undefined) {
  return useQuery({
    queryKey: ["risco-mercado-relatorios", isoDate ?? "latest"],
    enabled: !!isoDate,
    queryFn: async () => {
      const resp = await fetchRiscoConsolidado(isoDate);
      const linhas: MercadoFundRow[] = resp.linhas.map((l) => ({
        ...l,
        status: deriveMercadoStatus(l),
      }));
      linhas.sort((a, b) => {
        const diff = (STATUS_PRIORITY[a.status] ?? 5) - (STATUS_PRIORITY[b.status] ?? 5);
        if (diff !== 0) return diff;
        return (b.consumo_pct ?? 0) - (a.consumo_pct ?? 0);
      });
      return { ...resp, linhas };
    },
    staleTime: 5 * 60_000,
  });
}

interface RiscoMercadoRelatorioPanelProps {
  embedded?: boolean;
}

export function RiscoMercadoRelatorioPanel({ embedded: _embedded }: RiscoMercadoRelatorioPanelProps) {
  const queryClient = useQueryClient();
  const [dateIso, setDateIso] = useState<string | undefined>(undefined);
  const [busca, setBusca] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [activeTab, setActiveTab] = useState("diario");
  const [isExporting, setIsExporting] = useState<"excel" | "pdf" | null>(null);
  const { sortConfig, toggleSort, getDirection } = useRelatorioSort<MercadoSortKey>("nome_fundo");

  const { data: availableDates = [] } = usePosicaoAvailableDatesQuery();
  const { data: months = [] } = useRiscoMercadoMonthlyMonths();

  const availableIsoDates = useMemo(
    () => availableDates.map(yyyymmddToIso),
    [availableDates],
  );

  useEffect(() => {
    if (availableIsoDates.length > 0 && !dateIso) setDateIso(availableIsoDates[0]);
  }, [availableIsoDates, dateIso]);

  useEffect(() => {
    if (months.length > 0 && !selectedMonth) setSelectedMonth(months[0].mes);
  }, [months, selectedMonth]);

  const dateForMonthIso = useMemo(() => {
    const m = months.find((x) => x.mes === selectedMonth);
    return m?.ultimaIso;
  }, [months, selectedMonth]);

  const { data: dailyData, isLoading, isFetching } = useRiscoConsolidadoReport(dateIso);
  const { data: monthlyData, isLoading: loadingMonthly } = useRiscoConsolidadoReport(dateForMonthIso);

  const selectedDate = dateIso ? parseISO(`${dateIso}T12:00:00`) : undefined;
  const selectedMonthDate = dateForMonthIso ? parseISO(`${dateForMonthIso}T12:00:00`) : undefined;

  const filterLinhas = useCallback(
    (rows: MercadoFundRow[]) => {
      if (!busca.trim()) return rows;
      const t = busca.toLowerCase();
      return rows.filter(
        (f) => f.nome_fundo.toLowerCase().includes(t) || f.fundo_cnpj.includes(t),
      );
    },
    [busca],
  );

  const filteredDaily = useMemo(
    () => sortMercadoRows(filterLinhas(dailyData?.linhas ?? []), sortConfig.key, sortConfig.direction),
    [dailyData?.linhas, filterLinhas, sortConfig],
  );
  const filteredMonthly = useMemo(
    () => sortMercadoRows(filterLinhas(monthlyData?.linhas ?? []), sortConfig.key, sortConfig.direction),
    [monthlyData?.linhas, filterLinhas, sortConfig],
  );

  const stats = useMemo(() => {
    const arr = filteredDaily;
    return {
      total: arr.length,
      ok: arr.filter((f) => f.status === "ok").length,
      alerta: arr.filter((f) => f.status === "alerta").length,
      breach: arr.filter((f) => f.status === "breach").length,
      sem_dados: arr.filter((f) => f.status === "sem_dados").length,
      plTotal: arr.reduce((s, f) => s + f.pl, 0),
    };
  }, [filteredDaily]);

  const statsComite = useMemo(
    () =>
      [
        { name: "OK", value: stats.ok, color: "#16a34a" },
        { name: "Alerta", value: stats.alerta, color: "#eab308" },
        { name: "Breach", value: stats.breach, color: "#ef4444" },
        { name: "Sem Dados", value: stats.sem_dados, color: "#94a3b8" },
      ].filter((x) => x.value > 0),
    [stats],
  );

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["risco-mercado-relatorios"] });
    toast.success("Dados atualizados");
  };

  const handleExportConsolidado = async (tipo: "excel" | "pdf", iso?: string) => {
    const target = iso ?? dateIso;
    if (!target) return;
    setIsExporting(tipo);
    try {
      const data = await fetchRiscoConsolidado(target);
      if (tipo === "excel") exportRiscoConsolidadoExcel(data);
      else exportRiscoConsolidadoPdf(data);
      toast.success(`Relatório ${tipo.toUpperCase()} exportado (${data.linhas.length} fundos).`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao exportar");
    } finally {
      setIsExporting(null);
    }
  };

  const handleExportMensal = () => {
    const rows = filteredMonthly.map((f) => ({
      Fundo: f.nome_fundo,
      CNPJ: formatCnpj(f.fundo_cnpj),
      PL: f.pl,
      Exposição: f.exposicao,
      "VaR Histórico (%)": f.var_hist_pct,
      "VaR Paramétrico (%)": f.var_param_pct,
      "Stress Consumo (%)": f.consumo_pct,
      Status:
        f.status === "ok"
          ? "OK"
          : f.status === "alerta"
            ? "Alerta"
            : f.status === "breach"
              ? "Breach"
              : "Sem Dados",
      "Data Base": dateForMonthIso ?? "—",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Mensal ${monthLabelFromYyyymm(selectedMonth)}`);
    XLSX.writeFile(wb, `Relatorio_Risco_Mercado_Mensal_${selectedMonth}.xlsx`);
  };

  const handleExportComite = () => {
    const ws1 = XLSX.utils.json_to_sheet([
      { Métrica: "Total de Fundos", Valor: stats.total },
      { Métrica: "OK", Valor: stats.ok },
      { Métrica: "Alerta (Stress ≥85%)", Valor: stats.alerta },
      { Métrica: "Breach (Stress ≥100%)", Valor: stats.breach },
      { Métrica: "Sem Dados VaR", Valor: stats.sem_dados },
      { Métrica: "PL Total (R$)", Valor: stats.plTotal },
      { Métrica: "Data Referência", Valor: selectedDate ? format(selectedDate, "dd/MM/yyyy") : "—" },
    ]);
    const ws2 = XLSX.utils.json_to_sheet(
      filteredDaily.map((f) => ({
        Fundo: f.nome_fundo,
        CNPJ: formatCnpj(f.fundo_cnpj),
        PL: f.pl,
        "VaR Hist (%)": f.var_hist_pct,
        "Consumo Stress (%)": f.consumo_pct,
        Status: f.status,
      })),
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "Resumo Executivo");
    XLSX.utils.book_append_sheet(wb, ws2, "Detalhamento por Fundo");
    XLSX.writeFile(wb, `Relatorio_Comite_Risco_Mercado_${format(selectedDate || new Date(), "yyyyMMdd")}.xlsx`);
  };

  const renderTable = (rows: MercadoFundRow[]) => (
    <Table>
      <TableHeader>
        <TableRow>
          <RelatorioSortableHead
            label="Fundo"
            sortKey="nome_fundo"
            direction={getDirection("nome_fundo")}
            onSort={(k) => toggleSort(k as MercadoSortKey)}
          />
          <RelatorioSortableHead
            label="CNPJ"
            sortKey="fundo_cnpj"
            direction={getDirection("fundo_cnpj")}
            onSort={(k) => toggleSort(k as MercadoSortKey)}
          />
          <RelatorioSortableHead
            label="PL"
            sortKey="pl"
            direction={getDirection("pl")}
            onSort={(k) => toggleSort(k as MercadoSortKey)}
            align="right"
            className="text-right"
          />
          <RelatorioSortableHead
            label="Exposição"
            sortKey="exposicao"
            direction={getDirection("exposicao")}
            onSort={(k) => toggleSort(k as MercadoSortKey)}
            align="right"
            className="text-right"
          />
          <RelatorioSortableHead
            label="VaR Hist"
            sortKey="var_hist_pct"
            direction={getDirection("var_hist_pct")}
            onSort={(k) => toggleSort(k as MercadoSortKey)}
            align="right"
            className="text-right"
          />
          <RelatorioSortableHead
            label="VaR Param"
            sortKey="var_param_pct"
            direction={getDirection("var_param_pct")}
            onSort={(k) => toggleSort(k as MercadoSortKey)}
            align="right"
            className="text-right"
          />
          <RelatorioSortableHead
            label="Stress Consumo"
            sortKey="consumo_pct"
            direction={getDirection("consumo_pct")}
            onSort={(k) => toggleSort(k as MercadoSortKey)}
            align="right"
            className="text-right"
          />
          <RelatorioSortableHead
            label="Status"
            sortKey="status"
            direction={getDirection("status")}
            onSort={(k) => toggleSort(k as MercadoSortKey)}
            align="center"
            className="text-center"
          />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((f) => (
          <TableRow key={f.fundo_cnpj}>
            <TableCell className="font-medium text-sm">{f.nome_fundo}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{formatCnpj(f.fundo_cnpj)}</TableCell>
            <TableCell className="text-right font-mono text-xs">{formatBRL(f.pl)}</TableCell>
            <TableCell className="text-right font-mono text-xs">{formatBRL(f.exposicao)}</TableCell>
            <TableCell className="text-right font-mono text-xs">{formatPctDisplay(f.var_hist_pct)}</TableCell>
            <TableCell className="text-right font-mono text-xs">{formatPctDisplay(f.var_param_pct)}</TableCell>
            <TableCell className="text-right font-mono text-xs">
              {f.consumo_pct != null ? `${f.consumo_pct.toFixed(1)}%` : "—"}
            </TableCell>
            <TableCell className="text-center">
              <RelatorioStatusBadge status={f.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  const kpiItems = [
    { label: "Total", value: stats.total },
    { label: "OK", value: stats.ok, variant: "ok" as const },
    { label: "Alerta", value: stats.alerta, variant: "alerta" as const },
    { label: "Breach", value: stats.breach, variant: "violacao" as const },
    { label: "PL Total", value: stats.plTotal, variant: "pl" as const, isCurrency: true },
  ];

  const availableDatesMap = useMemo(() => new Set(availableIsoDates), [availableIsoDates]);

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
      <TabsList className="grid w-full max-w-2xl grid-cols-3">
        <TabsTrigger value="diario" className="flex items-center gap-2">
          <CalendarIcon className="h-4 w-4" />
          Relatório Diário
        </TabsTrigger>
        <TabsTrigger value="mensal" className="flex items-center gap-2">
          <CalendarIcon className="h-4 w-4" />
          Relatório Mensal
        </TabsTrigger>
        <TabsTrigger value="comite" className="flex items-center gap-2">
          <Users className="h-4 w-4" />
          Comitê de Risco
        </TabsTrigger>
      </TabsList>

      <TabsContent value="diario" className="space-y-4 mt-6">
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <CalendarIcon className="h-4 w-4" />
                {selectedDate ? format(selectedDate, "dd/MM/yyyy") : "Selecionar data"}
              </Button>
            </PopoverTrigger>
            <PopoverContent>
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={(d) => d && setDateIso(format(d, "yyyy-MM-dd"))}
                locale={ptBR}
                modifiers={{
                  hasData: (d) => availableDatesMap.has(format(d, "yyyy-MM-dd")),
                }}
                modifiersClassNames={{ hasData: "font-bold text-primary" }}
              />
            </PopoverContent>
          </Popover>
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Buscar fundo..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              className="w-[200px]"
            />
            <Button size="sm" variant="outline" onClick={handleRefresh} disabled={isFetching}>
              {isFetching ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Atualizar
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleExportConsolidado("excel")}
              disabled={!!isExporting || filteredDaily.length === 0}
            >
              <Download className="h-4 w-4 mr-2" />
              Excel
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleExportConsolidado("pdf")}
              disabled={!!isExporting || filteredDaily.length === 0}
            >
              <FileDown className="h-4 w-4 mr-2" />
              PDF
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <RelatorioKpiCards items={kpiItems} />
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              {renderTable(filteredDaily)}
            </div>
          </>
        )}
      </TabsContent>

      <TabsContent value="mensal" className="space-y-4 mt-6">
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
          <Select value={selectedMonth} onValueChange={setSelectedMonth}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Selecionar mês" />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m.mes} value={m.mes}>
                  {monthLabelFromYyyymm(m.mes)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex flex-wrap gap-2">
            <Input placeholder="Buscar fundo..." value={busca} onChange={(e) => setBusca(e.target.value)} className="w-[200px]" />
            <Button size="sm" variant="outline" onClick={handleExportMensal} disabled={filteredMonthly.length === 0}>
              <Download className="h-4 w-4 mr-2" />
              Exportar Excel
            </Button>
          </div>
        </div>
        {loadingMonthly ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            {renderTable(filteredMonthly)}
          </div>
        )}
      </TabsContent>

      <TabsContent value="comite" className="space-y-4 mt-6">
        <div className="flex flex-wrap gap-2 justify-end">
          <Button size="sm" variant="outline" onClick={handleExportComite} disabled={filteredDaily.length === 0}>
            <Download className="h-4 w-4 mr-2" />
            Exportar Excel
          </Button>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Resumo Executivo</CardTitle>
            </CardHeader>
            <CardContent>
              <RelatorioKpiCards items={kpiItems} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Distribuição por Status</CardTitle>
            </CardHeader>
            <CardContent>
              <RelatorioComiteChart data={statsComite} />
            </CardContent>
          </Card>
        </div>
        <div className="bg-card border border-border rounded-lg overflow-hidden">{renderTable(filteredDaily)}</div>
      </TabsContent>
    </Tabs>
  );
}
