import { useState, useMemo, useRef, useEffect, Fragment } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { exportResgatesSolicitadosExcel } from "@/lib/exportFundoExcel";
import {
  Receipt,
  Loader2,
  Upload,
  RefreshCw,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  CalendarDays,
  TrendingDown,
  X,
  Download,
  Search,
} from "lucide-react";

// ─── Formatadores ─────────────────────────────────────────────────────────────

const formatBRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);

const formatDate = (s: string | null | undefined) => {
  if (!s) return "—";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
};

const toIsoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const toYyyymmdd = (iso: string) => iso.replace(/-/g, "");

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ResgateRow = {
  fundo: string;
  fundo_cnpj?: string | null;
  cotista: string;
  contato?: string | null;
  codigo_clt?: number | null;
  data_impacto: string;
  valor: number;
  tipo_movimento: string | null;
  dias_ate_pagamento: number | null;
};

type FundoAgrupado = {
  fundo: string;
  count: number;
  total: number;
  proximoVencimento: string | null;
  linhas: ResgateRow[];
};

// ─── Componente ───────────────────────────────────────────────────────────────

export default function LiquidezResgatesSolicitados() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [importStep, setImportStep] = useState<"idle" | "importing" | "done">("idle");
  const [exportStep, setExportStep] = useState<"idle" | "exporting" | "done">("idle");
  const [dataRefImport, setDataRefImport] = useState(""); // YYYYMMDD — para cálculo no import
  const [dataFiltro, setDataFiltro] = useState("");       // YYYY-MM-DD — filtro da visão gerencial
  const [fundoSelecionado, setFundoSelecionado] = useState<string | null>(null);
  const [busca, setBusca] = useState("");

  useEffect(() => {
    const today = new Date();
    const iso = toIsoDate(today);
    setDataFiltro(iso);
    setDataRefImport(toYyyymmdd(iso));
  }, []);

  // ── Import ──────────────────────────────────────────────────────────────────

  const handleImport = async (file: File) => {
    setImportStep("importing");
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (dataRefImport) formData.append("data_referencia", dataRefImport);

      const { data, error } = await supabase.functions.invoke<{
        success: boolean;
        recordsInserted?: number;
        message?: string;
        error?: string;
      }>("import-resgates-movimentacoes", { body: formData });

      if (error || !data?.success) throw new Error(data?.error || error?.message || "Erro na importação");

      toast({ title: "Resgates importados", description: data.message ?? `${data.recordsInserted ?? 0} registros.` });
      queryClient.invalidateQueries({ queryKey: ["resgates-movimentacoes"] });
      setImportStep("done");
      setTimeout(() => setImportStep("idle"), 2500);
    } catch (err) {
      toast({
        title: "Erro na importação",
        description: err instanceof Error ? err.message : "Erro desconhecido",
        variant: "destructive",
      });
      setImportStep("idle");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // ── Query ───────────────────────────────────────────────────────────────────

  const { data: rawData = [], isLoading } = useQuery({
    queryKey: ["resgates-movimentacoes"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("resgates_movimentacoes")
        .select("fundo, fundo_cnpj, cotista, contato, codigo_clt, data_impacto, valor, tipo_movimento, dias_ate_pagamento")
        .order("data_impacto", { ascending: true })
        .order("valor", { ascending: false });
      if (error) throw error;
      return (data || []) as ResgateRow[];
    },
  });

  // ── Linhas pela data ────────────────────────────────────────────────────────

  const linhasPorData = useMemo(() => {
    if (!dataFiltro) return rawData;
    return rawData.filter((r) => r.data_impacto >= dataFiltro);
  }, [rawData, dataFiltro]);

  const linhasVisiveis = useMemo(() => {
    const q = busca.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    if (!q) return linhasPorData;
    return linhasPorData.filter((r) => {
      const cnpj = String(r.fundo_cnpj ?? "").replace(/\D/g, "");
      return (
        (r.fundo || "").toLowerCase().includes(q) ||
        (r.cotista || "").toLowerCase().includes(q) ||
        (r.contato || "").toLowerCase().includes(q) ||
        String(r.codigo_clt ?? "").includes(q) ||
        (!!qDigits && cnpj.includes(qDigits))
      );
    });
  }, [linhasPorData, busca]);

  // ── Agrupamento por fundo (data + busca) ─────────────────────────────────────

  const porFundo = useMemo<FundoAgrupado[]>(() => {
    const map = new Map<string, FundoAgrupado>();
    for (const r of linhasVisiveis) {
      const key = r.fundo || "—";
      if (!map.has(key)) {
        map.set(key, { fundo: key, count: 0, total: 0, proximoVencimento: null, linhas: [] });
      }
      const entry = map.get(key)!;
      entry.count++;
      entry.total += r.valor ?? 0;
      entry.linhas.push(r);
      // Próximo vencimento = menor data_impacto do grupo
      if (!entry.proximoVencimento || r.data_impacto < entry.proximoVencimento) {
        entry.proximoVencimento = r.data_impacto;
      }
    }

    // Ordenar por total decrescente
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [linhasVisiveis]);

  useEffect(() => {
    if (fundoSelecionado && !porFundo.some((f) => f.fundo === fundoSelecionado)) {
      setFundoSelecionado(null);
    }
  }, [fundoSelecionado, porFundo]);

  const totalGeral = useMemo(() => porFundo.reduce((s, f) => s + f.total, 0), [porFundo]);
  const totalRegistros = useMemo(() => porFundo.reduce((s, f) => s + f.count, 0), [porFundo]);

  // Linhas de detalhe do fundo selecionado
  const linhasDetalhe = useMemo<ResgateRow[]>(() => {
    if (!fundoSelecionado) return [];
    return porFundo.find((f) => f.fundo === fundoSelecionado)?.linhas
      .slice()
      .sort((a, b) => a.data_impacto.localeCompare(b.data_impacto)) ?? [];
  }, [porFundo, fundoSelecionado]);

  // ── Helpers de data ─────────────────────────────────────────────────────────

  const dataFiltroIso = dataFiltro; // já em YYYY-MM-DD
  const isHoje = dataFiltro === toIsoDate(new Date());

  const voltarParaHoje = () => {
    const iso = toIsoDate(new Date());
    setDataFiltro(iso);
    setDataRefImport(toYyyymmdd(iso));
  };

  // ── Export ──────────────────────────────────────────────────────────────────

  const handleExport = async () => {
    if (porFundo.length === 0) {
      toast({ title: "Nenhum dado para exportar", variant: "destructive" });
      return;
    }

    setExportStep("exporting");
    try {
      await exportResgatesSolicitadosExcel({
        dataReferencia: formatDate(dataFiltro),
        totalResgates: totalGeral,
        totalMovimentacoes: totalRegistros,
        totalFundos: porFundo.length,
        proximoVencimento: formatDate(
          [...porFundo]
            .map((f) => f.proximoVencimento)
            .filter(Boolean)
            .sort()[0] ?? null
        ),
        porFundo: porFundo.map((f) => ({
          fundo: f.fundo,
          qtd: f.count,
          total: f.total,
          proximoVencimento: formatDate(f.proximoVencimento),
          linhas: f.linhas,
        })),
      });

      toast({ title: "Planilha exportada com sucesso!" });
      setExportStep("done");
      setTimeout(() => setExportStep("idle"), 2000);
    } catch (err) {
      toast({
        title: "Erro ao exportar",
        description: err instanceof Error ? err.message : "Erro desconhecido",
        variant: "destructive",
      });
      setExportStep("idle");
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Layout>
      <div className="max-w-5xl mx-auto space-y-5 p-4">

        {/* ── Cabeçalho ── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
              <Receipt className="w-5 h-5 text-blue-600 shrink-0" />
              Resgates Solicitados
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Visão gerencial por fundo — clique em um fundo para ver o detalhe.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImport(f); }}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleExport}
              disabled={exportStep !== "idle" || porFundo.length === 0}
              className="h-8 px-3 text-xs gap-1.5"
            >
              {exportStep === "idle"      && <><Download className="w-3.5 h-3.5" />Exportar</>}
              {exportStep === "exporting" && <><RefreshCw className="w-3.5 h-3.5 animate-spin" />Exportando...</>}
              {exportStep === "done"      && <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />Concluído ✓</>}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={importStep !== "idle"}
              className="h-8 px-3 text-xs gap-1.5"
            >
              {importStep === "idle"      && <><Upload className="w-3.5 h-3.5" />Importar</>}
              {importStep === "importing" && <><RefreshCw className="w-3.5 h-3.5 animate-spin" />Importando...</>}
              {importStep === "done"      && <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />Concluído ✓</>}
            </Button>
          </div>
        </div>

        {/* ── Controles de filtro ── */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="text-sm text-muted-foreground">A partir de:</span>
              <input
                type="date"
                value={dataFiltroIso}
                onChange={(e) => {
                  setDataFiltro(e.target.value);
                  setDataRefImport(toYyyymmdd(e.target.value));
                }}
                className="h-8 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm"
              />
            </div>
            {!isHoje && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1" onClick={voltarParaHoje}>
                <X className="w-3 h-3" /> Voltar para hoje
              </Button>
            )}
            {!isLoading && porFundo.length > 0 && (
              <span className="text-xs text-muted-foreground ml-auto">
                {totalRegistros} resgate{totalRegistros !== 1 ? "s" : ""} em {porFundo.length} fundo{porFundo.length !== 1 ? "s" : ""}
                {!isHoje && <span className="text-amber-600 font-medium"> · visão histórica</span>}
              </span>
            )}
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Buscar por fundo, cotista ou Cód. Clt..."
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                className="pl-9 h-8 text-xs"
              />
            </div>
          </div>
        </div>

        {/* ── Cards de resumo ── */}
        {!isLoading && porFundo.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">
                  Total de Resgates
                </p>
                <p className="text-2xl font-bold font-mono tabular-nums text-red-600">
                  {formatBRL(totalGeral)}
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  soma de {totalRegistros} movimentação{totalRegistros !== 1 ? "ões" : ""}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">
                  Fundos com Resgate
                </p>
                <p className="text-2xl font-bold font-mono tabular-nums">
                  {porFundo.length}
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {isHoje ? "a partir de hoje" : `a partir de ${formatDate(dataFiltro)}`}
                </p>
              </CardContent>
            </Card>
            <Card className="hidden sm:block">
              <CardContent className="p-4">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">
                  Próximo Vencimento
                </p>
                <p className="text-2xl font-bold font-mono tabular-nums">
                  {formatDate(
                    [...porFundo]
                      .map((f) => f.proximoVencimento)
                      .filter(Boolean)
                      .sort()[0] ?? null
                  )}
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  data de impacto mais próxima
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Tabela mestre: por fundo ── */}
        <Card>
          <CardHeader className="py-3 px-4 bg-muted/30 border-b">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingDown className="w-3.5 h-3.5 text-red-500" />
              Resgates por Fundo
              {!isHoje && (
                <Badge variant="outline" className="text-[9px] h-4 text-amber-700 border-amber-300 bg-amber-50">
                  Visão histórica
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-14 gap-2 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span className="text-sm">Carregando...</span>
              </div>
            ) : porFundo.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-14 gap-2 text-center px-4">
                <Receipt className="w-10 h-10 text-muted-foreground/30" />
                {busca.trim() && linhasPorData.length > 0 ? (
                  <>
                    <p className="text-sm text-muted-foreground font-medium">
                      Nenhum resultado para{" "}
                      <span className="text-foreground font-semibold">{busca.trim()}</span>
                    </p>
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setBusca("")}>
                      Limpar busca
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground font-medium">
                      Nenhum resgate a partir de {formatDate(dataFiltro)}
                    </p>
                    {!isHoje && (
                      <Button variant="outline" size="sm" className="mt-1 h-7 text-xs" onClick={voltarParaHoje}>
                        Voltar para hoje
                      </Button>
                    )}
                  </>
                )}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="h-8 hover:bg-transparent bg-muted/20">
                    <TableHead className="text-[10px] font-bold uppercase w-6" />
                    <TableHead className="text-[10px] font-bold uppercase">Fundo</TableHead>
                    <TableHead className="text-right text-[10px] font-bold uppercase">Qtd</TableHead>
                    <TableHead className="text-right text-[10px] font-bold uppercase">Total</TableHead>
                    <TableHead className="text-right text-[10px] font-bold uppercase">Próx. Venc.</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {porFundo.map((f) => {
                    const selecionado = fundoSelecionado === f.fundo;
                    return (
                      <Fragment key={f.fundo}>
                        <TableRow
                          className={cn(
                            "h-10 cursor-pointer text-[12px] transition-colors",
                            selecionado
                              ? "bg-blue-50/60 dark:bg-blue-950/20"
                              : "hover:bg-muted/40"
                          )}
                          onClick={() => setFundoSelecionado(selecionado ? null : f.fundo)}
                        >
                          <TableCell className="pl-4 pr-1 w-6">
                            {selecionado
                              ? <ChevronDown className="w-3.5 h-3.5 text-blue-600" />
                              : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
                          </TableCell>
                          <TableCell className="font-medium">{f.fundo}</TableCell>
                          <TableCell className="text-right font-mono text-muted-foreground">
                            {f.count}
                          </TableCell>
                          <TableCell className="text-right font-mono font-semibold text-red-700">
                            {formatBRL(f.total)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-muted-foreground">
                            {formatDate(f.proximoVencimento)}
                          </TableCell>
                        </TableRow>

                        {/* ── Detalhe expandido ── */}
                        {selecionado && (
                          <TableRow key={`${f.fundo}-detail`} className="hover:bg-transparent">
                            <TableCell colSpan={7} className="p-0 border-b">
                              <div className="bg-muted/20 border-t border-blue-100 dark:border-blue-900/30">
                                {/* Sub-cabeçalho */}
                                <div className="flex items-center gap-2 px-4 py-2 border-b border-blue-100 dark:border-blue-900/30">
                                  <span className="text-[10px] font-bold uppercase tracking-wide text-blue-700 dark:text-blue-400">
                                    {f.fundo} — {f.count} resgate{f.count !== 1 ? "s" : ""}
                                  </span>
                                  <span className="text-[10px] text-muted-foreground">
                                    · total {formatBRL(f.total)}
                                  </span>
                                </div>

                                {/* Tabela de detalhe */}
                                <Table>
                                  <TableHeader>
                                    <TableRow className="h-7 hover:bg-transparent">
                                      <TableHead className="pl-8 text-[9px] font-bold uppercase text-muted-foreground">Cotista</TableHead>
                                      <TableHead className="text-[9px] font-bold uppercase text-muted-foreground">Cód. Clt.</TableHead>
                                      <TableHead className="text-[9px] font-bold uppercase text-muted-foreground">Contato</TableHead>
                                      <TableHead className="text-right text-[9px] font-bold uppercase text-muted-foreground">Data Impacto</TableHead>
                                      <TableHead className="text-right text-[9px] font-bold uppercase text-muted-foreground">Valor</TableHead>
                                      <TableHead className="text-[9px] font-bold uppercase text-muted-foreground">Tipo</TableHead>
                                      <TableHead className="text-right text-[9px] font-bold uppercase text-muted-foreground">Dias</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {linhasDetalhe.map((l, i) => (
                                      <TableRow key={i} className="h-8 text-[11px] hover:bg-muted/30">
                                        <TableCell className="pl-8 text-muted-foreground">{l.cotista || "—"}</TableCell>
                                        <TableCell className="font-mono text-muted-foreground text-[10px]">
                                          {l.codigo_clt != null ? l.codigo_clt : "—"}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground text-[10px]">
                                          {l.contato || "—"}
                                        </TableCell>
                                        <TableCell className="text-right font-mono">{formatDate(l.data_impacto)}</TableCell>
                                        <TableCell className="text-right font-mono font-medium text-red-700">
                                          {formatBRL(l.valor)}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground text-[10px]">
                                          {l.tipo_movimento || "—"}
                                        </TableCell>
                                        <TableCell className="text-right font-mono text-muted-foreground">
                                          {l.dias_ate_pagamento != null ? `D+${l.dias_ate_pagamento}` : "—"}
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>

                {/* Rodapé com total geral */}
                <tfoot>
                  <TableRow className="h-9 text-[11px] font-bold border-t-2 bg-muted/20">
                    <TableCell />
                    <TableCell className="font-bold text-muted-foreground">Total</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">{totalRegistros}</TableCell>
                    <TableCell className="text-right font-mono text-red-700">{formatBRL(totalGeral)}</TableCell>
                    <TableCell />
                  </TableRow>
                </tfoot>
              </Table>
            )}
          </CardContent>
        </Card>

      </div>
    </Layout>
  );
}
