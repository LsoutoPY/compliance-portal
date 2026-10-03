import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WalletTable, Asset } from "@/components/wallet/WalletTable";
import { WalletDetailsSheet } from "@/components/wallet/WalletDetailsSheet";
import {
  Building2,
  Users,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Loader2,
  Zap,
  EyeOff,
  Settings2,
  Info,
  Receipt,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FONTE_DESPESA_LABELS } from "@/lib/liquidezFechadoProcessed";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  LiquidezFrequencia,
  LiquidezHeatmap,
  LiquidezStress,
} from "@/components/liquidez/LiquidezCards";
import { exportFundoDetalhesPdf } from "@/lib/exportPdf";
import { exportFundoDetalhesExcel, ExportResgateRow } from "@/lib/exportFundoExcel";
import { computeLiquidezStressChoque } from "@/lib/liquidezStressChoque";
import { format, parse } from "date-fns";
import {
  dedupeCaracteristicasLinhas,
  normalizeIsinLiquidez,
  pickCaracteristicaParaPosicao,
  type FundoCaracteristicaLinha,
} from "@/lib/liquidezFundosCaracteristicas";
import {
  collectNomeLookupKeysFromPosicao,
  fetchNomeMapFromAtivosTable,
  fetchNomeMapFromFundosCaracteristicas,
  mergeNomesAtivosCarteira,
  nomeMapToRecord,
} from "@/lib/mapaAtivosNome";
import { resolveNomeExibicaoFromPosicao } from "@/hooks/useRentabilidadeCalc";
import {
  aggregatePassivoCotistas,
  resolvePassivoRowsForFundDetail,
  type PassivoFundoRow,
} from "@/lib/passivoFundoMatch";
import {
  fetchLiquidezTimelineData,
  mergeLiquidezTimelineStatus,
} from "@/lib/liquidezTimeline";

const CLASSES = ["Multimercados", "Cambial", "Renda Fixa", "RF DI", "Renda Fixa Crédito", "Ações"];
const SEGMENTOS = ["PRIVATE", "PJ", "VAREJO", "EFPC", "INSTITUCIONAIS", "OUTROS"];
const METRICAS = ["media_simples", "EWMA_94", "EWMA_97"];

const formatBRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);
const formatPerc = (v: number) => `${(v * 100).toFixed(2)}%`;

/** Label do vértice: D+720+ para prazos > 720 dias (vértice 1260) */
function verticeLabel(v: number): string {
  return v === 1260 ? "D+720+" : `D+${v}`;
}

/** Texto explicativo da faixa de dias úteis reais por bucket ANBIMA */
function verticeDiasUteisReaisLabel(v: number): string {
  if (v === 1) return "0 a 1 dia útil real";
  if (v === 2) return "entre 1 e 2 dias úteis reais";
  if (v === 3) return "2 dias úteis reais";
  if (v === 4) return "3 dias úteis reais";
  if (v === 5) return "4 dias úteis reais";
  if (v === 10) return "de 5 a 9 dias úteis reais";
  if (v === 21) return "de 10 a 22 dias úteis reais";
  if (v === 42) return "de 23 a 41 dias úteis reais";
  if (v === 63) return "de 42 a 62 dias úteis reais";
  if (v === 126) return "de 63 a 127 dias úteis reais";
  if (v === 252) return "de 121 a 180 dias (CVM) ou 123 dias úteis reais";
  if (v === 378) return "de 181 a 364 dias úteis reais";
  if (v === 504) return "de 365 a 504 dias úteis reais";
  if (v === 720) return "de 505 a 720 dias úteis reais";
  if (v === 1260) return "acima de 720 dias úteis reais";
  return `aproximadamente D+${v} em dias úteis reais`;
}

/** Formata índice de liquidez: exibe valor numérico em vez de ∞ para valores altos ou infinitos */
function formatIndice(val: number): string {
  if (!Number.isFinite(val)) return "—";
  const v = Math.abs(val);
  return v.toFixed(2);
}

/** data_liquidez_prevista da API: YYYY-MM-DD ou YYYYMMDD */
function formatDataLiquidezPrevistaBr(dataLiquidez: string | undefined | null): string {
  const s = String(dataLiquidez ?? "").trim();
  if (!s) return "—";
  if (/^\d{8}$/.test(s)) return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  return s;
}

/** Status consolidado com thresholds configuráveis: violacao se indice ≤ hardThreshold, alerta se < softThreshold, ok caso contrário */
function getConsolidatedStatus(
  indiceVertice: number,
  indiceAcumulado: number,
  hardThreshold: number,
  softThreshold: number,
): "ok" | "alerta" | "violacao" {
  const n = Math.abs(indiceVertice);
  const p = Math.abs(indiceAcumulado);
  if (n <= hardThreshold || p <= hardThreshold) return "violacao";
  if ((n > hardThreshold && n < softThreshold) || (p > hardThreshold && p < softThreshold)) return "alerta";
  return "ok";
}

interface AtivoNoVertice {
  nome: string;
  valor: number;
  prazo: number;
  fonte?: string;
  look_through_resumo?: string;
  look_through_fip_cnpj?: string;
  /** Data YYYYMMDD da posição do FIP usada no look-through (pode diferir da data-base do fundo-pai) */
  look_through_posicao_data?: string;
  look_through_detalhes?: Array<{ nome: string; valor: number; pct: number; data_liquidez: string; dias: number }>;
}

interface VerticeRow {
  vertice: number;
  ativoVertice: number;
  probabilidade: number;
  ativoAcumulado: number;
  /** Passivo ANBIMA (probabilidade × PL) — exibido na coluna "Prob. Resgate Valor" */
  passivoNoVertice: number;
  resgatesSolicitados?: number;
  /**
   * Passivo acumulado efetivo: soma de (resgates quando > 0, senão ANBIMA × PL) vértice a vértice.
   * É o denominador do Índice Acumulado.
   */
  passivoAcumulado: number;
  acumuladoLiquido: number;
  indice: number;
  status: "ok" | "alerta" | "violacao";
  indiceAcumulado: number;
  estadoAcumulado: "ok" | "alerta" | "violacao";
  posicaoPL: number;
  statusPosicao: "ok" | "alerta" | "violacao";
  statusConsolidado: "ok" | "alerta" | "violacao";
  /** Soma dos resgates confirmados de portfólio chegando neste vértice (já incluídos no ativoVertice) */
  resgAtivosVertice?: number;
  /** Resgates sem match de ativo na carteira — exibidos com marcação laranja */
  resgAtivosWarnings?: { descricao: string; valor: number }[];
  ativosNoVertice: AtivoNoVertice[];
}

export interface ExportHandlers {
  exportPdf: () => Promise<void>;
  exportExcel: () => Promise<void>;
}

interface LiquidezFundDetailContentProps {
  fundoCnpj: string;
  fundoDtposicao: string;
  /** ISIN da cota/subclasse do fundo analisado (posicao_carteira.fundo_isin) — refinamento com fundos_caracteristicas */
  fundoIsin?: string | null;
  onStatusChange?: (status: "ok" | "alerta" | "violacao") => void;
  onExportHandlersReady?: (handlers: ExportHandlers) => void;
  /** PL do CSV Finvest — quando presente e diverge >5% do XML, substitui o fundo_patliq nos cálculos */
  csvPL?: number;
  /** Classe ANBIMA inferida pelo tipo do fundo (ex: "Renda Fixa Crédito" para FIDC). Padrão: "Multimercados" */
  initialClasse?: string;
}

const CATEGORIA_LABELS: Record<string, string> = {
  taxa_administracao: "Taxa de Administração",
  taxa_gestao:        "Taxa de Gestão",
  taxa_custodia:      "Taxa de Custódia",
  taxa_anbima:        "Taxa ANBIMA",
  taxa_cetip:         "Taxa CETIP/B3",
  taxa_selic:         "Taxa SELIC",
  tarifa_banco:       "Tarifa Bancária",
  outros_custos:      "Outros Custos",
};

function StatusBadge({ status }: { status: "ok" | "alerta" | "violacao" }) {
  if (status === "ok") {
    return (
      <Badge className="bg-emerald-500/10 text-emerald-700 border-emerald-200 text-[9px] h-4 px-1.5 font-normal">
        <CheckCircle2 className="w-2 h-2 mr-1" /> OK
      </Badge>
    );
  }
  if (status === "alerta") {
    return (
      <Badge className="bg-amber-500/10 text-amber-700 border-amber-200 text-[9px] h-4 px-1.5 font-normal">
        <AlertTriangle className="w-2 h-2 mr-1" /> SOFT
      </Badge>
    );
  }
  return (
    <Badge className="bg-red-500/10 text-red-700 border-red-200 text-[9px] h-4 px-1.5 font-normal">
      <XCircle className="w-2 h-2 mr-1" /> HARD
    </Badge>
  );
}

function CoverageStatusBadge({ status }: { status: "ok" | "alerta" | "violacao" | "indisponivel" }) {
  if (status === "ok") {
    return (
      <Badge className="bg-emerald-500/10 text-emerald-700 border-emerald-200 text-[9px] h-4 px-1.5 font-normal">
        <CheckCircle2 className="w-2 h-2 mr-1" /> OK
      </Badge>
    );
  }
  if (status === "alerta") {
    return (
      <Badge className="bg-amber-500/10 text-amber-700 border-amber-200 text-[9px] h-4 px-1.5 font-normal">
        <AlertTriangle className="w-2 h-2 mr-1" /> SOFT
      </Badge>
    );
  }
  if (status === "violacao") {
    return (
      <Badge className="bg-red-500/10 text-red-700 border-red-200 text-[9px] h-4 px-1.5 font-normal">
        <XCircle className="w-2 h-2 mr-1" /> HARD
      </Badge>
    );
  }
  return (
    <Badge className="bg-muted/50 text-muted-foreground border-muted text-[9px] h-4 px-1.5 font-normal">
      — N/D
    </Badge>
  );
}

export function LiquidezFundDetailContent({ fundoCnpj, fundoDtposicao, fundoIsin = null, onStatusChange, onExportHandlersReady, csvPL, initialClasse }: LiquidezFundDetailContentProps) {
  const [classe, setClasse] = useState<string>(initialClasse ?? "Multimercados");
  const [segmento, setSegmento] = useState<string>("PRIVATE");
  const [metrica, setMetrica] = useState<string>("media_simples");
  const [hardLimitOverride, setHardLimitOverride] = useState<string>("");
  const [softLimitOverride, setSoftLimitOverride] = useState<string>("");
  // Limiares de disponibilidade para fundos fechados (dispPL)
  const [fechadoHardOverride, setFechadoHardOverride] = useState<string>("");
  const [fechadoSoftOverride, setFechadoSoftOverride] = useState<string>("");
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [resgatesSolicitados, setResgatesSolicitados] = useState<number | null>(null);
  const [isVerticesOpen, setIsVerticesOpen] = useState(true);
  const [verticeExpandido, setVerticeExpandido] = useState<number | null>(null);
  /** Drill-down look-through FIP: uma chave `${vertice}-lt-${idx}` ou null (fechado) */
  const [lookThroughExpandidoKey, setLookThroughExpandidoKey] = useState<string | null>(null);
  const [ativosAmortizacaoOpen, setAtivosAmortizacaoOpen] = useState(false);
  const [ativosCoberturaOpen, setAtivosCoberturaOpen] = useState(false);
  const [despesaBreakdownOpen, setDespesaBreakdownOpen] = useState(false);
  const [stressAtivo, setStressAtivo] = useState(false);
  const [ignorarResgates, setIgnorarResgates] = useState(false);
  const expandedRowRef = useRef<HTMLTableRowElement | null>(null);
  // Ref para aplicar initialClasse apenas na primeira vez que chega (query assíncrona do pai),
  // sem sobrescrever seleções manuais do usuário.
  const initialClasseApplied = useRef(false);

  // Sincroniza a classe quando initialClasse chega do pai (query assíncrona).
  // Aplica apenas uma vez para não sobrescrever mudanças manuais do usuário.
  useEffect(() => {
    if (initialClasseApplied.current) return;
    if (!initialClasse || initialClasse === "Multimercados") return;
    setClasse(initialClasse);
    initialClasseApplied.current = true;
  }, [initialClasse]);

  useEffect(() => {
    setLookThroughExpandidoKey(null);
  }, [verticeExpandido]);

  useEffect(() => {
    if (verticeExpandido == null) return;
    const t = setTimeout(() => {
      expandedRowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
    return () => clearTimeout(t);
  }, [verticeExpandido]);


  const fundoIsinNorm = normalizeIsinLiquidez(fundoIsin);

  const { data: walletData, isLoading: walletLoading, isError: walletError, error: queryError } = useQuery({
    queryKey: ["liquidez-wallet", fundoCnpj, fundoDtposicao, fundoIsinNorm],
    enabled: !!fundoCnpj && !!fundoDtposicao,
    queryFn: async () => {
      // vw_posicao_enriquecida preserva todas as colunas de posicao_carteira
      // e adiciona enr_* com classificação Finvest CSV quando disponível.
      // Fallback para posicao_carteira se a view não existir (migration não aplicada).
      let walletData: any[] | null = null;
      const ativosSelect = "*, ativos(id, cnpj, isin, tipo_ativo, validado, nome_frontend, descricao)";
      const { data: fromView, error: viewErr } = await (supabase as any)
        .from("vw_posicao_enriquecida")
        .select(ativosSelect)
        .eq("fundo_cnpj", fundoCnpj)
        .eq("fundo_dtposicao", fundoDtposicao)
        .order("valor_padrao", { ascending: false });

      if (viewErr) {
        const { data: fromTable, error: tableErr } = await supabase
          .from("posicao_carteira")
          .select(ativosSelect)
          .eq("fundo_cnpj", fundoCnpj)
          .eq("fundo_dtposicao", fundoDtposicao)
          .order("valor_padrao", { ascending: false });
        if (tableErr) throw tableErr;
        walletData = fromTable;
      } else {
        walletData = fromView;
      }

      const { cnpjs: nomeLookupCnpjs, isins: nomeLookupIsins } = collectNomeLookupKeysFromPosicao(
        walletData || [],
      );
      const [anbimaMap, frontendMap] = await Promise.all([
        fetchNomeMapFromFundosCaracteristicas(nomeLookupCnpjs, nomeLookupIsins),
        fetchNomeMapFromAtivosTable(nomeLookupCnpjs, nomeLookupIsins),
      ]);
      const nomeMap = nomeMapToRecord(mergeNomesAtivosCarteira(anbimaMap, frontendMap));

      const uniqueCnpjs = [...new Set(
        (walletData || [])
          .map((i: any) => {
            const s = String(i.section || "").toLowerCase();
            if (s === "cotas" || s === "fidc") return i.cnpjfundo ?? i.cnpjemissor;
            return i.cnpjemissor ?? i.cnpjfundo;
          })
          .filter(Boolean)
      )] as string[];

      let charLinhas: FundoCaracteristicaLinha[] = [];
      if (uniqueCnpjs.length > 0) {
        const sel =
          "id, cnpj_classe, cnpj_fundo, isin, estrutura, nome_comercial, prazo_pagamento_resgate_dias";
        const { data: d1 } = await supabase
          .from("fundos_caracteristicas" as any)
          .select(sel)
          .in("cnpj_classe", uniqueCnpjs);
        const { data: d2 } = await supabase
          .from("fundos_caracteristicas" as any)
          .select(sel)
          .in("cnpj_fundo", uniqueCnpjs);
        charLinhas = dedupeCaracteristicasLinhas([...(d1 || []), ...(d2 || [])] as any);
      }

      const mappedXml = (walletData || []).map((item: any) => {
        const sec = String(item.section || "").toLowerCase();
        const cnpjLinha =
          sec === "cotas" || sec === "fidc"
            ? item.cnpjfundo ?? item.cnpjemissor
            : item.cnpjemissor ?? item.cnpjfundo;
        const picked =
          cnpjLinha != null && String(cnpjLinha).trim() !== ""
            ? pickCaracteristicaParaPosicao(charLinhas, cnpjLinha, item.isin)
            : null;
        return {
          ...item,
          nome_comercial_ativo: resolveNomeExibicaoFromPosicao(item, nomeMap),
          prazo_pagamento_resgate_dias: picked?.prazo_pagamento_resgate_dias ?? null,
          validado: item.ativos?.validado ?? true,
        };
      });

      // Busca posições CSV-only (não presentes no XML) para exibir na carteira
      let csvOnly: any[] = [];
      try {
        const cnpj8 = fundoCnpj.replace(/\D/g, "").substring(0, 8);
        const dateIso = `${fundoDtposicao.slice(0, 4)}-${fundoDtposicao.slice(4, 6)}-${fundoDtposicao.slice(6, 8)}`;
        const { data } = await (supabase as any)
          .from("posicao_consolidada")
          .select("id, secao_xml, valor_mercado, quantidade, pu_mercado, cnpj_ativo, codigo_ativo, nome_ativo, subcategoria, categoria_detalhada, nivel_granularidade, status_consolidacao")
          .eq("fundo_cnpj", cnpj8)
          .eq("data_posicao", dateIso)
          .eq("status_consolidacao", "somente_csv");
        csvOnly = data || [];
      } catch {
        csvOnly = [];
      }

      const csvOnlyMapped = csvOnly.map((item: any) => ({
        id: `csv_${item.id}`,
        fundo_cnpj: fundoCnpj,
        fundo_dtposicao: fundoDtposicao,
        fundo_patliq: null,
        section: item.secao_xml || "provisao",
        valor_padrao: item.valor_mercado ?? 0,
        cnpjfundo: item.cnpj_ativo ?? null,
        cnpjemissor: null,
        codativo: item.codigo_ativo ?? null,
        isin: null,
        qtdisponivel: item.quantidade ?? 0,
        puposicao: item.pu_mercado ?? 0,
        nome_comercial_ativo: item.categoria_detalhada || item.subcategoria || item.nome_ativo || item.codigo_ativo || "–",
        prazo_pagamento_resgate_dias: null,
        validado: true,
        ativos: null,
        enr_subcategoria: item.subcategoria ?? null,
        enr_categoria_detalhada: item.categoria_detalhada ?? null,
        enr_nivel_granularidade: item.nivel_granularidade ?? null,
        enr_status_consolidacao: item.status_consolidacao ?? null,
        enr_tem_csv: true,
      }));

      // Retorna dados XML enriquecidos + posições exclusivas do CSV
      if (mappedXml.length === 0 && csvOnlyMapped.length === 0) return [];
      return [...mappedXml, ...csvOnlyMapped];
    },
  });

  const { data: calculoData, isLoading: calculoLoading, isError: calculoError } = useQuery({
    queryKey: ["calculo-risco-liquidez", fundoCnpj, fundoDtposicao, fundoIsinNorm, classe, segmento, metrica, ignorarResgates],
    enabled: !!fundoCnpj && !!fundoDtposicao,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke<{
        success: boolean;
        data?: {
          totalPL: number;
          isFundoFechado: boolean;
          fundoFechadoAnalise: {
            prazoResgate: number;
            disponibilidade: number;
            dispPL: number;
            pl: number;
            status: "ok" | "alerta" | "violacao";
            despesaOperacionalMensal: number | null;
            despesaBreakdown: { categoria: string; mediaMonsal: number; percentual: number; mesesDisponivel: number }[] | null;
            darfEstimado: number;
            caixaLiquido: number;
            mesesCobertura: number | null;
            statusCoberturaDespesa: "ok" | "alerta" | "violacao" | "indisponivel";
            fonteDespesa?: string | null;
            temComeCottas: boolean;
            cotaBaseComeCottas: number | null;
            rentSemestre: number | null;
          } | null;
          darfAberto: {
            darfEstimado: number;
            temComeCottas: boolean;
            cotaBaseComeCottas: number | null;
            rentSemestre: number | null;
          } | null;
          ativosComPrazo: { id: string; nome: string; valor: number; prazos_em_dias: number | null; vertice: number }[];
          tabelaVertices: VerticeRow[];
          indiceMinimo: number;
          worstStatus: "ok" | "alerta" | "violacao";
          mainFundChar: { prazo_pagamento_resgate_dias: number | null } | null;
          matrizPeriodo?: string;
          matrizDataRef?: string;
          fidcLiquidezEstimada?: { cnpj: string; nome: string; ownership_pct: number; pl_fidc: number; valor_aplicado: number; total_estimado: number; dt_comptc: string | null }[];
        };
        error?: string;
      }>("calculo-risco-liquidez", {
        body: {
          fundo_cnpj: fundoCnpj,
          fundo_dtposicao: fundoDtposicao,
          fundo_isin: fundoIsinNorm,
          classe,
          segmento_investidor: segmento,
          metrica,
          ignorar_resgates_solicitados: ignorarResgates,
        },
      });
      if (error) throw new Error((data as any)?.error || error);
      if (!data?.success || !data.data) throw new Error("Resposta inválida da edge function");
      return data.data;
    },
  });

  const matrizPeriodo = calculoData?.matrizPeriodo ?? null;
  const matrizDataRef = calculoData?.matrizDataRef ?? null;
  const periodo = matrizPeriodo ?? (fundoDtposicao ? `${fundoDtposicao.slice(4, 6)}/${fundoDtposicao.slice(0, 4)}` : "");
  const periodoExibicao = periodo || "-";

  const xmlPLRaw = calculoData?.totalPL ?? walletData?.find((r: any) => r.fundo_patliq != null && r.fundo_patliq > 0)?.fundo_patliq ?? 0;
  const totalPL = (() => {
    if (csvPL && csvPL > 0 && xmlPLRaw > 0) {
      const diff = Math.abs(xmlPLRaw - csvPL) / Math.max(xmlPLRaw, csvPL);
      if (diff > 0.05) return csvPL;
    }
    return xmlPLRaw;
  })();
  const isFundoFechado = calculoData?.isFundoFechado ?? false;
  const fundoFechadoAnaliseRaw = calculoData?.fundoFechadoAnalise ?? null;
  const darfAbertoAnalise = calculoData?.darfAberto ?? null;

  // Thresholds de disponibilidade para fundo fechado (configuráveis pelo usuário)
  const fechadoHardThreshold = fechadoHardOverride !== "" && !isNaN(Number(fechadoHardOverride))
    ? Number(fechadoHardOverride) / 100
    : 0.02;
  const fechadoSoftThreshold = fechadoSoftOverride !== "" && !isNaN(Number(fechadoSoftOverride))
    ? Number(fechadoSoftOverride) / 100
    : 0.03;

  // Re-deriva status de amortização com os limiares efetivos.
  // IMPORTANTE: useMemo garante referência estável → evita loop infinito no useEffect abaixo
  // que depende de fundoFechadoAnalise como dependência.
  const fundoFechadoAnalise = useMemo(() => {
    if (!fundoFechadoAnaliseRaw) return null;

    // Recalcula dispPL usando PL do CSV quando diverge >5% do XML
    let dispPL = fundoFechadoAnaliseRaw.dispPL;
    if (csvPL && csvPL > 0 && fundoFechadoAnaliseRaw.pl > 0) {
      const diff = Math.abs(fundoFechadoAnaliseRaw.pl - csvPL) / Math.max(fundoFechadoAnaliseRaw.pl, csvPL);
      if (diff > 0.05 && fundoFechadoAnaliseRaw.disponibilidade != null) {
        dispPL = fundoFechadoAnaliseRaw.disponibilidade / csvPL;
      }
    }

    return {
      ...fundoFechadoAnaliseRaw,
      dispPL,
      status: (dispPL >= fechadoSoftThreshold
        ? "ok"
        : dispPL >= fechadoHardThreshold
        ? "alerta"
        : "violacao") as "ok" | "alerta" | "violacao",
    };
  }, [fundoFechadoAnaliseRaw, fechadoSoftThreshold, fechadoHardThreshold, csvPL]);
  const tabelaVertices = calculoData?.tabelaVertices ?? [];
  const mainFundChar = calculoData?.mainFundChar ?? null;

  // Thresholds efetivos: usa override do usuário ou calcula automaticamente pelo prazo do fundo
  const prazoFundoPrincipal = mainFundChar?.prazo_pagamento_resgate_dias ?? 0;
  const autoSoftThreshold = prazoFundoPrincipal <= 60 ? 1.2 : prazoFundoPrincipal <= 126 ? 1.1 : 1.05;
  const effectiveHardThreshold = hardLimitOverride !== "" && !isNaN(Number(hardLimitOverride))
    ? Number(hardLimitOverride) / 100
    : 1.0;
  const effectiveSoftThreshold = softLimitOverride !== "" && !isNaN(Number(softLimitOverride))
    ? Number(softLimitOverride) / 100
    : autoSoftThreshold;

  // Re-aplica status usando os thresholds efetivos (sem nova chamada à API)
  const tabelaVerticesComLimites = useMemo((): VerticeRow[] =>
    tabelaVertices.map((r) => {
      let s = getConsolidatedStatus(r.indice, r.indiceAcumulado, effectiveHardThreshold, effectiveSoftThreshold);
      // Antes do prazo do fundo: HARD não é permitido — gestor ainda tem tempo de agir.
      if (s === "violacao" && prazoFundoPrincipal > 0 && r.vertice < prazoFundoPrincipal) {
        s = "alerta";
      }
      return { ...r, status: s, estadoAcumulado: s, statusConsolidado: s };
    }),
  [tabelaVertices, effectiveHardThreshold, effectiveSoftThreshold, prazoFundoPrincipal]);
  const ativosComPrazoMap = useMemo(() => {
    const m = new Map<string, { prazos_em_dias: number | null; vertice: number }>();
    (calculoData?.ativosComPrazo ?? []).forEach((a) => m.set(a.id, { prazos_em_dias: a.prazos_em_dias, vertice: a.vertice }));
    return m;
  }, [calculoData?.ativosComPrazo]);

  const top5Cotas = useMemo(() => {
    if (!walletData) return [];
    return walletData
      .filter((a: any) => (a.section || "").toLowerCase() === "cotas" && (a.valor_padrao || 0) > 0)
      .slice(0, 5)
      .map((a: any) => ({
        nome: a.nome_comercial_ativo || a.cnpjfundo || "Cota",
        valor: a.valor_padrao || 0,
        perc: totalPL > 0 ? ((a.valor_padrao || 0) / totalPL) * 100 : 0,
      }));
  }, [walletData, totalPL]);

  const fundName = walletData?.[0]?.nome_fundo || walletData?.[0]?.fundo_nome || "";

  // Resgates solicitados para o fundo — usados na aba Excel
  // Apenas resgates ainda não pagos: data_impacto >= data da posição do fundo
  const dataIsoMinResgates = fundoDtposicao
    ? `${fundoDtposicao.slice(0, 4)}-${fundoDtposicao.slice(4, 6)}-${fundoDtposicao.slice(6, 8)}`
    : new Date().toISOString().slice(0, 10);

  const { data: resgatesExportData = [] } = useQuery({
    // dataIsoMinResgates na chave garante refetch quando a data muda (evita cache stale sem filtro)
    queryKey: ["resgates-export", fundoCnpj, fundName, dataIsoMinResgates],
    enabled: (!!fundoCnpj || !!fundName) && !!fundoDtposicao,
    queryFn: async () => {
      const cnpjClean = (fundoCnpj || "").replace(/\D/g, "");
      const cnpjFormatted = cnpjClean.length === 14
        ? cnpjClean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
        : "";

      const queries: Promise<any>[] = [];
      if (cnpjClean) {
        queries.push(
          supabase
            .from("resgates_movimentacoes" as any)
            .select("fundo, cotista, data_impacto, valor, tipo_movimento, dias_ate_pagamento")
            .eq("fundo_cnpj", cnpjClean)
            .gte("data_impacto", dataIsoMinResgates)
            .order("data_impacto", { ascending: true }),
          supabase
            .from("resgates_movimentacoes" as any)
            .select("fundo, cotista, data_impacto, valor, tipo_movimento, dias_ate_pagamento")
            .eq("fundo_cnpj", cnpjFormatted)
            .gte("data_impacto", dataIsoMinResgates)
            .order("data_impacto", { ascending: true }),
        );
      }
      if (fundName) {
        queries.push(
          supabase
            .from("resgates_movimentacoes" as any)
            .select("fundo, cotista, data_impacto, valor, tipo_movimento, dias_ate_pagamento")
            .ilike("fundo", `%${fundName.slice(0, 20)}%`)
            .gte("data_impacto", dataIsoMinResgates)
            .order("data_impacto", { ascending: true }),
        );
      }

      const results = await Promise.all(queries);
      const seen = new Set<string>();
      const merged: ExportResgateRow[] = [];
      for (const res of results) {
        for (const r of (res.data || [])) {
          const key = `${r.fundo}|${r.cotista}|${r.data_impacto}|${r.valor}`;
          if (!seen.has(key)) { seen.add(key); merged.push(r as ExportResgateRow); }
        }
      }
      // Filtro client-side como garantia extra contra cache ou diferenças de tipo no banco
      return merged
        .filter((r) => !r.data_impacto || r.data_impacto >= dataIsoMinResgates)
        .sort((a, b) => a.data_impacto.localeCompare(b.data_impacto));
    },
  });

  const { data: passivoBundle } = useQuery({
    queryKey: ["passivo-cotistas", fundoCnpj, fundoIsinNorm, fundName, fundoDtposicao],
    enabled: !!fundoDtposicao && (!!fundoCnpj || !!fundName),
    queryFn: async () => {
      const empty = () => ({
        topCotistas: [] as { cotista: string; valor: number; codigo_clt?: number | null }[],
        plCotistasTotal: 0,
        passivoDataPosicao: "",
        passivoAdministradora: null as string | null,
      });

      type PassivoRow = PassivoFundoRow & { cotista: string; valor: number };
      const PASSIVO_SELECT =
        "fundo, fundo_cnpj, fundo_isin, cotista, valor, codigo_clt, administradora, data_posicao";

      const aggregateCotistas = (rows: PassivoRow[]) => aggregatePassivoCotistas(rows).slice(0, 10);

      /** PL cotistas do fundo (soma de todas as linhas do passivo), mesmo denominador do resumo em Passivo Fundos */
      const sumValorRows = (rows: PassivoRow[]) =>
        rows.reduce((s, r) => s + (Number(r.valor) || 0), 0);

      const pack = (rows: PassivoRow[]) => ({
        topCotistas: aggregateCotistas(rows),
        plCotistasTotal: sumValorRows(rows),
        passivoDataPosicao: rows.reduce(
          (max, r) => {
            const d = String(r.data_posicao ?? "");
            return d > max ? d : max;
          },
          "",
        ),
        passivoAdministradora: rows[0]?.administradora ?? null,
      });

      const filterOpts = { cnpj: fundoCnpj, isin: fundoIsinNorm, fundName };

      const cnpjClean = (fundoCnpj || "").replace(/\D/g, "");
      const cnpjFormatted =
        cnpjClean.length === 14
          ? cnpjClean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
          : "";

      const mergeUniqueRows = (...lists: (PassivoRow[] | null | undefined)[]): PassivoRow[] => {
        const seen = new Set<string>();
        const out: PassivoRow[] = [];
        for (const list of lists) {
          for (const r of list || []) {
            const key = [
              r.administradora,
              r.data_posicao,
              r.fundo,
              r.fundo_cnpj,
              r.fundo_isin,
              r.cotista,
              r.codigo_clt,
              r.valor,
            ].join("\0");
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(r);
          }
        }
        return out;
      };

      const fetchByCnpj = async (cnpj: string) => {
        const { data, error } = await supabase
          .from("passivo_fundos")
          .select(PASSIVO_SELECT)
          .eq("fundo_cnpj", cnpj)
          .order("data_posicao", { ascending: false })
          .limit(50000);
        if (error) throw error;
        return (data || []) as PassivoRow[];
      };

      let rawRows: PassivoRow[] = [];
      if (cnpjClean) {
        rawRows = mergeUniqueRows(
          await fetchByCnpj(cnpjClean),
          cnpjFormatted ? await fetchByCnpj(cnpjFormatted) : [],
        );
      } else if (fundName) {
        const { data, error } = await supabase
          .from("passivo_fundos")
          .select(PASSIVO_SELECT)
          .order("data_posicao", { ascending: false })
          .limit(100000);
        if (error) throw error;
        rawRows = (data || []) as PassivoRow[];
      }

      if (rawRows.length === 0) return empty();

      // Mesma regra da aba Passivo Fundos ("Mais recente por fundo") — sem cortar na data base da carteira
      const deduped = resolvePassivoRowsForFundDetail(rawRows, filterOpts) as PassivoRow[];
      if (deduped.length === 0) return empty();

      return pack(deduped);
    },
  });

  const passivoTop = passivoBundle?.topCotistas ?? [];
  const plCotistasTotal = passivoBundle?.plCotistasTotal ?? 0;
  const passivoDataPosicao = passivoBundle?.passivoDataPosicao ?? "";
  const passivoAdministradora = passivoBundle?.passivoAdministradora ?? null;

  const passivoDataPosicaoFmt = useMemo(() => {
    if (!passivoDataPosicao || passivoDataPosicao.length < 8) return "";
    return `${passivoDataPosicao.slice(6, 8)}/${passivoDataPosicao.slice(4, 6)}/${passivoDataPosicao.slice(0, 4)}`;
  }, [passivoDataPosicao]);

  const top5Cotistas = useMemo((): { nome: string; valor: number; perc: number; codigo_clt?: number | null }[] => {
    if (!passivoTop.length || plCotistasTotal <= 0) return [];
    return passivoTop.slice(0, 5).map((c) => ({
      nome: c.cotista,
      valor: c.valor,
      perc: (c.valor / plCotistasTotal) * 100,
      codigo_clt: c.codigo_clt,
    }));
  }, [passivoTop, plCotistasTotal]);

  /** Resultado do cálculo de choque (sempre computado, independente do toggle). */
  const liquidezStressChoque = useMemo(
    () => computeLiquidezStressChoque(
      calculoData?.totalPL ?? 0,
      passivoTop.slice(0, 3).map((c) => c.valor),
    ),
    [calculoData?.totalPL, passivoTop],
  );

  /** Tabela com stress aplicado apenas na linha do prazo do fundo. */
  const tabelaVerticesComStress = useMemo((): VerticeRow[] => {
    const prazoFundo = mainFundChar?.prazo_pagamento_resgate_dias ?? null;
    if (prazoFundo == null || tabelaVerticesComLimites.length === 0) return tabelaVerticesComLimites;

    const prazoRow = tabelaVerticesComLimites.find((r) => r.vertice === prazoFundo);
    if (!prazoRow) return tabelaVerticesComLimites;

    const { choque } = liquidezStressChoque;
    if (choque <= 0) return tabelaVerticesComLimites;

    return tabelaVerticesComLimites.map((r) => {
      if (r.vertice !== prazoFundo) return r;

      const passivoEfetivoBase = (r.resgatesSolicitados ?? 0) > 0 ? r.resgatesSolicitados! : r.passivoNoVertice;
      const passivoNoVerticeNew = passivoEfetivoBase + choque;
      const passivoAcumuladoNew = r.passivoAcumulado + choque;
      const indiceNew = passivoNoVerticeNew > 0 ? Math.abs(r.ativoAcumulado / passivoNoVerticeNew) : 100;
      const indiceAcumuladoNew = passivoAcumuladoNew > 0 ? r.ativoAcumulado / passivoAcumuladoNew : 100;
      const statusConsolidadoNew = getConsolidatedStatus(indiceNew, indiceAcumuladoNew, effectiveHardThreshold, effectiveSoftThreshold);

      return {
        ...r,
        passivoNoVertice: passivoNoVerticeNew,
        passivoAcumulado: passivoAcumuladoNew,
        indice: indiceNew,
        indiceAcumulado: indiceAcumuladoNew,
        status: statusConsolidadoNew,
        estadoAcumulado: statusConsolidadoNew,
        statusConsolidado: statusConsolidadoNew,
      };
    });
  }, [tabelaVerticesComLimites, mainFundChar?.prazo_pagamento_resgate_dias, liquidezStressChoque, effectiveHardThreshold, effectiveSoftThreshold]);

  const verticesParaExibir = stressAtivo ? tabelaVerticesComStress : tabelaVerticesComLimites;

  const assets: Asset[] = useMemo(
    () =>
      (walletData || []).map((a: any) => {
        const prazoInfo = ativosComPrazoMap.get(a.id);
        return {
          id: a.id,
          cnpjfundo: a.cnpjfundo,
          cnpjemissor: a.cnpjemissor,
          isin: a.isin,
          codativo: a.codativo,
          nome_comercial_ativo: a.nome_comercial_ativo,
          section: a.section,
          qtdisponivel: a.qtdisponivel ?? 0,
          puposicao: a.puposicao ?? 0,
          valor_padrao: a.valor_padrao ?? 0,
          prazo_pagamento_resgate_dias: a.prazo_pagamento_resgate_dias,
          prazos_em_dias: prazoInfo?.prazos_em_dias ?? undefined,
          vertice: prazoInfo?.vertice ?? undefined,
          credeb: a.credeb,
          validado: a.validado,
        };
      }),
    [walletData, ativosComPrazoMap]
  );

  const indiceMinimo = calculoData?.indiceMinimo ?? 1;
  const indiceAtual = useMemo(() => {
    const v = mainFundChar?.prazo_pagamento_resgate_dias;
    if (v == null) return tabelaVertices[tabelaVertices.length - 1]?.indiceAcumulado ?? 1;
    const row = tabelaVertices.find((r) => r.vertice === v);
    return row?.indiceAcumulado ?? tabelaVertices[tabelaVertices.length - 1]?.indiceAcumulado ?? 1;
  }, [tabelaVertices, mainFundChar?.prazo_pagamento_resgate_dias]);

  const ativosPieData = useMemo(() => {
    const sec = (s: string) => (s || "").toLowerCase();
    const bySection = (walletData || []).reduce((acc: Record<string, number>, a: any) => {
      const s = sec(a.section);
      if (!["despesas", "provisao"].includes(s)) acc[s] = (acc[s] || 0) + (a.valor_padrao ?? 0);
      return acc;
    }, {});
    const labels: Record<string, string> = {
      cotas: "Cotas",
      titpublico: "Títulos Públicos",
      titprivado: "Títulos Privados",
      caixa: "Caixa",
      acoes: "Ações",
      participacoes: "Participações",
      fidc: "FIDC",
      imoveis: "Imóveis",
    };
    return Object.entries(bySection)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({ name: labels[k] || k, value: v }))
      .sort((a, b) => b.value - a.value);
  }, [walletData]);

  useEffect(() => {
    if (!onStatusChange) return;
    if (isFundoFechado && fundoFechadoAnalise) {
      const cs = fundoFechadoAnalise.statusCoberturaDespesa ?? "indisponivel";
      onStatusChange(
        cs === "ok" || cs === "alerta" || cs === "violacao" ? cs : "pendente"
      );
      return;
    }
    if (tabelaVerticesComLimites.length === 0) return;

    const prazoFundo = mainFundChar?.prazo_pagamento_resgate_dias;

    // Usa apenas o status do vértice do prazo do fundo (sem "contaminação" de vértices intermediários),
    // consistente com o comportamento da lista de monitoramento após RECALCULAR.
    if (prazoFundo != null) {
      const prazoRow = tabelaVerticesComLimites.find((r) => r.vertice === prazoFundo)
        ?? tabelaVerticesComLimites.find((r) => r.vertice >= prazoFundo);
      if (prazoRow) {
        onStatusChange(prazoRow.statusConsolidado);
        return;
      }
    }

    // Fallback quando não há vértice com prazo definido: usa o pior status de todos
    let worst: "ok" | "alerta" | "violacao" = "ok";
    for (const r of tabelaVerticesComLimites) {
      if (r.statusConsolidado === "violacao") { worst = "violacao"; break; }
      if (r.statusConsolidado === "alerta") worst = "alerta";
    }
    onStatusChange(worst);
  }, [tabelaVerticesComLimites, fundoFechadoAnalise, isFundoFechado, onStatusChange, mainFundChar?.prazo_pagamento_resgate_dias]);

  // ── Export handlers (PDF + Excel) ────────────────────────────
  const buildExportInfo = useCallback(() => {
    const nomeFundo =
      (walletData?.[0] as any)?.nome_fundo ||
      (walletData?.[0] as any)?.fundo_nome || "Fundo";
    const cnpjFormatado = fundoCnpj.replace(
      /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
      "$1.$2.$3/$4-$5"
    );
    const dateObj = parse(fundoDtposicao, "yyyyMMdd", new Date());
    const dataBase = format(dateObj, "dd/MM/yyyy");
    const administrador = (walletData?.[0] as any)?.fundo_nomeadm || "—";
    const tipo = isFundoFechado ? "Fechado" : "Aberto";

    let worstStatus: "ok" | "alerta" | "violacao" = "ok";
    if (isFundoFechado && fundoFechadoAnalise) {
      const cs = fundoFechadoAnalise.statusCoberturaDespesa ?? "indisponivel";
      if (cs === "ok" || cs === "alerta" || cs === "violacao") worstStatus = cs;
    } else {
      const prazoFundo = mainFundChar?.prazo_pagamento_resgate_dias;
      const rel = prazoFundo != null
        ? tabelaVerticesComLimites.filter((r) => r.vertice <= prazoFundo)
        : tabelaVerticesComLimites;
      for (const r of rel) {
        if (r.statusConsolidado === "violacao") { worstStatus = "violacao"; break; }
        if (r.statusConsolidado === "alerta") worstStatus = "alerta";
      }
    }

    const fechadoExport = isFundoFechado && fundoFechadoAnalise ? {
      dispPL: fundoFechadoAnalise.dispPL,
      disponibilidade: fundoFechadoAnalise.disponibilidade,
      prazoResgate: fundoFechadoAnalise.prazoResgate ?? mainFundChar?.prazo_pagamento_resgate_dias ?? null,
      status: fundoFechadoAnalise.status,
      mesesCobertura: fundoFechadoAnalise.mesesCobertura ?? null,
      caixaLiquido: fundoFechadoAnalise.caixaLiquido ?? 0,
      darfEstimado: fundoFechadoAnalise.darfEstimado ?? 0,
      despesaOperacionalMensal: fundoFechadoAnalise.despesaOperacionalMensal ?? null,
      statusCoberturaDespesa: (fundoFechadoAnalise.statusCoberturaDespesa ?? "indisponivel") as "ok" | "alerta" | "violacao" | "indisponivel",
      hardThreshold: fechadoHardThreshold,
      softThreshold: fechadoSoftThreshold,
    } : null;

    return {
      nomeFundo,
      cnpj: cnpjFormatado,
      dataBase,
      administrador,
      tipo,
      pl: totalPL,
      prazoResgate: mainFundChar?.prazo_pagamento_resgate_dias ?? null,
      worstStatus,
      classe,
      segmento,
      metrica,
      fundoFechadoAnalise: fechadoExport,
    };
  }, [
    walletData, fundoCnpj, fundoDtposicao, isFundoFechado, fundoFechadoAnalise,
    mainFundChar, tabelaVertices, totalPL, classe, segmento, metrica,
    fechadoHardThreshold, fechadoSoftThreshold,
  ]);

  /** Informações de stress para passar ao export Excel. */
  const buildStressExportInfo = useCallback(() => {
    const prazo = mainFundChar?.prazo_pagamento_resgate_dias ?? null;
    if (prazo == null || liquidezStressChoque.choque <= 0) return null;
    const prazoRow = tabelaVerticesComLimites.find((r) => r.vertice === prazo);
    if (!prazoRow) return null;
    const passivoBase = (prazoRow.resgatesSolicitados ?? 0) > 0
      ? prazoRow.resgatesSolicitados!
      : prazoRow.passivoNoVertice;
    const passivoStress = passivoBase + liquidezStressChoque.choque;
    const indiceStress = passivoStress > 0
      ? Math.abs(prazoRow.ativoAcumulado / passivoStress)
      : 100;
    return {
      choque: liquidezStressChoque.choque,
      piso20: liquidezStressChoque.piso20,
      somaCotistasTop3: liquidezStressChoque.somaCotistasTop3,
      nCotistasTop3: liquidezStressChoque.nCotistasTop3,
      binding: liquidezStressChoque.binding,
      prazoVertice: prazo,
      passivoSemStress: passivoBase,
      passivoComStress: passivoStress,
      indiceComStress: indiceStress,
    };
  }, [mainFundChar, liquidezStressChoque, tabelaVerticesComLimites]);

  const buildWalletExport = useCallback(() =>
    assets.map((a) => ({
      section: a.section || "—",
      nome: a.nome_comercial_ativo || a.cnpjfundo || a.cnpjemissor || "—",
      cnpj: a.cnpjfundo || a.cnpjemissor || null,
      valor: a.valor_padrao || 0,
      prazo_dias: a.prazos_em_dias ?? null,
      vertice: a.vertice ?? null,
      validado: a.validado,
    })),
  [assets]);

  useEffect(() => {
    if (!calculoData || !walletData || walletData.length === 0) return;
    if (!onExportHandlersReady) return;

    const handlers: ExportHandlers = {
      exportPdf: async () => {
        const info = buildExportInfo();
        const walletExp = buildWalletExport();
        const stressInfo = buildStressExportInfo();
        await exportFundoDetalhesPdf(
          info,
          verticesParaExibir,
          walletExp,
          stressInfo ?? undefined,
          ignorarResgates,
          effectiveHardThreshold,
          effectiveSoftThreshold
        );
      },
      exportExcel: async () => {
        const info = buildExportInfo();
        const walletExp = buildWalletExport();
        const stressInfo = buildStressExportInfo();
        // Quando "Ignorar Resgates" está ativo, a aba de resgates não é gerada
        const resgatesParaExport = ignorarResgates ? undefined : resgatesExportData;
        await exportFundoDetalhesExcel(info, verticesParaExibir, walletExp, resgatesParaExport, stressInfo ?? undefined);
      },
    };
    onExportHandlersReady(handlers);
  }, [
    calculoData, walletData, verticesParaExibir, resgatesExportData, ignorarResgates,
    buildExportInfo, buildWalletExport, onExportHandlersReady, buildStressExportInfo,
    effectiveHardThreshold, effectiveSoftThreshold,
  ]);

  const { data: timelineDataRaw = [] } = useQuery({
    queryKey: ["liquidez-timeline", fundoCnpj, fundoIsinNorm],
    enabled: !!fundoCnpj,
    staleTime: 30_000,
    queryFn: () => fetchLiquidezTimelineData(fundoCnpj, fundoIsinNorm),
  });

  const liveTimelineStatus = useMemo((): "ok" | "alerta" | "violacao" | null => {
    if (!calculoData) return null;
    if (isFundoFechado && fundoFechadoAnalise) {
      const cs = fundoFechadoAnalise.statusCoberturaDespesa ?? "indisponivel";
      if (cs === "ok" || cs === "alerta" || cs === "violacao") return cs;
      return null;
    }
    if (tabelaVerticesComLimites.length === 0) return null;

    const prazoFundo = mainFundChar?.prazo_pagamento_resgate_dias;
    if (prazoFundo != null) {
      const prazoRow = tabelaVerticesComLimites.find((r) => r.vertice === prazoFundo)
        ?? tabelaVerticesComLimites.find((r) => r.vertice >= prazoFundo);
      if (prazoRow) return prazoRow.statusConsolidado;
    }

    let worst: "ok" | "alerta" | "violacao" = "ok";
    for (const r of tabelaVerticesComLimites) {
      if (r.statusConsolidado === "violacao") return "violacao";
      if (r.statusConsolidado === "alerta") worst = "alerta";
    }
    return worst;
  }, [calculoData, isFundoFechado, fundoFechadoAnalise, tabelaVerticesComLimites, mainFundChar?.prazo_pagamento_resgate_dias]);

  const timelineData = useMemo(
    () => mergeLiquidezTimelineStatus(timelineDataRaw, fundoDtposicao, liveTimelineStatus),
    [timelineDataRaw, fundoDtposicao, liveTimelineStatus],
  );

  const isLoading = walletLoading || calculoLoading;
  const isError = walletError || calculoError;

  if (isLoading)
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Carregando dados de liquidez...</p>
      </div>
    );

  if (isError)
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-4 text-center p-8 border border-dashed rounded-lg">
        <AlertTriangle className="h-12 w-12 text-red-500" />
        <h3 className="text-lg font-bold">Erro ao carregar dados</h3>
        <p className="text-sm text-muted-foreground max-w-md">
          Ocorreu um erro ao buscar as informações do fundo. Por favor, verifique sua conexão e tente novamente.
          <br />
          <span className="text-[10px] mt-2 block opacity-50">{(queryError as any)?.message}</span>
        </p>
        <Button onClick={() => window.location.reload()} variant="outline" size="sm">
          Recarregar Página
        </Button>
      </div>
    );

  if (!walletData || walletData.length === 0)
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-4 text-center p-8 border border-dashed rounded-lg">
        <Users className="h-12 w-12 text-muted-foreground/40" />
        <h3 className="text-lg font-bold text-muted-foreground">Nenhum dado encontrado</h3>
        <p className="text-sm text-muted-foreground max-w-md">
          Não foram encontrados dados de posição para este fundo na data selecionada ({fundoDtposicao}).
        </p>
      </div>
    );

  return (
    <div className="w-full min-w-0 max-w-full space-y-8 p-3 sm:p-4 bg-muted/5 rounded-lg border border-border/40">
      {/* ── Barra de parâmetros: diferente para aberto vs fechado ── */}
      {!isFundoFechado && (
        /* Fundo aberto: parâmetros da Matriz ANBIMA */
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end p-3 bg-muted/20 border rounded-lg mb-6 min-w-0">
          <div className="flex items-center gap-2 px-0 sm:px-2 sm:border-r sm:border-border/50 sm:mr-2 pb-0 sm:pb-0">
            <div className="p-1.5 rounded-md bg-primary/10 text-primary shrink-0">
              <Settings2 className="w-4 h-4" />
            </div>
            <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Parâmetros da Matriz
            </span>
          </div>

          <div className="flex flex-wrap items-end gap-3 min-w-0 flex-1">
            <div className="space-y-0.5 min-w-0 w-full sm:w-[180px] sm:min-w-[160px]">
              <label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground px-1">Classe</label>
              <Select value={classe} onValueChange={setClasse}>
                <SelectTrigger className="w-full h-10 text-xs font-medium bg-background shadow-sm border-muted-foreground/20 hover:border-primary/50 focus:ring-primary/20 transition-all">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLASSES.map((c) => (
                    <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-0.5 min-w-0 w-full sm:w-[160px] sm:min-w-[140px]">
              <label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground px-1">Segmento</label>
              <Select value={segmento} onValueChange={setSegmento}>
                <SelectTrigger className="w-full h-10 text-xs font-medium bg-background shadow-sm border-muted-foreground/20 hover:border-primary/50 focus:ring-primary/20 transition-all">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEGMENTOS.map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-0.5 min-w-0 w-full sm:w-[160px] sm:min-w-[140px]">
              <label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground px-1">Métrica</label>
              <Select value={metrica} onValueChange={setMetrica}>
                <SelectTrigger className="w-full h-10 text-xs font-medium bg-background shadow-sm border-muted-foreground/20 hover:border-primary/50 focus:ring-primary/20 transition-all">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METRICAS.map((m) => (
                    <SelectItem key={m} value={m} className="text-xs">{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="hidden sm:block w-px h-8 bg-border/60 mx-1 self-end mb-1 shrink-0" />

            <div className="space-y-0.5">
              <label className="text-[9px] font-bold uppercase tracking-wider text-red-500 px-1 flex items-center gap-1">
                Hard Limit
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="w-2.5 h-2.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[220px] text-[11px]">
                      Índice mínimo de cobertura. Abaixo deste valor o status é HARD LIMIT. Padrão: 100% (índice ≤ 1,0 = ativos cobrem menos do que o passivo esperado).
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </label>
              <div className="relative">
                <Input
                  type="number" min={0} max={200} step={1}
                  value={hardLimitOverride}
                  onChange={(e) => setHardLimitOverride(e.target.value)}
                  placeholder="100"
                  className="w-[90px] h-10 text-xs font-medium bg-background shadow-sm border-red-200 hover:border-red-400 focus-visible:ring-red-200 pr-7 transition-all"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-bold text-muted-foreground pointer-events-none">%</span>
              </div>
            </div>

            <div className="space-y-0.5">
              <label className="text-[9px] font-bold uppercase tracking-wider text-amber-600 px-1 flex items-center gap-1">
                Soft Limit
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="w-2.5 h-2.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[240px] text-[11px]">
                      Buffer mínimo de cobertura acima do Hard Limit. Abaixo deste valor o status é SOFT LIMIT. Padrão automático pelo prazo do fundo: ≤60d → 120% · ≤126d → 110% · &gt;126d → 105%.
                      {prazoFundoPrincipal > 0 && (
                        <span className="block mt-1 font-semibold">Auto atual: {(autoSoftThreshold * 100).toFixed(0)}% (prazo D+{prazoFundoPrincipal})</span>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </label>
              <div className="relative">
                <Input
                  type="number" min={100} max={300} step={1}
                  value={softLimitOverride}
                  onChange={(e) => setSoftLimitOverride(e.target.value)}
                  placeholder={prazoFundoPrincipal > 0 ? String((autoSoftThreshold * 100).toFixed(0)) : "105"}
                  className="w-[90px] h-10 text-xs font-medium bg-background shadow-sm border-amber-200 hover:border-amber-400 focus-visible:ring-amber-200 pr-7 transition-all"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-bold text-muted-foreground pointer-events-none">%</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {!isFundoFechado && (
        <Collapsible open={isVerticesOpen} onOpenChange={setIsVerticesOpen} className="space-y-2">
          <Card className={cn("transition-all duration-200", !isVerticesOpen && "border-none shadow-none bg-transparent")}>
            <CardHeader className="py-3 px-3 sm:px-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0 bg-muted/30 rounded-lg min-w-0">
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div className="flex items-start gap-2 min-w-0">
                  <div className={cn("p-2 rounded-full bg-primary/10 text-primary transition-colors shrink-0", isVerticesOpen && "bg-primary text-primary-foreground")}>
                    <TrendingUp className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="text-sm font-medium">Análise Vértice a Vértice</CardTitle>
                    <CardDescription className="text-[10px] mt-0.5 break-words">
                      Matriz de Probabilidade • {periodoExibicao}
                      {matrizDataRef && (
                        <span className="text-muted-foreground ml-1">
                          (ref. {matrizDataRef.split("-").reverse().join("/")})
                        </span>
                      )}
                      {stressAtivo && (
                        <span className="ml-0 sm:ml-2 text-amber-600 font-medium block sm:inline">
                          • Stress ativo — choque de {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(liquidezStressChoque.choque)} (20% PL{liquidezStressChoque.binding === "cap20" ? ` · top 3 cotistas excediam o teto` : ""}) somado ao vértice D+{mainFundChar?.prazo_pagamento_resgate_dias}
                        </span>
                      )}
                      {ignorarResgates && (
                        <span className="ml-0 sm:ml-2 text-slate-500 font-medium block sm:inline">
                          • Resgates solicitados ignorados
                        </span>
                      )}
                    </CardDescription>
                  </div>
                </div>
                {!isVerticesOpen && (
                  <div className="flex items-center gap-2 sm:ml-4">
                    {verticesParaExibir.some((r) => r.statusConsolidado === "violacao") ? (
                      <Badge variant="destructive" className="h-5 text-[10px] px-2 gap-1">
                        <XCircle className="w-3 h-3" /> HARD LIMIT
                      </Badge>
                    ) : verticesParaExibir.some((r) => r.statusConsolidado === "alerta") ? (
                      <Badge variant="secondary" className="h-5 text-[10px] px-2 gap-1 bg-amber-100 text-amber-700 hover:bg-amber-200">
                        <AlertTriangle className="w-3 h-3" /> SOFT LIMIT
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="h-5 text-[10px] px-2 gap-1 text-emerald-600 border-emerald-200 bg-emerald-50">
                        <CheckCircle2 className="w-3 h-3" /> OK
                      </Badge>
                    )}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 shrink-0 w-full sm:w-auto">
                <Button
                  variant={ignorarResgates ? "default" : "outline"}
                  size="sm"
                  className={cn(
                    "h-8 gap-1.5 text-[10px] font-bold uppercase",
                    ignorarResgates && "bg-slate-600 hover:bg-slate-700 text-white"
                  )}
                  onClick={() => setIgnorarResgates((prev) => !prev)}
                  title="Ignorar resgates solicitados no cálculo (sem excluir do banco)"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                  Ignorar Resgates
                </Button>
                <Button
                  variant={stressAtivo ? "default" : "outline"}
                  size="sm"
                  className={cn(
                    "h-8 gap-1.5 text-[10px] font-bold uppercase",
                    stressAtivo && "bg-amber-600 hover:bg-amber-700 text-white"
                  )}
                  onClick={() => setStressAtivo((prev) => !prev)}
                  title="MAX(20% PL, soma top N cotistas até cobrir 20% PL, N≤5) somado ao vértice do prazo"
                >
                  <Zap className="h-3.5 w-3.5" />
                  Stress
                </Button>
                {mainFundChar?.prazo_pagamento_resgate_dias != null && (
                  <Badge variant="outline" className="text-[10px] text-blue-600 border-blue-300 h-5 max-w-full truncate">
                    Prazo fundo: D+{mainFundChar.prazo_pagamento_resgate_dias}
                  </Badge>
                )}
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 hover:bg-muted-foreground/10 shrink-0">
                    {isVerticesOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                  </Button>
                </CollapsibleTrigger>
              </div>
            </CardHeader>
            <CollapsibleContent>
              <CardContent className="pt-0 pb-4 px-2 sm:px-4 min-w-0">
                <div className="mt-4 rounded-md border bg-background min-w-0 max-w-full">
                  <Table containerClassName="max-h-[350px]">
                    <TableHeader className="[&_tr]:bg-background">
                        <TableRow className="h-8 hover:bg-transparent">
                          <TableHead rowSpan={2} className="sticky top-0 z-20 bg-background text-[10px] font-bold uppercase h-8">Vértice</TableHead>
                          <TableHead rowSpan={2} className="sticky top-0 z-20 bg-background text-right text-[10px] font-bold uppercase h-8">Ativo</TableHead>
                          <TableHead rowSpan={2} className="sticky top-0 z-20 bg-background text-right text-[10px] font-bold uppercase h-8">Ativo Acum.</TableHead>
                          <TableHead rowSpan={2} className="sticky top-0 z-20 bg-background text-right text-[10px] font-bold uppercase h-8">
                            <TooltipProvider delayDuration={200}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex items-center gap-1 cursor-help">
                                    Resg. Ativos <Info className="w-3 h-3 text-muted-foreground" />
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="max-w-[280px] text-[11px] font-normal normal-case">
                                  <p className="font-semibold mb-1">Resgates Confirmados de Portfólio</p>
                                  <p>Valores de "Resgate de portfólio investido" da planilha CaixaFluxoFinanceiro que chegam neste vértice.</p>
                                  <p className="mt-1 text-muted-foreground">Já incluídos no Ativo. O ativo de origem foi deduzido quando localizado na carteira.</p>
                                  <p className="mt-1 text-amber-600 text-[10px]">Laranja: ativo de origem não localizado — dedução não aplicada.</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </TableHead>
                          <TableHead colSpan={2} className="sticky top-0 z-20 bg-background text-center text-[10px] font-bold uppercase h-8">Prob. Resgate</TableHead>
                          <TableHead rowSpan={2} className="sticky top-0 z-20 bg-background text-right text-[10px] font-bold uppercase h-8">Resgates Solicitados</TableHead>
                          <TableHead rowSpan={2} className="sticky top-0 z-20 bg-background text-right text-[10px] font-bold uppercase h-8">Passivo Acumulado</TableHead>
                          <TableHead rowSpan={2} className="sticky top-0 z-20 bg-background text-right text-[10px] font-bold uppercase h-8">
                            <TooltipProvider delayDuration={200}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex items-center gap-1 cursor-help">
                                    Índice Vértice <Info className="w-3 h-3 text-muted-foreground" />
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="max-w-[280px] text-[11px] font-normal normal-case">
                                  <p className="font-semibold mb-1">Índice Vértice</p>
                                  <p>Ativo Acumulado ÷ Passivo Efetivo do vértice.</p>
                                  <p className="mt-1 font-semibold">Passivo Efetivo:</p>
                                  <ul className="mt-0.5 space-y-0.5">
                                    <li>• Com resgates solicitados → usa <span className="font-semibold">apenas os resgates</span></li>
                                    <li>• Sem resgates → usa <span className="font-semibold">probabilidade ANBIMA × PL</span></li>
                                  </ul>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </TableHead>
                          <TableHead rowSpan={2} className="sticky top-0 z-20 bg-background text-[10px] font-bold uppercase h-8">
                            <TooltipProvider delayDuration={200}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex items-center gap-1 cursor-help">
                                    Status <Info className="w-3 h-3 text-muted-foreground" />
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="max-w-[260px] text-[11px] font-normal normal-case">
                                  <p className="font-semibold mb-1">Status do Índice Vértice</p>
                                  <p>Classificação baseada no Índice Vértice deste ponto isolado:</p>
                                  <ul className="mt-1 space-y-0.5">
                                    <li>≤ Hard Limit → <span className="text-red-600 font-semibold">HARD LIMIT</span></li>
                                    <li>&lt; Soft Limit → <span className="text-amber-600 font-semibold">SOFT LIMIT</span></li>
                                    <li>≥ Soft Limit → <span className="text-emerald-600 font-semibold">OK</span></li>
                                  </ul>
                                  <p className="mt-1 text-muted-foreground">Quando há resgates solicitados, o denominador é o valor real do resgate. Caso contrário, usa a estimativa ANBIMA.</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </TableHead>
                          <TableHead rowSpan={2} className="sticky top-0 z-20 bg-background text-right text-[10px] font-bold uppercase h-8">
                            <TooltipProvider delayDuration={200}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex items-center gap-1 cursor-help">
                                    Índice Acum. <Info className="w-3 h-3 text-muted-foreground" />
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="max-w-[280px] text-[11px] font-normal normal-case">
                                  <p className="font-semibold mb-1">Índice Acumulado</p>
                                  <p>Ativo Acumulado ÷ Passivo Acumulado (soma dos passivos efetivos de D+1 até este vértice).</p>
                                  <p className="mt-1 text-muted-foreground text-[10px]">Passivo acumulado usa resgates reais nos vértices com solicitações, e ANBIMA nos demais.</p>
                                  <p className="mt-1">É o principal indicador de status:</p>
                                  <ul className="mt-1 space-y-0.5">
                                    <li>≤ Hard Limit → <span className="text-red-600 font-semibold">HARD LIMIT</span></li>
                                    <li>&lt; Soft Limit → <span className="text-amber-600 font-semibold">SOFT LIMIT</span></li>
                                    <li>≥ Soft Limit → <span className="text-emerald-600 font-semibold">OK</span></li>
                                  </ul>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </TableHead>
                          <TableHead rowSpan={2} className="sticky top-0 z-20 bg-background text-[10px] font-bold uppercase h-8">
                            <TooltipProvider delayDuration={200}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex items-center gap-1 cursor-help">
                                    Status Acum. <Info className="w-3 h-3 text-muted-foreground" />
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="max-w-[270px] text-[11px] font-normal normal-case">
                                  <p className="font-semibold mb-1">Status do Índice Acumulado</p>
                                  <p>Classificação baseada no Índice Acumulado (Ativo Acum. ÷ Passivo Acum. Efetivo):</p>
                                  <ul className="mt-1 space-y-0.5">
                                    <li>≤ Hard Limit → <span className="text-red-600 font-semibold">HARD LIMIT</span></li>
                                    <li>&lt; Soft Limit → <span className="text-amber-600 font-semibold">SOFT LIMIT</span></li>
                                    <li>≥ Soft Limit → <span className="text-emerald-600 font-semibold">OK</span></li>
                                  </ul>
                                  <p className="mt-1 text-muted-foreground">Onde há resgates solicitados, o passivo usa o valor real; nos demais vértices, usa ANBIMA.</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </TableHead>
                          <TableHead rowSpan={2} className="sticky top-0 z-20 bg-background text-[10px] font-bold uppercase h-8 text-center">Consolidado</TableHead>
                        </TableRow>
                        <TableRow className="h-7 hover:bg-transparent">
                          <TableHead className="sticky top-8 z-20 bg-background text-right text-[9px] font-semibold uppercase h-7">%</TableHead>
                          <TableHead className="sticky top-8 z-20 bg-background text-right text-[9px] font-semibold uppercase h-7">Valor</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {verticesParaExibir.map((r) => (
                          <React.Fragment key={r.vertice}>
                            <TableRow
                              className={cn(
                                "h-9 text-[11px] cursor-pointer hover:bg-muted/50 transition-colors",
                                r.vertice === mainFundChar?.prazo_pagamento_resgate_dias && (
                                  r.statusConsolidado === "ok"
                                    ? "bg-emerald-50"
                                    : r.statusConsolidado === "alerta"
                                    ? "bg-amber-50"
                                    : r.statusConsolidado === "violacao"
                                    ? "bg-red-50"
                                    : "bg-muted/30"
                                )
                              )}
                              onClick={() => setVerticeExpandido((prev) => (prev === r.vertice ? null : r.vertice))}
                            >
                              <TableCell className="font-mono font-bold">
                                <div className="flex items-center gap-1">
                                  <span className={cn("transition-transform", verticeExpandido === r.vertice && "rotate-90")}>
                                    <ChevronRight className="w-3 h-3 text-muted-foreground" />
                                  </span>
                                  <TooltipProvider delayDuration={150}>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className="cursor-help underline decoration-dotted underline-offset-2">
                                          {verticeLabel(r.vertice)}
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent side="bottom" className="max-w-[260px] text-[11px] font-normal normal-case">
                                        <p>
                                          Dias úteis reais: <span className="font-semibold">{verticeDiasUteisReaisLabel(r.vertice)}</span>.
                                        </p>
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                  {r.vertice === mainFundChar?.prazo_pagamento_resgate_dias && (
                                    <Badge variant="outline" className="ml-2 text-[8px] h-4 px-1">Prazo</Badge>
                                  )}
                                  {r.ativosNoVertice.length > 0 && (
                                    <span className="text-[9px] text-muted-foreground ml-1">({r.ativosNoVertice.length})</span>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-right font-mono text-muted-foreground">{formatBRL(r.ativoVertice)}</TableCell>
                              <TableCell className="text-right font-mono text-muted-foreground">{formatBRL(r.ativoAcumulado)}</TableCell>
                              <TableCell className="text-right font-mono">
                                {(r.resgAtivosVertice ?? 0) > 0 ? (
                                  <TooltipProvider delayDuration={200}>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className={cn(
                                          "cursor-help",
                                          (r.resgAtivosWarnings?.length ?? 0) > 0
                                            ? "text-amber-600 font-semibold"
                                            : "text-emerald-700 font-semibold"
                                        )}>
                                          {formatBRL(r.resgAtivosVertice ?? 0)}
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent side="bottom" className="max-w-[300px] text-[11px] font-normal normal-case">
                                        {(r.resgAtivosWarnings?.length ?? 0) > 0 ? (
                                          <>
                                            <p className="font-semibold text-amber-600 mb-1">Ativo de origem não localizado</p>
                                            {r.resgAtivosWarnings!.map((w, i) => (
                                              <p key={i} className="text-[10px]">
                                                "{w.descricao}": {formatBRL(w.valor)} — dedução não aplicada
                                              </p>
                                            ))}
                                          </>
                                        ) : (
                                          <p>Resgate confirmado — ativo de origem deduzido com sucesso.</p>
                                        )}
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                ) : (
                                  <span className="text-muted-foreground">-</span>
                                )}
                              </TableCell>
                              <TableCell className="text-right font-mono text-muted-foreground">{formatPerc(r.probabilidade)}</TableCell>
                              <TableCell className="text-right font-mono text-muted-foreground">{formatBRL(r.passivoNoVertice)}</TableCell>
                              <TableCell className="text-right font-mono text-muted-foreground">
                                {(r.resgatesSolicitados ?? 0) > 0 ? formatBRL(r.resgatesSolicitados!) : "-"}
                              </TableCell>
                              <TableCell className={cn("text-right font-mono", (r.resgatesSolicitados ?? 0) > 0 ? "text-amber-700 font-semibold" : "text-muted-foreground")}>{formatBRL(r.passivoAcumulado)}</TableCell>
                              <TableCell className="text-right font-mono font-bold">{formatIndice(r.indice)}</TableCell>
                              <TableCell><StatusBadge status={r.status} /></TableCell>
                              <TableCell className="text-right font-mono font-bold">{formatIndice(r.indiceAcumulado)}</TableCell>
                              <TableCell><StatusBadge status={r.estadoAcumulado} /></TableCell>
                              <TableCell className="text-center"><StatusBadge status={r.statusConsolidado} /></TableCell>
                            </TableRow>
                            {verticeExpandido === r.vertice && r.ativosNoVertice.length > 0 && (
                              <TableRow ref={expandedRowRef} key={`${r.vertice}-ativos`} className="bg-muted/20 hover:bg-muted/20">
                                <TableCell colSpan={13} className="py-2 px-4">
                                  <div className="text-[10px] space-y-1 pl-6">
                                    <p className="font-medium text-muted-foreground mb-2">Ativos no vértice {verticeLabel(r.vertice)}:</p>
                                    <div className="space-y-1">
                                      {r.ativosNoVertice.map((a, idx) => {
                                        const ltKey = `${r.vertice}-lt-${idx}`;
                                        const ltAberto = lookThroughExpandidoKey === ltKey;
                                        const temLtDrill =
                                          a.fonte === "fip_lookthrough" &&
                                          (((a.look_through_detalhes?.length ?? 0) > 0) || !!a.look_through_resumo);

                                        return (
                                        <div key={idx} className="space-y-1">
                                          <div
                                            className={cn(
                                              "font-mono flex items-center gap-2 flex-wrap",
                                              (a.fonte === "informe_mensal_fidc" ||
                                                a.fonte === "estoque_fidc" ||
                                                a.fonte === "informe_fidc_fallback") &&
                                                "text-cyan-800",
                                              a.fonte === "fip_lookthrough" && "text-violet-900",
                                            )}
                                          >
                                            {temLtDrill ? (
                                              <button
                                                type="button"
                                                className="flex items-center gap-1.5 flex-wrap text-left rounded-sm hover:bg-violet-100/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-400 px-0.5 -mx-0.5"
                                                aria-expanded={ltAberto}
                                                title={ltAberto ? "Ocultar investidas" : "Ver investidas do FIP"}
                                                onClick={(e) => {
                                                  e.preventDefault();
                                                  e.stopPropagation();
                                                  setLookThroughExpandidoKey((prev) => (prev === ltKey ? null : ltKey));
                                                }}
                                              >
                                                <ChevronRight
                                                  className={cn(
                                                    "h-3 w-3 shrink-0 text-violet-600 transition-transform",
                                                    ltAberto && "rotate-90",
                                                  )}
                                                />
                                                <span>
                                                  {a.nome}: {formatBRL(a.valor)}
                                                </span>
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-violet-100 text-violet-800 border border-violet-200 not-italic">
                                                  Look-through FIP
                                                </span>
                                                <span className="text-muted-foreground">(D+{a.prazo})</span>
                                              </button>
                                            ) : (
                                              <>
                                                <span>
                                                  {a.nome}: {formatBRL(a.valor)}
                                                </span>
                                                {a.fonte === "fip_lookthrough" ? (
                                                  <>
                                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-violet-100 text-violet-800 border border-violet-200 not-italic">
                                                      Look-through FIP
                                                    </span>
                                                    <span className="text-muted-foreground">(D+{a.prazo})</span>
                                                  </>
                                                ) : a.fonte === "informe_mensal_fidc" ? (
                                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-cyan-100 text-cyan-700 border border-cyan-200 not-italic">
                                                    Inf. Mensal FIDC
                                                  </span>
                                                ) : a.fonte === "informe_mensal_fidc_residual" ? (
                                                  <>
                                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-100 text-amber-800 border border-amber-200 not-italic">
                                                      Residual ilíquido
                                                    </span>
                                                    <span className="text-muted-foreground">(D+1260)</span>
                                                  </>
                                                ) : a.fonte === "informe_buckets_vazio_fallback" ? (
                                                  <>
                                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-100 text-amber-800 border border-amber-200 not-italic">
                                                      Inf. sem buckets
                                                    </span>
                                                    <span className="text-muted-foreground">(D+720)</span>
                                                  </>
                                                ) : a.fonte === "estoque_fidc" || a.fonte === "informe_fidc_fallback" ? (
                                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-cyan-100 text-cyan-700 border border-cyan-200 not-italic">
                                                    Estoque
                                                  </span>
                                                ) : (
                                                  <span className="text-muted-foreground">(D+{a.prazo})</span>
                                                )}
                                              </>
                                            )}
                                          </div>
                                          {ltAberto && a.look_through_detalhes && a.look_through_detalhes.length > 0 ? (
                                            <div className="mt-1 space-y-0.5">
                                              {a.look_through_posicao_data && (() => {
                                                const pd = a.look_through_posicao_data;
                                                const pdBr = pd.length === 8
                                                  ? `${pd.slice(6, 8)}/${pd.slice(4, 6)}/${pd.slice(0, 4)}`
                                                  : pd;
                                                const isMesmaData = pd === fundoDtposicao;
                                                return (
                                                  <div className="flex items-center gap-1 text-[9px] text-violet-500/80 pl-2 ml-0.5 mb-0.5 italic">
                                                    <span>Posição FIP em</span>
                                                    <span className={`font-mono font-semibold not-italic ${isMesmaData ? "text-emerald-600" : "text-amber-600"}`}>
                                                      {pdBr}
                                                    </span>
                                                    {!isMesmaData && (
                                                      <span className="text-amber-500" title="A posição do FIP é de uma data diferente da data-base do fundo">
                                                        ⚠ snapshot anterior à data-base
                                                      </span>
                                                    )}
                                                  </div>
                                                );
                                              })()}
                                              {a.look_through_detalhes.map((d, di) => {
                                                const br = formatDataLiquidezPrevistaBr(d.data_liquidez);
                                                const pctStr = ` · ${d.pct}% do PL participações (FIP)`;
                                                return (
                                                  <div key={di} className="flex items-center gap-1.5 text-[9px] text-violet-800 pl-2 border-l-2 border-violet-300 ml-0.5">
                                                    <span className="text-violet-400">↳</span>
                                                    <span className="font-medium">{d.nome}</span>
                                                    <span className="text-violet-600 font-mono">D+{d.dias}</span>
                                                    <span className="text-muted-foreground">({br})</span>
                                                    <span className="text-violet-500/80 italic">{pctStr.trim()}</span>
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          ) : ltAberto && a.look_through_resumo ? (
                                            <p className="text-[9px] text-violet-900/90 leading-snug max-w-4xl pl-1 border-l-2 border-violet-300 ml-0.5 not-italic">
                                              {a.look_through_resumo}
                                            </p>
                                          ) : null}
                                        </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                            {verticeExpandido === r.vertice && r.ativosNoVertice.length === 0 && (
                              <TableRow ref={expandedRowRef} key={`${r.vertice}-vazio`} className="bg-muted/20 hover:bg-muted/20">
                                <TableCell colSpan={13} className="py-2 px-4 pl-6 text-[10px] text-muted-foreground">
                                  Nenhum ativo neste vértice (ativos vencem em prazos anteriores ou posteriores).
                                </TableCell>
                              </TableRow>
                            )}
                          </React.Fragment>
                        ))}
                      </TableBody>
                      <TableFooter>
                        {(() => {
                          const totalAtivo = verticesParaExibir.reduce((s, r) => s + r.ativoVertice, 0);
                          const totalResgSolic = verticesParaExibir.reduce((s, r) => s + (r.resgatesSolicitados ?? 0), 0);
                          return (
                            <TableRow className="h-9 text-[11px] font-bold border-t-2">
                              <TableCell className="font-mono font-bold">Total</TableCell>
                              <TableCell className="text-right font-mono font-bold">
                                {formatBRL(totalAtivo)}
                              </TableCell>
                              {/* cols 3-6: Ativo Acum, Resg. Ativos, Prob. %, Prob. Valor — sem total */}
                              <TableCell colSpan={4} />
                              <TableCell className={cn(
                                "text-right font-mono font-bold",
                                totalResgSolic > 0 ? "text-amber-700" : "text-muted-foreground"
                              )}>
                                {totalResgSolic > 0 ? formatBRL(totalResgSolic) : "—"}
                              </TableCell>
                              <TableCell colSpan={6} className="text-[10px] text-muted-foreground font-normal">
                                Soma Ativo = {formatBRL(totalAtivo)} • PL = {formatBRL(totalPL)}
                                {Math.abs(totalAtivo - totalPL) < 1 && (
                                  <span className="ml-2 text-emerald-600 font-medium">✓</span>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })()}
                      </TableFooter>
                    </Table>
                </div>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}

      {/* ── DARF estimado — Fundo Aberto ── */}
      {!isFundoFechado && darfAbertoAnalise && (
        <Card>
          <CardHeader className="py-3 px-4 bg-muted/30 border-b">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-md bg-blue-500/10 text-blue-600">
                <Receipt className="w-3.5 h-3.5" />
              </div>
              <CardTitle className="text-sm font-medium">DARF Estimado — Come-Cotas</CardTitle>
              {!darfAbertoAnalise.temComeCottas && (
                <span className="ml-auto inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground border border-border/60">
                  Não sujeito a come-cotas
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-4">
            {!darfAbertoAnalise.temComeCottas ? (
              <p className="text-sm text-muted-foreground">
                Este tipo de fundo (FIP, FIDC, FII, FIAGRO ou equivalente) não está sujeito ao come-cotas semestral.
                A tributação ocorre apenas no resgate.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* DARF Estimado */}
                <div className="flex flex-col gap-1 p-3 rounded-lg bg-muted/30 border">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wide">DARF Estimado</span>
                  <span className="text-2xl font-bold font-mono tabular-nums">
                    {darfAbertoAnalise.darfEstimado > 0
                      ? formatBRL(darfAbertoAnalise.darfEstimado)
                      : <span className="text-muted-foreground/50">R$ 0</span>
                    }
                  </span>
                  <span className="text-[9px] text-muted-foreground">alíquota 15% sobre lucro semestral</span>
                </div>

                {/* Cota base */}
                <div className="flex flex-col gap-1 p-3 rounded-lg bg-muted/30 border">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Cota Base (mai/nov)</span>
                  {darfAbertoAnalise.cotaBaseComeCottas != null ? (
                    <>
                      <span className="text-2xl font-bold font-mono tabular-nums">
                        {darfAbertoAnalise.cotaBaseComeCottas.toFixed(6)}
                      </span>
                      <span className="text-[9px] text-muted-foreground">último dia útil do semestre anterior</span>
                    </>
                  ) : (
                    <>
                      <span className="text-lg font-bold text-muted-foreground/50">—</span>
                      <span className="text-[9px] italic text-muted-foreground">sem posição de mai/nov importada</span>
                    </>
                  )}
                </div>

                {/* Rentabilidade semestral */}
                <div className="flex flex-col gap-1 p-3 rounded-lg bg-muted/30 border">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Rent. Semestral</span>
                  {darfAbertoAnalise.rentSemestre != null ? (
                    <>
                      <span className={cn(
                        "text-2xl font-bold font-mono tabular-nums",
                        darfAbertoAnalise.rentSemestre >= 0 ? "text-emerald-600" : "text-red-600"
                      )}>
                        {(darfAbertoAnalise.rentSemestre * 100).toFixed(2)}%
                      </span>
                      <span className="text-[9px] text-muted-foreground">
                        {darfAbertoAnalise.rentSemestre > 0
                          ? "positiva — DARF incide sobre o lucro"
                          : "negativa — sem come-cotas no período"}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-lg font-bold text-muted-foreground/50">—</span>
                      <span className="text-[9px] italic text-muted-foreground">sem base para cálculo</span>
                    </>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isFundoFechado && fundoFechadoAnalise && (() => {
        const prazoResgate = fundoFechadoAnalise.prazoResgate;
        const ativosConsiderados = (calculoData?.ativosComPrazo ?? []).filter(
          (a) => !["despesas","provisao"].includes((a as any).section ?? "") && (a.prazos_em_dias ?? a.vertice) <= prazoResgate
        );
        const coverStatus = fundoFechadoAnalise.statusCoberturaDespesa ?? "indisponivel";
        return (
          <Card className="overflow-hidden">
            {/* ── Header fino ── */}
            <div className="px-4 py-2.5 bg-muted/30 border-b space-y-1.5">
              {/* Linha 1: título + badges de status */}
              <div className="flex flex-wrap items-center gap-2 gap-y-2 min-w-0">
                <div className="p-1.5 rounded-md bg-muted text-muted-foreground shrink-0">
                  <Building2 className="w-3.5 h-3.5" />
                </div>
                <span className="text-xs font-semibold text-foreground min-w-0">Análise Fundo Fechado</span>
                <div className="ml-0 sm:ml-auto flex flex-wrap items-center gap-2 sm:gap-3 w-full sm:w-auto justify-end sm:justify-end">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Amortização</span>
                    <StatusBadge status={fundoFechadoAnalise.status} />
                  </div>
                  <div className="w-px h-4 bg-border" />
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Cobertura</span>
                    <CoverageStatusBadge status={coverStatus} />
                  </div>
                </div>
              </div>
              {/* Linha 2: réguas de regras */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
                {/* Disponibilidade */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[9px] font-medium text-muted-foreground">Disponibilidade:</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] bg-muted/80 text-muted-foreground border border-border/60">
                    Hard ≤ {(fechadoHardThreshold * 100).toFixed(1)}%
                  </span>
                  <span className="text-[9px] text-border">·</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] bg-muted/80 text-muted-foreground border border-border/60">
                    Soft {(fechadoHardThreshold * 100).toFixed(1)}%–{(fechadoSoftThreshold * 100).toFixed(1)}%
                  </span>
                  <span className="text-[9px] text-border">·</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] bg-muted/80 text-muted-foreground border border-border/60">
                    OK ≥ {(fechadoSoftThreshold * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="w-px h-3 bg-border/50 hidden md:block" />
                {/* Cobertura Op. */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[9px] font-medium text-muted-foreground">Cobertura Op.:</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] bg-muted/80 text-muted-foreground border border-border/60">
                    Hard &lt; 3 meses
                  </span>
                  <span className="text-[9px] text-border">·</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] bg-muted/80 text-muted-foreground border border-border/60">
                    Soft 3–7 meses
                  </span>
                  <span className="text-[9px] text-border">·</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] bg-muted/80 text-muted-foreground border border-border/60">
                    OK ≥ 7 meses
                  </span>
                </div>
              </div>
            </div>

            <CardContent className="p-0">
              <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">

                {/* ══ Painel A: Amortização ══ */}
                <div className="p-4 space-y-3">
                  {/* Métrica principal */}
                  <div className={cn(
                    "flex items-center justify-between rounded-md px-3 py-2",
                    fundoFechadoAnalise.status === "violacao" ? "bg-red-50 border border-red-200"
                      : fundoFechadoAnalise.status === "alerta" ? "bg-amber-50 border border-amber-200"
                      : "bg-emerald-50 border border-emerald-200"
                  )}>
                    <span className="text-[10px] text-muted-foreground">Disp. / PL</span>
                    <span className={cn(
                      "text-2xl font-bold font-mono",
                      fundoFechadoAnalise.status === "violacao" ? "text-red-600"
                        : fundoFechadoAnalise.status === "alerta" ? "text-amber-600"
                        : "text-emerald-600"
                    )}>
                      {formatPerc(fundoFechadoAnalise.dispPL)}
                    </span>
                  </div>

                  {/* Linha: Disponibilidade */}
                  <div className="flex items-center justify-between text-[11px] py-0.5">
                    <span className="text-muted-foreground">Disponibilidade</span>
                    <span className="font-mono font-medium">{formatBRL(fundoFechadoAnalise.disponibilidade)}</span>
                  </div>

                  {/* Linha: Prazo */}
                  <div className="flex items-center justify-between text-[11px] py-0.5 border-t border-border/50 pt-2">
                    <span className="text-muted-foreground">Prazo resgate</span>
                    <span className="font-mono font-medium">D+{prazoResgate}</span>
                  </div>

                  {/* Ativos considerados — expansível */}
                  <div className="border-t border-border/50 pt-2">
                    <button
                      onClick={() => setAtivosAmortizacaoOpen((v) => !v)}
                      className="flex items-center gap-1.5 text-[10px] text-primary hover:text-primary/80 font-medium transition-colors w-full"
                    >
                      <ChevronRight className={cn("w-3 h-3 transition-transform shrink-0", ativosAmortizacaoOpen && "rotate-90")} />
                      Ativos considerados ({ativosConsiderados.length})
                    </button>
                    {ativosAmortizacaoOpen && (
                      <div className="mt-2 rounded-md border bg-background overflow-hidden">
                        <table className="w-full text-[10px]">
                          <thead>
                            <tr className="border-b bg-muted/30">
                              <th className="text-left font-semibold text-muted-foreground px-2 py-1.5">Ativo</th>
                              <th className="text-right font-semibold text-muted-foreground px-2 py-1.5">Prazo</th>
                              <th className="text-right font-semibold text-muted-foreground px-2 py-1.5">Valor</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ativosConsiderados.length === 0 ? (
                              <tr><td colSpan={3} className="text-center text-muted-foreground px-2 py-3 italic">Nenhum ativo liquidável no prazo</td></tr>
                            ) : (
                              ativosConsiderados.map((a, i) => (
                                <tr key={a.id ?? i} className={cn("border-b last:border-0", i % 2 === 1 && "bg-muted/20")}>
                                  <td className="px-2 py-1.5 font-mono max-w-[160px] truncate">{a.nome}</td>
                                  <td className="text-right px-2 py-1.5 font-mono text-muted-foreground">{a.prazos_em_dias != null ? `D+${a.prazos_em_dias}` : `D+${a.vertice}`}</td>
                                  <td className="text-right px-2 py-1.5 font-mono">{formatBRL(a.valor)}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                </div>

                {/* ══ Painel B: Cobertura Operacional ══ */}
                <div className="p-4 space-y-3">
                  {/* Métrica principal */}
                  <div className={cn(
                    "flex items-center justify-between rounded-md px-3 py-2",
                    coverStatus === "violacao" ? "bg-red-50 border border-red-200"
                      : coverStatus === "alerta" ? "bg-amber-50 border border-amber-200"
                      : coverStatus === "ok" ? "bg-emerald-50 border border-emerald-200"
                      : "bg-muted/30 border border-border"
                  )}>
                    <span className="text-[10px] text-muted-foreground">Meses cobertura</span>
                    <span className={cn(
                      "text-2xl font-bold font-mono",
                      coverStatus === "violacao" ? "text-red-600"
                        : coverStatus === "alerta" ? "text-amber-600"
                        : coverStatus === "ok" ? "text-emerald-600"
                        : "text-muted-foreground/40"
                    )}>
                      {fundoFechadoAnalise.mesesCobertura != null ? fundoFechadoAnalise.mesesCobertura.toFixed(1) : "—"}
                    </span>
                  </div>

                  {/* Linha: Caixa líquido */}
                  <div className="flex items-center justify-between text-[11px] py-0.5">
                    <span className="text-muted-foreground">Caixa líquido</span>
                    <span className="font-mono font-medium">{formatBRL(fundoFechadoAnalise.caixaLiquido ?? 0)}</span>
                  </div>

                  {/* Linha: DARF + come-cotas */}
                  <div className="flex items-center justify-between text-[11px] py-0.5 border-t border-border/50 pt-2">
                    <span className="text-muted-foreground">DARF estimado</span>
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="font-mono text-muted-foreground">{formatBRL(fundoFechadoAnalise.darfEstimado ?? 0)}</span>
                      {fundoFechadoAnalise.temComeCottas && fundoFechadoAnalise.cotaBaseComeCottas != null ? (
                        <span className="text-[9px] text-muted-foreground">
                          cota base {fundoFechadoAnalise.cotaBaseComeCottas.toFixed(6)}
                          {fundoFechadoAnalise.rentSemestre != null && (
                            <> &nbsp;·&nbsp; <span className={cn("font-semibold", fundoFechadoAnalise.rentSemestre >= 0 ? "text-emerald-600" : "text-red-600")}>
                              {(fundoFechadoAnalise.rentSemestre * 100).toFixed(2)}% sem.
                            </span></>
                          )}
                        </span>
                      ) : fundoFechadoAnalise.temComeCottas ? (
                        <span className="text-[9px] italic text-muted-foreground">sem XML base mai/nov</span>
                      ) : (
                        <span className="text-[9px] text-muted-foreground">não aplicável</span>
                      )}
                    </div>
                  </div>

                  {/* Linha: Despesa mensal + breakdown expansível */}
                  <div className="py-0.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <button
                        onClick={() => fundoFechadoAnalise.despesaBreakdown ? setDespesaBreakdownOpen(v => !v) : undefined}
                        className={cn(
                          "flex items-center gap-1 text-muted-foreground transition-colors",
                          fundoFechadoAnalise.despesaBreakdown && "hover:text-primary cursor-pointer"
                        )}
                      >
                        {fundoFechadoAnalise.despesaBreakdown && (
                          <ChevronRight className={cn("w-3 h-3 shrink-0 transition-transform", despesaBreakdownOpen && "rotate-90")} />
                        )}
                        Despesa mensal
                      </button>
                      {fundoFechadoAnalise.despesaOperacionalMensal != null
                        ? <span className="font-mono font-medium">{formatBRL(fundoFechadoAnalise.despesaOperacionalMensal)}</span>
                        : <span className="italic text-[10px] text-muted-foreground">Não informado</span>
                      }
                    </div>
                    {fundoFechadoAnalise.fonteDespesa && (
                      <p className="text-[9px] text-muted-foreground text-right mt-0.5">
                        Fonte: {FONTE_DESPESA_LABELS[fundoFechadoAnalise.fonteDespesa] ?? fundoFechadoAnalise.fonteDespesa}
                      </p>
                    )}

                    {/* Breakdown por categoria */}
                    {despesaBreakdownOpen && fundoFechadoAnalise.despesaBreakdown && (
                      <div className="mt-1.5 rounded-md border bg-muted/20 overflow-hidden">
                        <table className="w-full text-[10px]">
                          <thead>
                            <tr className="border-b bg-muted/40">
                              <th className="text-left font-semibold text-muted-foreground px-2 py-1">Categoria</th>
                              <th className="text-right font-semibold text-muted-foreground px-2 py-1">Média/mês</th>
                              <th className="text-right font-semibold text-muted-foreground px-2 py-1">%</th>
                            </tr>
                          </thead>
                          <tbody>
                            {fundoFechadoAnalise.despesaBreakdown.map((item, i) => (
                              <tr key={item.categoria} className={cn("border-b last:border-0", i % 2 === 1 && "bg-muted/10")}>
                                <td className="px-2 py-1 text-muted-foreground">
                                  {CATEGORIA_LABELS[item.categoria] ?? item.categoria}
                                  {item.mesesDisponivel < 3 && (
                                    <span className="ml-1 text-amber-500" title={`Apenas ${item.mesesDisponivel} mês(es) de histórico`}>
                                      ({item.mesesDisponivel}m)
                                    </span>
                                  )}
                                </td>
                                <td className="px-2 py-1 font-mono text-right">{formatBRL(item.mediaMonsal)}</td>
                                <td className="px-2 py-1 font-mono text-right text-muted-foreground">{item.percentual.toFixed(1)}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* Ativos considerados — expansível (mesma base) */}
                  <div className="border-t border-border/50 pt-2">
                    <button
                      onClick={() => setAtivosCoberturaOpen((v) => !v)}
                      className="flex items-center gap-1.5 text-[10px] text-primary hover:text-primary/80 font-medium transition-colors w-full"
                    >
                      <ChevronRight className={cn("w-3 h-3 transition-transform shrink-0", ativosCoberturaOpen && "rotate-90")} />
                      Ativos considerados ({ativosConsiderados.length})
                    </button>
                    {ativosCoberturaOpen && (
                      <div className="mt-2 rounded-md border bg-background overflow-hidden">
                        <table className="w-full text-[10px]">
                          <thead>
                            <tr className="border-b bg-muted/30">
                              <th className="text-left font-semibold text-muted-foreground px-2 py-1.5">Ativo</th>
                              <th className="text-right font-semibold text-muted-foreground px-2 py-1.5">Prazo</th>
                              <th className="text-right font-semibold text-muted-foreground px-2 py-1.5">Valor</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ativosConsiderados.length === 0 ? (
                              <tr><td colSpan={3} className="text-center text-muted-foreground px-2 py-3 italic">Nenhum ativo liquidável no prazo</td></tr>
                            ) : (
                              ativosConsiderados.map((a, i) => (
                                <tr key={a.id ?? i} className={cn("border-b last:border-0", i % 2 === 1 && "bg-muted/20")}>
                                  <td className="px-2 py-1.5 font-mono max-w-[160px] truncate">{a.nome}</td>
                                  <td className="text-right px-2 py-1.5 font-mono text-muted-foreground">{a.prazos_em_dias != null ? `D+${a.prazos_em_dias}` : `D+${a.vertice}`}</td>
                                  <td className="text-right px-2 py-1.5 font-mono">{formatBRL(a.valor)}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* Rodapé */}
                  <p className="text-[9px] text-muted-foreground">
                    {coverStatus === "indisponivel"
                      ? <span className="text-amber-600">Cadastre a despesa mensal em Características do Fundo.</span>
                      : "HARD < 3 meses · SOFT 3–7 meses · OK ≥ 7 meses"
                    }
                  </p>
                </div>

              </div>
            </CardContent>
          </Card>
        );
      })()}

      {isFundoFechado ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <LiquidezHeatmap items={timelineData} activeDateStr={fundoDtposicao} />
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <TrendingUp className="w-4 h-4" />
                Histórico de Amortizações
              </CardTitle>
              <CardDescription className="text-[10px]">Últimas amortizações dos últimos 12 meses.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-border/60 rounded-lg bg-muted/20">
                <TrendingUp className="w-10 h-10 text-muted-foreground/40 mb-3" />
                <p className="text-xs font-medium text-muted-foreground">Em breve</p>
                <p className="text-[10px] text-muted-foreground/80 mt-1 max-w-[220px]">
                  Aqui será exibido o histórico de amortizações realizadas nos últimos 12 meses para este fundo fechado.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <LiquidezFrequencia items={timelineData} />
          <LiquidezHeatmap items={timelineData} activeDateStr={fundoDtposicao} />
          <LiquidezStress
            choqueResult={liquidezStressChoque}
            totalPL={calculoData?.totalPL ?? 0}
            maiorCotista={
              passivoTop[0]
                ? { nome: passivoTop[0].cotista, valor: passivoTop[0].valor }
                : null
            }
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="w-4 h-4" />
              Concentração de Cotas — Top 5
            </CardTitle>
            <CardDescription className="text-xs">Maiores posições em fundos investidos (cotas).</CardDescription>
          </CardHeader>
          <CardContent>
            {top5Cotas.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4">Nenhuma cota no portfólio.</p>
            ) : (
              <div className="space-y-2">
                {top5Cotas.map((c, i) => (
                  <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-muted/30">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-bold text-muted-foreground w-4">{i + 1}º</span>
                      <span className="text-xs font-medium truncate">{c.nome}</span>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-mono font-bold text-xs">{formatBRL(c.valor)}</p>
                      <p className="text-[10px] text-muted-foreground">{c.perc.toFixed(2)}% do PL</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="w-4 h-4" />
              Concentração de Cotista — Top 5
            </CardTitle>
            <CardDescription className="text-xs">
              Maiores cotistas do fundo por participação no passivo.
              {passivoDataPosicaoFmt && (
                <span className="block text-[10px] text-muted-foreground/80 mt-0.5">
                  Passivo ref.: {passivoDataPosicaoFmt}
                  {passivoAdministradora ? ` · ${passivoAdministradora}` : ""}
                  {fundoDtposicao && passivoDataPosicao && passivoDataPosicao !== fundoDtposicao && (
                    <span> (carteira: {fundoDtposicao.slice(6, 8)}/{fundoDtposicao.slice(4, 6)}/{fundoDtposicao.slice(0, 4)})</span>
                  )}
                </span>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {top5Cotistas.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-center border border-dashed border-border/60 rounded-lg bg-muted/20">
                <Users className="w-10 h-10 text-muted-foreground/40 mb-3" />
                <p className="text-xs font-medium text-muted-foreground">Nenhum dado encontrado</p>
                <p className="text-[10px] text-muted-foreground/80 mt-1 max-w-[200px]">
                  Não foram encontrados dados de cotistas para este fundo nesta data. Verifique se o passivo foi importado na aba Passivo Fundos e se o nome do fundo coincide
                  (o matching é feito por nome normalizado).
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {top5Cotistas.map((c, i) => (
                  <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-muted/30">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-bold text-muted-foreground w-4">{i + 1}º</span>
                      {c.codigo_clt != null && (
                        <span className="text-[10px] font-mono font-medium text-primary shrink-0">#{c.codigo_clt}</span>
                      )}
                      <span className="text-xs font-medium truncate">{c.nome}</span>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-mono font-bold text-xs">{formatBRL(c.valor)}</p>
                      <p className="text-[10px] text-muted-foreground">{c.perc.toFixed(2)}% do passivo</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <WalletTable
          assets={assets}
          totalPL={totalPL}
          onSelectAsset={setSelectedAsset}
          resgatesSolicitados={resgatesSolicitados}
          onResgatesSolicitadosChange={setResgatesSolicitados}
          showPrazosEmDias
        />
      </div>

      <WalletDetailsSheet asset={selectedAsset} onClose={() => setSelectedAsset(null)} />
    </div>
  );
}
