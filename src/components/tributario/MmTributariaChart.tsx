/**
 * Histórico da média móvel tributária de 10 dias úteis (FIQ — IN RFB 1585/2015 Art. 5º).
 * Dados: enquadramento_tributario_historico
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { calcularContadoresAnoFromSeries, aplicarMm10dRecalculada } from "@/lib/tributarioMm10d";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface HistoricoRow {
  data_referencia: string;
  p_dia: number;
  mm_10d: number;
  em_violacao: boolean;
  eventos_ano: number;
  dias_violacao_ano: number;
  valor_lp?: number | null;
  valor_cp?: number | null;
  valor_excluido?: number | null;
  pl_total?: number | null;
}

interface ChartPoint {
  data: string;
  dataFull: string;
  p_dia: number;
  mm_10d: number;
  em_violacao: boolean;
  eventos_ano: number;
  dias_violacao_ano: number;
}

type StatusMm = "ok" | "alerta" | "violacao";

const LIMITE_MM = 90;
const ALERTA_MM = 92;

function cnpjVariants(cnpj: string): string[] {
  const clean = cnpj.replace(/\D/g, "").padStart(14, "0");
  const formatted = clean.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    "$1.$2.$3/$4-$5",
  );
  return [...new Set([cnpj, clean, formatted])].filter(Boolean);
}

/** fundo_dtposicao YYYYMMDD → YYYY-MM-DD */
export function dtPosicaoToIso(raw?: string): string | null {
  const ymd = raw?.replace(/\D/g, "").slice(0, 8);
  if (!ymd || ymd.length !== 8) return null;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

export function anoFromDtPosicao(raw?: string): number | null {
  const ymd = raw?.replace(/\D/g, "").slice(0, 8);
  if (!ymd || ymd.length !== 8) return null;
  return parseInt(ymd.slice(0, 4), 10);
}

function formatDataBr(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

function formatDataFullBr(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

function formatPct(v: number): string {
  return `${v.toFixed(2).replace(".", ",")}%`;
}

function getStatusMm(mm: number, eventosAno: number, diasAno: number): StatusMm {
  if (mm >= ALERTA_MM) return "ok";
  if (mm >= LIMITE_MM) return "alerta";
  if (eventosAno >= 3 || diasAno >= 45) return "violacao";
  return mm < LIMITE_MM ? "violacao" : "alerta";
}

const STATUS_STYLES: Record<
  StatusMm,
  { text: string; bg: string; label: string }
> = {
  ok: {
    text: "text-emerald-600",
    bg: "bg-emerald-100 text-emerald-700 border-emerald-200",
    label: "enquadrado",
  },
  alerta: {
    text: "text-amber-600",
    bg: "bg-amber-100 text-amber-700 border-amber-200",
    label: "atenção",
  },
  violacao: {
    text: "text-red-600",
    bg: "bg-red-100 text-red-700 border-red-200",
    label: "violação",
  },
};

interface HistoricoFetchResult {
  rows: HistoricoRow[];
  fromHistorico: number;
  fromResultado: number;
}

function ymdPosicaoToIso(fundo_dtposicao: string): string | null {
  const ymd = fundo_dtposicao.replace(/\D/g, "").slice(0, 8);
  if (ymd.length !== 8) return null;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function rowFromEnquadramentoResultado(row: {
  fundo_dtposicao: string;
  detalhes: unknown;
  valor_atual: number | null;
}): HistoricoRow | null {
  const data_referencia = ymdPosicaoToIso(row.fundo_dtposicao);
  const d = row.detalhes as Record<string, unknown> | null;
  if (!data_referencia || !d) return null;

  const p_dia = d.p_dia != null ? Number(d.p_dia) : NaN;
  if (!Number.isFinite(p_dia)) return null;

  const mm_10d =
    d.mm_10d != null
      ? Number(d.mm_10d)
      : row.valor_atual != null
        ? Number(row.valor_atual) * 100
        : p_dia;

  return {
    data_referencia,
    p_dia,
    mm_10d: Number.isFinite(mm_10d) ? mm_10d : p_dia,
    em_violacao: (Number.isFinite(mm_10d) ? mm_10d : p_dia) < LIMITE_MM,
    eventos_ano: Number(d.eventos_ano) || 0,
    dias_violacao_ano: Number(d.dias_violacao_ano) || 0,
  };
}

/** Snapshots de enquadramento_resultado prevalecem (1 linha por data de posição). */
function mergeHistoricoSeries(
  historico: HistoricoRow[],
  resultado: HistoricoRow[],
): HistoricoRow[] {
  const map = new Map<string, HistoricoRow>();
  for (const r of historico) map.set(r.data_referencia, r);
  for (const r of resultado) map.set(r.data_referencia, r);
  return [...map.values()].sort((a, b) =>
    a.data_referencia.localeCompare(b.data_referencia),
  );
}

export function useMmHistorico(
  fundo_cnpj: string,
  dataAte?: string | null,
  regra_codigo?: string | null,
) {
  const codigoEfetivo = regra_codigo ?? "TRIB_FIQ_LP_90";
  return useQuery({
    queryKey: ["mm-tributaria-historico", fundo_cnpj, dataAte ?? "all", codigoEfetivo],
    enabled: !!fundo_cnpj,
    staleTime: 30_000,
    queryFn: async (): Promise<HistoricoFetchResult> => {
      const variants = cnpjVariants(fundo_cnpj);

      let histQuery = supabase
        .from("enquadramento_tributario_historico" as any)
        .select(
          "data_referencia, p_dia, mm_10d, em_violacao, eventos_ano, dias_violacao_ano, " +
          "valor_lp, valor_cp, valor_excluido, pl_total",
        )
        .in("fundo_cnpj", variants)
        .order("data_referencia", { ascending: true });

      if (dataAte) {
        histQuery = histQuery.lte("data_referencia", dataAte);
      }

      const resultadoQuery = supabase
        .from("enquadramento_resultado" as any)
        .select("fundo_dtposicao, detalhes, valor_atual")
        .in("fundo_cnpj", variants)
        .eq("regra_codigo", codigoEfetivo)
        .order("fundo_dtposicao", { ascending: true });

      const [{ data: histData, error: histErr }, { data: resData, error: resErr }] =
        await Promise.all([histQuery, resultadoQuery]);

      if (histErr) throw histErr;
      if (resErr) throw resErr;

      const fromHistorico = (histData ?? []) as HistoricoRow[];
      const fromResultado = (resData ?? [])
        .map((r) =>
          rowFromEnquadramentoResultado({
            fundo_dtposicao: String((r as { fundo_dtposicao: string }).fundo_dtposicao),
            detalhes: (r as { detalhes: unknown }).detalhes,
            valor_atual: (r as { valor_atual: number | null }).valor_atual,
          }),
        )
        .filter((r): r is HistoricoRow => r != null);

      let rows = mergeHistoricoSeries(fromHistorico, fromResultado);
      if (dataAte) {
        rows = rows.filter((r) => r.data_referencia <= dataAte);
      }

      // MM-10d sempre derivada da série p_dia (SMA) — evita mm EWMA defasada no banco
      rows = aplicarMm10dRecalculada(rows);

      return {
        rows,
        fromHistorico: fromHistorico.length,
        fromResultado: fromResultado.length,
      };
    },
  });
}

function filterRowsByAno(rows: HistoricoRow[], anoPreferido: number): {
  rows: HistoricoRow[];
  anoEfetivo: number;
  usouFallback: boolean;
} {
  const noAno = rows.filter((r) =>
    r.data_referencia.startsWith(`${anoPreferido}-`),
  );
  if (noAno.length > 0) {
    return { rows: noAno, anoEfetivo: anoPreferido, usouFallback: false };
  }

  const anos = [
    ...new Set(rows.map((r) => parseInt(r.data_referencia.slice(0, 4), 10))),
  ].filter((y) => !Number.isNaN(y));

  if (anos.length === 0) {
    return { rows: [], anoEfetivo: anoPreferido, usouFallback: false };
  }

  const anoEfetivo = Math.max(...anos);
  return {
    rows: rows.filter((r) => r.data_referencia.startsWith(`${anoEfetivo}-`)),
    anoEfetivo,
    usouFallback: anoEfetivo !== anoPreferido,
  };
}

function TooltipCustom({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;

  const mmStatus = getStatusMm(d.mm_10d, d.eventos_ano, d.dias_violacao_ano);

  return (
    <div className="rounded-lg border border-border bg-card px-3.5 py-2.5 text-xs shadow-sm min-w-[180px]">
      <p className="font-medium text-foreground mb-2">{formatDataFullBr(d.dataFull)}</p>
      <div className="flex justify-between gap-4 mb-1">
        <span className="text-muted-foreground">p do dia</span>
        <span className="font-mono font-medium text-[#378ADD]">{formatPct(d.p_dia)}</span>
      </div>
      <div className="flex justify-between gap-4 mb-2">
        <span className="text-muted-foreground">mm-10d</span>
        <span className={cn("font-mono font-medium", STATUS_STYLES[mmStatus].text)}>
          {formatPct(d.mm_10d)}
        </span>
      </div>
      {d.em_violacao && (
        <p className="text-center text-[10px] font-medium text-red-600 bg-red-50 rounded px-2 py-0.5">
          mm abaixo de 90% — violação
        </p>
      )}
    </div>
  );
}

export interface MmTributariaChartProps {
  fundo_cnpj: string;
  /** Ano-calendário preferido (ex.: extraído de fundo_dtposicao) */
  ano?: number;
  /** Limite superior da série — YYYY-MM-DD da data de posição exibida */
  dataAte?: string | null;
  /** Código da regra em enquadramento_resultado (default: TRIB_FIQ_LP_90) */
  regra_codigo?: string | null;
  className?: string;
}

export function MmTributariaChart({
  fundo_cnpj,
  ano = new Date().getFullYear(),
  dataAte = null,
  regra_codigo = null,
  className,
}: MmTributariaChartProps) {
  const { data: fetchResult, isLoading, error } = useMmHistorico(
    fundo_cnpj,
    dataAte,
    regra_codigo,
  );

  const allRows = fetchResult?.rows ?? [];
  const fromHistorico = fetchResult?.fromHistorico ?? 0;
  const fromResultado = fetchResult?.fromResultado ?? 0;
  const serieViaSnapshots =
    fromResultado > 0 &&
    (fromHistorico === 0 || fromResultado > fromHistorico);

  const { rows, anoEfetivo, usouFallback } = useMemo(
    () => filterRowsByAno(allRows, ano),
    [allRows, ano],
  );

  const anosDisponiveis = useMemo(
    () =>
      [...new Set(allRows.map((r) => r.data_referencia.slice(0, 4)))].sort(),
    [allRows],
  );

  const ultimo = rows.length > 0 ? rows[rows.length - 1] : null;

  const contadoresAno = useMemo(
    () =>
      calcularContadoresAnoFromSeries(
        rows.map((r) => ({
          data_referencia: r.data_referencia,
          mm_10d: Number(r.mm_10d),
        })),
      ),
    [rows],
  );

  const statusAtual: StatusMm = ultimo
    ? getStatusMm(ultimo.mm_10d, contadoresAno.eventos_ano, contadoresAno.dias_violacao_ano)
    : "ok";

  const chartData: ChartPoint[] = useMemo(
    () =>
      rows.map((r) => ({
        data: formatDataBr(r.data_referencia),
        dataFull: r.data_referencia,
        p_dia: Math.round(Number(r.p_dia) * 100) / 100,
        mm_10d: Math.round(Number(r.mm_10d) * 100) / 100,
        em_violacao: Number(r.mm_10d) < LIMITE_MM,
        eventos_ano: Number(r.eventos_ano) || 0,
        dias_violacao_ano: Number(r.dias_violacao_ano) || 0,
      })),
    [rows],
  );

  const [historicoTableOpen, setHistoricoTableOpen] = useState(false);

  const historicoRows = useMemo(
    () => [...chartData].reverse(),
    [chartData],
  );

  const yMin = useMemo(() => {
    if (rows.length === 0) return 0;
    const minP = Math.min(...rows.map((r) => Number(r.p_dia)));
    return Math.max(0, Math.floor((minP - 5) / 10) * 10);
  }, [rows]);

  if (isLoading) {
    return (
      <div
        className={cn(
          "flex items-center justify-center gap-2 rounded-lg bg-muted/30 py-8 text-sm text-muted-foreground",
          className,
        )}
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        Carregando histórico...
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={cn(
          "rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700",
          className,
        )}
      >
        Erro ao carregar histórico: {(error as Error).message}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
        className={cn(
          "rounded-lg bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        <p>
          Nenhum registro de mm tributária
          {allRows.length === 0
            ? " para este fundo."
            : ` em ${ano} (calendário da data exibida).`}
        </p>
        {allRows.length > 0 && anosDisponiveis.length > 0 && (
          <p className="text-xs mt-1 text-amber-700 dark:text-amber-400">
            Existem {allRows.length} registro(s) em:{" "}
            {anosDisponiveis.join(", ")}. Rode o check também nessas datas ou
            abra uma posição desses anos.
          </p>
        )}
        {allRows.length === 0 && (
          <p className="text-xs mt-1">
            Confirme: migration `20260520_enquadramento_tributario` aplicada,
            regra TRIB_FIQ_LP_90 ativa em fundo_regras, e check-enquadramento com
            categoria <code className="text-[10px]">tributario</code> em cada data
            com XML importado.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {usouFallback && (
        <p className="text-[10px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded px-2 py-1">
          Sem dados em {ano}; exibindo série de {anoEfetivo} ({rows.length}{" "}
          dia{rows.length !== 1 ? "s" : ""}).
        </p>
      )}

      {serieViaSnapshots && (
        <p className="text-[10px] text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded px-2 py-1">
          Série montada a partir dos checks salvos ({fromResultado} data
          {fromResultado !== 1 ? "s" : ""} em enquadramento_resultado).
          {fromHistorico > 0 &&
            ` Tabela de histórico tem apenas ${fromHistorico} linha${fromHistorico !== 1 ? "s" : ""} — rode “Verificação por período” em cada data para preencher enquadramento_tributario_historico.`}
          {fromHistorico === 0 &&
            " Rode “Verificação por período” (02/01 → hoje) para gravar também enquadramento_tributario_historico."}
        </p>
      )}

      {/* Cards resumo */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div className="rounded-lg bg-muted/40 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground mb-0.5">mm-10d atual</p>
          <p className={cn("font-mono text-lg font-semibold", STATUS_STYLES[statusAtual].text)}>
            {ultimo ? formatPct(ultimo.mm_10d) : "—"}
          </p>
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground mb-0.5">p do dia</p>
          <p className="font-mono text-lg font-semibold text-foreground">
            {ultimo ? formatPct(ultimo.p_dia) : "—"}
          </p>
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground mb-0.5">limite</p>
          <p className="font-mono text-lg font-semibold text-foreground">90,00%</p>
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground mb-0.5">status</p>
          <span
            className={cn(
              "inline-block text-[10px] font-semibold uppercase px-2 py-0.5 rounded border",
              STATUS_STYLES[statusAtual].bg,
            )}
          >
            {STATUS_STYLES[statusAtual].label}
          </span>
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground mb-0.5">eventos no ano</p>
          <p
            className={cn(
              "font-mono text-lg font-semibold",
              ultimo && contadoresAno.eventos_ano >= 3
                ? "text-red-600"
                : ultimo && contadoresAno.eventos_ano >= 2
                  ? "text-amber-600"
                  : "text-foreground",
            )}
          >
            {ultimo ? `${contadoresAno.eventos_ano} / 3` : "—"}
          </p>
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground mb-0.5">dias em violação</p>
          <p
            className={cn(
              "font-mono text-lg font-semibold",
              ultimo && contadoresAno.dias_violacao_ano >= 45
                ? "text-red-600"
                : ultimo && contadoresAno.dias_violacao_ano >= 30
                  ? "text-amber-600"
                  : "text-foreground",
            )}
          >
            {ultimo ? `${contadoresAno.dias_violacao_ano} / 45` : "—"}
          </p>
        </div>
      </div>

      {/* Legenda */}
      <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-[#378ADD]" />
          p do dia (% LP)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-[#1D9E75]" />
          mm-10d
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-amber-200/80" />
          alerta (90–92%)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-red-200/80" />
          violação (&lt; 90%)
        </span>
      </div>

      {/* Gráfico */}
      <div className="w-full h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" vertical={false} />
            <XAxis
              dataKey="data"
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[yMin, 100]}
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `${v}%`}
              width={40}
            />
            <Tooltip content={<TooltipCustom />} />
            <ReferenceArea
              y1={yMin}
              y2={LIMITE_MM}
              fill="rgba(226,75,74,0.10)"
              stroke="none"
            />
            <ReferenceArea
              y1={LIMITE_MM}
              y2={ALERTA_MM}
              fill="rgba(250,199,117,0.35)"
              stroke="none"
            />
            <ReferenceLine
              y={LIMITE_MM}
              stroke="#E24B4A"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
            <ReferenceLine
              y={ALERTA_MM}
              stroke="#D97706"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
            <Line
              type="monotone"
              dataKey="p_dia"
              stroke="#378ADD"
              strokeWidth={2}
              dot={{ r: 3, fill: "#378ADD", strokeWidth: 0 }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="mm_10d"
              stroke="#1D9E75"
              strokeWidth={2}
              isAnimationActive={false}
              dot={(props) => {
                const { cx, cy, payload } = props as {
                  cx?: number;
                  cy?: number;
                  payload?: ChartPoint;
                };
                if (cx == null || cy == null) return null;
                const fill = payload?.em_violacao ? "#E24B4A" : "#1D9E75";
                return (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={4}
                    fill={fill}
                    stroke="#fff"
                    strokeWidth={1}
                  />
                );
              }}
              activeDot={{ r: 6 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Tabela histórico — oculta por padrão, 10 linhas visíveis + scroll */}
      <div className="rounded-lg border border-border/60 overflow-hidden">
        <button
          type="button"
          onClick={() => setHistoricoTableOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-muted/40 transition-colors"
        >
          {historicoTableOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          Histórico diário
          <span className="font-normal normal-case tracking-normal text-muted-foreground/80">
            ({historicoRows.length} dia{historicoRows.length !== 1 ? "s" : ""})
          </span>
        </button>

        {historicoTableOpen && (
          <div className="max-h-[22rem] overflow-y-auto border-t border-border/60">
            <Table>
              <TableHeader>
                <TableRow className="sticky top-0 z-10 bg-muted/95 hover:bg-muted/95 backdrop-blur-sm border-b border-border/60">
                  <TableHead className="text-[10px] h-8">data</TableHead>
                  <TableHead className="text-[10px] h-8 text-right">p do dia</TableHead>
                  <TableHead className="text-[10px] h-8 text-right">mm-10d</TableHead>
                  <TableHead className="text-[10px] h-8 text-right">limite</TableHead>
                  <TableHead className="text-[10px] h-8 text-right">status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {historicoRows.map((row) => {
                  const st = getStatusMm(row.mm_10d, row.eventos_ano, row.dias_violacao_ano);
                  return (
                    <TableRow key={row.dataFull} className="h-8">
                      <TableCell className="text-[10px] py-1 font-mono">
                        {formatDataBr(row.dataFull)}
                      </TableCell>
                      <TableCell className="text-[10px] py-1 text-right font-mono text-[#378ADD]">
                        {formatPct(row.p_dia)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-[10px] py-1 text-right font-mono font-medium",
                          STATUS_STYLES[st].text,
                        )}
                      >
                        {formatPct(row.mm_10d)}
                      </TableCell>
                      <TableCell className="text-[10px] py-1 text-right font-mono text-muted-foreground">
                        90,00%
                      </TableCell>
                      <TableCell className="text-[10px] py-1 text-right">
                        <span
                          className={cn(
                            "inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold border",
                            STATUS_STYLES[st].bg,
                          )}
                        >
                          {STATUS_STYLES[st].label}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
