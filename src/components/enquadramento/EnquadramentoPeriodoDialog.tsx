/**
 * Dialog "Rodar Verificação por Período" — enquadramento.
 *
 * Dispara batch-monitoramento (modo periodo) no servidor e acompanha
 * progresso via polling + toast (não bloqueia a aba).
 */

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
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
  CalendarRange,
  CheckCircle2,
  XCircle,
  PlayCircle,
  Users2,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import {
  runPeriodoEnquadramentoInBackground,
  type LogEntry,
} from "@/lib/monitoramentoJobPoll";

type FundPair = { fundo_cnpj: string; fundo_isin: string };

function parseFundKey(key: string): FundPair {
  const [cnpj, isin = ""] = key.split("|");
  return { fundo_cnpj: cnpj, fundo_isin: isin };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableDates: string[];
  availableDatesMap: Set<string>;
  selectedFundsCnpjs: Set<string>;
  funds: Array<{ fundo_cnpj: string; nome_fundo?: string | null }>;
  queryClient: QueryClient;
}

const formatDateToDB = (d: Date) => format(d, "yyyyMMdd");
const cleanCnpj = (s: string) => String(s ?? "").replace(/\D/g, "");
const BATCH_LIMIT = 5;

export function EnquadramentoPeriodoDialog({
  open,
  onOpenChange,
  availableDates,
  availableDatesMap,
  selectedFundsCnpjs,
  funds,
  queryClient,
}: Props) {
  const [rangeStartDate, setRangeStartDate] = useState<Date | undefined>(undefined);
  const [rangeEndDate, setRangeEndDate] = useState<Date | undefined>(undefined);
  const [processing, setProcessing] = useState(false);
  const [finished, setFinished] = useState(false);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [erros, setErros] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const cancelRef = useRef(false);
  const toastIdRef = useRef<string | number | undefined>(undefined);

  const rangeDatesInPeriod = useMemo(() => {
    if (!rangeStartDate || !rangeEndDate) return [];
    const startStr = formatDateToDB(rangeStartDate <= rangeEndDate ? rangeStartDate : rangeEndDate);
    const endStr = formatDateToDB(rangeStartDate <= rangeEndDate ? rangeEndDate : rangeStartDate);
    return availableDates
      .filter((d) => d >= startStr && d <= endStr)
      .sort((a, b) => a.localeCompare(b));
  }, [rangeStartDate, rangeEndDate, availableDates]);

  const nomeMap = useMemo(
    () => new Map(funds.map((f) => [cleanCnpj(f.fundo_cnpj), f.nome_fundo || f.fundo_cnpj])),
    [funds],
  );

  const invalidateQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["funds-list"] });
    queryClient.invalidateQueries({ queryKey: ["enquadramento-rules"] });
    queryClient.invalidateQueries({ queryKey: ["enquadramento-rules-summary"] });
    queryClient.invalidateQueries({ queryKey: ["enquadramento-timeline"] });
    queryClient.invalidateQueries({ queryKey: ["mm-tributaria-historico"] });
    queryClient.invalidateQueries({ queryKey: ["fund-status-header"] });
  }, [queryClient]);

  const resetState = useCallback(() => {
    setFinished(false);
    setFailed(false);
    setProgress(0);
    setTotal(0);
    setErros(0);
    setLog([]);
  }, []);

  const handleClose = useCallback(() => {
    if (processing) {
      toast.info("Verificação continua em segundo plano. Acompanhe pelo toast.", { duration: 6000 });
      onOpenChange(false);
      return;
    }
    resetState();
    onOpenChange(false);
  }, [processing, onOpenChange, resetState]);

  const handleRunRangeChecks = useCallback(async () => {
    if (rangeDatesInPeriod.length === 0) return;

    const dataInicio = rangeDatesInPeriod[0];
    const dataFim = rangeDatesInPeriod[rangeDatesInPeriod.length - 1];
    const fundosFiltro =
      selectedFundsCnpjs.size > 0
        ? [...selectedFundsCnpjs].map(parseFundKey)
        : undefined;

    cancelRef.current = false;
    setProcessing(true);
    setFinished(false);
    setFailed(false);
    setProgress(0);
    setTotal(0);
    setErros(0);
    setLog([]);

    const toastId = toast.loading("Iniciando verificação por período em segundo plano...");
    toastIdRef.current = toastId;

    try {
      const { job } = await runPeriodoEnquadramentoInBackground({
        dataInicio,
        dataFim,
        datasPeriodo: rangeDatesInPeriod,
        fundosFiltro,
        batchLimit: BATCH_LIMIT,
        expectedMin: 1,
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
            `Verificando período… ${j.processados}/${j.total_pares}` +
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
        toast.error("Verificação falhou. Veja Configurações → Monitoramento → histórico.", { id: toastId });
        return;
      }

      if (job.processados === 0 && job.total_pares === 0) {
        setFailed(true);
        toast.error("Nenhum par processado. Verifique deploy de batch-monitoramento e migration 20260718.", {
          id: toastId,
        });
        return;
      }

      toast.success(
        `Concluído — ${job.processados} verificaç${job.processados !== 1 ? "ões" : "ão"}` +
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
  }, [
    rangeDatesInPeriod,
    selectedFundsCnpjs,
    invalidateQueries,
  ]);

  useEffect(() => {
    if (open && processing) {
      toast.loading(`Verificando… ${progress}/${total}`, { id: toastIdRef.current });
    }
  }, [open, processing, progress, total]);

  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  const showResult = finished || failed;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); else onOpenChange(true); }}>
      <DialogContent className="sm:max-w-xl">
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
              <CalendarRange className="w-5 h-5 text-primary" />
            )}
            {processing
              ? "Verificando em segundo plano…"
              : failed
              ? "Erro na verificação"
              : finished
              ? "Verificação de período concluída"
              : "Rodar Verificação por Período"}
          </DialogTitle>
          <DialogDescription>
            {processing
              ? "O job roda no servidor — você pode fechar esta janela. Progresso no toast."
              : failed
              ? "Falha ao processar. Confira deploy de batch-monitoramento e migration 20260718."
              : finished
              ? `${progress} par${progress !== 1 ? "es" : ""} verificado${progress !== 1 ? "s" : ""}` +
                (erros > 0 ? ` — ${erros} com erro` : " sem erros")
              : "Selecione o intervalo de datas. Apenas datas com posição importada são exibidas."}
          </DialogDescription>
        </DialogHeader>

        {!processing && !showResult && (
          <div className="space-y-4 py-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Data Início</p>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className={cn("w-full justify-start text-left font-normal h-9 text-xs", !rangeStartDate && "text-muted-foreground")}>
                      <CalendarIcon className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                      {rangeStartDate ? format(rangeStartDate, "dd/MM/yyyy") : "Selecionar..."}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={rangeStartDate}
                      onSelect={(d) => { if (d) setRangeStartDate(d); }}
                      initialFocus
                      locale={ptBR}
                      modifiers={{ hasData: (d) => availableDatesMap.has(formatDateToDB(d)) }}
                      modifiersClassNames={{ hasData: "font-bold text-primary underline underline-offset-4 decoration-primary/50" }}
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-1.5">
                <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Data Fim</p>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className={cn("w-full justify-start text-left font-normal h-9 text-xs", !rangeEndDate && "text-muted-foreground")}>
                      <CalendarIcon className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                      {rangeEndDate ? format(rangeEndDate, "dd/MM/yyyy") : "Selecionar..."}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="end">
                    <Calendar
                      mode="single"
                      selected={rangeEndDate}
                      onSelect={(d) => { if (d) setRangeEndDate(d); }}
                      initialFocus
                      locale={ptBR}
                      modifiers={{ hasData: (d) => availableDatesMap.has(formatDateToDB(d)) }}
                      modifiersClassNames={{ hasData: "font-bold text-primary underline underline-offset-4 decoration-primary/50" }}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <Users2 className="h-3.5 w-3.5 shrink-0" />
              {selectedFundsCnpjs.size === 0 ? (
                <span>Processando <strong className="text-foreground">todos os fundos</strong> de cada data</span>
              ) : (
                <span>
                  <strong className="text-foreground">{selectedFundsCnpjs.size} fundo{selectedFundsCnpjs.size !== 1 ? "s" : ""}</strong> selecionado{selectedFundsCnpjs.size !== 1 ? "s" : ""} em cada data
                </span>
              )}
            </div>

            {rangeStartDate && rangeEndDate && (
              <div className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm",
                rangeDatesInPeriod.length === 0
                  ? "border-amber-200 bg-amber-50 text-amber-700"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700",
              )}>
                <CalendarRange className="h-4 w-4 shrink-0" />
                {rangeDatesInPeriod.length === 0 ? (
                  <span>Nenhuma data com posição importada neste intervalo.</span>
                ) : (
                  <span>
                    <strong>{rangeDatesInPeriod.length}</strong> {rangeDatesInPeriod.length === 1 ? "data" : "datas"} com posição
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {(processing || showResult) && (
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-muted-foreground uppercase tracking-wide">Enquadramento</span>
                <span className="font-medium tabular-nums">{progress} / {total} pares</span>
              </div>
              <Progress value={pct} className="h-2" />
            </div>

            {processing && (
              <p className="text-xs text-muted-foreground">
                Pode fechar esta janela — a verificação continua no servidor.
              </p>
            )}

            {erros > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-amber-600">
                <AlertTriangle className="h-3.5 w-3.5" />
                {erros} erro{erros !== 1 ? "s" : ""} durante a verificação
              </div>
            )}

            {log.length > 0 && (
              <div className="max-h-[260px] overflow-y-auto space-y-0.5 border rounded-lg p-2 bg-muted/10">
                {[...log].reverse().slice(0, 50).map((r, i) => {
                  const nome = nomeMap.get(cleanCnpj(r.cnpj)) || r.cnpj;
                  return (
                    <div key={i} className="flex items-center gap-2 text-xs py-1 px-1 rounded hover:bg-muted/50">
                      {r.ok_eq ? (
                        <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
                      ) : (
                        <XCircle className="w-3 h-3 text-red-500 shrink-0" />
                      )}
                      <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                        {r.data?.slice(6, 8)}/{r.data?.slice(4, 6)}
                      </span>
                      <span className="truncate flex-1 font-medium">{nome}</span>
                    </div>
                  );
                })}
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
              <Button variant="outline" size="sm" onClick={() => { cancelRef.current = true; }}>
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
                className="bg-black hover:bg-black/90 text-white gap-2"
                disabled={rangeDatesInPeriod.length === 0}
                onClick={handleRunRangeChecks}
              >
                <PlayCircle className="h-3.5 w-3.5" />
                Verificar {rangeDatesInPeriod.length > 0 ? `(${rangeDatesInPeriod.length} ${rangeDatesInPeriod.length === 1 ? "data" : "datas"})` : ""}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
