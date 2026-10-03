import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { exportConsolidadoPdf } from "@/lib/exportPdf";
import { Layout } from "@/components/Layout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  Loader2,
  FileText,
  Calendar as CalendarIcon,
  Download,
  BarChart3,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Users,
  RefreshCw,
  FileDown,
  Filter,
  X,
  Mail,
  Droplets,
} from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { DateRefNavigator } from "@/components/DateRefNavigator";
import { cn, isFundoFechado } from "@/lib/utils";
import { format, parse } from "date-fns";
import { ptBR } from "date-fns/locale";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import {
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { RelatorioSortableHead } from "@/components/relatorios/RelatorioSortableHead";
import { sortRelatorioRows, useRelatorioSort } from "@/components/relatorios/useRelatorioSort";
import { usePosicaoMonthlyMonths } from "@/components/relatorios/relatorioUtils";
import { fetchPosicaoAvailableDates } from "@/lib/posicaoAvailableDates";
import {
  type LiquidezProcessedFundData,
  liquidezStorageKey,
  fundCacheKey,
  loadAndMigrateLiquidezProcessedResults,
  resolveProcessedFund,
} from "@/lib/liquidezProcessedResults";
import { saveLiquidezResultsToDb } from "@/lib/liquidezMonitoramentoRiscoDb";
import { toast } from "sonner";
import { RiscoOcorrenciasPanel } from "@/components/relatorios/RiscoOcorrenciasPanel";

type FundRow = {
  nome_fundo: string;
  fundo_cnpj: string;
  dt_posicao: string;
  administrador: string;
  pl: number;
  xmlPL: number;
  csvPL: number;
  hasPLDiscrepancy: boolean;
  prazoResgate: number | null;
  isFundoFechado: boolean;
  indiceLiquidez: number | null;
  status: string;
};

type ProcessedFundData = LiquidezProcessedFundData;

const formatCnpj = (cnpj: string | null) => {
  if (!cnpj) return "";
  const clean = String(cnpj).replace(/\D/g, "");
  if (clean.length !== 14) return cnpj;
  return clean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
};

const formatBRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);

const formatPerc = (v: number) => `${(v * 100).toFixed(1)}%`;

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

function useLiquidezFunds(date: Date | undefined) {
  const formatDateToDB = (d: Date) => format(d, "yyyyMMdd");

  const { data: availableDates = [] } = useQuery({
    queryKey: ["liquidez-relatorios-dates"],
    queryFn: fetchPosicaoAvailableDates,
  });

  const { data: funds = [], isLoading } = useQuery({
    queryKey: ["liquidez-relatorios-funds", date ? formatDateToDB(date) : "none"],
    enabled: !!date,
    queryFn: async (): Promise<FundRow[]> => {
      if (!date) return [];
      const dateStr = formatDateToDB(date);
      const dateIso = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;

      const csvPlMap = new Map<string, number>();
      const { data: csvPlsPatliq, error: csvPlsPatliqError } = await (supabase as any)
        .from("carteira_finvest_raw")
        .select("fundo_cnpj, valor_total_ativo, valor_a_pagar")
        .eq("data_posicao", dateIso)
        .not("valor_total_ativo", "is", null);

      if (!csvPlsPatliqError && csvPlsPatliq) {
        for (const row of csvPlsPatliq as any[]) {
          if (row.fundo_cnpj && row.valor_total_ativo != null) {
            const ativo = Number(row.valor_total_ativo ?? 0) || 0;
            const pagar = Number(row.valor_a_pagar ?? 0) || 0;
            csvPlMap.set(row.fundo_cnpj, ativo - pagar);
          }
        }
      } else {
        const { data: csvPls } = await supabase
          .from("carteira_finvest_raw")
          .select("fundo_cnpj, valor_total_ativo")
          .eq("data_posicao", dateIso)
          .not("valor_total_ativo", "is", null);

        if (csvPls) {
          for (const row of csvPls) {
            if (row.fundo_cnpj && row.valor_total_ativo != null) {
              csvPlMap.set(row.fundo_cnpj, row.valor_total_ativo);
            }
          }
        }
      }

      const { data: posicoes, error: posError } = await supabase
        .from("posicao_carteira")
        .select("fundo_cnpj, nome_fundo, fundo_nome, fundo_nomeadm, fundo_patliq, section, valor_padrao, saldo, cnpjfundo, cnpjemissor, dtvencimento")
        .eq("fundo_dtposicao", dateStr);

      if (posError) throw posError;
      if (!posicoes || posicoes.length === 0) return [];

      const fundosMap = new Map<
        string,
        { nome: string; cnpj: string; admin: string; pl: number; rows: typeof posicoes }
      >();

      for (const row of posicoes) {
        if (!row.fundo_cnpj) continue;
        const existing = fundosMap.get(row.fundo_cnpj);
        if (!existing) {
          fundosMap.set(row.fundo_cnpj, {
            nome: ((row as any).nome_fundo || (row as any).fundo_nome || "").trim() || "Nome Indisponível",
            cnpj: row.fundo_cnpj,
            admin: ((row as any).fundo_nomeadm || "").trim() || "–",
            pl: (row as any).fundo_patliq ?? 0,
            rows: [row],
          });
        } else {
          existing.rows.push(row);
          if ((!existing.admin || existing.admin === "–") && (row as any).fundo_nomeadm?.trim()) {
            existing.admin = (row as any).fundo_nomeadm.trim();
          }
          if (existing.pl === 0 && (row as any).fundo_patliq) {
            existing.pl = (row as any).fundo_patliq;
          }
        }
      }

      const allCnpjs = [...fundosMap.keys()];
      const cotasCnpjs = [
        ...new Set(
          posicoes
            .filter((p: any) => ["cotas", "fidc"].includes((p.section || "").toLowerCase()) && p.cnpjfundo)
            .map((p: any) => String(p.cnpjfundo).replace(/\D/g, ""))
        ),
      ];
      const emissoresCnpjs = [
        ...new Set(
          posicoes
            .filter(
              (p: any) =>
                !["despesas", "provisao", "caixa"].includes((p.section || "").toLowerCase()) && p.cnpjemissor
            )
            .map((p: any) => String(p.cnpjemissor).replace(/\D/g, ""))
        ),
      ];
      const todosCnpjs = [...new Set([...allCnpjs, ...cotasCnpjs, ...emissoresCnpjs])].filter(Boolean);

      const charMap = new Map<string, { prazo: number | null; fechado: boolean }>();

      if (todosCnpjs.length > 0) {
        const fmtCnpj = (d: string) =>
          d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d;
        const cleanVariants = todosCnpjs.map((c) => String(c).replace(/\D/g, ""));
        const formattedVariants = cleanVariants.filter((c) => c.length === 14).map(fmtCnpj);
        const allVariants = [...new Set([...todosCnpjs, ...cleanVariants, ...formattedVariants])].filter(Boolean);

        const { data: charsByClasse } = await supabase
          .from("fundos_caracteristicas" as any)
          .select("cnpj_classe, cnpj_fundo, prazo_pagamento_resgate_dias, aberto_estatutariamente")
          .in("cnpj_classe", allVariants);
        const { data: charsByFundo } = await supabase
          .from("fundos_caracteristicas" as any)
          .select("cnpj_classe, cnpj_fundo, prazo_pagamento_resgate_dias, aberto_estatutariamente")
          .in("cnpj_fundo", allVariants);
        const chars = [...(charsByClasse || []), ...(charsByFundo || [])];

        for (const c of chars as any[]) {
          const kClasse = c.cnpj_classe ? String(c.cnpj_classe).replace(/\D/g, "") : null;
          const kFundo = c.cnpj_fundo ? String(c.cnpj_fundo).replace(/\D/g, "") : null;
          for (const k of [kClasse, kFundo]) {
            if (!k) continue;
            const existing = charMap.get(k);
            if (
              !existing ||
              (c.prazo_pagamento_resgate_dias != null && existing.prazo == null)
            ) {
              charMap.set(k, {
                prazo: c.prazo_pagamento_resgate_dias ?? null,
                fechado: isFundoFechado(c.aberto_estatutariamente),
              });
            }
          }
        }
      }

      const dtPosicao = (() => {
        if (dateStr.length !== 8) return new Date(NaN);
        return new Date(
          parseInt(dateStr.slice(0, 4)),
          parseInt(dateStr.slice(4, 6)) - 1,
          parseInt(dateStr.slice(6, 8))
        );
      })();

      const diasUteisEntre = (d1: Date, d2: Date): number => {
        if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return 0;
        const start = d1 < d2 ? d1 : d2;
        const end = d1 < d2 ? d2 : d1;
        let count = 0;
        const cur = new Date(start);
        while (cur <= end) {
          const dow = cur.getDay();
          if (dow !== 0 && dow !== 6) count++;
          cur.setDate(cur.getDate() + 1);
        }
        return count;
      };

      const results: FundRow[] = [];

      for (const [cnpj, fundo] of fundosMap) {
        const cnpjClean = cnpj.replace(/\D/g, "");
        const charInfo = charMap.get(cnpjClean);
        const prazoFundo = charInfo?.prazo ?? null;
        const isFechado = charInfo?.fechado ?? false;
        const cnpj8 = cnpjClean.substring(0, 8);
        const csvPL = csvPlMap.get(cnpj8) || 0;
        const xmlPL = fundo.pl;

        let effectivePL = xmlPL;
        let hasPLDiscrepancy = false;

        if (csvPL > 0 && xmlPL > 0) {
          const diff = Math.abs(xmlPL - csvPL) / Math.max(xmlPL, csvPL);
          if (diff > 0.05) {
            effectivePL = csvPL;
            hasPLDiscrepancy = true;
          }
        } else if (xmlPL === 0 && csvPL > 0) {
          effectivePL = csvPL;
          hasPLDiscrepancy = true;
        }

        let disponibilidade = 0;

        for (const row of fundo.rows) {
          const section = ((row as any).section || "").toLowerCase();
          if (["despesas", "provisao"].includes(section)) continue;

          const valor =
            section === "caixa"
              ? (row as any).saldo ?? (row as any).valor_padrao ?? 0
              : (row as any).valor_padrao ?? 0;

          if (valor === 0 && section !== "caixa") continue;

          let prazoDias: number | null = null;

          if (section === "caixa") {
            prazoDias = 0;
          } else if (section === "cotas" || section === "fidc") {
            const cnpjAtivo = (row as any).cnpjfundo || (row as any).cnpjemissor || "";
            if (cnpjAtivo) {
              const ativoChar = charMap.get(String(cnpjAtivo).replace(/\D/g, ""));
              prazoDias = ativoChar?.prazo ?? null;
            }
          } else if (section === "titpublico" || section === "titprivado") {
            const dtVenc = (row as any).dtvencimento;
            if (dtVenc && String(dtVenc).length === 8) {
              prazoDias = diasUteisEntre(
                dtPosicao,
                new Date(
                  parseInt(String(dtVenc).slice(0, 4)),
                  parseInt(String(dtVenc).slice(4, 6)) - 1,
                  parseInt(String(dtVenc).slice(6, 8))
                )
              );
            }
          }

          if (prazoFundo != null && prazoDias != null && prazoDias <= prazoFundo) {
            disponibilidade += valor;
          }
        }

        let status: string;
        let indiceLiquidez: number | null = null;

        if (prazoFundo == null) {
          status = "pendente";
        } else if (isFechado) {
          const dispPL = effectivePL > 0 ? disponibilidade / effectivePL : 0;
          indiceLiquidez = dispPL;
          status = dispPL >= 0.04 ? "ok" : dispPL >= 0.03 ? "alerta" : "violacao";
        } else {
          const dispPL = effectivePL > 0 ? disponibilidade / effectivePL : 0;
          indiceLiquidez = dispPL;

          if (dispPL <= 0) {
            status = "violacao";
          } else {
            let softThreshold = 1.05;
            if (prazoFundo <= 60) softThreshold = 1.2;
            else if (prazoFundo <= 126) softThreshold = 1.1;

            if (dispPL <= 1) status = "violacao";
            else if (dispPL < softThreshold) status = "alerta";
            else status = "ok";
          }
        }

        results.push({
          nome_fundo: fundo.nome,
          fundo_cnpj: cnpj,
          dt_posicao: dateStr,
          administrador: fundo.admin,
          pl: effectivePL,
          xmlPL,
          csvPL,
          hasPLDiscrepancy,
          prazoResgate: prazoFundo,
          isFundoFechado: isFechado,
          indiceLiquidez,
          status,
        });
      }

      return results.sort((a, b) => {
        const order: Record<string, number> = { violacao: 0, alerta: 1, pendente: 2, ok: 3 };
        const diff = (order[a.status] ?? 5) - (order[b.status] ?? 5);
        if (diff !== 0) return diff;
        return b.pl - a.pl;
      });
    },
  });

  return { funds, isLoading, availableDates };
}

type LiquidezSortKey =
  | "nome_fundo"
  | "fundo_cnpj"
  | "administrador"
  | "pl"
  | "prazoResgate"
  | "indiceLiquidez"
  | "status";

const LIQUIDEZ_STATUS_ORDER: Record<string, number> = {
  violacao: 0,
  alerta: 1,
  pendente: 2,
  ok: 3,
};

function sortLiquidezRows(rows: FundRow[], key: LiquidezSortKey, direction: "none" | "asc" | "desc") {
  return sortRelatorioRows(
    rows,
    key,
    direction,
    (row, k) => {
      switch (k as LiquidezSortKey) {
        case "nome_fundo":
          return row.nome_fundo;
        case "fundo_cnpj":
          return row.fundo_cnpj;
        case "administrador":
          return row.administrador;
        case "pl":
          return row.pl;
        case "prazoResgate":
          return row.prazoResgate;
        case "indiceLiquidez":
          return row.indiceLiquidez;
        case "status":
          return row.status;
        default:
          return null;
      }
    },
    LIQUIDEZ_STATUS_ORDER,
    "status",
  );
}

interface LiquidezRelatorioPanelProps {
  /** Oculta cabeçalho da página (uso no hub de compliance) */
  showHeader?: boolean;
  /** Sem Layout externo (uso embutido) */
  embedded?: boolean;
}

export function LiquidezRelatorioPanel({ showHeader = true, embedded = false }: LiquidezRelatorioPanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [date, setDate] = useState<Date | undefined>(undefined);
  const [busca, setBusca] = useState("");
  const [selectedMonth, setSelectedMonth] = useState<string>("");
  const [activeTab, setActiveTab] = useState<string>("diario");
  const [filterStatus, setFilterStatus] = useState<string[]>([]);
  const [filterAdmin, setFilterAdmin] = useState<string[]>([]);
  const { sortConfig, toggleSort, getDirection } = useRelatorioSort<LiquidezSortKey>("nome_fundo");
  const [processing, setProcessing] = useState(false);
  const [processProgress, setProcessProgress] = useState(0);
  const [processTotal, setProcessTotal] = useState(0);
  const [processedResultsDaily, setProcessedResultsDaily] = useState<Map<string, ProcessedFundData>>(new Map());
  const [isNotifying, setIsNotifying] = useState(false);
  const [processedResultsMonthly, setProcessedResultsMonthly] = useState<Map<string, ProcessedFundData>>(new Map());
  const cancelRef = useRef(false);

  const { funds, isLoading, availableDates } = useLiquidezFunds(date);
  const { data: months = [] } = usePosicaoMonthlyMonths();

  const formatDateToDB = (d: Date) => format(d, "yyyyMMdd");

  useEffect(() => {
    if (availableDates.length > 0 && !date) {
      setDate(parse(availableDates[0], "yyyyMMdd", new Date()));
    }
  }, [availableDates, date]);

  useEffect(() => {
    if (months.length > 0 && !selectedMonth) {
      setSelectedMonth(months[0].mes);
    }
  }, [months, selectedMonth]);

  const dateForMonth = useMemo(() => {
    const m = months.find((x) => x.mes === selectedMonth);
    if (!m) return undefined;
    return parse(m.ultimaDt, "yyyyMMdd", new Date());
  }, [months, selectedMonth]);

  const { funds: monthlyFunds, isLoading: loadingMonthly } = useLiquidezFunds(dateForMonth);

  const storageKeyDaily = date ? liquidezStorageKey(formatDateToDB(date)) : "";
  const storageKeyMonthly = dateForMonth ? liquidezStorageKey(formatDateToDB(dateForMonth)) : "";

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    loadAndMigrateLiquidezProcessedResults(formatDateToDB(date))
      .then((merged) => {
        if (!cancelled) setProcessedResultsDaily(merged);
      })
      .catch(() => {
        if (!cancelled) setProcessedResultsDaily(new Map());
      });
    return () => { cancelled = true; };
  }, [date]);

  useEffect(() => {
    if (!dateForMonth) return;
    let cancelled = false;
    loadAndMigrateLiquidezProcessedResults(formatDateToDB(dateForMonth))
      .then((merged) => {
        if (!cancelled) setProcessedResultsMonthly(merged);
      })
      .catch(() => {
        if (!cancelled) setProcessedResultsMonthly(new Map());
      });
    return () => { cancelled = true; };
  }, [dateForMonth]);

  const getDisplayFund = useCallback(
    (fund: FundRow, processed: Map<string, ProcessedFundData>): FundRow => {
      const p = resolveProcessedFund(processed, fund.fundo_cnpj);
      if (!p) return fund;

      const effectiveIsFundoFechado = p.isFundoFechado;
      let displayPL = p.totalPL || fund.pl;
      let displayIndice = p.indiceLiquidez ?? fund.indiceLiquidez;
      let displayStatus = p.status;

      if (effectiveIsFundoFechado && fund.hasPLDiscrepancy && fund.csvPL > 0) {
        displayPL = fund.csvPL;
        const disponibilidade = (p.indiceLiquidez ?? 0) * (p.totalPL || fund.pl);
        displayIndice = fund.csvPL > 0 ? disponibilidade / fund.csvPL : p.indiceLiquidez;
        if (displayIndice != null) {
          if (displayIndice >= 0.04) displayStatus = "ok";
          else if (displayIndice >= 0.03) displayStatus = "alerta";
          else displayStatus = "violacao";
        }
      } else if (!effectiveIsFundoFechado && fund.hasPLDiscrepancy && fund.csvPL > 0 && (p.totalPL || fund.pl) > 0) {
        displayPL = fund.csvPL;
        if (displayIndice != null) {
          displayIndice = displayIndice * ((p.totalPL || fund.pl) / fund.csvPL);
          const f7 = p.prazoResgate ?? fund.prazoResgate ?? 0;
          let softLimitThreshold = 1.05;
          if (f7 <= 60) softLimitThreshold = 1.2;
          else if (f7 <= 126) softLimitThreshold = 1.1;

          if (displayIndice <= 1) displayStatus = "violacao";
          else if (displayIndice < softLimitThreshold) displayStatus = "alerta";
          else displayStatus = "ok";
        }
      }

      return {
        ...fund,
        pl: displayPL,
        prazoResgate: p.prazoResgate ?? fund.prazoResgate,
        indiceLiquidez: displayIndice,
        status: displayStatus,
        isFundoFechado: effectiveIsFundoFechado,
      };
    },
    []
  );

  const handleRecalculate = useCallback(async () => {
    const targetDate = activeTab === "mensal" ? dateForMonth : date;
    const targetFunds = activeTab === "mensal" ? monthlyFunds : funds;
    if (!targetDate || targetFunds.length === 0) return;

    const dateStr = formatDateToDB(targetDate);
    cancelRef.current = false;
    setProcessing(true);
    setProcessTotal(targetFunds.length);
    setProcessProgress(0);

    const newResults = new Map<string, ProcessedFundData>();

    for (let i = 0; i < targetFunds.length; i++) {
      if (cancelRef.current) break;
      const f = targetFunds[i];
      try {
        const { data, error } = await supabase.functions.invoke("calculo-risco-liquidez", {
          body: {
            fundo_cnpj: f.fundo_cnpj,
            fundo_dtposicao: dateStr,
            classe: "Multimercados",
            segmento_investidor: "PRIVATE",
            metrica: "media_simples",
          },
        });

        const cacheKey = fundCacheKey(f.fundo_cnpj);
        if (error || !data?.success) {
          newResults.set(cacheKey, {
            totalPL: f.pl,
            isFundoFechado: f.isFundoFechado,
            prazoResgate: f.prazoResgate,
            indiceLiquidez: f.indiceLiquidez,
            status: "pendente",
          });
        } else {
          const d = data.data;
          const isFechado = !!d.isFundoFechado;
          const prazoResgate = d.mainFundChar?.prazo_pagamento_resgate_dias ?? null;
          let indiceLiquidez: number | null = null;
          let status = d.worstStatus || "pendente";

          if (isFechado && d.fundoFechadoAnalise) {
            indiceLiquidez = d.fundoFechadoAnalise.dispPL ?? null;
            status = d.fundoFechadoAnalise.status || status;
          } else if (prazoResgate != null && Array.isArray(d.tabelaVertices)) {
            const vertice =
              d.tabelaVertices.find((v: any) => Number(v.vertice) === Number(prazoResgate)) ||
              d.tabelaVertices.find((v: any) => Number(v.vertice) >= Number(prazoResgate));
            if (vertice) {
              indiceLiquidez =
                vertice.indiceAcumulado ??
                (vertice.passivoAcumulado > 0 ? vertice.ativoAcumulado / vertice.passivoAcumulado : null);
              status = vertice.statusConsolidado || vertice.status || status;
            }
          }

          newResults.set(cacheKey, {
            totalPL: d.totalPL || 0,
            isFundoFechado: isFechado,
            prazoResgate,
            indiceLiquidez,
            status,
          });
        }
      } catch {
        newResults.set(fundCacheKey(f.fundo_cnpj), {
          totalPL: f.pl,
          isFundoFechado: f.isFundoFechado,
          prazoResgate: f.prazoResgate,
          indiceLiquidez: f.indiceLiquidez,
          status: "pendente",
        });
      }
      setProcessProgress(i + 1);
    }

    const targetKey = activeTab === "mensal" ? storageKeyMonthly : storageKeyDaily;
    if (activeTab === "mensal") {
      setProcessedResultsMonthly(newResults);
    } else {
      setProcessedResultsDaily(newResults);
    }
    saveLiquidezResultsToDb(dateStr, newResults).catch(() => {});
    try {
      localStorage.setItem(targetKey, JSON.stringify(Object.fromEntries(newResults.entries())));
    } catch {
      /* ignore */
    }
    setProcessing(false);
    queryClient.invalidateQueries({ queryKey: ["liquidez-relatorios-funds"] });
    queryClient.invalidateQueries({ queryKey: ["liquidez-funds-list"] });
  }, [activeTab, date, dateForMonth, funds, monthlyFunds, storageKeyDaily, storageKeyMonthly, queryClient]);

  const fundsToUse = date ? funds : [];
  const monthlyFundsToUse = selectedMonth ? monthlyFunds : [];

  const displayFundsDaily = useMemo(
    () => fundsToUse.map((f) => getDisplayFund(f, processedResultsDaily)),
    [fundsToUse, processedResultsDaily, getDisplayFund]
  );

  const displayFundsMonthly = useMemo(
    () => monthlyFundsToUse.map((f) => getDisplayFund(f, processedResultsMonthly)),
    [monthlyFundsToUse, processedResultsMonthly, getDisplayFund]
  );

  const adminList = useMemo(() => {
    return [...new Set(displayFundsDaily.map((f) => f.administrador || "—").filter(Boolean))].sort();
  }, [displayFundsDaily]);

  const filteredDaily = useMemo(() => {
    let arr = displayFundsDaily;
    if (busca.trim()) {
      const t = busca.toLowerCase();
      arr = arr.filter(
        (f) =>
          (f.nome_fundo || "").toLowerCase().includes(t) ||
          (f.fundo_cnpj || "").includes(t) ||
          (f.administrador || "").toLowerCase().includes(t)
      );
    }
    if (filterStatus.length > 0) {
      arr = arr.filter((f) => filterStatus.includes(f.status));
    }
    if (filterAdmin.length > 0) {
      arr = arr.filter((f) => filterAdmin.includes(f.administrador || "—"));
    }
    return sortLiquidezRows(arr, sortConfig.key, sortConfig.direction);
  }, [displayFundsDaily, busca, filterStatus, filterAdmin, sortConfig]);

  const filteredMonthly = useMemo(() => {
    let arr = displayFundsMonthly;
    if (busca.trim()) {
      const t = busca.toLowerCase();
      arr = arr.filter(
        (f) =>
          (f.nome_fundo || "").toLowerCase().includes(t) ||
          (f.fundo_cnpj || "").includes(t) ||
          (f.administrador || "").toLowerCase().includes(t)
      );
    }
    return sortLiquidezRows(arr, sortConfig.key, sortConfig.direction);
  }, [displayFundsMonthly, busca, sortConfig]);

  const stats = useMemo(() => {
    const arr = filteredDaily;
    return {
      total: arr.length,
      ok: arr.filter((f) => f.status === "ok").length,
      alerta: arr.filter((f) => f.status === "alerta").length,
      violacao: arr.filter((f) => f.status === "violacao").length,
      pendente: arr.filter((f) => f.status === "pendente").length,
      plTotal: arr.reduce((s, f) => s + f.pl, 0),
    };
  }, [filteredDaily]);

  const alertasDiarios = useMemo(() => {
    const hard = displayFundsDaily.filter((f) => f.status === "violacao").length;
    const soft = displayFundsDaily.filter((f) => f.status === "alerta").length;
    return { hard, soft, total: hard + soft };
  }, [displayFundsDaily]);

  const canNotificar = Boolean(date) && alertasDiarios.total > 0;

  const handleNotificar = async () => {
    if (!date || alertasDiarios.total === 0) return;

    setIsNotifying(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) throw new Error("Sessão não encontrada");

      const fundoDtposicao = format(date, "yyyyMMdd");
      const { data, error } = await supabase.functions.invoke("send-liquidez-notification", {
        body: { origem: "manual", fundo_dtposicao: fundoDtposicao },
      });

      if (error) throw new Error(await extractFunctionError(error));
      if (data?.error) throw new Error(data.details ?? data.error);

      if (data?.status === "sem_violacoes") {
        toast.info("Nenhum fundo em Soft ou Hard Limit — e-mail não enviado.");
        return;
      }

      toast.success(
        data?.log_warning
          ? `Notificação enviada, mas o histórico não foi salvo.`
          : `${data?.emails_enviados ?? data?.qtd_fundos ?? 0} e-mail(s) enviado(s) (${data?.qtd_soft ?? 0} Soft, ${data?.qtd_violacoes ?? 0} Hard).`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg.length > 300 ? `${msg.slice(0, 300)}…` : msg);
      console.error(err);
    } finally {
      setIsNotifying(false);
    }
  };

  const statsComite = useMemo(() => {
    const arr = filteredDaily;
    return [
      { name: "OK", value: arr.filter((f) => f.status === "ok").length, color: "#16a34a" },
      { name: "Soft Limit", value: arr.filter((f) => f.status === "alerta").length, color: "#eab308" },
      { name: "Hard Limit", value: arr.filter((f) => f.status === "violacao").length, color: "#ef4444" },
      { name: "Pendente", value: arr.filter((f) => f.status === "pendente").length, color: "#94a3b8" },
    ].filter((x) => x.value > 0);
  }, [filteredDaily]);

  const handleExportDiario = async () => {
    const EX_C = {
      GREEN_DARK: "FF00734A",
      GRAY_HEAD:  "FF5B6066",
      GRAY_SUB:   "FFF2F4F6",
      GRAY_ALT:   "FFF9FAFB",
      WHITE:      "FFFFFFFF",
      INK:        "FF1A1A2E",
      INK_LIGHT:  "FF5B6066",
      OK_BG:      "FFE6F9F1", OK_FG:  "FF00734A",
      SOFT_BG:    "FFFEF3CD", SOFT_FG: "FF856404",
      HARD_BG:    "FFFDECEA", HARD_FG: "FFC0392B",
      PEND_BG:    "FFF1F5F9", PEND_FG: "FF475569",
      BORDER:     "FFD1D5DB",
    };
    const thin: ExcelJS.Border = { style: "thin", color: { argb: EX_C.BORDER } };
    const brd = { top: thin, left: thin, bottom: thin, right: thin };
    const fill = (cell: ExcelJS.Cell, argb: string) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = "CVPAR Quadrante";
    wb.created = new Date();

    const addTitle = (ws: ExcelJS.Worksheet, t: string) => {
      const r = ws.addRow([t]);
      ws.mergeCells(r.number, 1, r.number, 2);
      fill(r.getCell(1), EX_C.GREEN_DARK);
      r.getCell(1).font = { bold: true, color: { argb: EX_C.WHITE }, size: 11, name: "Calibri" };
      r.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
      r.height = 24;
    };
    const addSection = (ws: ExcelJS.Worksheet, t: string) => {
      const r = ws.addRow([t]);
      ws.mergeCells(r.number, 1, r.number, 2);
      fill(r.getCell(1), EX_C.GRAY_HEAD);
      r.getCell(1).font = { bold: true, color: { argb: EX_C.WHITE }, size: 9, name: "Calibri" };
      r.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
      r.height = 20;
    };

    const wsD = wb.addWorksheet("Relatório Diário", { properties: { tabColor: { argb: "0000734A" } } });
    wsD.columns = [
      { width: 36 }, { width: 20 }, { width: 22 }, { width: 18 },
      { width: 14 }, { width: 14 }, { width: 12 }, { width: 14 },
    ];

    addTitle(wsD, "RELATÓRIO DIÁRIO DE RISCO DE LIQUIDEZ");
    wsD.addRow([]);
    addSection(wsD, `Data Posição: ${date ? format(date, "dd/MM/yyyy") : "—"}  |  Total: ${filteredDaily.length} fundos`);
    wsD.addRow([]);

    const hdrs = ["Fundo", "CNPJ", "Administrador", "PL (R$)", "Prazo Resgate", "Índice Liquidez", "Status", "Data Posição"];
    const hRow = wsD.addRow(hdrs);
    for (let c = 1; c <= hdrs.length; c++) {
      const cell = hRow.getCell(c);
      fill(cell, EX_C.GRAY_HEAD);
      cell.font = { bold: true, color: { argb: EX_C.WHITE }, size: 9, name: "Calibri" };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = brd;
    }
    hRow.height = 28;

    filteredDaily.forEach((f, idx) => {
      const isAlt = idx % 2 !== 0;
      const statusInfo = f.status === "ok"      ? { label: "OK",         bg: EX_C.OK_BG,   fg: EX_C.OK_FG   }
                       : f.status === "alerta"  ? { label: "Soft Limit", bg: EX_C.SOFT_BG, fg: EX_C.SOFT_FG }
                       : f.status === "violacao"? { label: "Hard Limit", bg: EX_C.HARD_BG, fg: EX_C.HARD_FG }
                       :                          { label: "Pendente",   bg: EX_C.PEND_BG, fg: EX_C.PEND_FG };
      const row = wsD.addRow([
        f.nome_fundo || "—",
        formatCnpj(f.fundo_cnpj),
        f.administrador || "—",
        f.pl,
        f.prazoResgate != null ? `D+${f.prazoResgate}` : "—",
        f.indiceLiquidez != null ? formatPerc(f.indiceLiquidez) : "—",
        statusInfo.label,
        date ? format(date, "dd/MM/yyyy") : "—",
      ]);
      for (let c = 1; c <= hdrs.length; c++) {
        const cell = row.getCell(c);
        fill(cell, c === 7 ? statusInfo.bg : (isAlt ? EX_C.GRAY_ALT : EX_C.WHITE));
        cell.font = { size: 9, name: "Calibri", color: { argb: c === 7 ? statusInfo.fg : EX_C.INK } };
        if (c === 7) cell.font = { ...cell.font, bold: true };
        cell.border = brd;
        if (c === 4) {
          cell.numFmt = '#,##0';
          cell.alignment = { horizontal: "right" };
        }
        if (c === 6) cell.alignment = { horizontal: "right" };
        if (c === 5 || c === 7 || c === 8) cell.alignment = { horizontal: "center" };
      }
      row.height = 16;
    });

    wsD.views = [{ state: "frozen", ySplit: 5 }];

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Relatorio_Liquidez_Diario_${format(date || new Date(), "yyyyMMdd")}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportMensal = () => {
    const mesLabel = selectedMonth
      ? format(parse(months.find((m) => m.mes === selectedMonth)?.ultimaDt || selectedMonth + "01", "yyyyMMdd", new Date()), "MMMM yyyy", { locale: ptBR })
      : "";
    const rows = filteredMonthly.map((f) => ({
      Fundo: f.nome_fundo,
      CNPJ: formatCnpj(f.fundo_cnpj),
      Administrador: f.administrador || "N/A",
      PL: f.pl,
      "Prazo Resgate": f.prazoResgate != null ? `D+${f.prazoResgate}` : "N/A",
      "Índice Liquidez": f.indiceLiquidez != null ? formatPerc(f.indiceLiquidez) : "N/A",
      Status:
        f.status === "ok"
          ? "OK"
          : f.status === "alerta"
          ? "Soft Limit"
          : f.status === "violacao"
          ? "Hard Limit"
          : "Pendente",
      "Data Posição": dateForMonth ? format(dateForMonth, "dd/MM/yyyy") : "N/A",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Relatório Mensal ${mesLabel}`);
    XLSX.writeFile(wb, `Relatorio_Liquidez_Mensal_${selectedMonth}.xlsx`);
  };

  const handleExportComite = () => {
    const ws1 = XLSX.utils.json_to_sheet([
      { Métrica: "Total de Fundos", Valor: stats.total },
      { Métrica: "OK", Valor: stats.ok },
      { Métrica: "Soft Limit (Alerta)", Valor: stats.alerta },
      { Métrica: "Hard Limit (Violação)", Valor: stats.violacao },
      { Métrica: "Pendente", Valor: stats.pendente },
      { Métrica: "PL Total (R$)", Valor: stats.plTotal },
      { Métrica: "Data Referência", Valor: date ? format(date, "dd/MM/yyyy") : "N/A" },
    ]);
    const ws2 = XLSX.utils.json_to_sheet(
      filteredDaily.map((f) => ({
        Fundo: f.nome_fundo,
        CNPJ: formatCnpj(f.fundo_cnpj),
        PL: f.pl,
        Status: f.status === "ok" ? "OK" : f.status === "alerta" ? "Soft" : f.status === "violacao" ? "Hard" : "Pendente",
      }))
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "Resumo Executivo");
    XLSX.utils.book_append_sheet(wb, ws2, "Detalhamento por Fundo");
    XLSX.writeFile(wb, `Relatorio_Comite_Risco_Liquidez_${format(date || new Date(), "yyyyMMdd")}.xlsx`);
  };

  const handleExportPdf = async () => {
    const dataRef = date ? format(date, "dd/MM/yyyy") : "N/A";
    const fundosForPdf = filteredDaily.map((f) => ({
      nome_fundo: f.nome_fundo || "—",
      fundo_cnpj: f.fundo_cnpj,
      administrador: f.administrador || "—",
      pl: f.pl,
      prazo_resgate: f.prazoResgate,
      disponibilidade: f.pl * (f.indiceLiquidez ?? 0),
      dispPL: f.indiceLiquidez ?? 0,
      status: f.status,
    }));
    const totals = {
      total: stats.total,
      ok: stats.ok,
      alerta: stats.alerta,
      violacao: stats.violacao,
      semPrazo: stats.pendente,
      plTotal: stats.plTotal,
    };
    await exportConsolidadoPdf(fundosForPdf, totals, dataRef);
  };

  const renderTable = (
    rows: FundRow[],
    showNavigate = false,
    opts?: {
      withFilters?: boolean;
      admins?: string[];
    }
  ) => (
    <Table>
      <TableHeader>
        <TableRow>
          <RelatorioSortableHead
            label="Fundo"
            sortKey="nome_fundo"
            direction={getDirection("nome_fundo")}
            onSort={(k) => toggleSort(k as LiquidezSortKey)}
          />
          <RelatorioSortableHead
            label="CNPJ"
            sortKey="fundo_cnpj"
            direction={getDirection("fundo_cnpj")}
            onSort={(k) => toggleSort(k as LiquidezSortKey)}
          />
          <RelatorioSortableHead
            label="Administrador"
            sortKey="administrador"
            direction={getDirection("administrador")}
            onSort={(k) => toggleSort(k as LiquidezSortKey)}
            trailing={
              opts?.withFilters ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "inline-flex items-center gap-0.5 rounded p-0.5 hover:text-foreground transition-colors",
                        filterAdmin.length > 0 ? "text-primary" : "text-muted-foreground/50",
                      )}
                      title="Filtrar por administrador"
                    >
                      <Filter className="h-3 w-3" />
                      {filterAdmin.length > 0 && (
                        <span className="rounded-full bg-primary text-primary-foreground w-4 h-4 flex items-center justify-center text-[9px] font-bold">
                          {filterAdmin.length}
                        </span>
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-56 p-2" align="start">
                    <div className="flex items-center justify-between pb-1 mb-1 border-b border-border">
                      <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Administrador</p>
                      {filterAdmin.length > 0 && (
                        <button onClick={() => setFilterAdmin([])} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5">
                          <X className="h-3 w-3" /> Limpar
                        </button>
                      )}
                    </div>
                    <div className="max-h-48 overflow-y-auto space-y-0.5">
                      {(opts.admins || []).map((adm) => {
                        const active = filterAdmin.includes(adm);
                        return (
                          <button
                            key={adm}
                            type="button"
                            onClick={() => setFilterAdmin((prev) => active ? prev.filter((x) => x !== adm) : [...prev, adm])}
                            className={cn(
                              "w-full flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors",
                              active ? "bg-primary text-primary-foreground" : "hover:bg-muted text-foreground",
                            )}
                          >
                            <span className="truncate text-left">{adm}</span>
                          </button>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              ) : undefined
            }
          />
          <RelatorioSortableHead
            label="PL"
            sortKey="pl"
            direction={getDirection("pl")}
            onSort={(k) => toggleSort(k as LiquidezSortKey)}
            align="right"
            className="text-right"
          />
          <RelatorioSortableHead
            label="Prazo"
            sortKey="prazoResgate"
            direction={getDirection("prazoResgate")}
            onSort={(k) => toggleSort(k as LiquidezSortKey)}
            align="center"
            className="text-center"
          />
          <RelatorioSortableHead
            label="Índice"
            sortKey="indiceLiquidez"
            direction={getDirection("indiceLiquidez")}
            onSort={(k) => toggleSort(k as LiquidezSortKey)}
            align="right"
            className="text-right"
          />
          <RelatorioSortableHead
            label="Status"
            sortKey="status"
            direction={getDirection("status")}
            onSort={(k) => toggleSort(k as LiquidezSortKey)}
            align="center"
            className="text-center"
            trailing={
              opts?.withFilters ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "inline-flex items-center gap-0.5 rounded p-0.5 hover:text-foreground transition-colors",
                        filterStatus.length > 0 ? "text-primary" : "text-muted-foreground/50",
                      )}
                      title="Filtrar por status"
                    >
                      <Filter className="h-3 w-3" />
                      {filterStatus.length > 0 && (
                        <span className="rounded-full bg-primary text-primary-foreground w-4 h-4 flex items-center justify-center text-[9px] font-bold">
                          {filterStatus.length}
                        </span>
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-44 p-2" align="end">
                    <div className="flex items-center justify-between pb-1 mb-1 border-b border-border">
                      <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Status</p>
                      {filterStatus.length > 0 && (
                        <button onClick={() => setFilterStatus([])} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5">
                          <X className="h-3 w-3" /> Limpar
                        </button>
                      )}
                    </div>
                    {(["violacao", "alerta", "ok", "pendente"] as const).map((st) => {
                      const info = {
                        violacao: { label: "Hard Limit", cls: "text-red-600 bg-red-50" },
                        alerta:   { label: "Soft Limit", cls: "text-amber-600 bg-amber-50" },
                        ok:       { label: "OK",         cls: "text-emerald-600 bg-emerald-50" },
                        pendente: { label: "Pendente",   cls: "text-slate-500 bg-slate-50" },
                      }[st];
                      const active = filterStatus.includes(st);
                      return (
                        <button
                          key={st}
                          type="button"
                          onClick={() => setFilterStatus((prev) => active ? prev.filter((x) => x !== st) : [...prev, st])}
                          className={cn(
                            "w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs font-medium transition-colors",
                            active ? "ring-1 ring-primary " + info.cls : "hover:bg-muted text-foreground",
                          )}
                        >
                          <span className={cn("inline-block w-2 h-2 rounded-full", {
                            "bg-red-500": st === "violacao",
                            "bg-amber-500": st === "alerta",
                            "bg-emerald-500": st === "ok",
                            "bg-slate-400": st === "pendente",
                          })} />
                          {info.label}
                        </button>
                      );
                    })}
                  </PopoverContent>
                </Popover>
              ) : undefined
            }
          />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((f) => (
          <TableRow
            key={f.fundo_cnpj}
            className={showNavigate ? "cursor-pointer hover:bg-muted/50" : ""}
            onClick={
              showNavigate
                ? () => navigate(`/liquidez/monitoramento-fundo/${f.fundo_cnpj}/${f.dt_posicao}`)
                : undefined
            }
          >
            <TableCell className="font-medium text-sm">{f.nome_fundo || "—"}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{formatCnpj(f.fundo_cnpj)}</TableCell>
            <TableCell className="text-xs text-muted-foreground truncate max-w-[140px]">{f.administrador || "—"}</TableCell>
            <TableCell className="text-right font-mono text-xs">{formatBRL(f.pl)}</TableCell>
            <TableCell className="text-center">
              {f.prazoResgate != null ? (
                <span className="text-xs font-mono">D+{f.prazoResgate}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="text-right">
              {f.indiceLiquidez != null ? (
                <span
                  className={cn(
                    "text-xs font-mono font-bold",
                    f.status === "ok" && "text-emerald-600",
                    f.status === "alerta" && "text-amber-600",
                    f.status === "violacao" && "text-red-600"
                  )}
                >
                  {formatPerc(f.indiceLiquidez)}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="text-center">
              <span
                className={cn(
                  "inline-flex px-2 py-0.5 rounded text-[10px] font-bold uppercase",
                  f.status === "ok" && "bg-emerald-50 text-emerald-700",
                  f.status === "alerta" && "bg-amber-50 text-amber-700",
                  f.status === "violacao" && "bg-red-50 text-red-700",
                  f.status === "pendente" && "bg-slate-50 text-slate-600"
                )}
              >
                {f.status === "ok" ? "OK" : f.status === "alerta" ? "Soft" : f.status === "violacao" ? "Hard" : "Pend."}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  const panelContent = (
    <>
      {showHeader && (
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-border pb-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
              <FileText className="h-6 w-6" />
              Relatórios de Risco de Liquidez
            </h1>
            <p className="text-sm text-muted-foreground">
              Relatório diário, mensal e para Comitê de Risco. Os dados são compartilhados com o Monitoramento de Liquidez — execute Recalcular para obter resultados atualizados (Matriz ANBIMA).
            </p>
          </div>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full max-w-2xl grid-cols-3">
            <TabsTrigger value="diario" className="flex items-center gap-2">
              <CalendarIcon className="h-4 w-4" />
              Relatório Diário
            </TabsTrigger>
            <TabsTrigger value="mensal" className="flex items-center gap-2">
              <CalendarIcon className="h-4 w-4" />
              Relatório Mensal
            </TabsTrigger>
            <TabsTrigger value="comite" className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              Comitê de Risco
            </TabsTrigger>
          </TabsList>

          {/* ── Relatório Diário ── */}
          <TabsContent value="diario" className="space-y-4 mt-6">
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
              <DateRefNavigator
                availableDates={availableDates}
                date={date}
                onDateChange={setDate}
                formatDateToDB={(d) => format(d, "yyyyMMdd")}
              />
              <div className="flex flex-wrap gap-2">
                <Input
                  placeholder="Buscar fundo..."
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  className="w-[200px]"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleRecalculate}
                  disabled={processing || fundsToUse.length === 0}
                >
                  {processing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                  Recalcular
                </Button>
                <Button size="sm" variant="outline" onClick={handleExportDiario} disabled={filteredDaily.length === 0}>
                  <Download className="h-4 w-4 mr-2" />
                  Exportar Excel
                </Button>
                <Button size="sm" variant="outline" onClick={handleExportPdf} disabled={filteredDaily.length === 0}>
                  <FileDown className="h-4 w-4 mr-2" />
                  Exportar PDF
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleNotificar}
                  disabled={isNotifying || !canNotificar}
                  title={
                    canNotificar
                      ? "Enviar e-mail de alerta de liquidez para a data selecionada"
                      : "Disponível quando houver fundos em Soft ou Hard Limit"
                  }
                >
                  {isNotifying ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Mail className="h-4 w-4 mr-2 text-amber-600" />
                  )}
                  Notificar
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <Card>
                  <CardHeader className="pb-1"><CardTitle className="text-xs">Total</CardTitle></CardHeader>
                  <CardContent className="text-xl font-bold">{stats.total}</CardContent>
                </Card>
                <Card className="bg-emerald-50/50 border-emerald-100">
                  <CardHeader className="pb-1"><CardTitle className="text-xs text-emerald-700">OK</CardTitle></CardHeader>
                  <CardContent className="text-xl font-bold text-emerald-700">{stats.ok}</CardContent>
                </Card>
                <Card className="bg-amber-50/50 border-amber-100">
                  <CardHeader className="pb-1"><CardTitle className="text-xs text-amber-700">Soft Limit</CardTitle></CardHeader>
                  <CardContent className="text-xl font-bold text-amber-700">{stats.alerta}</CardContent>
                </Card>
                <Card className="bg-red-50/50 border-red-100">
                  <CardHeader className="pb-1"><CardTitle className="text-xs text-red-700">Hard Limit</CardTitle></CardHeader>
                  <CardContent className="text-xl font-bold text-red-700">{stats.violacao}</CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-1"><CardTitle className="text-xs">PL Total</CardTitle></CardHeader>
                  <CardContent className="text-xl font-bold">{formatBRL(stats.plTotal)}</CardContent>
                </Card>
              </div>

              {isLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="border rounded-lg overflow-hidden">
                  {filteredDaily.length === 0 ? (
                    <div className="py-16 text-center text-muted-foreground">Nenhum fundo encontrado.</div>
                  ) : (
                    renderTable(filteredDaily, true, { withFilters: true, admins: adminList })
                  )}
                </div>
              )}
          </TabsContent>

          {/* ── Relatório Mensal ── */}
          <TabsContent value="mensal" className="space-y-4 mt-6">
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
              <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Selecionar mês" />
                </SelectTrigger>
                <SelectContent>
                  {months.map((m) => (
                    <SelectItem key={m.mes} value={m.mes}>
                      {format(parse(m.mes + "01", "yyyyMMdd", new Date()), "MMMM yyyy", { locale: ptBR })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex flex-wrap gap-2">
                <Input
                  placeholder="Buscar fundo..."
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  className="w-[200px]"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleRecalculate}
                  disabled={processing || monthlyFundsToUse.length === 0}
                >
                  {processing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                  Recalcular
                </Button>
                <Button size="sm" variant="outline" onClick={handleExportMensal} disabled={filteredMonthly.length === 0}>
                  <Download className="h-4 w-4 mr-2" />
                  Exportar Excel
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const dataRef = dateForMonth ? format(dateForMonth, "dd/MM/yyyy") : "N/A";
                    const fundosForPdf = filteredMonthly.map((f) => ({
                      nome_fundo: f.nome_fundo || "—",
                      fundo_cnpj: f.fundo_cnpj,
                      administrador: f.administrador || "—",
                      pl: f.pl,
                      prazo_resgate: f.prazoResgate,
                      disponibilidade: f.pl * (f.indiceLiquidez ?? 0),
                      dispPL: f.indiceLiquidez ?? 0,
                      status: f.status,
                    }));
                    const totals = {
                      total: filteredMonthly.length,
                      ok: filteredMonthly.filter((x) => x.status === "ok").length,
                      alerta: filteredMonthly.filter((x) => x.status === "alerta").length,
                      violacao: filteredMonthly.filter((x) => x.status === "violacao").length,
                      semPrazo: filteredMonthly.filter((x) => x.status === "pendente").length,
                      plTotal: filteredMonthly.reduce((s, f) => s + f.pl, 0),
                    };
                    await exportConsolidadoPdf(fundosForPdf, totals, dataRef);
                  }}
                  disabled={filteredMonthly.length === 0}
                >
                  <FileDown className="h-4 w-4 mr-2" />
                  Exportar PDF
                </Button>
              </div>
            </div>

            {selectedMonth && (
              <p className="text-sm text-muted-foreground">
                Última data disponível no mês:{" "}
                {dateForMonth ? format(dateForMonth, "dd/MM/yyyy") : "—"}
              </p>
            )}

            {loadingMonthly ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                {filteredMonthly.length === 0 ? (
                  <div className="py-16 text-center text-muted-foreground">Nenhum fundo encontrado para o mês selecionado.</div>
                ) : (
                  renderTable(filteredMonthly, true)
                )}
              </div>
            )}
          </TabsContent>

          {/* ── Relatório Comitê de Risco ── */}
          <TabsContent value="comite" className="space-y-4 mt-6">
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
              <DateRefNavigator
                availableDates={availableDates}
                date={date}
                onDateChange={setDate}
                formatDateToDB={(d) => format(d, "yyyyMMdd")}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleRecalculate}
                  disabled={processing || fundsToUse.length === 0}
                >
                  {processing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                  Recalcular
                </Button>
                <Button size="sm" variant="outline" onClick={handleExportComite} disabled={filteredDaily.length === 0}>
                  <Download className="h-4 w-4 mr-2" />
                  Exportar Excel
                </Button>
                <Button size="sm" variant="default" onClick={handleExportPdf} disabled={filteredDaily.length === 0}>
                  <FileDown className="h-4 w-4 mr-2" />
                  Exportar PDF
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleNotificar}
                  disabled={isNotifying || !canNotificar}
                  title={
                    canNotificar
                      ? "Enviar e-mail de alerta de liquidez para a data selecionada"
                      : "Disponível quando houver fundos em Soft ou Hard Limit"
                  }
                >
                  {isNotifying ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Mail className="h-4 w-4 mr-2 text-amber-600" />
                  )}
                  Notificar
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="h-5 w-5" />
                    Visão Executiva
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Resumo de risco de liquidez para apresentação ao Comitê
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30">
                      <Users className="h-8 w-8 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">Total de Fundos</p>
                        <p className="text-2xl font-bold">{stats.total}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30">
                      <span className="text-2xl">R$</span>
                      <div>
                        <p className="text-xs text-muted-foreground">PL Total</p>
                        <p className="text-xl font-bold">{formatBRL(stats.plTotal)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-emerald-50">
                      <CheckCircle2 className="h-8 w-8 text-emerald-600" />
                      <div>
                        <p className="text-xs text-emerald-700">Em conformidade (OK)</p>
                        <p className="text-2xl font-bold text-emerald-700">{stats.ok}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-50">
                      <AlertTriangle className="h-8 w-8 text-amber-600" />
                      <div>
                        <p className="text-xs text-amber-700">Soft Limit (Alerta)</p>
                        <p className="text-2xl font-bold text-amber-700">{stats.alerta}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-red-50">
                      <XCircle className="h-8 w-8 text-red-600" />
                      <div>
                        <p className="text-xs text-red-700">Hard Limit (Violação)</p>
                        <p className="text-2xl font-bold text-red-700">{stats.violacao}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-50">
                      <Clock className="h-8 w-8 text-slate-600" />
                      <div>
                        <p className="text-xs text-slate-700">Pendente</p>
                        <p className="text-2xl font-bold text-slate-700">{stats.pendente}</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Distribuição por Status</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Gráfico de pizza – {date ? format(date, "dd/MM/yyyy") : "—"}
                  </p>
                </CardHeader>
                <CardContent>
                  {statsComite.length > 0 ? (
                    <div className="h-[240px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={statsComite}
                            dataKey="value"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            outerRadius={80}
                            label={({ name, value }) => `${name}: ${value}`}
                          >
                            {statsComite.map((entry, index) => (
                              <Cell key={index} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="h-[240px] flex items-center justify-center text-muted-foreground">
                      Nenhum dado para exibir
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Detalhamento por Fundo</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Clique em um fundo para ver os detalhes completos
                </p>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="flex items-center justify-center py-16">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredDaily.length === 0 ? (
                  <div className="py-16 text-center text-muted-foreground">Nenhum fundo encontrado.</div>
                ) : (
                  <div className="border rounded-lg overflow-hidden">
                    {renderTable(filteredDaily, true)}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
    </>
  );

  if (embedded) {
    return <div className="space-y-6">{panelContent}</div>;
  }

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-6">{panelContent}</div>
    </Layout>
  );
}

export default function LiquidezRelatorios() {
  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="space-y-1 border-b border-border pb-4">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Droplets className="h-6 w-6" /> Relatórios de Risco de Liquidez
          </h1>
          <p className="text-sm text-muted-foreground">
            Visão operacional e dossiê mensal com ocorrências, notificações e planos de ação vinculados.
          </p>
        </div>
        <Tabs defaultValue="operacional" className="w-full">
          <TabsList className="grid w-full max-w-lg grid-cols-2">
            <TabsTrigger value="operacional">Visão operacional</TabsTrigger>
            <TabsTrigger value="ocorrencias">Ocorrências & planos</TabsTrigger>
          </TabsList>
          <TabsContent value="operacional" className="mt-5">
            <LiquidezRelatorioPanel embedded showHeader={false} />
          </TabsContent>
          <TabsContent value="ocorrencias" className="mt-5">
            <RiscoOcorrenciasPanel modulos={["liquidez"]} />
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
}
