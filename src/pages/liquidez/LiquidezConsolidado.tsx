import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { cn } from "@/lib/utils";
import { format, parse, differenceInBusinessDays } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  Search,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Download,
  Filter,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  RefreshCw,
  ListFilter,
  Building2,
} from "lucide-react";
import * as XLSX from "xlsx";

type SortField = "status" | "nome_fundo" | "cnpj_fundo" | "administrador" | "dt_posicao" | "daysDiff";
type SortDir = "asc" | "desc";
type ColFilterKey = "nome_fundo" | "cnpj_fundo" | "administrador" | "dt_posicao" | "daysDiff";

type GestorFilter = "monitorado" | "externo" | "todos";

type FundLastUpdate = {
  nome_fundo: string;
  cnpj_fundo: string;
  dt_posicao: string;
  administrador: string;
  gestor_nome?: string | null;
  cnpj_gestor?: string | null;
  is_monitorado?: boolean;
};

const formatCnpj = (cnpj: string | null) => {
  if (!cnpj) return "";
  const clean = String(cnpj).replace(/\D/g, "");
  if (clean.length !== 14) return cnpj;
  return clean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
};

// ── Componente de filtro por coluna ─────────────────────────────────────────
type ColumnFilterProps = {
  options: { label: string; value: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
  align?: "start" | "center" | "end";
};

function ColumnFilter({ options, selected, onChange, align = "start" }: ColumnFilterProps) {
  const isActive = selected.length > 0;

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex items-center justify-center rounded p-0.5 transition-colors",
            isActive
              ? "text-primary"
              : "text-muted-foreground/50 hover:text-muted-foreground"
          )}
          title="Filtrar coluna"
        >
          <ListFilter className="h-3 w-3" />
          {isActive && (
            <span className="ml-0.5 text-[9px] font-bold leading-none">
              {selected.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-52 p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-xs font-semibold text-foreground">Filtrar</span>
          {isActive && (
            <button
              onClick={() => onChange([])}
              className="text-[10px] text-primary hover:underline"
            >
              Limpar
            </button>
          )}
        </div>
        <ul className="max-h-56 overflow-y-auto py-1">
          {options.map((opt) => {
            const checked = selected.includes(opt.value);
            return (
              <li key={opt.value}>
                <label className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/50 select-none">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(opt.value)}
                    className="h-3.5 w-3.5 rounded border-input accent-primary"
                  />
                  <span className="truncate text-foreground">{opt.label}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

// ────────────────────────────────────────────────────────────────────────────

export default function LiquidezConsolidado() {
  const { session } = useAuth();
  const [busca, setBusca] = useState("");
  const [gestorFilter, setGestorFilter] = useState<GestorFilter>("monitorado");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>("status");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [colFilterValues, setColFilterValues] = useState<Record<ColFilterKey, string[]>>({
    nome_fundo: [],
    cnpj_fundo: [],
    administrador: [],
    dt_posicao: [],
    daysDiff: [],
  });

  const setColFilter = (key: ColFilterKey, values: string[]) => {
    setColFilterValues((prev) => ({ ...prev, [key]: values }));
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const handleCardClick = (filter: string) => {
    setStatusFilter((prev) => (prev === filter ? "all" : filter));
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ChevronsUpDown className="inline h-3 w-3 ml-1 opacity-40" />;
    return sortDir === "asc"
      ? <ChevronUp className="inline h-3 w-3 ml-1" />
      : <ChevronDown className="inline h-3 w-3 ml-1" />;
  };

  const {
    data: funds = [],
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["fund-last-updates", session?.user.id],
    enabled: !!session?.user.id,
    queryFn: async () => {
      const { data, error: rpcError } = await supabase.rpc("get_fund_last_updates");

      if (rpcError) {
        console.error("Erro ao buscar atualizações:", rpcError);
        throw rpcError;
      }

      return (data as FundLastUpdate[]) || [];
    },
  });

  const processedFunds = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return funds.map((fund) => {
      let dateObj: Date | null = null;
      let daysDiff = -1;
      let status: "ok" | "warning" | "critical" = "ok";

      if (fund.dt_posicao && fund.dt_posicao.length === 8) {
        try {
          dateObj = parse(fund.dt_posicao, "yyyyMMdd", new Date());
          dateObj.setHours(0, 0, 0, 0);
          daysDiff = differenceInBusinessDays(today, dateObj);
        } catch (e) {
          console.error("Erro ao processar data:", fund.dt_posicao);
        }
      }

      if (daysDiff > 5) {
        status = "critical";
      } else if (daysDiff >= 4) {
        status = "warning";
      } else {
        status = "ok";
      }

      return { ...fund, dateObj, daysDiff, status };
    });
  }, [funds]);

  const scopedFunds = useMemo(() => {
    if (gestorFilter === "monitorado") {
      return processedFunds.filter((f) => f.is_monitorado);
    }
    if (gestorFilter === "externo") {
      return processedFunds.filter((f) => !f.is_monitorado);
    }
    return processedFunds;
  }, [processedFunds, gestorFilter]);

  // Opções únicas por coluna (calculadas do escopo de gestora atual)
  const colOptions = useMemo(() => {
    const unique = <T,>(arr: T[]) => Array.from(new Set(arr)).filter(Boolean);

    const fundos = unique(scopedFunds.map((f) => f.nome_fundo))
      .sort((a, b) => (a as string).localeCompare(b as string, "pt-BR"))
      .map((v) => ({ label: v as string, value: v as string }));

    const cnpjs = unique(scopedFunds.map((f) => f.cnpj_fundo))
      .sort()
      .map((v) => ({ label: formatCnpj(v as string), value: v as string }));

    const admins = unique(scopedFunds.map((f) => f.administrador))
      .sort((a, b) => (a as string).localeCompare(b as string, "pt-BR"))
      .map((v) => ({ label: v as string, value: v as string }));

    const datas = unique(
      scopedFunds
        .filter((f) => f.dateObj)
        .map((f) => format(f.dateObj!, "dd/MM/yyyy"))
    )
      .sort()
      .map((v) => ({ label: v as string, value: v as string }));

    const dias = unique(
      scopedFunds.filter((f) => f.daysDiff >= 0).map((f) => String(f.daysDiff))
    )
      .sort((a, b) => Number(a) - Number(b))
      .map((v) => ({ label: `D+${v}`, value: v as string }));

    return { fundos, cnpjs, admins, datas, dias };
  }, [scopedFunds]);

  const filtered = useMemo(() => {
    let rows = scopedFunds;

    if (statusFilter !== "all") {
      rows = rows.filter((f) => f.status === statusFilter);
    }

    if (busca.trim()) {
      const t = busca.toLowerCase();
      rows = rows.filter(
        (f) =>
          (f.nome_fundo || "").toLowerCase().includes(t) ||
          (f.cnpj_fundo || "").includes(t) ||
          (f.administrador || "").toLowerCase().includes(t) ||
          (f.gestor_nome || "").toLowerCase().includes(t)
      );
    }

    if (colFilterValues.nome_fundo.length > 0) {
      rows = rows.filter((f) => colFilterValues.nome_fundo.includes(f.nome_fundo));
    }
    if (colFilterValues.cnpj_fundo.length > 0) {
      rows = rows.filter((f) => colFilterValues.cnpj_fundo.includes(f.cnpj_fundo));
    }
    if (colFilterValues.administrador.length > 0) {
      rows = rows.filter((f) => colFilterValues.administrador.includes(f.administrador));
    }
    if (colFilterValues.dt_posicao.length > 0) {
      rows = rows.filter((f) =>
        f.dateObj ? colFilterValues.dt_posicao.includes(format(f.dateObj, "dd/MM/yyyy")) : false
      );
    }
    if (colFilterValues.daysDiff.length > 0) {
      rows = rows.filter((f) =>
        f.daysDiff >= 0 ? colFilterValues.daysDiff.includes(String(f.daysDiff)) : false
      );
    }

    const statusOrder: Record<string, number> = { critical: 0, warning: 1, ok: 2 };
    const dir = sortDir === "asc" ? 1 : -1;

    return [...rows].sort((a, b) => {
      switch (sortField) {
        case "status":
          return (dir * (statusOrder[a.status] - statusOrder[b.status])) ||
            (b.daysDiff - a.daysDiff);
        case "nome_fundo":
          return dir * (a.nome_fundo || "").localeCompare(b.nome_fundo || "", "pt-BR");
        case "cnpj_fundo":
          return dir * (a.cnpj_fundo || "").localeCompare(b.cnpj_fundo || "");
        case "administrador":
          return dir * (a.administrador || "").localeCompare(b.administrador || "", "pt-BR");
        case "dt_posicao":
          return dir * ((a.dateObj?.getTime() ?? 0) - (b.dateObj?.getTime() ?? 0));
        case "daysDiff":
          return dir * (a.daysDiff - b.daysDiff);
        default:
          return 0;
      }
    });
  }, [scopedFunds, statusFilter, busca, colFilterValues, sortField, sortDir]);

  const handleExportExcel = () => {
    const rows = filtered.map((f) => ({
      Fundo: f.nome_fundo,
      CNPJ: formatCnpj(f.cnpj_fundo),
      Gestor: f.gestor_nome || "N/A",
      "Minha gestora": f.is_monitorado ? "Sim" : "Não",
      Administrador: f.administrador || "N/A",
      "Última Data": f.dateObj ? format(f.dateObj, "dd/MM/yyyy") : "N/A",
      "Dias Atraso": f.daysDiff >= 0 ? f.daysDiff : "N/A",
      Status:
        f.status === "ok"
          ? "Atualizado"
          : f.status === "warning"
          ? "Atenção (D+4/D+5)"
          : "Atrasado (> D+5)",
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Dashboard de XMLs");
    XLSX.writeFile(wb, `Dashboard_XMLs_${format(new Date(), "yyyyMMdd")}.xlsx`);
  };

  const monitorados = useMemo(
    () => processedFunds.filter((f) => f.is_monitorado),
    [processedFunds],
  );

  const stats = useMemo(() => ({
    meusFundos: monitorados.length,
    ok: scopedFunds.filter((f) => f.status === "ok").length,
    warning: scopedFunds.filter((f) => f.status === "warning").length,
    critical: scopedFunds.filter((f) => f.status === "critical").length,
    externos: processedFunds.filter((f) => !f.is_monitorado).length,
  }), [monitorados, scopedFunds, processedFunds]);

  const anyColFilter = Object.values(colFilterValues).some((v) => v.length > 0);

  const filteredByGestorOnly =
    !isLoading &&
    !isError &&
    funds.length > 0 &&
    scopedFunds.length === 0 &&
    gestorFilter !== "todos" &&
    statusFilter === "all" &&
    !busca.trim() &&
    !anyColFilter;

  const emptyMessage = isError
    ? error instanceof Error
      ? error.message
      : "Erro ao carregar dados. Verifique o console do navegador (F12)."
    : funds.length === 0
      ? "Nenhum fundo com posição importada. Importe XMLs em Dados → Importar XML."
      : filteredByGestorOnly
        ? gestorFilter === "monitorado"
          ? "Nenhum fundo das suas gestoras. Cadastre gestores em Dados → Gestores Monitorados ou altere o filtro para «Todas as gestoras»."
          : "Nenhum fundo de outras gestoras com os filtros atuais."
        : "Nenhum fundo encontrado com os filtros selecionados.";

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-border pb-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Dashboard de XMLs
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2"
              onClick={() => refetch()}
              disabled={isFetching}
              title="Atualizar dados"
            >
              <RefreshCw className={cn("w-4 h-4", isFetching && "animate-spin")} />
              Atualizar
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2"
              onClick={handleExportExcel}
              disabled={filtered.length === 0}
            >
              <Download className="w-4 h-4" />
              Exportar Excel
            </Button>
          </div>
        </div>

        {/* Cards de Resumo */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
          <div
            className={cn(
              "bg-card border rounded-xl p-4 shadow-sm transition-all cursor-pointer",
              gestorFilter === "monitorado" && statusFilter === "all"
                ? "border-primary ring-2 ring-primary/20"
                : "border-border hover:shadow-md hover:border-border/80"
            )}
            onClick={() => {
              setGestorFilter("monitorado");
              setStatusFilter("all");
            }}
            title="Ver fundos das minhas gestoras"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">Meus Fundos</span>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="mt-2 text-2xl font-bold">{stats.meusFundos}</div>
          </div>
          <div
            className={cn(
              "border rounded-xl p-4 shadow-sm transition-all",
              statusFilter === "ok"
                ? "bg-emerald-100 border-emerald-400 ring-2 ring-emerald-300/40 cursor-default"
                : "bg-emerald-50/50 border-emerald-100 hover:shadow-md cursor-pointer hover:border-emerald-300"
            )}
            onClick={() => handleCardClick("ok")}
            title="Filtrar por Atualizados"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-emerald-700">Atualizados (Até D+3)</span>
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            </div>
            <div className="mt-2 text-2xl font-bold text-emerald-700">{stats.ok}</div>
          </div>
          <div
            className={cn(
              "border rounded-xl p-4 shadow-sm transition-all",
              statusFilter === "warning"
                ? "bg-amber-100 border-amber-400 ring-2 ring-amber-300/40 cursor-default"
                : "bg-amber-50/50 border-amber-100 hover:shadow-md cursor-pointer hover:border-amber-300"
            )}
            onClick={() => handleCardClick("warning")}
            title="Filtrar por Atenção"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-amber-700">Atenção (D+4 a D+5)</span>
              <AlertTriangle className="h-4 w-4 text-amber-600" />
            </div>
            <div className="mt-2 text-2xl font-bold text-amber-700">{stats.warning}</div>
          </div>
          <div
            className={cn(
              "border rounded-xl p-4 shadow-sm transition-all",
              statusFilter === "critical"
                ? "bg-red-100 border-red-400 ring-2 ring-red-300/40 cursor-default"
                : "bg-red-50/50 border-red-100 hover:shadow-md cursor-pointer hover:border-red-300"
            )}
            onClick={() => handleCardClick("critical")}
            title="Filtrar por Atrasados"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-red-700">Atrasados ({">"} D+5)</span>
              <XCircle className="h-4 w-4 text-red-600" />
            </div>
            <div className="mt-2 text-2xl font-bold text-red-700">{stats.critical}</div>
          </div>
          <div
            className={cn(
              "border rounded-xl p-4 shadow-sm transition-all",
              gestorFilter === "externo"
                ? "bg-slate-100 border-slate-400 ring-2 ring-slate-300/40 cursor-default"
                : "bg-slate-50/50 border-slate-200 hover:shadow-md cursor-pointer hover:border-slate-300"
            )}
            onClick={() =>
              setGestorFilter((prev) => (prev === "externo" ? "monitorado" : "externo"))
            }
            title="Fundos de gestoras fora da allowlist (look-through)"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">Outras Gestoras</span>
              <Building2 className="h-4 w-4 text-slate-600" />
            </div>
            <div className="mt-2 text-2xl font-bold text-slate-700">{stats.externos}</div>
          </div>
        </div>

        {/* Filtros e Tabela */}
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar fundo por nome ou CNPJ..."
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                className="pl-9 bg-card"
              />
            </div>
            <div className="flex items-center gap-2">
              <Select value={gestorFilter} onValueChange={(v) => setGestorFilter(v as GestorFilter)}>
                <SelectTrigger className="w-[210px]">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    <SelectValue placeholder="Filtrar gestora" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monitorado">Minhas gestoras</SelectItem>
                  <SelectItem value="externo">Outras gestoras</SelectItem>
                  <SelectItem value="todos">Todas as gestoras</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[200px]">
                  <div className="flex items-center gap-2">
                    <Filter className="h-4 w-4" />
                    <SelectValue placeholder="Filtrar status" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os status</SelectItem>
                  <SelectItem value="ok">Atualizados (Até D+3)</SelectItem>
                  <SelectItem value="warning">Atenção (D+4 a D+5)</SelectItem>
                  <SelectItem value="critical">Atrasados ({">"} D+5)</SelectItem>
                </SelectContent>
              </Select>
              {anyColFilter && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setColFilterValues({
                      nome_fundo: [],
                      cnpj_fundo: [],
                      administrador: [],
                      dt_posicao: [],
                      daysDiff: [],
                    })
                  }
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Limpar filtros
                </Button>
              )}
            </div>
          </div>

          <div className="bg-transparent">
            <Table className="border-separate border-spacing-y-2">
              <TableHeader className="bg-transparent border-none">
                <TableRow className="hover:bg-transparent border-none">
                  {/* STATUS – sem filtro de coluna, já coberto pelos cards */}
                  <TableHead
                    className="w-[60px] text-center text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 select-none cursor-pointer hover:text-foreground transition-colors"
                    onClick={() => handleSort("status")}
                  >
                    Status<SortIcon field="status" />
                  </TableHead>

                  {/* FUNDO */}
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 select-none transition-colors">
                    <div className="flex items-center gap-1">
                      <span
                        className="cursor-pointer hover:text-foreground"
                        onClick={() => handleSort("nome_fundo")}
                      >
                        Fundo<SortIcon field="nome_fundo" />
                      </span>
                      <ColumnFilter
                        options={colOptions.fundos}
                        selected={colFilterValues.nome_fundo}
                        onChange={(v) => setColFilter("nome_fundo", v)}
                      />
                    </div>
                  </TableHead>

                  {/* CNPJ */}
                  <TableHead className="w-[180px] text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 select-none transition-colors">
                    <div className="flex items-center gap-1">
                      <span
                        className="cursor-pointer hover:text-foreground"
                        onClick={() => handleSort("cnpj_fundo")}
                      >
                        CNPJ<SortIcon field="cnpj_fundo" />
                      </span>
                      <ColumnFilter
                        options={colOptions.cnpjs}
                        selected={colFilterValues.cnpj_fundo}
                        onChange={(v) => setColFilter("cnpj_fundo", v)}
                      />
                    </div>
                  </TableHead>

                  {/* ADMINISTRADOR */}
                  <TableHead className="w-[180px] text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 select-none transition-colors">
                    <div className="flex items-center gap-1">
                      <span
                        className="cursor-pointer hover:text-foreground"
                        onClick={() => handleSort("administrador")}
                      >
                        Administrador<SortIcon field="administrador" />
                      </span>
                      <ColumnFilter
                        options={colOptions.admins}
                        selected={colFilterValues.administrador}
                        onChange={(v) => setColFilter("administrador", v)}
                        align="end"
                      />
                    </div>
                  </TableHead>

                  {/* ÚLTIMA DATA */}
                  <TableHead className="w-[150px] text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 select-none transition-colors">
                    <div className="flex items-center justify-end gap-1">
                      <ColumnFilter
                        options={colOptions.datas}
                        selected={colFilterValues.dt_posicao}
                        onChange={(v) => setColFilter("dt_posicao", v)}
                        align="end"
                      />
                      <span
                        className="cursor-pointer hover:text-foreground"
                        onClick={() => handleSort("dt_posicao")}
                      >
                        Última Data<SortIcon field="dt_posicao" />
                      </span>
                    </div>
                  </TableHead>

                  {/* DIAS ATRASO */}
                  <TableHead className="w-[150px] text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 select-none transition-colors">
                    <div className="flex items-center justify-end gap-1">
                      <ColumnFilter
                        options={colOptions.dias}
                        selected={colFilterValues.daysDiff}
                        onChange={(v) => setColFilter("daysDiff", v)}
                        align="end"
                      />
                      <span
                        className="cursor-pointer hover:text-foreground"
                        onClick={() => handleSort("daysDiff")}
                      >
                        Dias Atraso<SortIcon field="daysDiff" />
                      </span>
                    </div>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow className="bg-card shadow-sm rounded-lg border border-border/50">
                    <TableCell colSpan={6} className="h-32 text-center rounded-xl">
                      <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
                        <Loader2 className="h-6 w-6 animate-spin" />
                        <span>Carregando dados...</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow className="bg-card shadow-sm rounded-lg border border-border/50">
                    <TableCell colSpan={6} className="h-32 text-center rounded-xl">
                      <p
                        className={cn(
                          "text-sm max-w-lg mx-auto",
                          isError ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
                        )}
                      >
                        {emptyMessage}
                      </p>
                      {filteredByGestorOnly && gestorFilter === "monitorado" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          onClick={() => setGestorFilter("todos")}
                        >
                          Ver todas as gestoras
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((f) => (
                    <TableRow
                      key={f.cnpj_fundo}
                      className="group bg-card hover:bg-card/80 transition-all shadow-sm hover:shadow-md border-transparent"
                    >
                      <TableCell className="text-center rounded-l-xl border-l border-y border-border/40 py-4">
                        <div className="flex justify-center">
                          {f.status === "ok" && (
                            <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]" />
                          )}
                          {f.status === "warning" && (
                            <div className="h-1.5 w-1.5 rounded-full bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.6)]" />
                          )}
                          {f.status === "critical" && (
                            <div className="h-1.5 w-1.5 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]" />
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="border-y border-border/40 py-4">
                        <span className="text-sm font-semibold text-foreground">
                          {f.nome_fundo || "Nome não disponível"}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground border-y border-border/40 py-4">
                        {formatCnpj(f.cnpj_fundo)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground border-y border-border/40 py-4">
                        <div className="max-w-[180px] truncate" title={f.administrador}>
                          {f.administrador || "-"}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm border-y border-border/40 py-4">
                        {f.dateObj ? (
                          format(f.dateObj, "dd/MM/yyyy")
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right rounded-r-xl border-r border-y border-border/40 py-4">
                        {f.daysDiff >= 0 ? (
                          <span
                            className={cn(
                              "font-mono text-xs font-bold mr-4",
                              f.status === "ok" && "text-emerald-600",
                              f.status === "warning" && "text-amber-600",
                              f.status === "critical" && "text-red-600"
                            )}
                          >
                            {f.daysDiff === 0 ? "D+0" : `D+${f.daysDiff}`}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs font-mono mr-4">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </Layout>
  );
}
