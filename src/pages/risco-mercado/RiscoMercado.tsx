import React, { useState, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Layout } from "@/components/Layout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Info,
  Loader2,
  Search,
  Download,
  ShieldAlert,
  RefreshCw,
  BarChart2,
  List,
  TrendingDown,
  CalendarDays,
  FileSpreadsheet,
  FileText,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import * as XLSX from "xlsx-js-style";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { toast } from "sonner";
import {
  fetchRiscoConsolidado,
  exportRiscoConsolidadoExcel,
  exportRiscoConsolidadoPdf,
} from "@/lib/riscoConsolidadoExport";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as RTooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type {
  CarteiraRiscoExtendida,
  FundoRiscoExtendido,
  RiscoV2Response,
  RiscoMercadoSummary,
  VarSeriePoint,
} from "@/types/risco-mercado";
import {
  fetchFundosRiscoSimplificado,
  fetchFundoSerieDiaria,
  fetchUltimaExecucaoRiscoMercadoFundos,
  recalcularRiscoMercadoFundos,
} from "@/lib/riscoMercadoFundosSimplificado";
import {
  fetchUniversoCnpjsMonitorados,
  filtrarFundosUniversoMonitorado,
} from "@/lib/fundosMonitorados";
import type {
  FundoRiscoSimplificado,
  FundoRiscoSimplificadoDia,
  RiscoMercadoFundosCalcLog,
} from "@/types/risco-mercado-fundos-simplificado";

// ── Paleta ─────────────────────────────────────────────────────────────────

const SYS = {
  bg:     "#F8FAFB",
  panel:  "#FFFFFF",
  border: "#E5E7EB",
  text:   "#1F2937",
  muted:  "#6B7280",
  accent: "#2E5389",
  red:    "#DC2626",
  green:  "#16A34A",
  yellow: "#D97706",
  orange: "#EA580C",
};

// ── Formatação ─────────────────────────────────────────────────────────────

const fmtBRL = new Intl.NumberFormat("pt-BR", {
  style: "currency", currency: "BRL",
  minimumFractionDigits: 0, maximumFractionDigits: 0,
});
const fmt = new Intl.NumberFormat("pt-BR");

function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function fmtRS(v: number | null | undefined): string {
  if (v == null) return "—";
  return fmtBRL.format(v);
}

function fmtRSCompact(v: number | null | undefined): string {
  if (v == null) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `R$ ${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `R$ ${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `R$ ${(v / 1e3).toFixed(0)}K`;
  return fmtBRL.format(v);
}

function colorVar(v: number | null | undefined): string {
  if (v == null) return "text-gray-400";
  if (v < -5)  return "text-red-700 font-semibold";
  if (v < -2)  return "text-orange-600 font-medium";
  if (v < 0)   return "text-yellow-700";
  return "text-gray-500";
}

// Convenção OFICIAL V3 (aba Fundos): VaR = magnitude POSITIVA de perda.
// Diferente de colorVar() (usado pela aba Carteiras/V2 legada, onde VaR é negativo no banco).
function colorVarMagnitude(v: number | null | undefined): string {
  if (v == null) return "text-gray-400";
  if (v > 5)  return "text-red-700 font-semibold";
  if (v > 2)  return "text-orange-600 font-medium";
  if (v > 0)  return "text-yellow-700";
  return "text-gray-500";
}

function colorDD(v: number | null | undefined): string {
  if (v == null) return "text-gray-400";
  if (v > 10) return "text-red-700 font-semibold";
  if (v > 5)  return "text-orange-600 font-medium";
  if (v > 2)  return "text-yellow-700";
  return "text-gray-500";
}

// ── Badges ─────────────────────────────────────────────────────────────────

function FonteCotaBadge({ fonte }: { fonte: string | null }) {
  if (!fonte) return null;
  const isXml = fonte.includes("xml");
  const label = isXml ? "XML" : "CVM";
  return (
    <span
      className={cn(
        "text-[9px] font-semibold px-1 py-0.5 rounded ml-1",
        isXml ? "bg-sky-100 text-sky-700" : "bg-indigo-100 text-indigo-700",
      )}
      title={isXml ? "Cota via XML (posicao_carteira)" : "Cota via CVM (inf_diario)"}
    >
      {label}
    </span>
  );
}

function QualidadeBadge({ q }: { q: string | null }) {
  if (!q) return <span className="text-gray-400 text-[10px]">—</span>;
  const map: Record<string, { label: string; cls: string }> = {
    USAR:     { label: "USAR",     cls: "bg-emerald-100 text-emerald-700" },
    REVISAR:  { label: "REVISAR",  cls: "bg-yellow-100  text-yellow-700" },
    FALLBACK: { label: "FALLBACK", cls: "bg-gray-100    text-gray-600"   },
  };
  const c = map[q] ?? { label: q, cls: "bg-gray-100 text-gray-600" };
  return (
    <span className={cn("text-[9px] font-semibold px-1 py-0.5 rounded", c.cls)}>
      {c.label}
    </span>
  );
}

function AlertaBadge({ alerta }: { alerta: boolean }) {
  if (!alerta) return null;
  return (
    <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-red-100 text-red-700 ml-1">
      3σ
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "sem_dados") return null;
  const map: Record<string, { label: string; cls: string }> = {
    ok:     { label: "OK",     cls: "bg-emerald-100 text-emerald-700" },
    alerta: { label: "ALERTA", cls: "bg-amber-100   text-amber-700"   },
    breach: { label: "BREACH", cls: "bg-red-100     text-red-700 font-bold" },
  };
  const c = map[status] ?? { label: status.toUpperCase(), cls: "bg-gray-100 text-gray-600" };
  return (
    <span className={cn("text-[9px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide", c.cls)}>
      {c.label}
    </span>
  );
}

const ALERTA_SERIE_LABEL: Record<string, string> = {
  dd_gt_50:         "Drawdown > 50%",
  ret_1d_extremo:   "Retorno diário extremo (>50%)",
  ret_21d_extremo:  "Retorno 21d extremo (>50%)",
  quebra_serie:     "Possível quebra de série (gap elevado)",
  troca_cnpj:       "Série híbrida manual+XML (proxy de troca de CNPJ/estrutura)",
  historico_baixo:  "Histórico baixo",
  sem_dados:        "Sem dados suficientes para avaliar",
};

function SerieQualidadeBadge({
  status,
  alertas,
}: {
  status: 'ok' | 'suspeita' | 'sem_dados' | null | undefined;
  alertas: string[] | null | undefined;
}) {
  if (status === 'suspeita') {
    const detalhes = (alertas ?? [])
      .map((a) => ALERTA_SERIE_LABEL[a] ?? a)
      .join(" · ");
    return (
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 text-[9px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700 cursor-help">
              ⚠️ Série suspeita
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[11px] max-w-[320px]">
            {detalhes || "Gatilhos de suspeita acionados"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (status === 'ok') {
    return (
      <span className="inline-flex items-center gap-1 text-[9px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
        Série OK
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-[9px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
      Sem dados
    </span>
  );
}

// ── KPI card ───────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg px-4 py-3">
      <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={cn("text-lg font-semibold mt-0.5 tabular-nums leading-tight", color ?? "text-gray-900")}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

// ── SortIcon ───────────────────────────────────────────────────────────────

function SortIcon({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return <ChevronsUpDown className="h-3 w-3 text-gray-400 inline ml-0.5" />;
  return dir === "asc"
    ? <ChevronUp   className="h-3 w-3 text-blue-500 inline ml-0.5" />
    : <ChevronDown className="h-3 w-3 text-blue-500 inline ml-0.5" />;
}

// ── xlsx helpers ───────────────────────────────────────────────────────────

function to6(hex: string) { return hex.replace("#", "").toUpperCase().slice(-6); }
function xFill(hex: string) { return { patternType: "solid" as const, fgColor: { rgb: to6(hex) } }; }
function xFont(hex: string, bold = false, sz = 9) {
  return { color: { rgb: to6(hex) }, bold, sz, name: "Calibri" };
}
function xAlign(h: "left" | "center" | "right" = "left") {
  return { horizontal: h, vertical: "middle" as const };
}

function sanitizePdfText(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/−|—|–/g, "-")
    .replace(/×/g, "x")
    .replace(/÷/g, "/")
    .replace(/√/g, "sqrt")
    .replace(/\u2212/g, "-")
    .replace(/\u00d7/g, "x")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'");
}

// ══════════════════════════════════════════════════════════════════════════
// MÉTODOS COMPARATIVO
// ══════════════════════════════════════════════════════════════════════════

function MetodosComparativo({ carteiras }: { carteiras: CarteiraRiscoExtendida[] }) {
  const media = (key: keyof CarteiraRiscoExtendida) => {
    const vals = carteiras
      .map((c) => c[key] as number | null)
      .filter((v): v is number => v != null);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };

  const avgHist  = media("var_mes_95_pct");
  const avgParam = media("var_95_param_pct");

  return (
    <div className="grid grid-cols-2 gap-3">
      <KpiCard
        label="VaR Histórico Médio"
        value={avgHist != null ? `${avgHist.toFixed(2)}%` : "—"}
        sub="EWMA 21d — emp. por carteira"
        color={(avgHist ?? 0) < -3 ? "text-red-600" : "text-orange-600"}
      />
      <KpiCard
        label="VaR Paramétrico Médio (legado)"
        value={avgParam != null ? `${avgParam.toFixed(2)}%` : "—"}
        sub="Normal 21d c/ μ — ponderado por PL · auxiliar, não oficial"
        color={(avgParam ?? 0) < -3 ? "text-red-600" : "text-orange-600"}
      />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ABA CARTEIRAS
// ══════════════════════════════════════════════════════════════════════════

type CarteiraSortKey =
  | "cliente" | "var_mes_95_pct" | "drawdown_atual_pct"
  | "drawdown_max_252d_pct" | "pior_21d_pct" | "stress_pior_pct"
  | "var_95_param_pct" | "var_95_mc_t_pct" | "var_95_diversif_pct";

function TabCarteiras({
  carteiras,
  isLoading,
  error,
}: {
  carteiras: CarteiraRiscoExtendida[];
  isLoading: boolean;
  error: unknown;
}) {
  const [search, setSearch]   = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("todos");
  const [sort, setSort]       = useState<{ key: CarteiraSortKey; dir: "asc" | "desc" }>({
    key: "var_mes_95_pct", dir: "asc",
  });
  const [expandedRows, setExpanded] = useState<Set<string | number>>(new Set());
  const [isExporting, setIsExporting] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = carteiras.filter((c) => {
      if (filterStatus !== "todos" && c.status !== filterStatus) return false;
      if (!q) return true;
      return (
        c.cliente.toLowerCase().includes(q) ||
        (c.grupo ?? "").toLowerCase().includes(q)
      );
    });
    rows = [...rows].sort((a, b) => {
      const av = a[sort.key] ?? (sort.dir === "asc" ? Infinity : -Infinity);
      const bv = b[sort.key] ?? (sort.dir === "asc" ? Infinity : -Infinity);
      if (typeof av === "string")
        return sort.dir === "asc" ? av.localeCompare(bv as string) : (bv as string).localeCompare(av);
      return sort.dir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return rows;
  }, [carteiras, search, filterStatus, sort]);

  const kpis = useMemo(() => {
    const comVar  = filtered.filter((c) => c.var_mes_95_pct != null);
    const avgVar  = comVar.length ? comVar.reduce((s, c) => s + (c.var_mes_95_pct ?? 0), 0) / comVar.length : null;
    const piorVar = comVar.length ? Math.min(...comVar.map((c) => c.var_mes_95_pct ?? 0)) : null;
    const avgDD   = filtered.filter((c) => c.drawdown_atual_pct != null).length
      ? filtered.filter((c) => c.drawdown_atual_pct != null).reduce((s, c) => s + (c.drawdown_atual_pct ?? 0), 0) / filtered.filter((c) => c.drawdown_atual_pct != null).length
      : null;
    const nBreach = filtered.filter((c) => c.status === "breach").length;
    const nAlerta = filtered.filter((c) => c.status === "alerta").length;
    return { total: filtered.length, avgVar, piorVar, avgDD, nBreach, nAlerta };
  }, [filtered]);

  function handleSort(key: CarteiraSortKey) {
    setSort((s) => s.key === key
      ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
      : { key, dir: "asc" });
  }

  function toggleRow(id: string | number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function exportarExcel() {
    if (!filtered.length) return;
    setIsExporting(true);
    try {
      const wb = XLSX.utils.book_new();
      const HDR = [
        "Carteira", "Grupo", "Data",
        "VaR EWMA 95% (%)", "VaR Param 95% 21d (legado) (%)", "VaR MC(t) 95% (legado) (%)",
        "VaR Diversif 95% (legado) (%)", "VaR Hist R$", "VaR Diversif R$",
        "Economia Diversif R$", "B-VaR 95% (%)",
        "Drawdown Atual (%)", "DD Máx 252d (%)", "Pior 21d (%)",
        "Stress Pior (%)", "Uso Limite (%)", "Status",
      ];
      const ws = XLSX.utils.aoa_to_sheet([HDR]);
      ws["!cols"] = HDR.map(() => ({ wch: 16 }));
      ws["!cols"][0] = { wch: 35 }; ws["!cols"][1] = { wch: 8 }; ws["!cols"][2] = { wch: 12 };
      HDR.forEach((_, ci) => {
        const ref = XLSX.utils.encode_cell({ r: 0, c: ci });
        ws[ref] = { v: HDR[ci], t: "s", s: { fill: xFill(SYS.accent), font: xFont("#FFFFFF", true, 9), alignment: xAlign("center") } };
      });
      filtered.forEach((c, ri) => {
        const row = [
          c.cliente, c.grupo ?? "", c.data_posicao ?? "",
          c.var_mes_95_pct != null ? c.var_mes_95_pct / 100 : "",
          c.var_95_param_pct != null ? c.var_95_param_pct / 100 : "",
          c.var_95_mc_t_pct != null ? c.var_95_mc_t_pct / 100 : "",
          c.var_95_diversif_pct != null ? c.var_95_diversif_pct / 100 : "",
          c.var_95_hist_rs ?? "",
          c.var_95_diversif_rs ?? "",
          c.beneficio_diversif_rs ?? "",
          c.bvar_95_pct != null ? c.bvar_95_pct / 100 : "",
          c.drawdown_atual_pct != null ? c.drawdown_atual_pct / 100 : "",
          c.drawdown_max_252d_pct != null ? c.drawdown_max_252d_pct / 100 : "",
          c.pior_21d_pct != null ? c.pior_21d_pct / 100 : "",
          c.stress_pior_pct != null ? c.stress_pior_pct / 100 : "",
          c.pct_uso_limite != null ? c.pct_uso_limite / 100 : "",
          c.status,
        ];
        const rowBg = ri % 2 === 0 ? "#FFFFFF" : "#F8FAFB";
        const pctCols = [3, 4, 5, 6, 10, 11, 12, 13, 14, 15];
        row.forEach((v, ci) => {
          const ref = XLSX.utils.encode_cell({ r: ri + 1, c: ci });
          const isNum = typeof v === "number";
          ws[ref] = {
            v: v === "" ? null : v, t: isNum ? "n" : "s",
            s: {
              fill: xFill(rowBg),
              font: xFont((isNum && pctCols.includes(ci) && (v as number) < 0) ? SYS.red : SYS.text),
              alignment: xAlign(isNum ? "right" : "left"),
              ...(pctCols.includes(ci) ? { numFmt: "0.00%" } : {}),
            },
          };
        });
      });
      ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: filtered.length, c: HDR.length - 1 } });
      ws["!freeze"] = { xSplit: 1, ySplit: 1 };
      XLSX.utils.book_append_sheet(wb, ws, "Risco Carteiras");
      XLSX.writeFile(wb, `risco_mercado_carteiras_${filtered.length}.xlsx`);
    } finally {
      setIsExporting(false);
    }
  }

  const COLS: { key: CarteiraSortKey; label: string; align: string; tooltip?: string }[] = [
    { key: "cliente",            label: "Carteira",       align: "left"  },
    { key: "var_mes_95_pct",     label: "VaR Hist",       align: "right", tooltip: "VaR EWMA 95% 21d (série de cotas)" },
    { key: "var_95_param_pct",   label: "VaR Param (legado)",    align: "right", tooltip: "Legado/auxiliar — VaR Paramétrico Normal 95% 21d (μ×21 + z×σ×√21). Não é o VaR oficial (ver aba Fundos)." },
    { key: "var_95_mc_t_pct",    label: "VaR MC(t) (legado)",    align: "right", tooltip: "Legado/auxiliar — VaR Monte Carlo t-Student 95% 21d. Não alimenta KPIs oficiais de FIC/FIDC." },
    { key: "var_95_diversif_pct",label: "VaR Diversif (legado)", align: "right", tooltip: "Legado/auxiliar — VaR MC Multivariado (considera correlações). Não alimenta KPIs oficiais de FIC/FIDC." },
    { key: "pior_21d_pct",       label: "Pior 21d",       align: "right" },
    { key: "stress_pior_pct",    label: "Stress Pior",    align: "right" },
    { key: "drawdown_atual_pct", label: "DD Atual",       align: "right" },
  ];

  const statusOptions = [
    { v: "todos",    label: "Todos" },
    { v: "breach",   label: "Breach" },
    { v: "alerta",   label: "Alerta" },
    { v: "ok",       label: "OK" },
    { v: "sem_dados",label: "Sem dados" },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* KPIs */}
      {!isLoading && !error && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 px-6">
          <KpiCard label="Carteiras"       value={fmt.format(kpis.total)}   sub="no filtro atual" />
          <KpiCard label="VaR Hist. Médio" value={kpis.avgVar != null ? `${kpis.avgVar.toFixed(2)}%` : "—"}
            sub="EWMA 21d" color={(kpis.avgVar ?? 0) < -3 ? "text-red-600" : "text-orange-600"} />
          <KpiCard label="Pior VaR"        value={kpis.piorVar != null ? `${kpis.piorVar.toFixed(2)}%` : "—"}
            sub="carteira mais arriscada" color="text-red-700" />
          <KpiCard
            label="Breach / Alerta"
            value={`${kpis.nBreach} / ${kpis.nAlerta}`}
            sub="vs limite definido"
            color={kpis.nBreach > 0 ? "text-red-700" : kpis.nAlerta > 0 ? "text-amber-600" : "text-emerald-700"}
          />
        </div>
      )}

      {/* Filtros */}
      <div className="px-6 flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <Input className="pl-8 h-8 text-xs" placeholder="Buscar carteira ou grupo..."
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1">
          {statusOptions.map((opt) => (
            <button
              key={opt.v}
              onClick={() => setFilterStatus(opt.v)}
              className={cn(
                "text-[10px] font-semibold px-2 py-1 rounded border transition-colors",
                filterStatus === opt.v
                  ? "bg-[#2E5389] text-white border-[#2E5389]"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-400",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {(search || filterStatus !== "todos") && (
          <Button variant="ghost" size="sm" className="h-8 text-xs text-gray-500"
            onClick={() => { setSearch(""); setFilterStatus("todos"); }}>
            Limpar
          </Button>
        )}
        <Button size="sm" onClick={exportarExcel} disabled={!filtered.length || isExporting}
          className="h-8 text-xs bg-[#2E5389] hover:bg-[#1e3d6b] text-white ml-auto">
          {isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {isExporting ? "Exportando..." : `Exportar ${filtered.length}`}
        </Button>
      </div>

      {/* Tabela */}
      {isLoading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : error ? (
        <div className="mx-6 p-4 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          Erro: {error instanceof Error ? error.message : String(error)}
        </div>
      ) : (
        <div className="px-6 pb-6 overflow-auto">
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-[12px] border-collapse">
              <thead className="bg-[#2E5389] text-white sticky top-0 z-10">
                <tr>
                  <th className="w-7" />
                  {COLS.map((col) => (
                    <th
                      key={col.key}
                      className={cn(
                        "py-2.5 px-3 font-medium text-[11px] cursor-pointer select-none hover:bg-white/10 transition-colors",
                        col.align === "right" && "text-right",
                        col.align === "left"  && "text-left",
                      )}
                      onClick={() => handleSort(col.key)}
                    >
                      {col.tooltip ? (
                        <TooltipProvider delayDuration={100}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-help underline decoration-dotted">
                                {col.label}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-[11px]">
                              {col.tooltip}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : col.label}
                      <SortIcon active={sort.key === col.key} dir={sort.dir} />
                    </th>
                  ))}
                  <th className="py-2.5 px-3 text-center text-[11px]">Status</th>
                  <th className="py-2.5 px-3 text-right text-[11px]">Uso Limite</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={COLS.length + 3} className="py-12 text-center text-gray-400 text-sm">
                      {carteiras.length === 0
                        ? "Nenhuma carteira com métricas."
                        : "Nenhuma carteira encontrada."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((c, idx) => {
                    const rowKey   = c.cod_cli ?? c.cliente;
                    const isExpanded = expandedRows.has(rowKey);
                    const rowBg    = idx % 2 === 0 ? "bg-white" : "bg-gray-50/60";
                    const temDetalhe = c.fundos_detalhe && c.fundos_detalhe.length > 0;

                    return (
                      <React.Fragment key={rowKey}>
                        <tr
                          className={cn(
                            rowBg, "border-b border-gray-100",
                            temDetalhe && "cursor-pointer hover:bg-blue-50/40 transition-colors",
                            isExpanded && "bg-blue-50/20",
                          )}
                          onClick={() => temDetalhe && toggleRow(rowKey)}
                        >
                          <td className="pl-3 pr-1">
                            {temDetalhe && (
                              isExpanded
                                ? <ChevronUp   className="h-3.5 w-3.5 text-blue-500" />
                                : <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                            )}
                          </td>
                          {/* Carteira */}
                          <td className="py-2.5 px-3">
                            <div className="font-medium text-gray-800 leading-tight flex items-center gap-1">
                              {c.cliente}
                              <AlertaBadge alerta={c.alerta_3sigma} />
                            </div>
                            {c.grupo && <div className="text-[10px] text-gray-400">{c.grupo}</div>}
                          </td>
                          {/* VaR Hist */}
                          <td className={cn("py-2.5 px-3 text-right tabular-nums font-medium", colorVar(c.var_mes_95_pct))}>
                            {fmtPct(c.var_mes_95_pct)}
                          </td>
                          {/* VaR Param */}
                          <td className={cn("py-2.5 px-3 text-right tabular-nums", colorVar(c.var_95_param_pct))}>
                            {fmtPct(c.var_95_param_pct)}
                          </td>
                          {/* VaR MC(t) */}
                          <td className={cn("py-2.5 px-3 text-right tabular-nums", colorVar(c.var_95_mc_t_pct))}>
                            {fmtPct(c.var_95_mc_t_pct)}
                          </td>
                          {/* VaR Diversif */}
                          <td className={cn("py-2.5 px-3 text-right tabular-nums", colorVar(c.var_95_diversif_pct))}>
                            {c.var_95_diversif_pct != null ? (
                              <span className="text-emerald-700 font-medium">
                                {fmtPct(c.var_95_diversif_pct)}
                              </span>
                            ) : "—"}
                          </td>
                          {/* Pior 21d */}
                          <td className={cn("py-2.5 px-3 text-right tabular-nums", colorVar(c.pior_21d_pct))}>
                            {fmtPct(c.pior_21d_pct)}
                          </td>
                          {/* Stress Pior */}
                          <td className={cn("py-2.5 px-3 text-right tabular-nums", colorVar(c.stress_pior_pct))}>
                            {c.stress_pior_pct != null ? fmtPct(c.stress_pior_pct) : <span className="text-gray-300">—</span>}
                          </td>
                          {/* DD Atual */}
                          <td className={cn("py-2.5 px-3 text-right tabular-nums", colorDD(c.drawdown_atual_pct))}>
                            {c.drawdown_atual_pct != null ? `${c.drawdown_atual_pct.toFixed(2)}%` : "—"}
                          </td>
                          {/* Status */}
                          <td className="py-2.5 px-3 text-center">
                            <StatusBadge status={c.status} />
                          </td>
                          {/* Uso Limite */}
                          <td className={cn(
                            "py-2.5 px-3 text-right tabular-nums text-[11px]",
                            c.pct_uso_limite != null && c.pct_uso_limite >= 100 ? "text-red-600 font-semibold"
                              : c.pct_uso_limite != null && c.pct_uso_limite >= 85 ? "text-amber-600"
                              : "text-gray-500",
                          )}>
                            {c.pct_uso_limite != null ? `${c.pct_uso_limite.toFixed(0)}%` : "—"}
                            {c.limite_95 != null && (
                              <div className="text-[9px] text-gray-400">lim: {c.limite_95.toFixed(1)}%</div>
                            )}
                          </td>
                        </tr>

                        {/* Sub-linha: detalhe de fundos da carteira */}
                        {isExpanded && c.fundos_detalhe && c.fundos_detalhe.length > 0 && (
                          <tr>
                            <td colSpan={COLS.length + 3} className="p-0 bg-blue-50/30 border-b border-blue-100">
                              <div className="px-8 py-2">
                                <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                                  Fundos da Carteira — {c.cliente}
                                  {c.cobertura_cnpj_pct != null && (
                                    <span className="ml-2 font-normal normal-case">
                                      (cobertura CNPJ: {c.cobertura_cnpj_pct.toFixed(0)}%)
                                    </span>
                                  )}
                                  <span className="ml-2 font-normal normal-case text-gray-400">
                                    · métricas legadas (betas Python, horizonte 21d) — VaR oficial FIC/FIDC na aba Fundos
                                  </span>
                                </div>
                                <table className="w-full text-[11px] border-collapse">
                                  <thead>
                                    <tr className="bg-slate-100 text-gray-600">
                                      <th className="py-1.5 px-2 text-left font-semibold">Fundo</th>
                                      <th className="py-1.5 px-2 text-right font-semibold">Saldo</th>
                                      <th className="py-1.5 px-2 text-right font-semibold">% PL</th>
                                      <th className="py-1.5 px-2 text-right font-semibold">VaR Hist</th>
                                      <th className="py-1.5 px-2 text-right font-semibold">VaR Param</th>
                                      <th className="py-1.5 px-2 text-right font-semibold">VaR MC(t)</th>
                                      <th className="py-1.5 px-2 text-right font-semibold">B-VaR</th>
                                      <th className="py-1.5 px-2 text-center font-semibold">Qualidade</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {c.fundos_detalhe.map((fd, fi) => (
                                      <tr key={fd.cnpj ?? fi} className={fi % 2 === 0 ? "bg-white" : "bg-blue-50/20"}>
                                        <td className="py-1.5 px-2">
                                          <div className="font-medium text-gray-700 leading-tight truncate max-w-[200px]">
                                            {fd.nom_atv}
                                          </div>
                                          {fd.cnpj && (
                                            <div className="text-[9px] text-gray-400 font-mono">{fd.cnpj}</div>
                                          )}
                                        </td>
                                        <td className="py-1.5 px-2 text-right tabular-nums text-gray-700">
                                          {fmtRSCompact(fd.sld_lqd)}
                                        </td>
                                        <td className="py-1.5 px-2 text-right tabular-nums text-gray-500">
                                          {fd.pct_pl.toFixed(1)}%
                                        </td>
                                        <td className={cn("py-1.5 px-2 text-right tabular-nums", colorVar(fd.var_95_hist_pct))}>
                                          {fmtPct(fd.var_95_hist_pct)}
                                        </td>
                                        <td className={cn("py-1.5 px-2 text-right tabular-nums", colorVar(fd.var_95_param_pct))}>
                                          {fmtPct(fd.var_95_param_pct)}
                                        </td>
                                        <td className={cn("py-1.5 px-2 text-right tabular-nums", colorVar(fd.var_95_mc_t_pct))}>
                                          {fmtPct(fd.var_95_mc_t_pct)}
                                        </td>
                                        <td className={cn("py-1.5 px-2 text-right tabular-nums", colorVar(fd.bvar_95_pct))}>
                                          {fmtPct(fd.bvar_95_pct)}
                                        </td>
                                        <td className="py-1.5 px-2 text-center">
                                          <QualidadeBadge q={fd.qualidade} />
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ABA FUNDOS — versão simplificada
// Métricas: VaR Paramétrico, Volatilidade, Drawdown, Cota vs CDI
// Dados: nova edge function calcular-risco-mercado-fundos
// ══════════════════════════════════════════════════════════════════════════

// ── Drill-down: série diária de um fundo ────────────────────────────────

function FundoDrillDown({ cnpj }: { cnpj: string }) {
  const { data: serie = [], isLoading } = useQuery<FundoRiscoSimplificadoDia[]>({
    queryKey: ["risco-mercado-fundo-serie", cnpj],
    queryFn:  () => fetchFundoSerieDiaria(cnpj, 90),
    staleTime: 5 * 60_000,
  });

  const ultimos10 = useMemo(() => [...serie].slice(-10).reverse(), [serie]);

  const firstCota = useMemo(() => serie.find((d) => d.cota != null)?.cota ?? null, [serie]);
  const firstCdi  = useMemo(() => serie.find((d) => d.cdi_valor != null)?.cdi_valor ?? null, [serie]);

  function fmtDia(iso: string) {
    try { return format(parseISO(`${iso}T12:00:00`), "dd/MM/yy", { locale: ptBR }); } catch { return iso; }
  }
  function fmtDiaCurto(iso: string) {
    try { return format(parseISO(`${iso}T12:00:00`), "dd/MM", { locale: ptBR }); } catch { return iso; }
  }

  const chartCotaCdi = useMemo(() => serie.map((d) => ({
    dataLabel: fmtDiaCurto(d.data_ref),
    cota: firstCota != null && d.cota != null ? +(100 * d.cota / firstCota).toFixed(4) : null,
    cdi:  firstCdi  != null && d.cdi_valor != null ? +(100 * d.cdi_valor / firstCdi).toFixed(4) : null,
  })), [serie, firstCota, firstCdi]);

  const chartVar = useMemo(() => serie.map((d) => ({
    dataLabel: fmtDiaCurto(d.data_ref),
    var: d.var_param_dia_pct != null ? +d.var_param_dia_pct.toFixed(4) : null,
  })), [serie]);

  const chartVarHist = useMemo(() => serie.map((d) => ({
    dataLabel: fmtDiaCurto(d.data_ref),
    varHist: d.var_95_hist_21d_pct != null ? +d.var_95_hist_21d_pct.toFixed(4) : null,
  })), [serie]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 pl-8 text-xs text-gray-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Carregando série...
      </div>
    );
  }

  function badgeCdi(status: string) {
    if (status === "ok")      return <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">OK</span>;
    if (status === "atencao") return <span className="text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold">ATENÇÃO</span>;
    return <span className="text-gray-300 text-[9px]">—</span>;
  }

  return (
    <div className="px-8 py-4 bg-slate-50/80">
      {serie.length === 0 ? (
        <div className="text-xs text-gray-400 py-2">
          Sem histórico disponível. Clique em "Recalcular" para popular os dados.
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {/* Tabela últimos 10 dias */}
          <div>
            <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
              Últimos {Math.min(10, ultimos10.length)} dias
            </div>
            <div className="overflow-auto rounded-md border border-gray-200">
              <table className="w-full text-[11px] border-collapse">
                <thead className="bg-slate-100 text-gray-600">
                  <tr>
                    <th className="py-1.5 px-2 text-left font-semibold">Data</th>
                    <th className="py-1.5 px-2 text-right font-semibold">PL</th>
                    <th className="py-1.5 px-2 text-right font-semibold">Cota</th>
                    <th className="py-1.5 px-2 text-right font-semibold">Δ Cota</th>
                    <th className="py-1.5 px-2 text-right font-semibold">CDI (acum.)</th>
                    <th className="py-1.5 px-2 text-right font-semibold">Δ CDI</th>
                    <th className="py-1.5 px-2 text-right font-semibold">Relação</th>
                    <th className="py-1.5 px-2 text-center font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {ultimos10.map((d, i) => (
                    <tr key={d.data_ref} className={i % 2 === 0 ? "bg-white" : "bg-slate-50/60"}>
                      <td className="py-1.5 px-2 font-mono text-gray-700">{fmtDia(d.data_ref)}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                        {d.pl != null ? fmtRSCompact(d.pl) : "—"}
                      </td>
                      <td className="py-1.5 px-2 text-right tabular-nums text-gray-700">
                        {d.cota != null ? d.cota.toFixed(6) : "—"}
                      </td>
                      <td className={cn("py-1.5 px-2 text-right tabular-nums",
                        d.delta_cota_pct != null && d.delta_cota_pct < 0 ? "text-red-600" : "text-emerald-700")}>
                        {d.delta_cota_pct != null ? `${(d.delta_cota_pct * 100).toFixed(4)}%` : "—"}
                      </td>
                      <td className="py-1.5 px-2 text-right tabular-nums text-gray-500">
                        {d.cdi_valor != null ? d.cdi_valor.toFixed(6) : "—"}
                      </td>
                      <td className="py-1.5 px-2 text-right tabular-nums text-gray-500">
                        {d.delta_cdi_pct != null ? `${(d.delta_cdi_pct * 100).toFixed(4)}%` : "—"}
                      </td>
                      <td className="py-1.5 px-2 text-right tabular-nums">
                        {d.relacao_cota_cdi != null ? `${d.relacao_cota_cdi.toFixed(1)}×` : "—"}
                      </td>
                      <td className="py-1.5 px-2 text-center">{badgeCdi(d.status_cota_cdi)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Gráficos */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white border border-gray-200 rounded-lg p-3">
              <div className="text-[10px] font-semibold text-gray-600 mb-3">
                Cota vs CDI — base 100 (primeiro dia da janela)
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={chartCotaCdi} margin={{ top: 2, right: 8, bottom: 2, left: 4 }}>
                  <XAxis dataKey="dataLabel" tick={{ fontSize: 9, fill: "#9CA3AF" }} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 9, fill: "#9CA3AF" }} tickLine={false} tickFormatter={(v) => v.toFixed(0)} />
                  <RTooltip
                    contentStyle={{ fontSize: 10, borderRadius: 4 }}
                    formatter={(v: number, name: string) => [`${v.toFixed(2)}`, name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 9 }} iconType="line" />
                  <Line name="Cota" dataKey="cota" stroke="#2563EB" strokeWidth={1.5} dot={false} connectNulls />
                  <Line name="CDI" dataKey="cdi" stroke="#D97706" strokeWidth={1.5} strokeDasharray="4 2" dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-3">
              <div className="text-[10px] font-semibold text-gray-600 mb-3">
                VaR Paramétrico diário ilustrativo (1,645 × |Δcota|) — magnitude positiva
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={chartVar} margin={{ top: 2, right: 8, bottom: 2, left: 4 }}>
                  <XAxis dataKey="dataLabel" tick={{ fontSize: 9, fill: "#9CA3AF" }} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 9, fill: "#9CA3AF" }} tickLine={false} tickFormatter={(v) => `${v.toFixed(2)}%`} />
                  <RTooltip
                    contentStyle={{ fontSize: 10, borderRadius: 4 }}
                    formatter={(v: number) => [`${v.toFixed(3)}%`, "VaR param dia"]}
                  />
                  <ReferenceLine y={0} stroke="#E5E7EB" />
                  <Line name="VaR param dia" dataKey="var" stroke="#DC2626" strokeWidth={1.5} dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-3">
              <div className="text-[10px] font-semibold text-gray-600 mb-3">
                VaR Histórico 95% — 21d (max(0, -P5))
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={chartVarHist} margin={{ top: 2, right: 8, bottom: 2, left: 4 }}>
                  <XAxis dataKey="dataLabel" tick={{ fontSize: 9, fill: "#9CA3AF" }} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 9, fill: "#9CA3AF" }} tickLine={false} tickFormatter={(v) => `${v.toFixed(2)}%`} />
                  <RTooltip
                    contentStyle={{ fontSize: 10, borderRadius: 4 }}
                    formatter={(v: number) => [`${v.toFixed(3)}%`, "VaR Hist 21d"]}
                  />
                  <ReferenceLine y={0} stroke="#E5E7EB" />
                  <Line name="VaR Hist 21d" dataKey="varHist" stroke="#7C3AED" strokeWidth={1.5} dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── TabFundos principal ──────────────────────────────────────────────────

type FundoSortKey =
  | "nome_fundo" | "var_95_hist_21d_pct" | "var_95_param_1d_pct" | "drawdown_atual_pct"
  | "drawdown_max_pct" | "relacao_cota_cdi" | "qualidade_serie_status";

function TabFundos({
  fundos,
  isLoading,
  error,
}: {
  fundos: FundoRiscoSimplificado[];
  isLoading: boolean;
  error: unknown;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch]             = useState("");
  const [expandedRows, setExpanded]     = useState<Set<string>>(new Set());
  const [sort, setSort]                 = useState<{ key: FundoSortKey; dir: "asc" | "desc" }>({
    key: "var_95_param_1d_pct", dir: "desc",
  });
  const [isExporting, setIsExporting]       = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);

  const { data: ultimaExec } = useQuery<RiscoMercadoFundosCalcLog | null>({
    queryKey: ["risco-mercado-fundos-ultima-exec"],
    queryFn:  fetchUltimaExecucaoRiscoMercadoFundos,
    staleTime: 60_000,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = fundos.filter((f) => {
      if (!q) return true;
      return (f.nome_fundo ?? "").toLowerCase().includes(q) || f.cnpj.includes(q);
    });
    rows = [...rows].sort((a, b) => {
      const av = a[sort.key] ?? (sort.dir === "asc" ? Infinity : -Infinity);
      const bv = b[sort.key] ?? (sort.dir === "asc" ? Infinity : -Infinity);
      if (typeof av === "string")
        return sort.dir === "asc" ? av.localeCompare(bv as string) : (bv as string).localeCompare(av);
      return sort.dir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return rows;
  }, [fundos, search, sort]);

  const kpis = useMemo(() => {
    // Convenção V3: VaR = magnitude positiva. "Pior" = maior valor (mais perda potencial).
    const comVar   = filtered.filter((f) => f.var_95_param_1d_pct != null);
    const avgVar   = comVar.length ? comVar.reduce((s, f) => s + (f.var_95_param_1d_pct ?? 0), 0) / comVar.length : null;
    const piorVar  = comVar.length ? Math.max(...comVar.map((f) => f.var_95_param_1d_pct ?? 0)) : null;
    const nAtencao = filtered.filter((f) => f.status_cota_cdi === "atencao").length;
    const nSerieSuspeita = filtered.filter((f) => f.serie_suspeita).length;
    return { total: filtered.length, avgVar, piorVar, nAtencao, nSerieSuspeita };
  }, [filtered]);

  function handleSort(key: FundoSortKey) {
    setSort((s) => s.key === key
      ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
      : { key, dir: "asc" });
  }

  function toggleRow(cnpj: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(cnpj) ? next.delete(cnpj) : next.add(cnpj);
      return next;
    });
  }

  async function handleRecalcular() {
    setIsRecalculating(true);
    try {
      const result = await recalcularRiscoMercadoFundos();
      if (result.ok) {
        toast.success(`Recálculo concluído — ${result.message}`);
      } else {
        toast.error(`Erro no recálculo: ${result.message}`);
      }
    } catch (e) {
      toast.error(`Erro inesperado: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsRecalculating(false);
      await queryClient.invalidateQueries({ queryKey: ["risco-mercado-fundos-simplificado"] });
      await queryClient.invalidateQueries({ queryKey: ["risco-mercado-fundos-ultima-exec"] });
    }
  }

  function fmtUltimaExec(): string {
    if (!ultimaExec) return "nunca executado";
    try {
      const d = format(parseISO(ultimaExec.iniciado_em), "dd/MM HH:mm", { locale: ptBR });
      const s = ultimaExec.status === "success" ? "OK" : "ERRO";
      return `${d} · ${s}`;
    } catch {
      return ultimaExec.iniciado_em;
    }
  }

  function exportarExcel() {
    if (!filtered.length) return;
    setIsExporting(true);
    try {
      const HDR = [
        "Fundo", "CNPJ", "Data Ref",
        "VaR Histórico 95% — 21d (%)", "VaR Histórico 95% — 21d (R$)",
        "VaR Paramétrico 95% — 1d (%)", "VaR Paramétrico 95% — 1d (R$)", "Volatilidade σ (%)",
        "Drawdown Atual (%)", "Drawdown Máx (%)",
        "Δ Cota", "Δ CDI", "Relação Cota/CDI", "Status Cota/CDI", "n Obs 21d (janelas)",
        "Qualidade da Série", "Série Suspeita", "Alertas da Série", "Extremos 1d", "Extremos 21d", "Gap Máx (dias)",
      ];
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([HDR]);
      ws["!cols"] = HDR.map(() => ({ wch: 14 }));
      ws["!cols"][0] = { wch: 45 }; ws["!cols"][1] = { wch: 18 }; ws["!cols"][2] = { wch: 12 };
      HDR.forEach((_, ci) => {
        const ref = XLSX.utils.encode_cell({ r: 0, c: ci });
        ws[ref] = { v: HDR[ci], t: "s", s: { fill: xFill(SYS.accent), font: xFont("#FFFFFF", true, 9), alignment: xAlign("center") } };
      });
      const pctCols = [3, 5, 7, 8, 9, 10, 11];
      // VaR/DD/Vol são magnitude positiva (V3) — destaca em vermelho quando alto, não quando negativo.
      const magnitudeCols = [3, 5, 8, 9]; // VaR Hist %, VaR Param %, DD Atual %, DD Máx %
      filtered.forEach((f, ri) => {
        const row: (string | number | null)[] = [
          f.nome_fundo ?? "", f.cnpj, f.data_ref,
          f.var_95_hist_21d_pct != null ? f.var_95_hist_21d_pct / 100 : null,
          f.var_95_hist_21d_rs ?? null,
          f.var_95_param_1d_pct != null ? f.var_95_param_1d_pct / 100 : null,
          f.var_95_param_1d_rs ?? null,
          f.sigma_diario_pct != null ? f.sigma_diario_pct / 100 : null,
          f.drawdown_atual_pct != null ? f.drawdown_atual_pct / 100 : null,
          f.drawdown_max_pct != null ? f.drawdown_max_pct / 100 : null,
          f.delta_cota_pct ?? null,
          f.delta_cdi_pct ?? null,
          f.relacao_cota_cdi ?? null,
          f.status_cota_cdi,
          f.n_obs_21d ?? null,
          f.qualidade_serie_status ?? null,
          f.serie_suspeita ? "SIM" : "NAO",
          (f.serie_alertas ?? []).join(", "),
          f.serie_extremos_1d ?? null,
          f.serie_extremos_21d ?? null,
          f.serie_maior_gap_dias ?? null,
        ];
        const rowBg = ri % 2 === 0 ? "#FFFFFF" : "#F8FAFB";
        row.forEach((v, ci) => {
          const ref = XLSX.utils.encode_cell({ r: ri + 1, c: ci });
          const isNum = typeof v === "number";
          const isRisco = magnitudeCols.includes(ci) && isNum && (v as number) > 0.02; // > 2%
          const isRetornoNeg = !magnitudeCols.includes(ci) && pctCols.includes(ci) && isNum && (v as number) < 0;
          ws[ref] = {
            v: v == null ? null : v, t: isNum ? "n" : "s",
            s: {
              fill: xFill(rowBg),
              font: xFont((isRisco || isRetornoNeg) ? SYS.red : SYS.text),
              alignment: xAlign(isNum ? "right" : "left"),
              ...(pctCols.includes(ci) ? { numFmt: "0.00%" } : {}),
            },
          };
        });
      });
      ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: filtered.length, c: HDR.length - 1 } });
      ws["!freeze"] = { xSplit: 2, ySplit: 1 };
      XLSX.utils.book_append_sheet(wb, ws, "Risco Fundos");
      XLSX.writeFile(wb, `risco_mercado_fundos_${filtered.length}.xlsx`);
    } finally {
      setIsExporting(false);
    }
  }

  function exportarPdf() {
    if (!filtered.length) return;
    setIsExportingPdf(true);
    try {
      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const MARGIN = 10;
      const C_HEADER: [number, number, number] = [46, 83, 137];   // SYS.accent
      const C_TEXT: [number, number, number] = [31, 41, 55];
      const C_MUTED: [number, number, number] = [107, 114, 128];
      const C_BORDER: [number, number, number] = [229, 231, 235];
      const C_ROW_ALT: [number, number, number] = [248, 250, 251];
      const C_ALERT_BG: [number, number, number] = [254, 226, 226];
      const C_ALERT_TX: [number, number, number] = [153, 27, 27];
      const C_WARN_BG: [number, number, number] = [254, 243, 199];
      const C_WARN_TX: [number, number, number] = [146, 64, 14];

      const dataBase = filtered[0]?.data_ref ? fmtDataIso(filtered[0].data_ref) : "—";
      const geradoEm = format(new Date(), "dd/MM/yyyy HH:mm", { locale: ptBR });

      autoTable(pdf, {
        startY: MARGIN,
        head: [[sanitizePdfText(`Relatorio Risco de Mercado - Fundos | Data base: ${dataBase}`)]],
        body: [[sanitizePdfText(`Gerado em ${geradoEm} | Frame Control Center`)]],
        theme: "plain",
        margin: { left: MARGIN, right: MARGIN },
        styles: { cellPadding: 2, font: "helvetica" },
        headStyles: { fillColor: C_HEADER, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 11, halign: "center" },
        bodyStyles: { fillColor: C_HEADER, textColor: [255, 255, 255], fontSize: 8, halign: "center" },
      });

      const startY = (pdf as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 3;
      const LIMITE_VAR_1D = 5; // limite usado para consumo de VaR 1d

      const body: unknown[] = [];
      filtered.forEach((f) => {
        const consumoLimite = f.var_95_param_1d_pct != null ? (f.var_95_param_1d_pct / LIMITE_VAR_1D) * 100 : null;
        const stressTexto = f.qualidade_serie_status === "suspeita" ? "ALERTA SERIE" : "—";
        body.push([
          sanitizePdfText(f.nome_fundo ?? f.cnpj),
          sanitizePdfText(fmtRS(f.pl)),
          sanitizePdfText(fmtRS(f.pl)), // Exposicao proxy = PL monitorado
          sanitizePdfText(f.var_95_param_1d_pct != null ? `${f.var_95_param_1d_pct.toFixed(2)}%` : "—"),
          sanitizePdfText(f.var_95_hist_21d_pct != null ? `${f.var_95_hist_21d_pct.toFixed(2)}%` : "—"),
          sanitizePdfText(f.drawdown_max_pct != null ? `${f.drawdown_max_pct.toFixed(2)}%` : "—"),
          sanitizePdfText(stressTexto),
        ]);
        body.push([
          { content: sanitizePdfText(`CNPJ: ${f.cnpj}`), styles: { textColor: C_MUTED, fontStyle: "normal" } },
          sanitizePdfText(`VaR Param R$: ${fmtRSCompact(f.var_95_param_1d_rs)}`),
          sanitizePdfText(`VaR Hist R$: ${fmtRSCompact(f.var_95_hist_21d_rs)}`),
          { content: sanitizePdfText(`Consumo Limite: ${consumoLimite != null ? `${consumoLimite.toFixed(1)}%` : "—"}`), colSpan: 2 },
          { content: sanitizePdfText(`n obs: ${f.n_obs ?? "—"} | n 21d: ${f.n_obs_21d ?? "—"}`), colSpan: 2 },
        ]);
      });

      autoTable(pdf, {
        startY,
        head: [[
          "Fundo", "PL", "Exposicao", "VaR Param 1d 95%", "VaR Hist 21d 95%", "DD Max", "Stress",
        ]],
        body: body as never[],
        margin: { left: MARGIN, right: MARGIN, bottom: 14 },
        theme: "grid",
        styles: {
          fontSize: 7.3,
          cellPadding: { top: 2, right: 2, bottom: 2, left: 2 },
          lineColor: C_BORDER,
          lineWidth: 0.2,
          textColor: C_TEXT,
          valign: "middle",
        },
        headStyles: {
          fillColor: C_HEADER,
          textColor: [255, 255, 255],
          fontStyle: "bold",
          fontSize: 7.2,
          halign: "center",
        },
        alternateRowStyles: { fillColor: C_ROW_ALT },
        columnStyles: {
          0: { cellWidth: 70, halign: "left", fontStyle: "bold" },
          1: { cellWidth: 32, halign: "right" },
          2: { cellWidth: 32, halign: "right" },
          3: { cellWidth: 30, halign: "right" },
          4: { cellWidth: 30, halign: "right" },
          5: { cellWidth: 20, halign: "right" },
          6: { cellWidth: 24, halign: "center", fontStyle: "bold" },
        },
        didParseCell: (hook) => {
          if (hook.section !== "body") return;
          const rowIdx = hook.row.index;
          const isLinhaPrincipal = rowIdx % 2 === 0;
          const fundoIdx = Math.floor(rowIdx / 2);
          const f = filtered[fundoIdx];
          if (!f) return;

          if (isLinhaPrincipal && hook.column.index === 6 && f.qualidade_serie_status === "suspeita") {
            hook.cell.styles.fillColor = C_ALERT_BG;
            hook.cell.styles.textColor = C_ALERT_TX;
          }
          if (!isLinhaPrincipal && hook.column.index >= 1 && hook.column.index <= 4) {
            hook.cell.styles.textColor = C_MUTED;
            hook.cell.styles.fontSize = 6.8;
          }
          if (!isLinhaPrincipal && hook.column.index === 3 && f.var_95_param_1d_pct != null && f.var_95_param_1d_pct > 4) {
            hook.cell.styles.fillColor = C_WARN_BG;
            hook.cell.styles.textColor = C_WARN_TX;
          }
        },
      });

      const finalY = (pdf as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 3;
      autoTable(pdf, {
        startY: finalY,
        body: [[sanitizePdfText(
          "* Exposicao no contexto da aba Fundos usa o PL monitorado por fundo. " +
          "* Consumo Limite = VaR Param 1d / 5,0%. " +
          "* Stress nesta visao representa alerta de qualidade da serie (nao o stress de cenarios da aba Carteiras).",
        )]],
        theme: "plain",
        margin: { left: MARGIN, right: MARGIN },
        styles: { fontSize: 6, cellPadding: { top: 2, right: 3, bottom: 2, left: 3 }, textColor: C_MUTED, fontStyle: "italic" },
      });

      const dataTag = filtered[0]?.data_ref ?? format(new Date(), "yyyy-MM-dd");
      pdf.save(`Risco_Fundos_${dataTag}.pdf`);
    } finally {
      setIsExportingPdf(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* KPIs */}
      {!isLoading && !error && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 px-6">
          <KpiCard
            label="Fundos"
            value={fmt.format(kpis.total)}
            sub="gestores monitorados"
          />
          <KpiCard
            label="VaR Param 95% Médio — 1d"
            value={kpis.avgVar != null ? `${kpis.avgVar.toFixed(2)}%` : "—"}
            sub="1,645 × σ diário"
            color={(kpis.avgVar ?? 0) > 3 ? "text-red-600" : "text-orange-600"}
          />
          <KpiCard
            label="Pior VaR Param — 1d"
            value={kpis.piorVar != null ? `${kpis.piorVar.toFixed(2)}%` : "—"}
            sub="fundo mais arriscado"
            color="text-red-700"
          />
          <KpiCard
            label="Em ATENÇÃO (Cota/CDI)"
            value={fmt.format(kpis.nAtencao)}
            sub="relação > 20×"
            color={kpis.nAtencao > 0 ? "text-amber-600" : "text-emerald-700"}
          />
          <KpiCard
            label="Série suspeita"
            value={fmt.format(kpis.nSerieSuspeita)}
            sub="qualidade da série"
            color={kpis.nSerieSuspeita > 0 ? "text-red-700" : "text-emerald-700"}
          />
        </div>
      )}

      {/* Toolbar */}
      <div className="px-6 flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <Input
            className="pl-8 h-8 text-xs"
            placeholder="Buscar fundo, CNPJ..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {search && (
          <Button variant="ghost" size="sm" className="h-8 text-xs text-gray-500"
            onClick={() => setSearch("")}>
            Limpar
          </Button>
        )}

        {/* Status da última execução */}
        {ultimaExec && (
          <span className={cn(
            "text-[10px] tabular-nums hidden sm:inline",
            ultimaExec.status === "success" ? "text-gray-400" : "text-red-500 font-medium",
          )}>
            última execução: {fmtUltimaExec()}
          </span>
        )}

        {/* Recalcular */}
        <Button
          variant="outline"
          size="sm"
          onClick={handleRecalcular}
          disabled={isRecalculating}
          className="h-8 text-xs"
          title="Recalcula métricas para todos os fundos (XML + histórico manual)"
        >
          {isRecalculating
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <RefreshCw className="h-3.5 w-3.5" />}
          {isRecalculating ? "Recalculando..." : "Recalcular"}
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={exportarPdf}
          disabled={!filtered.length || isExportingPdf}
          className="h-8 text-xs"
        >
          {isExportingPdf ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
          {isExportingPdf ? "Gerando PDF..." : "PDF"}
        </Button>

        <Button
          size="sm"
          onClick={exportarExcel}
          disabled={!filtered.length || isExporting}
          className="h-8 text-xs bg-[#2E5389] hover:bg-[#1e3d6b] text-white ml-auto"
        >
          {isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {isExporting ? "Exportando..." : `Exportar ${filtered.length}`}
        </Button>
      </div>

      {/* Tabela */}
      {isLoading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : error ? (
        <div className="mx-6 p-4 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          Erro: {error instanceof Error ? error.message : String(error)}
        </div>
      ) : (
        <div className="px-6 pb-6 overflow-auto">
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-[12px] border-collapse">
              <thead className="bg-[#2E5389] text-white sticky top-0 z-10">
                <tr>
                  <th className="w-7" />
                  {/* Fundo */}
                  <th
                    className="py-2.5 px-3 text-left font-medium text-[11px] cursor-pointer select-none hover:bg-white/10 transition-colors"
                    onClick={() => handleSort("nome_fundo")}
                  >
                    Fundo
                    <SortIcon active={sort.key === "nome_fundo"} dir={sort.dir} />
                  </th>
                  {/* VaR Histórico 95% — 21d */}
                  <th
                    className="py-2.5 px-3 text-right font-medium text-[11px] cursor-pointer select-none hover:bg-white/10 transition-colors"
                    onClick={() => handleSort("var_95_hist_21d_pct")}
                  >
                    <TooltipProvider delayDuration={100}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help underline decoration-dotted">VaR Hist 95% — 21d</span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-[11px] max-w-[260px]">
                          Oficial · horizonte 21 dias úteis · max(0, −P5(retornos rolling 21d)) ·
                          magnitude positiva · até 252 janelas, mín. 100
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <SortIcon active={sort.key === "var_95_hist_21d_pct"} dir={sort.dir} />
                  </th>
                  {/* VaR Paramétrico 95% — 1d */}
                  <th
                    className="py-2.5 px-3 text-right font-medium text-[11px] cursor-pointer select-none hover:bg-white/10 transition-colors"
                    onClick={() => handleSort("var_95_param_1d_pct")}
                  >
                    <TooltipProvider delayDuration={100}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help underline decoration-dotted">VaR Param 95% — 1d</span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-[11px] max-w-[260px]">
                          Oficial · horizonte 1 dia útil · 1,645 × σ diário · magnitude positiva ·
                          janela trailing até 252 obs, mín. 20
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <SortIcon active={sort.key === "var_95_param_1d_pct"} dir={sort.dir} />
                  </th>
                  {/* Volatilidade */}
                  <th className="py-2.5 px-3 text-right font-medium text-[11px]">
                    Volatilidade (σ)
                  </th>
                  {/* Drawdown Atual */}
                  <th
                    className="py-2.5 px-3 text-right font-medium text-[11px] cursor-pointer select-none hover:bg-white/10 transition-colors"
                    onClick={() => handleSort("drawdown_atual_pct")}
                  >
                    Drawdown Atual
                    <SortIcon active={sort.key === "drawdown_atual_pct"} dir={sort.dir} />
                  </th>
                  {/* Cota vs CDI */}
                  <th
                    className="py-2.5 px-3 text-center font-medium text-[11px] cursor-pointer select-none hover:bg-white/10 transition-colors"
                    onClick={() => handleSort("relacao_cota_cdi")}
                  >
                    <TooltipProvider delayDuration={100}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help underline decoration-dotted">Cota vs CDI</span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-[11px]">
                          |Δcota do dia| / |ΔCDI do dia| · alerta quando &gt; 20×
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <SortIcon active={sort.key === "relacao_cota_cdi"} dir={sort.dir} />
                  </th>
                  {/* Qualidade da Série */}
                  <th
                    className="py-2.5 px-3 text-center font-medium text-[11px] cursor-pointer select-none hover:bg-white/10 transition-colors"
                    onClick={() => handleSort("qualidade_serie_status")}
                  >
                    <TooltipProvider delayDuration={100}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help underline decoration-dotted">Qualidade da Série</span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-[11px] max-w-[320px]">
                          ⚠️ Série suspeita quando houver DD &gt; 50%, retorno extremo (1d/21d),
                          quebra de série, proxy de troca de CNPJ/estrutura ou histórico baixo.
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <SortIcon active={sort.key === "qualidade_serie_status"} dir={sort.dir} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-gray-400 text-sm">
                      {fundos.length === 0
                        ? 'Nenhum fundo de gestor monitorado. Verifique gestores_monitorados ou clique em "Recalcular".'
                        : "Nenhum fundo encontrado."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((f, idx) => {
                    const isExpanded = expandedRows.has(f.cnpj);
                    const rowBg = idx % 2 === 0 ? "bg-white" : "bg-gray-50/60";
                    return (
                      <React.Fragment key={f.cnpj}>
                        <tr
                          className={cn(
                            rowBg, "border-b border-gray-100 cursor-pointer hover:bg-blue-50/40 transition-colors",
                            isExpanded && "bg-blue-50/30",
                          )}
                          onClick={() => toggleRow(f.cnpj)}
                        >
                          <td className="pl-3 pr-1">
                            {isExpanded
                              ? <ChevronUp   className="h-3.5 w-3.5 text-blue-500" />
                              : <ChevronDown className="h-3.5 w-3.5 text-gray-400" />}
                          </td>
                          {/* Fundo */}
                          <td className="py-2.5 px-3 max-w-[280px]">
                            <div className="font-medium text-gray-800 leading-tight truncate">
                              {f.nome_fundo ?? f.cnpj}
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-gray-400 font-mono">{f.cnpj}</span>
                              {f.fonte_cota === "hibrido_manual_xml" && (
                                <span className="text-[9px] px-1 py-0.5 rounded bg-sky-100 text-sky-700 font-semibold">
                                  XML+Manual
                                </span>
                              )}
                            </div>
                          </td>
                          {/* VaR Histórico 95% — 21d (magnitude positiva) */}
                          <td className="py-2.5 px-3 text-right">
                            <div className={cn("tabular-nums font-medium", colorVarMagnitude(f.var_95_hist_21d_pct))}>
                              {f.var_95_hist_21d_pct != null ? `${f.var_95_hist_21d_pct.toFixed(2)}%` : "—"}
                            </div>
                            {f.var_95_hist_21d_rs != null && (
                              <div className="text-[10px] text-gray-400 tabular-nums">
                                {fmtRSCompact(f.var_95_hist_21d_rs)}
                              </div>
                            )}
                            {f.n_obs_21d != null && (
                              <div className="text-[10px] text-gray-400">n={f.n_obs_21d} janelas</div>
                            )}
                          </td>
                          {/* VaR Paramétrico 95% — 1d (magnitude positiva) */}
                          <td className="py-2.5 px-3 text-right">
                            <div className={cn("tabular-nums font-medium", colorVarMagnitude(f.var_95_param_1d_pct))}>
                              {f.var_95_param_1d_pct != null ? `${f.var_95_param_1d_pct.toFixed(2)}%` : "—"}
                            </div>
                            {f.var_95_param_1d_rs != null && (
                              <div className="text-[10px] text-gray-400 tabular-nums">
                                {fmtRSCompact(f.var_95_param_1d_rs)}
                              </div>
                            )}
                          </td>
                          {/* Volatilidade */}
                          <td className="py-2.5 px-3 text-right tabular-nums text-gray-600">
                            {f.sigma_diario_pct != null ? `${f.sigma_diario_pct.toFixed(3)}%` : "—"}
                            {f.n_obs != null && (
                              <div className="text-[10px] text-gray-400">n={f.n_obs}</div>
                            )}
                          </td>
                          {/* Drawdown Atual */}
                          <td className="py-2.5 px-3 text-right">
                            <div className={cn("tabular-nums font-medium", colorDD(f.drawdown_atual_pct))}>
                              {f.drawdown_atual_pct != null ? `${f.drawdown_atual_pct.toFixed(2)}%` : "—"}
                            </div>
                            {f.drawdown_max_pct != null && (
                              <div className="text-[10px] text-gray-400 tabular-nums">
                                máx {f.drawdown_max_pct.toFixed(2)}%
                              </div>
                            )}
                          </td>
                          {/* Cota vs CDI */}
                          <td className="py-2.5 px-3 text-center">
                            {f.relacao_cota_cdi != null ? (
                              <div className="flex flex-col items-center gap-0.5">
                                <span className="tabular-nums text-[11px] text-gray-700">
                                  {f.relacao_cota_cdi.toFixed(1)}×
                                </span>
                                <span className={cn(
                                  "text-[9px] px-1 py-0.5 rounded font-semibold",
                                  f.status_cota_cdi === "atencao"
                                    ? "bg-amber-100 text-amber-700"
                                    : "bg-emerald-100 text-emerald-700",
                                )}>
                                  {f.status_cota_cdi === "atencao" ? "ATENÇÃO" : "OK"}
                                </span>
                              </div>
                            ) : (
                              <span className="text-gray-300 text-[10px]">—</span>
                            )}
                          </td>
                          {/* Qualidade da Série */}
                          <td className="py-2.5 px-3 text-center">
                            <SerieQualidadeBadge
                              status={f.qualidade_serie_status}
                              alertas={f.serie_alertas}
                            />
                            {f.serie_maior_gap_dias != null && f.serie_maior_gap_dias > 0 && (
                              <div className="text-[10px] text-gray-400 mt-0.5">
                                gap máx {f.serie_maior_gap_dias}d
                              </div>
                            )}
                          </td>
                        </tr>

                        {/* Linha expandida — drill-down */}
                        {isExpanded && (
                          <tr>
                            <td colSpan={8} className="p-0 border-b border-blue-100">
                              <FundoDrillDown cnpj={f.cnpj} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ABA EVOLUÇÃO TEMPORAL
// ══════════════════════════════════════════════════════════════════════════

function TabEvolucao({ carteiras }: { carteiras: CarteiraRiscoExtendida[] }) {
  const comSerie = carteiras.filter((c) => c.serie_var && c.serie_var.length > 0);
  const [selectedCli, setSelectedCli] = useState<string>(() =>
    comSerie.length > 0 ? String(comSerie[0].cod_cli ?? comSerie[0].cliente) : "",
  );

  const selected = carteiras.find(
    (c) => String(c.cod_cli ?? c.cliente) === selectedCli,
  );

  const chartData = useMemo(() => {
    if (!selected?.serie_var) return [];
    return selected.serie_var.map((p: VarSeriePoint) => ({
      data: p.data_ref,
      dataLabel: (() => {
        try { return format(parseISO(p.data_ref), "dd/MM/yy"); } catch { return p.data_ref; }
      })(),
      hist:     p.var_95_hist    != null ? +(p.var_95_hist    * 100).toFixed(3) : null,
      param:    p.var_95_param   != null ? +(p.var_95_param   * 100).toFixed(3) : null,
      mc_t:     p.var_95_mc_t    != null ? +(p.var_95_mc_t    * 100).toFixed(3) : null,
      diversif: p.var_95_diversif != null ? +(p.var_95_diversif * 100).toFixed(3) : null,
    }));
  }, [selected]);

  const temDados = chartData.length > 0;

  return (
    <div className="px-6 py-4 flex flex-col gap-4">
      {/* Seletor de carteira */}
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium text-gray-600">Carteira:</span>
        <Select value={selectedCli} onValueChange={setSelectedCli}>
          <SelectTrigger className="w-72 h-8 text-xs">
            <SelectValue placeholder="Selecione uma carteira..." />
          </SelectTrigger>
          <SelectContent>
            {comSerie.map((c) => (
              <SelectItem key={c.cod_cli ?? c.cliente} value={String(c.cod_cli ?? c.cliente)} className="text-xs">
                {c.cliente}
              </SelectItem>
            ))}
            {comSerie.length === 0 && (
              <SelectItem value="_vazio" disabled className="text-xs text-gray-400">
                Nenhuma carteira com histórico
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        {selected?.status && selected.status !== "sem_dados" && (
          <StatusBadge status={selected.status} />
        )}
      </div>

      {!temDados ? (
        <div className="flex items-center justify-center h-64 bg-white border border-gray-200 rounded-lg">
          <div className="text-center text-gray-400 text-sm">
            <BarChart2 className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>Sem histórico de VaR disponível para esta carteira.</p>
            <p className="text-[11px] mt-1">Execute <code>calcular_var_completo.py</code> para popular var_historico_carteira.</p>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-[11px] font-semibold text-gray-700 mb-1">
            VaR 95% — Evolução Temporal · {selected?.cliente}
          </div>
          <div className="text-[10px] text-gray-400 mb-3">Horizonte 21 dias úteis · valores em %</div>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
              <XAxis
                dataKey="dataLabel"
                tick={{ fontSize: 10, fill: "#9CA3AF" }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#9CA3AF" }}
                tickLine={false}
                tickFormatter={(v) => `${v.toFixed(1)}%`}
              />
              <RTooltip
                contentStyle={{ fontSize: 11, borderRadius: 6 }}
                formatter={(value: number, name: string) => [
                  value != null ? `${value.toFixed(2)}%` : "—",
                  name,
                ]}
              />
              <Legend
                wrapperStyle={{ fontSize: 10, paddingTop: 8 }}
                iconType="line"
              />
              {selected?.limite_95 != null && (
                <ReferenceLine
                  y={-selected.limite_95}
                  stroke="#DC2626"
                  strokeDasharray="6 3"
                  label={{ value: "Limite", position: "right", fontSize: 10, fill: "#DC2626" }}
                />
              )}
              <Line
                name="VaR Histórico"
                dataKey="hist"
                stroke="#DC2626"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              <Line
                name="VaR Paramétrico"
                dataKey="param"
                stroke="#EA580C"
                strokeWidth={1.5}
                strokeDasharray="4 2"
                dot={false}
                connectNulls
              />
              <Line
                name="VaR MC(t)"
                dataKey="mc_t"
                stroke="#2563EB"
                strokeWidth={1.5}
                strokeDasharray="2 2"
                dot={false}
                connectNulls
              />
              <Line
                name="VaR Diversificado"
                dataKey="diversif"
                stroke="#16A34A"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
          <div className="mt-2 flex gap-4 text-[10px] text-gray-500 flex-wrap">
            {selected?.var_95_hist_rs != null && (
              <span>VaR Hist R$: <strong className="text-red-600">{fmtRSCompact(selected.var_95_hist_rs)}</strong></span>
            )}
            {selected?.var_95_diversif_rs != null && (
              <span>VaR Diversif R$: <strong className="text-emerald-600">{fmtRSCompact(selected.var_95_diversif_rs)}</strong></span>
            )}
            {selected?.beneficio_diversif_rs != null && (
              <span>Economia: <strong className="text-emerald-600">{fmtRSCompact(selected.beneficio_diversif_rs)}</strong></span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchRiscoMercadoV2(dataPosicao?: string | null): Promise<RiscoV2Response> {
  const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL ?? "";
  const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";
  const qs = dataPosicao ? `?data_posicao=${encodeURIComponent(dataPosicao)}` : "";
  const r = await fetch(
    `${SUPABASE_URL}/functions/v1/buscar-risco-mercado-v2${qs}`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
  );
  const json = await r.json();
  if (!r.ok || json?.success === false) {
    throw new Error(json?.error ?? `HTTP ${r.status}`);
  }
  return json as RiscoV2Response;
}

async function fetchDatasPosicaoDiaria(): Promise<string[]> {
  const seen = new Set<string>();
  let from = 0;
  const PAGE = 1000;
  for (let i = 0; i < 50; i++) {
    const { data, error } = await supabase
      .from("posicao_diaria")
      .select("data_posicao")
      .order("data_posicao", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) break;
    if (!data?.length) break;
    for (const row of data) {
      const d = (row as { data_posicao: string }).data_posicao;
      if (d) seen.add(d);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return [...seen].sort((a, b) => b.localeCompare(a));
}

function fmtDataIso(iso: string): string {
  return format(parseISO(`${iso}T12:00:00`), "dd/MM/yyyy", { locale: ptBR });
}

// ══════════════════════════════════════════════════════════════════════════
// PÁGINA PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// IMPORTAÇÃO DE HISTÓRICO MANUAL
// Fundos com quebra de série conhecida (mudança de estrutura jurídica)
// ══════════════════════════════════════════════════════════════════════════

// Fundos conhecidos com quebra de série documentada.
// Fundos não listados ainda podem ser importados usando a opção "Outro fundo".
const FUNDOS_COM_QUEBRA = [
  {
    cnpj: "45653388000168",
    nome: "QI CP PLUS",
    dataCorte: "2024-10-08",
    motivo: "Mudança FIM → FIDC (08/10/2024)",
  },
  // Adicionar outros fundos conforme identificados via:
  // SELECT cnpj, nome_fundo, data_base_calculo FROM betas_por_cnpj ORDER BY data_base_calculo DESC
];

const OUTRO_FUNDO_KEY = "__outro__";

function ImportarHistoricoManualButton() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Começa VAZIO — usuário precisa escolher explicitamente o fundo
  const [fundoSelecionado, setFundoSelecionado] = useState<string>("");
  const [cnpjManual, setCnpjManual] = useState("");
  const [dataCorteManual, setDataCorteManual] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isOutro = fundoSelecionado === OUTRO_FUNDO_KEY;
  const fundoCadastrado = FUNDOS_COM_QUEBRA.find((f) => f.cnpj === fundoSelecionado);

  const cnpjEfetivo = isOutro ? cnpjManual.replace(/\D/g, "") : (fundoCadastrado?.cnpj ?? "");
  const dataCorteEfetiva = isOutro ? dataCorteManual : (fundoCadastrado?.dataCorte ?? "");
  const nomeEfetivo = isOutro
    ? (cnpjEfetivo ? `CNPJ ${cnpjEfetivo}` : "fundo manual")
    : (fundoCadastrado?.nome ?? "");

  const fundoEscolhido = fundoSelecionado !== "";
  const podeImportar =
    fundoEscolhido &&
    cnpjEfetivo.length === 14 &&
    /^\d{4}-\d{2}-\d{2}$/.test(dataCorteEfetiva) &&
    !uploading;

  // Resetar seleção ao abrir o dialog
  const abrirDialog = () => {
    setFundoSelecionado("");
    setCnpjManual("");
    setDataCorteManual("");
    setDialogOpen(true);
  };

  const executarImportacao = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("cnpj", cnpjEfetivo);
      formData.append("data_corte", dataCorteEfetiva);

      const { data, error } = await supabase.functions.invoke("importar-historico-manual", {
        body: formData,
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? "Falha desconhecida");

      toast.success(
        `Histórico ${nomeEfetivo} importado! ` +
        `${data.total_dias_importados} dias da planilha + ` +
        `${data.dias_merged_cvm} dias CVM = ` +
        `${data.total_serie_final} dias totais` +
        (data.eventos_corporativos_filtrados > 0
          ? ` (${data.eventos_corporativos_filtrados} evento(s) corporativo(s) filtrado(s))`
          : ""),
        { duration: 6000 },
      );

      await queryClient.invalidateQueries({ queryKey: ["risco-mercado-v2"] });
      setDialogOpen(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Erro ao importar: ${msg}`, { duration: 10000 });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await executarImportacao(file);
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={abrirDialog}
        className="h-8 text-xs hidden sm:inline-flex"
        title="Importar série histórica manual (fundos com quebra de CNPJ/tipo)"
      >
        <Upload className="h-3.5 w-3.5" />
        Histórico Manual
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Importar Histórico Manual</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Usado para fundos com quebra de série histórica (mudança de CNPJ ou tipo jurídico).
              Os dados serão gravados com{" "}
              <code className="bg-muted px-1 rounded text-[10px]">fonte = historico_manual</code>.
            </p>

            {/* ── Seletor de fundo ── obrigatório antes de habilitar upload */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">
                1. Selecione o fundo de destino
              </Label>
              <Select
                value={fundoSelecionado}
                onValueChange={setFundoSelecionado}
              >
                <SelectTrigger
                  className={cn(
                    "h-9 text-xs",
                    !fundoEscolhido && "border-amber-400 ring-1 ring-amber-300",
                  )}
                >
                  <SelectValue placeholder="— Escolha o fundo antes de continuar —" />
                </SelectTrigger>
                <SelectContent>
                  {FUNDOS_COM_QUEBRA.map((f) => (
                    <SelectItem key={f.cnpj} value={f.cnpj} className="text-xs">
                      <span className="font-medium">{f.nome}</span>
                      <span className="text-muted-foreground ml-2 text-[10px]">
                        corte {f.dataCorte} · {f.motivo}
                      </span>
                    </SelectItem>
                  ))}
                  <SelectItem value={OUTRO_FUNDO_KEY} className="text-xs italic">
                    Outro fundo — informar CNPJ manualmente
                  </SelectItem>
                </SelectContent>
              </Select>
              {!fundoEscolhido && (
                <p className="text-[10px] text-amber-600 font-medium">
                  Selecione o fundo antes de escolher a planilha. Sem isso o arquivo será rejeitado.
                </p>
              )}
            </div>

            {/* ── Campos manuais para "Outro fundo" ── */}
            {isOutro && (
              <div className="space-y-3 border rounded-md p-3 bg-muted/30">
                <div className="space-y-1.5">
                  <Label className="text-xs">CNPJ (14 dígitos, somente números)</Label>
                  <Input
                    className="h-8 text-xs font-mono"
                    placeholder="Ex: 45653388000168"
                    maxLength={14}
                    value={cnpjManual}
                    onChange={(e) => setCnpjManual(e.target.value.replace(/\D/g, "").slice(0, 14))}
                  />
                  {cnpjManual.length > 0 && cnpjManual.length < 14 && (
                    <p className="text-[10px] text-amber-600">
                      {14 - cnpjManual.length} dígitos restantes
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Data de corte (YYYY-MM-DD)</Label>
                  <Input
                    className="h-8 text-xs font-mono"
                    placeholder="Ex: 2024-10-08"
                    value={dataCorteManual}
                    onChange={(e) => setDataCorteManual(e.target.value)}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Dados da planilha serão gravados até esta data (exclusive).
                    Registros CVM a partir desta data são preservados.
                  </p>
                </div>
              </div>
            )}

            {/* ── Confirmação de destino — aparece apenas quando tudo está pronto ── */}
            {podeImportar && (
              <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 space-y-1">
                <p className="text-[11px] font-semibold text-emerald-800">
                  2. Confirme o destino e selecione a planilha
                </p>
                <p className="text-[11px] text-emerald-700">
                  <strong>Fundo:</strong> {nomeEfetivo}
                </p>
                <p className="text-[11px] text-emerald-700">
                  <strong>CNPJ:</strong> {cnpjEfetivo}
                </p>
                <p className="text-[11px] text-emerald-700">
                  <strong>Data de corte:</strong> {dataCorteEfetiva}
                </p>
                <p className="text-[10px] text-emerald-600 mt-1 leading-relaxed">
                  Registros anteriores a {dataCorteEfetiva} serão substituídos.
                  Registros a partir desta data são mantidos.
                </p>
              </div>
            )}
          </div>

          <DialogFooter className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDialogOpen(false)}
              className="text-xs"
            >
              Cancelar
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xls,.xlsx,.html,.htm"
              onChange={handleFileSelect}
              className="hidden"
              aria-hidden="true"
            />
            <Button
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={!podeImportar}
              className="text-xs"
              title={!fundoEscolhido ? "Selecione o fundo primeiro" : undefined}
            >
              {uploading
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Importando...</>
                : <><Upload className="h-3.5 w-3.5 mr-1.5" />Selecionar planilha</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════

export default function RiscoMercado() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [calOpen, setCalOpen] = useState(false);
  const [isExportingAll, setIsExportingAll] = useState(false);
  const [isExportingConsolidado, setIsExportingConsolidado] = useState<"excel" | "pdf" | null>(null);

  const dataParam = searchParams.get("data");

  const { data: datasDisponiveis = [] } = useQuery({
    queryKey: ["risco-mercado-datas"],
    queryFn: fetchDatasPosicaoDiaria,
    staleTime: 5 * 60_000,
  });

  const { data: resp, isLoading, error, refetch, isFetching } = useQuery<RiscoV2Response>({
    queryKey: ["risco-mercado-v2", dataParam ?? "latest"],
    queryFn: () => fetchRiscoMercadoV2(dataParam),
    staleTime: 5 * 60_000,
  });

  const {
    data: fundosSimplificados = [],
    isLoading: isLoadingFundos,
    error: errorFundos,
  } = useQuery<FundoRiscoSimplificado[]>({
    queryKey: ["risco-mercado-fundos-simplificado"],
    queryFn:  fetchFundosRiscoSimplificado,
    staleTime: 5 * 60_000,
  });

  const { data: universoMonitorado } = useQuery({
    queryKey: ["universo-cnpjs-monitorados"],
    queryFn:  fetchUniversoCnpjsMonitorados,
    staleTime: 5 * 60_000,
  });

  const fundosMonitorados = useMemo(
    () => filtrarFundosUniversoMonitorado(fundosSimplificados, universoMonitorado ?? null),
    [fundosSimplificados, universoMonitorado],
  );

  const dataPosicaoIso = resp?.summary?.data_posicao_risco ?? dataParam ?? datasDisponiveis[0] ?? null;
  const dataParaInput  = dataParam ?? resp?.summary?.data_posicao_risco ?? "";

  const datasSet = useMemo(() => {
    const s = new Set(datasDisponiveis);
    if (resp?.summary?.data_posicao_risco) s.add(resp.summary.data_posicao_risco);
    return s;
  }, [datasDisponiveis, resp?.summary?.data_posicao_risco]);

  function setDataUrl(isoDate: string | null) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (isoDate) next.set("data", isoDate);
      else next.delete("data");
      return next;
    }, { replace: true });
  }

  const dataPosicaoFmt = dataPosicaoIso ? fmtDataIso(dataPosicaoIso) : null;

  const summary = resp?.summary;

  async function exportarConsolidado(tipo: "excel" | "pdf") {
    setIsExportingConsolidado(tipo);
    try {
      const data = await fetchRiscoConsolidado(dataParam ?? dataPosicaoIso);
      if (tipo === "excel") exportRiscoConsolidadoExcel(data);
      else exportRiscoConsolidadoPdf(data);
      toast.success(`Relatório consolidado (${tipo.toUpperCase()}) exportado com ${data.linhas.length} fundos.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao exportar relatório consolidado.");
    } finally {
      setIsExportingConsolidado(null);
    }
  }

  function exportarTudo() {
    if (!resp) return;
    setIsExportingAll(true);
    try {
      const wb = XLSX.utils.book_new();

      // Aba 1: Carteiras V2
      const HDR1 = [
        "Carteira", "Grupo", "Data",
        "VaR EWMA 95% (%)", "VaR Param 95% 21d (legado) (%)", "VaR MC(t) 95% (legado) (%)",
        "VaR Diversif 95% (legado) (%)", "VaR Hist R$", "VaR Diversif R$",
        "Economia Diversif R$", "B-VaR 95% (%)",
        "Drawdown Atual (%)", "DD Máx 252d (%)", "Pior 21d (%)",
        "Stress Pior (%)", "Uso Limite (%)", "Status",
      ];
      const ws1 = XLSX.utils.aoa_to_sheet([HDR1]);
      ws1["!cols"] = HDR1.map(() => ({ wch: 16 }));
      ws1["!cols"][0] = { wch: 35 }; ws1["!cols"][1] = { wch: 8 }; ws1["!cols"][2] = { wch: 12 };
      HDR1.forEach((_, ci) => {
        const ref = XLSX.utils.encode_cell({ r: 0, c: ci });
        ws1[ref] = { v: HDR1[ci], t: "s", s: { fill: xFill(SYS.accent), font: xFont("#FFFFFF", true, 9), alignment: xAlign("center") } };
      });
      const pctCols1 = [3, 4, 5, 6, 10, 11, 12, 13, 14, 15];
      resp.carteiras.forEach((c, ri) => {
        const row = [
          c.cliente, c.grupo ?? "", c.data_posicao ?? "",
          c.var_mes_95_pct != null ? c.var_mes_95_pct / 100 : "",
          c.var_95_param_pct != null ? c.var_95_param_pct / 100 : "",
          c.var_95_mc_t_pct  != null ? c.var_95_mc_t_pct  / 100 : "",
          c.var_95_diversif_pct != null ? c.var_95_diversif_pct / 100 : "",
          c.var_95_hist_rs ?? "",
          c.var_95_diversif_rs ?? "",
          c.beneficio_diversif_rs ?? "",
          c.bvar_95_pct != null ? c.bvar_95_pct / 100 : "",
          c.drawdown_atual_pct != null ? c.drawdown_atual_pct / 100 : "",
          c.drawdown_max_252d_pct != null ? c.drawdown_max_252d_pct / 100 : "",
          c.pior_21d_pct != null ? c.pior_21d_pct / 100 : "",
          c.stress_pior_pct != null ? c.stress_pior_pct / 100 : "",
          c.pct_uso_limite != null ? c.pct_uso_limite / 100 : "",
          c.status,
        ];
        const rowBg = ri % 2 === 0 ? "#FFFFFF" : "#F8FAFB";
        row.forEach((v, ci) => {
          const ref = XLSX.utils.encode_cell({ r: ri + 1, c: ci });
          const isNum = typeof v === "number";
          ws1[ref] = {
            v: v === "" ? null : v, t: isNum ? "n" : "s",
            s: {
              fill: xFill(rowBg),
              font: xFont((isNum && pctCols1.includes(ci) && (v as number) < 0) ? SYS.red : SYS.text),
              alignment: xAlign(isNum ? "right" : "left"),
              ...(pctCols1.includes(ci) ? { numFmt: "0.00%" } : {}),
            },
          };
        });
      });
      ws1["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: resp.carteiras.length, c: HDR1.length - 1 } });
      ws1["!freeze"] = { xSplit: 1, ySplit: 1 };
      XLSX.utils.book_append_sheet(wb, ws1, "Risco Carteiras");

      // Aba 2: Fundos — métricas simplificadas (VaR Hist/Param, Volatilidade, Drawdown, Cota vs CDI)
      const HDR2 = [
        "Fundo", "CNPJ", "Data Ref",
        "VaR Histórico 95% — 21d (%)", "VaR Histórico 95% — 21d (R$)",
        "VaR Paramétrico 95% — 1d (%)", "VaR Paramétrico 95% — 1d (R$)", "Volatilidade σ (%)",
        "Drawdown Atual (%)", "Drawdown Máx (%)",
        "Δ Cota", "Δ CDI", "Relação Cota/CDI", "Status Cota/CDI",
        "n Obs σ", "n Obs 21d (janelas)", "Fonte Cota",
        "Qualidade da Série", "Série Suspeita", "Alertas da Série", "Extremos 1d", "Extremos 21d", "Gap Máx (dias)",
      ];
      const ws2 = XLSX.utils.aoa_to_sheet([HDR2]);
      ws2["!cols"] = HDR2.map(() => ({ wch: 14 }));
      ws2["!cols"][0] = { wch: 45 }; ws2["!cols"][1] = { wch: 18 }; ws2["!cols"][2] = { wch: 12 };
      HDR2.forEach((_, ci) => {
        const ref = XLSX.utils.encode_cell({ r: 0, c: ci });
        ws2[ref] = { v: HDR2[ci], t: "s", s: { fill: xFill(SYS.accent), font: xFont("#FFFFFF", true, 9), alignment: xAlign("center") } };
      });
      const pctCols2 = [3, 5, 7, 8, 9, 10, 11];
      fundosMonitorados.forEach((f, ri) => {
        const row: (string | number | null)[] = [
          f.nome_fundo ?? "", f.cnpj, f.data_ref,
          f.var_95_hist_21d_pct != null ? f.var_95_hist_21d_pct / 100 : null,
          f.var_95_hist_21d_rs ?? null,
          f.var_95_param_1d_pct != null ? f.var_95_param_1d_pct / 100 : null,
          f.var_95_param_1d_rs ?? null,
          f.sigma_diario_pct != null ? f.sigma_diario_pct / 100 : null,
          f.drawdown_atual_pct != null ? f.drawdown_atual_pct / 100 : null,
          f.drawdown_max_pct != null ? f.drawdown_max_pct / 100 : null,
          f.delta_cota_pct ?? null,
          f.delta_cdi_pct ?? null,
          f.relacao_cota_cdi ?? null,
          f.status_cota_cdi,
          f.n_obs ?? null,
          f.n_obs_21d ?? null,
          f.fonte_cota ?? "",
          f.qualidade_serie_status ?? null,
          f.serie_suspeita ? "SIM" : "NAO",
          (f.serie_alertas ?? []).join(", "),
          f.serie_extremos_1d ?? null,
          f.serie_extremos_21d ?? null,
          f.serie_maior_gap_dias ?? null,
        ];
        const rowBg = ri % 2 === 0 ? "#FFFFFF" : "#F8FAFB";
        row.forEach((v, ci) => {
          const ref = XLSX.utils.encode_cell({ r: ri + 1, c: ci });
          const isNum = typeof v === "number";
          ws2[ref] = {
            v: v == null ? null : v, t: isNum ? "n" : "s",
            s: {
              fill: xFill(rowBg),
              font: xFont((isNum && pctCols2.includes(ci) && (v as number) < 0) ? SYS.red : SYS.text),
              alignment: xAlign(isNum ? "right" : "left"),
              ...(pctCols2.includes(ci) ? { numFmt: "0.00%" } : {}),
            },
          };
        });
      });
      ws2["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: fundosMonitorados.length, c: HDR2.length - 1 } });
      ws2["!freeze"] = { xSplit: 2, ySplit: 1 };
      XLSX.utils.book_append_sheet(wb, ws2, "Risco Fundos");

      const dpStr = summary?.data_posicao_risco ?? "s-data";
      XLSX.writeFile(wb, `risco_mercado_v2_${dpStr}.xlsx`);
    } finally {
      setIsExportingAll(false);
    }
  }

  return (
    <Layout>
      <TooltipProvider delayDuration={200}>
        <div className="flex flex-col h-full bg-[#F8FAFB]">

          {/* ── Header ── */}
          <div className="flex items-center justify-between px-6 py-4 bg-white border-b border-gray-200 shrink-0 flex-wrap gap-3">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Risco de Mercado</h1>
              <p className="text-xs text-gray-500 mt-0.5">
                VaR 95% · Histórico · Paramétrico
              </p>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs text-gray-500 whitespace-nowrap">Posição diária</span>
                <Popover open={calOpen} onOpenChange={setCalOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={cn(
                        "h-8 min-w-[170px] justify-start text-left text-xs font-normal",
                        !dataParaInput && "text-muted-foreground",
                      )}
                    >
                      <CalendarDays className="mr-2 h-3.5 w-3.5 shrink-0 opacity-70" />
                      {dataParaInput ? fmtDataIso(dataParaInput) : "Selecionar data"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      locale={ptBR}
                      defaultMonth={
                        dataParaInput
                          ? parseISO(`${dataParaInput}T12:00:00`)
                          : datasDisponiveis[0]
                            ? parseISO(`${datasDisponiveis[0]}T12:00:00`)
                            : new Date()
                      }
                      selected={dataParaInput ? parseISO(`${dataParaInput}T12:00:00`) : undefined}
                      onSelect={(d) => {
                        if (d) {
                          setDataUrl(format(d, "yyyy-MM-dd"));
                          setCalOpen(false);
                        }
                      }}
                      modifiers={{
                        temDado: (date) => datasSet.has(format(date, "yyyy-MM-dd")),
                      }}
                      modifiersClassNames={{
                        temDado:
                          "relative after:pointer-events-none after:absolute after:bottom-0.5 after:left-1/2 after:h-0.5 after:w-2 after:-translate-x-1/2 after:rounded-sm after:bg-[#2E5389]",
                      }}
                      classNames={{
                        day_selected: "bg-[#2E5389] text-white hover:bg-[#2E5389] focus:bg-[#2E5389]",
                      }}
                    />
                    <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
                      <button
                        type="button"
                        className="text-xs text-gray-500 hover:text-gray-900"
                        onClick={() => setCalOpen(false)}
                      >
                        Fechar
                      </button>
                      <button
                        type="button"
                        className="text-xs font-medium text-[#2E5389] hover:underline"
                        onClick={() => { setDataUrl(null); setCalOpen(false); }}
                      >
                        Última disponível
                      </button>
                    </div>
                  </PopoverContent>
                </Popover>
                {dataPosicaoFmt && (
                  <span className="text-[10px] text-gray-400 hidden sm:inline">
                    VaR consolidado · {dataPosicaoFmt}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Summary pills */}
              {summary && (
                <div className="hidden md:flex items-center gap-2 text-[11px] mr-2">
                  {summary.carteiras_breach > 0 && (
                    <span className="px-2 py-0.5 rounded bg-red-100 text-red-700 font-semibold">
                      {summary.carteiras_breach} BREACH
                    </span>
                  )}
                  {summary.carteiras_alerta > 0 && (
                    <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold">
                      {summary.carteiras_alerta} ALERTA
                    </span>
                  )}
                </div>
              )}
              <ImportarHistoricoManualButton />
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="h-8 text-xs">
                {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Atualizar
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportarConsolidado("excel")}
                disabled={!!isExportingConsolidado}
                className="h-8 text-xs hidden sm:inline-flex"
                title="Relatório consolidado por fundo gerido (posição XML)"
              >
                {isExportingConsolidado === "excel"
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <FileSpreadsheet className="h-3.5 w-3.5" />}
                Consolidado Excel
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportarConsolidado("pdf")}
                disabled={!!isExportingConsolidado}
                className="h-8 text-xs hidden sm:inline-flex"
                title="Relatório consolidado por fundo gerido (posição XML)"
              >
                {isExportingConsolidado === "pdf"
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <FileText className="h-3.5 w-3.5" />}
                Consolidado PDF
              </Button>
              <Button size="sm" onClick={exportarTudo} disabled={!resp || isExportingAll}
                className="h-8 text-xs bg-[#2E5389] hover:bg-[#1e3d6b] text-white">
                {isExportingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {isExportingAll ? "Exportando..." : "Exportar Excel (2 abas)"}
              </Button>
            </div>
          </div>

          {/* ── Summary KPIs globais ── */}
          {summary && !isLoading && (
            <div className="px-6 pt-3 grid grid-cols-2 gap-3 shrink-0 max-w-xl">
              <KpiCard
                label="PL Total"
                value={fmtRSCompact(summary.pl_total)}
                sub={`${fmt.format(summary.total_carteiras)} carteiras`}
              />
              <KpiCard
                label="OK / Alerta / Breach"
                value={`${summary.carteiras_ok} / ${summary.carteiras_alerta} / ${summary.carteiras_breach}`}
                sub="status vs limites"
                color={summary.carteiras_breach > 0 ? "text-red-700" : summary.carteiras_alerta > 0 ? "text-amber-600" : "text-emerald-700"}
              />
            </div>
          )}

          {/* ── Comparativo de métodos ── */}
          {!isLoading && resp && (
            <div className="px-6 pt-3 shrink-0">
              <MetodosComparativo carteiras={resp.carteiras} />
            </div>
          )}

          {/* ── Aviso metodológico ── */}
          <div className="mx-6 mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md flex items-start gap-2 text-[11px] text-amber-800 shrink-0">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-500" />
            <span>
              <strong>Aba Carteiras:</strong> VaR EWMA e Paramétrico da série de cotas.{" "}
              <strong>Aba Fundos:</strong> VaR Paramétrico diário, volatilidade, drawdown e cota vs CDI (fonte XML + histórico manual).
            </span>
          </div>

          {/* ── Abas ── */}
          <Tabs defaultValue="fundos" className="flex flex-col flex-1 min-h-0 mt-3">
            <div className="px-6 shrink-0">
              <TabsList>
                <TabsTrigger value="fundos" className="gap-1.5">
                  <List className="h-3.5 w-3.5" />
                  Fundos
                  {fundosMonitorados.length > 0 && (
                    <Badge variant="secondary" className="ml-1 text-[9px] px-1 py-0">
                      {fundosMonitorados.length}
                    </Badge>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="fundos" className="flex-1 overflow-auto mt-3">
              <TabFundos
                fundos={fundosMonitorados}
                isLoading={isLoadingFundos}
                error={errorFundos}
              />
            </TabsContent>
          </Tabs>

        </div>
      </TooltipProvider>
    </Layout>
  );
}
