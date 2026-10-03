import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  ArrowLeftRight,
  Upload,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronDown,
  ChevronUp,
  FileUp,
  Info,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

// ─── Formatadores ───────────────────────────────────────────────────────────

const formatBRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(v);

const formatDate = (s: string | null | undefined) => {
  if (!s) return "—";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
};

function verticeLabel(v: number): string {
  return v === 1260 ? "D+720+" : `D+${v}`;
}

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface VerticeDescasamento {
  vertice: number;
  verticeLabel: string;
  saidaCotistas: number;
  entradaPortfolio: number;
  saldoLiquido: number;
}

interface LinhaFluxo {
  data_liquidacao: string;
  subtipo: string;
  financeiro: number;
  vertice: number;
}

interface DescasamentoData {
  porVertice: VerticeDescasamento[];
  totais: { saidaCotistas: number; entradaPortfolio: number; saldoLiquido: number };
  linhasFluxo: LinhaFluxo[];
}

interface PorFundoItem {
  cnpj: string;
  nome: string | null;
  count: number;
}

interface ImportResult {
  success: boolean;
  inserted?: number;
  linhasResgate?: number;
  totalLinhas?: number;
  porFundo?: PorFundoItem[];
  message?: string;
  error?: string;
}

interface FundoOption {
  cnpj: string;
  nome: string;
}

// ─── Componentes auxiliares ──────────────────────────────────────────────────

function SaldoBadge({ valor }: { valor: number }) {
  if (valor > 0)
    return (
      <Badge className="bg-emerald-500/10 text-emerald-700 border-emerald-200 text-[9px] h-4 px-1.5 font-normal">
        <CheckCircle2 className="w-2 h-2 mr-1" /> Coberto
      </Badge>
    );
  if (valor === 0)
    return (
      <Badge className="bg-muted/50 text-muted-foreground border-muted text-[9px] h-4 px-1.5 font-normal">
        Zerado
      </Badge>
    );
  return (
    <Badge className="bg-red-500/10 text-red-700 border-red-200 text-[9px] h-4 px-1.5 font-normal">
      <XCircle className="w-2 h-2 mr-1" /> Descoberto
    </Badge>
  );
}

function SummaryCard({
  label,
  valor,
  sub,
  destaque,
}: {
  label: string;
  valor: number;
  sub?: string;
  destaque?: "positivo" | "negativo" | "neutro";
}) {
  const colorClass =
    destaque === "positivo"
      ? "text-emerald-600"
      : destaque === "negativo"
      ? "text-red-600"
      : "text-foreground";

  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">
          {label}
        </p>
        <p className={cn("text-2xl font-bold font-mono tabular-nums", colorClass)}>
          {formatBRL(valor)}
        </p>
        {sub && <p className="text-[10px] text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ─── Página principal ────────────────────────────────────────────────────────

export default function LiquidezDescasamentoOperacional() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [fundoCnpj, setFundoCnpj] = useState<string>("");
  const [dataAnalise, setDataAnalise] = useState<string>(() => {
    const t = new Date();
    return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, "0")}${String(t.getDate()).padStart(2, "0")}`;
  });
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [detalheOpen, setDetalheOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Lista de fundos disponíveis ──
  const { data: fundos = [], isLoading: fundosLoading } = useQuery({
    queryKey: ["fundos-lista-descasamento"],
    queryFn: async (): Promise<FundoOption[]> => {
      const { data, error } = await supabase
        .from("posicao_carteira")
        .select("fundo_cnpj, nome_fundo")
        .order("fundo_dtposicao", { ascending: false });
      if (error) throw error;

      const seen = new Set<string>();
      const list: FundoOption[] = [];
      for (const r of data ?? []) {
        const cnpj = String(r.fundo_cnpj ?? "").trim();
        if (!cnpj || seen.has(cnpj)) continue;
        seen.add(cnpj);
        list.push({
          cnpj,
          nome: String((r as any).nome_fundo ?? cnpj).trim() || cnpj,
        });
      }
      return list;
    },
  });

  // Pré-seleciona o primeiro fundo quando a lista carrega
  useEffect(() => {
    if (!fundoCnpj && fundos.length > 0) {
      setFundoCnpj(fundos[0].cnpj);
    }
  }, [fundos, fundoCnpj]);

  // ── Query principal ──
  const dataAnaliseIso = dataAnalise.length === 8
    ? `${dataAnalise.slice(0, 4)}-${dataAnalise.slice(4, 6)}-${dataAnalise.slice(6, 8)}`
    : "";

  const {
    data: descasamentoData,
    isLoading: descasamentoLoading,
    isError: descasamentoError,
    refetch,
  } = useQuery({
    queryKey: ["descasamento-operacional", fundoCnpj, dataAnalise],
    enabled: !!fundoCnpj && !!dataAnalise,
    queryFn: async (): Promise<DescasamentoData> => {
      const { data, error } = await supabase.functions.invoke<{
        success: boolean;
        data?: DescasamentoData;
        error?: string;
      }>("buscar-descasamento-operacional", {
        body: { fundo_cnpj: fundoCnpj, data_analise: dataAnalise },
      });
      if (error) throw new Error((data as any)?.error || error);
      if (!data?.success || !data.data) throw new Error("Resposta inválida da edge function");
      return data.data;
    },
  });

  // ── Import ──
  // fundo_cnpj é enviado apenas como filtro opcional: se informado, importa só esse fundo.
  // Sem seleção, todos os fundos presentes na planilha são importados.
  const handleImport = async () => {
    if (!arquivo) return;

    setIsImporting(true);
    setImportResult(null);

    try {
      const formData = new FormData();
      formData.append("file", arquivo);
      // Envia CNPJ selecionado como filtro, se houver
      if (fundoCnpj) formData.append("fundo_cnpj", fundoCnpj);

      const { data, error } = await supabase.functions.invoke<ImportResult>(
        "import-caixa-fluxo-financeiro",
        { body: formData }
      );

      const result = data ?? { success: false, error: error?.message ?? "Resposta vazia" };
      setImportResult(result);

      if (result.success) {
        setArquivo(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        // Invalida queries de todos os fundos importados
        queryClient.invalidateQueries({ queryKey: ["descasamento-operacional"] });
        toast({
          title: "Importação concluída",
          description: result.message ?? `${result.inserted ?? 0} registro(s) importado(s).`,
        });
      } else {
        toast({
          title: "Erro na importação",
          description: result.error ?? "Não foi possível importar o arquivo.",
          variant: "destructive",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro desconhecido";
      setImportResult({ success: false, error: msg });
      toast({
        title: "Erro na importação",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setIsImporting(false);
    }
  };

  const porVertice = descasamentoData?.porVertice ?? [];
  const totais = descasamentoData?.totais ?? { saidaCotistas: 0, entradaPortfolio: 0, saldoLiquido: 0 };
  const linhasFluxo = descasamentoData?.linhasFluxo ?? [];

  const fundoNome = fundos.find((f) => f.cnpj === fundoCnpj)?.nome ?? fundoCnpj;

  return (
    <Layout>
      <div className="max-w-6xl mx-auto space-y-6 p-4">
        {/* ── Cabeçalho ── */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-md bg-primary/10 text-primary">
              <ArrowLeftRight className="w-4 h-4" />
            </div>
            <h1 className="text-xl font-bold">Descasamento Operacional</h1>
          </div>
          <p className="text-sm text-muted-foreground ml-9">
            Compara resgates de cotistas pendentes com resgates de portfólio já acionados, por vértice ANBIMA.
          </p>
        </div>

        {/* ── Filtros: Fundo + Data ── */}
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap gap-4 items-end">
              <div className="space-y-1 min-w-[260px] flex-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  Fundo
                </label>
                <Select value={fundoCnpj} onValueChange={setFundoCnpj}>
                  <SelectTrigger className="h-10 text-sm">
                    <SelectValue placeholder={fundosLoading ? "Carregando..." : "Selecione o fundo"} />
                  </SelectTrigger>
                  <SelectContent>
                    {fundos.map((f) => (
                      <SelectItem key={f.cnpj} value={f.cnpj} className="text-xs">
                        <span className="font-medium">{f.nome}</span>
                        <span className="ml-2 text-muted-foreground font-mono text-[10px]">{f.cnpj}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  Data de Análise
                </label>
                <input
                  type="date"
                  value={dataAnaliseIso}
                  onChange={(e) => setDataAnalise(e.target.value.replace(/-/g, ""))}
                  className="flex h-10 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                />
              </div>

              <Button
                variant="outline"
                size="sm"
                className="h-10 self-end"
                disabled={!fundoCnpj || descasamentoLoading}
                onClick={() => refetch()}
              >
                {descasamentoLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-1" />
                ) : null}
                Atualizar
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Card de Import ── */}
        <Card>
          <CardHeader className="py-3 px-4 bg-muted/30 border-b">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-md bg-primary/10 text-primary">
                <FileUp className="w-3.5 h-3.5" />
              </div>
              <CardTitle className="text-sm font-medium">
                Importar CaixaFluxoFinanceiro
              </CardTitle>
            </div>
            <CardDescription className="text-[10px] mt-1">
              Planilha CaixaFluxoFinanceiro do administrador. Suporta múltiplos fundos no mesmo arquivo —
              o CNPJ é lido da coluna <span className="font-semibold">"CNPJ da classe"</span> de cada linha.
              Apenas subtipo <span className="font-semibold">"Resgate do/de portfólio investido"</span> é importado.
              Selecione um fundo acima para filtrar a importação (opcional).
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 space-y-4">
            <div
              className={cn(
                "relative border-2 border-dashed rounded-lg p-6 transition-colors",
                "hover:border-primary/50 hover:bg-accent/30",
                "flex flex-col items-center justify-center gap-3 text-center",
                isImporting && "pointer-events-none opacity-50"
              )}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f?.name.toLowerCase().endsWith(".xlsx")) {
                  setArquivo(f);
                  setImportResult(null);
                } else {
                  toast({
                    title: "Arquivo inválido",
                    description: "Selecione um arquivo .xlsx do CaixaFluxoFinanceiro.",
                    variant: "destructive",
                  });
                }
              }}
              onDragOver={(e) => e.preventDefault()}
            >
              <Upload className="w-7 h-7 text-primary" />
              <div>
                <p className="text-sm font-medium">
                  {arquivo ? arquivo.name : "Arraste o XLSX aqui ou clique para selecionar"}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">CaixaFluxoFinanceiro*.xlsx</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={isImporting}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setArquivo(f);
                    setImportResult(null);
                  }
                }}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Button
                  onClick={handleImport}
                  disabled={!arquivo || isImporting}
                  className="h-9"
                >
                  {isImporting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      Importando...
                    </>
                  ) : (
                    <>
                      <FileUp className="w-4 h-4 mr-2" />
                      {fundoCnpj ? "Importar (filtrar por fundo)" : "Importar (todos os fundos)"}
                    </>
                  )}
                </Button>

                {importResult && !importResult.success && (
                  <div className="flex items-center gap-1.5 text-sm text-red-600">
                    <XCircle className="w-4 h-4" />
                    <span>{importResult.error}</span>
                  </div>
                )}
              </div>

              {/* Resultado de importação: resumo por fundo */}
              {importResult?.success && (
                <div className="rounded-md border bg-emerald-50 dark:bg-emerald-950/20 p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="w-4 h-4" />
                    {importResult.message ?? `${importResult.inserted ?? 0} registro(s) importado(s).`}
                  </div>
                  {importResult.porFundo && importResult.porFundo.length > 0 && (
                    <div className="space-y-1">
                      {importResult.porFundo.map((f) => (
                        <div key={f.cnpj} className="flex items-center gap-2 text-[11px] text-emerald-800 dark:text-emerald-300">
                          <span className="font-medium">{f.nome ?? f.cnpj}</span>
                          <span className="text-muted-foreground font-mono">{f.cnpj}</span>
                          <Badge variant="outline" className="text-[9px] h-4 bg-emerald-100 border-emerald-300">
                            {f.count} registo{f.count !== 1 ? "s" : ""}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ── Cards de Resumo ── */}
        {descasamentoLoading ? (
          <div className="flex items-center justify-center h-32 gap-3 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Calculando descasamento...</span>
          </div>
        ) : descasamentoError ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-10 gap-3">
              <AlertTriangle className="w-10 h-10 text-amber-500" />
              <p className="text-sm text-muted-foreground">
                Erro ao carregar dados. Selecione um fundo e tente novamente.
              </p>
            </CardContent>
          </Card>
        ) : descasamentoData ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <SummaryCard
                label="Saídas — Resgates de Cotistas"
                valor={totais.saidaCotistas}
                sub="soma dos resgates_movimentacoes no período"
                destaque="negativo"
              />
              <SummaryCard
                label="Entradas — Resgates de Portfólio"
                valor={totais.entradaPortfolio}
                sub="resgates de portfólio confirmados (fluxo financeiro)"
                destaque="positivo"
              />
              <SummaryCard
                label="Saldo Líquido Acumulado"
                valor={totais.saldoLiquido}
                sub="entradas − saídas (positivo = coberto)"
                destaque={totais.saldoLiquido >= 0 ? "positivo" : "negativo"}
              />
            </div>

            {/* ── Tabela Vértice a Vértice ── */}
            <Card>
              <CardHeader className="py-3 px-4 bg-muted/30 border-b">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-md bg-primary/10 text-primary">
                    <ArrowLeftRight className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-medium">
                      Descasamento por Vértice ANBIMA
                    </CardTitle>
                    <CardDescription className="text-[10px] mt-0.5">
                      {fundoNome} · a partir de {formatDate(dataAnaliseIso)}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {porVertice.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
                    <Info className="w-10 h-10 text-muted-foreground/40" />
                    <p className="text-sm font-medium text-muted-foreground">Nenhum dado para exibir</p>
                    <p className="text-[11px] text-muted-foreground max-w-xs">
                      Não há resgates de cotistas ou entradas de portfólio registrados
                      para este fundo a partir da data de análise selecionada.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="h-8 hover:bg-transparent bg-muted/20">
                        <TableHead className="text-[10px] font-bold uppercase">Vértice</TableHead>
                        <TableHead className="text-right text-[10px] font-bold uppercase">
                          <TooltipProvider delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex items-center gap-1 cursor-help">
                                  Saída Cotistas <Info className="w-3 h-3 text-muted-foreground" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-[220px] text-[11px]">
                                Soma dos resgates de cotistas (resgates_movimentacoes) com
                                data de impacto neste vértice.
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </TableHead>
                        <TableHead className="text-right text-[10px] font-bold uppercase">
                          <TooltipProvider delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex items-center gap-1 cursor-help">
                                  Entrada Portfólio <Info className="w-3 h-3 text-muted-foreground" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-[240px] text-[11px]">
                                Soma dos resgates de portfólio confirmados (CaixaFluxoFinanceiro,
                                subtipo "Resgate de portfólio investido") com liquidação neste vértice.
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </TableHead>
                        <TableHead className="text-right text-[10px] font-bold uppercase">Saldo Líquido</TableHead>
                        <TableHead className="text-[10px] font-bold uppercase text-center">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {porVertice.map((row) => (
                        <TableRow key={row.vertice} className="h-9 text-[11px]">
                          <TableCell className="font-mono font-bold">
                            {row.verticeLabel ?? verticeLabel(row.vertice)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-red-700">
                            {row.saidaCotistas > 0 ? formatBRL(row.saidaCotistas) : "—"}
                          </TableCell>
                          <TableCell className="text-right font-mono text-emerald-700">
                            {row.entradaPortfolio > 0 ? formatBRL(row.entradaPortfolio) : "—"}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right font-mono font-semibold",
                              row.saldoLiquido >= 0 ? "text-emerald-700" : "text-red-700"
                            )}
                          >
                            {formatBRL(row.saldoLiquido)}
                          </TableCell>
                          <TableCell className="text-center">
                            <SaldoBadge valor={row.saldoLiquido} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                    {/* Totais */}
                    <tfoot>
                      <TableRow className="h-9 text-[11px] font-bold border-t-2 bg-muted/20">
                        <TableCell className="font-bold">Total</TableCell>
                        <TableCell className="text-right font-mono text-red-700 font-bold">
                          {formatBRL(totais.saidaCotistas)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-emerald-700 font-bold">
                          {formatBRL(totais.entradaPortfolio)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right font-mono font-bold",
                            totais.saldoLiquido >= 0 ? "text-emerald-700" : "text-red-700"
                          )}
                        >
                          {formatBRL(totais.saldoLiquido)}
                        </TableCell>
                        <TableCell className="text-center">
                          <SaldoBadge valor={totais.saldoLiquido} />
                        </TableCell>
                      </TableRow>
                    </tfoot>
                  </Table>
                )}
              </CardContent>
            </Card>

            {/* ── Detalhe das entradas de portfólio ── */}
            {linhasFluxo.length > 0 && (
              <Collapsible open={detalheOpen} onOpenChange={setDetalheOpen}>
                <Card>
                  <CardHeader className="py-2 px-4 bg-muted/30 border-b">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-sm font-medium">
                          Detalhe — Entradas de Portfólio Confirmadas
                        </CardTitle>
                        <Badge variant="outline" className="text-[9px] h-4">
                          {linhasFluxo.length} linha{linhasFluxo.length !== 1 ? "s" : ""}
                        </Badge>
                      </div>
                      <CollapsibleTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                          {detalheOpen ? (
                            <ChevronUp className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          )}
                        </Button>
                      </CollapsibleTrigger>
                    </div>
                  </CardHeader>
                  <CollapsibleContent>
                    <CardContent className="p-0">
                      <Table>
                        <TableHeader>
                          <TableRow className="h-8 hover:bg-transparent bg-muted/20">
                            <TableHead className="text-[10px] font-bold uppercase">Data Liquidação</TableHead>
                            <TableHead className="text-[10px] font-bold uppercase">Subtipo</TableHead>
                            <TableHead className="text-right text-[10px] font-bold uppercase">Financeiro</TableHead>
                            <TableHead className="text-[10px] font-bold uppercase">Vértice</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {linhasFluxo.map((l, i) => (
                            <TableRow key={i} className="h-8 text-[11px]">
                              <TableCell className="font-mono">
                                {formatDate(l.data_liquidacao)}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {l.subtipo}
                              </TableCell>
                              <TableCell
                                className={cn(
                                  "text-right font-mono",
                                  l.financeiro >= 0 ? "text-emerald-700" : "text-red-700"
                                )}
                              >
                                {formatBRL(l.financeiro)}
                              </TableCell>
                              <TableCell className="font-mono text-muted-foreground">
                                {verticeLabel(l.vertice)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            )}
          </>
        ) : (
          // Estado inicial — fundo não selecionado ou sem dados ainda
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <ArrowLeftRight className="w-12 h-12 text-muted-foreground/30" />
              <p className="text-sm font-medium text-muted-foreground">
                Selecione um fundo e importe a planilha CaixaFluxoFinanceiro
              </p>
              <p className="text-[11px] text-muted-foreground max-w-sm">
                Após a importação, o sistema compara as saídas de cotistas com as entradas de
                portfólio confirmadas, exibindo o descasamento vértice a vértice.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
