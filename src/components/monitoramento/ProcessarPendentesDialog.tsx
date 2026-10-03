/**
 * Dialog "Processar Pendentes" — enquadramento e/ou liquidez.
 *
 * Dispara batch-monitoramento com auto_continue no servidor e acompanha
 * o progresso via polling em monitoramento_job_log (não bloqueia a aba).
 */

import { useState, useCallback, useRef, useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Loader2,
  Calendar as CalendarIcon,
  CheckCircle2,
  XCircle,
  ClipboardCheck,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format, startOfYear } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import {
  runPendentesInBackground,
  countParesPendentesPorData,
  type LogEntry,
} from "@/lib/monitoramentoJobPoll";

const formatDateToDB = (d: Date) => format(d, "yyyyMMdd");

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableDates: string[];
  queryClient: QueryClient;
}

const BATCH_LIMIT = 5;

export function ProcessarPendentesDialog({ open, onOpenChange, availableDates, queryClient }: Props) {
  const today = new Date();
  const defaultStart = startOfYear(today);
  const defaultEnd = availableDates.length > 0
    ? new Date(
        Number(availableDates[0].slice(0, 4)),
        Number(availableDates[0].slice(4, 6)) - 1,
        Number(availableDates[0].slice(6, 8)),
      )
    : today;

  const [startDate, setStartDate] = useState<Date | undefined>(defaultStart);
  const [endDate, setEndDate] = useState<Date | undefined>(defaultEnd);
  const [modoEnquadramento, setModoEnquadramento] = useState(true);
  const [modoLiquidez, setModoLiquidez] = useState(true);

  const [contagem, setContagem] = useState<{ eq: number; liq: number } | null>(null);
  const [contagemError, setContagemError] = useState<string | null>(null);
  const [contandoPendentes, setContandoPendentes] = useState(false);

  const [processing, setProcessing] = useState(false);
  const [finished, setFinished] = useState(false);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [erros, setErros] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const cancelRef = useRef(false);
  const toastIdRef = useRef<string | number | undefined>(undefined);

  const canStart = !!startDate && !!endDate && (modoEnquadramento || modoLiquidez) && !processing;

  const invalidateQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["funds-list"] });
    queryClient.invalidateQueries({ queryKey: ["enquadramento-rules"] });
    queryClient.invalidateQueries({ queryKey: ["enquadramento-rules-summary"] });
    queryClient.invalidateQueries({ queryKey: ["enquadramento-timeline"] });
    queryClient.invalidateQueries({ queryKey: ["liquidez-funds-list"] });
    queryClient.invalidateQueries({ queryKey: ["fund-status-header"] });
  }, [queryClient]);

  const resetState = useCallback(() => {
    setFinished(false);
    setFailed(false);
    setLog([]);
    setProgress(0);
    setTotal(0);
    setErros(0);
    setContagem(null);
    setContagemError(null);
  }, []);

  const handleClose = useCallback(() => {
    if (processing) {
      toast.info("Processamento continua em segundo plano. Acompanhe pelo toast ou reabra este diálogo.", {
        duration: 6000,
      });
      onOpenChange(false);
      return;
    }
    resetState();
    onOpenChange(false);
  }, [processing, onOpenChange, resetState]);

  const contarPendentes = useCallback(async () => {
    if (!startDate || !endDate) return;
    setContandoPendentes(true);
    setContagem(null);
    setContagemError(null);
    try {
      const di = formatDateToDB(startDate);
      const df = formatDateToDB(endDate);
      const datasPeriodo = availableDates.filter((d) => d >= di && d <= df);

      if (datasPeriodo.length === 0) {
        setContagem({ eq: 0, liq: 0 });
        return;
      }

      const { eq, liq, errors } = await countParesPendentesPorData(datasPeriodo, {
        enquadramento: modoEnquadramento,
        liquidez: modoLiquidez,
      });

      if (errors.length > 0) {
        setContagemError(errors.join(" "));
        toast.error(errors[0]);
        return;
      }

      setContagem({ eq, liq });
    } catch (e: unknown) {
      const msg = (e as Error).message ?? "Erro desconhecido";
      setContagemError(msg);
      toast.error(`Erro ao contar pendentes: ${msg}`);
    } finally {
      setContandoPendentes(false);
    }
  }, [startDate, endDate, modoEnquadramento, modoLiquidez, availableDates]);

  const handleStart = useCallback(async () => {
    if (!startDate || !endDate) return;

    const modos: string[] = [];
    if (modoEnquadramento) modos.push("enquadramento");
    if (modoLiquidez) modos.push("liquidez");
    if (modos.length === 0) return;

    cancelRef.current = false;
    setProcessing(true);
    setFinished(false);
    setFailed(false);
    setLog([]);
    setProgress(0);
    setTotal(0);
    setErros(0);

    const di = formatDateToDB(startDate);
    const df = formatDateToDB(endDate);
    const datasPeriodo = availableDates.filter((d) => d >= di && d <= df).sort();

    if (datasPeriodo.length === 0) {
      toast.error("Nenhuma data com posição importada encontrada nesse período.");
      setProcessing(false);
      return;
    }

    const expectedMin = contagem
      ? Math.max(
          modoEnquadramento ? contagem.eq : 0,
          modoLiquidez ? contagem.liq : 0,
        )
      : 0;
    const toastId = toast.loading("Iniciando processamento em segundo plano...");
    toastIdRef.current = toastId;

    try {
      const { job } = await runPendentesInBackground({
        dataInicio: di,
        dataFim: df,
        datasPeriodo,
        modos,
        batchLimit: BATCH_LIMIT,
        expectedMin,
        signal: cancelRef,
        onProgress: (j) => {
          setTotal(j.total_pares);
          setProgress(j.processados);
          setErros(j.erros);
          const lote = j.detalhes?.ultimo_lote;
          if (lote?.length) {
            setLog((prev) => [...prev, ...lote]);
          }
          toast.loading(
            `Processando em segundo plano… ${j.processados}/${j.total_pares}` +
              (j.erros > 0 ? ` (${j.erros} erro${j.erros !== 1 ? "s" : ""})` : ""),
            { id: toastId },
          );
        },
      });

      if (cancelRef.current) {
        toast.warning("Acompanhamento cancelado — o job continua no servidor.", { id: toastId });
        return;
      }

      if (job.status === "error") {
        setFailed(true);
        toast.error("Processamento falhou. Verifique Configurações → Monitoramento → histórico de jobs.", {
          id: toastId,
        });
        return;
      }

      if (expectedMin > 0 && job.processados === 0 && job.total_pares === 0) {
        setFailed(true);
        toast.error(
          "Nenhum par foi processado apesar da contagem mostrar pendentes. Reaplique a migration 20260717 no Supabase.",
          { id: toastId },
        );
        return;
      }

      toast.success(
        `Concluído — ${job.processados} par${job.processados !== 1 ? "es" : ""} processado${job.processados !== 1 ? "s" : ""}` +
          (job.erros > 0 ? `, ${job.erros} com erro` : ""),
        { id: toastId },
      );
      invalidateQueries();
      setFinished(true);
    } catch (err: unknown) {
      setFailed(true);
      toast.error(`Erro: ${(err as Error).message ?? ""}`, { id: toastId });
    } finally {
      setProcessing(false);
    }
  }, [startDate, endDate, modoEnquadramento, modoLiquidez, contagem, invalidateQueries, availableDates]);

  // Reabrir diálogo enquanto job ativo: retoma exibição de progresso via toast
  useEffect(() => {
    if (open && processing) {
      toast.loading(`Processando… ${progress}/${total}`, { id: toastIdRef.current });
    }
  }, [open, processing, progress, total]);

  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  const modesLabel = [
    modoEnquadramento ? "Enquadramento" : null,
    modoLiquidez ? "Liquidez" : null,
  ].filter(Boolean).join(" + ");

  const showResult = finished || failed;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); else onOpenChange(true); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {processing ? (
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
            ) : failed ? (
              <XCircle className="w-5 h-5 text-red-500" />
            ) : finished ? (
              erros > 0 ? (
                <AlertTriangle className="w-5 h-5 text-amber-500" />
              ) : (
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              )
            ) : (
              <ClipboardCheck className="w-5 h-5 text-primary" />
            )}
            {processing
              ? "Processando em segundo plano…"
              : failed
              ? "Erro no processamento"
              : finished
              ? "Processamento concluído"
              : "Processar pendentes"}
          </DialogTitle>
          <DialogDescription>
            {processing
              ? "O job roda no servidor — você pode fechar esta janela. O progresso aparece no toast."
              : failed
              ? "A chamada falhou. Confira se a migration e o deploy de batch-monitoramento foram feitos."
              : finished
              ? `${progress} par${progress !== 1 ? "es" : ""} processado${progress !== 1 ? "s" : ""}` +
                (erros > 0 ? ` — ${erros} com erro` : " sem erros")
              : "Detecta e calcula apenas os pares (fundo, data) com posição importada mas sem cálculo concluído."}
          </DialogDescription>
        </DialogHeader>

        {!processing && !showResult && (
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Período</p>
              <div className="flex gap-2 items-center">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className={cn("flex-1 justify-start gap-2 text-xs", !startDate && "text-muted-foreground")}
                    >
                      <CalendarIcon className="h-3.5 w-3.5" />
                      {startDate ? format(startDate, "dd/MM/yyyy") : "Início"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={startDate}
                      onSelect={(d) => { setStartDate(d); setContagem(null); }}
                      locale={ptBR}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>

                <span className="text-muted-foreground text-xs">até</span>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className={cn("flex-1 justify-start gap-2 text-xs", !endDate && "text-muted-foreground")}
                    >
                      <CalendarIcon className="h-3.5 w-3.5" />
                      {endDate ? format(endDate, "dd/MM/yyyy") : "Fim"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={endDate}
                      onSelect={(d) => { setEndDate(d); setContagem(null); }}
                      locale={ptBR}
                      disabled={(d) => (startDate ? d < startDate : false)}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Módulos</p>
              <div className="flex gap-3">
                {[
                  { label: "Enquadramento", value: modoEnquadramento, set: setModoEnquadramento },
                  { label: "Liquidez", value: modoLiquidez, set: setModoLiquidez },
                ].map(({ label, value, set }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => { set(!value); setContagem(null); }}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded border text-xs font-medium transition-colors",
                      value
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:bg-muted",
                    )}
                  >
                    <span className={cn(
                      "w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0",
                      value ? "bg-primary-foreground border-primary-foreground" : "border-muted-foreground",
                    )}>
                      {value && <CheckCircle2 className="h-2.5 w-2.5 text-primary" />}
                    </span>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-md border bg-muted/40 px-3 py-2.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">Pendentes no período</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs gap-1"
                  onClick={contarPendentes}
                  disabled={contandoPendentes || !startDate || !endDate}
                >
                  {contandoPendentes
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <RefreshCw className="h-3 w-3" />}
                  Contar
                </Button>
              </div>
              {contagemError ? (
                <p className="text-xs text-red-600">{contagemError}</p>
              ) : contagem !== null ? (
                <div className="flex gap-4 text-xs">
                  {modoEnquadramento && (
                    <span>
                      Enquadramento: <strong>{contagem.eq.toLocaleString("pt-BR")}</strong>
                    </span>
                  )}
                  {modoLiquidez && (
                    <span>
                      Liquidez: <strong>{contagem.liq.toLocaleString("pt-BR")}</strong>
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">Clique em &quot;Contar&quot; para ver o total</p>
              )}
            </div>
          </div>
        )}

        {(processing || showResult) && (
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{modesLabel}</span>
                <span>{progress}/{total} pares</span>
              </div>
              <Progress value={pct} className="h-2" />
            </div>

            {processing && (
              <p className="text-xs text-muted-foreground">
                Pode fechar esta janela — o processamento continua no servidor.
              </p>
            )}

            {erros > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-amber-600">
                <AlertTriangle className="h-3.5 w-3.5" />
                {erros} erro{erros !== 1 ? "s" : ""} durante o processamento
              </div>
            )}

            {finished && erros === 0 && progress > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Todos os pares processados com sucesso
              </div>
            )}

            {log.length > 0 && (
              <div className="max-h-44 overflow-y-auto rounded border text-xs">
                <table className="w-full">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="text-left px-2 py-1 font-medium text-muted-foreground">CNPJ</th>
                      <th className="text-left px-2 py-1 font-medium text-muted-foreground">Data</th>
                      <th className="text-center px-2 py-1 font-medium text-muted-foreground">Enq.</th>
                      <th className="text-center px-2 py-1 font-medium text-muted-foreground">Liq.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {log.slice(-50).map((e, i) => (
                      <tr key={i} className="border-t hover:bg-muted/40">
                        <td className="px-2 py-0.5 font-mono">{e.cnpj?.slice(0, 8)}…</td>
                        <td className="px-2 py-0.5">
                          {e.data?.slice(0, 4)}-{e.data?.slice(4, 6)}-{e.data?.slice(6, 8)}
                        </td>
                        <td className="px-2 py-0.5 text-center">
                          {modoEnquadramento ? (
                            e.ok_eq
                              ? <CheckCircle2 className="h-3 w-3 text-emerald-500 inline" />
                              : <XCircle className="h-3 w-3 text-red-500 inline" />
                          ) : "—"}
                        </td>
                        <td className="px-2 py-0.5 text-center">
                          {modoLiquidez ? (
                            e.ok_liq
                              ? <CheckCircle2 className="h-3 w-3 text-emerald-500 inline" />
                              : <XCircle className="h-3 w-3 text-red-500 inline" />
                          ) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {processing ? (
            <>
              <Button variant="outline" size="sm" onClick={handleClose}>
                Fechar (continua em background)
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { cancelRef.current = true; }}
              >
                Parar de acompanhar
              </Button>
            </>
          ) : showResult ? (
            <Button size="sm" onClick={handleClose}>Fechar</Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={handleClose}>
                Cancelar
              </Button>
              <Button
                size="sm"
                onClick={handleStart}
                disabled={!canStart}
                className="gap-2"
              >
                <ClipboardCheck className="h-3.5 w-3.5" />
                Processar pendentes
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
