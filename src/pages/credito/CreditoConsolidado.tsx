import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { Layout } from "@/components/Layout";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Download, Loader2, AlertTriangle, ShieldAlert, BadgeAlert, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  formatBRL,
  formatPct,
  formatDateBR,
  mapIndicadorRow,
  INDICADOR_EXTENDED_SELECT,
  INDICADOR_BASE_SELECT,
  INDICADOR_EXTENDED_COLUMNS,
  isMissingColumnError,
  type IndicadorCreditoExtended,
} from "@/lib/creditoIndicadores";

const getBucketColor = (bucket: string) => {
  switch (bucket) {
    case "Adimplente":
      return "bg-green-50/50 hover:bg-green-50";
    case "1-30":
      return "bg-yellow-50/50 hover:bg-yellow-50";
    case "31-60":
      return "bg-orange-50/50 hover:bg-orange-50";
    case "61-90":
      return "bg-red-50 hover:bg-red-100 border-l-4 border-red-500";
    case "91-180":
      return "bg-red-100/50 hover:bg-red-100 border-l-4 border-red-700";
    case "180+":
      return "bg-red-200/30 hover:bg-red-200 border-l-4 border-red-900";
    default:
      return "";
  }
};

type BucketResumo = {
  import_id: string;
  criado_em?: string;
  nome_fundo: string;
  doc_fundo: string | null;
  data_referencia: string;
  bucket_atraso: string;
  exposicao: number;
  pdd_atual: number;
  pdd_modelo: number;
  gap: number;
  cobertura: number;
  percentual_carteira: number;
};

const BUCKET_ORDER = ["Adimplente", "1-30", "31-60", "61-90", "91-180", "180+"];

export default function CreditoConsolidado() {
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedFund, setSelectedFund] = useState<string>("CONSOLIDADO");
  const [isCalculating, setIsCalculating] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Datas já calculadas
  const { data: calculatedDates = [] } = useQuery({
    queryKey: ["credito-resumo-dates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("credito_estoque_resumo_bucket")
        .select("data_referencia")
        .order("data_referencia", { ascending: false })
        .limit(5000);
      if (error) throw error;
      return Array.from(new Set((data || []).map((d) => d.data_referencia).filter(Boolean))) as string[];
    },
  });

  // Datas disponíveis em estoque_fidc (importadas mas talvez não calculadas)
  // Fallback silencioso: se a tabela ainda não existir no banco, retorna lista vazia
  const { data: estoqueImportDates = [] } = useQuery({
    queryKey: ["estoque-fidc-import-dates"],
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("importacoes_estoque_fidc")
          .select("reference_date")
          .in("status", ["success", "partial_success"])
          .order("reference_date", { ascending: false })
          .limit(500);
        if (error) return [] as string[];
        return Array.from(new Set((data || []).map((d) => d.reference_date).filter(Boolean))) as string[];
      } catch {
        return [] as string[];
      }
    },
  });

  // União das datas de ambas as fontes
  const availableDates = useMemo(() => {
    const set = new Set([...calculatedDates, ...estoqueImportDates]);
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [calculatedDates, estoqueImportDates]);

  const effectiveDate = selectedDate || availableDates[0] || "";

  const { data: resumo = [], isLoading: loadingResumo } = useQuery({
    queryKey: ["credito-resumo-bucket", effectiveDate],
    enabled: !!effectiveDate,
    queryFn: async () => {
      const extendedSelect =
        "import_id, criado_em, nome_fundo, doc_fundo, data_referencia, bucket_atraso, exposicao, pdd_atual, pdd_modelo, gap, cobertura, percentual_carteira";
      const baseSelect =
        "import_id, criado_em, nome_fundo, doc_fundo, data_referencia, bucket_atraso, exposicao, pdd_atual, pdd_modelo, gap, cobertura";

      const { data, error } = await supabase
        .from("credito_estoque_resumo_bucket")
        .select(extendedSelect)
        .eq("data_referencia", effectiveDate)
        .order("criado_em", { ascending: false })
        .order("nome_fundo", { ascending: true });

      if (error) {
        if (!isMissingColumnError(error, ["percentual_carteira"])) {
          throw error;
        }

        const fallback = await supabase
          .from("credito_estoque_resumo_bucket")
          .select(baseSelect)
          .eq("data_referencia", effectiveDate)
          .order("criado_em", { ascending: false })
          .order("nome_fundo", { ascending: true });

        if (fallback.error) throw fallback.error;
        return (fallback.data || []).map((r) => ({ ...r, percentual_carteira: 0 })) as BucketResumo[];
      }

      return (data || []) as BucketResumo[];
    },
  });

  const { data: indicadores = [] } = useQuery({
    queryKey: ["credito-consolidado-indicadores", effectiveDate],
    enabled: !!effectiveDate,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("credito_estoque_indicadores")
        .select(INDICADOR_EXTENDED_SELECT)
        .eq("data_referencia", effectiveDate)
        .order("criado_em", { ascending: false })
        .order("nome_fundo", { ascending: true });

      if (error) {
        if (!isMissingColumnError(error, [...INDICADOR_EXTENDED_COLUMNS])) {
          throw error;
        }

        const fallback = await supabase
          .from("credito_estoque_indicadores")
          .select(INDICADOR_BASE_SELECT)
          .eq("data_referencia", effectiveDate)
          .order("criado_em", { ascending: false })
          .order("nome_fundo", { ascending: true });

        if (fallback.error) throw fallback.error;
        return (fallback.data || []).map((r) => mapIndicadorRow(r as Record<string, unknown>));
      }

      return (data || []).map((r) => mapIndicadorRow(r as Record<string, unknown>));
    },
  });

  const fundos = useMemo(() => {
    const fromResumo = resumo.map((r) => r.nome_fundo);
    const unique = Array.from(new Set(fromResumo)).filter(Boolean).sort();
    if (!unique.includes("CONSOLIDADO")) unique.unshift("CONSOLIDADO");
    return unique;
  }, [resumo]);

  const selectedImportId = useMemo(() => {
    const byFund = indicadores.find((i) => i.nome_fundo === selectedFund)?.import_id;
    if (byFund) return byFund;
    return indicadores.find((i) => i.nome_fundo === "CONSOLIDADO")?.import_id ?? null;
  }, [indicadores, selectedFund]);

  const resumoFiltrado = useMemo(
    () =>
      resumo
        .filter((r) => r.nome_fundo === selectedFund && (!selectedImportId || r.import_id === selectedImportId))
        .sort((a, b) => BUCKET_ORDER.indexOf(a.bucket_atraso) - BUCKET_ORDER.indexOf(b.bucket_atraso)),
    [resumo, selectedFund, selectedImportId]
  );
  const indicadorAtual = useMemo(
    () => indicadores.find((i) => i.nome_fundo === selectedFund && (!selectedImportId || i.import_id === selectedImportId)) ?? null,
    [indicadores, selectedFund, selectedImportId]
  );

  const hasEstoqueForDate = effectiveDate ? estoqueImportDates.includes(effectiveDate) : false;
  const isDateCalculated = effectiveDate ? calculatedDates.includes(effectiveDate) : false;

  const handleCalcular = async () => {
    if (!effectiveDate) {
      toast({ title: "Selecione uma data antes de calcular.", variant: "destructive" });
      return;
    }
    if (!hasEstoqueForDate) {
      toast({
        title: "Sem dados de estoque",
        description: `Não há importação de estoque FIDC para ${formatDateBR(effectiveDate)}. Importe o arquivo primeiro.`,
        variant: "destructive",
      });
      return;
    }

    setIsCalculating(true);
    try {
      const { data, error } = await supabase.functions.invoke("calcular-credito", {
        body: { data_referencia: effectiveDate },
      });

      // A função sempre retorna HTTP 200; erros vêm em data.success = false
      if (error) throw new Error(error.message || "Falha ao invocar calcular-credito");
      if (!data?.success) throw new Error(data?.error || "Erro desconhecido no cálculo");

      toast({
        title: "Indicadores calculados com sucesso",
        description: `${data.fundos_calculados} fundo(s) processado(s) para ${formatDateBR(effectiveDate)}.`,
      });

      await queryClient.invalidateQueries({ queryKey: ["credito-resumo-bucket"] });
      await queryClient.invalidateQueries({ queryKey: ["credito-resumo-dates"] });
      await queryClient.invalidateQueries({ queryKey: ["credito-consolidado-indicadores"] });
      await queryClient.invalidateQueries({ queryKey: ["credito-indicadores"] });
      await queryClient.invalidateQueries({ queryKey: ["credito-indicadores-dates"] });
    } catch (err) {
      toast({
        title: "Erro no cálculo",
        description: err instanceof Error ? err.message : "Erro desconhecido",
        variant: "destructive",
      });
    } finally {
      setIsCalculating(false);
    }
  };

  const handleExportCsv = () => {
    if (resumoFiltrado.length === 0) return;
    const headerResumo = "nome_fundo;doc_fundo;data_referencia;bucket_atraso;exposicao;pdd_atual;pdd_modelo;gap;cobertura";
    const bodyResumo = resumoFiltrado
      .map((r) =>
        [r.nome_fundo, r.doc_fundo || "", r.data_referencia, r.bucket_atraso, r.exposicao, r.pdd_atual, r.pdd_modelo, r.gap, r.cobertura].join(";")
      )
      .join("\n");
    const headerIndic =
      "nome_fundo;doc_fundo;data_referencia;carteira_total;over90;over180;coverage_vencidos;gap_total;pdd_atual_total;pdd_modelo_total";
    const indic = indicadorAtual
      ? [
          indicadorAtual.nome_fundo,
          indicadorAtual.doc_fundo || "",
          indicadorAtual.data_referencia,
          indicadorAtual.carteira_total,
          indicadorAtual.over90,
          indicadorAtual.over180,
          indicadorAtual.coverage_vencidos,
          indicadorAtual.gap_total,
          indicadorAtual.pdd_atual_total,
          indicadorAtual.pdd_modelo_total,
        ].join(";")
      : "";
    const payload = ["[Resumo_por_faixa]", headerResumo, bodyResumo, "", "[Indicadores]", headerIndic, indic].join("\n");
    const blob = new Blob([payload], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aging_resumo_${selectedFund.toLowerCase().replace(/[^\w-]+/g, "_")}_${(effectiveDate || "sem_data").replace(/-/g, "")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportXlsx = () => {
    if (resumoFiltrado.length === 0) return;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumoFiltrado), "Resumo_por_faixa");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(indicadorAtual ? [indicadorAtual] : []), "Indicadores");
    XLSX.writeFile(
      wb,
      `aging_resumo_${selectedFund.toLowerCase().replace(/[^\w-]+/g, "_")}_${(effectiveDate || "sem_data").replace(/-/g, "")}.xlsx`
    );
  };

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight uppercase">Consolidado - Risco de Credito</h1>
            <p className="text-xs text-muted-foreground uppercase tracking-wide">
              Buckets canônicos · Coverage regulatório · Coverage NPL · Aderência PDD
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={effectiveDate} onValueChange={setSelectedDate}>
              <SelectTrigger className="w-[180px] h-8 text-xs">
                <SelectValue placeholder="Data-base" />
              </SelectTrigger>
              <SelectContent>
                {availableDates.map((d) => (
                  <SelectItem key={d} value={d}>
                    {formatDateBR(d)}
                    {!calculatedDates.includes(d) && (
                      <span className="ml-1 text-amber-500 text-[10px]">●</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant={isDateCalculated ? "outline" : "default"}
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={handleCalcular}
              disabled={isCalculating || !effectiveDate}
              title={
                !hasEstoqueForDate
                  ? "Nenhum estoque importado para esta data"
                  : isDateCalculated
                  ? "Recalcular indicadores para esta data"
                  : "Calcular indicadores para esta data"
              }
            >
              {isCalculating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              {isCalculating ? "Calculando..." : isDateCalculated ? "Recalcular" : "Calcular"}
            </Button>

            <Select value={selectedFund} onValueChange={setSelectedFund}>
              <SelectTrigger className="w-[320px] h-8 text-xs">
                <SelectValue placeholder="Fundo" />
              </SelectTrigger>
              <SelectContent>
                {fundos.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handleExportCsv} disabled={!resumoFiltrado.length}>
              <Download className="w-3.5 h-3.5 mr-1" /> CSV
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handleExportXlsx} disabled={!resumoFiltrado.length}>
              <Download className="w-3.5 h-3.5 mr-1" /> Excel
            </Button>
          </div>
        </div>

        {/* Aviso: data com estoque mas ainda não calculada */}
        {effectiveDate && hasEstoqueForDate && !isDateCalculated && (
          <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <span className="font-semibold">Estoque disponível</span> — os indicadores ainda não foram calculados para{" "}
            {formatDateBR(effectiveDate)}. Clique em <strong>Calcular</strong> para gerar o aging e PDD.
          </div>
        )}

        {indicadorAtual && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <Card className="bg-red-50 border-red-200">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-red-800">Risco Carteira (&gt;90 dias)</CardTitle>
                <AlertTriangle className="h-4 w-4 text-red-600" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-900">{formatPct(indicadorAtual.over90)}</div>
                <p className="text-xs text-red-600 mt-1">
                  {indicadorAtual.over90 > 0.1 ? "Acima do limite recomendado" : "Dentro do esperado"}
                </p>
              </CardContent>
            </Card>
            <Card className="bg-blue-50 border-blue-200">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-blue-800">Coverage Regulatório</CardTitle>
                <ShieldAlert className="h-4 w-4 text-blue-600" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-blue-900">{formatPct(indicadorAtual.coverage_vencidos)}</div>
                <p className="text-xs text-blue-600 mt-1">PDD ÷ carteira vencida</p>
              </CardContent>
            </Card>
            <Card className="bg-indigo-50 border-indigo-200">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-indigo-800">Coverage NPL</CardTitle>
                <ShieldAlert className="h-4 w-4 text-indigo-600" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-indigo-900">{formatPct(indicadorAtual.coverage_npl)}</div>
                <p className="text-xs text-indigo-600 mt-1">PDD ÷ Over90</p>
              </CardContent>
            </Card>
            <Card className="bg-amber-50 border-amber-200">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-amber-800">Aderência PDD</CardTitle>
                <BadgeAlert className="h-4 w-4 text-amber-600" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-amber-900">{formatPct(indicadorAtual.aderencia_pdd)}</div>
                <p className="text-xs text-amber-600 mt-1">PDD atual ÷ PDD modelo</p>
              </CardContent>
            </Card>
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">PL do Fundo</CardTitle></CardHeader>
            <CardContent className="text-lg font-bold">{formatBRL(indicadorAtual?.pl || 0)}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">PDD / PL</CardTitle></CardHeader>
            <CardContent className="text-lg font-bold">{formatPct(indicadorAtual?.pdd_sobre_pl || 0)}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Impacto Stress (PL)</CardTitle></CardHeader>
            <CardContent className="text-lg font-bold text-red-600">{formatPct(indicadorAtual?.impacto_stress_pl || 0)}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Gap Total</CardTitle></CardHeader>
            <CardContent className="text-lg font-bold">{formatBRL(indicadorAtual?.gap_total || 0)}</CardContent>
          </Card>
        </div>

        {loadingResumo ? (
          <div className="py-16 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow>
                  <TableHead>Bucket</TableHead>
                  <TableHead className="text-right">Exposição</TableHead>
                  <TableHead className="text-right">% Cart.</TableHead>
                  <TableHead className="text-right">PDD Atual</TableHead>
                  <TableHead className="text-right">PDD Modelo</TableHead>
                  <TableHead className="text-right">Gap</TableHead>
                  <TableHead className="text-right">Cobertura</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resumoFiltrado.map((r, idx) => {
                  const isCritical = ["61-90", "91-180", "180+"].includes(r.bucket_atraso);
                  const isHighRisk = r.bucket_atraso === "61-90";
                  
                  return (
                    <TableRow key={`${r.nome_fundo}-${r.bucket_atraso}-${idx}`} className={getBucketColor(r.bucket_atraso)}>
                      <TableCell className="font-medium flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${
                          r.bucket_atraso === "Adimplente" ? "bg-green-500" :
                          r.bucket_atraso === "1-30" ? "bg-yellow-500" :
                          r.bucket_atraso === "31-60" ? "bg-orange-500" :
                          "bg-red-600"
                        }`} />
                        {r.bucket_atraso}
                      </TableCell>
                      <TableCell className={`text-right ${isHighRisk ? "text-red-700 font-bold" : ""}`}>
                        {formatBRL(r.exposicao)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatPct(r.percentual_carteira)}
                      </TableCell>
                      <TableCell className="text-right">{formatBRL(r.pdd_atual)}</TableCell>
                      <TableCell className="text-right">{formatBRL(r.pdd_modelo)}</TableCell>
                      <TableCell className={`text-right ${r.gap > 0 ? "text-red-600 font-bold" : "text-green-600"}`}>
                        {formatBRL(r.gap)}
                      </TableCell>
                      <TableCell className={`text-right ${r.cobertura < 0.2 && isCritical ? "text-red-600 font-bold" : ""}`}>
                        {formatPct(r.cobertura)}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {resumoFiltrado.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                      Nenhum dado encontrado para o fundo/data selecionado.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Layout>
  );
}
