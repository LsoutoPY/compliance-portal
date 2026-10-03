import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  AlertCircle,
  ArrowDownAZ,
  ArrowDownUp,
  ArrowUpAZ,
  Bell,
  CheckCircle2,
  ChevronRight,
  FileCheck2,
  Filter,
  Loader2,
  MailCheck,
  RefreshCw,
  Search,
  ShieldAlert,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useCanWrite } from "@/contexts/PermissionsContext";
import {
  useClassificarValidadeEpisodioRisco,
  useRegistrarNotificacaoManualEpisodioRisco,
  useRiscoEpisodios,
  useSalvarPlanoEpisodioRisco,
  useSincronizarEpisodiosRisco,
} from "@/hooks/useRiscoEpisodios";
import { cn } from "@/lib/utils";
import type { RiscoModulo } from "@/types/relatorios-risco";
import {
  RISCO_MODULO_LABEL,
  RISCO_WORKFLOW_LABEL,
} from "@/types/relatorios-risco";
import type { RiscoEpisodio } from "@/types/risco-episodios";

const ALL_MODULES: RiscoModulo[] = [
  "enquadramento",
  "liquidez",
  "mercado",
  "concentracao",
];
const moduleTone: Record<RiscoModulo, string> = {
  enquadramento: "border-blue-200 bg-blue-50 text-blue-800",
  liquidez: "border-cyan-200 bg-cyan-50 text-cyan-800",
  mercado: "border-violet-200 bg-violet-50 text-violet-800",
  concentracao: "border-orange-200 bg-orange-50 text-orange-800",
};

function date(value: string | null) {
  return value ? format(parseISO(value), "dd/MM/yyyy", { locale: ptBR }) : "—";
}
function cnpj(value: string) {
  return value.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    "$1.$2.$3/$4-$5",
  );
}

function isActiveEpisode(item: RiscoEpisodio) {
  return (
    !item.data_regularizacao &&
    item.status_workflow !== "encerrada" &&
    item.validade_ocorrencia !== "invalidada_correcao_dado"
  );
}

function Nivel({ item }: { item: RiscoEpisodio }) {
  const violacao = item.nivel_atual === "violacao" || item.violacao_detectada;
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1",
        violacao
          ? "border-red-300 bg-red-50 text-red-800"
          : "border-amber-300 bg-amber-50 text-amber-800",
      )}
    >
      {violacao ? (
        <ShieldAlert className="h-3 w-3" />
      ) : (
        <AlertCircle className="h-3 w-3" />
      )}
      {violacao ? "Violação" : "Atenção"}
    </Badge>
  );
}

function Status({ item }: { item: RiscoEpisodio }) {
  const text = item.data_regularizacao
    ? "Regularizado pela fonte"
    : RISCO_WORKFLOW_LABEL[item.status_workflow];
  const tone = item.data_regularizacao
    ? "border-emerald-300 bg-emerald-50 text-emerald-800"
    : item.status_workflow === "aguardando_plano"
      ? "border-amber-300 bg-amber-50 text-amber-800"
      : "border-blue-300 bg-blue-50 text-blue-800";
  return (
    <Badge variant="outline" className={tone}>
      {text}
    </Badge>
  );
}

function Kpi({
  label,
  value,
  icon: Icon,
  tone,
  onClick,
  active,
}: {
  label: string;
  value: number;
  icon: ComponentType<{ className?: string }>;
  tone: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const body = (
    <div className="flex items-center justify-between p-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 font-mono text-2xl font-bold tabular-nums">
          {value}
        </p>
      </div>
      <div className={cn("rounded-lg p-2", tone)}>
        <Icon className="h-5 w-5" />
      </div>
    </div>
  );
  return (
    <Card
      className={cn(
        "shadow-none",
        active && "border-primary ring-2 ring-primary/20",
      )}
    >
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-pressed={active}
          className="w-full text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
        >
          {body}
        </button>
      ) : (
        <CardContent className="p-0">{body}</CardContent>
      )}
    </Card>
  );
}

type SortKey =
  | "nivel"
  | "modulo"
  | "fundo"
  | "evento"
  | "periodo"
  | "notificacao"
  | "plano"
  | "status";
type SortDirection = "asc" | "desc";

function TableHeaderControl({
  label,
  column,
  sortKey,
  sortDirection,
  onSort,
  activeFilter,
  children,
}: {
  label: string;
  column: SortKey;
  sortKey: SortKey;
  sortDirection: SortDirection;
  onSort: (column: SortKey) => void;
  activeFilter: boolean;
  children: ReactNode;
}) {
  const activeSort = sortKey === column;
  const SortIcon = !activeSort
    ? ArrowDownUp
    : sortDirection === "asc"
      ? ArrowUpAZ
      : ArrowDownAZ;
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 rounded px-1 py-1 text-left font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-sort={
          activeSort
            ? sortDirection === "asc"
              ? "ascending"
              : "descending"
            : "none"
        }
      >
        {label}
        <SortIcon className={cn("h-3.5 w-3.5", activeSort && "text-primary")} />
      </button>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Filtrar ${label}`}
            className={cn(
              "rounded p-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              activeFilter && "bg-primary/10 text-primary",
            )}
          >
            <Filter className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-3">
          {children}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function HeaderFilter({
  children,
  clear,
  active,
}: {
  children: ReactNode;
  clear: () => void;
  active: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold">Filtrar coluna</p>
        {active && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={clear}
          >
            <X className="mr-1 h-3 w-3" />
            Limpar
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}

function EpisodioSheet({
  item,
  onClose,
}: {
  item: RiscoEpisodio | null;
  onClose: () => void;
}) {
  const canWrite = useCanWrite();
  const saveMutation = useSalvarPlanoEpisodioRisco();
  const validadeMutation = useClassificarValidadeEpisodioRisco();
  const notificacaoMutation = useRegistrarNotificacaoManualEpisodioRisco();
  const [conteudo, setConteudo] = useState("");
  const [responsavel, setResponsavel] = useState("");
  const [email, setEmail] = useState("");
  const [prazo, setPrazo] = useState("");
  const [lastId, setLastId] = useState<string | null>(null);
  const [motivoValidade, setMotivoValidade] = useState("xml_incorreto");
  const [notificacaoEm, setNotificacaoEm] = useState("");
  const [destinatarios, setDestinatarios] = useState("");
  const [observacaoNotificacao, setObservacaoNotificacao] = useState("");
  useEffect(() => {
    if (!item || item.id === lastId) return;
    setLastId(item.id);
    setConteudo(item.plano_conteudo ?? "");
    setResponsavel(item.plano_responsavel_nome ?? "");
    setEmail(item.plano_responsavel_email ?? "");
    setPrazo(item.plano_prazo ?? "");
  }, [item, lastId]);
  const save = async () => {
    if (!item || conteudo.trim().length < 10) {
      toast.error("Descreva o plano de ação com pelo menos 10 caracteres.");
      return;
    }
    try {
      await saveMutation.mutateAsync({
        episodioId: item.id,
        conteudo,
        responsavelNome: responsavel,
        responsavelEmail: email,
        prazo,
        origem: "email",
      });
      toast.success("Plano vinculado ao episódio.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Não foi possível salvar o plano.",
      );
    }
  };
  const registrarNotificacao = async () => {
    if (!item) return;
    try {
      await notificacaoMutation.mutateAsync({
        episodioId: item.id,
        ocorridaEm: notificacaoEm
          ? new Date(notificacaoEm).toISOString()
          : new Date().toISOString(),
        destinatarios: destinatarios
          .split(/[;,]/)
          .map((v) => v.trim())
          .filter(Boolean),
        observacao: observacaoNotificacao,
      });
      toast.success("Notificação manual registrada.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Falha ao registrar notificação.",
      );
    }
  };
  const invalidarPorDados = async () => {
    if (!item) return;
    try {
      await validadeMutation.mutateAsync({
        episodioId: item.id,
        validade: "invalidada_correcao_dado",
        motivo: motivoValidade,
      });
      toast.success("Episódio invalidado por correção de dados.");
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao atualizar validade.",
      );
    }
  };
  return (
    <Sheet open={!!item} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Episódio de desenquadramento</SheetTitle>
          <SheetDescription>
            O episódio só é regularizado após uma leitura diária válida com
            status enquadrado.
          </SheetDescription>
        </SheetHeader>
        {item && (
          <div className="mt-6 space-y-5">
            <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/20 p-4 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Início</p>
                <p className="font-mono font-medium">
                  {date(item.data_inicio)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  Última evidência
                </p>
                <p className="font-mono font-medium">
                  {date(item.data_ultima_evidencia)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  Idade do episódio
                </p>
                <p className="font-mono font-medium">
                  {item.dias_episodio} dias
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Regularização</p>
                <p className="font-mono font-medium">
                  {date(item.data_regularizacao)}
                </p>
              </div>
            </div>
            <div>
              <p className="font-medium">{item.fundo_nome}</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {cnpj(item.fundo_cnpj)}{" "}
                {item.fundo_isin && `· ISIN ${item.fundo_isin}`}
              </p>
              <p className="mt-3 text-sm font-medium">{item.titulo}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Nivel item={item} />
                <Status item={item} />
                {item.notificacao_pendente && (
                  <Badge
                    variant="outline"
                    className="border-amber-300 bg-amber-50 text-amber-800"
                  >
                    <Bell className="mr-1 h-3 w-3" />
                    Cobrança pendente
                  </Badge>
                )}
              </div>
            </div>
            {!item.data_regularizacao && (
              <div className="space-y-3 border-t pt-5">
                <div>
                  <h3 className="font-semibold">Notificação</h3>
                  <p className="text-xs text-muted-foreground">
                    Registre comunicações feitas antes ou fora da automação.
                  </p>
                </div>
                {item.notificacao_manual_em && (
                  <p className="text-sm text-emerald-700">
                    Notificação manual registrada em{" "}
                    {date(item.notificacao_manual_em)}
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    type="datetime-local"
                    value={notificacaoEm}
                    disabled={!canWrite}
                    onChange={(event) => setNotificacaoEm(event.target.value)}
                  />
                  <Input
                    value={destinatarios}
                    disabled={!canWrite}
                    onChange={(event) => setDestinatarios(event.target.value)}
                    placeholder="Destinatários (separe por ;)"
                  />
                </div>
                <Textarea
                  value={observacaoNotificacao}
                  disabled={!canWrite}
                  onChange={(event) =>
                    setObservacaoNotificacao(event.target.value)
                  }
                  placeholder="Observação da notificação manual"
                  rows={2}
                />
                <Button
                  variant="outline"
                  onClick={registrarNotificacao}
                  disabled={!canWrite || notificacaoMutation.isPending}
                >
                  {notificacaoMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <MailCheck className="mr-2 h-4 w-4" />
                  )}
                  Registrar notificação manual
                </Button>
              </div>
            )}
            <div className="space-y-3 border-t pt-5">
              <div>
                <h3 className="font-semibold">Validade do dado</h3>
                <p className="text-xs text-muted-foreground">
                  Use somente quando o episódio decorrer de falha de XML,
                  arquivo ou regra.
                </p>
              </div>
              <div className="flex gap-2">
                <Select
                  value={motivoValidade}
                  onValueChange={setMotivoValidade}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="xml_incorreto">XML incorreto</SelectItem>
                    <SelectItem value="arquivo_reprocessado">
                      Arquivo reprocessado
                    </SelectItem>
                    <SelectItem value="regra_incorreta">
                      Regra incorreta
                    </SelectItem>
                    <SelectItem value="duplicidade">Duplicidade</SelectItem>
                    <SelectItem value="em_analise">Em análise</SelectItem>
                    <SelectItem value="outro">Outro motivo</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  onClick={invalidarPorDados}
                  disabled={!canWrite || validadeMutation.isPending}
                >
                  Invalidar caso
                </Button>
              </div>
            </div>
            {item.violacao_detectada && !item.data_regularizacao && (
              <div className="space-y-3 border-t pt-5">
                <div>
                  <h3 className="font-semibold">Plano de ação</h3>
                  <p className="text-xs text-muted-foreground">
                    O prazo orienta a cobrança, mas não encerra o episódio.
                  </p>
                </div>
                <Textarea
                  value={conteudo}
                  rows={6}
                  disabled={!canWrite}
                  onChange={(event) => setConteudo(event.target.value)}
                  placeholder="Tratativa, responsável, prazo e critério de regularização."
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    value={responsavel}
                    disabled={!canWrite}
                    onChange={(event) => setResponsavel(event.target.value)}
                    placeholder="Responsável"
                  />
                  <Input
                    type="email"
                    value={email}
                    disabled={!canWrite}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="E-mail do responsável"
                  />
                  <Input
                    type="date"
                    value={prazo}
                    disabled={!canWrite}
                    onChange={(event) => setPrazo(event.target.value)}
                  />
                </div>
                <Button
                  onClick={save}
                  disabled={!canWrite || saveMutation.isPending}
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <FileCheck2 className="mr-2 h-4 w-4" />
                  )}
                  {item.plano_id ? "Salvar nova versão" : "Vincular plano"}
                </Button>
              </div>
            )}
            {!item.violacao_detectada && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Acompanhamento de atenção</AlertTitle>
                <AlertDescription>
                  Este episódio não exige plano de ação enquanto não houver
                  violação.
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function RiscoEpisodiosMonitoramento({
  modulos,
}: {
  modulos?: RiscoModulo[];
}) {
  const [busca, setBusca] = useState("");
  const [modulo, setModulo] = useState<RiscoModulo | "todos">("todos");
  const [escopo, setEscopo] = useState<"ativos" | "historico">("ativos");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quick, setQuick] = useState<
    "violacoes" | "pendentes" | "regularizados" | null
  >(null);
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "periodo",
    direction: "desc",
  });
  const [nivelFiltro, setNivelFiltro] = useState<
    "todos" | "atencao" | "violacao"
  >("todos");
  const [moduloFiltro, setModuloFiltro] = useState<RiscoModulo | "todos">(
    "todos",
  );
  const [fundoFiltro, setFundoFiltro] = useState("");
  const [eventoFiltro, setEventoFiltro] = useState("");
  const [periodoFiltro, setPeriodoFiltro] = useState<
    "todos" | "7" | "30" | "90"
  >("todos");
  const [notificacaoFiltro, setNotificacaoFiltro] = useState<
    "todos" | "pendente" | "regular"
  >("todos");
  const [planoFiltro, setPlanoFiltro] = useState<
    "todos" | "com_plano" | "sem_plano"
  >("todos");
  const [statusFiltro, setStatusFiltro] = useState<
    "todos" | "aberta" | "aguardando_plano" | "em_tratamento" | "regularizada"
  >("todos");
  const query = useRiscoEpisodios(modulos);
  const sync = useSincronizarEpisodiosRisco();
  const items = query.data ?? [];
  const filtered = useMemo(() => {
    const term = busca.trim().toLocaleLowerCase("pt-BR");
    const columnFund = fundoFiltro.trim().toLocaleLowerCase("pt-BR");
    const columnEvent = eventoFiltro.trim().toLocaleLowerCase("pt-BR");
    const sorted = items.filter((item) => {
      if (modulo !== "todos" && item.modulo !== modulo) return false;
      if (escopo === "ativos" && !isActiveEpisode(item)) return false;
      if (
        quick === "violacoes" &&
        (!isActiveEpisode(item) || !item.violacao_detectada)
      )
        return false;
      if (
        quick === "pendentes" &&
        (!isActiveEpisode(item) || !item.notificacao_pendente)
      )
        return false;
      if (quick === "regularizados" && !item.data_regularizacao) return false;
      if (
        nivelFiltro !== "todos" &&
        (nivelFiltro === "violacao") !== item.violacao_detectada
      )
        return false;
      if (moduloFiltro !== "todos" && item.modulo !== moduloFiltro)
        return false;
      if (
        notificacaoFiltro !== "todos" &&
        (notificacaoFiltro === "pendente") !== item.notificacao_pendente
      )
        return false;
      if (planoFiltro === "com_plano" && !item.plano_id) return false;
      if (planoFiltro === "sem_plano" && item.plano_id) return false;
      if (statusFiltro !== "todos" && item.status_workflow !== statusFiltro)
        return false;
      if (
        periodoFiltro !== "todos" &&
        Math.floor(
          (Date.now() - parseISO(item.data_inicio).getTime()) / 86400000,
        ) > Number(periodoFiltro)
      )
        return false;
      if (
        columnFund &&
        ![item.fundo_nome, item.fundo_cnpj, item.fundo_isin].some((v) =>
          v.toLocaleLowerCase("pt-BR").includes(columnFund),
        )
      )
        return false;
      if (
        columnEvent &&
        ![item.titulo, item.source_key].some((v) =>
          v.toLocaleLowerCase("pt-BR").includes(columnEvent),
        )
      )
        return false;
      return (
        !term ||
        [item.fundo_nome, item.fundo_cnpj, item.fundo_isin, item.titulo].some(
          (v) => v.toLocaleLowerCase("pt-BR").includes(term),
        )
      );
    });
    const value = (item: RiscoEpisodio) =>
      ({
        nivel: item.violacao_detectada ? 2 : 1,
        modulo: RISCO_MODULO_LABEL[item.modulo],
        fundo: item.fundo_nome,
        evento: item.titulo,
        periodo: item.data_inicio,
        notificacao: item.notificacao_pendente ? 1 : 0,
        plano: item.plano_id ? 1 : 0,
        status: item.status_workflow,
      })[sort.key];
    return sorted.sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      const compare =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv), "pt-BR");
      return sort.direction === "asc" ? compare : -compare;
    });
  }, [
    busca,
    escopo,
    eventoFiltro,
    fundoFiltro,
    items,
    modulo,
    moduloFiltro,
    nivelFiltro,
    notificacaoFiltro,
    periodoFiltro,
    planoFiltro,
    quick,
    sort,
    statusFiltro,
  ]);
  const stats = useMemo(
    () => ({
      fundos: new Set(
        items
          .filter(isActiveEpisode)
          .map((i) => `${i.fundo_cnpj}|${i.fundo_isin}`),
      ).size,
      ativos: items.filter(isActiveEpisode).length,
      violacoes: items.filter((i) => isActiveEpisode(i) && i.violacao_detectada)
        .length,
      pendentes: items.filter(
        (i) => isActiveEpisode(i) && i.notificacao_pendente,
      ).length,
      regularizados: items.filter((i) => !!i.data_regularizacao).length,
    }),
    [items],
  );
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const toggle = (next: NonNullable<typeof quick>) =>
    setQuick((current) => (current === next ? null : next));
  const sortColumn = (key: SortKey) =>
    setSort((current) => ({
      key,
      direction:
        current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  const refresh = async () => {
    try {
      await sync.mutateAsync();
      toast.success("Visão atualizada com as evidências diárias pendentes.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Falha ao atualizar episódios.",
      );
    }
  };
  if (query.isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  if (query.error)
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Não foi possível carregar os episódios</AlertTitle>
        <AlertDescription className="flex items-center justify-between gap-3">
          <span>
            {query.error instanceof Error
              ? query.error.message
              : "Erro inesperado"}
          </span>
          <Button variant="outline" onClick={() => query.refetch()}>
            Tentar novamente
          </Button>
        </AlertDescription>
      </Alert>
    );
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 xl:flex-row xl:items-end xl:justify-between">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Visão</Label>
            <Select
              value={escopo}
              onValueChange={(v) => setEscopo(v as typeof escopo)}
            >
              <SelectTrigger className="w-[190px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ativos">Casos ativos</SelectItem>
                <SelectItem value="historico">Histórico completo</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {!modulos && (
            <div className="space-y-1">
              <Label className="text-xs">Módulo</Label>
              <Select
                value={modulo}
                onValueChange={(v) => setModulo(v as RiscoModulo | "todos")}
              >
                <SelectTrigger className="w-[175px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todos">Todos os módulos</SelectItem>
                  {ALL_MODULES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {RISCO_MODULO_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              aria-label="Buscar episódio"
              className="w-[250px] pl-9"
              placeholder="Buscar fundo ou evento"
            />
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={sync.isPending || query.isFetching}
        >
          {sync.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Atualizar fontes diárias
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi
          label="Fundos ativos"
          value={stats.fundos}
          icon={Users}
          tone="bg-slate-100 text-slate-700"
        />
        <Kpi
          label="Episódios ativos"
          value={stats.ativos}
          icon={ShieldAlert}
          tone="bg-blue-100 text-blue-700"
        />
        <Kpi
          label="Violações abertas"
          value={stats.violacoes}
          icon={ShieldAlert}
          tone="bg-red-100 text-red-700"
          onClick={() => toggle("violacoes")}
          active={quick === "violacoes"}
        />
        <Kpi
          label="Cobranças pendentes"
          value={stats.pendentes}
          icon={Bell}
          tone="bg-amber-100 text-amber-700"
          onClick={() => toggle("pendentes")}
          active={quick === "pendentes"}
        />
        <Kpi
          label="Regularizados"
          value={stats.regularizados}
          icon={CheckCircle2}
          tone="bg-emerald-100 text-emerald-700"
          onClick={() => {
            setEscopo("historico");
            toggle("regularizados");
          }}
          active={quick === "regularizados"}
        />
      </div>
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-2 text-xs text-muted-foreground">
          <span>
            {filtered.length} de {items.length} episódio(s)
          </span>
          <span>Data de referência: {format(new Date(), "dd/MM/yyyy")}</span>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead>
                  <TableHeaderControl
                    label="Nível"
                    column="nivel"
                    sortKey={sort.key}
                    sortDirection={sort.direction}
                    onSort={sortColumn}
                    activeFilter={nivelFiltro !== "todos"}
                  >
                    <HeaderFilter
                      active={nivelFiltro !== "todos"}
                      clear={() => setNivelFiltro("todos")}
                    >
                      <Select
                        value={nivelFiltro}
                        onValueChange={(value) =>
                          setNivelFiltro(value as typeof nivelFiltro)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="todos">Todos os níveis</SelectItem>
                          <SelectItem value="violacao">Violação</SelectItem>
                          <SelectItem value="atencao">Atenção</SelectItem>
                        </SelectContent>
                      </Select>
                    </HeaderFilter>
                  </TableHeaderControl>
                </TableHead>
                <TableHead>
                  <TableHeaderControl
                    label="Módulo"
                    column="modulo"
                    sortKey={sort.key}
                    sortDirection={sort.direction}
                    onSort={sortColumn}
                    activeFilter={moduloFiltro !== "todos"}
                  >
                    <HeaderFilter
                      active={moduloFiltro !== "todos"}
                      clear={() => setModuloFiltro("todos")}
                    >
                      <Select
                        value={moduloFiltro}
                        onValueChange={(value) =>
                          setModuloFiltro(value as RiscoModulo | "todos")
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="todos">
                            Todos os módulos
                          </SelectItem>
                          {ALL_MODULES.map((value) => (
                            <SelectItem key={value} value={value}>
                              {RISCO_MODULO_LABEL[value]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </HeaderFilter>
                  </TableHeaderControl>
                </TableHead>
                <TableHead className="min-w-[230px]">
                  <TableHeaderControl
                    label="Fundo"
                    column="fundo"
                    sortKey={sort.key}
                    sortDirection={sort.direction}
                    onSort={sortColumn}
                    activeFilter={Boolean(fundoFiltro)}
                  >
                    <HeaderFilter
                      active={Boolean(fundoFiltro)}
                      clear={() => setFundoFiltro("")}
                    >
                      <Input
                        value={fundoFiltro}
                        onChange={(event) => setFundoFiltro(event.target.value)}
                        placeholder="Nome, CNPJ ou ISIN"
                      />
                    </HeaderFilter>
                  </TableHeaderControl>
                </TableHead>
                <TableHead className="min-w-[250px]">
                  <TableHeaderControl
                    label="Evento"
                    column="evento"
                    sortKey={sort.key}
                    sortDirection={sort.direction}
                    onSort={sortColumn}
                    activeFilter={Boolean(eventoFiltro)}
                  >
                    <HeaderFilter
                      active={Boolean(eventoFiltro)}
                      clear={() => setEventoFiltro("")}
                    >
                      <Input
                        value={eventoFiltro}
                        onChange={(event) =>
                          setEventoFiltro(event.target.value)
                        }
                        placeholder="Regra ou evento"
                      />
                    </HeaderFilter>
                  </TableHeaderControl>
                </TableHead>
                <TableHead>
                  <TableHeaderControl
                    label="Início / última evidência"
                    column="periodo"
                    sortKey={sort.key}
                    sortDirection={sort.direction}
                    onSort={sortColumn}
                    activeFilter={periodoFiltro !== "todos"}
                  >
                    <HeaderFilter
                      active={periodoFiltro !== "todos"}
                      clear={() => setPeriodoFiltro("todos")}
                    >
                      <Select
                        value={periodoFiltro}
                        onValueChange={(value) =>
                          setPeriodoFiltro(value as typeof periodoFiltro)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="todos">Qualquer início</SelectItem>
                          <SelectItem value="7">Últimos 7 dias</SelectItem>
                          <SelectItem value="30">Últimos 30 dias</SelectItem>
                          <SelectItem value="90">Últimos 90 dias</SelectItem>
                        </SelectContent>
                      </Select>
                    </HeaderFilter>
                  </TableHeaderControl>
                </TableHead>
                <TableHead>
                  <TableHeaderControl
                    label="Notificação"
                    column="notificacao"
                    sortKey={sort.key}
                    sortDirection={sort.direction}
                    onSort={sortColumn}
                    activeFilter={notificacaoFiltro !== "todos"}
                  >
                    <HeaderFilter
                      active={notificacaoFiltro !== "todos"}
                      clear={() => setNotificacaoFiltro("todos")}
                    >
                      <Select
                        value={notificacaoFiltro}
                        onValueChange={(value) =>
                          setNotificacaoFiltro(
                            value as typeof notificacaoFiltro,
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="todos">Todas</SelectItem>
                          <SelectItem value="pendente">Pendente</SelectItem>
                          <SelectItem value="regular">Regular</SelectItem>
                        </SelectContent>
                      </Select>
                    </HeaderFilter>
                  </TableHeaderControl>
                </TableHead>
                <TableHead>
                  <TableHeaderControl
                    label="Plano de ação"
                    column="plano"
                    sortKey={sort.key}
                    sortDirection={sort.direction}
                    onSort={sortColumn}
                    activeFilter={planoFiltro !== "todos"}
                  >
                    <HeaderFilter
                      active={planoFiltro !== "todos"}
                      clear={() => setPlanoFiltro("todos")}
                    >
                      <Select
                        value={planoFiltro}
                        onValueChange={(value) =>
                          setPlanoFiltro(value as typeof planoFiltro)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="todos">Todos</SelectItem>
                          <SelectItem value="com_plano">Com plano</SelectItem>
                          <SelectItem value="sem_plano">Sem plano</SelectItem>
                        </SelectContent>
                      </Select>
                    </HeaderFilter>
                  </TableHeaderControl>
                </TableHead>
                <TableHead>
                  <TableHeaderControl
                    label="Status"
                    column="status"
                    sortKey={sort.key}
                    sortDirection={sort.direction}
                    onSort={sortColumn}
                    activeFilter={statusFiltro !== "todos"}
                  >
                    <HeaderFilter
                      active={statusFiltro !== "todos"}
                      clear={() => setStatusFiltro("todos")}
                    >
                      <Select
                        value={statusFiltro}
                        onValueChange={(value) =>
                          setStatusFiltro(value as typeof statusFiltro)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="todos">Todos</SelectItem>
                          <SelectItem value="aberta">Aberta</SelectItem>
                          <SelectItem value="aguardando_plano">
                            Aguardando plano
                          </SelectItem>
                          <SelectItem value="em_tratamento">
                            Em tratamento
                          </SelectItem>
                          <SelectItem value="regularizada">
                            Regularizada
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </HeaderFilter>
                  </TableHeaderControl>
                </TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="h-40 text-center">
                    <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-emerald-600" />
                    <p className="font-medium">Nenhum episódio encontrado</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Ajuste os filtros ou atualize as fontes diárias.
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((item) => (
                  <TableRow
                    key={item.id}
                    tabIndex={0}
                    onClick={() => setSelectedId(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(item.id);
                      }
                    }}
                    className="cursor-pointer hover:bg-muted/40 focus:bg-muted/40 focus:outline-none"
                  >
                    <TableCell>
                      <Nivel item={item} />
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={moduleTone[item.modulo]}
                      >
                        {RISCO_MODULO_LABEL[item.modulo]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <p className="font-medium">{item.fundo_nome}</p>
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                        {cnpj(item.fundo_cnpj)}
                      </p>
                      {item.fundo_isin && (
                        <p className="font-mono text-[11px] text-muted-foreground">
                          ISIN {item.fundo_isin}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <p className="line-clamp-2 text-sm font-medium">
                        {item.titulo}
                      </p>
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                        {item.source_key}
                      </p>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <p>{date(item.data_inicio)}</p>
                      <p className="text-muted-foreground">
                        última: {date(item.data_ultima_evidencia)} ·{" "}
                        {item.dias_episodio}d
                      </p>
                    </TableCell>
                    <TableCell>
                      {item.notificacao_pendente ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                          <Bell className="h-4 w-4" />
                          Pendente
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                          <MailCheck className="h-4 w-4" />
                          Regular
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {item.plano_id ? (
                        <div>
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                            <FileCheck2 className="h-4 w-4" />
                            Recebido · v{item.plano_versao}
                          </span>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Prazo: {date(item.plano_prazo)}
                          </p>
                        </div>
                      ) : item.violacao_detectada ? (
                        <span className="text-xs font-medium text-amber-700">
                          Aguardando gestor
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Não aplicável
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Status item={item} />
                    </TableCell>
                    <TableCell>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      <EpisodioSheet item={selected} onClose={() => setSelectedId(null)} />
    </div>
  );
}
