/**
 * Monitoramento de Risco de Crédito — Tela unificada com 4 abas matriciais.
 * Substitui: CreditoDashboard, CreditoMonitoramento, CreditoConsolidado, CreditoSafras.
 */
import { useMemo, useState } from "react";
import { Layout } from "@/components/Layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import {
  useCreditoMatrizDatas,
  useCreditoMatrizFundos,
  useCreditoMatrizVisaoGeral,
  useCreditoMatrizFundoResumo,
  useCreditoMatrizPrazo,
  useCreditoMatrizCoberturaPdd,
  useCreditoMatrizConcentracao,
  useCreditoMatrizConcentracaoPartes,
  useCreditoMatrizEnquadramento,
  useCreditoMatrizSafras,
  useCreditoMatrizSafrasMetricas,
  useCreditoScoreAlertas,
  useCalcularCredito,
} from "@/hooks/useCreditoMatrizData";
import { anualizarTaxaPctPoints, formatDateBR } from "@/lib/creditoMatriz";
import { VisaoGeralTab } from "./tabs/VisaoGeralTab";
import { AtrasoPddTab } from "./tabs/AtrasoPddTab";
import { SafraTab } from "./tabs/SafraTab";
import { SaudeFidcTab } from "./tabs/SaudeFidcTab";
import { FundoEnquadramentoTab } from "./tabs/FundoEnquadramentoTab";
import { ExportPddButton } from "@/components/credito/matriz/ExportPddButton";

const FUND_TODOS = "TODOS";

export default function CreditoMatriz() {
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedFund, setSelectedFund] = useState<string>(FUND_TODOS);
  const [activeTab, setActiveTab] = useState("visao-geral");

  // ─── Datas e fundos ─────────────────────────────────────────────────────
  const { data: datas = [], isLoading: loadingDatas } = useCreditoMatrizDatas();
  const effectiveDate = selectedDate || datas[0] || "";

  const { data: fundos = [] } = useCreditoMatrizFundos(effectiveDate);
  const effectiveFund = selectedFund;

  // ─── Visão Geral ─────────────────────────────────────────────────────────
  const { data: visaoGeralRows = [], isLoading: loadingVg, error: errorVg } =
    useCreditoMatrizVisaoGeral(effectiveFund, effectiveDate);

  const visaoGeral = useMemo(() => {
    if (visaoGeralRows.length === 0) return null;
    if (effectiveFund === FUND_TODOS) {
      // Agrega todos os fundos
      const agg = visaoGeralRows.reduce((acc, cur) => ({
        ...acc,
        vp_total: acc.vp_total + cur.vp_total,
        pdd_total: acc.pdd_total + cur.pdd_total,
        vp_a_vencer: acc.vp_a_vencer + cur.vp_a_vencer,
        qtd_a_vencer: acc.qtd_a_vencer + cur.qtd_a_vencer,
        vp_vencido: acc.vp_vencido + cur.vp_vencido,
        qtd_vencido: acc.qtd_vencido + cur.qtd_vencido,
        vp_writeoff: acc.vp_writeoff + cur.vp_writeoff,
        qtd_writeoff: acc.qtd_writeoff + cur.qtd_writeoff,
        vp_comp_adimplente: (acc.vp_comp_adimplente ?? 0) + (cur.vp_comp_adimplente ?? cur.vp_a_vencer ?? 0),
        vp_comp_vencido_ate_90: (acc.vp_comp_vencido_ate_90 ?? 0) + (cur.vp_comp_vencido_ate_90 ?? 0),
        vp_comp_vencido_91_180: (acc.vp_comp_vencido_91_180 ?? 0) + (cur.vp_comp_vencido_91_180 ?? 0),
        vp_over90: acc.vp_over90 + cur.vp_over90,
        vp_vence_esta_semana: acc.vp_vence_esta_semana + cur.vp_vence_esta_semana,
        vp_vence_este_mes: acc.vp_vence_este_mes + cur.vp_vence_este_mes,
        vp_vence_proximo_mes: acc.vp_vence_proximo_mes + cur.vp_vence_proximo_mes,
        vp_vence_3_meses: acc.vp_vence_3_meses + cur.vp_vence_3_meses,
        vp_vence_6_meses: acc.vp_vence_6_meses + cur.vp_vence_6_meses,
        vp_vence_acima_6_meses: (acc.vp_vence_acima_6_meses ?? 0) + (cur.vp_vence_acima_6_meses ?? 0),
        qtd_vence_esta_semana: acc.qtd_vence_esta_semana + cur.qtd_vence_esta_semana,
        qtd_vence_este_mes: acc.qtd_vence_este_mes + cur.qtd_vence_este_mes,
        qtd_vence_proximo_mes: acc.qtd_vence_proximo_mes + cur.qtd_vence_proximo_mes,
        qtd_vence_3_meses: acc.qtd_vence_3_meses + cur.qtd_vence_3_meses,
        qtd_vence_6_meses: acc.qtd_vence_6_meses + cur.qtd_vence_6_meses,
        qtd_vence_acima_6_meses: (acc.qtd_vence_acima_6_meses ?? 0) + (cur.qtd_vence_acima_6_meses ?? 0),
        pct_vencido: 0, pct_over90: 0, pct_pdd_carteira: 0, // recalc abaixo
      }));
      const total = agg.vp_total;
      agg.pct_vencido = total > 0 ? agg.vp_vencido / total : 0;
      agg.pct_over90 = total > 0 ? agg.vp_over90 / total : 0;
      agg.pct_pdd_carteira = total > 0 ? agg.pdd_total / total : 0;
      return agg;
    }
    return visaoGeralRows[0] ?? null;
  }, [visaoGeralRows, effectiveFund]);

  const { data: fundosResumoRows = [], isLoading: loadingFundosResumo, error: errorFundosResumo } =
    useCreditoMatrizFundoResumo(effectiveFund, effectiveDate);

  const fundoResumo = useMemo(() => {
    if (fundosResumoRows.length === 0) return null;
    if (effectiveFund !== FUND_TODOS) return fundosResumoRows[0] ?? null;

    const plTotal = fundosResumoRows.reduce((sum, row) => sum + (row.pl_total ?? 0), 0);
    return {
      ...fundosResumoRows[0],
      nome_fundo: "Consolidado",
      qtd_classes: fundosResumoRows.reduce((sum, row) => sum + row.qtd_classes, 0),
      pl_total: plTotal || null,
      rentabilidade_dia_pct: null,
      rentabilidade_mes_pct: null,
      rentabilidade_ano_pct: null,
      rentabilidade_12m_pct: null,
    };
  }, [fundosResumoRows, effectiveFund]);

  // ─── Atraso & PDD ────────────────────────────────────────────────────────
  const { data: matrizRows = [], isLoading: loadingMatriz, error: errorMatriz } =
    useCreditoMatrizPrazo(effectiveFund, effectiveDate);
  const { data: coberturaRows = [], isLoading: loadingCobertura, error: errorCobertura } =
    useCreditoMatrizCoberturaPdd(effectiveFund, effectiveDate);

  // ─── Concentração (Visão Geral) ─────────────────────────────────────────
  const { data: concentracaoRows = [], isLoading: loadingConc, error: errorConc } =
    useCreditoMatrizConcentracao(effectiveFund, effectiveDate);
  const { data: concentracaoPartes = [], isLoading: loadingConcPartes, error: errorConcPartes } =
    useCreditoMatrizConcentracaoPartes(effectiveFund, effectiveDate);
  const { data: enquadramentoRows = [], isLoading: loadingEnquadramento, error: errorEnquadramento } =
    useCreditoMatrizEnquadramento(effectiveFund, effectiveDate);

  // ─── Safras ──────────────────────────────────────────────────────────────
  const { data: safras = [], isLoading: loadingSafras, error: errorSafras } =
    useCreditoMatrizSafras(effectiveFund, effectiveDate);
  const { data: metricasSafra = [], isLoading: loadingMetricas } =
    useCreditoMatrizSafrasMetricas(effectiveFund, effectiveDate);

  const metricasAgregadas = useMemo(() => {
    if (metricasSafra.length === 0) return null;
    if (effectiveFund !== FUND_TODOS) return metricasSafra[0] ?? null;
    // Média ponderada por VP para TODOS
    const totalVp = metricasSafra.reduce((s, r) => s + r.vp_total, 0);
    const totalVpComTaxa = metricasSafra.reduce((s, r) => s + (r.vp_com_taxa ?? r.vp_total), 0);
    if (totalVp === 0) return null;
    const prazo_rec = metricasSafra.reduce((s, r) => s + (r.prazo_medio_recebimento_dias ?? 0) * r.vp_total, 0) / totalVp;
    const taxa_m = totalVpComTaxa > 0
      ? metricasSafra.reduce((s, r) => s + (r.taxa_media_mensal ?? 0) * (r.vp_com_taxa ?? r.vp_total), 0) / totalVpComTaxa
      : null;
    return {
      ...metricasSafra[0],
      prazo_medio_recebimento_dias: prazo_rec,
      taxa_media_mensal: taxa_m,
      taxa_media_anualizada: taxa_m != null ? anualizarTaxaPctPoints(taxa_m) : null,
      vp_total: totalVp,
      vp_com_taxa: totalVpComTaxa,
    };
  }, [metricasSafra, effectiveFund]);

  // ─── Saúde do FIDC ───────────────────────────────────────────────────────
  const { score, alertas, concentracao: concOver90, isLoading: loadingScore, error: errorScore } =
    useCreditoScoreAlertas(effectiveFund, effectiveDate);

  // ─── Calcular ─────────────────────────────────────────────────────────────
  const calcular = useCalcularCredito();

  const handleCalcular = () => {
    if (!effectiveDate) return;
    calcular.mutate({
      data_referencia: effectiveDate,
      doc_fundo: effectiveFund !== FUND_TODOS ? effectiveFund : undefined,
    });
  };

  // ─── Verificação de estado vazio ─────────────────────────────────────────
  const semDados = !loadingDatas && datas.length === 0;

  return (
    <Layout>
      <div className="p-4 md:p-6 space-y-4">
        {/* ── Header ────────────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1">
            <h1 className="text-xl font-bold">Monitoramento de Risco de Crédito</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Visão unificada do estoque FIDC — atraso, PDD, safras e saúde do fundo
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Seletor de data */}
            <Select
              value={effectiveDate}
              onValueChange={setSelectedDate}
              disabled={loadingDatas}
            >
              <SelectTrigger className="w-[160px] h-9 text-sm">
                <SelectValue placeholder={loadingDatas ? "Carregando…" : "Data-base"} />
              </SelectTrigger>
              <SelectContent>
                {datas.map((d) => (
                  <SelectItem key={d} value={d}>
                    {formatDateBR(d)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Seletor de fundo */}
            <Select value={selectedFund} onValueChange={setSelectedFund}>
              <SelectTrigger className="w-[200px] h-9 text-sm">
                <SelectValue placeholder="Todos os fundos" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FUND_TODOS}>Todos os fundos</SelectItem>
                {fundos.map((f) => (
                  <SelectItem key={f.fund_document} value={f.fund_document}>
                    {f.fund_name ?? f.fund_document}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <ExportPddButton
              fund={effectiveFund}
              date={effectiveDate}
              disabled={loadingDatas || loadingVg || !!errorVg || !visaoGeralRows.length || calcular.isPending}
            />

            {/* Calcular */}
            <Button
              size="sm"
              variant="outline"
              onClick={handleCalcular}
              disabled={calcular.isPending || !effectiveDate}
            >
              {calcular.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              )}
              {calcular.isPending ? "Calculando…" : "Calcular"}
            </Button>
          </div>
        </div>

        {/* ── Estado vazio global ───────────────────────────────────────────── */}
        {semDados && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Nenhum estoque FIDC importado. Acesse Estoque FIDC para importar o arquivo CSV do Frontis.
            </AlertDescription>
          </Alert>
        )}

        {/* ── Abas ──────────────────────────────────────────────────────────── */}
        {!semDados && (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="h-9">
              <TabsTrigger value="visao-geral" className="text-xs">Visão Geral</TabsTrigger>
              <TabsTrigger value="fundo-enquadramento" className="text-xs">Fundo & Enquadramento</TabsTrigger>
              <TabsTrigger value="atraso-pdd" className="text-xs">Atraso & PDD</TabsTrigger>
              <TabsTrigger value="safra" className="text-xs">Safra</TabsTrigger>
              <TabsTrigger value="saude-fidc" className="text-xs">Saúde do FIDC</TabsTrigger>
            </TabsList>

            <TabsContent value="visao-geral" className="mt-4">
              <VisaoGeralTab
                key={`${effectiveFund}:${effectiveDate}`}
                fund={effectiveFund}
                date={effectiveDate}
                visaoGeral={visaoGeral}
                concentracao={concentracaoRows}
                plTotal={fundoResumo?.pl_total ?? null}
                isLoadingVg={loadingVg}
                isLoadingConc={loadingConc}
                isLoadingPl={loadingFundosResumo}
                errorVg={errorVg as Error | null}
                errorConc={errorConc as Error | null}
              />
            </TabsContent>

            <TabsContent value="fundo-enquadramento" className="mt-4">
              <FundoEnquadramentoTab
                resumo={fundoResumo}
                concentracoes={concentracaoPartes}
                enquadramentos={enquadramentoRows}
                isLoadingResumo={loadingFundosResumo}
                isLoadingConcentracoes={loadingConcPartes}
                isLoadingEnquadramento={loadingEnquadramento}
                errorResumo={errorFundosResumo as Error | null}
                errorConcentracoes={errorConcPartes as Error | null}
                errorEnquadramento={errorEnquadramento as Error | null}
              />
            </TabsContent>

            <TabsContent value="atraso-pdd" className="mt-4">
              <AtrasoPddTab
                matrizRows={matrizRows}
                coberturaRows={coberturaRows}
                isLoadingMatriz={loadingMatriz}
                isLoadingCobertura={loadingCobertura}
                errorMatriz={errorMatriz as Error | null}
                errorCobertura={errorCobertura as Error | null}
              />
            </TabsContent>

            <TabsContent value="safra" className="mt-4">
              <SafraTab
                safras={safras}
                metricas={metricasAgregadas}
                isLoadingSafras={loadingSafras}
                isLoadingMetricas={loadingMetricas}
                errorSafras={errorSafras as Error | null}
              />
            </TabsContent>

            <TabsContent value="saude-fidc" className="mt-4">
              <SaudeFidcTab
                score={score}
                alertas={alertas}
                concentracao={concOver90}
                isLoadingScore={loadingScore}
                fund={effectiveFund}
                visaoGeral={visaoGeral}
                isLoadingVg={loadingVg}
                taxaMediaMensal={metricasAgregadas?.taxa_media_mensal}
              />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </Layout>
  );
}
