import { useMemo, useState, Fragment } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DateRefNavigator } from "@/components/DateRefNavigator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ChevronDown,
  ChevronRight,
  LineChart,
  RefreshCw,
  Mail,
  Loader2,
  FileSpreadsheet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  fmtBRL,
  fmtCDIPlusAA,
  fmtCnpj,
  fmtCota,
  fmtData,
  fmtPct,
  fmtPctCDI,
  buildVsCDITooltipLines,
  calcCdiAcumulado12M,
  subtractDaysIso,
  getRetornoDiaDestaque,
} from "@/hooks/useRentabilidadeCalc";
import {
  useRentabilidadeAtivos,
  useRentabilidadeDatas,
  useRentabilidadeFundos,
  useFundosXmlCoverage,
  consolidateFundosPorCnpj,
  fetchRentabilidadeAtivosForFundo,
  type RentabilidadeFundoRow,
} from "@/hooks/useRentabilidadeData";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCDI, fetchCdiRange } from "@/hooks/useCDI";
import { useToast } from "@/hooks/use-toast";
import {
  prepareFundosRelatorio,
  type AtivoRelatorio,
} from "@/lib/generateRentabilidadeRelatorioHTML_v2";
import {
  convertAtivoToRelatorio,
  sortAtivosRelatorio,
  fetchSiglasNomesFundos,
  collectCnpjsAtivos,
} from "@/lib/prepareRentabilidadeRelatorioData";
import {
  buildRentabilidadeRelatorioExcelBuffer,
  downloadExcelBuffer,
  generateRentabilidadeRelatorioExcel,
} from "@/lib/generateRentabilidadeRelatorioExcel";
import { generateRentabilidadeEmailTableHTML } from "@/lib/generateRentabilidadeEmailTableHTML";
import {
  buildRentabilidadeEmailIntro,
  buildRentabilidadeEmailClipboardContent,
  copyRentabilidadeEmailToClipboard,
  openRentabilidadeEmailDraft,
} from "@/lib/rentabilidadeEmailOutlook";
import { RetComPctCdiCell } from "@/components/rentabilidade/RetComPctCdiCell";

type SortKey = keyof Pick<
  RentabilidadeFundoRow,
  | "nome_fundo"
  | "valor_cota"
  | "pl"
  | "retorno_dia_pct"
  | "retorno_mes_pct"
  | "retorno_ano_pct"
  | "retorno_12m_pct"
  | "cdi_dia_pct"
>;

function pctColor(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v > 0) return "text-emerald-600 dark:text-emerald-400";
  if (v < 0) return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

function retornoDiaRowHighlight(retornoDiaPct: number | null): string {
  const destaque = getRetornoDiaDestaque(retornoDiaPct);
  if (destaque === "queda") {
    return "bg-red-50/90 dark:bg-red-950/35 ring-1 ring-inset ring-red-200/70 dark:ring-red-800/50 hover:bg-red-100/80 dark:hover:bg-red-950/45";
  }
  if (destaque === "alta") {
    return "bg-emerald-50/90 dark:bg-emerald-950/35 ring-1 ring-inset ring-emerald-200/70 dark:ring-emerald-800/50 hover:bg-emerald-100/80 dark:hover:bg-emerald-950/45";
  }
  return "";
}

function retornoDiaCellHighlight(retornoDiaPct: number | null): string {
  const destaque = getRetornoDiaDestaque(retornoDiaPct);
  if (destaque === "queda") return "font-bold text-red-700 dark:text-red-400";
  if (destaque === "alta") return "font-bold text-emerald-700 dark:text-emerald-400";
  return "";
}

const EXPORT_ATIVOS_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

function formatExportError(error: unknown, fallback: string): string {
  if (error instanceof TypeError && error.message === "Failed to fetch") {
    return "Falha de rede ao buscar dados. Verifique a conexão e tente novamente.";
  }
  return error instanceof Error ? error.message : fallback;
}

async function fetchRelatorioRentabilidadeCompleto(
  fundos: RentabilidadeFundoRow[],
  selectedDate: string,
) {
  const dataMin = subtractDaysIso(selectedDate, 560);
  const cdiDict = await fetchCdiRange(dataMin, selectedDate);
  const fundosAtivosMap = new Map<string, AtivoRelatorio[]>();

  const results = await mapWithConcurrency(
    fundos,
    EXPORT_ATIVOS_CONCURRENCY,
    async (fundo) => {
      try {
        const ativos = await fetchRentabilidadeAtivosForFundo(
          fundo.fundo_cnpj,
          fundo.fundo_isin,
          fundo.nome_fundo,
          selectedDate,
          fundo.pl,
          cdiDict,
        );
        const ativosRelatorio = ativos.map(convertAtivoToRelatorio);
        return {
          cnpj: fundo.fundo_key,
          ativos: sortAtivosRelatorio(ativosRelatorio),
        };
      } catch (err) {
        console.error(`Erro ao buscar ativos do fundo ${fundo.fundo_cnpj}:`, err);
        return { cnpj: fundo.fundo_key, ativos: [] as AtivoRelatorio[] };
      }
    },
  );

  results.forEach(({ cnpj, ativos }) => {
    fundosAtivosMap.set(cnpj, ativos);
  });

  const { fundos: fundosRelatorio } = prepareFundosRelatorio(fundos, fundosAtivosMap);
  const fundosResumoRows = consolidateFundosPorCnpj(fundos);
  const { fundos: fundosResumo } = prepareFundosRelatorio(fundosResumoRows, new Map());

  return { fundosRelatorio, fundosResumo, fundosAtivosMap };
}

function VsCDICell({
  retornoPct,
  cdiBenchPct,
  cdiPlusAaPct,
  pctCdi,
  retornoLabel = "Retorno do dia",
  cdiLabel = "CDI do dia",
  cdiPlusPct = null,
  duAnual = 252,
}: {
  retornoPct: number | null;
  cdiBenchPct: number | null;
  cdiPlusAaPct: number | null;
  pctCdi: number | null;
  retornoLabel?: string;
  cdiLabel?: string;
  cdiPlusPct?: number | null;
  duAnual?: number;
}) {
  if (
    retornoPct == null ||
    retornoPct < 0 ||
    cdiBenchPct == null ||
    (cdiPlusAaPct == null && pctCdi == null)
  ) {
    return <span className="text-muted-foreground">—</span>;
  }

  const tooltipLines = buildVsCDITooltipLines(
    retornoPct,
    cdiBenchPct,
    cdiPlusPct,
    pctCdi,
    retornoLabel,
    cdiLabel,
    duAnual,
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="text-right text-xs cursor-help leading-snug space-y-0.5">
          <div className="font-medium">{fmtCDIPlusAA(cdiPlusAaPct)}</div>
          <div className="text-muted-foreground">{fmtPctCDI(pctCdi)}</div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[280px] text-xs space-y-1">
        {tooltipLines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

function AtivosPanel({
  fundo,
  dataRef,
}: {
  fundo: RentabilidadeFundoRow;
  dataRef: string;
}) {
  const dataMin = subtractDaysIso(dataRef, 560);
  const { cdiDict } = useCDI(dataMin, dataRef);
  const cdi12mPct = useMemo(
    () => calcCdiAcumulado12M(cdiDict, dataRef),
    [cdiDict, dataRef],
  );
  const { data: ativos = [], isLoading } = useRentabilidadeAtivos(
    fundo.fundo_cnpj,
    fundo.fundo_isin,
    fundo.nome_fundo,
    dataRef,
    fundo.pl,
    cdiDict,
    true,
  );

  if (isLoading) {
    return (
      <div className="p-4 space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (ativos.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Nenhum ativo com PU/valor (cotas, títulos, ações, participações ou imóveis) nesta data.
      </p>
    );
  }

  return (
    <div className="p-4 bg-muted/30">
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead>Ativo</TableHead>
            <TableHead className="text-right">Qtd</TableHead>
            <TableHead className="text-right">PU</TableHead>
            <TableHead className="text-right">Vl. Mercado</TableHead>
            <TableHead className="text-right">% PL</TableHead>
            <TableHead className="text-right">Var. Dia</TableHead>
            <TableHead className="text-right">vs CDI dia</TableHead>
            <TableHead className="text-right">Var. Mês</TableHead>
            <TableHead className="text-right">vs CDI mês</TableHead>
            <TableHead className="text-right">Var. Ano</TableHead>
            <TableHead className="text-right">vs CDI ano</TableHead>
            <TableHead className="text-right">Var. 12M</TableHead>
            <TableHead className="text-right">vs CDI 12M</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ativos.map((a, i) => (
            <TableRow key={`${a.ativo_key}-${i}`}>
              <TableCell className="font-medium text-sm">
                {a.nome_exibicao}
                {a.cnpj_ativo && (
                  <span className="block text-xs text-muted-foreground font-mono">
                    {fmtCnpj(a.cnpj_ativo)}
                  </span>
                )}
                {a.isin_ativo && (
                  <span className="block text-[11px] text-muted-foreground/90 font-mono">
                    ISIN: {a.isin_ativo}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {a.qt_disponivel?.toLocaleString("pt-BR", {
                  minimumFractionDigits: 6,
                  maximumFractionDigits: 6,
                }) ?? "—"}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {fmtCota(a.pu_posicao, 8)}
              </TableCell>
              <TableCell className="text-right text-xs">
                {fmtBRL(a.vl_mercado)}
              </TableCell>
              <TableCell className="text-right text-xs">
                {a.perc_pl_pct != null ? fmtPct(a.perc_pl_pct, 2) : "—"}
              </TableCell>
              <TableCell
                className={cn("text-right text-xs", pctColor(a.var_pu_pct))}
              >
                {fmtPct(a.var_pu_pct)}
              </TableCell>
              <TableCell className="text-right">
                <VsCDICell
                  retornoPct={a.var_pu_pct}
                  cdiBenchPct={fundo.cdi_dia_pct}
                  cdiPlusAaPct={a.cdi_plus_aa_pct}
                  cdiPlusPct={a.cdi_plus_dia_pct}
                  pctCdi={a.pct_cdi}
                  retornoLabel="Var. PU do dia"
                  cdiLabel="CDI do dia"
                  duAnual={252}
                />
              </TableCell>
              <TableCell
                className={cn("text-right text-xs", pctColor(a.var_pu_mes_pct))}
              >
                {fmtPct(a.var_pu_mes_pct)}
              </TableCell>
              <TableCell className="text-right">
                <VsCDICell
                  retornoPct={a.var_pu_mes_pct}
                  cdiBenchPct={fundo.cdi_mes_pct}
                  cdiPlusAaPct={a.cdi_plus_aa_mes_pct}
                  cdiPlusPct={a.cdi_plus_mes_pct}
                  pctCdi={a.pct_cdi_mes}
                  retornoLabel="Var. PU do mês"
                  cdiLabel="CDI acum. mês"
                  duAnual={12}
                />
              </TableCell>
              <TableCell
                className={cn("text-right text-xs", pctColor(a.var_pu_ano_pct))}
              >
                {fmtPct(a.var_pu_ano_pct)}
              </TableCell>
              <TableCell className="text-right">
                <VsCDICell
                  retornoPct={a.var_pu_ano_pct}
                  cdiBenchPct={fundo.cdi_ano_pct}
                  cdiPlusAaPct={a.cdi_plus_aa_ano_pct}
                  cdiPlusPct={a.cdi_plus_ano_pct}
                  pctCdi={a.pct_cdi_ano}
                  retornoLabel="Var. PU do ano"
                  cdiLabel="CDI acum. ano"
                  duAnual={1}
                />
              </TableCell>
              <TableCell
                className={cn("text-right text-xs", pctColor(a.var_pu_12m_pct))}
              >
                {fmtPct(a.var_pu_12m_pct)}
              </TableCell>
              <TableCell className="text-right">
                <VsCDICell
                  retornoPct={a.var_pu_12m_pct}
                  cdiBenchPct={cdi12mPct}
                  cdiPlusAaPct={a.cdi_plus_aa_12m_pct}
                  cdiPlusPct={a.cdi_plus_12m_pct}
                  pctCdi={a.pct_cdi_12m}
                  retornoLabel="Var. PU 12M"
                  cdiLabel="CDI acum. 12M"
                  duAnual={1}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function ControleCotasRentabilidade() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {
    data: datas = [],
    isLoading: datasLoading,
    refetch: refetchDatas,
  } = useRentabilidadeDatas();
  const [dataRef, setDataRef] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("nome_fundo");
  const [sortAsc, setSortAsc] = useState(true);
  const [isGeneratingEmail, setIsGeneratingEmail] = useState(false);
  const [isGeneratingExcel, setIsGeneratingExcel] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [xmlFaltantesOpen, setXmlFaltantesOpen] = useState(false);

  const selectedDate = dataRef ?? datas[0] ?? null;

  const {
    fundos,
    isLoading,
    error,
    refetch,
    rebuildSnapshot,
    cdiDisponivel,
    source: rentabilidadeSource,
    snapshotStatus,
  } =
    useRentabilidadeFundos(selectedDate);

  const {
    total: xmlTotal,
    importados: xmlImportados,
    faltantes: xmlFaltantes,
    isLoading: xmlCoverageLoading,
  } = useFundosXmlCoverage(selectedDate);

  const sortedFundos = useMemo(() => {
    const list = [...fundos];
    list.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string") {
        return sortAsc ? av.localeCompare(bv, "pt-BR") : bv.localeCompare(av, "pt-BR");
      }
      const na = Number(av);
      const nb = Number(bv);
      return sortAsc ? na - nb : nb - na;
    });
    return list;
  }, [fundos, sortKey, sortAsc]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(key === "nome_fundo");
    }
  };

  const toggleExpand = (fundoKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(fundoKey)) next.delete(fundoKey);
      else next.add(fundoKey);
      return next;
    });
  };

  const handleRefresh = async (recalcularCotas = false) => {
    setIsRefreshing(true);
    try {
      if (selectedDate && recalcularCotas) {
        const result = await rebuildSnapshot();
        const [, refreshResult] = await Promise.all([
          refetchDatas(),
          refetch(),
          queryClient.invalidateQueries({ queryKey: ["fundos-xml-coverage", selectedDate] }),
        ]);
        if (refreshResult?.error) throw refreshResult.error;
        if (result.persistedCount > 0) {
          toast({
            title: "Snapshot atualizado",
            description: `${result.persistedCount} de ${result.totalFundos} fundos persistidos para ${fmtData(selectedDate)}.`,
            duration: 2000,
          });
        } else {
          toast({
            title: "Dados atualizados",
            description: "Snapshot ainda não disponível no banco; exibindo cálculo em tempo real.",
            duration: 2500,
          });
        }
        return;
      }

      const [, refreshResult] = await Promise.all([
        refetchDatas(),
        refetch(),
        queryClient.invalidateQueries({ queryKey: ["fundos-xml-coverage"] }),
      ]);
      if (refreshResult?.error) throw refreshResult.error;
      toast({
        title: "Dados atualizados",
        duration: 1500,
      });
    } catch (error) {
      toast({
        title: "Erro ao atualizar",
        description: error instanceof Error ? error.message
          : (error as { message?: string })?.message ?? "Falha ao atualizar os dados",
        variant: "destructive",
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleGerarEmailOutlook = async () => {
    if (!selectedDate) {
      toast({
        title: "Erro",
        description: "Selecione uma data de referência",
        variant: "destructive",
      });
      return;
    }

    setIsGeneratingEmail(true);
    try {
      toast({
        title: "Gerando e-mail",
        description: "Aguarde enquanto coletamos os dados...",
      });

      const { fundosRelatorio, fundosResumo, fundosAtivosMap } =
        await fetchRelatorioRentabilidadeCompleto(fundos, selectedDate);

      const dataFormatada = format(parseISO(selectedDate), "dd/MM/yyyy", { locale: ptBR });

      const cnpjsSiglas = [
        ...collectCnpjsAtivos(fundosAtivosMap),
        ...xmlFaltantes.map((f) => f.cnpj_fundo),
      ];
      const siglasPorCnpj = await fetchSiglasNomesFundos(cnpjsSiglas);

      const { buffer, filename } = await buildRentabilidadeRelatorioExcelBuffer(
        fundosRelatorio,
        selectedDate,
        fundosResumo,
      );

      const { html: tableHtml, plainText: tablePlain } = generateRentabilidadeEmailTableHTML(
        fundosRelatorio,
        selectedDate,
      );

      const { plainIntro, htmlIntro } = buildRentabilidadeEmailIntro(
        dataFormatada,
        xmlFaltantes,
        siglasPorCnpj,
      );

      const { tableOnlyHtml, tableOnlyPlain } = buildRentabilidadeEmailClipboardContent(
        htmlIntro,
        tableHtml,
        plainIntro,
        tablePlain,
      );

      // Copia antes do download — o diálogo de arquivo costuma roubar o foco da aba
      const tabelaCopiada = await copyRentabilidadeEmailToClipboard(
        tableOnlyHtml,
        tableOnlyPlain,
      );

      downloadExcelBuffer(buffer, filename);

      openRentabilidadeEmailDraft(dataFormatada, plainIntro);

      toast({
        title: "Pronto!",
        description: tabelaCopiada
          ? "Excel baixado e rascunho aberto. Cole a tabela (Ctrl+V) abaixo do texto, anexe o Excel e envie."
          : "Excel baixado e rascunho aberto com o texto. A tabela não foi copiada — volte à aba do sistema, clique em E-mail novamente ou exporte o Excel.",
        duration: 10000,
      });
    } catch (error) {
      console.error("Erro ao gerar e-mail:", error);
      toast({
        title: "Erro",
        description: formatExportError(error, "Falha ao gerar e-mail"),
        variant: "destructive",
      });
    } finally {
      setIsGeneratingEmail(false);
    }
  };

  const handleGerarExcel = async () => {
    if (!selectedDate) {
      toast({
        title: "Erro",
        description: "Selecione uma data de referência",
        variant: "destructive",
      });
      return;
    }

    setIsGeneratingExcel(true);
    try {
      toast({
        title: "Gerando Excel",
        description: "Aguarde enquanto coletamos os dados...",
      });

      const { fundosRelatorio, fundosResumo } = await fetchRelatorioRentabilidadeCompleto(
        fundos,
        selectedDate,
      );

      await generateRentabilidadeRelatorioExcel(fundosRelatorio, selectedDate, fundosResumo);

      toast({
        title: "Excel gerado!",
        description: "O arquivo foi baixado automaticamente.",
        duration: 5000,
      });
    } catch (error) {
      console.error("Erro ao gerar Excel:", error);
      toast({
        title: "Erro",
        description: formatExportError(error, "Falha ao gerar Excel"),
        variant: "destructive",
      });
    } finally {
      setIsGeneratingExcel(false);
    }
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold tracking-tight text-foreground uppercase tracking-wider flex items-center gap-2">
              <LineChart className="h-6 w-6 text-primary" />
              Rentabilidade
            </h1>
            <p className="text-sm text-muted-foreground font-medium uppercase tracking-wide">
              Controle diário de rentabilidade dos fundos (XML)
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-muted-foreground">Data de referência:</span>
            {datasLoading ? (
              <Skeleton className="h-8 w-[220px]" />
            ) : (
              <DateRefNavigator
                datesFormat="iso"
                availableDates={datas}
                selectedDate={selectedDate}
                onSelectedDateChange={setDataRef}
              />
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => handleRefresh()}
              disabled={isLoading || datasLoading || isRefreshing}
              title="Atualizar dados e CDI da data selecionada"
              aria-label="Atualizar rentabilidade e CDI"
            >
              <RefreshCw
                className={cn(
                  "h-3.5 w-3.5",
                  (isLoading || datasLoading || isRefreshing) && "animate-spin",
                )}
              />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-2 border-emerald-700 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500 dark:text-emerald-400"
              onClick={handleGerarExcel}
              disabled={!selectedDate || isLoading || isGeneratingExcel}
            >
              {isGeneratingExcel ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileSpreadsheet className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">
                {isGeneratingExcel ? "Gerando..." : "Excel"}
              </span>
            </Button>
            <Button
              variant="default"
              size="sm"
              className="h-8 gap-2"
              onClick={handleGerarEmailOutlook}
              disabled={!selectedDate || isLoading || isGeneratingEmail}
            >
              {isGeneratingEmail ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Mail className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">
                {isGeneratingEmail ? "Gerando..." : "E-mail + Excel"}
              </span>
            </Button>
          </div>
        </div>

        <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
                Data de referência
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg font-semibold">
                {selectedDate ? fmtData(selectedDate) : "—"}
              </p>
            </CardContent>
          </Card>
          <Card
            className={cn(
              "transition-colors",
              selectedDate &&
                xmlFaltantes.length > 0 &&
                "cursor-pointer hover:bg-muted/40",
            )}
            onClick={() => {
              if (selectedDate && xmlFaltantes.length > 0) {
                setXmlFaltantesOpen(true);
              }
            }}
            title={
              xmlFaltantes.length > 0
                ? "Clique para ver fundos sem XML nesta data"
                : undefined
            }
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
                Fundos com XML
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading || xmlCoverageLoading || !selectedDate ? (
                <Skeleton className="h-7 w-24" />
              ) : (
                <>
                  <p
                    className={cn(
                      "text-lg font-semibold tabular-nums",
                      xmlImportados < xmlTotal &&
                        "text-amber-700 dark:text-amber-500",
                    )}
                  >
                    {xmlImportados}{" "}
                    <span className="text-muted-foreground font-normal">
                      / {xmlTotal}
                    </span>
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {xmlFaltantes.length > 0
                      ? `${xmlFaltantes.length} faltante${xmlFaltantes.length !== 1 ? "s" : ""} — clique para listar`
                      : "Todos os fundos ativos com XML nesta data"}
                  </p>
                  <p className="text-[10px] text-muted-foreground/80 mt-0.5">
                    Universo por classe (fundo_key); inativos há mais de 10 dias
                    fora da contagem · PL via fundo_patliq (import-xml)
                  </p>
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                    Fonte da grade: {rentabilidadeSource === "snapshot" ? "snapshot persistido" : "cálculo em tempo real"}
                  </p>
                  {snapshotStatus?.is_stale && rentabilidadeSource === "snapshot" && (
                    <p className="text-[10px] text-amber-700 dark:text-amber-500 mt-0.5">
                      Cotas marcadas como desatualizadas.{" "}
                      <button
                        type="button"
                        className="underline disabled:opacity-50"
                        disabled={isRefreshing || isLoading}
                        onClick={() => handleRefresh(true)}
                      >
                        Recalcular cotas
                      </button>
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <Dialog open={xmlFaltantesOpen} onOpenChange={setXmlFaltantesOpen}>
          <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>
                XML faltante em{" "}
                {selectedDate ? fmtData(selectedDate) : "—"}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground -mt-2">
              {xmlImportados} de {xmlTotal} fundos ativos com posição importada
              nesta data (último XML nos últimos 10 dias).
            </p>
            {xmlFaltantes.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Nenhum fundo faltante.
              </p>
            ) : (
              <div className="overflow-auto flex-1 -mx-1">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fundo</TableHead>
                      <TableHead>CNPJ</TableHead>
                      <TableHead>ISIN</TableHead>
                      <TableHead>Administrador</TableHead>
                      <TableHead className="text-right">Último XML</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {xmlFaltantes.map((f) => (
                      <TableRow key={f.fundo_key}>
                        <TableCell className="font-medium">
                          {f.nome_fundo || "—"}
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">
                          {fmtCnpj(f.cnpj_fundo)}
                        </TableCell>
                        <TableCell className="text-xs font-mono text-muted-foreground">
                          {f.fundo_isin || "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {f.administrador || "—"}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">
                          {f.ultima_data_iso
                            ? fmtData(f.ultima_data_iso)
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </DialogContent>
        </Dialog>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold uppercase tracking-wide">
              Rentabilidade por fundo
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {error && (
              <p className="p-4 text-sm text-destructive">
                Erro ao carregar dados: {(error as Error).message}
              </p>
            )}
            {!isLoading && !error && fundos.length > 0 && !cdiDisponivel && (
              <p className="p-4 text-sm text-amber-700 dark:text-amber-500" role="status">
                CDI indisponível para a data selecionada. Os comparativos com CDI
                ficarão em branco até a taxa estar disponível.
              </p>
            )}
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : sortedFundos.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground text-center">
                Nenhum fundo com posição XML na data selecionada.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead className="w-8" />
                      <TableHead
                        className="cursor-pointer min-w-[200px]"
                        onClick={() => toggleSort("nome_fundo")}
                      >
                        Fundo
                      </TableHead>
                      <TableHead
                        className="text-right cursor-pointer"
                        onClick={() => toggleSort("valor_cota")}
                      >
                        Cota
                      </TableHead>
                      <TableHead
                        className="text-right cursor-pointer"
                        onClick={() => toggleSort("pl")}
                      >
                        PL
                      </TableHead>
                      <TableHead
                        className="text-right cursor-pointer"
                        onClick={() => toggleSort("retorno_dia_pct")}
                      >
                        Ret. Dia
                      </TableHead>
                      <TableHead className="text-right">vs CDI dia</TableHead>
                      <TableHead
                        className="text-right cursor-pointer"
                        onClick={() => toggleSort("retorno_mes_pct")}
                      >
                        Ret. Mês
                      </TableHead>
                      <TableHead className="text-right">vs CDI mês</TableHead>
                      <TableHead
                        className="text-right cursor-pointer"
                        onClick={() => toggleSort("retorno_ano_pct")}
                      >
                        Ret. Ano
                      </TableHead>
                      <TableHead className="text-right">vs CDI ano</TableHead>
                      <TableHead
                        className="text-right cursor-pointer"
                        onClick={() => toggleSort("retorno_12m_pct")}
                      >
                        Ret. 12M
                      </TableHead>
                      <TableHead
                        className="text-right cursor-pointer"
                        onClick={() => toggleSort("cdi_dia_pct")}
                      >
                        CDI Dia
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedFundos.map((f) => {
                      const isOpen = expanded.has(f.fundo_key);
                      return (
                        <Fragment key={f.fundo_key}>
                          <TableRow
                            className={cn(
                              "cursor-pointer hover:bg-muted/40",
                              retornoDiaRowHighlight(f.retorno_dia_pct),
                            )}
                            onClick={() => {
                              const params = new URLSearchParams();
                              if (f.fundo_isin) params.set("isin", f.fundo_isin);
                              const qs = params.toString();
                              navigate(
                                `/rentabilidade/${f.fundo_cnpj}${qs ? `?${qs}` : ""}`,
                              );
                            }}
                          >
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleExpand(f.fundo_key);
                                }}
                              >
                                {isOpen ? (
                                  <ChevronDown className="h-4 w-4" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </Button>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col">
                                <span className="font-medium text-sm truncate max-w-[240px]">
                                  {f.nome_fundo ?? "—"}
                                </span>
                                <span className="text-xs text-muted-foreground font-mono">
                                  {fmtCnpj(f.fundo_cnpj)}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {fmtCota(f.valor_cota)}
                            </TableCell>
                            <TableCell className="text-right text-xs">
                              {fmtBRL(f.pl)}
                            </TableCell>
                            <TableCell
                              className={cn(
                                "text-right text-xs font-medium",
                                retornoDiaCellHighlight(f.retorno_dia_pct) ||
                                  pctColor(f.retorno_dia_pct),
                              )}
                            >
                              {fmtPct(f.retorno_dia_pct)}
                            </TableCell>
                            <TableCell className="text-right">
                              <VsCDICell
                                retornoPct={f.retorno_dia_pct}
                                cdiBenchPct={f.cdi_dia_pct}
                                cdiPlusAaPct={f.cdi_plus_aa_pct}
                                cdiPlusPct={f.cdi_plus_dia_pct}
                                pctCdi={f.pct_cdi}
                                retornoLabel="Retorno do dia"
                                cdiLabel="CDI do dia"
                                duAnual={252}
                              />
                            </TableCell>
                            <TableCell
                              className={cn(
                                "text-right text-xs",
                                pctColor(f.retorno_mes_pct),
                              )}
                            >
                              {fmtPct(f.retorno_mes_pct)}
                            </TableCell>
                            <TableCell className="text-right">
                              <VsCDICell
                                retornoPct={f.retorno_mes_pct}
                                cdiBenchPct={f.cdi_mes_pct}
                                cdiPlusAaPct={f.cdi_plus_aa_mes_pct}
                                cdiPlusPct={f.cdi_plus_mes_pct}
                                pctCdi={f.pct_cdi_mes}
                                retornoLabel="Retorno do mês"
                                cdiLabel="CDI acum. mês"
                                duAnual={12}
                              />
                            </TableCell>
                            <TableCell
                              className={cn(
                                "text-right text-xs",
                                pctColor(f.retorno_ano_pct),
                              )}
                            >
                              {fmtPct(f.retorno_ano_pct)}
                            </TableCell>
                            <TableCell className="text-right">
                              <VsCDICell
                                retornoPct={f.retorno_ano_pct}
                                cdiBenchPct={f.cdi_ano_pct}
                                cdiPlusAaPct={f.cdi_plus_aa_ano_pct}
                                cdiPlusPct={f.cdi_plus_ano_pct}
                                pctCdi={f.pct_cdi_ano}
                                retornoLabel="Retorno do ano"
                                cdiLabel="CDI acum. ano"
                                duAnual={1}
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <RetComPctCdiCell
                                retornoPct={f.retorno_12m_pct}
                                pctCdi={f.pct_cdi_12m}
                                cdiBenchPct={f.cdi_12m_pct}
                                cdiPlusPct={f.cdi_plus_12m_pct}
                                retornoLabel="Retorno 12 meses"
                                cdiLabel="CDI acum. 12M"
                                duAnual={1}
                              />
                            </TableCell>
                            <TableCell className="text-right text-xs text-muted-foreground">
                              {fmtPct(f.cdi_dia_pct)}
                            </TableCell>
                          </TableRow>
                          {isOpen && selectedDate && (
                            <TableRow>
                              <TableCell colSpan={15} className="p-0">
                                <AtivosPanel
                                  fundo={f}
                                  dataRef={selectedDate}
                                />
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
          </CardContent>
        </Card>
        </div>
      </div>
    </Layout>
  );
}
