import { useState, useMemo, useEffect, Fragment } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { Search, Loader2, Calendar as CalendarIcon, CalendarRange, Filter, MoreHorizontal, ArrowRight, AlertCircle, CheckCircle2, Clock, PlayCircle, ClipboardCheck, XCircle, ChevronDown, ChevronRight, FileDown, ChevronsUpDown, ChevronUp, X, Users2 } from "lucide-react";
import { RulesSheet, RulesStatusBadges, RulesList } from "@/components/RulesSheet";
import { resolveStoredComplianceStatus } from "@/lib/fipClasseCompliance";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { DateRefNavigator } from "@/components/DateRefNavigator";
import { cn } from "@/lib/utils";
import { fetchPosicaoAvailableDates } from "@/lib/posicaoAvailableDates";
import { format, parse } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Layout } from "@/components/Layout";
import { exportEnquadramentoConsolidadoPdf } from "@/lib/exportPdf";
import { exportEnquadramentoConsolidadoExcel } from "@/lib/exportFundoExcel";
import { EnquadramentoPeriodoDialog } from "@/components/enquadramento/EnquadramentoPeriodoDialog";
import { ProcessarPendentesDialog } from "@/components/monitoramento/ProcessarPendentesDialog";
import { fetchParesMonitorados, buildParKey } from "@/lib/fundosMonitorados";
import { useFundosXmlCoverage } from "@/hooks/useRentabilidadeData";
import { FundosComXmlIndicator } from "@/components/FundosComXmlIndicator";

type SortDirection = "none" | "asc" | "desc";
type SortKey = "nome_fundo" | "fundo_cnpj" | "dt_posicao" | "status";

export function EnquadramentoList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busca, setBusca] = useState("");
  const [date, setDate] = useState<Date | undefined>(undefined);
  const [isRunningCheck, setIsRunningCheck] = useState(false);
  const [checkProgress, setCheckProgress] = useState<{ current: number; total: number } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [expandedFund, setExpandedFund] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string[]>([]);
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "status",
    direction: "none",
  });

  // Fund selector (applies to single-date and period runs)
  const [selectedFundsCnpjs, setSelectedFundsCnpjs] = useState<Set<string>>(new Set());
  const [fundSelectorOpen, setFundSelectorOpen] = useState(false);
  const [fundSelectorSearch, setFundSelectorSearch] = useState("");

  // Period recalculation dialog
  const [rangeDialogOpen, setRangeDialogOpen] = useState(false);

  // Processar pendentes dialog
  const [pendentesDialogOpen, setPendentesDialogOpen] = useState(false);

  // Helper to format date to YYYYMMDD
  const formatDateToDB = (d: Date) => format(d, "yyyyMMdd");
  const dataRefIso = date ? format(date, "yyyy-MM-dd") : null;

  const {
    total: xmlTotal,
    importados: xmlImportados,
    faltantes: xmlFaltantes,
    isLoading: xmlCoverageLoading,
  } = useFundosXmlCoverage(dataRefIso);

  const cnpjKey = (s: string) => String(s ?? "").replace(/\D/g, "");

  const handleRunAllChecks = async () => {
    if (!date) return;

    setIsRunningCheck(true);
    setCheckProgress(null);
    const dateStr = formatDateToDB(date);

    try {
      // Pares únicos (cnpj, isin) — necessário para processar subclasses separadamente
      let fundPairs: Array<{ fundo_cnpj: string; fundo_isin: string }>;

      if (selectedFundsCnpjs.size > 0) {
        // Mapeia as chaves "cnpj|isin" selecionadas de volta para pares
        fundPairs = [...selectedFundsCnpjs].map(key => {
          const [cnpj, isin = ""] = key.split("|");
          return { fundo_cnpj: cnpj, fundo_isin: isin };
        });
      } else {
        // Busca apenas pares de fundos monitorados (filtra por cnpjgestor via RPC)
        const pares = await fetchParesMonitorados(dateStr);
        fundPairs = pares.map((p) => ({
          fundo_cnpj: p.fundo_cnpj,
          fundo_isin: p.fundo_isin ?? "",
        }));
      }

      if (fundPairs.length === 0) {
        toast.warning("Nenhum fundo encontrado para esta data.");
        return;
      }

      const total = fundPairs.length;
      let erros = 0;
      const toastId = toast.loading(`Processando fundo 1 de ${total}...`);

      for (let i = 0; i < fundPairs.length; i++) {
        const { fundo_cnpj: cnpj, fundo_isin: isin } = fundPairs[i];
        setCheckProgress({ current: i + 1, total });
        toast.loading(`Processando fundo ${i + 1} de ${total}...`, { id: toastId });

        const body: Record<string, string> = { fundo_cnpj: cnpj, fundo_dtposicao: dateStr };
        if (isin) body.fundo_isin = isin;

        const { error } = await supabase.functions.invoke('check-enquadramento', { body });

        if (error) {
          console.error(`Erro no fundo ${cnpj} isin=${isin}:`, error);
          erros++;
        }
      }

      queryClient.invalidateQueries({ queryKey: ["funds-list"] });
      queryClient.invalidateQueries({ queryKey: ["enquadramento-rules"] });
      queryClient.invalidateQueries({ queryKey: ["enquadramento-rules-summary"] });
      queryClient.invalidateQueries({ queryKey: ["enquadramento-timeline"] });
      queryClient.invalidateQueries({ queryKey: ["fund-status-header"] });

      if (erros === 0) {
        toast.success(`Verificação concluída — ${total} fundos processados.`, { id: toastId });
      } else {
        toast.warning(`Concluído com ${erros} erro(s) — ${total - erros} de ${total} fundos OK.`, { id: toastId });
      }
    } catch (err: any) {
      toast.error(`Erro ao processar: ${err.message}`);
    } finally {
      setIsRunningCheck(false);
      setCheckProgress(null);
    }
  };


  // Fetch available dates from the database (view vw_posicao_datas_disponiveis)
  const { data: availableDates = [] } = useQuery({
    queryKey: ["available-dates"],
    queryFn: fetchPosicaoAvailableDates,
  });

  // Sempre iniciar na data mais recente disponível
  useEffect(() => {
    if (availableDates.length > 0 && !date) {
      const latestDateStr = availableDates[0];
      const parsedDate = parse(latestDateStr, "yyyyMMdd", new Date());
      setDate(parsedDate);
    }
  }, [availableDates, date]);

  const availableDatesMap = useMemo(() => {
    return new Set(availableDates);
  }, [availableDates]);

  // Fetch funds monitorados para a data selecionada (filtro por cnpjgestor via RPC)
  const { data: funds = [], isLoading } = useQuery({
    queryKey: ["funds-list", date ? formatDateToDB(date) : "none"],
    enabled: !!date,
    queryFn: async () => {
      if (!date) return [];
      const dateStr = formatDateToDB(date);

      // Pares monitorados — apenas fundos da allowlist de gestores
      const paresMonitorados = await fetchParesMonitorados(dateStr);
      if (paresMonitorados.length === 0) return [];

      // Fetch enquadramento results for this date — inclui fundo_isin para lookup correto
      const { data: enquadramentoData } = await supabase
        .from("enquadramento_resultado" as any)
        .select("fundo_cnpj, fundo_isin, regra_codigo, status, valor_atual, valor_limite, detalhes")
        .eq("fundo_dtposicao", dateStr) as { data: Array<{
          fundo_cnpj: string;
          fundo_isin: string;
          regra_codigo: string;
          status: string;
          valor_atual: number | null;
          valor_limite: number | null;
          detalhes: Record<string, unknown> | null;
        }> | null };

      const normalizeCnpj = (cnpj: string) => cnpj.replace(/\D/g, '');

      // Mapa "cnpj_limpo|isin" -> pior status
      const statusMap = new Map<string, string>();
      if (enquadramentoData) {
        enquadramentoData.forEach((item) => {
          const effectiveStatus = resolveStoredComplianceStatus(item);
          const cnpjKey = normalizeCnpj(item.fundo_cnpj);
          if (!cnpjKey) return;
          const isinKey = item.fundo_isin ?? '';
          const key = `${cnpjKey}|${isinKey}`;
          const currentStatus = statusMap.get(key);
          if (effectiveStatus === 'violacao' || !currentStatus) {
            statusMap.set(key, effectiveStatus);
          } else if (effectiveStatus === 'alerta' && currentStatus !== 'violacao') {
            statusMap.set(key, effectiveStatus);
          }
        });
      }

      // Monta lista usando pares da RPC (já deduplica + só monitorados)
      return paresMonitorados.map((par) => {
        const isin = par.fundo_isin ?? '';
        const cnpjNorm = normalizeCnpj(par.fundo_cnpj);
        const enquadramentoStatus =
          statusMap.get(`${cnpjNorm}|${isin}`) ??
          (isin ? statusMap.get(`${cnpjNorm}|`) : undefined);
        const displayStatus = enquadramentoStatus === 'violacao' ? "desenquadrado" : "enquadrado";
        return {
          nome_fundo: par.nome_fundo || par.fundo_cnpj,
          fundo_cnpj: par.fundo_cnpj,
          fundo_isin: isin,
          dt_posicao: dateStr,
          status: displayStatus,
          statusDetail: enquadramentoStatus || 'pendente',
        };
      });
    },
  });

  const handleExportPdf = async () => {
    if (!date || funds.length === 0) return;
    setIsExporting(true);
    try {
      const dataRef = format(date, "dd/MM/yyyy");
      await exportEnquadramentoConsolidadoPdf(funds, dataRef);
    } catch (err) {
      toast.error("Erro ao gerar PDF");
      console.error(err);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportExcel = async () => {
    if (!date || funds.length === 0) return;
    setIsExportingExcel(true);
    try {
      const dataRef = format(date, "dd/MM/yyyy");
      await exportEnquadramentoConsolidadoExcel(funds, dataRef);
    } catch (err) {
      toast.error("Erro ao gerar Excel");
      console.error(err);
    } finally {
      setIsExportingExcel(false);
    }
  };

  // Resolve display status para filtro e ordenação
  const getDisplayStatus = (fund: { status: string; statusDetail: string }) => {
    if (fund.statusDetail === "pendente") return "pendente";
    if (fund.status === "desenquadrado")  return "violacao";
    return "regular";
  };

  // Prioridade numérica para ordenação: violação primeiro, depois pendente, depois regular
  const statusPriority: Record<string, number> = { violacao: 0, pendente: 1, regular: 2 };

  const toggleSort = (key: SortKey) => {
    setSortConfig((current) => {
      if (current.key !== key) return { key, direction: "asc" };
      if (current.direction === "none") return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      return { key, direction: "none" };
    });
  };

  const getColumnSortDirection = (key: SortKey): SortDirection =>
    sortConfig.key === key ? sortConfig.direction : "none";

  const getSortTitle = (key: SortKey, label: string) => {
    const direction = getColumnSortDirection(key);
    if (direction === "asc") return `${label}: crescente`;
    if (direction === "desc") return `${label}: decrescente`;
    return `Clique para ordenar por ${label.toLowerCase()}`;
  };

  const renderSortIcon = (key: SortKey) => {
    const direction = getColumnSortDirection(key);
    if (direction === "none") return <ChevronsUpDown className="h-3 w-3 text-muted-foreground/50" />;
    if (direction === "asc") return <ChevronUp className="h-3 w-3 text-primary" />;
    return <ChevronDown className="h-3 w-3 text-primary" />;
  };

  const fundsFiltrados = useMemo(() => {
    const termo = busca.toLowerCase();

    let result = funds.filter((f) => {
      const matchBusca =
        (f.nome_fundo?.toLowerCase() || "").includes(termo) ||
        (f.fundo_cnpj || "").includes(termo);

      const matchStatus =
        filterStatus.length === 0 || filterStatus.includes(getDisplayStatus(f));

      return matchBusca && matchStatus;
    });

    if (sortConfig.direction !== "none") {
      result = [...result].sort((a, b) => {
        let diff = 0;

        switch (sortConfig.key) {
          case "nome_fundo":
            diff = (a.nome_fundo || "").localeCompare(b.nome_fundo || "", "pt-BR", { sensitivity: "base" });
            break;
          case "fundo_cnpj":
            diff = (a.fundo_cnpj || "").localeCompare(b.fundo_cnpj || "", "pt-BR");
            break;
          case "dt_posicao":
            diff = (a.dt_posicao || "").localeCompare(b.dt_posicao || "");
            break;
          case "status": {
            const pa = statusPriority[getDisplayStatus(a)] ?? 99;
            const pb = statusPriority[getDisplayStatus(b)] ?? 99;
            diff = pa - pb;
            break;
          }
        }

        if (diff !== 0) return sortConfig.direction === "asc" ? diff : -diff;
        return (a.nome_fundo || "").localeCompare(b.nome_fundo || "", "pt-BR", { sensitivity: "base" });
      });
    }

    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [funds, busca, filterStatus, sortConfig]);

  return (
    <Layout>
      <div className="space-y-4">
        {/* Header Section */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-end gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <FundosComXmlIndicator
              variant="compact"
              dataRefIso={dataRefIso}
              dataRefLabel={date ? format(date, "dd/MM/yyyy") : undefined}
              total={xmlTotal}
              importados={xmlImportados}
              faltantes={xmlFaltantes}
              isLoading={xmlCoverageLoading}
            />

            {/* Seletor de fundos */}
            <Popover open={fundSelectorOpen} onOpenChange={setFundSelectorOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant={selectedFundsCnpjs.size > 0 ? "default" : "outline"}
                  size="sm"
                  className="h-8 px-3 gap-2 text-sm font-medium"
                  title="Selecionar fundos para verificar"
                >
                  <Users2 className="h-3.5 w-3.5" />
                  {selectedFundsCnpjs.size === 0 ? "Todos os fundos" : `${selectedFundsCnpjs.size} fundo${selectedFundsCnpjs.size !== 1 ? "s" : ""}`}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-2" align="end">
                <div className="space-y-2">
                  <div className="flex items-center justify-between px-1 pb-1.5 border-b border-border">
                    <span className="text-xs font-medium text-muted-foreground">Selecionar fundos</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setSelectedFundsCnpjs(new Set(funds.map((f: any) => `${cnpjKey(f.fundo_cnpj)}|${f.fundo_isin ?? ''}`)))}
                        className="text-[10px] text-primary hover:underline"
                      >
                        Todos
                      </button>
                      <span className="text-muted-foreground text-[10px]">·</span>
                      <button
                        onClick={() => setSelectedFundsCnpjs(new Set())}
                        className="text-[10px] text-muted-foreground hover:underline"
                      >
                        Limpar
                      </button>
                    </div>
                  </div>
                  <Input
                    placeholder="Buscar fundo..."
                    value={fundSelectorSearch}
                    onChange={(e) => setFundSelectorSearch(e.target.value)}
                    className="h-7 text-xs"
                  />
                  <div className="max-h-60 overflow-y-auto space-y-0.5 pr-0.5">
                    {(funds as any[])
                      .filter((f: any) =>
                        (f.nome_fundo?.toLowerCase() || "").includes(fundSelectorSearch.toLowerCase()) ||
                        (f.fundo_cnpj || "").includes(fundSelectorSearch)
                      )
                      .map((f: any) => {
                        const key = `${cnpjKey(f.fundo_cnpj)}|${f.fundo_isin ?? ''}`;
                        const checked = selectedFundsCnpjs.has(key);
                        return (
                          <button
                            key={key}
                            onClick={() => {
                              const next = new Set(selectedFundsCnpjs);
                              if (checked) next.delete(key); else next.add(key);
                              setSelectedFundsCnpjs(next);
                            }}
                            className={cn(
                              "w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left transition-colors",
                              checked ? "bg-muted font-medium" : "hover:bg-muted/60"
                            )}
                          >
                            <span className={cn(
                              "w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0",
                              checked ? "bg-primary border-primary" : "border-border"
                            )}>
                              {checked && <CheckCircle2 className="h-2 w-2 text-primary-foreground" />}
                            </span>
                            <span className="truncate flex-1">
                              {f.nome_fundo || f.fundo_cnpj}
                              {f.fundo_isin && <span className="ml-1 text-muted-foreground/60 text-[9px]">({f.fundo_isin})</span>}
                            </span>
                          </button>
                        );
                      })}
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            {/* Rodar por período */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3 gap-2 text-sm font-medium"
              onClick={() => setRangeDialogOpen(true)}
              disabled={isRunningCheck}
              title="Rodar verificação em múltiplas datas de uma vez"
            >
              <CalendarRange className="h-3.5 w-3.5" />
              Período
            </Button>

            {/* Processar pendentes */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3 gap-2 text-sm font-medium"
              onClick={() => setPendentesDialogOpen(true)}
              disabled={isRunningCheck}
              title="Calcular apenas os fundos/datas ainda sem verificação de enquadramento ou liquidez"
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              Pendentes
            </Button>

            <Button
              onClick={handleRunAllChecks}
              disabled={isRunningCheck || !date}
              variant="default"
              size="sm"
              className="gap-2"
            >
              {isRunningCheck ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
              <span>
                {checkProgress
                  ? `${checkProgress.current}/${checkProgress.total}`
                  : "Rodar Verificação"}
              </span>
            </Button>

            <Button
              onClick={handleExportPdf}
              disabled={isExporting || funds.length === 0 || !date}
              variant="outline"
              size="sm"
              className="gap-2"
            >
              {isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
              <span>Exportar PDF</span>
            </Button>

            <Button
              onClick={handleExportExcel}
              disabled={isExportingExcel || funds.length === 0 || !date}
              variant="outline"
              size="sm"
              className="gap-2"
            >
              {isExportingExcel ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
              <span>Exportar Excel</span>
            </Button>

            <DateRefNavigator
              availableDates={availableDates}
              date={date}
              onDateChange={setDate}
              formatDateToDB={formatDateToDB}
              popoverAlign="end"
            />
          </div>
        </div>

        {/* Filters and Search */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Buscar fundo por nome ou CNPJ..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              className="pl-9 bg-card border-border h-8 text-sm"
            />
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant={filterStatus.length > 0 ? "default" : "outline"}
                size="sm"
                className="h-8 px-3 gap-2 text-sm font-medium whitespace-nowrap"
              >
                <Filter className="h-3.5 w-3.5" />
                <span>Filtros</span>
                {filterStatus.length > 0 && (
                  <span className="ml-1 rounded-full bg-primary-foreground text-primary w-4 h-4 flex items-center justify-center text-[10px] font-bold">
                    {filterStatus.length}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-52 p-3" align="end">
              <div className="space-y-2">
                <div className="flex items-center justify-between pb-1 border-b border-border">
                  <p className="text-xs font-medium text-muted-foreground">Filtrar por status</p>
                  {filterStatus.length > 0 && (
                    <button
                      onClick={() => setFilterStatus([])}
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                    >
                      <X className="h-3 w-3" /> Limpar
                    </button>
                  )}
                </div>
                {(["violacao", "pendente", "regular"] as const).map((st) => {
                  const labels: Record<string, { label: string; className: string }> = {
                    violacao: { label: "Violação",  className: "text-red-600"     },
                    pendente: { label: "Pendente",  className: "text-slate-500"   },
                    regular:  { label: "Regular",   className: "text-emerald-600" },
                  };
                  const active = filterStatus.includes(st);
                  return (
                    <button
                      key={st}
                      onClick={() =>
                        setFilterStatus((prev) =>
                          active ? prev.filter((s) => s !== st) : [...prev, st]
                        )
                      }
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors",
                        active ? "bg-muted font-bold" : "hover:bg-muted/60"
                      )}
                    >
                      <span
                        className={cn(
                          "w-4 h-4 rounded border flex items-center justify-center shrink-0",
                          active ? "bg-primary border-primary" : "border-border"
                        )}
                      >
                        {active && <CheckCircle2 className="h-2.5 w-2.5 text-primary-foreground" />}
                      </span>
                      <span className={labels[st].className}>{labels[st].label}</span>
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        {/* Content Section */}
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-32 space-y-3">
             <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Sincronizando posições…</p>
          </div>
        ) : fundsFiltrados.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-32 text-center space-y-4 border border-dashed border-border rounded-lg bg-muted/10">
            <div className="p-4 bg-muted rounded-full">
              <Search className="h-8 w-8 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-base font-semibold text-foreground">Nenhum fundo encontrado</p>
              <p className="text-sm text-muted-foreground max-w-md">
                Não encontramos resultados para sua busca nesta data.
              </p>
            </div>
          </div>
        ) : (
          <div className="rcv-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="min-w-[240px]">
                    <button
                      type="button"
                      onClick={() => toggleSort("nome_fundo")}
                      className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
                      title={getSortTitle("nome_fundo", "Fundo")}
                    >
                      <span>Fundo</span>
                      {renderSortIcon("nome_fundo")}
                    </button>
                  </TableHead>
                  <TableHead className="min-w-[140px]">
                    <button
                      type="button"
                      onClick={() => toggleSort("fundo_cnpj")}
                      className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
                      title={getSortTitle("fundo_cnpj", "CNPJ")}
                    >
                      <span>CNPJ</span>
                      {renderSortIcon("fundo_cnpj")}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      type="button"
                      onClick={() => toggleSort("dt_posicao")}
                      className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
                      title={getSortTitle("dt_posicao", "Data")}
                    >
                      <span>Data</span>
                      {renderSortIcon("dt_posicao")}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      type="button"
                      onClick={() => toggleSort("status")}
                      className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
                      title={getSortTitle("status", "Status")}
                    >
                      <span>Status</span>
                      {renderSortIcon("status")}
                    </button>
                  </TableHead>
                  <TableHead>Regras</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fundsFiltrados.map((fund) => {
                  const fundKey = `${fund.fundo_cnpj}|${fund.fundo_isin}`;
                  const isinSuffix = fund.fundo_isin
                    ? `?isin=${encodeURIComponent(fund.fundo_isin)}`
                    : "";
                  const carteiraPath = fund.dt_posicao
                    ? `/enquadramento/carteira/${fund.fundo_cnpj}/${fund.dt_posicao}${isinSuffix}`
                    : `/enquadramento/carteira/${fund.fundo_cnpj}${isinSuffix}`;

                  return (
                  <Fragment key={fundKey}>
                    <TableRow
                      className="cursor-pointer group"
                      onClick={() => navigate(carteiraPath)}
                    >
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <div className="font-medium text-[var(--text-strong)]" title={fund.nome_fundo}>
                            {fund.nome_fundo || "Nome indisponível"}
                          </div>
                          {fund.fundo_isin && (
                            <span className="font-mono text-xs text-muted-foreground">
                              ISIN {fund.fundo_isin}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-sm num whitespace-nowrap">
                        {fund.fundo_cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")}
                      </TableCell>
                      <TableCell className="font-mono text-sm whitespace-nowrap">
                        {fund.dt_posicao?.replace(/(\d{4})(\d{2})(\d{2})/, '$3/$2/$1')}
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "rcv-badge",
                            fund.status === "enquadrado" && "bg-[var(--risk-baixo-surface)] text-[var(--text-positive)]",
                            fund.status === "desenquadrado" && "bg-[var(--risk-critico-surface)] text-[var(--text-negative)]",
                            fund.statusDetail === "pendente" && "bg-[var(--surface-sunken)] text-[var(--text-muted)]"
                          )}
                        >
                          {fund.statusDetail === "pendente" ? (
                            <><Clock className="h-3.5 w-3.5" /> Pendente</>
                          ) : fund.status === "desenquadrado" ? (
                            <><XCircle className="h-3.5 w-3.5" /> Violação</>
                          ) : (
                            <><CheckCircle2 className="h-3.5 w-3.5" /> Regular</>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setExpandedFund(expandedFund === fundKey ? null : fundKey)}
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                          >
                            {expandedFund === fundKey ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                          </Button>
                          <RulesStatusBadges
                            fundoCnpj={fund.fundo_cnpj}
                            fundoDtposicao={fund.dt_posicao}
                            fundoIsin={fund.fundo_isin || null}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <RulesSheet
                            fundoCnpj={fund.fundo_cnpj}
                            fundoDtposicao={fund.dt_posicao}
                            fundoIsin={fund.fundo_isin || null}
                            trigger={
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted"
                              >
                                <ClipboardCheck className="h-4 w-4" />
                              </Button>
                            }
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted"
                            onClick={() => navigate(carteiraPath)}
                          >
                            <ArrowRight className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {expandedFund === fundKey && (
                      <TableRow key={`${fundKey}-expanded`} className="bg-muted/[0.02] border-t-0 hover:bg-muted/[0.02] transition-none">
                        <TableCell colSpan={6} className="p-0 border-b border-border/40">
                          <div className="py-2">
                            <RulesList
                              fundoCnpj={fund.fundo_cnpj}
                              fundoDtposicao={fund.dt_posicao}
                              fundoIsin={fund.fundo_isin || null}
                              maxHeight="500px"
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <EnquadramentoPeriodoDialog
        open={rangeDialogOpen}
        onOpenChange={setRangeDialogOpen}
        availableDates={availableDates}
        availableDatesMap={availableDatesMap}
        selectedFundsCnpjs={selectedFundsCnpjs}
        funds={funds}
        queryClient={queryClient}
      />

      <ProcessarPendentesDialog
        open={pendentesDialogOpen}
        onOpenChange={setPendentesDialogOpen}
        availableDates={availableDates}
        queryClient={queryClient}
      />
    </Layout>
  );
}
