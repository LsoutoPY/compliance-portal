import { useState, useMemo, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
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
import { DateRefNavigator } from "@/components/DateRefNavigator";
import { cn } from "@/lib/utils";
import { format, parse } from "date-fns";
import { ptBR } from "date-fns/locale";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { exportEnquadramentoConsolidadoPdf } from "@/lib/exportPdf";
import { exportEnquadramentoConsolidadoExcel } from "@/lib/exportFundoExcel";
import { RelatorioKpiCards } from "./RelatorioKpiCards";
import { RelatorioComiteChart } from "./RelatorioComiteChart";
import { RelatorioStatusBadge } from "./RelatorioStatusBadge";
import { RelatorioSortableHead } from "./RelatorioSortableHead";
import { sortRelatorioRows, useRelatorioSort } from "./useRelatorioSort";
import {
  formatCnpj,
  formatBRL,
  formatDateToDB,
  monthLabelFromYyyymm,
  normalizeCnpj,
  STATUS_PRIORITY,
  usePosicaoAvailableDatesQuery,
  usePosicaoMonthlyMonths,
  fetchPrimeiraDataEnquadramentoMes,
} from "./relatorioUtils";
import { fetchParesMonitorados } from "@/lib/fundosMonitorados";

type EnquadramentoFundRow = {
  nome_fundo: string;
  fundo_cnpj: string;
  fundo_isin: string;
  dt_posicao: string;
  administrador: string;
  pl: number;
  statusDetail: string;
  nViolacoes: number;
  nAlertas: number;
  nRegras: number;
};

function fundRowKey(cnpj: string, isin: string) {
  return `${normalizeCnpj(cnpj)}|${isin ?? ""}`;
}

type EnquadramentoSortKey =
  | "nome_fundo"
  | "fundo_cnpj"
  | "administrador"
  | "pl"
  | "nRegras"
  | "nViolacoes"
  | "statusDetail";

const ENQUADRAMENTO_STATUS_ORDER: Record<string, number> = {
  violacao: 0,
  alerta: 1,
  pendente: 2,
  ok: 3,
};

function sortEnquadramentoRows(rows: EnquadramentoFundRow[], key: EnquadramentoSortKey, direction: "none" | "asc" | "desc") {
  return sortRelatorioRows(
    rows,
    key,
    direction,
    (row, k) => {
      switch (k as EnquadramentoSortKey) {
        case "nome_fundo":
          return row.nome_fundo;
        case "fundo_cnpj":
          return row.fundo_cnpj;
        case "administrador":
          return row.administrador;
        case "pl":
          return row.pl;
        case "nRegras":
          return row.nRegras;
        case "nViolacoes":
          return row.nViolacoes;
        case "statusDetail":
          return row.statusDetail;
        default:
          return null;
      }
    },
    ENQUADRAMENTO_STATUS_ORDER,
    "statusDetail",
  );
}

function useEnquadramentoFunds(date: Date | undefined) {
  return useQuery({
    queryKey: ["enquadramento-relatorios-funds", date ? formatDateToDB(date) : "none"],
    enabled: !!date,
    queryFn: async (): Promise<EnquadramentoFundRow[]> => {
      if (!date) return [];
      const dateStr = formatDateToDB(date);

      // Pares monitorados (filtra por cnpjgestor via RPC)
      const paresMonitorados = await fetchParesMonitorados(dateStr);
      if (!paresMonitorados.length) return [];

      const enquadramentoData: Array<{
        fundo_cnpj: string;
        fundo_isin: string;
        status: string;
        regra_codigo: string;
      }> = [];
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data: page, error: enqError } = await supabase
          .from("enquadramento_resultado" as any)
          .select("fundo_cnpj, fundo_isin, status, regra_codigo")
          .eq("fundo_dtposicao", dateStr)
          .range(offset, offset + PAGE - 1) as {
          data: Array<{ fundo_cnpj: string; fundo_isin: string; status: string; regra_codigo: string }> | null;
          error: unknown;
        };
        if (enqError) throw enqError;
        if (!page?.length) break;
        enquadramentoData.push(...page);
        if (page.length < PAGE) break;
        offset += PAGE;
      }

      const statusMap = new Map<string, string>();
      const countsMap = new Map<string, { violacao: number; alerta: number; regras: Set<string> }>();

      for (const item of enquadramentoData) {
        const cnpjKey = normalizeCnpj(item.fundo_cnpj);
        if (!cnpjKey) continue;
        const isinKey = item.fundo_isin ?? "";
        const key = `${cnpjKey}|${isinKey}`;

        const current = statusMap.get(key);
        if (item.status === "violacao" || !current) {
          statusMap.set(key, item.status);
        } else if (item.status === "alerta" && current !== "violacao") {
          statusMap.set(key, item.status);
        }

        const counts = countsMap.get(key) ?? { violacao: 0, alerta: 0, regras: new Set<string>() };
        if (item.regra_codigo) counts.regras.add(item.regra_codigo);
        if (item.status === "violacao") counts.violacao += 1;
        if (item.status === "alerta") counts.alerta += 1;
        countsMap.set(key, counts);
      }

      // Monta lista usando pares da RPC (já deduplica + só monitorados)
      const rows: EnquadramentoFundRow[] = paresMonitorados.map((par) => {
        const isin = par.fundo_isin ?? "";
        const cnpjNorm = normalizeCnpj(par.fundo_cnpj);
        const lookupKey = `${cnpjNorm}|${isin}`;
        const statusDetail =
          statusMap.get(lookupKey) ??
          (isin ? statusMap.get(`${cnpjNorm}|`) : undefined) ??
          "pendente";
        const counts =
          countsMap.get(lookupKey) ??
          countsMap.get(`${cnpjNorm}|`) ??
          { violacao: 0, alerta: 0, regras: new Set<string>() };

        return {
          nome_fundo: par.nome_fundo || par.fundo_cnpj,
          fundo_cnpj: par.fundo_cnpj,
          fundo_isin: isin,
          dt_posicao: dateStr,
          administrador: "—",
          pl: par.fundo_patliq ?? 0,
          statusDetail,
          nViolacoes: counts.violacao,
          nAlertas: counts.alerta,
          nRegras: counts.regras.size,
        };
      });

      return rows.sort((a, b) => {
        const diff =
          (STATUS_PRIORITY[a.statusDetail] ?? 5) - (STATUS_PRIORITY[b.statusDetail] ?? 5);
        if (diff !== 0) return diff;
        return b.pl - a.pl;
      });
    },
  });
}

interface EnquadramentoRelatorioPanelProps {
  embedded?: boolean;
}

export function EnquadramentoRelatorioPanel({ embedded: _embedded }: EnquadramentoRelatorioPanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [date, setDate] = useState<Date | undefined>(undefined);
  const [busca, setBusca] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [activeTab, setActiveTab] = useState("diario");
  const [processing, setProcessing] = useState(false);
  const [processProgress, setProcessProgress] = useState(0);
  const [processTotal, setProcessTotal] = useState(0);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [loadingFundCnpj, setLoadingFundCnpj] = useState<string | null>(null);
  const { sortConfig, toggleSort, getDirection } = useRelatorioSort<EnquadramentoSortKey>("nome_fundo");

  const { data: availableDates = [] } = usePosicaoAvailableDatesQuery();
  const { data: months = [] } = usePosicaoMonthlyMonths();
  const { data: funds = [], isLoading } = useEnquadramentoFunds(date);

  useEffect(() => {
    if (availableDates.length > 0 && !date) {
      setDate(parse(availableDates[0], "yyyyMMdd", new Date()));
    }
  }, [availableDates, date]);

  useEffect(() => {
    if (months.length > 0 && !selectedMonth) setSelectedMonth(months[0].mes);
  }, [months, selectedMonth]);

  const dateForMonth = useMemo(() => {
    const m = months.find((x) => x.mes === selectedMonth);
    if (!m) return undefined;
    return parse(m.ultimaDt, "yyyyMMdd", new Date());
  }, [months, selectedMonth]);

  const { data: monthlyFunds = [], isLoading: loadingMonthly } = useEnquadramentoFunds(dateForMonth);

  const filterFunds = useCallback(
    (rows: EnquadramentoFundRow[]) => {
      if (!busca.trim()) return rows;
      const t = busca.toLowerCase();
      return rows.filter(
        (f) =>
          f.nome_fundo.toLowerCase().includes(t) ||
          f.fundo_cnpj.includes(t) ||
          f.administrador.toLowerCase().includes(t),
      );
    },
    [busca],
  );

  const filteredDaily = useMemo(
    () => sortEnquadramentoRows(filterFunds(funds), sortConfig.key, sortConfig.direction),
    [funds, filterFunds, sortConfig],
  );
  const filteredMonthly = useMemo(
    () => sortEnquadramentoRows(filterFunds(monthlyFunds), sortConfig.key, sortConfig.direction),
    [monthlyFunds, filterFunds, sortConfig],
  );

  const stats = useMemo(() => {
    const arr = filteredDaily;
    return {
      total: arr.length,
      ok: arr.filter((f) => f.statusDetail === "ok").length,
      alerta: arr.filter((f) => f.statusDetail === "alerta").length,
      violacao: arr.filter((f) => f.statusDetail === "violacao").length,
      pendente: arr.filter((f) => f.statusDetail === "pendente").length,
      plTotal: arr.reduce((s, f) => s + f.pl, 0),
    };
  }, [filteredDaily]);

  const statsComite = useMemo(
    () =>
      [
        { name: "Regular", value: stats.ok, color: "#16a34a" },
        { name: "Alerta", value: stats.alerta, color: "#eab308" },
        { name: "Violação", value: stats.violacao, color: "#ef4444" },
        { name: "Pendente", value: stats.pendente, color: "#94a3b8" },
      ].filter((x) => x.value > 0),
    [stats],
  );

  const handleRecalculate = async () => {
    const targetDate = activeTab === "mensal" ? dateForMonth : date;
    const targetFunds = activeTab === "mensal" ? monthlyFunds : funds;
    if (!targetDate || targetFunds.length === 0) return;

    const dateStr = formatDateToDB(targetDate);
    setProcessing(true);
    setProcessTotal(targetFunds.length);
    setProcessProgress(0);

    let erros = 0;
    for (let i = 0; i < targetFunds.length; i++) {
      const f = targetFunds[i];
      const body: Record<string, string> = {
        fundo_cnpj: f.fundo_cnpj,
        fundo_dtposicao: dateStr,
      };
      if (f.fundo_isin) body.fundo_isin = f.fundo_isin;

      const { error } = await supabase.functions.invoke("check-enquadramento", { body });
      if (error) erros++;
      setProcessProgress(i + 1);
    }

    setProcessing(false);
    queryClient.invalidateQueries({ queryKey: ["enquadramento-relatorios-funds"] });
    queryClient.invalidateQueries({ queryKey: ["funds-list"] });

    if (erros === 0) toast.success(`Verificação concluída — ${targetFunds.length} fundos.`);
    else toast.warning(`Concluído com ${erros} erro(s).`);
  };

  const toExportRows = (rows: EnquadramentoFundRow[]) =>
    rows.map((f) => ({
      nome_fundo: f.nome_fundo,
      fundo_cnpj: f.fundo_cnpj,
      dt_posicao: f.dt_posicao,
      statusDetail: f.statusDetail,
      administrador: f.administrador,
      pl: f.pl,
      nRegras: f.nRegras,
      nViolacoes: f.nViolacoes,
    }));

  const exportOptions = { layout: "completo" as const };

  const handleExportPdf = async () => {
    if (!date || filteredDaily.length === 0) return;
    setIsExportingPdf(true);
    try {
      await exportEnquadramentoConsolidadoPdf(
        toExportRows(filteredDaily),
        format(date, "dd/MM/yyyy"),
        exportOptions,
      );
    } catch {
      toast.error("Erro ao gerar PDF");
    } finally {
      setIsExportingPdf(false);
    }
  };

  const handleExportExcel = async () => {
    if (!date || filteredDaily.length === 0) return;
    setIsExportingExcel(true);
    try {
      await exportEnquadramentoConsolidadoExcel(
        toExportRows(filteredDaily),
        format(date, "dd/MM/yyyy"),
        exportOptions,
      );
    } catch {
      toast.error("Erro ao gerar Excel");
    } finally {
      setIsExportingExcel(false);
    }
  };

  const handleExportMensal = () => {
    const rows = filteredMonthly.map((f) => ({
      Fundo: f.nome_fundo,
      CNPJ: formatCnpj(f.fundo_cnpj),
      Administrador: f.administrador,
      PL: f.pl,
      "Regras": f.nRegras,
      Violações: f.nViolacoes,
      Alertas: f.nAlertas,
      Status:
        f.statusDetail === "ok"
          ? "Regular"
          : f.statusDetail === "alerta"
            ? "Alerta"
            : f.statusDetail === "violacao"
              ? "Violação"
              : "Pendente",
      "Data Posição": dateForMonth ? format(dateForMonth, "dd/MM/yyyy") : "—",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Mensal ${monthLabelFromYyyymm(selectedMonth)}`);
    XLSX.writeFile(wb, `Relatorio_Enquadramento_Mensal_${selectedMonth}.xlsx`);
  };

  const handleExportMensalPdf = async () => {
    if (!dateForMonth || filteredMonthly.length === 0) return;
    setIsExportingPdf(true);
    try {
      const dataRef = `${monthLabelFromYyyymm(selectedMonth)} — ${format(dateForMonth, "dd/MM/yyyy")}`;
      await exportEnquadramentoConsolidadoPdf(toExportRows(filteredMonthly), dataRef, {
        titulo: "RELATÓRIO MENSAL DE ENQUADRAMENTO",
        layout: "completo",
        fileName: `Relatorio_Enquadramento_Mensal_${selectedMonth}`,
      });
    } catch {
      toast.error("Erro ao gerar PDF");
    } finally {
      setIsExportingPdf(false);
    }
  };

  const handleExportComite = () => {
    const ws1 = XLSX.utils.json_to_sheet([
      { Métrica: "Total de Fundos", Valor: stats.total },
      { Métrica: "Regular", Valor: stats.ok },
      { Métrica: "Alerta", Valor: stats.alerta },
      { Métrica: "Violação", Valor: stats.violacao },
      { Métrica: "Pendente", Valor: stats.pendente },
      { Métrica: "PL Total (R$)", Valor: stats.plTotal },
      { Métrica: "Data Referência", Valor: date ? format(date, "dd/MM/yyyy") : "—" },
    ]);
    const ws2 = XLSX.utils.json_to_sheet(
      filteredDaily.map((f) => ({
        Fundo: f.nome_fundo,
        CNPJ: formatCnpj(f.fundo_cnpj),
        PL: f.pl,
        Violações: f.nViolacoes,
        Status:
          f.statusDetail === "ok"
            ? "Regular"
            : f.statusDetail === "alerta"
              ? "Alerta"
              : f.statusDetail === "violacao"
                ? "Violação"
                : "Pendente",
      })),
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "Resumo Executivo");
    XLSX.utils.book_append_sheet(wb, ws2, "Detalhamento por Fundo");
    XLSX.writeFile(wb, `Relatorio_Comite_Enquadramento_${format(date || new Date(), "yyyyMMdd")}.xlsx`);
  };

  const handleMonthlyFundClick = async (f: EnquadramentoFundRow) => {
    if (!selectedMonth) return;

    setLoadingFundCnpj(fundRowKey(f.fundo_cnpj, f.fundo_isin));
    try {
      if (f.statusDetail === "violacao" || f.statusDetail === "alerta") {
        const primeiraDt = await fetchPrimeiraDataEnquadramentoMes(
          f.fundo_cnpj,
          selectedMonth,
          f.statusDetail as "violacao" | "alerta",
          f.fundo_isin || null,
        );
        const targetDt = primeiraDt ?? f.dt_posicao;
        const targetDate = parse(targetDt, "yyyyMMdd", new Date());

        setDate(targetDate);
        setActiveTab("diario");

        toast.info(
          primeiraDt
            ? `Relatório diário — primeiro ${f.statusDetail === "violacao" ? "desenquadramento" : "alerta"} em ${format(targetDate, "dd/MM/yyyy")}`
            : `Relatório diário — ${format(targetDate, "dd/MM/yyyy")}`,
        );
        return;
      }

      const targetDate = dateForMonth ?? parse(f.dt_posicao, "yyyyMMdd", new Date());
      setDate(targetDate);
      setActiveTab("diario");
      toast.info(`Relatório diário — última data do mês (${format(targetDate, "dd/MM/yyyy")})`);
    } catch {
      toast.error("Não foi possível abrir o relatório diário");
    } finally {
      setLoadingFundCnpj(null);
    }
  };

  const renderTable = (
    rows: EnquadramentoFundRow[],
    mode: "daily" | "monthly" | "comite" = "daily",
  ) => (
    <Table>
      <TableHeader>
        <TableRow>
          <RelatorioSortableHead
            label="Fundo"
            sortKey="nome_fundo"
            direction={getDirection("nome_fundo")}
            onSort={(k) => toggleSort(k as EnquadramentoSortKey)}
          />
          <RelatorioSortableHead
            label="CNPJ"
            sortKey="fundo_cnpj"
            direction={getDirection("fundo_cnpj")}
            onSort={(k) => toggleSort(k as EnquadramentoSortKey)}
          />
          <RelatorioSortableHead
            label="Administrador"
            sortKey="administrador"
            direction={getDirection("administrador")}
            onSort={(k) => toggleSort(k as EnquadramentoSortKey)}
          />
          <RelatorioSortableHead
            label="PL"
            sortKey="pl"
            direction={getDirection("pl")}
            onSort={(k) => toggleSort(k as EnquadramentoSortKey)}
            align="right"
            className="text-right"
          />
          <RelatorioSortableHead
            label="Regras"
            sortKey="nRegras"
            direction={getDirection("nRegras")}
            onSort={(k) => toggleSort(k as EnquadramentoSortKey)}
            align="center"
            className="text-center"
          />
          <RelatorioSortableHead
            label="Violações"
            sortKey="nViolacoes"
            direction={getDirection("nViolacoes")}
            onSort={(k) => toggleSort(k as EnquadramentoSortKey)}
            align="center"
            className="text-center"
          />
          <RelatorioSortableHead
            label="Status"
            sortKey="statusDetail"
            direction={getDirection("statusDetail")}
            onSort={(k) => toggleSort(k as EnquadramentoSortKey)}
            align="center"
            className="text-center"
          />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((f) => {
          const isClickableMonthly = mode === "monthly";
          const isClickableCarteira = mode === "daily" || mode === "comite";
          const rowKey = fundRowKey(f.fundo_cnpj, f.fundo_isin);
          const isLoading = loadingFundCnpj === rowKey;
          const isinSuffix = f.fundo_isin
            ? `?isin=${encodeURIComponent(f.fundo_isin)}`
            : "";
          const carteiraPath = `/enquadramento/carteira/${f.fundo_cnpj}/${f.dt_posicao}${isinSuffix}`;

          return (
          <TableRow
            key={rowKey}
            className={cn(
              (isClickableCarteira || isClickableMonthly) && "hover:bg-muted/50",
              (isClickableCarteira || isClickableMonthly) && "cursor-pointer",
            )}
            onClick={
              isClickableCarteira
                ? () => navigate(carteiraPath)
                : undefined
            }
          >
            <TableCell className="font-medium text-sm">
              {isClickableMonthly ? (
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => handleMonthlyFundClick(f)}
                  className={cn(
                    "text-left hover:text-primary hover:underline underline-offset-2 transition-colors",
                    isLoading && "opacity-60 cursor-wait",
                  )}
                  title={
                    f.statusDetail === "violacao"
                      ? "Ver primeiro dia de violação no mês"
                      : f.statusDetail === "alerta"
                        ? "Ver primeiro dia de alerta no mês"
                        : "Ver relatório diário na última data do mês"
                  }
                >
                  {isLoading ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {f.nome_fundo}
                    </span>
                  ) : (
                    f.nome_fundo
                  )}
                </button>
              ) : isClickableCarteira ? (
                <span className="hover:text-primary hover:underline underline-offset-2 transition-colors">
                  {f.nome_fundo}
                </span>
              ) : (
                f.nome_fundo
              )}
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{formatCnpj(f.fundo_cnpj)}</TableCell>
            <TableCell className="text-xs text-muted-foreground truncate max-w-[140px]">{f.administrador}</TableCell>
            <TableCell className="text-right font-mono text-xs">{formatBRL(f.pl)}</TableCell>
            <TableCell className="text-center text-xs">{f.nRegras || "—"}</TableCell>
            <TableCell className="text-center text-xs font-semibold text-red-600">{f.nViolacoes || "—"}</TableCell>
            <TableCell className="text-center">
              <RelatorioStatusBadge
                status={
                  f.statusDetail === "ok"
                    ? "regular"
                    : f.statusDetail === "alerta"
                      ? "alerta"
                      : f.statusDetail === "violacao"
                        ? "violacao"
                        : "pendente"
                }
              />
            </TableCell>
          </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );

  const kpiItems = [
    { label: "Total", value: stats.total },
    { label: "Regular", value: stats.ok, variant: "ok" as const },
    { label: "Alerta", value: stats.alerta, variant: "alerta" as const },
    { label: "Violação", value: stats.violacao, variant: "violacao" as const },
    { label: "PL Total", value: stats.plTotal, variant: "pl" as const, isCurrency: true },
  ];

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
          <DateRefNavigator
            availableDates={availableDates}
            date={date}
            onDateChange={setDate}
            formatDateToDB={formatDateToDB}
          />
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Buscar fundo..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              className="w-[200px]"
            />
            <Button size="sm" variant="outline" onClick={handleRecalculate} disabled={processing || funds.length === 0}>
              {processing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              {processing ? `${processProgress}/${processTotal}` : "Recalcular"}
            </Button>
            <Button size="sm" variant="outline" onClick={handleExportExcel} disabled={isExportingExcel || filteredDaily.length === 0}>
              <Download className="h-4 w-4 mr-2" />
              Excel
            </Button>
            <Button size="sm" variant="outline" onClick={handleExportPdf} disabled={isExportingPdf || filteredDaily.length === 0}>
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
            <Button size="sm" variant="outline" onClick={handleRecalculate} disabled={processing || monthlyFunds.length === 0}>
              {processing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Recalcular
            </Button>
            <Button size="sm" variant="outline" onClick={handleExportMensal} disabled={filteredMonthly.length === 0}>
              <Download className="h-4 w-4 mr-2" />
              Excel
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExportMensalPdf}
              disabled={isExportingPdf || filteredMonthly.length === 0}
            >
              {isExportingPdf ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FileDown className="h-4 w-4 mr-2" />
              )}
              PDF
            </Button>
          </div>
        </div>
        {loadingMonthly ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="bg-card border border-border rounded-lg overflow-hidden">{renderTable(filteredMonthly, "monthly")}</div>
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
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {renderTable(filteredDaily, "comite")}
        </div>
      </TabsContent>
    </Tabs>
  );
}
