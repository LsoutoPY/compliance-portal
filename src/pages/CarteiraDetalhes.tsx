import { useParams, useSearchParams, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { useState, useMemo, useEffect } from "react";
import { toast } from "sonner";
import { RulesList } from "@/components/RulesSheet";
import { EnquadramentoTimeline } from "@/components/EnquadramentoTimeline";
import { WalletHeader } from "@/components/wallet/WalletHeader";
import { buildFundoDisplayKey } from "@/lib/mapaFundos/keys";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WalletSummary } from "@/components/wallet/WalletSummary";
import { FIPCapitalSubscrCard } from "@/components/wallet/FIPCapitalSubscrCard";
import { WalletTable, Asset } from "@/components/wallet/WalletTable";
import { WalletDetailsSheet } from "@/components/wallet/WalletDetailsSheet";
import { PrazoMedioCarteira } from "@/components/wallet/PrazoMedioCarteira";
import { Loader2, Info, ArrowLeft, X, Receipt, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { exportEnquadramentoFundoPdf, ExportEnquadramentoFundoInfo, ExportEnquadramentoRule, ExportWalletAsset } from "@/lib/exportPdf";
import { buildEnquadramentoFundoExcelBuffer, exportEnquadramentoFundoExcel } from "@/lib/exportFundoExcel";
import { resolvePatliqEnquadramento } from "@/lib/patliqContext";
import {
  collectNomeLookupKeysFromPosicao,
  fetchNomeMapFromAtivosTable,
  fetchNomeMapFromFundosCaracteristicas,
  mergeNomesAtivosCarteira,
  nomeMapToRecord,
} from "@/lib/mapaAtivosNome";
import { resolveNomeExibicaoFromPosicao } from "@/hooks/useRentabilidadeCalc";
import { resolveStoredComplianceStatus } from "@/lib/fipClasseCompliance";
import "./CarteiraDetalhes.css";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
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
  }
  return error instanceof Error ? error.message : String(error);
}

export interface CarteiraDetalhesProps {
  /** Caminho para o botão Voltar (ex: /dados/posicao-fundos) */
  backPath?: string;
  /** Texto do botão Voltar */
  backLabel?: string;
  /** Exibe Rodar Verificação e exportação PDF/Excel */
  showEnquadramentoActions?: boolean;
  /** Exibe seção Monitoramento de Compliance e Regras */
  showComplianceSection?: boolean;
  /** Usar explosão inline (expandir na mesma página) em vez de navegar */
  inlineExplosao?: boolean;
}

export default function CarteiraDetalhes({
  backPath = "/enquadramento/monitoramento",
  backLabel = "Voltar para Monitoramento",
  showEnquadramentoActions = true,
  showComplianceSection = true,
  inlineExplosao = true,
}: CarteiraDetalhesProps = {}) {
  const { cnpj, date: dateParam } = useParams();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  // ISIN da query string — diferencia subclasses (ex: FIDC SR vs JR) com mesmo CNPJ
  const isinParam = searchParams.get("isin") || null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isRunningCheck, setIsRunningCheck] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [investidoresOpen, setInvestidoresOpen] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [isNotifying, setIsNotifying] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [considerarCapitalSubscr, setConsiderarCapitalSubscr] = useState(true);
  const [expandedCotaPath, setExpandedCotaPath] = useState<string[]>([]);
  const [drillSection, setDrillSection] = useState<string | null>(null);

  const enrichWalletAssets = async (walletData: any[]) => {
    const { cnpjs, isins } = collectNomeLookupKeysFromPosicao(walletData);

    const [anbimaMap, frontendMap] = await Promise.all([
      fetchNomeMapFromFundosCaracteristicas(cnpjs, isins),
      fetchNomeMapFromAtivosTable(cnpjs, isins),
    ]);
    const nomeMap = nomeMapToRecord(mergeNomesAtivosCarteira(anbimaMap, frontendMap));

    let charData: any[] = [];
    if (cnpjs.length > 0) {
      const { data } = await supabase
        .from("fundos_caracteristicas" as any)
        .select("cnpj_classe, cnpj_fundo, prazo_pagamento_resgate_dias")
        .or(`cnpj_classe.in.(${cnpjs.join(",")}),cnpj_fundo.in.(${cnpjs.join(",")})`);
      charData = (data as any[]) || [];
    }

    const prazoMap = new Map<string, number | null>();
    charData.forEach((char: any) => {
      const prazo = char.prazo_pagamento_resgate_dias ?? null;
      if (char.cnpj_classe) prazoMap.set(char.cnpj_classe, prazo);
      if (char.cnpj_fundo && char.cnpj_fundo !== char.cnpj_classe) prazoMap.set(char.cnpj_fundo, prazo);
    });

    return walletData.map((item: any) => {
      const keyFromPos = item.section === "cotas" ? item.cnpjfundo : item.cnpjemissor;
      return {
        ...item,
        nome_comercial_ativo: resolveNomeExibicaoFromPosicao(item, nomeMap),
        prazo_pagamento_resgate_dias: keyFromPos ? prazoMap.get(keyFromPos) ?? null : null,
        validado: item.ativos?.validado ?? true,
      };
    });
  };

  // 1. Fetch wallet data
  const { data: assets = [], isLoading } = useQuery({
    queryKey: ["carteira", cnpj, dateParam, isinParam],
    enabled: !!cnpj,
    queryFn: async () => {
      let targetDate = dateParam;
      if (!targetDate) {
        // Sem data na URL: usar a mais recente
        let dateQuery = supabase
          .from("posicao_carteira")
          .select("fundo_dtposicao")
          .eq("fundo_cnpj", cnpj)
          .order("fundo_dtposicao", { ascending: false })
          .limit(1);
        if (isinParam) dateQuery = (dateQuery as any).eq("fundo_isin", isinParam);
        const { data: dateData } = await dateQuery;
        targetDate = (dateData as any)?.[0]?.fundo_dtposicao;
      }
      if (!targetDate) return [];

      let walletQuery = supabase
        .from("posicao_carteira")
        .select("*, ativos(id, cnpj, tipo_ativo, validado, nome_frontend, descricao)")
        .eq("fundo_cnpj", cnpj)
        .eq("fundo_dtposicao", targetDate)
        .order("valor_padrao", { ascending: false });
      // Filtrar por ISIN quando subclasse especificada (ex: FIDC SR vs JR)
      if (isinParam) walletQuery = (walletQuery as any).eq("fundo_isin", isinParam);

      const { data: walletData, error: walletError } = await walletQuery;

      if (walletError) throw walletError;
      if (!walletData?.length) return [];

      return enrichWalletAssets(walletData);
    },
  });

  const fundInfo = assets[0]; // Take general info from first record
  const fundoDtPosicao = fundInfo?.fundo_dtposicao;

  useEffect(() => {
    if (location.hash !== "#monitoramento-compliance" || isLoading || !fundInfo) return;
    const el = document.getElementById("monitoramento-compliance");
    if (!el) return;
    const timer = window.setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [location.hash, dateParam, cnpj, isLoading, fundInfo]);

  // CNPJs de cotas (sub-funds) que possuem posição/XML importado na mesma data
  const cnpjFundosFromCotas = [...new Set(
    assets.filter((a) => (a.section || "").toLowerCase() === "cotas" && a.cnpjfundo).map((a) => a.cnpjfundo!)
  )] as string[];

  const { data: cotasComPosicao = [] } = useQuery({
    queryKey: ["cotas-com-posicao", cnpjFundosFromCotas, fundoDtPosicao],
    enabled: cnpjFundosFromCotas.length > 0 && !!fundoDtPosicao,
    queryFn: async () => {
      const { data } = await supabase
        .from("posicao_carteira")
        .select("fundo_cnpj")
        .in("fundo_cnpj", cnpjFundosFromCotas)
        .eq("fundo_dtposicao", fundoDtPosicao)
        .limit(cnpjFundosFromCotas.length * 2);
      const unique = [...new Set((data || []).map((r) => r.fundo_cnpj))];
      return unique;
    },
  });

  const cotasComPosicaoSet = useMemo(() => new Set(cotasComPosicao), [cotasComPosicao]);

  // Fetch sub-fund assets for each level in expanded path (explosão recursiva)
  const fetchFundAssetsWithCotas = async (fundCnpj: string) => {
    const { data: walletData, error: walletError } = await supabase
      .from("posicao_carteira")
      .select("*, ativos(id, cnpj, tipo_ativo, validado, nome_frontend, descricao)")
      .eq("fundo_cnpj", fundCnpj)
      .eq("fundo_dtposicao", fundoDtPosicao!)
      .order("valor_padrao", { ascending: false });

    if (walletError || !walletData?.length) return { assets: [], cotasComPosicao: new Set<string>(), totalPL: 0 };

    const cnpjFundosFromCotas = [...new Set(
      walletData
        .filter((item: any) => (item.section || "").toLowerCase() === "cotas" && item.cnpjfundo)
        .map((item: any) => item.cnpjfundo)
    )] as string[];

    let cotasComPosicao = new Set<string>();
    if (cnpjFundosFromCotas.length > 0) {
      const { data: posData } = await supabase
        .from("posicao_carteira")
        .select("fundo_cnpj")
        .in("fundo_cnpj", cnpjFundosFromCotas)
        .eq("fundo_dtposicao", fundoDtPosicao!);
      (posData || []).forEach((r: any) => cotasComPosicao.add(r.fundo_cnpj));
    }

    const assets = await enrichWalletAssets(walletData);

    const totalPL = (walletData[0] as any)?.fundo_patliq ?? 1;
    return { assets, cotasComPosicao, totalPL };
  };

  const pathAssetsResults = useQuery({
    queryKey: ["path-assets", expandedCotaPath, fundoDtPosicao, inlineExplosao],
    enabled: expandedCotaPath.length > 0 && !!fundoDtPosicao && inlineExplosao,
    queryFn: async () => {
      const results: { assets: Asset[]; cotasComPosicao: Set<string>; totalPL: number }[] = [];
      for (const cnpj of expandedCotaPath) {
        const r = await fetchFundAssetsWithCotas(cnpj);
        results.push(r);
      }
      return results;
    },
  });

  const pathAssetsData = pathAssetsResults.data ?? [];

  // Fetch the commercial name + prazo resgate + nivel1 for the main fund.
  // Match preferencial: CNPJ + ISIN (subclasse FIDC), fallback: CNPJ only.
  const fundIsin = fundInfo?.fundo_isin ?? null;
  const { data: mainFundChar } = useQuery({
    queryKey: ["fund-char", cnpj, fundIsin],
    enabled: !!cnpj && !isLoading,
    queryFn: async () => {
      const sel = "nome_comercial, prazo_pagamento_resgate_dias, nivel1_categoria, patliq_soma_fidc, pl_formula";

      if (fundIsin) {
        const { data: byIsin } = await supabase
          .from("fundos_caracteristicas" as any)
          .select(sel)
          .or(`cnpj_classe.eq.${cnpj},cnpj_fundo.eq.${cnpj}`)
          .eq("isin", fundIsin)
          .limit(1)
          .maybeSingle();
        if (byIsin) return byIsin as any;
      }

      const { data } = await supabase
        .from("fundos_caracteristicas" as any)
        .select(sel)
        .or(`cnpj_classe.eq.${cnpj},cnpj_fundo.eq.${cnpj}`)
        .or("estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo")
        .limit(1)
        .maybeSingle();
      return data as any;
    },
  });

  const { data: csvFundInfo } = useQuery({
    queryKey: ["carteira-csv-pl", cnpj, fundInfo?.fundo_dtposicao],
    enabled: !!cnpj && !!fundInfo?.fundo_dtposicao,
    retry: false,
    queryFn: async () => {
      try {
        const cnpj8 = cnpj!.replace(/\D/g, "").substring(0, 8);
        const dateIso = `${fundInfo!.fundo_dtposicao.slice(0, 4)}-${fundInfo!.fundo_dtposicao.slice(4, 6)}-${fundInfo!.fundo_dtposicao.slice(6, 8)}`;
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

  const isFIP = (mainFundChar?.nivel1_categoria || "").toUpperCase() === "FIP";

  // Fetch enquadramento rules for export
  const exportIsin = isinParam ?? fundInfo?.fundo_isin ?? null;
  const { data: enquadramentoRules = [] } = useQuery({
    queryKey: ["enquadramento-rules-export", cnpj, assets[0]?.fundo_dtposicao, exportIsin],
    enabled: !!cnpj && !!assets[0]?.fundo_dtposicao,
    queryFn: async () => {
      let q = supabase
        .from("enquadramento_resultado" as any)
        .select("regra_codigo, regra_descricao, regra_categoria, status, valor_atual, valor_limite, detalhes")
        .eq("fundo_cnpj", cnpj!)
        .eq("fundo_dtposicao", assets[0]?.fundo_dtposicao);
      if (exportIsin) q = (q as any).eq("fundo_isin", exportIsin);
      const { data } = await q;
      return ((data || []) as ExportEnquadramentoRule[]).map((rule) => ({
        ...rule,
        status: resolveStoredComplianceStatus(rule),
      }));
    },
  });

  const cleanCnpj = (cnpj || "").replace(/\D/g, "").padStart(14, "0");
  const posDate = fundInfo?.fundo_dtposicao
    ? `${fundInfo.fundo_dtposicao.slice(0, 4)}-${fundInfo.fundo_dtposicao.slice(4, 6)}-${fundInfo.fundo_dtposicao.slice(6, 8)}`
    : "";

  const { data: fipInforme } = useQuery({
    queryKey: ["fip-informe", cleanCnpj, posDate],
    enabled: !!isFIP && !!cleanCnpj && !!posDate,
    queryFn: async () => {
      const { data } = await supabase
        .from("fip_informe_quadrimestral" as any)
        .select("vl_cap_subscr")
        .eq("cnpj_fundo_classe", cleanCnpj)
        .lte("dt_comptc", posDate)
        .order("dt_comptc", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data as { vl_cap_subscr: number } | null;
    },
  });

  // De-para: códigos ANBIMA de lançamento (provisões)
  const { data: anbimaCodsRaw = [] } = useQuery({
    queryKey: ["anbima-cod-lancamento"],
    staleTime: Infinity,
    queryFn: async () => {
      const { data } = await supabase
        .from("anbima_cod_lancamento" as any)
        .select("cod_lancamento, descricao, grupo");
      return (data || []) as { cod_lancamento: string; descricao: string; grupo: string }[];
    },
  });

  const anbimaMap = useMemo(
    () => new Map(anbimaCodsRaw.map((r) => [r.cod_lancamento, r])),
    [anbimaCodsRaw]
  );

  const assetsEnriquecidos = useMemo(
    () =>
      assets.map((a) => {
        if ((a.section || "").toLowerCase() !== "provisao" || !a.codprov) return a;
        const anbima = anbimaMap.get(String(a.codprov));
        return {
          ...a,
          anbimaDescricao: anbima?.descricao ?? null,
          anbimaGrupo: anbima?.grupo ?? null,
        };
      }),
    [assets, anbimaMap]
  );

  const displayFundName = (fundInfo?.fundo_nome || fundInfo?.nome_fundo || mainFundChar?.nome_comercial || "Fundo Indisponível").trim() || "Fundo Indisponível";

  const patliqResolved = resolvePatliqEnquadramento({
    fundoPatliq: fundInfo?.fundo_patliq || 0,
    header: {
      fundo_valorativos: fundInfo?.fundo_valorativos,
      fundo_valorreceber: fundInfo?.fundo_valorreceber,
      fundo_valorpagar: fundInfo?.fundo_valorpagar,
      fundo_vlcotasresgatar: fundInfo?.fundo_vlcotasresgatar,
    },
    nivel1Categoria: mainFundChar?.nivel1_categoria,
    nomeFundo: displayFundName,
    csvPL: csvFundInfo?.valor_total_ativo || 0,
    patliqSomaFidc: mainFundChar?.patliq_soma_fidc,
    plFormula: mainFundChar?.pl_formula,
  });
  const { totalPL, xmlPL, plHeaderRaw, plFidc, hasPLDiscrepancy, origem: patliqOrigem } = patliqResolved;
  const csvPL = csvFundInfo?.valor_total_ativo || 0;

  const handleRunCheck = async () => {
    if (!cnpj || !fundInfo?.fundo_dtposicao) return;
    
    setIsRunningCheck(true);
    
    toast.promise(
      supabase.functions.invoke('check-enquadramento', {
        body: {
          fundo_cnpj: cnpj,
          fundo_dtposicao: fundInfo.fundo_dtposicao,
          ...(isinParam || fundInfo.fundo_isin
            ? { fundo_isin: isinParam || fundInfo.fundo_isin }
            : {}),
          categories: [
            'pl',
            'classe',
            'relational',
            'fidc-concentracao',
            'fidc-estrutura',
            'tributario',
            'tributario-art4',
            'tributario-art4-fidc',
          ],
        },
      }),
      {
        loading: "Verificando enquadramento...",
        success: (response) => {
          if (response.error) throw new Error(response.error.message);
          const data = response.data as {
            success?: boolean;
            warnings?: string[];
            total_rules_checked?: number;
          } | null;
          const warnings = data?.warnings ?? [];
          const tribWarnings = warnings.filter((w) =>
            /tributario/i.test(w),
          );
          if (tribWarnings.length > 0) {
            throw new Error(`Regras tributárias não calculadas: ${tribWarnings[0]}`);
          }
          if (data?.success === false && warnings.length > 0) {
            throw new Error(warnings[0]);
          }
          queryClient.invalidateQueries({ queryKey: ["funds-list"] });
          queryClient.invalidateQueries({ queryKey: ["enquadramento-rules"] });
          queryClient.invalidateQueries({ queryKey: ["enquadramento-rules-export"] });
          queryClient.invalidateQueries({ queryKey: ["enquadramento-rules-summary"] });
          queryClient.invalidateQueries({ queryKey: ["enquadramento-timeline"] });
          queryClient.invalidateQueries({ queryKey: ["fund-status-header"] });
          return "Verificação concluída!";
        },
        error: (err) => `Erro ao processar: ${err.message}`,
        finally: () => setIsRunningCheck(false)
      }
    );
  };

  const assetsToExport = (): ExportWalletAsset[] => {
    const totalPL = (hasPLDiscrepancy ? csvPL : (plFidc ?? fundInfo?.fundo_patliq)) || 1;
    const sectionNameMap: Record<string, string> = {
      caixa: "Caixa", provisao: "Provisão", despesas: "Despesa", imoveis: "Imóvel",
    };

    const provisoes = assets.filter((a) => (a.section || "").toLowerCase() === "provisao");
    const tableAssets =
      provisoes.length <= 1
        ? assets
        : (() => {
            const firstIdx = assets.findIndex((a) => (a.section || "").toLowerCase() === "provisao");
            const totalProvisao = provisoes.reduce((sum, a) => {
              const base = a.valor_padrao || 0;
              return sum + (a.credeb === "D" ? -base : base);
            }, 0);
            const agg: Asset = {
              ...provisoes[0],
              id: "provisao-agrupada",
              nome_comercial_ativo: "Provisão (consolidado)",
              qtdisponivel: null as unknown as number,
              puposicao: null as unknown as number,
              valor_padrao: Math.abs(totalProvisao),
              credeb: totalProvisao < 0 ? "D" : "C",
              isSectionAggregate: true,
              prazo_pagamento_resgate_dias: null,
              validado: true,
            };
            const compacted = assets.filter((a) => (a.section || "").toLowerCase() !== "provisao");
            compacted.splice(firstIdx, 0, agg);
            return compacted;
          })();

    return tableAssets.map((a) => {
      const displayName =
        a.section === "imoveis"
          ? a.nomecomercial || (a.logradouro ? `${a.logradouro}${a.numero ? `, ${a.numero}` : ""}` : undefined)
          : a.nome_comercial_ativo || a.isin || a.codativo;
      const ativo = displayName || sectionNameMap[(a.section || "").toLowerCase()] || "Outros Lançamentos";
      const prazoLiquidez =
        a.section?.toLowerCase() === "caixa" ? 0 : a.prazo_pagamento_resgate_dias ?? null;
      const valor = a.valor_padrao || 0;
      const share = valor / totalPL;
      const percPL = share ? (a.credeb === "D" ? "-" : "") + (share * 100).toFixed(2) + "%" : "0.00%";
      const financeiro =
        valor != null
          ? (a.credeb === "D" ? "-" : "") +
            new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(valor)
          : "-";

      return {
        ativo: ativo.length > 50 ? ativo.slice(0, 49) + "…" : ativo,
        tipo: (a.section || "").toLowerCase(),
        quantidade: a.qtdisponivel != null ? new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(a.qtdisponivel) : "-",
        precoUnit: a.puposicao != null ? new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 4, minimumFractionDigits: 2 }).format(a.puposicao) : "-",
        liquidez: prazoLiquidez != null ? `D+${prazoLiquidez}` : "N/D",
        financeiro,
        percPL,
      };
    });
  };

  const buildEnquadramentoExportInfo = (): ExportEnquadramentoFundoInfo | null => {
    if (!fundInfo) return null;
    const dtPos = fundInfo.fundo_dtposicao || "";
    const dataBase = dtPos.replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1");
    const cnpjFormatado = (fundInfo.fundo_cnpj || "")
      .replace(/\D/g, "")
      .replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

    const worstStatusRaw = enquadramentoRules.reduce<string>((worst, r) => {
      if (r.status === "violacao") return "violacao";
      if (r.status === "alerta" && worst !== "violacao") return "alerta";
      return worst;
    }, enquadramentoRules.length > 0 ? "ok" : "pendente");

    return {
      nomeFundo: displayFundName,
      cnpj: cnpjFormatado,
      isin: fundInfo.fundo_isin ?? isinParam ?? null,
      dataBase,
      prazoResgate: mainFundChar?.prazo_pagamento_resgate_dias ?? null,
      totalPL,
      worstStatus: worstStatusRaw as ExportEnquadramentoFundoInfo["worstStatus"],
    };
  };

  const hasViolacaoEnquadramento = enquadramentoRules.some((r) => r.status === "violacao");

  const handleExportPdf = async () => {
    const info = buildEnquadramentoExportInfo();
    if (!info) return;
    setIsExporting(true);
    try {
      await exportEnquadramentoFundoPdf(info, enquadramentoRules, assetsToExport());
    } catch (err) {
      toast.error("Erro ao gerar PDF");
      console.error(err);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportExcel = async () => {
    const info = buildEnquadramentoExportInfo();
    if (!info) return;
    setIsExportingExcel(true);
    try {
      await exportEnquadramentoFundoExcel(info, enquadramentoRules, assetsToExport());
    } catch (err) {
      toast.error("Erro ao gerar Excel");
      console.error(err);
    } finally {
      setIsExportingExcel(false);
    }
  };

  const handleNotificar = async () => {
    if (!fundInfo || !hasViolacaoEnquadramento) return;
    const info = buildEnquadramentoExportInfo();
    if (!info) return;

    setIsNotifying(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) throw new Error("Sessão não encontrada");

      const { buffer, filename } = await buildEnquadramentoFundoExcelBuffer(
        info,
        enquadramentoRules,
        assetsToExport(),
      );

      const { data, error } = await supabase.functions.invoke("send-desenquadramento-notification", {
        body: {
          origem: "manual",
          fundo_dtposicao: fundInfo.fundo_dtposicao,
          fundo_cnpj: fundInfo.fundo_cnpj,
          fundo_isin: fundInfo.fundo_isin ?? "",
          nome_fundo: displayFundName,
          excel_base64: arrayBufferToBase64(buffer),
          excel_filename: filename,
        },
      });

      if (error) throw new Error(await extractFunctionError(error));
      if (data?.error) throw new Error(data.details ?? data.error);

      toast.success(
        data?.log_warning
          ? `Notificação enviada, mas o histórico não foi salvo.`
          : `Notificação enviada — ${data?.qtd_violacoes ?? 0} violação(ões) · planilha anexa.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg.length > 300 ? `${msg.slice(0, 300)}…` : msg);
      console.error(err);
    } finally {
      setIsNotifying(false);
    }
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="flex flex-col h-[80vh] items-center justify-center space-y-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground animate-pulse font-medium">Carregando carteira...</p>
        </div>
      </Layout>
    );
  }

  if (!assets.length) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center h-[80vh] gap-6 px-4 text-center">
          <div className="p-4 bg-muted rounded-full">
            <Info className="h-8 w-8 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <p className="text-xl font-semibold tracking-tight">Carteira não encontrada</p>
            <p className="text-sm text-muted-foreground max-w-md">Não conseguimos localizar os dados de posição para este fundo no momento.</p>
          </div>
          <Button onClick={() => navigate(backPath)} variant="outline" className="gap-2">
            <ArrowLeft className="h-4 w-4" /> Voltar
          </Button>
        </div>
      </Layout>
    );
  }

  // Calculate totals by section respecting Credit/Debit
  const summaryBase = assets.reduce((acc, curr) => {
    const section = curr.section || "outros";
    const value = curr.valor_padrao || 0;
    const adjustedValue = curr.credeb === 'D' ? -value : value;
    acc[section] = (acc[section] || 0) + adjustedValue;
    return acc;
  }, {} as Record<string, number>);

  const vlCapSubscr = fipInforme?.vl_cap_subscr ?? 0;
  const bonus5pct = vlCapSubscr > 0 ? vlCapSubscr * 0.05 : 0;
  const summary = summaryBase;

  const fipCard =
    isFIP && vlCapSubscr > 0 ? (
      <FIPCapitalSubscrCard
        vlCapSubscr={vlCapSubscr}
        bonus5pct={bonus5pct}
        considerando={considerarCapitalSubscr}
        onConsiderarChange={setConsiderarCapitalSubscr}
      />
    ) : undefined;

  return (
    <Layout>
      <div className="wallet-page">
        <WalletHeader
          fundName={displayFundName}
          fundCnpj={fundInfo.fundo_cnpj}
          fundDate={fundInfo.fundo_dtposicao}
          isin={fundInfo.fundo_isin}
          prazoResgateDias={mainFundChar?.prazo_pagamento_resgate_dias}
          xmlPL={xmlPL}
          csvPL={csvPL}
          plHeaderRaw={plHeaderRaw}
          patliqOrigem={patliqOrigem}
          hasPLDiscrepancy={hasPLDiscrepancy}
          onRunCheck={handleRunCheck}
          isRunningCheck={isRunningCheck}
          showRulesPanel={true}
          toggleRulesPanel={() => {}}
          onExportPdf={handleExportPdf}
          isExporting={isExporting}
          onExportExcel={handleExportExcel}
          isExportingExcel={isExportingExcel}
          onNotificar={showEnquadramentoActions ? handleNotificar : undefined}
          isNotifying={isNotifying}
          canNotificar={hasViolacaoEnquadramento}
          backPath={backPath}
          backLabel={backLabel}
          showEnquadramentoActions={showEnquadramentoActions}
          onShowInvestidores={() => setInvestidoresOpen(true)}
        />

        {/* "Quem investe aqui" → deep-link ao Mapa de Fundos (modo passivo) */}
        {investidoresOpen && fundInfo && (() => {
          const nodeKey = buildFundoDisplayKey(fundInfo.fundo_cnpj);
          navigate(
            `/dados/mapa-ativos?tab=grafo&dt=${fundInfo.fundo_dtposicao}&node=${encodeURIComponent(nodeKey)}&dir=passivo&nivel=2`,
          );
          setInvestidoresOpen(false);
          return null;
        })()}

        <div>
          <WalletSummary
            totalPL={totalPL}
            summary={summary}
            extraCardAfterCaixa={fipCard}
            onSectionClick={(section) => setDrillSection((prev) => (prev === section ? null : section))}
            activeDrillSection={drillSection}
          />
        </div>

        {/* Panel de drill-down de Provisões — aparece imediatamente abaixo do WalletSummary */}
        {drillSection === "provisao" && (() => {
          const provisoes = assetsEnriquecidos.filter(
            (a) => (a.section || "").toLowerCase() === "provisao"
          );
          if (provisoes.length === 0) return null;

          const grupoMap: Record<string, { itens: typeof provisoes; total: number }> = {};
          provisoes.forEach((a) => {
            const grp = a.anbimaGrupo || "Outros";
            if (!grupoMap[grp]) grupoMap[grp] = { itens: [], total: 0 };
            grupoMap[grp].itens.push(a);
            const sinal = a.credeb === "D" ? -1 : 1;
            grupoMap[grp].total += sinal * (a.valor_padrao || 0);
          });

          const fmtBrl = (v: number) =>
            new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

          return (
            <div className="animate-in fade-in slide-in-from-top-2 duration-300 border border-amber-200/60 rounded-xl bg-amber-50/40 shadow-sm overflow-hidden">
              {/* Header do panel */}
              <div className="flex items-center justify-between px-5 py-3 bg-amber-100/50 border-b border-amber-200/60">
                <div className="flex items-center gap-2">
                  <Receipt className="h-4 w-4 text-amber-600" />
                  <span className="text-sm font-bold text-amber-900 tracking-tight">Detalhamento de Provisões</span>
                  <Badge variant="outline" className="text-[10px] font-bold bg-amber-100 border-amber-300 text-amber-700">
                    {provisoes.length} lançamento{provisoes.length !== 1 ? "s" : ""}
                  </Badge>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-amber-600 hover:bg-amber-200/60"
                  onClick={() => setDrillSection(null)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>

              {/* Conteúdo agrupado por grupo ANBIMA */}
              <div className="p-4 space-y-4">
                {Object.entries(grupoMap).map(([grupo, { itens, total }]) => (
                  <div key={grupo}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700/80">{grupo}</span>
                      <span className={cn(
                        "text-xs font-bold font-mono",
                        total < 0 ? "text-red-600" : "text-emerald-700"
                      )}>
                        {fmtBrl(total)}
                      </span>
                    </div>
                    <div className="rounded-lg border border-amber-200/50 overflow-hidden bg-white/60">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-amber-100 bg-amber-50/60">
                            <th className="text-left py-1.5 px-3 text-[9px] font-bold uppercase tracking-wider text-amber-700/60 w-12">Cód.</th>
                            <th className="text-left py-1.5 px-3 text-[9px] font-bold uppercase tracking-wider text-amber-700/60">Descrição</th>
                            <th className="text-center py-1.5 px-3 text-[9px] font-bold uppercase tracking-wider text-amber-700/60 w-16">D/C</th>
                            <th className="text-right py-1.5 px-3 text-[9px] font-bold uppercase tracking-wider text-amber-700/60 w-36">Valor</th>
                          </tr>
                        </thead>
                        <tbody>
                          {itens.map((a, i) => {
                            const isDebito = a.credeb === "D";
                            const nome = a.anbimaDescricao || (a.codprov ? `Lançamento cód. ${a.codprov}` : "Provisão");
                            return (
                              <tr key={i} className="border-b border-amber-100/60 last:border-0 hover:bg-amber-50/40">
                                <td className="py-2 px-3 font-mono text-muted-foreground/60">{a.codprov || "—"}</td>
                                <td className="py-2 px-3 font-medium text-foreground/90">{nome}</td>
                                <td className="py-2 px-3 text-center">
                                  <span className={cn(
                                    "inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full",
                                    isDebito
                                      ? "bg-red-50 text-red-600 border border-red-200"
                                      : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                  )}>
                                    {isDebito
                                      ? <><TrendingDown className="h-2.5 w-2.5" /> D</>
                                      : <><TrendingUp className="h-2.5 w-2.5" /> C</>
                                    }
                                  </span>
                                </td>
                                <td className={cn(
                                  "py-2 px-3 text-right font-mono font-bold",
                                  isDebito ? "text-red-600" : "text-foreground"
                                )}>
                                  {isDebito ? "-" : ""}{fmtBrl(a.valor_padrao || 0)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        <div className="space-y-8">
          {showComplianceSection && (
            <div id="monitoramento-compliance" className="wallet-rules">
              <div className="wallet-section-heading">
                <div>
                  <div className="wallet-eyebrow">Controles regulatórios</div>
                  <h2>Enquadramento</h2>
                  <p>Regras de investimento na posição</p>
                </div>
              </div>
              <RulesList
                fundoCnpj={fundInfo.fundo_cnpj}
                fundoDtposicao={fundInfo.fundo_dtposicao}
                fundoIsin={isinParam ?? (fundInfo.fundo_isin || null)}
                considerarCapitalSubscr={considerarCapitalSubscr}
                fipBonus5pct={isFIP && bonus5pct > 0 ? bonus5pct : undefined}
              />
            </div>
          )}

          {/* Section 2: Wallet Composition */}
          <div className="min-w-0">
             <WalletTable
                assets={assetsEnriquecidos}
                totalPL={totalPL}
                onSelectAsset={setSelectedAsset}
                cotasComPosicao={cotasComPosicaoSet}
                fundoDtPosicao={fundoDtPosicao}
                inlineExplosao={inlineExplosao}
                expandedCotaPath={expandedCotaPath}
                onExpandCotaAtLevel={(level, cnpj) => {
                  setExpandedCotaPath((prev) => {
                    const newPath = prev.slice(0, level);
                    if (cnpj) newPath.push(cnpj);
                    return newPath;
                  });
                }}
                pathAssetsData={inlineExplosao && pathAssetsData.length > 0 ? pathAssetsData : undefined}
                showProvisaoDetalhada={drillSection === "provisao"}
             />
          </div>

          {/* Section 3: Prazo Médio da Carteira */}
          {fundInfo && fundoDtPosicao && (
            <div className="min-w-0">
              <PrazoMedioCarteira
                fundoCnpj={fundInfo.fundo_cnpj}
                fundoDtposicao={fundoDtPosicao}
                totalPL={totalPL}
              />
            </div>
          )}

          {showComplianceSection && (
            <EnquadramentoTimeline
              fundoCnpj={fundInfo.fundo_cnpj}
              fundoIsin={isinParam ?? (fundInfo.fundo_isin || null)}
              activeDate={fundoDtPosicao ?? dateParam ?? null}
            />
          )}
        </div>
      </div>

      <WalletDetailsSheet 
        asset={selectedAsset} 
        onClose={() => setSelectedAsset(null)} 
      />
    </Layout>
  );
}
