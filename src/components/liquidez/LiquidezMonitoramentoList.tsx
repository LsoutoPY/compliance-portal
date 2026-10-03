import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { fetchParKeySetMonitorado, buildParKey } from "@/lib/fundosMonitorados";
import { exportConsolidadoPdf } from "@/lib/exportPdf";
import { saveLiquidezResultsToDb } from "@/lib/liquidezMonitoramentoRiscoDb";
import { fetchPosicaoAvailableDates } from "@/lib/posicaoAvailableDates";
import { ProcessarPendentesDialog } from "@/components/monitoramento/ProcessarPendentesDialog";
import {
  type LiquidezProcessedFundData,
  fundCacheKey,
  cleanCnpjKey,
  liquidezStorageKey,
  loadAndMigrateLiquidezProcessedResults,
  resolveProcessedFund,
} from "@/lib/liquidezProcessedResults";
import { mapCalculoToProcessedFechado, FONTE_DESPESA_LABELS } from "@/lib/liquidezFechadoProcessed";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Search,
  Loader2,
  Calendar as CalendarIcon,
  CalendarRange,
  Filter,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FileDown,
  Users2,
} from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { DateRefNavigator } from "@/components/DateRefNavigator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn, isFundoFechado } from "@/lib/utils";
import { resolvePatliqEnquadramento } from "@/lib/patliqContext";
import { format, parse } from "date-fns";
import { ptBR } from "date-fns/locale";

type FundRow = {
  nome_fundo: string;
  fundo_cnpj: string;
  fundo_isin?: string;
  dt_posicao: string;
  administrador: string;
  pl: number;
  xmlPL: number;
  csvPL: number;
  hasPLDiscrepancy: boolean;
  prazoResgate: number | null;
  isFundoFechado: boolean;
  /** Valor bruto de fundos_caracteristicas.aberto_estatutariamente */
  abertoEstatutariamente: string | null;
  indiceLiquidez: number | null;
  status: string;
  intermediateStatus?: string | null;
  classeAnbima: string;
};

type ProcessedFundData = LiquidezProcessedFundData;

type ProcessResult = { cnpj: string; nome: string; success: boolean; error?: string };
type SortDirection = "none" | "asc" | "desc";
type SortKey =
  | "nome_fundo"
  | "fundo_cnpj"
  | "administrador"
  | "pl"
  | "prazoResgate"
  | "tipoFundo"
  | "mesesCobertura"
  | "indiceLiquidez"
  | "status"
  | "intermediateStatus";

const formatBRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);

const formatPerc = (v: number) => `${(v * 100).toFixed(1)}%`;

/**

 * Infere a classe ANBIMA mais adequada para a Matriz de Probabilidade
 * com base no nivel1_categoria do fundo ou no nome.
 * FIDC e FICFIDC → "Renda Fixa Crédito"
 * Demais → "Multimercados" (padrão)
 */
function inferClasseAnbima(nivel1Categoria: string | null, nomeFundo: string): string {
  const cat = (nivel1Categoria || "").toUpperCase();
  const nome = (nomeFundo || "").toUpperCase();
  if (cat.includes("FIDC") || nome.includes("FIDC")) return "Renda Fixa Crédito";
  return "Multimercados";
}

export function LiquidezMonitoramentoList() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [busca, setBusca] = useState("");
  const [date, setDate] = useState<Date | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<"all" | "ok" | "alerta" | "violacao" | "pendente">("all");
  const [trilhaFilter, setTrilhaFilter] = useState<"abertos" | "fechados">("abertos");
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "status",
    direction: "none",
  });

  const [processedResults, setProcessedResults] = useState<Map<string, ProcessedFundData>>(new Map());
  const [processing, setProcessing] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [processProgress, setProcessProgress] = useState(0);
  const [processTotal, setProcessTotal] = useState(0);
  const [processLog, setProcessLog] = useState<ProcessResult[]>([]);
  const [processDialogOpen, setProcessDialogOpen] = useState(false);
  const cancelRef = useRef(false);
  // Ref estável para processedResults — permite acessá-lo dentro de useCallback sem deps instáveis
  const processedResultsRef = useRef(processedResults);
  useEffect(() => { processedResultsRef.current = processedResults; }, [processedResults]);

  // Fund selector (applies to both single-date and range recalculations)
  const [selectedFundsCnpjs, setSelectedFundsCnpjs] = useState<Set<string>>(new Set());
  const [fundSelectorOpen, setFundSelectorOpen] = useState(false);
  const [fundSelectorSearch, setFundSelectorSearch] = useState("");

  // Range recalculation
  const [rangeDialogOpen, setRangeDialogOpen] = useState(false);

  // Processar pendentes dialog
  const [pendentesDialogOpen, setPendentesDialogOpen] = useState(false);
  const [rangeStartDate, setRangeStartDate] = useState<Date | undefined>(undefined);
  const [rangeEndDate, setRangeEndDate] = useState<Date | undefined>(undefined);
  const [rangeProcessing, setRangeProcessing] = useState(false);
  const [rangeDateProgress, setRangeDateProgress] = useState(0);
  const [rangeDateTotal, setRangeDateTotal] = useState(0);
  const [rangeFundProgress, setRangeFundProgress] = useState(0);
  const [rangeFundTotal, setRangeFundTotal] = useState(0);
  const [rangeCurrentDate, setRangeCurrentDate] = useState("");
  const [rangeLog, setRangeLog] = useState<{ date: string; cnpj: string; nome: string; success: boolean; error?: string }[]>([]);
  const [rangeDone, setRangeDone] = useState(false);
  const rangeCancelRef = useRef(false);

  const formatDateToDB = (d: Date) => format(d, "yyyyMMdd");
  const storageKey = useMemo(
    () => (date ? liquidezStorageKey(formatDateToDB(date)) : ""),
    [date]
  );

  const { data: availableDates = [] } = useQuery({
    queryKey: ["liquidez-available-dates"],
    queryFn: fetchPosicaoAvailableDates,
  });

  useEffect(() => {
    if (availableDates.length > 0 && !date) {
      setDate(parse(availableDates[0], "yyyyMMdd", new Date()));
    }
  }, [availableDates, date]);

  const availableDatesMap = useMemo(() => new Set(availableDates), [availableDates]);

  const { data: funds = [], isLoading } = useQuery({
    queryKey: ["liquidez-funds-list", date ? formatDateToDB(date) : "none"],
    enabled: !!date,
    queryFn: async (): Promise<FundRow[]> => {
      if (!date) return [];
      const dateStr = formatDateToDB(date);
      const dateIso = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;

      // Busca PL do CSV:
      // preferência = PATLIQ (valor_total_ativo - valor_a_pagar)
      // fallback = valor_total_ativo puro (ambientes sem valor_a_pagar)
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

      const [{ data: posicoes, error: posError }, parKeysMonitorados] = await Promise.all([
        supabase
          .from("posicao_carteira")
          .select("fundo_cnpj, fundo_isin, nome_fundo, fundo_nome, fundo_nomeadm, fundo_patliq, fundo_valorativos, fundo_valorreceber, fundo_valorpagar, section, valor_padrao, saldo, cnpjfundo, cnpjemissor, dtvencimento")
          .eq("fundo_dtposicao", dateStr),
        fetchParKeySetMonitorado(dateStr),
      ]);

      if (posError) throw posError;
      if (!posicoes || posicoes.length === 0) return [];

      const fundosMap = new Map<string, {
        nome: string; cnpj: string; isin: string; admin: string; pl: number;
        rows: typeof posicoes;
      }>();

      for (const row of posicoes) {
        if (!row.fundo_cnpj) continue;
        const isin = (row as any).fundo_isin ?? "";
        // Inclui na lista apenas fundos monitorados; posicoes completas ficam disponíveis
        // para look-through (charMap, emissores) abaixo
        if (parKeysMonitorados.size > 0 && !parKeysMonitorados.has(buildParKey(row.fundo_cnpj, isin))) continue;
        const mapKey = `${row.fundo_cnpj}|${isin}`;
        const existing = fundosMap.get(mapKey);
        if (!existing) {
          fundosMap.set(mapKey, {
            nome: ((row as any).nome_fundo || (row as any).fundo_nome || "").trim() || "Nome Indisponível",
            cnpj: row.fundo_cnpj,
            isin,
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

      const allCnpjs = [...new Set([...fundosMap.values()].map((f) => cleanCnpjKey(f.cnpj)))];
      const cotasCnpjs = [...new Set(
        posicoes.filter((p: any) => ['cotas', 'fidc'].includes((p.section || '').toLowerCase()) && p.cnpjfundo)
          .map((p: any) => String(p.cnpjfundo).replace(/\D/g, ''))
      )];
      const emissoresCnpjs = [...new Set(
        posicoes.filter((p: any) => !['despesas', 'provisao', 'caixa'].includes((p.section || '').toLowerCase()) && p.cnpjemissor)
          .map((p: any) => String(p.cnpjemissor).replace(/\D/g, ''))
      )];
      const todosCnpjs = [...new Set([...allCnpjs, ...cotasCnpjs, ...emissoresCnpjs])].filter(Boolean);

      const charMap = new Map<string, {
        prazo: number | null;
        fechado: boolean;
        abertoEstatutariamente: string | null;
        nivel1Categoria: string | null;
      }>();
      /** Características por (cnpj|isin) — inclui pl_formula para subclasses FIDC */
      const charByFundKey = new Map<string, {
        prazo: number | null;
        fechado: boolean;
        abertoEstatutariamente: string | null;
        nivel1Categoria: string | null;
        plFormula: string | null;
        patliqSomaFidc: boolean;
      }>();

      if (todosCnpjs.length > 0) {
        const fmtCnpj = (d: string) =>
          d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d;
        const cleanVariants = todosCnpjs.map((c) => String(c).replace(/\D/g, ''));
        const formattedVariants = cleanVariants.filter((c) => c.length === 14).map(fmtCnpj);
        const allVariants = [...new Set([...todosCnpjs, ...cleanVariants, ...formattedVariants])].filter(Boolean);

        const { data: charsByClasse } = await supabase
          .from("fundos_caracteristicas" as any)
          .select("cnpj_classe, cnpj_fundo, isin, prazo_pagamento_resgate_dias, aberto_estatutariamente, nivel1_categoria, pl_formula, patliq_soma_fidc, nome_comercial")
          .in("cnpj_classe", allVariants);
        const { data: charsByFundo } = await supabase
          .from("fundos_caracteristicas" as any)
          .select("cnpj_classe, cnpj_fundo, isin, prazo_pagamento_resgate_dias, aberto_estatutariamente, nivel1_categoria, pl_formula, patliq_soma_fidc, nome_comercial")
          .in("cnpj_fundo", allVariants);
        const chars = [...(charsByClasse || []), ...(charsByFundo || [])];

        for (const c of (chars) as any[]) {
          const kClasse = c.cnpj_classe ? String(c.cnpj_classe).replace(/\D/g, '') : null;
          const kFundo = c.cnpj_fundo ? String(c.cnpj_fundo).replace(/\D/g, '') : null;
          const isinKey = String(c.isin ?? "").trim();
          const charEntry = {
            prazo: c.prazo_pagamento_resgate_dias ?? null,
            fechado: isFundoFechado(c.aberto_estatutariamente),
            abertoEstatutariamente: c.aberto_estatutariamente ?? null,
            nivel1Categoria: c.nivel1_categoria ?? null,
            plFormula: c.pl_formula ?? null,
            patliqSomaFidc: Boolean(c.patliq_soma_fidc),
          };
          for (const k of [kClasse, kFundo]) {
            if (!k) continue;
            charByFundKey.set(`${k}|${isinKey}`, charEntry);
            const existing = charMap.get(k);
            const preferThis =
              !existing ||
              (c.prazo_pagamento_resgate_dias != null && existing.prazo == null) ||
              (c.aberto_estatutariamente != null && existing.abertoEstatutariamente == null);
            if (preferThis) {
              charMap.set(k, {
                prazo: charEntry.prazo,
                fechado: charEntry.fechado,
                abertoEstatutariamente: charEntry.abertoEstatutariamente,
                nivel1Categoria: charEntry.nivel1Categoria,
              });
            }
          }
        }
      }

      const dtPosicao = (() => {
        if (dateStr.length !== 8) return new Date(NaN);
        return new Date(parseInt(dateStr.slice(0, 4)), parseInt(dateStr.slice(4, 6)) - 1, parseInt(dateStr.slice(6, 8)));
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

      for (const [, fundo] of fundosMap) {
        const cnpj = fundo.cnpj;
        const isin = fundo.isin;
        const cnpjClean = cleanCnpjKey(cnpj);
        const charInfo =
          charByFundKey.get(`${cnpjClean}|${isin}`) ??
          charByFundKey.get(`${cnpjClean}|`) ??
          (charMap.has(cnpjClean)
            ? {
                ...charMap.get(cnpjClean)!,
                plFormula: null as string | null,
                patliqSomaFidc: false,
              }
            : null);
        const prazoFundo = charInfo?.prazo ?? null;
        const isFechado = charInfo?.fechado ?? false;
        const abertoEstatutariamente = charInfo?.abertoEstatutariamente ?? null;
        const nivel1Categoria = charInfo?.nivel1Categoria ?? null;
        const classeAnbima = inferClasseAnbima(nivel1Categoria, fundo.nome);

        const headerRow =
          fundo.rows.find((r: any) => r.fundo_patliq != null && r.fundo_patliq > 0) ??
          fundo.rows[0];
        // CSV Finvest é por CNPJ8 — não usar para subclasses com ISIN distinto
        // CSV Finvest é por CNPJ8 — ignorar só em FIDC com ISIN (subclasses no mesmo CNPJ)
        const isFidcFund =
          (nivel1Categoria ?? "").toUpperCase().includes("FIDC") ||
          fundo.nome.toUpperCase().includes("FIDC");
        const cnpj8 = cnpjClean.substring(0, 8);
        const csvPL = isin && isFidcFund ? 0 : (csvPlMap.get(cnpj8) || 0);

        const plResolved = resolvePatliqEnquadramento({
          fundoPatliq: Number((headerRow as any)?.fundo_patliq ?? fundo.pl ?? 0) || 0,
          header: {
            fundo_valorativos: (headerRow as any)?.fundo_valorativos,
            fundo_valorreceber: (headerRow as any)?.fundo_valorreceber,
            fundo_valorpagar: (headerRow as any)?.fundo_valorpagar,
          },
          nivel1Categoria,
          nomeFundo: fundo.nome,
          csvPL,
          patliqSomaFidc: charInfo?.patliqSomaFidc,
          plFormula: charInfo?.plFormula ?? null,
        });

        const effectivePL = plResolved.totalPL;
        const xmlPL = plResolved.xmlPL;
        const hasPLDiscrepancy = plResolved.hasPLDiscrepancy;

        let disponibilidade = 0;

        for (const row of fundo.rows) {
          const section = ((row as any).section || '').toLowerCase();
          if (['despesas', 'provisao'].includes(section)) continue;

          const valor = section === 'caixa'
            ? ((row as any).saldo ?? (row as any).valor_padrao ?? 0)
            : ((row as any).valor_padrao ?? 0);

          if (valor === 0 && section !== 'caixa') continue;

          let prazoDias: number | null = null;

          if (section === 'caixa') {
            prazoDias = 0;
          } else if (section === 'cotas' || section === 'fidc') {
            const cnpjAtivo = ((row as any).cnpjfundo || (row as any).cnpjemissor || '');
            if (cnpjAtivo) {
              const ativoChar = charMap.get(String(cnpjAtivo).replace(/\D/g, ''));
              prazoDias = ativoChar?.prazo ?? null;
            }
          } else if (section === 'titpublico' || section === 'titprivado') {
            const dtVenc = (row as any).dtvencimento;
            if (dtVenc && String(dtVenc).length === 8) {
              prazoDias = diasUteisEntre(dtPosicao, new Date(
                parseInt(String(dtVenc).slice(0, 4)),
                parseInt(String(dtVenc).slice(4, 6)) - 1,
                parseInt(String(dtVenc).slice(6, 8))
              ));
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
          // Trilha fechada: status via meses cobertura (após recálculo)
          status = "pendente";
          indiceLiquidez = null;
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
          fundo_isin: isin || undefined,
          dt_posicao: dateStr,
          administrador: fundo.admin,
          pl: effectivePL,
          xmlPL,
          csvPL: plResolved.hasPLDiscrepancy ? csvPL : (csvPL || 0),
          hasPLDiscrepancy,
          prazoResgate: prazoFundo,
          isFundoFechado: isFechado,
          abertoEstatutariamente,
          indiceLiquidez,
          status,
          intermediateStatus: null,
          classeAnbima,
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

  const fundsFiltrados = funds.filter((f) => {
    const termo = busca.toLowerCase();
    return (f.nome_fundo?.toLowerCase() || "").includes(termo) || (f.fundo_cnpj || "").includes(termo);
  });

  useEffect(() => {
    if (!date) return;
    const dtPosicao = formatDateToDB(date);

    let cancelled = false;

    async function loadResults() {
      const merged = await loadAndMigrateLiquidezProcessedResults(dtPosicao);
      if (!cancelled) setProcessedResults(merged);
    }

    loadResults().catch(() => {
      if (!cancelled) setProcessedResults(new Map());
    });
    return () => { cancelled = true; };
  }, [date]);

  const fundsInTrilha = useMemo(() => {
    return funds.filter((f) => {
      const processed = resolveProcessedFund(processedResults, f.fundo_cnpj, f.fundo_isin);
      const isFechado = processed ? processed.isFundoFechado : f.isFundoFechado;
      return trilhaFilter === "fechados" ? isFechado : !isFechado;
    });
  }, [funds, processedResults, trilhaFilter]);

  useEffect(() => {
    setSelectedFundsCnpjs(new Set());
  }, [trilhaFilter]);

  const handleRecalculate = useCallback(async () => {
    if (!date || fundsInTrilha.length === 0) return;
    const dateStr = formatDateToDB(date);

    const fundsToProcess = selectedFundsCnpjs.size === 0
      ? fundsInTrilha
      : fundsInTrilha.filter((f) => selectedFundsCnpjs.has(fundCacheKey(f.fundo_cnpj, f.fundo_isin)));

    cancelRef.current = false;
    setProcessing(true);
    setProcessTotal(fundsToProcess.length);
    setProcessProgress(0);
    setProcessLog([]);
    setProcessDialogOpen(true);

    const newResults = new Map<string, ProcessedFundData>();
    const log: ProcessResult[] = [];

    for (let i = 0; i < fundsToProcess.length; i++) {
      if (cancelRef.current) break;

      const f = fundsToProcess[i];
      const cacheKey = fundCacheKey(f.fundo_cnpj, f.fundo_isin);
      try {
        const { data, error } = await supabase.functions.invoke("calculo-risco-liquidez", {
          body: {
            fundo_cnpj: f.fundo_cnpj,
            fundo_isin: f.fundo_isin || null,
            fundo_dtposicao: dateStr,
            classe: f.classeAnbima,
            segmento_investidor: "PRIVATE",
            metrica: "media_simples",
          },
        });

        if (error || !data?.success) {
          log.push({ cnpj: f.fundo_cnpj, nome: f.nome_fundo, success: false, error: error?.message || data?.error || "Erro" });
          if (cacheKey) {
            newResults.set(cacheKey, {
              totalPL: f.pl,
              isFundoFechado: f.isFundoFechado,
              prazoResgate: f.prazoResgate,
              indiceLiquidez: f.indiceLiquidez,
              status: "pendente",
              intermediateStatus: null,
            });
          }
        } else {
          const d = data.data;
          const isFechado = !!d.isFundoFechado;
          const prazoResgate = d.mainFundChar?.prazo_pagamento_resgate_dias ?? null;
          let indiceLiquidez: number | null = null;
          let status = d.worstStatus || "pendente";
          let intermediateStatus: string | null = null;

          if (isFechado) {
            if (cacheKey) {
              if (d.fundoFechadoAnalise) {
                newResults.set(cacheKey, {
                  totalPL: d.totalPL || 0,
                  isFundoFechado: true,
                  prazoResgate,
                  ...mapCalculoToProcessedFechado(d),
                });
              } else {
                newResults.set(cacheKey, {
                  totalPL: d.totalPL || 0,
                  isFundoFechado: true,
                  prazoResgate,
                  indiceLiquidez: null,
                  status: "pendente",
                  intermediateStatus: null,
                  mesesCobertura: null,
                  dispPL: null,
                  statusCobertura: "indisponivel",
                  fonteDespesa: null,
                });
              }
            }
          } else if (prazoResgate != null && Array.isArray(d.tabelaVertices)) {
            // Vértice no prazo do fundo (exato ou o primeiro que cobre)
            const vertice = d.tabelaVertices.find((v: any) => Number(v.vertice) === Number(prazoResgate))
              || d.tabelaVertices.find((v: any) => Number(v.vertice) >= Number(prazoResgate));
            if (vertice) {
              // Índice ANBIMA = ativoAcumulado / passivoAcumulado (ex: 1.2 = 120%)
              indiceLiquidez = vertice.indiceAcumulado ?? (vertice.passivoAcumulado > 0
                ? vertice.ativoAcumulado / vertice.passivoAcumulado
                : null);
              
              // Status: apenas o status do vértice do prazo (sem "contaminação" de anteriores)
              status = vertice.statusConsolidado || vertice.status || status;
            }

            // Status intermediário: verifica se há violação/alerta em vértices ANTERIORES ao prazo
            const intermediateVertices = d.tabelaVertices.filter((v: any) => Number(v.vertice) < Number(prazoResgate));
            if (intermediateVertices.length > 0) {
              const hasViolacao = intermediateVertices.some((v: any) => (v.statusConsolidado || v.status) === "violacao");
              const hasAlerta = intermediateVertices.some((v: any) => (v.statusConsolidado || v.status) === "alerta");
              if (hasViolacao) intermediateStatus = "violacao";
              else if (hasAlerta) intermediateStatus = "alerta";
            }
          }

          if (!isFechado && cacheKey) {
            newResults.set(cacheKey, {
              totalPL: d.totalPL || 0,
              isFundoFechado: false,
              prazoResgate,
              indiceLiquidez,
              status,
              intermediateStatus,
            });
          }

          log.push({ cnpj: f.fundo_cnpj, nome: f.nome_fundo, success: true });
        }
      } catch (err: any) {
        log.push({ cnpj: f.fundo_cnpj, nome: f.nome_fundo, success: false, error: err?.message || "Erro desconhecido" });
        if (cacheKey) {
          newResults.set(cacheKey, {
            totalPL: f.pl,
            isFundoFechado: f.isFundoFechado,
            prazoResgate: f.prazoResgate,
            indiceLiquidez: f.indiceLiquidez,
            status: "pendente",
            intermediateStatus: null,
          });
        }
      }

      setProcessProgress(i + 1);
      setProcessLog([...log]);
    }

    // Merge com resultados existentes — fundos fora da seleção mantêm o status anterior
    const merged = new Map(processedResultsRef.current);
    for (const [k, v] of newResults.entries()) merged.set(k, v);
    setProcessedResults(merged);

    // Persiste no banco (fonte primária, multi-sessão)
    saveLiquidezResultsToDb(dateStr, merged).catch((e) => {
      console.warn("[liquidez] Erro ao salvar resultados no banco:", e);
    });

    // Mantém localStorage como backup secundário
    try {
      const obj = Object.fromEntries(merged.entries());
      localStorage.setItem(storageKey, JSON.stringify(obj));
    } catch (e) {
      console.warn("[liquidez] Não foi possível gravar o cache local (limite ou storage bloqueado):", e);
    }

    setProcessing(false);
    queryClient.invalidateQueries({ queryKey: ["liquidez-funds-list"] });
  }, [date, fundsInTrilha, queryClient, storageKey, selectedFundsCnpjs]);

  const handleCancelProcess = () => {
    cancelRef.current = true;
  };

  const rangeDatesInPeriod = useMemo(() => {
    if (!rangeStartDate || !rangeEndDate) return [];
    const startStr = formatDateToDB(rangeStartDate <= rangeEndDate ? rangeStartDate : rangeEndDate);
    const endStr = formatDateToDB(rangeStartDate <= rangeEndDate ? rangeEndDate : rangeStartDate);
    return availableDates
      .filter((d) => d >= startStr && d <= endStr)
      .sort((a, b) => a.localeCompare(b));
  }, [rangeStartDate, rangeEndDate, availableDates]);

  const handleRecalculateRange = useCallback(async () => {
    if (rangeDatesInPeriod.length === 0) return;

    rangeCancelRef.current = false;
    setRangeProcessing(true);
    setRangeDone(false);
    setRangeDateTotal(rangeDatesInPeriod.length);
    setRangeDateProgress(0);
    setRangeFundProgress(0);
    setRangeFundTotal(0);
    setRangeCurrentDate("");
    setRangeLog([]);

    for (let di = 0; di < rangeDatesInPeriod.length; di++) {
      if (rangeCancelRef.current) break;

      const dtPosicao = rangeDatesInPeriod[di];
      setRangeCurrentDate(dtPosicao);
      setRangeFundProgress(0);
      setRangeFundTotal(0);

      // Carrega apenas pares monitorados para esta data (filtra por cnpjgestor via RPC)
      const { data: paresData, error: paresError } = await (supabase as any).rpc(
        "get_pares_fundo_monitorado",
        { p_dtposicao: dtPosicao },
      );

      if (rangeCancelRef.current) break;
      if (paresError) continue;

      const fundMap = new Map<string, string>();
      for (const p of (paresData ?? []) as any[]) {
        if (p.fundo_cnpj && !fundMap.has(p.fundo_cnpj)) {
          fundMap.set(p.fundo_cnpj, (p.nome_fundo || p.fundo_cnpj).trim());
        }
      }

      // Busca nivel1_categoria em lote para inferir classe ANBIMA
      const cnpjsList = [...fundMap.keys()];
      const classeMap = new Map<string, string>();
      const fechadoMap = new Map<string, boolean>();
      if (cnpjsList.length > 0) {
        const fmtCnpj = (d: string) =>
          d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d;
        const cleaned = cnpjsList.map((c) => c.replace(/\D/g, ""));
        const formatted = cleaned.filter((c) => c.length === 14).map(fmtCnpj);
        const allVariants = [...new Set([...cnpjsList, ...cleaned, ...formatted])].filter(Boolean);

        const { data: chars } = await (supabase as any)
          .from("fundos_caracteristicas")
          .select("cnpj_classe, cnpj_fundo, nivel1_categoria, aberto_estatutariamente")
          .in("cnpj_classe", allVariants);
        const { data: chars2 } = await (supabase as any)
          .from("fundos_caracteristicas")
          .select("cnpj_classe, cnpj_fundo, nivel1_categoria, aberto_estatutariamente")
          .in("cnpj_fundo", allVariants);

        for (const c of ([...(chars ?? []), ...(chars2 ?? [])] as any[])) {
          const kClasse = c.cnpj_classe ? String(c.cnpj_classe).replace(/\D/g, "") : null;
          const kFundo = c.cnpj_fundo ? String(c.cnpj_fundo).replace(/\D/g, "") : null;
          const isFechado = isFundoFechado(c.aberto_estatutariamente);
          for (const k of [kClasse, kFundo]) {
            if (k && !classeMap.has(k)) {
              classeMap.set(k, inferClasseAnbima(c.nivel1_categoria ?? null, ""));
            }
            if (k && !fechadoMap.has(k)) {
              fechadoMap.set(k, isFechado);
            }
          }
        }
      }

      const fundsForDate = cnpjsList
        .filter((cnpj) => {
          const key = cnpj.replace(/\D/g, "");
          if (selectedFundsCnpjs.size > 0 && !selectedFundsCnpjs.has(key)) return false;
          const isFechado = fechadoMap.get(key) ?? false;
          return trilhaFilter === "fechados" ? isFechado : !isFechado;
        })
        .map((cnpj) => ({
          cnpj,
          nome: fundMap.get(cnpj) || cnpj,
          classeAnbima: classeMap.get(cnpj.replace(/\D/g, "")) ?? "Multimercados",
        }));

      setRangeFundTotal(fundsForDate.length);

      const dateResults = new Map<string, ProcessedFundData>();

      for (let fi = 0; fi < fundsForDate.length; fi++) {
        if (rangeCancelRef.current) break;

        const f = fundsForDate[fi];
        const cnpjKey = f.cnpj.replace(/\D/g, "");

        try {
          const { data, error } = await supabase.functions.invoke("calculo-risco-liquidez", {
            body: {
              fundo_cnpj: f.cnpj,
              fundo_dtposicao: dtPosicao,
              classe: f.classeAnbima,
              segmento_investidor: "PRIVATE",
              metrica: "media_simples",
            },
          });

          if (error || !data?.success) {
            setRangeLog((prev) => [...prev, { date: dtPosicao, cnpj: f.cnpj, nome: f.nome, success: false, error: error?.message || data?.error || "Erro" }]);
            if (cnpjKey) {
              dateResults.set(cnpjKey, { totalPL: 0, isFundoFechado: false, prazoResgate: null, indiceLiquidez: null, status: "pendente", intermediateStatus: null });
            }
          } else {
            const d = data.data;
            const isFechado = !!d.isFundoFechado;
            const prazoResgate = d.mainFundChar?.prazo_pagamento_resgate_dias ?? null;
            let indiceLiquidez: number | null = null;
            let status = d.worstStatus || "pendente";
            let intermediateStatus: string | null = null;

            if (isFechado) {
              if (cnpjKey) {
                if (d.fundoFechadoAnalise) {
                  dateResults.set(cnpjKey, {
                    totalPL: d.totalPL || 0,
                    isFundoFechado: true,
                    prazoResgate,
                    ...mapCalculoToProcessedFechado(d),
                  });
                } else {
                  dateResults.set(cnpjKey, {
                    totalPL: d.totalPL || 0,
                    isFundoFechado: true,
                    prazoResgate,
                    indiceLiquidez: null,
                    status: "pendente",
                    intermediateStatus: null,
                    mesesCobertura: null,
                    dispPL: null,
                    statusCobertura: "indisponivel",
                    fonteDespesa: null,
                  });
                }
              }
            } else if (prazoResgate != null && Array.isArray(d.tabelaVertices)) {
              const vertice = d.tabelaVertices.find((v: any) => Number(v.vertice) === Number(prazoResgate))
                || d.tabelaVertices.find((v: any) => Number(v.vertice) >= Number(prazoResgate));
              if (vertice) {
                indiceLiquidez = vertice.indiceAcumulado ?? (vertice.passivoAcumulado > 0 ? vertice.ativoAcumulado / vertice.passivoAcumulado : null);
                status = vertice.statusConsolidado || vertice.status || status;
              }
              const intermediateVertices = d.tabelaVertices.filter((v: any) => Number(v.vertice) < Number(prazoResgate));
              if (intermediateVertices.length > 0) {
                const hasViolacao = intermediateVertices.some((v: any) => (v.statusConsolidado || v.status) === "violacao");
                const hasAlerta = intermediateVertices.some((v: any) => (v.statusConsolidado || v.status) === "alerta");
                if (hasViolacao) intermediateStatus = "violacao";
                else if (hasAlerta) intermediateStatus = "alerta";
              }
            }

            if (!isFechado && cnpjKey) {
              dateResults.set(cnpjKey, { totalPL: d.totalPL || 0, isFundoFechado: false, prazoResgate, indiceLiquidez, status, intermediateStatus });
            }
            setRangeLog((prev) => [...prev, { date: dtPosicao, cnpj: f.cnpj, nome: f.nome, success: true }]);
          }
        } catch (err: any) {
          setRangeLog((prev) => [...prev, { date: dtPosicao, cnpj: f.cnpj, nome: f.nome, success: false, error: err?.message || "Erro desconhecido" }]);
          if (cnpjKey) {
            dateResults.set(cnpjKey, { totalPL: 0, isFundoFechado: false, prazoResgate: null, indiceLiquidez: null, status: "pendente", intermediateStatus: null });
          }
        }

        setRangeFundProgress(fi + 1);
      }

      // Persiste no banco para esta data
      if (dateResults.size > 0) {
        saveLiquidezResultsToDb(dtPosicao, dateResults).catch(() => {});

        // Atualiza localStorage também para a data atual visível
        if (date && formatDateToDB(date) === dtPosicao) {
          setProcessedResults(new Map(dateResults));
          try {
            const storageKeyDate = liquidezStorageKey(dtPosicao);
            localStorage.setItem(storageKeyDate, JSON.stringify(Object.fromEntries(dateResults.entries())));
          } catch {}
        }
      }

      setRangeDateProgress(di + 1);
    }

    setRangeProcessing(false);
    setRangeDone(true);
    queryClient.invalidateQueries({ queryKey: ["liquidez-funds-list"] });
  }, [rangeDatesInPeriod, date, queryClient, selectedFundsCnpjs, trilhaFilter]);

  const handleRowClick = (fund: FundRow) => {
    const isinSuffix = fund.fundo_isin
      ? `?isin=${encodeURIComponent(fund.fundo_isin)}`
      : "";
    navigate(`/liquidez/monitoramento-fundo/${fund.fundo_cnpj}/${fund.dt_posicao}${isinSuffix}`, {
      state: { from: `${location.pathname}${location.search}` },
    });
  };

  const toggleSort = (key: SortKey) => {
    setSortConfig((current) => {
      if (current.key !== key) return { key, direction: "asc" };
      if (current.direction === "none") return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      return { key, direction: "none" };
    });
  };

  const getColumnSortDirection = (key: SortKey): SortDirection =>
    sortConfig.key === key ? sortConfig.direction : "none";

  const getSortTitle = (key: SortKey, label: string) => {
    const direction = getColumnSortDirection(key);
    if (direction === "asc") return `${label}: crescente`;
    if (direction === "desc") return `${label}: decrescente`;
    return `Clique para ordenar por ${label.toLowerCase()}`;
  };

  const renderSortIcon = (key: SortKey) => {
    const direction = getColumnSortDirection(key);
    if (direction === "asc") return <ChevronUp className="h-3 w-3 text-primary" />;
    if (direction === "desc") return <ChevronDown className="h-3 w-3 text-primary" />;
    return <ChevronsUpDown className="h-3 w-3 text-muted-foreground/50" />;
  };

  const getFundDisplay = (fund: FundRow) => {
    const processed = resolveProcessedFund(processedResults, fund.fundo_cnpj, fund.fundo_isin);
    const effectiveIsFundoFechado = processed ? processed.isFundoFechado : fund.isFundoFechado;

    // ── Trilha fechados (cobertura operacional) — separada dos abertos ──
    if (effectiveIsFundoFechado) {
      let displayPL = fund.pl;
      if (processed && fund.hasPLDiscrepancy && fund.csvPL > 0) {
        displayPL = fund.csvPL;
      }
      return {
        pl: displayPL,
        prazoResgate: processed?.prazoResgate ?? fund.prazoResgate,
        isFundoFechado: true,
        indiceLiquidez: null,
        mesesCobertura: processed?.mesesCobertura ?? null,
        dispPL: processed?.dispPL ?? null,
        status: processed?.status ?? "pendente",
        statusCobertura: processed?.statusCobertura ?? "indisponivel",
        fonteDespesa: processed?.fonteDespesa ?? null,
        intermediateStatus: null,
        hasPLDiscrepancy: fund.hasPLDiscrepancy,
        xmlPL: fund.xmlPL,
        csvPL: fund.csvPL,
      };
    }

    let displayPL = fund.pl;
    // Para fundos abertos sem dados processados, não exibir índice preliminar (evita falso HARD LIMIT)
    let displayIndice = processed ? processed.indiceLiquidez : null;
    let displayStatus = processed ? processed.status : "pendente";

    if (processed) {
      if (fund.hasPLDiscrepancy && fund.csvPL > 0 && processed.totalPL > 0) {
        displayPL = fund.csvPL;
        if (displayIndice != null) {
          displayIndice = displayIndice * (processed.totalPL / fund.csvPL);
          const f7 = processed.prazoResgate ?? fund.prazoResgate ?? 0;
          let softLimitThreshold = 1.05;
          if (f7 <= 60) softLimitThreshold = 1.2;
          else if (f7 <= 126) softLimitThreshold = 1.1;

          if (displayIndice <= 1) displayStatus = "violacao";
          else if (displayIndice < softLimitThreshold) displayStatus = "alerta";
          else displayStatus = "ok";
        }
      }
    }

    return {
      pl: displayPL,
      prazoResgate: processed ? processed.prazoResgate : fund.prazoResgate,
      isFundoFechado: false,
      indiceLiquidez: displayIndice,
      status: displayStatus,
      intermediateStatus: processed ? processed.intermediateStatus : null,
      hasPLDiscrepancy: fund.hasPLDiscrepancy,
      xmlPL: fund.xmlPL,
      csvPL: fund.csvPL,
    };
  };

  const rowsToShow = useMemo(() => {
    const statusRank: Record<string, number> = {
      violacao: 0,
      alerta: 1,
      pendente: 2,
      ok: 3,
    };

    const intermediateStatusRank: Record<string, number> = {
      violacao: 0,
      alerta: 1,
      none: 2,
    };

    const filtered = fundsFiltrados
      .map((fund) => ({ fund, display: getFundDisplay(fund) }))
      .filter(({ display }) => {
        if (trilhaFilter === "abertos" && display.isFundoFechado) return false;
        if (trilhaFilter === "fechados" && !display.isFundoFechado) return false;
        return statusFilter === "all" || display.status === statusFilter;
      });

    if (sortConfig.direction === "none") return filtered;

    const directionFactor = sortConfig.direction === "asc" ? 1 : -1;

    filtered.sort((a, b) => {
      let diff = 0;

      switch (sortConfig.key) {
        case "nome_fundo":
          diff = (a.fund.nome_fundo || "").localeCompare(b.fund.nome_fundo || "", "pt-BR", { sensitivity: "base" });
          break;
        case "fundo_cnpj":
          diff = (a.fund.fundo_cnpj || "").localeCompare(b.fund.fundo_cnpj || "", "pt-BR");
          break;
        case "administrador":
          diff = (a.fund.administrador || "").localeCompare(b.fund.administrador || "", "pt-BR", { sensitivity: "base" });
          break;
        case "pl":
          diff = a.display.pl - b.display.pl;
          break;
        case "prazoResgate":
          diff = (a.display.prazoResgate ?? Number.POSITIVE_INFINITY) - (b.display.prazoResgate ?? Number.POSITIVE_INFINITY);
          break;
        case "tipoFundo": {
          const tipoRank = (f: FundRow) => {
            if (f.abertoEstatutariamente == null) return 2;
            return isFundoFechado(f.abertoEstatutariamente) ? 0 : 1;
          };
          diff = tipoRank(a.fund) - tipoRank(b.fund);
          break;
        }
        case "mesesCobertura":
          diff = (a.display.mesesCobertura ?? Number.NEGATIVE_INFINITY) - (b.display.mesesCobertura ?? Number.NEGATIVE_INFINITY);
          break;
        case "indiceLiquidez":
          diff = (a.display.indiceLiquidez ?? Number.NEGATIVE_INFINITY) - (b.display.indiceLiquidez ?? Number.NEGATIVE_INFINITY);
          break;
        case "status":
          diff = (statusRank[a.display.status] ?? 99) - (statusRank[b.display.status] ?? 99);
          break;
        case "intermediateStatus":
          diff =
            (intermediateStatusRank[a.display.intermediateStatus ?? "none"] ?? 99) -
            (intermediateStatusRank[b.display.intermediateStatus ?? "none"] ?? 99);
          break;
      }

      if (diff !== 0) return diff * directionFactor;
      return b.display.pl - a.display.pl;
    });

    return filtered;
  }, [fundsFiltrados, statusFilter, sortConfig, processedResults, trilhaFilter]);

  const handleExportPdf = useCallback(async () => {
    if (!date || rowsToShow.length === 0 || trilhaFilter !== "abertos") return;
    setExportingPdf(true);
    try {
      const dataRef = format(date, "dd/MM/yyyy");
      const fundosForPdf = rowsToShow.map(({ fund, display }) => {
        return {
          nome_fundo: fund.nome_fundo || "—",
          fundo_cnpj: fund.fundo_cnpj,
          administrador: fund.administrador || "—",
          pl: display.pl,
          prazo_resgate: display.prazoResgate,
          disponibilidade: display.pl * (display.indiceLiquidez ?? 0),
          dispPL: display.indiceLiquidez ?? 0,
          status: display.status,
          intermediateStatus: display.intermediateStatus ?? null,
        };
      });
      const tot = {
        total: rowsToShow.length,
        ok:       fundosForPdf.filter((f) => f.status === "ok").length,
        alerta:   fundosForPdf.filter((f) => f.status === "alerta").length,
        violacao: fundosForPdf.filter((f) => f.status === "violacao").length,
        semPrazo: fundosForPdf.filter((f) => f.status === "pendente").length,
        plTotal:  fundosForPdf.reduce((s, f) => s + f.pl, 0),
      };
      await exportConsolidadoPdf(fundosForPdf, tot, dataRef);
    } finally {
      setExportingPdf(false);
    }
  }, [date, rowsToShow, trilhaFilter]);

  const successCount = processLog.filter((r) => r.success).length;
  const errorCount = processLog.filter((r) => !r.success).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-center justify-end gap-3">
        <div className="flex items-center gap-2">
          <DateRefNavigator
            availableDates={availableDates}
            date={date}
            onDateChange={setDate}
            formatDateToDB={formatDateToDB}
            popoverAlign="end"
          />
          {/* Seletor de fundos */}
          <Popover open={fundSelectorOpen} onOpenChange={setFundSelectorOpen}>
            <PopoverTrigger asChild>
              <Button
                variant={selectedFundsCnpjs.size > 0 ? "default" : "outline"}
                size="sm"
                className="h-8 px-3 gap-2 text-sm font-medium"
                title="Selecionar fundos para processar"
              >
                <Users2 className="h-3.5 w-3.5" />
                {selectedFundsCnpjs.size === 0 ? `Todos (${trilhaFilter === "fechados" ? "fechados" : "abertos"})` : `${selectedFundsCnpjs.size} fundo${selectedFundsCnpjs.size !== 1 ? "s" : ""}`}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-2" align="end">
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1 pb-1.5 border-b border-border">
                  <span className="text-xs font-medium text-muted-foreground">Selecionar fundos</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setSelectedFundsCnpjs(new Set(fundsInTrilha.map((f) => fundCacheKey(f.fundo_cnpj, f.fundo_isin))))}
                      className="text-[10px] text-primary hover:underline"
                    >
                      Todos
                    </button>
                    <span className="text-muted-foreground text-[10px]">·</span>
                    <button
                      onClick={() => setSelectedFundsCnpjs(new Set())}
                      className="text-[10px] text-muted-foreground hover:underline"
                    >
                      Limpar
                    </button>
                  </div>
                </div>
                <Input
                  placeholder="Buscar fundo..."
                  value={fundSelectorSearch}
                  onChange={(e) => setFundSelectorSearch(e.target.value)}
                  className="h-7 text-xs"
                />
                <div className="max-h-60 overflow-y-auto space-y-0.5 pr-0.5">
                  {fundsInTrilha
                    .filter((f) =>
                      (f.nome_fundo?.toLowerCase() || "").includes(fundSelectorSearch.toLowerCase()) ||
                      f.fundo_cnpj.includes(fundSelectorSearch)
                    )
                    .map((f) => {
                        const key = fundCacheKey(f.fundo_cnpj, f.fundo_isin);
                        const checked = selectedFundsCnpjs.has(key);
                      return (
                        <button
                          key={key}
                          onClick={() => {
                            const next = new Set(selectedFundsCnpjs);
                            if (checked) next.delete(key); else next.add(key);
                            setSelectedFundsCnpjs(next);
                          }}
                          className={cn(
                            "w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left transition-colors",
                            checked ? "bg-muted font-medium" : "hover:bg-muted/60"
                          )}
                        >
                          <span className={cn(
                            "w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0",
                            checked ? "bg-primary border-primary" : "border-border"
                          )}>
                            {checked && <CheckCircle2 className="h-2 w-2 text-primary-foreground" />}
                          </span>
                          <span className="truncate flex-1">{f.nome_fundo || f.fundo_cnpj}</span>
                        </button>
                      );
                    })}
                </div>
              </div>
            </PopoverContent>
          </Popover>

          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 gap-2 text-sm font-medium"
            onClick={() => { setRangeDone(false); setRangeLog([]); setRangeDialogOpen(true); }}
            disabled={processing || rangeProcessing}
            title="Recalcular múltiplas datas de uma vez"
          >
            <CalendarRange className="h-3.5 w-3.5" />
            Período
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 gap-2 text-sm font-medium"
            onClick={() => setPendentesDialogOpen(true)}
            disabled={processing || rangeProcessing}
            title="Calcular apenas fundos/datas sem resultado de liquidez ou enquadramento"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Pendentes
          </Button>
          <Button
            variant="default"
            size="sm"
            className="h-8 px-3 gap-2 text-sm font-medium"
            onClick={handleRecalculate}
            disabled={processing || fundsInTrilha.length === 0}
          >
            {processing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Recalcular
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 gap-2 text-sm font-medium"
            onClick={handleExportPdf}
            disabled={exportingPdf || rowsToShow.length === 0 || trilhaFilter !== "abertos"}
            title={trilhaFilter !== "abertos" ? "Exportação PDF disponível apenas na trilha Abertos" : "Exportar relatório profissional em PDF"}
          >
            {exportingPdf ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
            {exportingPdf ? "Gerando..." : "Exportar PDF"}
          </Button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="rcv-seg shrink-0">
          <button
            type="button"
            onClick={() => setTrilhaFilter("abertos")}
            className="rcv-seg__item"
            aria-selected={trilhaFilter === "abertos"}
          >
            Abertos
          </button>
          <button
            type="button"
            onClick={() => setTrilhaFilter("fechados")}
            className="rcv-seg__item"
            aria-selected={trilhaFilter === "fechados"}
          >
            Fechados
          </button>
        </div>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Buscar fundo por nome ou CNPJ..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="pl-9 bg-card border-border h-8 text-xs"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v: "all" | "ok" | "alerta" | "violacao" | "pendente") => setStatusFilter(v)}>
          <SelectTrigger className="w-[180px] h-8 text-xs">
            <div className="flex items-center gap-2">
              <Filter className="h-3.5 w-3.5" />
              <SelectValue placeholder="Filtrar status" />
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os status</SelectItem>
            <SelectItem value="ok">OK</SelectItem>
            <SelectItem value="alerta">Soft Limit</SelectItem>
            <SelectItem value="violacao">Hard Limit</SelectItem>
            <SelectItem value="pendente">Pendente</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-32 space-y-3">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Sincronizando posições…</p>
        </div>
      ) : rowsToShow.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-32 text-center space-y-4 border border-dashed border-border rounded-lg bg-muted/10">
          <div className="p-4 bg-muted rounded-full">
            <Search className="h-8 w-8 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <p className="text-base font-semibold text-foreground">Nenhum fundo encontrado</p>
            <p className="text-sm text-muted-foreground max-w-md">
              Não encontramos resultados para sua busca nesta data.
            </p>
          </div>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-lg shadow-sm">
          <Table containerClassName="overflow-visible">
            <TableHeader className="bg-muted/30">
              <TableRow className="hover:bg-transparent border-border">
                <TableHead className="h-11 px-4 text-[11px] font-bold uppercase tracking-wider text-muted-foreground min-w-[250px]">
                  <button
                    type="button"
                    onClick={() => toggleSort("nome_fundo")}
                    className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
                    title={getSortTitle("nome_fundo", "Fundo")}
                  >
                    <span>Fundo</span>
                    {renderSortIcon("nome_fundo")}
                  </button>
                </TableHead>
                <TableHead className="h-11 text-[11px] font-bold uppercase tracking-wider text-muted-foreground min-w-[168px]">
                  <button
                    type="button"
                    onClick={() => toggleSort("fundo_cnpj")}
                    className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
                    title={getSortTitle("fundo_cnpj", "CNPJ")}
                  >
                    <span>CNPJ</span>
                    {renderSortIcon("fundo_cnpj")}
                  </button>
                </TableHead>
                <TableHead className="h-11 text-[11px] font-bold uppercase tracking-wider text-muted-foreground min-w-[180px]">
                  <button
                    type="button"
                    onClick={() => toggleSort("administrador")}
                    className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
                    title={getSortTitle("administrador", "Administrador")}
                  >
                    <span>Administrador</span>
                    {renderSortIcon("administrador")}
                  </button>
                </TableHead>
                <TableHead className="h-11 text-center text-[11px] font-bold uppercase tracking-wider text-muted-foreground min-w-[90px]">
                  <button
                    type="button"
                    onClick={() => toggleSort("tipoFundo")}
                    className="inline-flex items-center justify-center gap-1.5 transition-colors hover:text-foreground"
                    title={getSortTitle("tipoFundo", "Tipo")}
                  >
                    <span>Tipo</span>
                    {renderSortIcon("tipoFundo")}
                  </button>
                </TableHead>
                <TableHead className="h-11 text-right text-[11px] font-bold uppercase tracking-wider text-muted-foreground min-w-[110px]">
                  <button
                    type="button"
                    onClick={() => toggleSort("pl")}
                    className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
                    title={getSortTitle("pl", "PL")}
                  >
                    <span>PL</span>
                    {renderSortIcon("pl")}
                  </button>
                </TableHead>
                <TableHead className="h-11 text-center text-[11px] font-bold uppercase tracking-wider text-muted-foreground min-w-[90px]">
                  <button
                    type="button"
                    onClick={() => toggleSort("prazoResgate")}
                    className="inline-flex items-center justify-center gap-1.5 transition-colors hover:text-foreground"
                    title={getSortTitle("prazoResgate", "Prazo Resgate")}
                  >
                    <span>Prazo Resgate</span>
                    {renderSortIcon("prazoResgate")}
                  </button>
                </TableHead>
                <TableHead className="h-11 text-right text-[11px] font-bold uppercase tracking-wider text-muted-foreground min-w-[120px]">
                  {trilhaFilter === "fechados" ? (
                    <button
                      type="button"
                      onClick={() => toggleSort("mesesCobertura")}
                      className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
                      title={getSortTitle("mesesCobertura", "Meses Cobertura")}
                    >
                      <span>Meses Cobertura</span>
                      {renderSortIcon("mesesCobertura")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleSort("indiceLiquidez")}
                      className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
                      title={getSortTitle("indiceLiquidez", "Índice Liquidez")}
                    >
                      <span>Índice Liquidez</span>
                      {renderSortIcon("indiceLiquidez")}
                    </button>
                  )}
                </TableHead>
                {trilhaFilter === "fechados" && (
                  <TableHead className="h-11 text-right text-[11px] font-bold uppercase tracking-wider text-muted-foreground min-w-[90px]">
                    <span>Disp. / PL</span>
                  </TableHead>
                )}
                <TableHead className={cn(
                  "h-11 text-center text-[11px] font-bold uppercase tracking-wider text-muted-foreground",
                  trilhaFilter === "fechados" ? "min-w-[168px]" : "min-w-[120px]"
                )}>
                  <button
                    type="button"
                    onClick={() => toggleSort("status")}
                    className="inline-flex items-center justify-center gap-1.5 transition-colors hover:text-foreground"
                    title={getSortTitle("status", trilhaFilter === "fechados" ? "Cobertura" : "Status")}
                  >
                    <span>{trilhaFilter === "fechados" ? "Cobertura" : "Status"}</span>
                    {renderSortIcon("status")}
                  </button>
                </TableHead>
                {trilhaFilter === "abertos" && (
                <TableHead className="h-11 text-center text-[11px] font-bold uppercase tracking-wider text-muted-foreground w-[60px]">
                  <button
                    type="button"
                    onClick={() => toggleSort("intermediateStatus")}
                    className="inline-flex items-center justify-center gap-1.5 transition-colors hover:text-foreground"
                    title={getSortTitle("intermediateStatus", "Alertas")}
                  >
                    <span>Alertas</span>
                    {renderSortIcon("intermediateStatus")}
                  </button>
                </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rowsToShow.map(({ fund, display }) => {
                const rowKey = fundCacheKey(fund.fundo_cnpj, fund.fundo_isin);
                return (
                  <TableRow
                    key={rowKey}
                    className="cursor-pointer hover:bg-muted/30 transition-colors border-border h-14"
                    onClick={() => handleRowClick(fund)}
                  >
                    <TableCell className="px-4 py-3 font-bold text-sm text-foreground">
                      <div className="max-w-[240px] truncate" title={fund.nome_fundo}>
                        {fund.nome_fundo || "Nome Indisponível"}
                      </div>
                    </TableCell>
                    <TableCell className="py-3 font-mono text-xs text-muted-foreground whitespace-nowrap min-w-[168px]">
                      {fund.fundo_cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")}
                    </TableCell>
                    <TableCell className="py-3 text-xs text-muted-foreground min-w-[180px]">
                      <div className="max-w-[200px] truncate" title={fund.administrador}>
                        {fund.administrador || "–"}
                      </div>
                    </TableCell>
                    <TableCell className="py-3 text-center">
                      {fund.abertoEstatutariamente != null ? (
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] font-bold uppercase tracking-wide",
                            isFundoFechado(fund.abertoEstatutariamente)
                              ? "bg-slate-500/10 text-slate-700 border-slate-200"
                              : "bg-sky-500/10 text-sky-700 border-sky-200"
                          )}
                        >
                          {isFundoFechado(fund.abertoEstatutariamente) ? "Fechado" : "Aberto"}
                        </Badge>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-right text-xs font-mono font-bold">
                      {display.pl > 0 ? (
                        <div className="flex items-center justify-end gap-1.5">
                          {display.hasPLDiscrepancy && (
                            <div title={`Divergência de PL: XML ${formatBRL(display.xmlPL)} → CSV ${formatBRL(display.csvPL)}`} className="text-amber-500">
                              <AlertTriangle className="h-3 w-3" />
                            </div>
                          )}
                          <span>{formatBRL(display.pl)}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-center">
                      {display.prazoResgate != null ? (
                        <Badge variant="outline" className="text-[10px] font-mono font-bold">
                          D+{display.prazoResgate}
                        </Badge>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-right">
                      {trilhaFilter === "fechados" ? (
                        display.mesesCobertura != null ? (
                          <span className={cn(
                            "text-xs font-mono font-bold",
                            display.mesesCobertura >= 7 ? "text-emerald-600"
                              : display.mesesCobertura >= 3 ? "text-amber-600"
                              : "text-red-600"
                          )}>
                            {display.mesesCobertura.toFixed(1)} meses
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">—</span>
                        )
                      ) : (
                        display.indiceLiquidez != null && display.prazoResgate != null ? (
                          <span className={cn(
                            "text-xs font-mono font-bold",
                            display.indiceLiquidez >= 1.1 ? "text-emerald-600"
                              : display.indiceLiquidez >= 1 ? "text-amber-600"
                              : "text-red-600"
                          )}>
                            {formatPerc(display.indiceLiquidez)}
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">—</span>
                        )
                      )}
                    </TableCell>
                    {trilhaFilter === "fechados" && (
                      <TableCell className="py-3 text-right">
                        {display.dispPL != null ? (
                          <span className="text-xs font-mono text-muted-foreground" title="Informativo — amortização">
                            {formatPerc(display.dispPL)}
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell className={cn("py-3 text-center", trilhaFilter === "fechados" && "min-w-[168px]")}>
                      <div className="flex flex-col items-center justify-center gap-1">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded border justify-center shrink-0",
                            trilhaFilter === "fechados"
                              ? "px-3.5 py-2 min-w-[152px] text-[11px] font-bold uppercase tracking-wide whitespace-nowrap leading-none"
                              : "px-3 py-1 min-w-[110px] text-xs font-bold uppercase tracking-wider",
                            display.status === "pendente" && "bg-slate-50 text-slate-600 border-slate-200",
                            display.status === "violacao" && "bg-red-50 text-red-700 border-red-100",
                            display.status === "alerta" && "bg-amber-50 text-amber-700 border-amber-100",
                            display.status === "ok" && "bg-emerald-50 text-emerald-700 border-emerald-100"
                          )}
                        >
                          {display.status === "pendente" ? (
                            <><Clock className="h-3.5 w-3.5 shrink-0" /> {trilhaFilter === "fechados" && display.statusCobertura === "indisponivel" ? "Indisp." : "Pendente"}</>
                          ) : display.status === "violacao" ? (
                            <><XCircle className="h-3.5 w-3.5 shrink-0" /> {trilhaFilter === "fechados" ? "< 3 meses" : "Hard Limit"}</>
                          ) : display.status === "alerta" ? (
                            <><AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {trilhaFilter === "fechados" ? "3–7 meses" : "Soft Limit"}</>
                          ) : (
                            <><CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> {trilhaFilter === "fechados" ? "≥ 7 meses" : "OK"}</>
                          )}
                        </span>
                        {trilhaFilter === "fechados" && display.fonteDespesa && (
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap leading-none">
                            {FONTE_DESPESA_LABELS[display.fonteDespesa] ?? display.fonteDespesa}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    {trilhaFilter === "abertos" && (
                    <TableCell className="py-3 text-center">
                      {display.intermediateStatus && (
                        <div className="flex justify-center" title={`Atenção: ${display.intermediateStatus === 'violacao' ? 'Violação' : 'Alerta'} em vértices intermediários`}>
                          <div className={cn(
                            "h-8 w-8 rounded-full flex items-center justify-center transition-colors",
                            display.intermediateStatus === 'violacao' ? "bg-red-50 text-red-600 hover:bg-red-100" : "bg-amber-50 text-amber-600 hover:bg-amber-100"
                          )}>
                            <AlertTriangle className="h-4 w-4" />
                          </div>
                        </div>
                      )}
                    </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={processDialogOpen} onOpenChange={(open) => {
        if (!processing) setProcessDialogOpen(open);
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {processing ? (
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
              ) : (
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              )}
              {processing ? "Processando Fundos..." : "Processamento Concluído"}
            </DialogTitle>
            <DialogDescription>
              {processing
                ? "Calculando risco de liquidez para cada fundo..."
                : `${successCount} fundo${successCount !== 1 ? "s" : ""} processado${successCount !== 1 ? "s" : ""} com sucesso${errorCount > 0 ? `, ${errorCount} com erro` : ""}.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{processProgress} de {processTotal}</span>
                <span className="text-muted-foreground text-xs">
                  {processTotal > 0 ? Math.round((processProgress / processTotal) * 100) : 0}%
                </span>
              </div>
              <Progress value={processTotal > 0 ? (processProgress / processTotal) * 100 : 0} />
            </div>

            <div className="max-h-[300px] overflow-y-auto space-y-1 border rounded-lg p-2">
              {processLog.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-xs py-1 px-1 rounded hover:bg-muted/50">
                  {r.success ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                  )}
                  <span className="truncate flex-1 font-medium">{r.nome}</span>
                  {!r.success && r.error && (
                    <span className="text-red-500 text-[10px] truncate max-w-[120px]">{r.error}</span>
                  )}
                </div>
              ))}
              {processing && processProgress < processTotal && (
                <div className="flex items-center gap-2 text-xs py-1 px-1 text-muted-foreground">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span>Aguardando...</span>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            {processing ? (
              <Button variant="destructive" size="sm" onClick={handleCancelProcess}>
                Cancelar
              </Button>
            ) : (
              <Button size="sm" onClick={() => setProcessDialogOpen(false)}>
                Fechar
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog: Recalcular por Período ── */}
      <Dialog open={rangeDialogOpen} onOpenChange={(open) => {
        if (!rangeProcessing) setRangeDialogOpen(open);
      }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {rangeProcessing ? (
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
              ) : rangeDone ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              ) : (
                <CalendarRange className="w-5 h-5 text-primary" />
              )}
              {rangeProcessing
                ? "Calculando Período..."
                : rangeDone
                ? "Cálculo de Período Concluído"
                : "Recalcular por Período"}
            </DialogTitle>
            <DialogDescription>
              {rangeProcessing
                ? `Processando data ${rangeDateProgress + 1} de ${rangeDateTotal}...`
                : rangeDone
                ? `${rangeLog.filter((r) => r.success).length} cálculos concluídos com sucesso${rangeLog.filter((r) => !r.success).length > 0 ? `, ${rangeLog.filter((r) => !r.success).length} com erro` : ""}.`
                : "Selecione o intervalo de datas para recalcular. Apenas datas com posição importada são exibidas."}
            </DialogDescription>
          </DialogHeader>

          {!rangeProcessing && !rangeDone && (
            <div className="space-y-4 py-1">
              {/* Date range pickers */}
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

              {/* Resumo fundos selecionados */}
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <Users2 className="h-3.5 w-3.5 shrink-0" />
                {selectedFundsCnpjs.size === 0 ? (
                  <span>Processando <strong className="text-foreground">todos os fundos</strong> de cada data — use o botão <strong className="text-foreground">Todos os fundos</strong> na barra para restringir</span>
                ) : (
                  <span><strong className="text-foreground">{selectedFundsCnpjs.size} fundo{selectedFundsCnpjs.size !== 1 ? "s" : ""} selecionado{selectedFundsCnpjs.size !== 1 ? "s" : ""}</strong> serão processados em cada data do período</span>
                )}
              </div>

              {/* Summary datas */}
              {rangeStartDate && rangeEndDate && (
                <div className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm",
                  rangeDatesInPeriod.length === 0
                    ? "border-amber-200 bg-amber-50 text-amber-700"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700"
                )}>
                  <CalendarRange className="h-4 w-4 shrink-0" />
                  {rangeDatesInPeriod.length === 0 ? (
                    <span>Nenhuma data com posição importada neste intervalo.</span>
                  ) : (
                    <span>
                      <strong>{rangeDatesInPeriod.length}</strong> {rangeDatesInPeriod.length === 1 ? "data encontrada" : "datas encontradas"} —{" "}
                      de <strong>{format(rangeStartDate <= rangeEndDate ? rangeStartDate : rangeEndDate, "dd/MM/yyyy")}</strong> até{" "}
                      <strong>{format(rangeStartDate <= rangeEndDate ? rangeEndDate : rangeStartDate, "dd/MM/yyyy")}</strong>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {(rangeProcessing || rangeDone) && (
            <div className="space-y-4 py-1">
              {/* Progresso datas */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-muted-foreground uppercase tracking-wide">Datas</span>
                  <span className="font-medium tabular-nums">{rangeDateProgress} / {rangeDateTotal}</span>
                </div>
                <Progress value={rangeDateTotal > 0 ? (rangeDateProgress / rangeDateTotal) * 100 : 0} className="h-2" />
                {rangeCurrentDate && (
                  <p className="text-[11px] text-muted-foreground">
                    Processando: <span className="font-mono font-semibold text-foreground">
                      {rangeCurrentDate.slice(6, 8)}/{rangeCurrentDate.slice(4, 6)}/{rangeCurrentDate.slice(0, 4)}
                    </span>
                  </p>
                )}
              </div>

              {/* Progresso fundos dentro da data */}
              {(rangeFundTotal > 0 || rangeProcessing) && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-muted-foreground uppercase tracking-wide">Fundos (data atual)</span>
                    <span className="font-medium tabular-nums">{rangeFundProgress} / {rangeFundTotal}</span>
                  </div>
                  <Progress value={rangeFundTotal > 0 ? (rangeFundProgress / rangeFundTotal) * 100 : 0} className="h-1.5 bg-muted" />
                </div>
              )}

              {/* Log */}
              <div className="max-h-[260px] overflow-y-auto space-y-0.5 border rounded-lg p-2 bg-muted/10">
                {rangeLog.length === 0 && rangeProcessing && (
                  <div className="flex items-center gap-2 text-xs py-1 px-1 text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                    <span>Iniciando...</span>
                  </div>
                )}
                {[...rangeLog].reverse().map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs py-1 px-1 rounded hover:bg-muted/50">
                    {r.success ? (
                      <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
                    ) : (
                      <XCircle className="w-3 h-3 text-red-500 shrink-0" />
                    )}
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                      {r.date.slice(6, 8)}/{r.date.slice(4, 6)}
                    </span>
                    <span className="truncate flex-1 font-medium">{r.nome}</span>
                    {!r.success && r.error && (
                      <span className="text-red-500 text-[10px] truncate max-w-[100px]">{r.error}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            {rangeProcessing ? (
              <Button variant="destructive" size="sm" onClick={() => { rangeCancelRef.current = true; }}>
                Cancelar
              </Button>
            ) : rangeDone ? (
              <Button size="sm" onClick={() => setRangeDialogOpen(false)}>
                Fechar
              </Button>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={() => setRangeDialogOpen(false)}>
                  Cancelar
                </Button>
                <Button
                  size="sm"
                  className="bg-black hover:bg-black/90 text-white gap-2"
                  disabled={rangeDatesInPeriod.length === 0}
                  onClick={handleRecalculateRange}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Calcular {rangeDatesInPeriod.length > 0 ? `(${rangeDatesInPeriod.length} ${rangeDatesInPeriod.length === 1 ? "data" : "datas"})` : ""}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProcessarPendentesDialog
        open={pendentesDialogOpen}
        onOpenChange={setPendentesDialogOpen}
        availableDates={availableDates}
        queryClient={queryClient}
      />
    </div>
  );
}
