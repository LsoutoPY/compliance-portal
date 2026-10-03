import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DateRefNavigator } from "@/components/DateRefNavigator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Mail,
  Calendar as CalendarIcon,
  Download,
  Send,
  Plus,
  X,
  Loader2,
  FileText,
  RefreshCw,
  EyeOff,
  Eye,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  useRentabilidadeDatas,
  type RentabilidadeFundoRow,
  useFundosXmlCoverage,
} from "@/hooks/useRentabilidadeData";
import { fetchRentabilidadeRelatorioV2 } from "@/lib/rentabilidadeSnapshotV2";
import { buildParKey, fetchParesMonitorados } from "@/lib/fundosMonitorados";
import { invokeAuthenticatedFunction } from "@/lib/supabaseFunctions";

interface FundoIgnoradoRelatorio {
  fundo_key: string;
  fundo_cnpj: string;
  fundo_isin: string | null;
  nome_fundo: string | null;
  ativo: boolean;
}
import { fetchCdiRange } from "@/hooks/useCDI";
import { subtractDaysIso } from "@/hooks/useRentabilidadeCalc";
import { fetchRentabilidadeAtivosForFundo } from "@/hooks/useRentabilidadeData";
import {
  prepareFundosRelatorio,
  type AtivoRelatorio,
} from "@/lib/generateRentabilidadeRelatorioHTML_v2";
import { generateRentabilidadeEmailHTML } from "@/lib/generateRentabilidadeEmailHTML";
import { buildRentabilidadeRelatorioExcelBuffer } from "@/lib/generateRentabilidadeRelatorioExcel";
import {
  downloadRentabilidadeRelatorioPDF,
} from "@/lib/generateRentabilidadeRelatorioPDF";
import {
  convertAtivoToRelatorio,
  sortAtivosRelatorio,
  fetchSiglasNomesFundos,
  collectCnpjsAtivos,
} from "@/lib/prepareRentabilidadeRelatorioData";

/** Converte ArrayBuffer em Base64 sem estourar a pilha (anexos grandes). */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Limite conservador do body JSON enviado à Edge Function (~6 MB no gateway Supabase). */
const MAX_INVOKE_BODY_BYTES = 5 * 1024 * 1024;

/** Evita estourar rate limit do Supabase ao buscar ativos de dezenas de fundos em paralelo. */
const ATIVOS_FETCH_BATCH_SIZE = 6;

async function mapInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

async function fetchAtivosForFundoWithRetry(
  fundo: RentabilidadeFundoRow,
  selectedDate: string,
  cdiDict: Record<string, number>,
): Promise<{ cnpj: string; nome: string; ativos: AtivoRelatorio[]; failed: boolean }> {
  const load = async () => {
    const rows = await fetchRentabilidadeAtivosForFundo(
      fundo.fundo_cnpj,
      fundo.fundo_isin,
      fundo.nome_fundo,
      selectedDate,
      fundo.pl,
      cdiDict,
    );
    return sortAtivosRelatorio(rows.map(convertAtivoToRelatorio));
  };

  const label = fundo.nome_fundo ?? fundo.fundo_cnpj;

  try {
    const ativos = await load();
    return { cnpj: fundo.fundo_key, nome: label, ativos, failed: false };
  } catch (err) {
    console.error(`Erro ao buscar ativos do fundo ${fundo.fundo_cnpj}:`, err);
    try {
      const ativos = await load();
      return { cnpj: fundo.fundo_key, nome: label, ativos, failed: false };
    } catch (retryErr) {
      console.error(`Retry falhou para fundo ${fundo.fundo_cnpj}:`, retryErr);
      return { cnpj: fundo.fundo_key, nome: label, ativos: [], failed: true };
    }
  }
}

async function extractFunctionError(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response })?.context;
  if (ctx) {
    try {
      const body = (await ctx.json()) as { details?: string; error?: string };
      return body.details ?? body.error ?? String(error);
    } catch {
      /* ignore */
    }
    if (ctx.status === 404) {
      return "Edge Function send-rentabilidade-report não encontrada — verifique o deploy no Supabase";
    }
    if (ctx.status === 413) {
      return "Relatório muito grande para enviar com anexo Excel — tente novamente (o Excel será omitido automaticamente)";
    }
  }
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("Failed to send a request to the Edge Function")) {
    return "Falha na comunicação com a Edge Function (rede, CORS ou payload muito grande). Tente novamente; se persistir, contate o suporte.";
  }
  return msg;
}

export default function EnviarRelatorioRentabilidade() {
  const { toast } = useToast();
  const { data: datas = [], isLoading: datasLoading } = useRentabilidadeDatas();
  const [dataRef, setDataRef] = useState<string | null>(null);
  const [emails, setEmails] = useState<string[]>([]);
  const [novoEmail, setNovoEmail] = useState("");
  const [emailsCarregados, setEmailsCarregados] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  // Pré-popula destinatários cadastrados em Configurações → Notificações (tipo=rentabilidade)
  useEffect(() => {
    if (emailsCarregados) return;
    supabase
      .from("email_destinatarios")
      .select("email")
      .eq("tipo", "rentabilidade")
      .eq("ativo", true)
      .then(({ data }) => {
        const cadastrados = (data ?? []).map((d) => d.email as string).filter(Boolean);
        if (cadastrados.length > 0) {
          setEmails(cadastrados);
        }
        setEmailsCarregados(true);
      });
  }, [emailsCarregados]);
  const [isSending, setIsSending] = useState(false);
  const [htmlPreview, setHtmlPreview] = useState<string | null>(null);

  const selectedDate = dataRef ?? datas[0] ?? null;

  const { data: snapshotReport, isLoading: fundosLoading, refetch: refetchSnapshots } = useQuery({
    queryKey: ["rentabilidade-relatorio-v2", selectedDate],
    queryFn: () => fetchRentabilidadeRelatorioV2(selectedDate!),
    enabled: !!selectedDate,
    staleTime: 60 * 1000,
    // Os workers V2 processam a fila em background. Atualiza a contagem sem
    // exigir que o usuário clique em "Calcular" enquanto o worker trabalha.
    refetchInterval: 10 * 1000,
    refetchIntervalInBackground: false,
  });
  const fundosTodos = snapshotReport?.fundos ?? [];
  const { data: fundosIgnorados = [], isLoading: ignoredLoading, refetch: refetchIgnored } = useQuery({
    queryKey: ["rentabilidade-relatorio-fundos-ignorados"],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).from("rentabilidade_relatorio_fundos_ignorados")
        .select("fundo_key, fundo_cnpj, fundo_isin, nome_fundo, ativo").eq("ativo", true).order("nome_fundo");
      if (error) throw error;
      return (data ?? []) as FundoIgnoradoRelatorio[];
    },
    staleTime: 60 * 1000,
  });
  const ignoredKeys = new Set(fundosIgnorados.map((fundo) => fundo.fundo_key));
  const fundos = fundosTodos.filter((fundo) => !ignoredKeys.has(fundo.fundo_key));
  const { data: fundosComXml = [], isLoading: xmlFundosLoading } = useQuery({
    queryKey: ["rentabilidade-relatorio-v2-xml", selectedDate],
    queryFn: () => fetchParesMonitorados(selectedDate!.replace(/-/g, "")),
    enabled: !!selectedDate,
    staleTime: 60 * 1000,
  });
  const snapshotKeys = new Set(fundosTodos.map((fundo) => buildParKey(fundo.fundo_cnpj, fundo.fundo_isin)));
  const fundosPendentesV2 = fundosComXml.filter((fundo) => !snapshotKeys.has(buildParKey(fundo.fundo_cnpj, fundo.fundo_isin)));
  // Cobertura de XML e calculo V2 sao indicadores diferentes. Esta consulta
  // serve somente para informar faltantes; nunca bloqueia a operacao.
  const { total: totalUniversoXml, faltantes: xmlFaltantes, isLoading: xmlCoverageLoading } = useFundosXmlCoverage(selectedDate);
  const snapshotsDosXmls = fundosComXml.filter((fundo) => snapshotKeys.has(buildParKey(fundo.fundo_cnpj, fundo.fundo_isin))).length;

  // Carregar ativos de todos os fundos
  const [fundosAtivosMap, setFundosAtivosMap] = useState<Map<string, AtivoRelatorio[]>>(new Map());
  const [isLoadingAtivos, setIsLoadingAtivos] = useState(false);
  const [isCalculatingSnapshots, setIsCalculatingSnapshots] = useState(false);
  const [snapshotCalculationError, setSnapshotCalculationError] = useState<string | null>(null);
  const fundosSemAtivos = fundosTodos.filter((fundo) => !(snapshotReport?.ativosMap.has(fundo.fundo_key) ?? false));

  // Pré-visualização e cache de ativos ficam obsoletos ao trocar a data
  useEffect(() => {
    setHtmlPreview(null);
    setFundosAtivosMap(new Map());
  }, [selectedDate]);

  // Buscar ativos quando data ou fundos mudarem
  const fetchAllAtivos = async (): Promise<Map<string, AtivoRelatorio[]>> => {
    if (!selectedDate || fundosLoading || fundos.length === 0) return new Map();

    setIsLoadingAtivos(true);
    try {
      const persistedMap = snapshotReport?.ativosMap;
      if (persistedMap) {
        setFundosAtivosMap(persistedMap);
        return persistedMap;
      }
      const dataMin = subtractDaysIso(selectedDate, 560);
      const cdiDict = await fetchCdiRange(dataMin, selectedDate);
      const map = new Map<string, AtivoRelatorio[]>();
      const failedFundos: string[] = [];

      const results = await mapInBatches(fundos, ATIVOS_FETCH_BATCH_SIZE, (fundo) =>
        fetchAtivosForFundoWithRetry(fundo, selectedDate, cdiDict),
      );

      results.forEach(({ cnpj, nome, ativos, failed }) => {
        if (failed) {
          failedFundos.push(nome);
        }
        if (ativos.length > 0) {
          map.set(cnpj, ativos);
        }
      });

      if (failedFundos.length > 0) {
        const preview =
          failedFundos.length <= 3
            ? failedFundos.join(", ")
            : `${failedFundos.slice(0, 3).join(", ")} e mais ${failedFundos.length - 3}`;
        toast({
          title: "Aviso",
          description: `Não foi possível carregar ativos de ${failedFundos.length} fundo(s): ${preview}`,
          variant: "default",
        });
      }

      setFundosAtivosMap(map);
      return map;
    } catch (error) {
      console.error("Erro ao buscar ativos:", error);
      toast({
        title: "Aviso",
        description: "Alguns ativos podem não estar disponíveis no relatório",
        variant: "default",
      });
      return new Map();
    } finally {
      setIsLoadingAtivos(false);
    }
  };

  const handleAddEmail = () => {
    const trimmed = novoEmail.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return;
    if (emails.some((e) => e.toLowerCase() === trimmed.toLowerCase())) {
      setNovoEmail("");
      return;
    }
    setEmails([...emails, trimmed]);
    setNovoEmail("");
  };

  const handleRemoveEmail = (email: string) => {
    setEmails(emails.filter((e) => e !== email));
  };

  const validEmails = emails.filter(
    (email) => email.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()),
  );
  const novoEmailValido =
    novoEmail.trim() !== "" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(novoEmail.trim());

  const dadosRelatorioProntos = !!selectedDate && !fundosLoading && !ignoredLoading && fundos.length > 0;

  const handleToggleIgnoreFundo = async (fundo: RentabilidadeFundoRow) => {
    const jaIgnorado = ignoredKeys.has(fundo.fundo_key);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const query = (supabase as any).from("rentabilidade_relatorio_fundos_ignorados");
      if (jaIgnorado) {
        const { error } = await query.delete().eq("fundo_key", fundo.fundo_key);
        if (error) throw error;
      } else {
        const { data: authData } = await supabase.auth.getUser();
        const { error } = await query.upsert({
          fundo_key: fundo.fundo_key,
          fundo_cnpj: fundo.fundo_cnpj,
          fundo_isin: fundo.fundo_isin,
          nome_fundo: fundo.nome_fundo,
          ativo: true,
          created_by: authData.user?.id ?? null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "fundo_key" });
        if (error) throw error;
      }
      await refetchIgnored();
      toast({ title: jaIgnorado ? "Fundo incluído no relatório" : "Fundo adicionado à lista de ignorados", description: fundo.nome_fundo ?? fundo.fundo_cnpj });
    } catch (error) {
      toast({ title: "Não foi possível atualizar a lista", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    }
  };

  const handleRemoveIgnored = async (fundo: FundoIgnoradoRelatorio) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).from("rentabilidade_relatorio_fundos_ignorados")
        .delete().eq("fundo_key", fundo.fundo_key);
      if (error) throw error;
      await refetchIgnored();
      toast({ title: "Fundo incluído no relatório", description: fundo.nome_fundo ?? fundo.fundo_cnpj });
    } catch (error) {
      toast({ title: "Não foi possível atualizar a lista", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    }
  };

  const handleCalcularSnapshots = async (alvo: "pendentes" | "todos") => {
    const classes = alvo === "todos" ? fundosComXml : fundosPendentesV2;
    if (!selectedDate || classes.length === 0) return;
    setIsCalculatingSnapshots(true);
    setSnapshotCalculationError(null);
    const falhas: string[] = [];
    try {
      for (const fundo of classes) {
        const { data, error } = await invokeAuthenticatedFunction<{ error?: string; details?: string }>("rebuild-rentabilidade-snapshot-v2", {
          fundo_cnpj: fundo.fundo_cnpj,
          fundo_isin: fundo.fundo_isin,
          fundo_nome: fundo.nome_fundo,
          data_referencia: selectedDate,
          origem: "envio_relatorio_manual",
        });
        if (error || data?.error) {
          falhas.push(`${fundo.nome_fundo || fundo.fundo_cnpj}: ${error?.message ?? data?.details ?? data?.error}`);
        }
      }
      await refetchSnapshots();
      if (falhas.length > 0) {
        const mensagem = falhas.join(" | ");
        setSnapshotCalculationError(mensagem);
        toast({ title: "Alguns snapshots não foram calculados", description: mensagem, variant: "destructive" });
      } else {
        toast({
          title: alvo === "todos" ? "Snapshots V2 recalculados" : "Snapshots V2 calculados",
          description: `${classes.length} classe(s) prontas para o relatÃ³rio.`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({ title: "Falha ao calcular snapshots", description: message, variant: "destructive" });
    } finally {
      setIsCalculatingSnapshots(false);
    }
  };

  /** Monta HTML do e-mail sempre a partir dos dados atuais (nunca cache desatualizado). */
  const buildEmailHtmlContent = async (): Promise<{
    html: string;
    ativosMap: Map<string, AtivoRelatorio[]>;
  }> => {
    if (!selectedDate || fundos.length === 0) {
      throw new Error("Selecione uma data com fundos disponíveis");
    }
    const ativosMap = await fetchAllAtivos();

    const { fundos: fundosRelatorio, summary } = prepareFundosRelatorio(fundos, ativosMap);
    const cnpjsSiglas = [
      ...collectCnpjsAtivos(ativosMap),
      ...xmlFaltantes.map((f) => f.cnpj_fundo),
    ];
    const siglasPorCnpj = await fetchSiglasNomesFundos(cnpjsSiglas);
    const html = generateRentabilidadeEmailHTML(
      fundosRelatorio,
      summary,
      selectedDate,
      siglasPorCnpj,
      {
        cdiDiaPct: fundos[0]?.cdi_dia_pct ?? null,
        faltantes: xmlFaltantes,
      },
    );

    if (!html.includes("Ret/Var Ano") || !html.includes("vs CDI Ano")) {
      throw new Error("Template do e-mail desatualizado — recarregue a página (Ctrl+F5) e tente novamente");
    }

    return { html, ativosMap };
  };

  const handleGeneratePreview = async () => {
    if (!selectedDate) {
      toast({
        title: "Erro",
        description: "Selecione uma data de referência",
        variant: "destructive",
      });
      return;
    }

    setIsGenerating(true);
    try {
      const { html } = await buildEmailHtmlContent();
      setHtmlPreview(html);

      toast({
        title: "Pré-visualização gerada",
        description: "Tabela com 12 colunas (inclui Ret/Var Ano e vs CDI Ano)",
      });
    } catch (error) {
      console.error("Erro ao gerar pré-visualização:", error);
      const msg = error instanceof Error ? error.message : "Falha ao gerar pré-visualização";
      toast({
        title: "Erro",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const buildPdfParams = (ativosMap = fundosAtivosMap) => {
    if (!selectedDate) return null;
    const { fundos: fundosRelatorio, summary } = prepareFundosRelatorio(fundos, ativosMap);
    const dataFormatada = format(parseISO(selectedDate), "dd/MM/yyyy", { locale: ptBR });
    const cdiDia = fundos[0]?.cdi_dia_pct ?? 0;
    return { dataFormatada, fundosRelatorio, summary, cdiDia };
  };

  const handleDownloadPDF = async () => {
    if (!selectedDate || fundos.length === 0) {
      toast({
        title: "Erro",
        description: "Selecione uma data com fundos disponíveis",
        variant: "destructive",
      });
      return;
    }

    setIsGenerating(true);
    try {
      const ativosMap = await fetchAllAtivos();

      const params = buildPdfParams(ativosMap);
      if (!params) return;

      await downloadRentabilidadeRelatorioPDF(
        params.dataFormatada,
        params.fundosRelatorio,
        params.summary,
        params.cdiDia,
        xmlFaltantes,
      );
      
      toast({
        title: "PDF baixado",
        description: "Download concluído com sucesso",
      });
    } catch (error) {
      console.error("Erro ao gerar PDF:", error);
      toast({
        title: "Erro",
        description: "Falha ao gerar PDF",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSendEmail = async () => {
    if (!selectedDate) {
      toast({
        title: "Erro",
        description: "Selecione uma data de referência",
        variant: "destructive",
      });
      return;
    }

    if (validEmails.length === 0) {
      toast({
        title: "Erro",
        description: "Adicione pelo menos um e-mail válido",
        variant: "destructive",
      });
      return;
    }

    setIsSending(true);
    try {
      const { data: serverData, error: serverError } = await supabase.functions.invoke("send-rentabilidade-report", {
        body: { dataReferencia: selectedDate, emailDestinatarios: validEmails, fundosFaltantes: xmlFaltantes },
      });
      if (serverError) throw new Error(await extractFunctionError(serverError));
      if (serverData?.error) throw new Error(serverData.details ?? serverData.error);
      toast({
        title: "E-mail enviado",
        description: `RelatÃ³rio enviado para ${validEmails.length} destinatÃ¡rio(s) a partir do snapshot V2`,
      });
      setNovoEmail("");
      if (serverData?.success) return;

      const { html: htmlContent, ativosMap } = await buildEmailHtmlContent();
      setHtmlPreview(htmlContent);

      const { fundos: fundosRelatorio } = prepareFundosRelatorio(fundos, ativosMap);
      const { buffer, filename } = await buildRentabilidadeRelatorioExcelBuffer(
        fundosRelatorio,
        selectedDate,
      );
      const base64 = arrayBufferToBase64(buffer);

      const invokeBody: Record<string, unknown> = {
        dataReferencia: selectedDate,
        emailDestinatarios: validEmails,
        htmlContent,
        excelBase64: base64,
        excelFilename: filename,
      };

      let bodyBytes = new Blob([JSON.stringify(invokeBody)]).size;
      if (bodyBytes > MAX_INVOKE_BODY_BYTES) {
        delete invokeBody.excelBase64;
        delete invokeBody.excelFilename;
        bodyBytes = new Blob([JSON.stringify(invokeBody)]).size;
        toast({
          title: "Anexo Excel omitido",
          description:
            "O relatório excede o limite de tamanho da requisição — o e-mail será enviado sem Excel. Use «Baixar PDF» ou exporte na tela de Rentabilidade.",
        });
      }

      const { data, error } = await supabase.functions.invoke("send-rentabilidade-report", {
        body: invokeBody,
      });

      if (error) throw new Error(await extractFunctionError(error));
      if (data?.error) throw new Error(data.details ?? data.error);

      toast({
        title: "E-mail enviado",
        description: `Relatório enviado para ${validEmails.length} destinatário(s)`,
      });

      // Limpar campo de novo e-mail após envio bem-sucedido
      setNovoEmail("");
    } catch (error) {
      console.error("Erro ao enviar e-mail:", error);
      const msg = error instanceof Error ? error.message : "Falha ao enviar e-mail";
      toast({
        title: "Erro ao enviar e-mail",
        description: msg.length > 300 ? `${msg.slice(0, 300)}…` : msg,
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground uppercase flex items-center gap-2">
              <Mail className="h-6 w-6 text-primary" />
              Enviar Relatório de Rentabilidade
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Relatório diário consolidado por fundo com detalhamento de ativos
            </p>
          </div>
        </div>

        {/* Configuração */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Painel de configuração */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarIcon className="h-4 w-4" />
                Configuração
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Seletor de data */}
              <div className="space-y-2">
                <Label>Data de referência</Label>
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
              </div>

              {/* Lista de e-mails */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>Destinatários</Label>
                  {validEmails.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {validEmails.length} e-mail(s)
                    </span>
                  )}
                </div>

                <div className="min-h-[2.5rem] max-h-28 overflow-y-auto rounded-md border border-input bg-muted/30 p-2">
                  {validEmails.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-1 py-1">
                      Nenhum destinatário — adicione abaixo
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {validEmails.map((email) => (
                        <Badge
                          key={email}
                          variant="secondary"
                          className="gap-1 pl-2 pr-1 py-0.5 font-normal text-[11px] max-w-full"
                          title={email}
                        >
                          <span className="truncate max-w-[220px]">{email}</span>
                          <button
                            type="button"
                            onClick={() => handleRemoveEmail(email)}
                            className="rounded-full p-0.5 hover:bg-muted-foreground/20 shrink-0"
                            aria-label={`Remover ${email}`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex gap-2">
                  <Input
                    type="email"
                    placeholder="Adicionar e-mail..."
                    value={novoEmail}
                    onChange={(e) => setNovoEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddEmail();
                      }
                    }}
                    className="h-8 text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleAddEmail}
                    disabled={!novoEmailValido}
                    className="shrink-0 h-8 px-2"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Ações */}
              <div className="space-y-2 pt-4">
                {fundosPendentesV2.length > 0 && (
                  <Button
                    onClick={() => handleCalcularSnapshots("pendentes")}
                    disabled={!selectedDate || isCalculatingSnapshots || xmlFundosLoading}
                    className="w-full"
                    variant="secondary"
                  >
                    {isCalculatingSnapshots ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                    {isCalculatingSnapshots ? "Calculando snapshots V2..." : `Calcular ${fundosPendentesV2.length} snapshot(s) V2`}
                  </Button>
                )}
                {fundosComXml.length > 0 && (
                  <Button
                    onClick={() => handleCalcularSnapshots("todos")}
                    disabled={!selectedDate || isCalculatingSnapshots || xmlFundosLoading}
                    className="w-full"
                    variant="outline"
                  >
                    {isCalculatingSnapshots ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                    {isCalculatingSnapshots ? "Recalculando snapshots V2..." : `Recalcular todos (${fundosComXml.length})`}
                  </Button>
                )}
                <Button
                  onClick={handleGeneratePreview}
                  disabled={!dadosRelatorioProntos || isGenerating || isLoadingAtivos}
                  className="w-full"
                  variant="outline"
                >
                  {isGenerating || isLoadingAtivos || fundosLoading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <FileText className="h-4 w-4 mr-2" />
                  )}
                  {fundosLoading
                    ? "Carregando fundos..."
                    : isLoadingAtivos
                        ? "Carregando ativos..."
                        : "Gerar pré-visualização"}
                </Button>

                <Button
                  onClick={handleDownloadPDF}
                  disabled={!dadosRelatorioProntos || isGenerating || isLoadingAtivos}
                  className="w-full"
                  variant="outline"
                >
                  {isGenerating ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 mr-2" />
                  )}
                  Baixar PDF
                </Button>

                <Button
                  onClick={handleSendEmail}
                  disabled={!dadosRelatorioProntos || validEmails.length === 0 || isSending || isGenerating}
                  className="w-full"
                >
                  {isSending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4 mr-2" />
                  )}
                  Enviar por e-mail
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Estatísticas */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Resumo do relatório</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Total de fundos</span>
                  <span className="font-semibold">{xmlFundosLoading ? "…" : fundosComXml.length}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Fundos faltantes (XML)</span>
                  <span className="font-semibold text-amber-600">
                    {xmlCoverageLoading ? "…" : xmlFaltantes.length}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Cálculo V2</span>
                  <span className="font-semibold">{xmlFundosLoading ? "…" : `${snapshotsDosXmls}/${fundosComXml.length}`}</span>
                </div>
                {!xmlFundosLoading && fundosPendentesV2.length > 0 && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    <p className="font-semibold">Aguardando cÃ¡lculo V2 ({fundosPendentesV2.length})</p>
                    <p className="mt-1 leading-5">
                      {fundosPendentesV2.slice(0, 5).map((fundo) => fundo.nome_fundo || fundo.fundo_cnpj).join(" · ")}
                      {fundosPendentesV2.length > 5 ? ` e mais ${fundosPendentesV2.length - 5}` : ""}
                    </p>
                  </div>
                )}
                {!xmlCoverageLoading && xmlFaltantes.length > 0 && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    <p className="font-semibold">Fundos sem XML na data ({xmlFaltantes.length} de {totalUniversoXml})</p>
                    <p className="mt-1 leading-5">
                      {xmlFaltantes.slice(0, 5).map((fundo) => fundo.nome_fundo || fundo.cnpj_fundo).join(" · ")}
                      {xmlFaltantes.length > 5 ? ` e mais ${xmlFaltantes.length - 5}` : ""}
                    </p>
                  </div>
                )}
                {snapshotCalculationError && (
                  <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900">
                    <p className="font-semibold">Erro ao calcular snapshot</p>
                    <p className="mt-1 break-words leading-5">{snapshotCalculationError}</p>
                  </div>
                )}
                <div className="border-t pt-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">Fundos sem ativos</span>
                    <span className="text-xs text-muted-foreground">inclusão padrão</span>
                  </div>
                  {fundosSemAtivos.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Nenhum fundo sem composição de ativos nesta data.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {fundosSemAtivos.map((fundo) => {
                        const ignorado = ignoredKeys.has(fundo.fundo_key);
                        return (
                          <div key={fundo.fundo_key} className="flex items-center justify-between gap-2 rounded border px-2 py-1.5">
                            <span className="min-w-0 truncate text-xs" title={fundo.nome_fundo ?? fundo.fundo_cnpj}>
                              {fundo.nome_fundo ?? fundo.fundo_cnpj}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 shrink-0 px-2 text-xs"
                              onClick={() => handleToggleIgnoreFundo(fundo)}
                            >
                              {ignorado ? <Eye className="mr-1 h-3.5 w-3.5" /> : <EyeOff className="mr-1 h-3.5 w-3.5" />}
                              {ignorado ? "Incluir" : "Ignorar"}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {fundosIgnorados.length > 0 && (
                    <div className="mt-3">
                      <p className="mb-1 text-xs text-muted-foreground">Ignorados salvos ({fundosIgnorados.length})</p>
                      <div className="space-y-1.5">
                        {fundosIgnorados.map((fundo) => (
                          <div key={fundo.fundo_key} className="flex items-center justify-between gap-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
                            <span className="min-w-0 truncate text-xs text-amber-950" title={fundo.nome_fundo ?? fundo.fundo_cnpj}>
                              {fundo.nome_fundo ?? fundo.fundo_cnpj}
                            </span>
                            <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={() => handleRemoveIgnored(fundo)}>
                              <Eye className="mr-1 h-3.5 w-3.5" /> Incluir
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Data selecionada</span>
                  <span className="font-semibold">
                    {selectedDate
                      ? format(parseISO(selectedDate), "dd/MM/yyyy", { locale: ptBR })
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Status</span>
                  <span className={cn("font-semibold", fundos.length > 0 && fundosPendentesV2.length === 0 ? "text-emerald-600" : "text-amber-600")}>
                    {fundosLoading
                      ? "Lendo snapshots V2..."
                      : fundos.length === 0
                        ? "Sem snapshot V2 calculado"
                        : fundosPendentesV2.length > 0
                          ? "Cálculo V2 pendente"
                          : xmlFaltantes.length > 0
                            ? "Pronto para envio parcial"
                            : "Pronto para envio"}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Pré-visualização */}
        {htmlPreview && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pré-visualização</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-2">
                Relatório em largura total — todas as 12 colunas visíveis sem faixa vazia à direita.
              </p>
              <div className="border rounded-lg overflow-x-auto bg-gray-50">
                <iframe
                  srcDoc={htmlPreview}
                  className="w-full"
                  style={{ height: "600px", border: "none" }}
                  title="Pré-visualização do relatório"
                />
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
