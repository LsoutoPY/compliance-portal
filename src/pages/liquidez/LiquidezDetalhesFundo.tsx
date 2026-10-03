import { useState } from "react";
import { useParams, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { ArrowLeft, FileDown, FileSpreadsheet, Loader2, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Mail } from "lucide-react";
import { LiquidezFundDetailContent, type ExportHandlers } from "@/components/liquidez/LiquidezFundDetailContent";
import { format, parse } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import { cn, liquidezNotificacaoHabilitada } from "@/lib/utils";
import { normalizeCnpj14, normalizeIsinLiquidez } from "@/lib/liquidezFundosCaracteristicas";

async function extractFunctionError(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response })?.context;
  if (ctx) {
    try {
      const body = (await ctx.json()) as { details?: string; error?: string };
      return body.details ?? body.error ?? String(error);
    } catch {
      /* ignore */
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export default function LiquidezDetalhesFundo() {
  const { cnpj, date } = useParams();
  const [searchParams] = useSearchParams();
  const isinParam = searchParams.get("isin") || null;
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [exportHandlers, setExportHandlers] = useState<ExportHandlers | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);
  const [recalculando, setRecalculando] = useState(false);
  const [isNotifying, setIsNotifying] = useState(false);
  const [liquidezStatus, setLiquidezStatus] = useState<"ok" | "alerta" | "violacao" | null>(null);

  const { data: fundInfo, isFetched: fundInfoFetched } = useQuery({
    queryKey: ["liquidez-fund-info", cnpj, date, isinParam],
    enabled: !!cnpj && !!date,
    queryFn: async () => {
      let q = supabase
        .from("posicao_carteira")
        .select("nome_fundo, fundo_nomeadm, fundo_patliq, fundo_valorativos, fundo_valorreceber, fundo_valorpagar, fundo_isin")
        .eq("fundo_cnpj", cnpj)
        .eq("fundo_dtposicao", date);
      if (isinParam) q = q.eq("fundo_isin", isinParam);
      const { data } = await q.limit(1).maybeSingle();
      return data as {
        nome_fundo: string;
        fundo_nomeadm: string;
        fundo_patliq: number;
        fundo_valorativos: number | null;
        fundo_valorreceber: number | null;
        fundo_valorpagar: number | null;
        fundo_isin: string | null;
      } | null;
    },
  });

  const { data: csvFundInfo } = useQuery({
    queryKey: ["liquidez-csv-pl", cnpj, date],
    enabled: !!cnpj && !!date,
    retry: false,
    queryFn: async () => {
      try {
        const cnpj8 = cnpj.replace(/\D/g, "").substring(0, 8);
        const dateIso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

        // Preferência: PATLIQ do CSV = valor_total_ativo - valor_a_pagar
        const { data: dataWithPagar, error: errorWithPagar } = await (supabase as any)
          .from("carteira_finvest_raw")
          .select("valor_total_ativo, valor_a_pagar")
          .eq("fundo_cnpj", cnpj8)
          .eq("data_posicao", dateIso)
          .not("valor_total_ativo", "is", null)
          .limit(1)
          .maybeSingle();

        if (!errorWithPagar && dataWithPagar) {
          const ativo = Number(dataWithPagar.valor_total_ativo ?? 0) || 0;
          const pagar = Number(dataWithPagar.valor_a_pagar ?? 0) || 0;
          return { valor_total_ativo: ativo - pagar };
        }

        // Fallback compatível com ambientes sem coluna valor_a_pagar
        const { data, error } = await (supabase as any)
          .from("carteira_finvest_raw")
          .select("valor_total_ativo")
          .eq("fundo_cnpj", cnpj8)
          .eq("data_posicao", dateIso)
          .not("valor_total_ativo", "is", null)
          .limit(1)
          .maybeSingle();

        if (error) return null;
        return data as { valor_total_ativo: number } | null;
      } catch {
        return null;
      }
    },
  });

  const fundoIsinHeader = normalizeIsinLiquidez(isinParam ?? fundInfo?.fundo_isin ?? null);

  const { data: characteristics } = useQuery({
    queryKey: ["fund-characteristics", cnpj, fundoIsinHeader],
    enabled: !!cnpj && !!date && fundInfoFetched,
    queryFn: async () => {
      const cnpj14 = normalizeCnpj14(cnpj ?? "");
      const estruturaOr = "estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo";

      const fcSelect = "aberto_estatutariamente, nivel1_categoria, cnpj_classe, cnpj_fundo, isin, pl_formula";

      if (fundoIsinHeader && cnpj14) {
        const { data: byIsin } = await supabase
          .from("fundos_caracteristicas")
          .select(fcSelect)
          .eq("isin", fundoIsinHeader)
          .maybeSingle();

        if (byIsin) {
          const nc = normalizeCnpj14((byIsin as any).cnpj_classe);
          const nf = normalizeCnpj14((byIsin as any).cnpj_fundo);
          if (nc === cnpj14 || nf === cnpj14) return byIsin;
        }
      }

      const { data: d1 } = await supabase
        .from("fundos_caracteristicas")
        .select(fcSelect)
        .eq("cnpj_classe", cnpj as string)
        .or(estruturaOr)
        .limit(1)
        .maybeSingle();

      if (d1) return d1;

      const { data: d2 } = await supabase
        .from("fundos_caracteristicas")
        .select(fcSelect)
        .eq("cnpj_fundo", cnpj as string)
        .or(estruturaOr)
        .limit(1)
        .maybeSingle();

      return d2;
    },
  });

  if (!cnpj || !date) {
    return <div>Parâmetros inválidos</div>;
  }

  const dateObj = parse(date, "yyyyMMdd", new Date());
  const dateFormatted = format(dateObj, "dd/MM/yyyy");
  const nomeFundo = fundInfo?.nome_fundo?.trim() || "Fundo";
  const cnpjFormatado = cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

  // Infere a classe ANBIMA correta para a Matriz de Probabilidade.
  // FIDC / FICFIDC → "Renda Fixa Crédito"; demais → "Multimercados".
  const nivel1Categoria = (characteristics as any)?.nivel1_categoria ?? null;
  const initialClasse = (
    String(nivel1Categoria ?? "").toUpperCase().includes("FIDC") ||
    nomeFundo.toUpperCase().includes("FIDC")
  ) ? "Renda Fixa Crédito" : "Multimercados";

  const isFidc = (
    String(nivel1Categoria ?? "").toUpperCase().includes("FIDC") ||
    nomeFundo.toUpperCase().includes("FIDC")
  );
  const plFormula = (characteristics as any)?.pl_formula ?? null;
  const plHeaderXml = fundInfo?.fundo_patliq || 0;
  const va = fundInfo?.fundo_valorativos || 0;
  const vr = fundInfo?.fundo_valorreceber || 0;
  const vp = fundInfo?.fundo_valorpagar || 0;
  // pl_formula = 'va_vr' → usa va+vr (sem subtrair vp) — modo Nexum JR
  // Demais FIDCs → usa va+vr-vp (fórmula contábil padrão)
  const plFidcLiquidez = plFormula === "va_vr" ? (va + vr) : (va + vr - vp);
  const xmlPL = isFidc && plFidcLiquidez > 0 ? plFidcLiquidez : plHeaderXml;
  const csvPL =
    fundoIsinHeader && isFidc ? 0 : (csvFundInfo?.valor_total_ativo || 0);
  const plDivPct = xmlPL > 0 && csvPL > 0 ? Math.abs(xmlPL - csvPL) / Math.max(xmlPL, csvPL) : 0;
  const hasPLDiscrepancy = plDivPct > 0.05;
  const fmtBRL = (v: number) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
  const fmtBRLCompact = (v: number) => {
    try {
      return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 }).format(v);
    } catch {
      return fmtBRL(v);
    }
  };
  const handleVoltar = () => {
    const from = (location.state as { from?: string } | null)?.from;
    const historyIdx = typeof window !== "undefined" ? (window.history.state?.idx ?? 0) : 0;

    if (historyIdx > 0) {
      navigate(-1);
      return;
    }

    navigate(from || "/liquidez/monitoramento-fundo");
  };

  const handleExportPdf = async () => {
    if (!exportHandlers?.exportPdf) {
      toast.error("Dados ainda carregando. Aguarde e tente novamente.");
      return;
    }
    setExportingPdf(true);
    try {
      await exportHandlers.exportPdf();
      toast.success("PDF exportado com sucesso!");
    } catch (err) {
      console.error(err);
      toast.error("Erro ao exportar PDF. Tente novamente.");
    } finally {
      setExportingPdf(false);
    }
  };

  const handleExportExcel = async () => {
    if (!exportHandlers?.exportExcel) {
      toast.error("Dados ainda carregando. Aguarde e tente novamente.");
      return;
    }
    setExportingXlsx(true);
    try {
      await exportHandlers.exportExcel();
      toast.success("Excel exportado com sucesso!");
    } catch (err) {
      console.error(err);
      toast.error("Erro ao exportar Excel. Tente novamente.");
    } finally {
      setExportingXlsx(false);
    }
  };

  const handleRecalcular = async () => {
    if (!cnpj || !date) return;
    setRecalculando(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ["calculo-risco-liquidez", cnpj, date] });
      await queryClient.invalidateQueries({ queryKey: ["liquidez-wallet", cnpj, date] });
      toast.success("Dados recalculados com sucesso!");
    } catch (err) {
      toast.error("Erro ao recalcular. Tente novamente.");
    } finally {
      setRecalculando(false);
    }
  };

  const canNotificar =
    (liquidezStatus === "alerta" || liquidezStatus === "violacao")
    && liquidezNotificacaoHabilitada(nomeFundo);

  const handleNotificar = async () => {
    if (!cnpj || !date || !canNotificar) return;

    setIsNotifying(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) throw new Error("Sessão não encontrada");

      const { data, error } = await supabase.functions.invoke("send-liquidez-notification", {
        body: {
          origem: "manual",
          fundo_dtposicao: date,
          fundo_cnpj: cnpj,
          nome_fundo: nomeFundo,
          tipo_limite: liquidezStatus === "violacao" ? "hard" : "soft",
        },
      });

      if (error) throw new Error(await extractFunctionError(error));
      if (data?.error) throw new Error(data.details ?? data.error);

      if (data?.status === "sem_violacoes") {
        if (!liquidezNotificacaoHabilitada(nomeFundo)) {
          toast.info("Notificações de liquidez do FIDC NEXUM são enviadas apenas pela classe JR.");
          return;
        }
        toast.info("Nenhum alerta de liquidez para este fundo — e-mail não enviado.");
        return;
      }

      toast.success(
        data?.log_warning
          ? "Notificação enviada, mas o histórico não foi salvo."
          : `E-mail de ${liquidezStatus === "violacao" ? "Hard Limit" : "Soft Limit"} enviado — ${data?.destinatarios_count ?? 0} destinatário(s).`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg.length > 300 ? `${msg.slice(0, 300)}…` : msg);
      console.error(err);
    } finally {
      setIsNotifying(false);
    }
  };

  const statusIcon = liquidezStatus === "violacao"
    ? <XCircle className="w-3.5 h-3.5" />
    : liquidezStatus === "alerta"
      ? <AlertTriangle className="w-3.5 h-3.5" />
      : <CheckCircle2 className="w-3.5 h-3.5" />;

  const statusLabel = liquidezStatus === "violacao" ? "HARD" : liquidezStatus === "alerta" ? "SOFT" : "OK";
  const statusColor = liquidezStatus === "violacao"
    ? "border-red-300 bg-red-50 text-red-700 dark:bg-red-950/50 dark:border-red-700 dark:text-red-300"
    : liquidezStatus === "alerta"
      ? "border-amber-300 bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:border-amber-700 dark:text-amber-300"
      : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:border-emerald-700 dark:text-emerald-300";

  return (
    <Layout>
      <div className="w-full min-w-0 max-w-7xl mx-auto bg-background min-h-screen">
        {/* ─── Sticky Header ─── */}
        <div className="sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b border-border/60 px-3 sm:px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between min-w-0">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
              <Button variant="ghost" size="sm" className="h-8 px-2 text-muted-foreground hover:text-foreground group shrink-0"
                onClick={handleVoltar}>
                <ArrowLeft className="h-4 w-4 mr-1.5 transition-transform group-hover:-translate-x-1" />
                <span className="text-[10px] font-bold uppercase tracking-wider hidden sm:inline">Voltar</span>
              </Button>

              <div className="h-6 w-[1px] bg-border/60 hidden sm:block shrink-0" />

              <h1 className="text-sm md:text-base font-bold tracking-tight truncate min-w-0">
                {nomeFundo}
              </h1>
            </div>

            <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end w-full sm:w-auto">
              {liquidezStatus && (
                <div className={cn("rounded-lg border px-2 py-1 flex items-center gap-1.5 h-8", statusColor)}>
                  {statusIcon}
                  <span className="text-[10px] font-bold">{statusLabel}</span>
                </div>
              )}

              <Button
                variant="outline"
                size="sm"
                onClick={handleExportExcel}
                disabled={exportingXlsx || !exportHandlers}
                className="h-8 text-[10px] font-bold uppercase"
              >
                {exportingXlsx
                  ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  : <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" />}
                Excel
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={handleExportPdf}
                disabled={exportingPdf || !exportHandlers}
                className="h-8 text-[10px] font-bold uppercase"
              >
                {exportingPdf
                  ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  : <FileDown className="h-3.5 w-3.5 mr-1.5" />}
                PDF
              </Button>
            </div>
          </div>
        </div>

        {/* ─── Info do Fundo ─── */}
        <div className="px-3 sm:px-4 pt-6 pb-4 space-y-4 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 min-w-0">
            <div className="space-y-2 min-w-0">
              <h2 className="text-xl md:text-2xl font-bold tracking-tight text-foreground">
                {nomeFundo}
              </h2>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                <InfoItem label="CNPJ" value={cnpjFormatado} mono />
                {fundoIsinHeader && <InfoItem label="ISIN" value={fundoIsinHeader} mono />}
                <InfoItem label="Data Base" value={dateFormatted} mono />
                <InfoItem label="Administrador" value={fundInfo?.fundo_nomeadm || "–"} />
                <InfoItem label="Tipo" value={characteristics?.aberto_estatutariamente || "–"} />
                <InfoItem
                  label="Patrimônio Líquido"
                  value={fmtBRL(hasPLDiscrepancy ? csvPL : xmlPL)}
                  mono
                />
                {hasPLDiscrepancy && (
                  <span className="inline-flex items-center gap-1 text-[9px] font-bold bg-amber-50 border border-amber-300 text-amber-700 dark:bg-amber-950/40 dark:border-amber-700 dark:text-amber-400 rounded px-1.5 py-0.5">
                    <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
                    XML {fmtBRLCompact(xmlPL)} → CSV {fmtBRLCompact(csvPL)}
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 gap-2 text-sm font-medium"
                onClick={handleNotificar}
                disabled={isNotifying || !canNotificar}
                title={
                  !liquidezNotificacaoHabilitada(nomeFundo)
                    ? "Notificações de liquidez do FIDC NEXUM são enviadas apenas pela classe JR"
                    : canNotificar
                    ? "Enviar e-mail de alerta de liquidez deste fundo"
                    : "Disponível apenas para fundos em Soft ou Hard Limit"
                }
              >
                {isNotifying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Mail className="h-3.5 w-3.5 text-amber-600" />
                )}
                Notificar
              </Button>
              <Button
                variant="default"
                size="sm"
                className="h-8 px-3 gap-2 text-sm font-medium shrink-0"
                onClick={handleRecalcular}
                disabled={recalculando}
              >
                {recalculando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Recalcular
              </Button>
            </div>
          </div>
        </div>

        {/* ─── Conteúdo Principal ─── */}
        <div className="px-3 sm:px-4 pb-10 min-w-0">
          <LiquidezFundDetailContent
            fundoCnpj={cnpj}
            fundoDtposicao={date}
            fundoIsin={fundoIsinHeader}
            onStatusChange={setLiquidezStatus}
            onExportHandlersReady={setExportHandlers}
            csvPL={csvPL > 0 ? csvPL : undefined}
            initialClasse={initialClasse}
          />
        </div>
      </div>
    </Layout>
  );
}

function InfoItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground font-medium uppercase text-[10px] tracking-wider shrink-0">{label}:</span>
      <span className={cn("text-foreground/80 truncate", mono && "font-mono")}>{value}</span>
    </div>
  );
}
