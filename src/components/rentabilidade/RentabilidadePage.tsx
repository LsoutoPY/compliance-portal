import { useMemo, useState, useEffect } from "react";
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
  Tooltip as TooltipUI,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LineChart as LineChartIcon, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { format, lastDayOfMonth, parseISO } from "date-fns";
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
  subtractDaysIso,
  dedupSeriePuPorData,
  expandAtivoKeyAliases,
} from "@/hooks/useRentabilidadeCalc";
import type { RentabilidadeAtivoRow } from "@/hooks/useRentabilidadeData";
import {
  useRentabilidadeAtivos,
  useRentabilidadeDatas,
  useRentabilidadeFundos,
  fetchHistoricoPuFundos,
  fetchSnapshotsFundoClasse,
} from "@/hooks/useRentabilidadeData";
import { useCDI } from "@/hooks/useCDI";
import { RetComPctCdiCell } from "@/components/rentabilidade/RetComPctCdiCell";

/** Chave segura para dataKey do Recharts (evita caracteres especiais do ativo_key). */
function chartDataKey(index: number): string {
  return `ativo_${index}`;
}

const PERIODOS_GRAFICO = [
  { id: "dia", label: "Dia" },
  { id: "d5", label: "5d" },
  { id: "d30", label: "30d" },
  { id: "d60", label: "60d" },
  { id: "d90", label: "90d" },
  { id: "mes", label: "Mês" },
  { id: "ano", label: "Ano" },
] as const;

type PeriodoGrafico = (typeof PERIODOS_GRAFICO)[number]["id"];

const DIAS_JANELA: Partial<Record<PeriodoGrafico, number>> = {
  d5: 5,
  d30: 30,
  d60: 60,
  d90: 90,
};

const YEAR_MONTH_RE = /^\d{4}-\d{2}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidYearMonth(mes: string): boolean {
  return YEAR_MONTH_RE.test(mes);
}

function isValidIsoDate(iso: string): boolean {
  if (!ISO_DATE_RE.test(iso)) return false;
  return !Number.isNaN(parseISO(iso).getTime());
}

function formatIsoDateSafe(
  iso: string,
  pattern: string,
  fallback = "—",
): string {
  if (!isValidIsoDate(iso)) return fallback;
  return format(parseISO(iso), pattern, { locale: ptBR });
}

/** Último dia do mês (ISO) a partir de "YYYY-MM". */
function lastDayOfMonthIso(yearMonth: string): string {
  if (!isValidYearMonth(yearMonth)) return "";
  const [y, m] = yearMonth.split("-").map(Number);
  return format(lastDayOfMonth(new Date(y, m - 1, 1)), "yyyy-MM-dd");
}

/** Limites do mês selecionado, respeitando a data de referência. Retorna null se mês inteiro é futuro. */
function periodoMesBounds(
  mesAlvo: string,
  dataRef: string,
): { inicio: string; fim: string } | null {
  if (!isValidYearMonth(mesAlvo)) return null;
  const inicio = `${mesAlvo}-01`;
  if (inicio > dataRef) return null;
  const fimMes = lastDayOfMonthIso(mesAlvo);
  if (!fimMes) return null;
  return { inicio, fim: fimMes <= dataRef ? fimMes : dataRef };
}

/** Limites do ano civil selecionado, respeitando a data de referência. Retorna null se ano inteiro é futuro. */
function periodoAnoBounds(
  anoAlvo: number,
  dataRef: string,
): { inicio: string; fim: string } | null {
  const inicio = `${anoAlvo}-01-01`;
  if (inicio > dataRef) return null;
  const fimAno = `${anoAlvo}-12-31`;
  return { inicio, fim: fimAno <= dataRef ? fimAno : dataRef };
}

function formatMesAnoLabel(mesAlvo: string): string {
  return formatIsoDateSafe(`${mesAlvo}-01`, "MMMM/yyyy");
}

interface PeriodoGraficoFiltro<T extends { data_posicao: string }> {
  pontos: T[];
  dataInicioPeriodo: string | null;
  usaJanelaFixa: boolean;
  dataLabel: (dataIso: string) => string;
}

/** Filtra série temporal conforme o período do gráfico (cálculo inalterado para dia/5d/30d/60d/90d). */
function filtrarSeriePorPeriodo<T extends { data_posicao: string }>(
  sorted: T[],
  dataRef: string,
  periodo: PeriodoGrafico,
  mesAlvo: string,
  anoAlvo: number,
): PeriodoGraficoFiltro<T> {
  let pontos = sorted;
  let dataInicioPeriodo: string | null = null;
  let usaJanelaFixa = false;

  if (periodo === "dia") {
    pontos = sorted.slice(-5);
    dataInicioPeriodo = pontos[0]?.data_posicao ?? null;
    usaJanelaFixa = true;
  } else if (
    periodo === "d5" ||
    periodo === "d30" ||
    periodo === "d60" ||
    periodo === "d90"
  ) {
    const dias = DIAS_JANELA[periodo] ?? 30;
    dataInicioPeriodo = subtractDaysIso(dataRef, dias);
    pontos = sorted.filter((s) => s.data_posicao >= dataInicioPeriodo!);
    usaJanelaFixa = true;
  } else if (periodo === "mes") {
    const bounds = periodoMesBounds(mesAlvo, dataRef);
    if (bounds) {
      const { inicio, fim } = bounds;
      dataInicioPeriodo = inicio;
      pontos = sorted.filter(
        (s) => s.data_posicao >= inicio && s.data_posicao <= fim,
      );
      usaJanelaFixa = true;
    } else {
      pontos = [];
    }
  } else if (periodo === "ano") {
    const bounds = periodoAnoBounds(anoAlvo, dataRef);
    if (bounds) {
      const { inicio, fim } = bounds;
      dataInicioPeriodo = inicio;
      const porMes = new Map<string, T>();
      for (const s of sorted) {
        if (s.data_posicao < inicio || s.data_posicao > fim) continue;
        const mesAno = s.data_posicao.slice(0, 7);
        const existente = porMes.get(mesAno);
        if (!existente || s.data_posicao > existente.data_posicao) {
          porMes.set(mesAno, s);
        }
      }
      pontos = Array.from(porMes.values()).sort((a, b) =>
        a.data_posicao.localeCompare(b.data_posicao),
      );
      usaJanelaFixa = true;
    } else {
      pontos = [];
    }
  }

  const dataLabel = (dataIso: string): string => {
    if (periodo === "ano") {
      return formatIsoDateSafe(dataIso, "MMM/yy", dataIso);
    }
    if (periodo === "mes" || DIAS_JANELA[periodo] != null || periodo === "dia") {
      return formatIsoDateSafe(dataIso, "dd/MM", dataIso);
    }
    return formatIsoDateSafe(dataIso, "dd/MM/yyyy", dataIso);
  };

  return { pontos, dataInicioPeriodo, usaJanelaFixa, dataLabel };
}

function PeriodoGraficoControles({
  periodo,
  onPeriodo,
  mesAlvo,
  onMesAlvo,
  anoAlvo,
  onAnoAlvo,
  mesesDisponiveis,
  anosDisponiveis,
  className,
}: {
  periodo: PeriodoGrafico;
  onPeriodo: (p: PeriodoGrafico) => void;
  mesAlvo: string;
  onMesAlvo: (mes: string) => void;
  anoAlvo: number;
  onAnoAlvo: (ano: number) => void;
  mesesDisponiveis: string[];
  anosDisponiveis: number[];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-end gap-2", className)}>
      {periodo === "mes" && mesesDisponiveis.length > 0 && (
        <select
          value={mesesDisponiveis.includes(mesAlvo) ? mesAlvo : mesesDisponiveis[0]}
          onChange={(e) => onMesAlvo(e.target.value)}
          className="h-7 px-2 text-xs rounded border border-gray-200 bg-white text-gray-700"
          aria-label="Selecionar mês"
        >
          {mesesDisponiveis.map((mes) => (
            <option key={mes} value={mes}>
              {formatMesAnoLabel(mes)}
            </option>
          ))}
        </select>
      )}
      {periodo === "ano" && anosDisponiveis.length > 0 && (
        <select
          value={anosDisponiveis.includes(anoAlvo) ? anoAlvo : anosDisponiveis[0]}
          onChange={(e) => onAnoAlvo(Number(e.target.value))}
          className="h-7 px-2 text-xs rounded border border-gray-200 bg-white text-gray-700"
          aria-label="Selecionar ano"
        >
          {anosDisponiveis.map((ano) => (
            <option key={ano} value={ano}>
              {ano}
            </option>
          ))}
        </select>
      )}
      <div className="flex flex-wrap justify-end gap-1.5">
        {PERIODOS_GRAFICO.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => onPeriodo(id)}
            className={cn(
              "px-2.5 py-1 text-xs rounded border transition-colors",
              periodo === id
                ? "bg-blue-600 text-white border-blue-600"
                : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50",
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function tituloPeriodoAcumulado(
  periodo: PeriodoGrafico,
  alvo: "fundo" | "ativos",
  mesAlvo: string,
  anoAlvo: number,
): string {
  const base =
    alvo === "fundo"
      ? "Retorno acumulado — cota do fundo"
      : "Retorno acumulado dos ativos";
  if (periodo === "dia") return `${base} — variação diária (últimos dias)`;
  const dias = DIAS_JANELA[periodo];
  if (dias) return `${base} — últimos ${dias} dias`;
  if (periodo === "mes") {
    return `${base} — ${formatMesAnoLabel(mesAlvo)} (diário)`;
  }
  if (periodo === "ano") return `${base} — ${anoAlvo} (mensal)`;
  return base;
}

function tituloPeriodoBarraAtivos(
  periodo: PeriodoGrafico,
  dataRef: string,
  mesAlvo: string,
  anoAlvo: number,
): string {
  if (periodo === "dia") {
    return `Variação por ativo — dia (${fmtData(dataRef)})`;
  }
  const dias = DIAS_JANELA[periodo];
  if (dias) return `Variação por ativo — últimos ${dias} dias`;
  if (periodo === "mes") {
    return `Variação por ativo — ${formatMesAnoLabel(mesAlvo)}`;
  }
  if (periodo === "ano") return `Variação por ativo — ${anoAlvo}`;
  return "Variação por ativo";
}

function labelMetricaBarra(periodo: PeriodoGrafico): string {
  if (periodo === "dia") return "Var. dia";
  const dias = DIAS_JANELA[periodo];
  if (dias) return `Var. ${dias}d acum.`;
  if (periodo === "mes") return "Var. mês";
  if (periodo === "ano") return "Var. ano";
  return "Variação";
}

function mensagemGraficoVazio(
  periodo: PeriodoGrafico,
  mesAlvo: string,
  anoAlvo: number,
): string {
  if (periodo === "mes") {
    return `Sem snapshots de cota em ${formatMesAnoLabel(mesAlvo)}.`;
  }
  if (periodo === "ano") {
    return `Sem snapshots de cota em ${anoAlvo}.`;
  }
  return "Sem dados para o período selecionado.";
}

const BAR_COLUMN_WIDTH = 52;
const BAR_CHART_HEIGHT = 300;

function truncateChartLabel(text: string, max = 22): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function retornoAcumPuNoPeriodo(
  serie: Array<{ data_posicao: string; pu_posicao: number }>,
  data: string,
  dataInicioPeriodo: string,
): number | null {
  const base =
    [...serie]
      .filter((p) => p.data_posicao <= dataInicioPeriodo)
      .sort((a, b) => b.data_posicao.localeCompare(a.data_posicao))[0] ??
    serie.find((p) => p.data_posicao >= dataInicioPeriodo);
  const hoje = serie.find((p) => p.data_posicao === data);
  if (!base || !hoje || base.pu_posicao === 0) return null;
  return (hoje.pu_posicao / base.pu_posicao - 1) * 100;
}

const CORES_ATIVOS = [
  "#3B82F6", // blue-500
  "#10B981", // emerald-500
  "#F59E0B", // amber-500
  "#EF4444", // red-500
  "#8B5CF6", // violet-500
  "#EC4899", // pink-500
  "#06B6D4", // cyan-500
  "#F97316", // orange-500
  "#14B8A6", // teal-500
  "#A855F7", // purple-500
];

interface RentabilidadePageProps {
  cnpj: string;
  isin?: string | null;
}

function pctColor(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v > 0) return "text-emerald-600 dark:text-emerald-400";
  if (v < 0) return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
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
    <TooltipUI>
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
    </TooltipUI>
  );
}

export function RentabilidadePage({ cnpj, isin = null }: RentabilidadePageProps) {
  const { data: datas = [], isLoading: datasLoading } = useRentabilidadeDatas();
  const [dataRef, setDataRef] = useState<string | null>(null);
  const [aba, setAba] = useState<'fundo' | 'ativos'>('fundo');
  const [periodo, setPeriodo] = useState<PeriodoGrafico>("mes");
  const [mesAlvo, setMesAlvo] = useState<string>("");
  const [anoAlvo, setAnoAlvo] = useState<number>(new Date().getFullYear());
  const [historicoPu, setHistoricoPu] = useState<
    Array<{ ativo_key: string; data_posicao: string; pu_posicao: number }>
  >([]);
  const [snapshotsFundo, setSnapshotsFundo] = useState<
    Array<{ data_posicao: string; valor_cota: number }>
  >([]);

  const selectedDate = dataRef ?? datas[0] ?? null;

  useEffect(() => {
    if (!selectedDate) return;
    setMesAlvo(selectedDate.slice(0, 7));
    setAnoAlvo(parseInt(selectedDate.slice(0, 4), 10));
  }, [selectedDate]);

  const mesesDisponiveis = useMemo(() => {
    const meses = new Set<string>();
    const maxMes = selectedDate?.slice(0, 7);
    for (const s of snapshotsFundo) {
      if (selectedDate && s.data_posicao > selectedDate) continue;
      const mes = s.data_posicao.slice(0, 7);
      if (maxMes && mes > maxMes) continue;
      meses.add(mes);
    }
    return [...meses].sort((a, b) => b.localeCompare(a));
  }, [snapshotsFundo, selectedDate]);

  const mesAlvoEfetivo =
    mesAlvo || selectedDate?.slice(0, 7) || mesesDisponiveis[0] || "";

  const anosDisponiveis = useMemo(() => {
    const anos = new Set<number>();
    const maxAno = selectedDate
      ? parseInt(selectedDate.slice(0, 4), 10)
      : null;
    for (const s of snapshotsFundo) {
      if (selectedDate && s.data_posicao > selectedDate) continue;
      const ano = parseInt(s.data_posicao.slice(0, 4), 10);
      if (maxAno != null && ano > maxAno) continue;
      anos.add(ano);
    }
    return [...anos].sort((a, b) => b - a);
  }, [snapshotsFundo, selectedDate]);

  useEffect(() => {
    if (mesesDisponiveis.length && !mesesDisponiveis.includes(mesAlvo)) {
      const preferido = selectedDate?.slice(0, 7);
      const fallback =
        preferido && mesesDisponiveis.includes(preferido)
          ? preferido
          : mesesDisponiveis[0];
      setMesAlvo(fallback);
    }
  }, [mesesDisponiveis, mesAlvo, selectedDate]);

  useEffect(() => {
    if (anosDisponiveis.length && !anosDisponiveis.includes(anoAlvo)) {
      const preferido = selectedDate
        ? parseInt(selectedDate.slice(0, 4), 10)
        : null;
      const fallback =
        preferido != null && anosDisponiveis.includes(preferido)
          ? preferido
          : anosDisponiveis[0];
      setAnoAlvo(fallback);
    }
  }, [anosDisponiveis, anoAlvo, selectedDate]);

  const { fundos, isLoading, error, refetch, cdiDisponivel } =
    useRentabilidadeFundos(selectedDate);

  const fundo = useMemo(
    () =>
      fundos.find(
        (f) => f.fundo_cnpj === cnpj && (isin ? f.fundo_isin === isin : true),
      ),
    [fundos, cnpj, isin],
  );

  const dataMin = selectedDate ? subtractDaysIso(selectedDate, 560) : null;
  const { cdiDict } = useCDI(dataMin ?? "", selectedDate ?? "");

  const { data: ativos = [], isLoading: ativosLoading } =
    useRentabilidadeAtivos(
      cnpj,
      fundo?.fundo_isin ?? isin,
      fundo?.nome_fundo ?? null,
      selectedDate,
      fundo?.pl ?? null,
      cdiDict,
      !!selectedDate && !!fundo,
    );

  // Buscar histórico completo de PU para os gráficos
  useEffect(() => {
    if (selectedDate && cnpj) {
      Promise.all([
        fetchHistoricoPuFundos(
          cnpj,
          fundo?.fundo_isin ?? isin,
          fundo?.nome_fundo ?? null,
          selectedDate,
        ),
        fetchSnapshotsFundoClasse(
          cnpj,
          fundo?.fundo_isin ?? isin,
          fundo?.nome_fundo ?? null,
          selectedDate,
        ),
      ]).then(([pu, snapshots]) => {
        setHistoricoPu(pu);
        setSnapshotsFundo(snapshots);
      });
    }
  }, [cnpj, isin, fundo?.fundo_isin, fundo?.nome_fundo, selectedDate]);

  // Processar dados para o gráfico de linha (retorno acumulado)
  const dadosGraficoLinha = useMemo(() => {
    if (!historicoPu.length || !ativos.length) return [];

    // Agrupar por ativo (deduplicado por data)
    const porAtivo = new Map<
      string,
      Array<{ data_posicao: string; pu_posicao: number }>
    >();
    for (const h of historicoPu) {
      const lista = porAtivo.get(h.ativo_key) ?? [];
      lista.push({ data_posicao: h.data_posicao, pu_posicao: h.pu_posicao });
      porAtivo.set(h.ativo_key, lista);
    }
    for (const [key, serie] of porAtivo) {
      porAtivo.set(key, dedupSeriePuPorData(serie));
    }

    // Calcular retorno acumulado por ativo por data
    let datasUnicas = [
      ...new Set(historicoPu.map((h) => h.data_posicao)),
    ].sort();

    const dataRefGrafico = selectedDate ?? datasUnicas[datasUnicas.length - 1] ?? "";
    const sortedDatas = datasUnicas.map((d) => ({ data_posicao: d }));
    const {
      pontos: pontosFiltrados,
      dataInicioPeriodo,
      usaJanelaFixa,
      dataLabel,
    } = filtrarSeriePorPeriodo(
      sortedDatas,
      dataRefGrafico,
      periodo,
      mesAlvoEfetivo,
      anoAlvo,
    );
    datasUnicas = pontosFiltrados.map((p) => p.data_posicao);

    return datasUnicas.map((data) => {
      const ponto: Record<string, string | number | null> = {
        data,
        dataFormatada: formatIsoDateSafe(data, "dd/MM/yyyy"),
        dataLabel: dataLabel(data),
      };

      ativos.forEach((ativo, i) => {
        const serie = porAtivo.get(ativo.ativo_key) ?? [];

        if (usaJanelaFixa && dataInicioPeriodo) {
          ponto[chartDataKey(i)] = retornoAcumPuNoPeriodo(
            serie,
            data,
            dataInicioPeriodo,
          );
          return;
        }

        const serieAteData = serie.filter((s) => s.data_posicao <= data);
        if (serieAteData.length > 0) {
          const puBase = serieAteData[0].pu_posicao;
          const puAtual = serieAteData[serieAteData.length - 1].pu_posicao;
          ponto[chartDataKey(i)] =
            puBase > 0 ? (puAtual / puBase - 1) * 100 : null;
        }
      });

      return ponto;
    });
  }, [historicoPu, ativos, periodo, selectedDate, mesAlvoEfetivo, anoAlvo]);

  const historicoPorAtivo = useMemo(() => {
    const map = new Map<string, Array<{ data_posicao: string; pu_posicao: number }>>();
    for (const h of historicoPu) {
      const lista = map.get(h.ativo_key) ?? [];
      lista.push({ data_posicao: h.data_posicao, pu_posicao: h.pu_posicao });
      map.set(h.ativo_key, lista);
    }
    for (const [key, serie] of map) {
      map.set(key, dedupSeriePuPorData(serie));
    }
    return map;
  }, [historicoPu]);

  // Variação por ativo no período selecionado — ordenado por magnitude
  const dadosGraficoBarra = useMemo(() => {
    if (!selectedDate) return [];

    const seriePuDoAtivo = (ativo: RentabilidadeAtivoRow) => {
      const aliases = new Set(
        expandAtivoKeyAliases(ativo.ativo_key, ativo.isin_ativo),
      );
      const merged: Array<{
        data_posicao: string;
        pu_posicao: number;
        qt?: number;
      }> = [];
      for (const [key, serie] of historicoPorAtivo) {
        if (aliases.has(key)) {
          for (const p of serie) merged.push({ ...p, qt: 1 });
        }
      }
      return dedupSeriePuPorData(merged);
    };

    return [...ativos]
      .map((ativo) => {
        let valor: number | null = null;

        if (periodo === "dia") {
          valor = ativo.var_pu_pct;
        } else if (periodo === "mes") {
          const mesRef = selectedDate.slice(0, 7);
          if (mesAlvoEfetivo === mesRef) {
            valor = ativo.var_pu_mes_pct;
          } else {
            const bounds = periodoMesBounds(mesAlvoEfetivo, selectedDate);
            if (bounds) {
              valor = retornoAcumPuNoPeriodo(
                seriePuDoAtivo(ativo),
                bounds.fim,
                bounds.inicio,
              );
            }
          }
        } else if (periodo === "ano") {
          const bounds = periodoAnoBounds(anoAlvo, selectedDate);
          if (bounds) {
            valor = retornoAcumPuNoPeriodo(
              seriePuDoAtivo(ativo),
              bounds.fim,
              bounds.inicio,
            );
          }
        } else {
          const dias = DIAS_JANELA[periodo];
          if (dias) {
            const dataInicio = subtractDaysIso(selectedDate, dias);
            valor = retornoAcumPuNoPeriodo(
              seriePuDoAtivo(ativo),
              selectedDate,
              dataInicio,
            );
          }
        }

        return {
          nome: truncateChartLabel(ativo.nome_exibicao),
          nomeCompleto: ativo.nome_exibicao,
          valor: valor ?? 0,
          percPl: ativo.perc_pl_pct,
          metrica: labelMetricaBarra(periodo),
        };
      })
      .sort((a, b) => Math.abs(b.valor) - Math.abs(a.valor));
  }, [ativos, periodo, selectedDate, historicoPorAtivo, mesAlvoEfetivo, anoAlvo]);

  const barChartMinWidth = Math.max(
    dadosGraficoBarra.length * BAR_COLUMN_WIDTH,
    320,
  );

  // Retorno acumulado da cota do fundo — respeita período (dia, 5d, 30d… mês, ano)
  const dadosFundo = useMemo(() => {
    if (!snapshotsFundo.length || !selectedDate) return [];

    const sorted = [...snapshotsFundo]
      .filter((s) => s.data_posicao <= selectedDate)
      .sort((a, b) => a.data_posicao.localeCompare(b.data_posicao));
    if (!sorted.length) return [];

    const cotaBaseSerie = sorted[0].valor_cota;
    const {
      pontos,
      dataInicioPeriodo,
      usaJanelaFixa,
      dataLabel,
    } = filtrarSeriePorPeriodo(
      sorted,
      selectedDate,
      periodo,
      mesAlvoEfetivo,
      anoAlvo,
    );

    const cotaBaseJanela =
      usaJanelaFixa && dataInicioPeriodo
        ? ([...sorted]
            .filter((s) => s.data_posicao <= dataInicioPeriodo!)
            .pop()?.valor_cota ?? pontos[0]?.valor_cota)
        : cotaBaseSerie;

    return pontos.map((s) => {
      const base = usaJanelaFixa ? cotaBaseJanela : cotaBaseSerie;
      return {
        dataLabel: dataLabel(s.data_posicao),
        dataFormatada: formatIsoDateSafe(s.data_posicao, "dd/MM/yyyy"),
        acum: base > 0 ? (s.valor_cota / base - 1) * 100 : 0,
      };
    });
  }, [snapshotsFundo, selectedDate, periodo, mesAlvoEfetivo, anoAlvo]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground uppercase tracking-wider flex items-center gap-2">
            <LineChartIcon className="h-6 w-6 text-primary" />
            Rentabilidade do Fundo
          </h1>
          {fundo && (
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{fundo.nome_fundo ?? "—"}</p>
              <p className="text-xs text-muted-foreground font-mono">
                {fmtCnpj(cnpj)}
              </p>
            </div>
          )}
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
            onClick={() => refetch()}
            disabled={isLoading}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", isLoading && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      {!isLoading && !error && fundo && !cdiDisponivel && (
        <p className="text-sm text-amber-700 dark:text-amber-500" role="status">
          CDI indisponível para a data selecionada. Os comparativos com CDI
          ficarão em branco até a taxa estar disponível.
        </p>
      )}
      {error && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">
              Erro ao carregar dados: {(error as Error).message}
            </p>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : !fundo ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground text-center">
              Fundo não encontrado na data selecionada.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
                  Cota
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-lg font-semibold font-mono">
                  {fmtCota(fundo.valor_cota)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
                  Patrimônio Líquido
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-lg font-semibold">{fmtBRL(fundo.pl)}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
                  Ret. Dia
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p
                  className={cn(
                    "text-lg font-semibold",
                    pctColor(fundo.retorno_dia_pct),
                  )}
                >
                  {fmtPct(fundo.retorno_dia_pct)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
                  Ret. Mês
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p
                  className={cn(
                    "text-lg font-semibold",
                    pctColor(fundo.retorno_mes_pct),
                  )}
                >
                  {fmtPct(fundo.retorno_mes_pct)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
                  Ret. Acumulado
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p
                  className={cn(
                    "text-lg font-semibold",
                    pctColor(fundo.retorno_acum_pct),
                  )}
                >
                  {fmtPct(fundo.retorno_acum_pct)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
                  Ret. 12M
                </CardTitle>
              </CardHeader>
              <CardContent>
                <RetComPctCdiCell
                  retornoPct={fundo.retorno_12m_pct}
                  pctCdi={fundo.pct_cdi_12m}
                  cdiBenchPct={fundo.cdi_12m_pct}
                  cdiPlusPct={fundo.cdi_plus_12m_pct}
                  retornoLabel="Retorno 12 meses"
                  cdiLabel="CDI acum. 12M"
                  duAnual={1}
                  size="lg"
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
                  CDI Dia
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-lg font-semibold text-muted-foreground">
                  {fmtPct(fundo.cdi_dia_pct)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
                  vs CDI (dia)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="leading-snug space-y-0.5">
                  <p className="text-sm font-medium">
                    {fmtCDIPlusAA(fundo.cdi_plus_aa_pct)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {fmtPctCDI(fundo.pct_cdi)}
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Abas de visualização */}
          <div className="flex gap-2">
            {(["fundo", "ativos"] as const).map((a) => (
              <button
                key={a}
                onClick={() => setAba(a)}
                className={cn(
                  "px-4 py-1.5 rounded-full text-sm border transition-colors",
                  aba === a
                    ? "bg-emerald-700 text-white border-emerald-700"
                    : "bg-white text-gray-500 border-gray-200 hover:bg-gray-50"
                )}
              >
                {a === "fundo" ? "Fundo" : "Ativos por PU"}
              </button>
            ))}
          </div>

          {/* Aba Fundo - Gráficos da cota */}
          {aba === "fundo" && (
            <>
              <div className="bg-white rounded-lg border border-gray-100 p-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                    {tituloPeriodoAcumulado(periodo, "fundo", mesAlvoEfetivo, anoAlvo)}
                  </p>
                  <PeriodoGraficoControles
                    periodo={periodo}
                    onPeriodo={setPeriodo}
                    mesAlvo={mesAlvo}
                    onMesAlvo={setMesAlvo}
                    anoAlvo={anoAlvo}
                    onAnoAlvo={setAnoAlvo}
                    mesesDisponiveis={mesesDisponiveis}
                    anosDisponiveis={anosDisponiveis}
                  />
                </div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-2.5 h-2.5 rounded-sm inline-block bg-emerald-600" />
                  <span className="text-xs text-gray-500">Cota acumulada %</span>
                </div>
                {dadosFundo.length > 0 ? (
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={dadosFundo}>
                      <defs>
                        <linearGradient id="gradFundo" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#1D9E75" stopOpacity={0.12} />
                          <stop offset="95%" stopColor="#1D9E75" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
                      <XAxis
                        dataKey="dataLabel"
                        tick={{ fill: "#6B7280", fontSize: 11 }}
                        axisLine={{ stroke: "#E5E7EB" }}
                        tickLine={false}
                        height={32}
                        tickCount={8}
                      />
                      <YAxis
                        tick={{ fill: "#6B7280", fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(v) => `${Number(v).toFixed(3)}%`}
                        width={72}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "#FFFFFF",
                          border: "0.5px solid #E5E7EB",
                          borderRadius: "8px",
                          fontSize: "12px",
                          color: "#111827",
                          boxShadow: "none",
                        }}
                        labelFormatter={(label, payload) => {
                          if (payload && payload[0]) {
                            return payload[0].payload.dataFormatada;
                          }
                          return label;
                        }}
                        formatter={(v: number) => [
                          `${v >= 0 ? "+" : ""}${v.toFixed(4)}%`,
                          "Acumulado",
                        ]}
                      />
                      <Area
                        type="monotone"
                        dataKey="acum"
                        stroke="#1D9E75"
                        strokeWidth={2}
                        fill="url(#gradFundo)"
                        dot={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-16">
                    {mensagemGraficoVazio(periodo, mesAlvoEfetivo, anoAlvo)}
                  </p>
                )}
              </div>
            </>
          )}

          {/* Aba Ativos por PU - Gráficos dos ativos */}
          {aba === "ativos" && (
            <>
              {/* Gráfico 1: Retorno acumulado dos ativos */}
              {!ativosLoading && ativos.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-100 p-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
                <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                  {tituloPeriodoAcumulado(periodo, "ativos", mesAlvoEfetivo, anoAlvo)}
                </p>
                <PeriodoGraficoControles
                  periodo={periodo}
                  onPeriodo={setPeriodo}
                  mesAlvo={mesAlvo}
                  onMesAlvo={setMesAlvo}
                  anoAlvo={anoAlvo}
                  onAnoAlvo={setAnoAlvo}
                  mesesDisponiveis={mesesDisponiveis}
                  anosDisponiveis={anosDisponiveis}
                />
              </div>
              {/* Legenda customizada */}
              <div className="flex flex-wrap gap-3 mb-4">
                {ativos.map((ativo, i) => (
                  <div key={ativo.cnpj_ativo ?? i} className="flex items-center gap-1.5">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: CORES_ATIVOS[i % CORES_ATIVOS.length] }}
                    />
                    <span className="text-xs text-gray-600">{ativo.nome_exibicao}</span>
                  </div>
                ))}
              </div>
              {dadosGraficoLinha.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={dadosGraficoLinha}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
                  <XAxis
                    dataKey="dataLabel"
                    tick={{ fill: "#6B7280", fontSize: 11 }}
                    axisLine={{ stroke: "#E5E7EB" }}
                    tickLine={false}
                    height={32}
                    tickCount={8}
                  />
                  <YAxis
                    tick={{ fill: "#6B7280", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `${Number(v).toFixed(3)}%`}
                    width={72}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#FFFFFF",
                      border: "0.5px solid #E5E7EB",
                      borderRadius: "8px",
                      fontSize: "12px",
                      color: "#111827",
                      boxShadow: "none",
                    }}
                    labelFormatter={(label, payload) => {
                      if (payload && payload[0]) {
                        return payload[0].payload.dataFormatada;
                      }
                      return label;
                    }}
                    formatter={(value: number, name: string) => [
                      `${value >= 0 ? "+" : ""}${value.toFixed(4)}%`,
                      name,
                    ]}
                  />
                  {ativos.map((ativo, i) => (
                      <Line
                        key={ativo.ativo_key}
                        type="monotone"
                        dataKey={chartDataKey(i)}
                        name={ativo.nome_exibicao}
                        stroke={CORES_ATIVOS[i % CORES_ATIVOS.length]}
                        dot={false}
                        strokeWidth={2}
                        connectNulls
                      />
                    ))}
                </LineChart>
              </ResponsiveContainer>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-16">
                  {mensagemGraficoVazio(periodo, mesAlvo, anoAlvo)}
                </p>
              )}
            </div>
          )}

              {/* Gráfico barras por ativo */}
              {!ativosLoading &&
                ativos.length > 0 &&
                selectedDate && (
              <div className="bg-white rounded-lg border border-gray-100 p-4 mb-6">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-3">
                  <div>
                    <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                      {tituloPeriodoBarraAtivos(
                        periodo,
                        selectedDate,
                        mesAlvoEfetivo,
                        anoAlvo,
                      )}
                    </p>
                    <span className="text-[10px] text-gray-400">
                      {dadosGraficoBarra.length} ativos · ordenado por |var.|
                    </span>
                  </div>
                  <PeriodoGraficoControles
                    periodo={periodo}
                    onPeriodo={setPeriodo}
                    mesAlvo={mesAlvo}
                    onMesAlvo={setMesAlvo}
                    anoAlvo={anoAlvo}
                    onAnoAlvo={setAnoAlvo}
                    mesesDisponiveis={mesesDisponiveis}
                    anosDisponiveis={anosDisponiveis}
                  />
                </div>
                {dadosGraficoBarra.length > 0 ? (
                <div className="overflow-x-auto overflow-y-hidden rounded-md border border-gray-50">
                  <div style={{ minWidth: barChartMinWidth, height: BAR_CHART_HEIGHT }}>
                    <ResponsiveContainer width="100%" height={BAR_CHART_HEIGHT}>
                      <BarChart
                        data={dadosGraficoBarra}
                        margin={{ left: 4, right: 8, top: 8, bottom: 64 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="#E5E7EB"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="nome"
                          tick={{ fill: "#374151", fontSize: 9 }}
                          angle={-50}
                          textAnchor="end"
                          interval={0}
                          height={64}
                          axisLine={{ stroke: "#E5E7EB" }}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{ fill: "#6B7280", fontSize: 10 }}
                          axisLine={false}
                          tickLine={false}
                          tickFormatter={(v) => `${Number(v).toFixed(2)}%`}
                          width={52}
                        />
                        <Tooltip
                          contentStyle={{
                            background: "#FFFFFF",
                            border: "0.5px solid #E5E7EB",
                            borderRadius: "8px",
                            fontSize: "12px",
                            color: "#111827",
                            boxShadow: "none",
                            maxWidth: 320,
                          }}
                          labelFormatter={(_, payload) =>
                            payload?.[0]?.payload?.nomeCompleto ?? ""
                          }
                          formatter={(value: number, _name, item) => {
                            const percPl = item?.payload?.percPl as number | null;
                            const metrica = (item?.payload?.metrica as string) ?? "Var.";
                            const plLabel =
                              percPl != null
                                ? ` · ${percPl.toFixed(2).replace(".", ",")}% PL`
                                : "";
                            return [
                              `${value >= 0 ? "+" : ""}${value.toFixed(4)}%${plLabel}`,
                              metrica,
                            ];
                          }}
                        />
                        <Bar dataKey="valor" radius={[3, 3, 0, 0]} maxBarSize={40}>
                          {dadosGraficoBarra.map((entry, i) => (
                            <Cell
                              key={`${entry.nomeCompleto}-${i}`}
                              fill={entry.valor >= 0 ? "#1D9E75" : "#EF4444"}
                            />
                          ))}
                        </Bar>
                        <ReferenceLine y={0} stroke="#9CA3AF" strokeWidth={1} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-12">
                    {mensagemGraficoVazio(periodo, mesAlvoEfetivo, anoAlvo)}
                  </p>
                )}
              </div>
                )}

            </>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold uppercase tracking-wide">
                Cotas Investidas
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {ativosLoading ? (
                <div className="p-4 space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : ativos.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground text-center">
                  Nenhum ativo com PU/valor (cotas, títulos, ações, participações ou imóveis) nesta data.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
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
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ativos.map((a, i) => (
                        <TableRow key={`${a.cnpj_ativo}-${i}`}>
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
                            {a.perc_pl_pct != null
                              ? fmtPct(a.perc_pl_pct, 2)
                              : "—"}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right text-xs",
                              pctColor(a.var_pu_pct),
                            )}
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
                            className={cn(
                              "text-right text-xs",
                              pctColor(a.var_pu_mes_pct),
                            )}
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
                            className={cn(
                              "text-right text-xs",
                              pctColor(a.var_pu_ano_pct),
                            )}
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
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
