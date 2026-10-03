import { useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bell,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Download,
  FileCheck2,
  FileText,
  Filter,
  Loader2,
  ListChecks,
  MailCheck,
  RefreshCw,
  Search,
  ShieldAlert,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CompetenciaNavigator } from "@/components/relatorios/CompetenciaNavigator";
import { RiscoEpisodiosMonitoramento } from "@/components/relatorios/RiscoEpisodiosMonitoramento";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useCanWrite } from "@/contexts/PermissionsContext";
import {
  useAtualizarRelatorioMensal,
  useAtualizarStatusOcorrencia,
  useClassificarValidadeOcorrencia,
  useRiscoComunicacoes,
  useRiscoOcorrenciasMes,
  useSalvarPlanoRisco,
  useSincronizarOcorrenciasRisco,
} from "@/hooks/useRelatoriosRisco";
import {
  exportRelatorioMensalRiscoExcel,
  exportRelatorioMensalRiscoPdf,
  exportRelatorioMensalRiscoWord,
} from "@/lib/relatorioMensalRiscoExport";
import { countFundosAfetados } from "@/lib/riscoOcorrenciasStats";
import { cn } from "@/lib/utils";
import type {
  RiscoMotivoValidade,
  RiscoModulo,
  RiscoOcorrenciaMensal,
  RiscoRelatorioMensal,
  RiscoValidadeOcorrencia,
  RiscoWorkflowStatus,
} from "@/types/relatorios-risco";
import {
  RISCO_MODULO_LABEL,
  RISCO_MOTIVO_VALIDADE_LABEL,
  RISCO_VALIDADE_LABEL,
  RISCO_WORKFLOW_LABEL,
} from "@/types/relatorios-risco";

type PlanoFilter = "todos" | "recebido" | "pendente";
type ValidadeFilter = "validas" | "todas" | RiscoValidadeOcorrencia;
type StatusFilter = "todos" | "regularizadas_encerradas" | RiscoWorkflowStatus;
type QuickFilter = "violacoes" | "planos_pendentes" | "regularizadas" | null;
type SortColumn =
  | "nivel"
  | "validade"
  | "modulo"
  | "fundo"
  | "evento"
  | "periodo"
  | "notificacao"
  | "plano"
  | "status";
type SortDirection = "asc" | "desc";
type ReportSortColumn = "fundo" | "evento" | "nivel" | "periodo" | "plano" | "status";
type ReportStatusFilter = "todos" | RiscoWorkflowStatus;
type ReportQuickFilter = "fundos" | "ocorrencias" | "abertos" | "planos_pendentes" | null;

interface RiscoOcorrenciasPanelProps {
  modulos?: RiscoModulo[];
  showReportControls?: boolean;
}

const ALL_MODULES: RiscoModulo[] = ["enquadramento", "liquidez", "mercado", "concentracao"];
const REPORT_MODULES: RiscoModulo[] = ["enquadramento", "liquidez", "concentracao"];

function isReportableMensal(item: RiscoOcorrenciaMensal) {
  return item.nivel === "violacao" || (item.modulo === "liquidez" && item.nivel === "atencao");
}

const moduleTone: Record<RiscoModulo, string> = {
  enquadramento: "border-blue-200 bg-blue-50 text-blue-800",
  liquidez: "border-cyan-200 bg-cyan-50 text-cyan-800",
  mercado: "border-violet-200 bg-violet-50 text-violet-800",
  concentracao: "border-orange-200 bg-orange-50 text-orange-800",
};

const REPORT_STATUS_LABEL: Record<RiscoRelatorioMensal["status"], string> = {
  rascunho: "Rascunho",
  em_revisao: "Em revisão",
  aprovado: "Aprovado",
  arquivado: "Arquivado",
};

function formatDate(value: string | null, withTime = false) {
  if (!value) return "—";
  return format(parseISO(value), withTime ? "dd/MM/yyyy HH:mm" : "dd/MM/yyyy", { locale: ptBR });
}

function formatCnpj(value: string) {
  return value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

function NivelBadge({ ocorrencia }: { ocorrencia: RiscoOcorrenciaMensal }) {
  const violacao = ocorrencia.nivel === "violacao";
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 whitespace-nowrap",
        violacao ? "border-red-300 bg-red-50 text-red-800" : "border-amber-300 bg-amber-50 text-amber-800",
      )}
    >
      {violacao ? <ShieldAlert className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
      {violacao ? "Violação" : "Atenção"}
    </Badge>
  );
}

function WorkflowBadge({ status }: { status: RiscoWorkflowStatus }) {
  const style: Record<RiscoWorkflowStatus, string> = {
    aberta: "border-slate-300 bg-slate-50 text-slate-700",
    aguardando_plano: "border-amber-300 bg-amber-50 text-amber-800",
    em_tratamento: "border-blue-300 bg-blue-50 text-blue-800",
    regularizada: "border-emerald-300 bg-emerald-50 text-emerald-800",
    encerrada: "border-slate-300 bg-slate-100 text-slate-700",
  };
  return <Badge variant="outline" className={cn("whitespace-nowrap", style[status])}>{RISCO_WORKFLOW_LABEL[status]}</Badge>;
}

function ValidadeBadge({ validade }: { validade: RiscoValidadeOcorrencia }) {
  const style: Record<RiscoValidadeOcorrencia, string> = {
    confirmada: "border-emerald-300 bg-emerald-50 text-emerald-800",
    em_revisao: "border-amber-300 bg-amber-50 text-amber-800",
    invalidada_correcao_dado: "border-slate-300 bg-slate-100 text-slate-700",
  };
  return (
    <Badge variant="outline" className={cn("whitespace-nowrap", style[validade])}>
      {RISCO_VALIDADE_LABEL[validade]}
    </Badge>
  );
}

function SortableTableHead({
  column,
  label,
  activeColumn,
  direction,
  onSort,
  className,
}: {
  column: SortColumn;
  label: string;
  activeColumn: SortColumn;
  direction: SortDirection;
  onSort: (column: SortColumn) => void;
  className?: string;
}) {
  const active = activeColumn === column;
  const Icon = !active ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <TableHead
      className={className}
      aria-sort={!active ? "none" : direction === "asc" ? "ascending" : "descending"}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className="-ml-2 inline-flex h-10 items-center gap-1.5 rounded-md px-2 font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Ordenar por ${label}`}
      >
        {label}
        <Icon className={cn("h-3.5 w-3.5", active ? "text-foreground" : "text-muted-foreground/60")} />
      </button>
    </TableHead>
  );
}

function ReportSortableHead({
  column,
  label,
  activeColumn,
  direction,
  onSort,
}: {
  column: ReportSortColumn;
  label: string;
  activeColumn: ReportSortColumn;
  direction: SortDirection;
  onSort: (column: ReportSortColumn) => void;
}) {
  const active = activeColumn === column;
  const Icon = !active ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead aria-sort={!active ? "none" : direction === "asc" ? "ascending" : "descending"}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex min-h-10 items-center gap-1 rounded-md px-2 font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Ordenar por ${label}`}
      >
        {label}
        <Icon className={cn("h-3.5 w-3.5", active ? "text-foreground" : "text-muted-foreground/60")} />
      </button>
    </TableHead>
  );
}

function Kpi({
  label,
  value,
  icon: Icon,
  tone,
  onClick,
  active = false,
}: {
  label: string;
  value: number;
  icon: typeof ShieldAlert;
  tone: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const content = (
    <div className="flex items-center justify-between p-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 font-mono text-2xl font-bold tabular-nums">{value}</p>
      </div>
      <div className={cn("rounded-lg p-2", tone)}><Icon className="h-5 w-5" /></div>
    </div>
  );

  if (onClick) {
    return (
      <Card className={cn(
        "overflow-hidden shadow-none transition-colors",
        active && "border-primary ring-2 ring-primary/20",
      )}>
        <button
          type="button"
          onClick={onClick}
          aria-pressed={active}
          aria-label={`${active ? "Remover filtro" : "Filtrar"}: ${label}`}
          title={active ? "Clique para remover este filtro" : `Clique para filtrar ${label.toLocaleLowerCase("pt-BR")}`}
          className="w-full text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {content}
        </button>
      </Card>
    );
  }

  return (
    <Card className="shadow-none">
      <CardContent className="p-0">{content}</CardContent>
    </Card>
  );
}

function ReportControls({
  mes,
  relatorio,
}: {
  mes: string;
  relatorio: RiscoRelatorioMensal | null;
}) {
  const canWrite = useCanWrite();
  const mutation = useAtualizarRelatorioMensal();
  const [manifestacao, setManifestacao] = useState("");
  const [ressalvas, setRessalvas] = useState("");
  const [status, setStatus] = useState<RiscoRelatorioMensal["status"]>("rascunho");

  useEffect(() => {
    setManifestacao(relatorio?.manifestacao_diretor ?? "");
    setRessalvas(relatorio?.ressalvas ?? "");
    setStatus(relatorio?.status ?? "rascunho");
  }, [relatorio]);

  const save = async () => {
    try {
      await mutation.mutateAsync({ mes, manifestacaoDiretor: manifestacao, ressalvas, status });
      toast.success("Manifestação mensal salva.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar o relatório");
    }
  };

  return (
    <Card className="shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileCheck2 className="h-4 w-4" /> Fechamento e manifestação do Diretor de Risco
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 lg:grid-cols-[1fr_1fr_180px_auto]">
        <div className="space-y-1.5">
          <Label htmlFor="manifestacao-diretor">Manifestação executiva</Label>
          <Textarea
            id="manifestacao-diretor"
            value={manifestacao}
            onChange={(event) => setManifestacao(event.target.value)}
            disabled={!canWrite}
            rows={3}
            placeholder="Síntese do Diretor de Risco sobre a exposição e as ocorrências da competência."
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ressalvas-relatorio">Ressalvas e observações</Label>
          <Textarea
            id="ressalvas-relatorio"
            value={ressalvas}
            onChange={(event) => setRessalvas(event.target.value)}
            disabled={!canWrite}
            rows={3}
            placeholder="Registre ressalvas que devam constar no relatório formal."
          />
        </div>
        <div className="space-y-1.5">
          <Label>Status do dossiê</Label>
          <Select value={status} onValueChange={(value) => setStatus(value as RiscoRelatorioMensal["status"])} disabled={!canWrite}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="rascunho">Rascunho</SelectItem>
              <SelectItem value="em_revisao">Em revisão</SelectItem>
              <SelectItem value="aprovado">Aprovado</SelectItem>
              <SelectItem value="arquivado">Arquivado</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button onClick={save} disabled={!canWrite || mutation.isPending} className="w-full lg:w-auto">
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar fechamento
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RelatorioMensalView({
  mes,
  ocorrencias,
  relatorio,
}: {
  mes: string;
  ocorrencias: RiscoOcorrenciaMensal[];
  relatorio: RiscoRelatorioMensal | null;
}) {
  const [buscaRelatorio, setBuscaRelatorio] = useState("");
  const [moduloRelatorio, setModuloRelatorio] = useState<RiscoModulo | "todos">("todos");
  const [nivelRelatorio, setNivelRelatorio] = useState<"todos" | "atencao" | "violacao">("todos");
  const [planoRelatorio, setPlanoRelatorio] = useState<"todos" | "pendente" | "registrado" | "nao_aplicavel">("todos");
  const [statusRelatorio, setStatusRelatorio] = useState<ReportStatusFilter>("todos");
  const [sortRelatorio, setSortRelatorio] = useState<ReportSortColumn>("nivel");
  const [directionRelatorio, setDirectionRelatorio] = useState<SortDirection>("desc");
  const [quickFilterRelatorio, setQuickFilterRelatorio] = useState<ReportQuickFilter>(null);

  const filteredRelatorio = useMemo(() => {
    const term = buscaRelatorio.trim().toLocaleLowerCase("pt-BR");
    const filtered = ocorrencias.filter((item) => {
      if (quickFilterRelatorio === "abertos" && ["regularizada", "encerrada"].includes(item.status_workflow)) return false;
      if (quickFilterRelatorio === "planos_pendentes" && (item.nivel !== "violacao" || item.plano_conteudo)) return false;
      if (moduloRelatorio !== "todos" && item.modulo !== moduloRelatorio) return false;
      if (nivelRelatorio !== "todos" && item.nivel !== nivelRelatorio) return false;
      if (statusRelatorio !== "todos" && item.status_workflow !== statusRelatorio) return false;
      if (planoRelatorio === "registrado" && !item.plano_conteudo) return false;
      if (planoRelatorio === "pendente" && (item.nivel !== "violacao" || item.plano_conteudo)) return false;
      if (planoRelatorio === "nao_aplicavel" && (item.nivel === "violacao" || item.plano_conteudo)) return false;
      if (!term) return true;
      return [item.fundo_nome, item.fundo_cnpj, item.fundo_isin, item.titulo, item.descricao ?? ""]
        .some((value) => value.toLocaleLowerCase("pt-BR").includes(term));
    });

    const valueFor = (item: RiscoOcorrenciaMensal): string | number => {
      switch (sortRelatorio) {
        case "fundo": return item.fundo_nome;
        case "evento": return item.titulo;
        case "nivel": return item.nivel === "violacao" ? 2 : 1;
        case "periodo": return new Date(item.data_primeira).getTime();
        case "plano": return item.plano_conteudo ? 1 : 0;
        case "status": return RISCO_WORKFLOW_LABEL[item.status_workflow];
      }
    };

    return filtered
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const left = valueFor(a.item);
        const right = valueFor(b.item);
        const comparison = typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right), "pt-BR", { sensitivity: "base" });
        return (comparison || a.index - b.index) * (directionRelatorio === "asc" ? 1 : -1);
      })
      .map(({ item }) => item);
  }, [buscaRelatorio, directionRelatorio, moduloRelatorio, nivelRelatorio, ocorrencias, planoRelatorio, quickFilterRelatorio, sortRelatorio, statusRelatorio]);

  const handleReportSort = (column: ReportSortColumn) => {
    if (sortRelatorio === column) {
      setDirectionRelatorio((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortRelatorio(column);
    setDirectionRelatorio("asc");
  };

  const limparFiltrosRelatorio = () => {
    setBuscaRelatorio("");
    setModuloRelatorio("todos");
    setNivelRelatorio("todos");
    setPlanoRelatorio("todos");
    setStatusRelatorio("todos");
    setQuickFilterRelatorio(null);
  };

  const applyQuickFilterRelatorio = (filter: Exclude<ReportQuickFilter, null>) => {
    const removeCurrent = quickFilterRelatorio === filter;
    setBuscaRelatorio("");
    setModuloRelatorio("todos");
    setNivelRelatorio("todos");
    setPlanoRelatorio("todos");
    setStatusRelatorio("todos");

    if (!removeCurrent) {
      if (filter === "fundos") {
        setSortRelatorio("fundo");
        setDirectionRelatorio("asc");
      }
      if (filter === "ocorrencias") {
        setSortRelatorio("periodo");
        setDirectionRelatorio("desc");
      }
      if (filter === "planos_pendentes") setPlanoRelatorio("pendente");
    }

    setQuickFilterRelatorio(removeCurrent ? null : filter);
  };

  const clearQuickFilterRelatorio = () => setQuickFilterRelatorio(null);

  const planosPendentes = ocorrencias.filter((item) => item.nivel === "violacao" && !item.plano_conteudo).length;
  const notificacoesPendentes = ocorrencias.filter((item) => item.nivel === "violacao" && item.notificacao_status !== "enviada").length;
  const casosAbertos = ocorrencias.filter(
    (item) => !["regularizada", "encerrada"].includes(item.status_workflow),
  ).length;
  const fundos = new Set(ocorrencias.map((item) => `${item.fundo_cnpj}|${item.fundo_isin ?? ""}`)).size;
  const semOcorrencias = ocorrencias.length === 0;
  const prontoParaRevisao = !semOcorrencias && planosPendentes === 0 && notificacoesPendentes === 0;
  const status = relatorio?.status ?? "rascunho";

  const exportWord = async () => {
    try {
      await exportRelatorioMensalRiscoWord(mes, ocorrencias, relatorio);
      toast.success("Documento Word gerado.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao gerar o documento Word");
    }
  };

  const resumoModulos = REPORT_MODULES.map((modulo) => {
    const itens = ocorrencias.filter((item) => item.modulo === modulo);
    return {
      modulo,
      total: itens.length,
      violacoes: itens.filter((item) => item.nivel === "violacao").length,
      planosPendentes: itens.filter((item) => item.nivel === "violacao" && !item.plano_conteudo).length,
      abertos: itens.filter((item) => !["regularizada", "encerrada"].includes(item.status_workflow)).length,
    };
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Dossiê da competência</h2>
            <Badge variant="outline">{REPORT_STATUS_LABEL[status]}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {format(parseISO(`${mes}-01`), "MMMM 'de' yyyy", { locale: ptBR })} · consolidação para Compliance
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportRelatorioMensalRiscoExcel(mes, ocorrencias, relatorio)}
            disabled={!ocorrencias.length}
          >
            <Download className="mr-2 h-4 w-4" />Excel
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void exportWord()}
            disabled={!ocorrencias.length}
          >
            <FileCheck2 className="mr-2 h-4 w-4" />Word
          </Button>
          <Button
            size="sm"
            onClick={() => exportRelatorioMensalRiscoPdf(mes, ocorrencias, relatorio)}
            disabled={!ocorrencias.length}
          >
            <FileText className="mr-2 h-4 w-4" />PDF Compliance
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Fundos afetados" value={fundos} icon={Users} tone="bg-slate-100 text-slate-700" active={quickFilterRelatorio === "fundos"} onClick={() => applyQuickFilterRelatorio("fundos")} />
        <Kpi label="Ocorrências no mês" value={ocorrencias.length} icon={CalendarDays} tone="bg-blue-100 text-blue-700" active={quickFilterRelatorio === "ocorrencias"} onClick={() => applyQuickFilterRelatorio("ocorrencias")} />
        <Kpi label="Casos em aberto" value={casosAbertos} icon={ShieldAlert} tone="bg-red-100 text-red-700" active={quickFilterRelatorio === "abertos"} onClick={() => applyQuickFilterRelatorio("abertos")} />
        <Kpi label="Planos pendentes" value={planosPendentes} icon={Bell} tone="bg-amber-100 text-amber-700" active={quickFilterRelatorio === "planos_pendentes"} onClick={() => applyQuickFilterRelatorio("planos_pendentes")} />
      </div>

      <Alert className={prontoParaRevisao ? "border-emerald-300 bg-emerald-50 text-emerald-900" : semOcorrencias ? "border-slate-300 bg-slate-50 text-slate-900" : "border-amber-300 bg-amber-50 text-amber-950"}>
        {prontoParaRevisao ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
        <AlertTitle>{semOcorrencias ? "Nenhuma ocorrência na competência" : prontoParaRevisao ? "Competência pronta para revisão" : "Existem pendências antes do fechamento"}</AlertTitle>
        <AlertDescription>
          {semOcorrencias
            ? "Não há violações ou alertas consolidados para compor o relatório mensal."
            : prontoParaRevisao
            ? "Todas as notificações foram enviadas e todos os planos de ação foram registrados."
            : `${planosPendentes} plano(s) de ação e ${notificacoesPendentes} notificação(ões) ainda estão pendentes.`}
        </AlertDescription>
      </Alert>

      <Card className="shadow-none">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldAlert className="h-4 w-4" /> Exceções registradas no período
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Entram violações e Soft Limits de liquidez; alertas dos demais módulos ficam somente no Monitoramento. Mercado não compõe este fechamento.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md border bg-muted/20 p-2">
            <div className="relative min-w-[220px] flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={buscaRelatorio} onChange={(event) => { clearQuickFilterRelatorio(); setBuscaRelatorio(event.target.value); }} placeholder="Buscar fundo, CNPJ ou evento" className="h-9 pl-9" aria-label="Buscar no relatório mensal" />
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground"><Filter className="h-3.5 w-3.5" />Filtros</div>
            <Select value={moduloRelatorio} onValueChange={(value) => { clearQuickFilterRelatorio(); setModuloRelatorio(value as RiscoModulo | "todos"); }}>
              <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Módulo" /></SelectTrigger>
              <SelectContent><SelectItem value="todos">Todos os módulos</SelectItem>{REPORT_MODULES.map((item) => <SelectItem key={item} value={item}>{RISCO_MODULO_LABEL[item]}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={nivelRelatorio} onValueChange={(value) => { clearQuickFilterRelatorio(); setNivelRelatorio(value as typeof nivelRelatorio); }}>
              <SelectTrigger className="h-9 w-[130px]"><SelectValue placeholder="Nível" /></SelectTrigger>
              <SelectContent><SelectItem value="todos">Todos os níveis</SelectItem><SelectItem value="violacao">Violação</SelectItem><SelectItem value="atencao">Soft Limit</SelectItem></SelectContent>
            </Select>
            <Select value={planoRelatorio} onValueChange={(value) => { clearQuickFilterRelatorio(); setPlanoRelatorio(value as typeof planoRelatorio); }}>
              <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Plano" /></SelectTrigger>
              <SelectContent><SelectItem value="todos">Todos os planos</SelectItem><SelectItem value="pendente">Plano pendente</SelectItem><SelectItem value="registrado">Plano registrado</SelectItem><SelectItem value="nao_aplicavel">Não aplicável</SelectItem></SelectContent>
            </Select>
            <Select value={statusRelatorio} onValueChange={(value) => { clearQuickFilterRelatorio(); setStatusRelatorio(value as ReportStatusFilter); }}>
              <SelectTrigger className="h-9 w-[165px]"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent><SelectItem value="todos">Todos os status</SelectItem>{Object.entries(RISCO_WORKFLOW_LABEL).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
            </Select>
            <Button type="button" variant="ghost" size="sm" className="h-9" onClick={limparFiltrosRelatorio}>Limpar</Button>
          </div>
          <p className="text-xs text-muted-foreground">Exibindo {filteredRelatorio.length} de {ocorrencias.length} exceção(ões).</p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <ReportSortableHead column="fundo" label="Fundo / identificação" activeColumn={sortRelatorio} direction={directionRelatorio} onSort={handleReportSort} />
                  <ReportSortableHead column="evento" label="Regra / evento" activeColumn={sortRelatorio} direction={directionRelatorio} onSort={handleReportSort} />
                  <ReportSortableHead column="nivel" label="Classificação" activeColumn={sortRelatorio} direction={directionRelatorio} onSort={handleReportSort} />
                  <ReportSortableHead column="periodo" label="Evidência no mês" activeColumn={sortRelatorio} direction={directionRelatorio} onSort={handleReportSort} />
                  <ReportSortableHead column="plano" label="Plano de ação" activeColumn={sortRelatorio} direction={directionRelatorio} onSort={handleReportSort} />
                  <ReportSortableHead column="status" label="Status do caso" activeColumn={sortRelatorio} direction={directionRelatorio} onSort={handleReportSort} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRelatorio.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="h-28 text-center text-sm text-muted-foreground">Nenhuma exceção encontrada para os filtros selecionados.</TableCell></TableRow>
                ) : filteredRelatorio.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="min-w-[220px]">
                      <p className="font-medium leading-tight">{item.fundo_nome}</p>
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">{formatCnpj(item.fundo_cnpj)}{item.fundo_isin ? ` · ISIN ${item.fundo_isin}` : ""}</p>
                    </TableCell>
                    <TableCell className="min-w-[240px]">
                      <p className="line-clamp-2 text-sm font-medium">{item.titulo}</p>
                      <Badge variant="outline" className={cn("mt-1", moduleTone[item.modulo])}>{RISCO_MODULO_LABEL[item.modulo]}</Badge>
                    </TableCell>
                    <TableCell><NivelBadge ocorrencia={item} /></TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {formatDate(item.data_primeira)} a {formatDate(item.data_ultima)}
                      <p className="text-muted-foreground">{item.dias_ocorrencia} dia(s)</p>
                    </TableCell>
                    <TableCell className="min-w-[180px]">
                      {item.plano_conteudo ? <><Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">Registrado</Badge><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.plano_conteudo}</p></> : item.nivel === "violacao" ? <span className="text-xs font-medium text-amber-700">Pendente</span> : <span className="text-xs text-muted-foreground">Não aplicável</span>}
                    </TableCell>
                    <TableCell><WorkflowBadge status={item.status_workflow} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ListChecks className="h-4 w-4" /> Resumo por módulo
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Módulo</TableHead>
                  <TableHead className="text-right">Ocorrências</TableHead>
                  <TableHead className="text-right">Violações</TableHead>
                  <TableHead className="text-right">Casos abertos</TableHead>
                  <TableHead className="text-right">Planos pendentes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resumoModulos.map((item) => (
                  <TableRow key={item.modulo}>
                    <TableCell><Badge variant="outline" className={moduleTone[item.modulo]}>{RISCO_MODULO_LABEL[item.modulo]}</Badge></TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{item.total}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{item.violacoes}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{item.abertos}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{item.planosPendentes}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <ReportControls mes={mes} relatorio={relatorio} />
    </div>
  );
}

function OccurrenceSheet({
  ocorrencia,
  onClose,
}: {
  ocorrencia: RiscoOcorrenciaMensal | null;
  onClose: () => void;
}) {
  const canWrite = useCanWrite();
  const planMutation = useSalvarPlanoRisco();
  const statusMutation = useAtualizarStatusOcorrencia();
  const validadeMutation = useClassificarValidadeOcorrencia();
  const { data: comunicacoes = [], isLoading: loadingTimeline } = useRiscoComunicacoes(ocorrencia?.id);
  const [conteudo, setConteudo] = useState("");
  const [responsavel, setResponsavel] = useState("");
  const [email, setEmail] = useState("");
  const [prazo, setPrazo] = useState("");
  const [origem, setOrigem] = useState<"manual" | "email">("email");
  const [validadeSelecionada, setValidadeSelecionada] = useState<RiscoValidadeOcorrencia>("confirmada");
  const [motivoValidade, setMotivoValidade] = useState<RiscoMotivoValidade | "">("");
  const [confirmarInvalidacao, setConfirmarInvalidacao] = useState(false);

  useEffect(() => {
    setConteudo(ocorrencia?.plano_conteudo ?? "");
    setResponsavel(ocorrencia?.plano_responsavel_nome ?? "");
    setEmail(ocorrencia?.plano_responsavel_email ?? "");
    setPrazo(ocorrencia?.plano_prazo ?? "");
    setOrigem(ocorrencia?.plano_origem === "manual" ? "manual" : "email");
    setValidadeSelecionada(ocorrencia?.validade_ocorrencia ?? "confirmada");
    setMotivoValidade(ocorrencia?.motivo_classificacao ?? "");
    setConfirmarInvalidacao(false);
  }, [ocorrencia]);

  if (!ocorrencia) return null;

  const validade = ocorrencia.validade_ocorrencia ?? "confirmada";
  const invalidada = validade === "invalidada_correcao_dado";
  const planoEditavel = canWrite && !invalidada;

  const savePlan = async () => {
    if (conteudo.trim().length < 10) {
      toast.error("Descreva o plano de ação com pelo menos 10 caracteres.");
      return;
    }
    try {
      await planMutation.mutateAsync({
        ocorrenciaId: ocorrencia.id,
        conteudo,
        responsavelNome: responsavel,
        responsavelEmail: email,
        prazo,
        origem,
      });
      toast.success("Plano de ação vinculado à ocorrência.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar o plano");
    }
  };

  const updateStatus = async (status: RiscoWorkflowStatus) => {
    try {
      await statusMutation.mutateAsync({ id: ocorrencia.id, status });
      toast.success("Status da ocorrência atualizado.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao atualizar o status");
    }
  };

  const executarClassificacao = async () => {
    try {
      await validadeMutation.mutateAsync({
        ocorrenciaId: ocorrencia.id,
        validade: validadeSelecionada,
        motivo: validadeSelecionada === "confirmada" ? null : motivoValidade || null,
      });
      setConfirmarInvalidacao(false);
      toast.success(
        validadeSelecionada === "invalidada_correcao_dado"
          ? "Ocorrência retirada do relatório e preservada no histórico."
          : "Validade da ocorrência atualizada.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao atualizar a validade");
    }
  };

  const saveValidade = () => {
    if (validadeSelecionada !== "confirmada" && !motivoValidade) {
      toast.error("Selecione o motivo da classificação.");
      return;
    }
    if (validadeSelecionada === "invalidada_correcao_dado") {
      setConfirmarInvalidacao(true);
      return;
    }
    void executarClassificacao();
  };

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="pr-8 text-left">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <NivelBadge ocorrencia={ocorrencia} />
            <Badge variant="outline" className={moduleTone[ocorrencia.modulo]}>{RISCO_MODULO_LABEL[ocorrencia.modulo]}</Badge>
            <ValidadeBadge validade={validade} />
          </div>
          <SheetTitle>{ocorrencia.titulo}</SheetTitle>
          <SheetDescription>
            {ocorrencia.fundo_nome} · {formatCnpj(ocorrencia.fundo_cnpj)}
            {ocorrencia.fundo_isin ? ` · ISIN ${ocorrencia.fundo_isin}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {validade !== "confirmada" && (
            <Alert className={invalidada ? "border-slate-300 bg-slate-50" : "border-amber-300 bg-amber-50 text-amber-950"}>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{RISCO_VALIDADE_LABEL[validade]}</AlertTitle>
              <AlertDescription>
                {ocorrencia.motivo_invalidacao ?? (invalidada
                  ? "A ocorrência foi preservada apenas para histórico e auditoria."
                  : "A ocorrência aguarda validação humana antes de compor o fechamento.")}
                {ocorrencia.invalidada_em ? ` Registrada em ${formatDate(ocorrencia.invalidada_em, true)}.` : ""}
              </AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/20 p-4 text-sm">
            <div><p className="text-xs text-muted-foreground">Primeira ocorrência</p><p className="font-medium">{formatDate(ocorrencia.data_primeira)}</p></div>
            <div><p className="text-xs text-muted-foreground">Última ocorrência</p><p className="font-medium">{formatDate(ocorrencia.data_ultima)}</p></div>
            <div><p className="text-xs text-muted-foreground">Dias afetados no mês</p><p className="font-mono font-semibold">{ocorrencia.dias_ocorrencia}</p></div>
            <div><p className="text-xs text-muted-foreground">Notificação</p><p className="font-medium">{ocorrencia.notificacao_status === "enviada" ? `Enviada em ${formatDate(ocorrencia.notificacao_enviada_em, true)}` : "Não localizada"}</p></div>
          </div>

          {ocorrencia.descricao && <p className="text-sm leading-relaxed text-muted-foreground">{ocorrencia.descricao}</p>}

          <div className="space-y-4 rounded-lg border p-4">
            <div>
              <h3 className="font-semibold">Validade da ocorrência</h3>
              <p className="text-xs text-muted-foreground">
                Diferencia uma violação efetiva de um alerta causado por erro de dados, sem apagar o histórico.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="validade-ocorrencia">Classificação</Label>
              <Select
                value={validadeSelecionada}
                onValueChange={(value) => {
                  const next = value as RiscoValidadeOcorrencia;
                  setValidadeSelecionada(next);
                  if (next === "confirmada") setMotivoValidade("");
                  if (next === "em_revisao" && !motivoValidade) setMotivoValidade("em_analise");
                }}
                disabled={!canWrite || validadeMutation.isPending}
              >
                <SelectTrigger id="validade-ocorrencia"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(RISCO_VALIDADE_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {validadeSelecionada !== "confirmada" && (
              <div className="space-y-1.5">
                <Label htmlFor="motivo-validade">Motivo</Label>
                <Select
                  value={motivoValidade}
                  onValueChange={(value) => setMotivoValidade(value as RiscoMotivoValidade)}
                  disabled={!canWrite || validadeMutation.isPending}
                >
                  <SelectTrigger id="motivo-validade"><SelectValue placeholder="Selecione o motivo" /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(RISCO_MOTIVO_VALIDADE_LABEL).map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {validadeSelecionada === "invalidada_correcao_dado" && (
              <Alert className="border-slate-300 bg-slate-50">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Impacto no fechamento</AlertTitle>
                <AlertDescription>
                  Esta ocorrência sairá dos KPIs, planos pendentes e relatório mensal, mas continuará no histórico e na auditoria.
                </AlertDescription>
              </Alert>
            )}

            <Button
              variant={validadeSelecionada === "invalidada_correcao_dado" ? "destructive" : "outline"}
              onClick={saveValidade}
              disabled={!canWrite || validadeMutation.isPending}
            >
              {validadeMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salvar classificação
            </Button>
          </div>

          <div className="space-y-2">
            <Label>Status do caso</Label>
            <Select value={ocorrencia.status_workflow} onValueChange={(value) => updateStatus(value as RiscoWorkflowStatus)} disabled={!canWrite || invalidada || statusMutation.isPending}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(RISCO_WORKFLOW_LABEL).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
              </SelectContent>
            </Select>
            {invalidada && <p className="text-xs text-muted-foreground">O workflow fica bloqueado porque a ocorrência foi classificada como indevida.</p>}
          </div>

          <div className="space-y-3 border-t pt-5">
            <div>
              <h3 className="font-semibold">Plano de ação do gestor</h3>
              <p className="text-xs text-muted-foreground">Cole a resposta recebida por e-mail. Cada alteração cria uma nova versão auditável.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plano-acao">Plano de ação</Label>
              <Textarea id="plano-acao" rows={7} value={conteudo} onChange={(event) => setConteudo(event.target.value)} disabled={!canWrite} placeholder="Cole aqui a resposta do gestor, incluindo tratativa, prazo e critério de regularização." />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="plano-responsavel">Responsável</Label><Input id="plano-responsavel" value={responsavel} onChange={(event) => setResponsavel(event.target.value)} disabled={!canWrite} /></div>
              <div className="space-y-1.5"><Label htmlFor="plano-email">E-mail</Label><Input id="plano-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={!canWrite} /></div>
              <div className="space-y-1.5"><Label htmlFor="plano-prazo">Prazo</Label><Input id="plano-prazo" type="date" value={prazo} onChange={(event) => setPrazo(event.target.value)} disabled={!canWrite} /></div>
              <div className="space-y-1.5"><Label>Origem</Label><Select value={origem} onValueChange={(value) => setOrigem(value as "manual" | "email")} disabled={!canWrite}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="email">Resposta por e-mail</SelectItem><SelectItem value="manual">Registro manual</SelectItem></SelectContent></Select></div>
            </div>
            <Button onClick={savePlan} disabled={!planoEditavel || planMutation.isPending}>
              {planMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileCheck2 className="mr-2 h-4 w-4" />}
              {ocorrencia.plano_id ? "Salvar nova versão" : "Vincular plano de ação"}
            </Button>
          </div>

          <div className="space-y-3 border-t pt-5">
            <h3 className="font-semibold">Linha do tempo</h3>
            {loadingTimeline ? <Skeleton className="h-20 w-full" /> : comunicacoes.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Nenhuma comunicação complementar registrada.</p>
            ) : (
              <div className="space-y-3">
                {comunicacoes.map((item) => (
                  <div key={item.id} className="relative border-l-2 border-muted pl-4 text-sm">
                    <CircleDot className="absolute -left-[9px] top-0 h-4 w-4 bg-background text-primary" />
                    <div className="flex items-center justify-between gap-3"><p className="font-medium">{item.assunto ?? item.tipo}</p><span className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(item.created_at, true)}</span></div>
                    {item.conteudo && <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{item.conteudo}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </SheetContent>

      <AlertDialog open={confirmarInvalidacao} onOpenChange={setConfirmarInvalidacao}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Classificar como ocorrência indevida?</AlertDialogTitle>
            <AlertDialogDescription>
              Ela será retirada dos indicadores, pendências e relatório oficial. Nenhum registro, notificação, plano ou evidência será apagado.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={validadeMutation.isPending}>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                void executarClassificacao();
              }}
              disabled={validadeMutation.isPending}
            >
              {validadeMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirmar e retirar do relatório
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

export function RiscoOcorrenciasPanel({ modulos, showReportControls = false }: RiscoOcorrenciasPanelProps) {
  const [mes, setMes] = useState(format(new Date(), "yyyy-MM"));
  const [activeView, setActiveView] = useState<"monitoramento" | "relatorio">("monitoramento");
  const [busca, setBusca] = useState("");
  const [modulo, setModulo] = useState<RiscoModulo | "todos">("todos");
  const [nivel, setNivel] = useState<"todos" | "atencao" | "violacao">("todos");
  const [plano, setPlano] = useState<PlanoFilter>("todos");
  const [validade, setValidade] = useState<ValidadeFilter>("validas");
  const [status, setStatus] = useState<StatusFilter>("todos");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>(null);
  const [sortColumn, setSortColumn] = useState<SortColumn>("periodo");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fixedModules = modulos?.length ? modulos : undefined;
  const query = useRiscoOcorrenciasMes(mes, fixedModules);
  const syncMutation = useSincronizarOcorrenciasRisco();
  const ocorrencias = useMemo(() => query.data?.ocorrencias ?? [], [query.data?.ocorrencias]);
  const ocorrenciasValidas = useMemo(
    () => ocorrencias.filter((item) => item.validade_ocorrencia !== "invalidada_correcao_dado"),
    [ocorrencias],
  );
  const ocorrenciasRelatorio = useMemo(
    () => ocorrenciasValidas.filter(isReportableMensal),
    [ocorrenciasValidas],
  );
  const selected = ocorrencias.find((item) => item.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const term = busca.trim().toLocaleLowerCase("pt-BR");
    const items = ocorrencias.filter((item) => {
      const validadeItem = item.validade_ocorrencia ?? "confirmada";
      if (validade === "validas" && validadeItem === "invalidada_correcao_dado") return false;
      if (validade !== "validas" && validade !== "todas" && validadeItem !== validade) return false;
      if (modulo !== "todos" && item.modulo !== modulo) return false;
      if (nivel !== "todos" && item.nivel !== nivel) return false;
      if (plano === "recebido" && !item.plano_conteudo) return false;
      if (plano === "pendente" && (item.plano_conteudo || validadeItem === "invalidada_correcao_dado")) return false;
      if (
        status === "regularizadas_encerradas"
        && !["regularizada", "encerrada"].includes(item.status_workflow)
      ) return false;
      if (
        status !== "todos"
        && status !== "regularizadas_encerradas"
        && item.status_workflow !== status
      ) return false;
      if (!term) return true;
      return [item.fundo_nome, item.fundo_cnpj, item.fundo_isin, item.titulo, item.descricao ?? ""]
        .some((value) => value.toLocaleLowerCase("pt-BR").includes(term));
    });

    const valueFor = (item: RiscoOcorrenciaMensal): string | number => {
      switch (sortColumn) {
        case "nivel": return item.nivel === "violacao" ? 2 : 1;
        case "validade": return RISCO_VALIDADE_LABEL[item.validade_ocorrencia ?? "confirmada"];
        case "modulo": return RISCO_MODULO_LABEL[item.modulo];
        case "fundo": return item.fundo_nome;
        case "evento": return item.titulo;
        case "periodo": return new Date(item.data_primeira).getTime();
        case "notificacao": return item.notificacao_status;
        case "plano": return item.plano_conteudo ? 1 : 0;
        case "status": return RISCO_WORKFLOW_LABEL[item.status_workflow];
      }
    };

    return items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const left = valueFor(a.item);
        const right = valueFor(b.item);
        const comparison = typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right), "pt-BR", { sensitivity: "base" });
        if (comparison === 0) return a.index - b.index;
        return comparison * (sortDirection === "asc" ? 1 : -1);
      })
      .map(({ item }) => item);
  }, [busca, modulo, nivel, ocorrencias, plano, sortColumn, sortDirection, status, validade]);

  const stats = useMemo(() => ({
    fundos: countFundosAfetados(ocorrenciasValidas),
    total: ocorrenciasValidas.length,
    violacoes: ocorrenciasValidas.filter((item) => item.nivel === "violacao").length,
    planosPendentes: ocorrenciasValidas.filter((item) => !item.plano_conteudo).length,
    regularizadas: ocorrenciasValidas.filter((item) => ["regularizada", "encerrada"].includes(item.status_workflow)).length,
  }), [ocorrenciasValidas]);

  const moduleOptions = fixedModules ?? ALL_MODULES;

  const applyQuickFilter = (filter: Exclude<QuickFilter, null>) => {
    const removeCurrent = quickFilter === filter;
    setSelectedId(null);
    setBusca("");
    setModulo("todos");
    setNivel("todos");
    setPlano("todos");
    setValidade("validas");
    setStatus("todos");

    if (!removeCurrent) {
      if (filter === "violacoes") setNivel("violacao");
      if (filter === "planos_pendentes") setPlano("pendente");
      if (filter === "regularizadas") setStatus("regularizadas_encerradas");
    }
    setQuickFilter(removeCurrent ? null : filter);
  };

  const clearQuickFilter = () => setQuickFilter(null);

  const handleSort = (column: SortColumn) => {
    if (column === sortColumn) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortColumn(column);
    setSortDirection("asc");
  };

  const sincronizar = async () => {
    try {
      await syncMutation.mutateAsync(mes);
      toast.success(activeView === "relatorio" ? "Fechamento mensal registrado." : "Competência sincronizada.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao sincronizar a competência");
    }
  };

  if (query.isLoading) {
    return <div className="space-y-4"><Skeleton className="h-10 w-full" /><div className="grid gap-3 md:grid-cols-5">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-24" />)}</div><Skeleton className="h-80 w-full" /></div>;
  }

  if (query.error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Não foi possível carregar o monitoramento</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <span>{query.error instanceof Error ? query.error.message : "Erro inesperado"}</span>
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>Tentar novamente</Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {(showReportControls && activeView === "relatorio") && <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 xl:flex-row xl:items-end xl:justify-between">
        <div className="flex flex-wrap items-end gap-2">
          <CompetenciaNavigator value={mes} onChange={setMes} />
          {(!showReportControls || activeView === "monitoramento") && <>
          {!fixedModules && <div className="space-y-1"><Label className="text-xs">Módulo</Label><Select value={modulo} onValueChange={(value) => { clearQuickFilter(); setModulo(value as RiscoModulo | "todos"); }}><SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="todos">Todos os módulos</SelectItem>{moduleOptions.map((item) => <SelectItem key={item} value={item}>{RISCO_MODULO_LABEL[item]}</SelectItem>)}</SelectContent></Select></div>}
          <div className="space-y-1"><Label className="text-xs">Nível</Label><Select value={nivel} onValueChange={(value) => { clearQuickFilter(); setNivel(value as typeof nivel); }}><SelectTrigger className="w-[145px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="todos">Todos</SelectItem><SelectItem value="violacao">Violação</SelectItem><SelectItem value="atencao">Atenção</SelectItem></SelectContent></Select></div>
          <div className="space-y-1"><Label className="text-xs">Plano de ação</Label><Select value={plano} onValueChange={(value) => { clearQuickFilter(); setPlano(value as PlanoFilter); }}><SelectTrigger className="w-[155px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="todos">Todos</SelectItem><SelectItem value="recebido">Recebido</SelectItem><SelectItem value="pendente">Pendente</SelectItem></SelectContent></Select></div>
          <div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input aria-label="Buscar fundo ou ocorrência" value={busca} onChange={(event) => { clearQuickFilter(); setBusca(event.target.value); }} placeholder="Buscar fundo ou evento" className="w-[230px] pl-9" /></div>
          <div className="space-y-1">
            <Label className="text-xs">Validade</Label>
            <Select value={validade} onValueChange={(value) => { clearQuickFilter(); setValidade(value as ValidadeFilter); }}>
              <SelectTrigger className="w-[190px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="validas">Válidas</SelectItem>
                <SelectItem value="confirmada">Confirmadas</SelectItem>
                <SelectItem value="em_revisao">Em revisão</SelectItem>
                <SelectItem value="invalidada_correcao_dado">Invalidadas</SelectItem>
                <SelectItem value="todas">Todas, com histórico</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Status</Label>
            <Select value={status} onValueChange={(value) => { clearQuickFilter(); setStatus(value as StatusFilter); }}>
              <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos</SelectItem>
                <SelectItem value="regularizadas_encerradas">Regularizadas ou encerradas</SelectItem>
                {Object.entries(RISCO_WORKFLOW_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          </>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={sincronizar} disabled={syncMutation.isPending || query.isFetching}>{syncMutation.isPending || query.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}{syncMutation.isPending ? (activeView === "relatorio" ? "Registrando..." : "Sincronizando...") : (activeView === "relatorio" ? "Registrar fechamento" : "Atualizar")}</Button>
          {!showReportControls && <>
            <Button variant="outline" size="sm" onClick={() => exportRelatorioMensalRiscoExcel(mes, ocorrenciasValidas, query.data?.relatorio)} disabled={!ocorrenciasValidas.length}><Download className="mr-2 h-4 w-4" />Excel</Button>
            <Button size="sm" onClick={() => exportRelatorioMensalRiscoPdf(mes, ocorrenciasValidas, query.data?.relatorio)} disabled={!ocorrenciasValidas.length}><FileText className="mr-2 h-4 w-4" />PDF Compliance</Button>
          </>}
        </div>
      </div>}

      <Tabs
        value={showReportControls ? activeView : "monitoramento"}
        onValueChange={(value) => setActiveView(value as typeof activeView)}
      >
        {showReportControls && (
          <TabsList className="grid h-auto w-full max-w-xl grid-cols-2">
            <TabsTrigger value="monitoramento" className="min-h-11 gap-2">
              <ShieldAlert className="h-4 w-4" />
              Monitoramento
              <Badge variant="secondary" className="font-mono tabular-nums">{stats.total}</Badge>
            </TabsTrigger>
            <TabsTrigger value="relatorio" className="min-h-11 gap-2">
              <FileCheck2 className="h-4 w-4" />
              Relatório mensal
              <Badge variant="secondary">{REPORT_STATUS_LABEL[query.data?.relatorio?.status ?? "rascunho"]}</Badge>
            </TabsTrigger>
          </TabsList>
        )}

        <TabsContent value="monitoramento" className={showReportControls ? "mt-4 space-y-4" : "mt-0 space-y-4"}>
          <RiscoEpisodiosMonitoramento modulos={fixedModules} />
          {false && <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi label="Fundos afetados" value={stats.fundos} icon={Users} tone="bg-slate-100 text-slate-700" />
        <Kpi label="Ocorrências" value={stats.total} icon={CalendarDays} tone="bg-blue-100 text-blue-700" />
        <Kpi
          label="Violações"
          value={stats.violacoes}
          icon={ShieldAlert}
          tone="bg-red-100 text-red-700"
          active={quickFilter === "violacoes"}
          onClick={() => applyQuickFilter("violacoes")}
        />
        <Kpi
          label="Planos pendentes"
          value={stats.planosPendentes}
          icon={Bell}
          tone="bg-amber-100 text-amber-700"
          active={quickFilter === "planos_pendentes"}
          onClick={() => applyQuickFilter("planos_pendentes")}
        />
        <Kpi
          label="Regularizadas"
          value={stats.regularizadas}
          icon={CheckCircle2}
          tone="bg-emerald-100 text-emerald-700"
          active={quickFilter === "regularizadas"}
          onClick={() => applyQuickFilter("regularizadas")}
        />
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-2 text-xs text-muted-foreground">
          <span>{filtered.length} de {ocorrencias.length} ocorrência(s)</span>
          <span>Dados consultados em: {format(new Date(query.dataUpdatedAt), "dd/MM/yyyy HH:mm")}</span>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <SortableTableHead column="nivel" label="Nível" activeColumn={sortColumn} direction={sortDirection} onSort={handleSort} className="w-[105px]" />
                <SortableTableHead column="validade" label="Validade" activeColumn={sortColumn} direction={sortDirection} onSort={handleSort} className="w-[175px]" />
                <SortableTableHead column="modulo" label="Módulo" activeColumn={sortColumn} direction={sortDirection} onSort={handleSort} className="w-[130px]" />
                <SortableTableHead column="fundo" label="Fundo" activeColumn={sortColumn} direction={sortDirection} onSort={handleSort} className="min-w-[250px]" />
                <SortableTableHead column="evento" label="Evento" activeColumn={sortColumn} direction={sortDirection} onSort={handleSort} className="min-w-[260px]" />
                <SortableTableHead column="periodo" label="Período" activeColumn={sortColumn} direction={sortDirection} onSort={handleSort} className="w-[145px]" />
                <SortableTableHead column="notificacao" label="Notificação" activeColumn={sortColumn} direction={sortDirection} onSort={handleSort} className="w-[120px]" />
                <SortableTableHead column="plano" label="Plano de ação" activeColumn={sortColumn} direction={sortDirection} onSort={handleSort} className="min-w-[190px]" />
                <SortableTableHead column="status" label="Status" activeColumn={sortColumn} direction={sortDirection} onSort={handleSort} className="w-[155px]" />
                <TableHead className="w-12"><span className="sr-only">Abrir detalhes</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={10} className="h-40 text-center"><div className="mx-auto max-w-md"><CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-emerald-600" /><p className="font-medium">Nenhuma ocorrência encontrada</p><p className="mt-1 text-sm text-muted-foreground">Não houve atenção ou violação para os filtros e a competência selecionados.</p></div></TableCell></TableRow>
              ) : filtered.map((item) => (
                <TableRow key={item.id} tabIndex={0} className={cn("cursor-pointer hover:bg-muted/40 focus:bg-muted/40 focus:outline-none", item.validade_ocorrencia === "invalidada_correcao_dado" && "bg-slate-50/70 text-muted-foreground")} onClick={() => setSelectedId(item.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(item.id); } }}>
                  <TableCell><NivelBadge ocorrencia={item} /></TableCell>
                  <TableCell><ValidadeBadge validade={item.validade_ocorrencia ?? "confirmada"} /></TableCell>
                  <TableCell><Badge variant="outline" className={moduleTone[item.modulo]}>{RISCO_MODULO_LABEL[item.modulo]}</Badge></TableCell>
                  <TableCell><p className="font-medium leading-tight">{item.fundo_nome}</p><p className="mt-1 font-mono text-[11px] text-muted-foreground">{formatCnpj(item.fundo_cnpj)}</p>{item.fundo_isin && <p className="font-mono text-[11px] text-muted-foreground">ISIN {item.fundo_isin}</p>}</TableCell>
                  <TableCell><p className="line-clamp-2 text-sm font-medium">{item.titulo}</p><p className="mt-1 font-mono text-[11px] text-muted-foreground">{item.source_key.split("|")[0]}</p></TableCell>
                  <TableCell className="font-mono text-xs"><p>{formatDate(item.data_primeira)}</p><p className="text-muted-foreground">até {formatDate(item.data_ultima)} · {item.dias_ocorrencia}d</p></TableCell>
                  <TableCell>{item.notificacao_status === "enviada" ? <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><MailCheck className="h-4 w-4" />Enviada</span> : <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700"><AlertCircle className="h-4 w-4" />Pendente</span>}</TableCell>
                  <TableCell>{item.plano_conteudo ? <div><span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><FileCheck2 className="h-4 w-4" />Recebido · v{item.plano_versao}</span><p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{item.plano_conteudo}</p></div> : item.validade_ocorrencia === "invalidada_correcao_dado" ? <span className="text-xs text-muted-foreground">Não aplicável</span> : <span className="text-xs font-medium text-amber-700">Aguardando gestor</span>}</TableCell>
                  <TableCell><WorkflowBadge status={item.status_workflow} /></TableCell>
                  <TableCell><ChevronRight className="h-4 w-4 text-muted-foreground" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <OccurrenceSheet ocorrencia={selected} onClose={() => setSelectedId(null)} />
          </>}
        </TabsContent>

        {showReportControls && (
          <TabsContent value="relatorio" className="mt-4">
            <RelatorioMensalView
              mes={mes}
              ocorrencias={ocorrenciasRelatorio}
              relatorio={query.data?.relatorio ?? null}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
