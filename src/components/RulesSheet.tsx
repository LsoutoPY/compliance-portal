import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { categoriaEnquadramentoFromRegra } from "@/lib/regrasTributariasCatalog";
import { fundoRegrasIsinQueryValues, resolveFundoRegrasForIsin } from "@/lib/fundoRegrasUtils";
import { labelOrigemPlConcentracao } from "@/lib/fidcConcentracaoPlOrigem";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Badge as InstitutionalBadge } from "@/design-system/components/core/Badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { 
  ClipboardCheck,
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Loader2,
  Wallet,
  Users,
  Droplets,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  ShieldAlert,
  BarChart2,
  Receipt
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MmTributariaChart,
  anoFromDtPosicao,
  dtPosicaoToIso,
  useMmHistorico,
} from "@/components/tributario/MmTributariaChart";
import { TributarioRegraInfoDialog } from "@/components/tributario/TributarioRegraInfoDialog";
import { TribFimPrazoMedio, effectiveTribArt4Status } from "@/components/enquadramento/TribFimPrazoMedio";
import { MinAlocacaoContadores } from "@/components/enquadramento/MinAlocacaoContadores";
import {
  effectiveMinAlocacaoStatus,
  isRegraMinAlocacaoFidc,
  resolveMaxEventosMinAloc12m,
} from "@/lib/minAlocacaoContadores";
import {
  resolveTributarioMetrics,
  tributarioPDiaDisplay,
  tributarioMm10dDisplay,
} from "@/lib/tributarioMetrics";
import { calcularContadoresAnoFromSeries } from "@/lib/tributarioMm10d";
import { fetchTributarioAtivosFallback } from "@/lib/tributarioAtivosFallback";
import {
  type ComplianceStatus,
  resolveFipClasseCompliance,
  resolveStoredComplianceStatus,
} from "@/lib/fipClasseCompliance";

interface RuleResult {
  id: string;
  regra_codigo: string;
  regra_descricao: string;
  regra_categoria: string;
  status: 'ok' | 'alerta' | 'violacao';
  valor_atual: number | null;
  valor_limite: number | null;
  detalhes: Record<string, unknown> | null;
}

interface RulesSheetProps {
  fundoCnpj: string;
  fundoDtposicao: string;
  /** ISIN da subclasse do fundo. Quando fornecido, filtra resultados por subclasse. */
  fundoIsin?: string | null;
  trigger?: React.ReactNode;
}

const categoryConfig: Record<string, { label: string; icon: React.ElementType }> = {
  pl: { 
    label: "PL", 
    icon: Wallet, 
  },
  concentration: { 
    label: "Concentração", 
    icon: Users, 
  },
  liquidity: { 
    label: "Liquidez", 
    icon: Droplets, 
  },
  classe: { 
    label: "Classe", 
    icon: ClipboardCheck, 
  },
  relacional: { 
    label: "Manual", 
    icon: ShieldAlert, 
  },
  "fidc-concentracao": {
    label: "Conc. FIDC",
    icon: BarChart2,
  },
  "fidc-estrutura": {
    label: "Estrutura FIDC",
    icon: BarChart2,
  },
  tributario: {
    label: "Tributário",
    icon: Receipt,
  },
  "tributario-art4": {
    label: "Tributário Art. 4º",
    icon: Receipt,
  },
  "tributario-art4-fidc": {
    label: "Tributário Art. 4º FIDC",
    icon: Receipt,
  },
};

function isTribArt4PrazoMedioRule(rule: Pick<RuleResult, "regra_codigo" | "regra_categoria">): boolean {
  const codigo = (rule.regra_codigo || "").toUpperCase();
  const categoria = (rule.regra_categoria || "").toLowerCase();
  return (
    codigo === "TRIB_FIM_LP_365" ||
    codigo === "TRIB_FIDC_LP_365" ||
    categoria === "tributario-art4" ||
    categoria === "tributario-art4-fidc"
  );
}

function cnpjQueryVariants(cnpj: string): string[] {
  const clean = cnpj.replace(/\D/g, "").padStart(14, "0");
  const formatted = clean.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    "$1.$2.$3/$4-$5",
  );
  return [...new Set([cnpj, clean, formatted])].filter(Boolean);
}

const statusConfig = {
  ok: {
    label: "Regular",
    icon: CheckCircle2,
    className: "text-emerald-600 border-emerald-200",
    iconClass: "text-emerald-600",
  },
  alerta: {
    label: "Alerta",
    icon: AlertTriangle,
    className: "text-amber-600 border-amber-200",
    iconClass: "text-amber-600",
  },
  violacao: {
    label: "Violação",
    icon: XCircle,
    className: "text-red-600 border-red-200",
    iconClass: "text-red-600",
  },
};

interface RulesListProps {
  fundoCnpj: string;
  fundoDtposicao: string;
  /** ISIN da subclasse do fundo. Quando fornecido, filtra resultados por subclasse. */
  fundoIsin?: string | null;
  className?: string;
  maxHeight?: string;
  /** Quando false, CLASSE_FIP_90 exibe perc_participacoes_sem_bonus em vez de valor_atual */
  considerarCapitalSubscr?: boolean;
  /** Bônus 5% do capital subscrito (do frontend) para recalcular Valor Atual quando toggle ON */
  fipBonus5pct?: number;
}

export function RulesList({ fundoCnpj, fundoDtposicao, fundoIsin, className, maxHeight, considerarCapitalSubscr = true, fipBonus5pct }: RulesListProps) {
  const [expandedRule, setExpandedRule] = useState<string | null>(null);
  const [expandedGrupos, setExpandedGrupos] = useState<Set<string>>(new Set());

  const toggleGrupo = (key: string) =>
    setExpandedGrupos((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["enquadramento-rules", fundoCnpj, fundoDtposicao, fundoIsin],
    enabled: !!fundoCnpj && !!fundoDtposicao,
    queryFn: async () => {
      const cnpjVars = cnpjQueryVariants(fundoCnpj);

      let rulesQuery = supabase
        .from("enquadramento_resultado" as any)
        .select("*")
        .in("fundo_cnpj", cnpjVars)
        .eq("fundo_dtposicao", fundoDtposicao)
        .order("regra_categoria", { ascending: true })
        .order("status", { ascending: false });
      if (fundoIsin) rulesQuery = (rulesQuery as any).eq("fundo_isin", fundoIsin);

      const [{ data, error }, { data: assocDataRaw }] = await Promise.all([
        rulesQuery,
        supabase
          .from("fundo_regras")
          .select("fundo_isin, regra_id, regras_compliance (codigo, descricao, parametros)")
          .in("fundo_cnpj", cnpjVars)
          .in("fundo_isin", fundoRegrasIsinQueryValues(fundoIsin))
          .eq("ativo", true)
          .eq("status_aprovacao", "ativo"),
      ]);

      const assocData = resolveFundoRegrasForIsin(assocDataRaw, fundoIsin);

      if (error) {
        console.error("Erro ao buscar regras:", error);
        throw error;
      }

      const results = (data || []) as RuleResult[];
      const codigosComResultado = new Set(results.map((r) => r.regra_codigo));

      for (const assoc of assocData || []) {
        const rule = Array.isArray(assoc.regras_compliance)
          ? assoc.regras_compliance[0]
          : assoc.regras_compliance;
        const codigo = (rule as { codigo?: string; descricao?: string; parametros?: Record<string, unknown> } | null)?.codigo;
        const parametros = (rule as { parametros?: Record<string, unknown> } | null)?.parametros;
        const categoria = codigo ? categoriaEnquadramentoFromRegra(codigo, parametros) : null;
        if (!codigo || !categoria || codigosComResultado.has(codigo)) continue;

        results.push({
          id: `pending-${codigo}`,
          regra_codigo: codigo,
          regra_descricao: (rule as { descricao?: string }).descricao || codigo,
          regra_categoria: categoria,
          status: "alerta",
          valor_atual: null,
          valor_limite: null,
          detalhes: {
            pendente_verificacao: true,
            motivo: "Regra associada — clique em Rodar Verificação para calcular",
          },
        });
      }

      return results;
    },
  });

  const dataAteIso = dtPosicaoToIso(fundoDtposicao);
  const { data: histFetch } = useMmHistorico(fundoCnpj, dataAteIso);
  const histForDate = useMemo(() => {
    const rows = histFetch?.rows ?? [];
    if (!dataAteIso) return rows.length > 0 ? rows[rows.length - 1] : null;
    return rows.find((r) => r.data_referencia === dataAteIso) ?? rows[rows.length - 1] ?? null;
  }, [histFetch?.rows, dataAteIso]);

  const contadoresAnoTrib = useMemo(() => {
    const rows = histFetch?.rows ?? [];
    const ano = anoFromDtPosicao(fundoDtposicao) ?? new Date().getFullYear();
    const noAno = rows.filter((r) => r.data_referencia.startsWith(`${ano}-`));
    return calcularContadoresAnoFromSeries(
      noAno.map((r) => ({
        data_referencia: r.data_referencia,
        mm_10d: Number(r.mm_10d),
      })),
    );
  }, [histFetch?.rows, fundoDtposicao]);

  const needsAtivosFallback = useMemo(() => {
    if (!expandedRule) return false;
    const rule = rules.find((r) => r.id === expandedRule);
    if (!rule || rule.regra_categoria !== "tributario" || isTribArt4PrazoMedioRule(rule)) {
      return false;
    }
    const det = rule.detalhes as Record<string, unknown> | null;
    const ativos = (det?.ativos_contabilizados ?? det?.ativos_vedados) as unknown[] | undefined;
    return !(Array.isArray(ativos) && ativos.length > 0);
  }, [expandedRule, rules]);

  const { data: ativosFallback = [], isLoading: ativosFallbackLoading } = useQuery({
    queryKey: ["trib-ativos-fallback", fundoCnpj, fundoDtposicao, dataAteIso],
    enabled: needsAtivosFallback && !!dataAteIso,
    staleTime: 60_000,
    queryFn: () => fetchTributarioAtivosFallback(fundoCnpj, fundoDtposicao, dataAteIso!),
  });

  const formatCurrency = (value: number | null) => {
    if (value === null) return "-";
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(value);
  };

  const formatCurrencyCompact = (value: number | null) => {
    if (value === null) return "-";
    try {
      return new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
    } catch {
      return formatCurrency(value);
    }
  };

  const formatPercentage = (value: number | null) => {
    if (value === null) return "-";
    return `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value * 100)}%`;
  };

  const formatPrazoMedioDias = (value: number | null) => {
    if (value === null) return "-";
    return `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value * 365)}d`;
  };

  // Função para recalcular a descrição de regras de agrupamento conjunto
  const getDisplayDescricao = (rule: RuleResult) => {
    const detalhes = rule.detalhes as Record<string, unknown> | undefined;
    
    // Tenta pegar dos parametros dentro de detalhes (após processar motor)
    let params = detalhes?.parametros as Record<string, unknown> | undefined;
    
    // Fallback: tenta pegar do componentes_breakdown para inferir o modo
    if (!params) {
      const breakdown = detalhes?.componentes_breakdown as any[] | undefined;
      if (breakdown && breakdown.length > 0) {
        // Verifica se tem componentes do tipo 'regra'
        const temRegras = breakdown.some((comp: any) => comp.tipo === 'regra');
        const limiteMax = rule.valor_limite as number | undefined;
        const pct = limiteMax != null ? Math.round(limiteMax * 100) : 0;
        
        if (temRegras) {
          return `Limite conjunto (${breakdown.length} regras) — máximo ${pct}% do PL`;
        } else {
          return `Limite conjunto (${breakdown.length} componentes) — máximo ${pct}% do PL`;
        }
      }
    } else if (params?.tipo_regra === "agrupamento_conjunto") {
      const regrasBase = params.regras_base as string[] | undefined;
      const componentes = params.componentes as any[] | undefined;
      const limiteMax = params.limite_max as number | undefined;
      const pct = limiteMax != null ? Math.round(limiteMax * 100) : 0;
      
      if (regrasBase && regrasBase.length > 0) {
        return `Limite conjunto (${regrasBase.length} regras) — máximo ${pct}% do PL`;
      } else if (componentes && componentes.length > 0) {
        return `Limite conjunto (${componentes.length} componentes) — máximo ${pct}% do PL`;
      }
    }
    
    return rule.regra_descricao;
  };

  const getValueFormat = (rule: RuleResult) => {
    const codigo = (rule.regra_codigo || "").toUpperCase();
    const categoria = (rule.regra_categoria || "").toLowerCase();
    if (categoria === "pl" || codigo === "PL_MIN") return formatCurrency;
    if (isTribArt4PrazoMedioRule({ regra_codigo: codigo, regra_categoria: categoria })) {
      return formatPrazoMedioDias;
    }
    return formatPercentage;
  };

  const resolveDisplayStatus = (
    rule: RuleResult,
    d: Record<string, unknown> | null,
    fipStatus?: ComplianceStatus,
  ): ComplianceStatus => {
    if (rule.regra_codigo === "CLASSE_FIP_90" && fipStatus) return fipStatus;
    if (isTribArt4PrazoMedioRule(rule)) return effectiveTribArt4Status(rule.status, d);
    if (isRegraMinAlocacaoFidc({ ...rule, detalhes: d })) {
      return effectiveMinAlocacaoStatus(rule.status, d);
    }
    return rule.status;
  };

  const getRuleStatusLabel = (rule: RuleResult, displayStatus?: ComplianceStatus): string => {
    const d = rule.detalhes as Record<string, unknown> | null;
    if (d?.pendente_verificacao) return "Pendente";
    if (d?.norma_nao_aplicavel && d?.p_dia == null && rule.valor_atual == null) return "Não aplicável";
    return statusConfig[displayStatus ?? resolveDisplayStatus(rule, d)].label;
  };

  const getStatusTooltip = (
    rule: RuleResult,
    displayStatus?: ComplianceStatus,
    displayValue?: number | null,
  ): string => {
    const d = rule.detalhes as Record<string, unknown> | null;
    if (d?.pendente_verificacao) {
      return String(d.motivo || "Rode a verificação de enquadramento para calcular esta regra.");
    }
    if (d?.norma_nao_aplicavel) {
      const sugerida = d.regra_sugerida as string | undefined;
      const motivo = String(d.motivo || "Norma não aplicável a este fundo.");
      return sugerida
        ? `${motivo} Associe e verifique a regra ${sugerida}.`
        : motivo;
    }
    const codigo = (rule.regra_codigo || "").toUpperCase();
    const isFipClasse = codigo === "CLASSE_FIP_90";
    const va = isFipClasse && displayValue !== undefined ? displayValue : rule.valor_atual;
    const vl = rule.valor_limite;
    const formatter = getValueFormat(rule);
    if (isTribArt4PrazoMedioRule(rule)) {
      const st = effectiveTribArt4Status(rule.status, d);
      const prazo = Number(d?.prazo_medio_dias ?? 0);
      const limite = Number(d?.limite_dias ?? 365);
      const alerta = Number(d?.alerta_dias ?? 367);
      const avisos = Array.isArray(d?.avisos_dados) ? (d.avisos_dados as string[]) : [];
      const avisoExtra = avisos.length > 0 ? ` Avisos: ${avisos.join("; ")}.` : "";
      if (st === "ok") {
        return `LP tributário: prazo médio ${prazo.toFixed(2)}d (acima de ${alerta}d).${avisoExtra}`;
      }
      if (st === "alerta") {
        return `Margem estreita: prazo médio ${prazo.toFixed(2)}d (entre ${limite}d e ${alerta}d).${avisoExtra}`;
      }
      return `CP tributário: prazo médio ${prazo.toFixed(2)}d ≤ ${limite}d.${avisoExtra}`;
    }
    const effectiveStatus = isFipClasse
      ? displayStatus ?? resolveDisplayStatus(rule, d)
      : rule.status;
    if (effectiveStatus === "ok") {
      return "Regra em conformidade.";
    }
    if (codigo === "PL_MIN") {
      const periodoGraca = d?.periodo_graça as boolean | undefined;
      const diasConsec = d?.dias_consecutivos_abaixo_1m as number | undefined;
      if (periodoGraca) return "Período de graça (menos de 90 dias desde o início das atividades).";
      if (rule.status === "violacao" && diasConsec != null && diasConsec >= 90) {
        return `PL abaixo de R$ 1.000.000 por ${diasConsec} dias consecutivos. Liquidação ou incorporação exigida.`;
      }
      if (rule.status === "alerta") {
        const dias = diasConsec != null && diasConsec > 0 ? diasConsec : null;
        const prefixo = dias != null ? `${dias} dia${dias !== 1 ? "s" : ""} com ` : "";
        return `${prefixo}PL (${formatter(va)}) abaixo do mínimo. Atenção: se mantiver por 90 dias consecutivos, exigida liquidação ou incorporação.`;
      }
      return `PL (${formatter(va)}) abaixo do mínimo de R$ 1.000.000.`;
    }
    if (isRegraMinAlocacaoFidc({ ...rule, detalhes: d })) {
      const st = resolveDisplayStatus(rule, d);
      const ev = Number(d?.eventos_12m ?? 0);
      const dias = Number(d?.dias_violacao_12m ?? 0);
      const maxEv = resolveMaxEventosMinAloc12m(vl, d);
      const maxDias = Number(d?.max_dias_violacao_12m ?? 30);
      if (st === "violacao" && (ev >= maxEv || dias >= maxDias)) {
        return `Limite regulatório: ${ev}/${maxEv} eventos e ${dias}/${maxDias} dias em violação nos últimos 12 meses.`;
      }
      if (st === "violacao") {
        return `Alocação (${formatter(va)}) abaixo do mínimo (${formatter(vl)}).`;
      }
      if (st === "alerta") {
        return `Alocação (${formatter(va)}) próxima ou abaixo do mínimo (${formatter(vl)}).`;
      }
      return `Alocação (${formatter(va)}) dentro do mínimo (${formatter(vl)}). Eventos 12m: ${ev}/${maxEv}, dias: ${dias}/${maxDias}.`;
    }
    if (codigo === "CLASSE_FIDC_67") {
      return `Investimento em FIDCs (${formatter(va)}) abaixo do mínimo de 67%.`;
    }
    if (codigo === "CLASSE_FIP_90") {
      if (effectiveStatus === "alerta") {
        return `Participações em empresas-alvo (${formatter(va)}) próximas do limite mínimo (${formatter(vl)}).`;
      }
      return `Participações em empresas-alvo (${formatter(va)}) abaixo do mínimo de 90%.`;
    }
    if (codigo === "CLASSE_FII_67") {
      return `Investimento em imóveis (${formatter(va)}) abaixo do mínimo de 67%.`;
    }
    if (rule.regra_categoria === "relacional" || rule.regra_categoria === "relational") {
      const tipoFundo = d?.tipo_fundo as string | undefined;
      const catsVed = d?.categorias_vedadas as string[] | undefined;
      const catVed = d?.categoria_vedada as string | undefined;
      const catLabel = catsVed?.length ? catsVed.join(", ") : catVed;
      if (d?.categoria_vedada || catLabel) {
        return tipoFundo ? `${tipoFundo} não pode ter cotas de ${catLabel}.` : `Vedação: cotas de ${catLabel} não permitidas.`;
      }
      return `Valor atual (${formatter(va)}) fora do limite (${formatter(vl)}).`;
    }
    if (rule.regra_categoria === "fidc-concentracao") {
      if (d?.sem_dados) return `Sem dados de estoque FIDC para calcular esta regra.`;
      const catAlvo = d?.categoria_alvo as string | undefined;
      const ofensor = d?.principal_ofensor as { nome?: string; percentual_pl?: number } | undefined;
      if (ofensor?.nome) {
        return `${catAlvo ? `${catAlvo}: ` : ""}${ofensor.nome} representa ${ofensor.percentual_pl?.toFixed(2) ?? "?"}% do PL (limite: ${formatter(vl)}).`;
      }
      return `Concentração (${formatter(va)}) acima do limite (${formatter(vl)}).`;
    }
    if (rule.regra_categoria === "fidc-estrutura") {
      if (d?.sem_dados) return String(d?.motivo ?? "Sem dados para calcular subordinação.");
      const idx = d?.indice_calculado != null ? Number(d.indice_calculado) : va;
      return `Subordinação ${(idx * 100).toFixed(2)}% (mínimo ${formatter(vl)}).`;
    }
    return `Valor atual (${formatter(va)}) fora do limite (${formatter(vl)}).`;
  };

  const getCategoryLabel = (rule: RuleResult) => {
    const config = categoryConfig[rule.regra_categoria] || { label: rule.regra_categoria, icon: ClipboardCheck };
    if (rule.regra_categoria === "fidc-concentracao") {
      const d = rule.detalhes as Record<string, unknown> | null;
      const catAlvo = d?.categoria_alvo as string | undefined;
      return catAlvo ? `${config.label}: ${catAlvo}` : config.label;
    }
    if (rule.regra_categoria === "fidc-estrutura") {
      const d = rule.detalhes as Record<string, unknown> | null;
      const alvo = d?.classe_alvo as string | undefined;
      return alvo ? `${config.label}: ${alvo}` : config.label;
    }
    if (rule.regra_categoria === "relacional" || rule.regra_categoria === "relational") {
      const d = rule.detalhes as Record<string, unknown> | null;
      const override = d?.categoria_display as string | undefined;
      if (override) return override;
      const cat = d?.categoria_alvo as string | undefined;
      const tipoFundo = d?.tipo_fundo as string | undefined;
      const catVedada = d?.categoria_vedada as string | undefined;
      const catsVedadas = d?.categorias_vedadas as string[] | undefined;
      const catLabel = catsVedadas?.length ? catsVedadas.join(", ") : catVedada;
      const tipoAlvo = d?.tipo_alvo as string | undefined;
      const catInvestidor = d?.categoria_alvo as string | undefined; // Para regras limite_por_tipo_investidor + categoria
      if ((tipoFundo || d?.fundos_cnpj) && catLabel) return `${tipoFundo || "Fundos"} ≠ ${catLabel}`;
      if (tipoAlvo && catInvestidor && d?.mesma_administradora) return `${tipoAlvo} + ${catInvestidor} + Mesma Adm.`;
      if (tipoAlvo && d?.mesma_administradora) return `${tipoAlvo} + Mesma Adm.`;
      if (tipoAlvo && catInvestidor) return `${tipoAlvo} + ${catInvestidor}`;
      return cat || tipoAlvo || config.label;
    }
    return config.label;
  };

  // Group rules by category
  const rulesByCategory = rules.reduce((acc, rule) => {
    const category = rule.regra_categoria || "outros";
    if (!acc[category]) acc[category] = [];
    acc[category].push(rule);
    return acc;
  }, {} as Record<string, RuleResult[]>);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 px-4">
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium">Sincronizando regras...</span>
      </div>
    );
  }

  if (rules.length === 0) {
    return (
      <div className="py-4 px-4 text-[10px] text-muted-foreground uppercase tracking-wider font-medium italic">
        Sem dados de enquadramento
      </div>
    );
  }

  const content = (
    <div className={cn("wallet-rules__panel", className)}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent bg-muted/30 h-12 border-b border-border/50">
            <TableHead className="w-[50%] text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground pl-6">Regra de Compliance</TableHead>
            <TableHead className="w-[15%] text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground text-center">Categoria</TableHead>
            <TableHead className="w-[15%] text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground text-right">Valor Atual</TableHead>
            <TableHead className="w-[15%] text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground text-right">Limite</TableHead>
            <TableHead className="w-[5%] text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground text-right pr-6">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(rulesByCategory).map(([category, categoryRules]) => {
            const config = categoryConfig[category] || { label: category, icon: ClipboardCheck };
            const CategoryIcon = config.icon;

            return (
              <React.Fragment key={category}>
                {categoryRules.map((rule) => {
                  const formatter = getValueFormat(rule);
                  const isExpanded = expandedRule === rule.id;
                  const detalhes = rule.detalhes as Record<string, unknown> | null;
                  const showMinAlocContadores = isRegraMinAlocacaoFidc({
                    ...rule,
                    detalhes,
                  });
                  const patliqXml = typeof detalhes?.patliq_xml === "number" ? detalhes.patliq_xml : null;
                  const patliqCsv = typeof detalhes?.patliq_csv === "number" ? detalhes.patliq_csv : null;
                  const hasPLDiscrepancy = Boolean(detalhes?.patliq_divergente) && patliqXml !== null && patliqCsv !== null;
                  const contributionAssetsStored =
                    ((detalhes?.ativos_contabilizados ?? detalhes?.ativos_vedados) as any[]) || [];
                  const contributionAssets =
                    contributionAssetsStored.length > 0
                      ? contributionAssetsStored
                      : isExpanded &&
                          rule.regra_categoria === "tributario" &&
                          !isTribArt4PrazoMedioRule(rule)
                        ? ativosFallback
                        : [];
                  const usingAtivosFallback =
                    contributionAssetsStored.length === 0 && contributionAssets.length > 0;
                  const patliq = (detalhes?.patliq as number) ?? 0;
                  let valorExibir: number | null = rule.valor_atual;
                  let displayStatus = resolveDisplayStatus(rule, detalhes);
                  if (rule.regra_codigo === "CLASSE_FIP_90") {
                    const presentation = resolveFipClasseCompliance({
                      storedValue: rule.valor_atual,
                      storedStatus: rule.status,
                      minimumLimit: rule.valor_limite,
                      alertLimit: typeof detalhes?.limite_alerta === "number"
                        ? detalhes.limite_alerta
                        : rule.valor_limite === 0.9
                          ? 0.92
                          : null,
                      totalParticipacoes: typeof detalhes?.total_participacoes === "number"
                        ? detalhes.total_participacoes
                        : null,
                      patliq,
                      percParticipacoesSemBonus: typeof detalhes?.perc_participacoes_sem_bonus === "number"
                        ? detalhes.perc_participacoes_sem_bonus
                        : null,
                      bonus5pct: fipBonus5pct ?? (
                        typeof detalhes?.bonus_5pct_cap_subscrito === "number"
                          ? detalhes.bonus_5pct_cap_subscrito
                          : null
                      ),
                      considerarCapitalSubscr,
                      emCarenciaMinimoAlocacao: detalhes?.em_carencia_minimo_alocacao === true,
                    });
                    valorExibir = presentation.value;
                    displayStatus = presentation.status;
                  } else if (rule.regra_categoria === "tributario") {
                    const pDiaDisplay = tributarioPDiaDisplay(detalhes, histForDate);
                    if (pDiaDisplay != null) valorExibir = pDiaDisplay;
                  }

                  const statusConf = statusConfig[displayStatus];
                  const StatusIcon = statusConf.icon;

                  const tribMetrics =
                    rule.regra_categoria === "tributario"
                      ? {
                          ...resolveTributarioMetrics(detalhes, histForDate, rule.valor_atual),
                          ...(histForDate
                            ? {
                                mm_10d: Number(histForDate.mm_10d),
                                eventos_ano: contadoresAnoTrib.eventos_ano,
                                dias_violacao_ano: contadoresAnoTrib.dias_violacao_ano,
                              }
                            : {
                                eventos_ano: contadoresAnoTrib.eventos_ano,
                                dias_violacao_ano: contadoresAnoTrib.dias_violacao_ano,
                              }),
                        }
                      : null;

                  return (
                    <React.Fragment key={rule.id}>
                      <TableRow
                        role="button"
                        tabIndex={0}
                        aria-expanded={isExpanded}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setExpandedRule(isExpanded ? null : rule.id);
                          }
                        }}
                        className={cn(
                          "h-14 hover:bg-muted/30 transition-colors group border-b border-border/40 last:border-0 cursor-pointer",
                          displayStatus === 'violacao' ? "bg-red-50/30" : 
                          displayStatus === 'alerta' ? "bg-amber-50/30" : 
                          "bg-emerald-50/10",
                          isExpanded && "bg-muted/20"
                        )}
                        onClick={() => setExpandedRule(isExpanded ? null : rule.id)}
                      >
                        <TableCell className="pl-6 py-3">
                          <div className="flex items-center gap-3">
                            <div className="text-muted-foreground/40 group-hover:text-primary transition-colors">
                              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </div>
                            <span className="text-[13px] font-semibold text-foreground leading-snug">
                              {getDisplayDescricao(rule)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-center py-3">
                          <InstitutionalBadge tone="neutral">
                            <CategoryIcon className="h-3 w-3" />
                            {(rule.regra_categoria === "relacional" || rule.regra_categoria === "relational" || rule.regra_categoria === "fidc-concentracao") ? getCategoryLabel(rule) : config.label}
                          </InstitutionalBadge>
                        </TableCell>
                        <TableCell className="text-right py-3">
                          <span className={cn(
                            "font-mono text-sm font-bold",
                            displayStatus === 'violacao' ? "text-red-600" : 
                            displayStatus === 'alerta' ? "text-amber-600" : 
                            "text-emerald-600"
                          )}>
                            {formatter(valorExibir)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right py-3">
                          <span className="font-mono text-xs text-muted-foreground/80">
                            {formatter(rule.valor_limite)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right py-3 pr-6">
                          <div className="flex justify-end">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <InstitutionalBadge tone={displayStatus === "violacao" ? "negative" : displayStatus === "alerta" ? "warning" : "positive"}>
                                  <StatusIcon className="h-3.5 w-3.5" />
                                  {getRuleStatusLabel(rule, displayStatus)}
                                </InstitutionalBadge>
                              </TooltipTrigger>
                              <TooltipContent side="left" className="max-w-xs text-xs">
                                <p className="font-semibold text-foreground/90">{getRuleStatusLabel(rule, displayStatus)}</p>
                                <p className="text-muted-foreground mt-0.5">{getStatusTooltip(rule, displayStatus, valorExibir)}</p>
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </TableCell>
                      </TableRow>

                      {isExpanded && detalhes && (
                        <TableRow className="bg-muted/5 border-b border-border/40 hover:bg-muted/5">
                          <TableCell colSpan={5} className="p-0">
                            {isTribArt4PrazoMedioRule(rule) ? (
                              <div className="px-8 py-4 animate-in fade-in slide-in-from-top-2 duration-300">
                                <TribFimPrazoMedio
                                  detalhes={detalhes}
                                  status={displayStatus}
                                  fundoCnpj={fundoCnpj}
                                  fundoDtposicao={fundoDtposicao}
                                  fundoIsin={fundoIsin}
                                  regraCodigo={rule.regra_codigo}
                                />
                              </div>
                            ) : (
                            <div className="px-14 py-4 space-y-3 animate-in fade-in slide-in-from-top-2 duration-300">

                              {/* Resumo numérico da regra (sempre visível) */}
                              {(detalhes.total_imoveis != null || detalhes.total_participacoes != null || detalhes.total_fidc != null || detalhes.total_investido != null || detalhes.patliq != null) && (
                                <div className="space-y-2 pb-3 border-b border-border/40">
                                  <div className="flex items-center gap-2 flex-wrap w-full">
                                  <div className="flex items-center gap-6 flex-wrap flex-1 min-w-0">
                                    {detalhes.patliq != null && (
                                      <div className="flex flex-col">
                                        <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                                          PL do Fundo
                                          {detalhes.patliq_origem_utilizada === "fidc_header" && (
                                            <span className="ml-1 font-mono normal-case text-indigo-600 dark:text-indigo-400">
                                              (Header FIDC)
                                            </span>
                                          )}
                                          {rule.regra_categoria === "fidc-concentracao" && detalhes.origem_pl_utilizada != null && (
                                            <span className={`ml-1 font-mono normal-case ${
                                              detalhes.origem_pl_fallback && detalhes.origem_pl_utilizada !== 'fidc_header' && detalhes.origem_pl_utilizada !== 'pl_mes_anterior_posicao'
                                                ? 'text-amber-500'
                                                : detalhes.pl_sub_origem === 'fidc_header' || detalhes.origem_pl_utilizada === 'fidc_header'
                                                  ? 'text-indigo-600 dark:text-indigo-400'
                                                  : 'text-muted-foreground'
                                            }`}>
                                              ({labelOrigemPlConcentracao(detalhes)})
                                            </span>
                                          )}
                                        </span>
                                        <span className="font-mono text-sm text-foreground font-semibold">
                                          {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(detalhes.patliq as number)}
                                        </span>
                                        {hasPLDiscrepancy && (
                                          <span className="mt-1 inline-flex items-center gap-1 text-[9px] font-bold bg-amber-50 border border-amber-300 text-amber-700 dark:bg-amber-950/40 dark:border-amber-700 dark:text-amber-400 rounded px-1.5 py-0.5 w-fit">
                                            <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
                                            XML {formatCurrencyCompact(patliqXml)} → CSV {formatCurrencyCompact(patliqCsv)}
                                          </span>
                                        )}
                                      </div>
                                    )}
                                    {(detalhes.total_imoveis ?? detalhes.total_participacoes ?? detalhes.total_fidc ?? detalhes.total_investido) != null && (
                                      <div className="flex flex-col">
                                        <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                                          {detalhes.total_imoveis != null ? 'Total Qualificado' :
                                           detalhes.total_participacoes != null ? 'Total Participações' :
                                           detalhes.total_fidc != null ? 'Total FIDC' : 'Montante Considerado'}
                                        </span>
                                        <span className={cn(
                                          "font-mono text-sm font-semibold",
                                          Number(detalhes.total_fidc) < 0 ? "text-red-600" : "text-foreground"
                                        )}>
                                          {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
                                            (detalhes.total_imoveis ?? detalhes.total_participacoes ?? detalhes.total_fidc ?? detalhes.total_investido) as number
                                          )}
                                        </span>
                                        {Number(detalhes.total_fidc) < 0 && (
                                          <span className="text-[10px] text-red-600 max-w-[220px] leading-tight">
                                            Numerador negativo: PDD/ajuste entrou como “investimento”. Rode a verificação de novo.
                                          </span>
                                        )}
                                      </div>
                                    )}
                                    {detalhes.total_pdd_fidc != null && Number(detalhes.total_pdd_fidc) < 0 && (
                                      <div className="flex flex-col">
                                        <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">PDD (fora dos 67%)</span>
                                        <span className="font-mono text-sm text-amber-700 dark:text-amber-400 font-semibold">
                                          {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(detalhes.total_pdd_fidc))}
                                        </span>
                                      </div>
                                    )}
                                    {showMinAlocContadores && (
                                      <div className="w-full basis-full mt-1">
                                        <MinAlocacaoContadores
                                          fundoCnpj={fundoCnpj}
                                          fundoDtposicao={fundoDtposicao}
                                          fundoIsin={fundoIsin}
                                          regraCodigo={rule.regra_codigo}
                                          status={displayStatus}
                                          detalhes={detalhes}
                                          valorLimite={rule.valor_limite}
                                        />
                                      </div>
                                    )}
                                    <div className="flex flex-col">
                                      {detalhes?.qtd_desenquadrados != null ? (
                                        <>
                                          <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Qtd. Desenq.</span>
                                          <span className={cn("font-mono text-sm font-bold",
                                            Number(detalhes.qtd_desenquadrados) > 0 ? 'text-red-600' : 'text-emerald-600'
                                          )}>
                                            {Number(detalhes.qtd_desenquadrados)}
                                          </span>
                                        </>
                                      ) : (
                                        <>
                                          <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                                            {rule.regra_categoria === "tributario"
                                              ? "p do dia (atual)"
                                              : isTribArt4PrazoMedioRule(rule)
                                                ? "Prazo médio"
                                                : "% Calculado"}
                                          </span>
                                          <span className={cn("font-mono text-sm font-bold",
                                            rule.status === 'violacao' ? 'text-red-600' :
                                            rule.status === 'alerta'   ? 'text-amber-600' : 'text-emerald-600'
                                          )}>
                                            {rule.regra_categoria === "tributario" && tribMetrics?.hasData
                                              ? formatPercentage(tributarioPDiaDisplay(detalhes, histForDate))
                                              : formatter(rule.valor_atual)}
                                          </span>
                                          {rule.regra_categoria === "tributario" && tribMetrics && tribMetrics.hasData && (
                                            <span className="text-[9px] text-muted-foreground font-mono">
                                              MM-10d: {tribMetrics.mm_10d.toFixed(2)}%
                                            </span>
                                          )}
                                          {isTribArt4PrazoMedioRule(rule) && (detalhes.classificacao_tributaria as string) && (
                                            <span className="text-[9px] text-muted-foreground font-mono uppercase">
                                              classificação: {String(detalhes.classificacao_tributaria)}
                                            </span>
                                          )}
                                        </>
                                      )}
                                    </div>
                                    {rule.valor_limite != null && (
                                      <div className="flex flex-col">
                                        <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Limite</span>
                                        <span className="font-mono text-sm text-muted-foreground">
                                          {isTribArt4PrazoMedioRule(rule)
                                            ? formatPrazoMedioDias(rule.valor_limite)
                                            : formatPercentage(rule.valor_limite)}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                  {rule.regra_categoria === "tributario" && (
                                    <TributarioRegraInfoDialog className="self-start" />
                                  )}
                                  </div>

                                  {/* Breakdown FII: imóveis diretos vs RF imobiliária (CRI, LCI…) */}
                                  {(detalhes.total_imoveis_diretos != null || detalhes.total_rf_imob != null) && (
                                    <div className="flex items-center gap-4 flex-wrap pt-1">
                                      {detalhes.total_imoveis_diretos != null && (
                                        <div className="flex items-center gap-1.5 text-[10px]">
                                          <span className="inline-block w-2 h-2 rounded-sm bg-blue-400 shrink-0" />
                                          <span className="text-muted-foreground">Imóveis diretos:</span>
                                          <span className="font-mono font-semibold text-foreground">
                                            {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 }).format(detalhes.total_imoveis_diretos as number)}
                                          </span>
                                        </div>
                                      )}
                                      {detalhes.total_rf_imob != null && (
                                        <div className="flex items-center gap-1.5 text-[10px]">
                                          <span className="inline-block w-2 h-2 rounded-sm bg-violet-400 shrink-0" />
                                          <span className="text-muted-foreground">CRI / LCI / LIG:</span>
                                          <span className="font-mono font-semibold text-foreground">
                                            {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 }).format(detalhes.total_rf_imob as number)}
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Resumo tributário — LP / CP / Excluído + MM-10d */}
                              {rule.regra_categoria === "tributario" && detalhes && (
                                <div className="space-y-3 pt-2 pb-3 border-b border-border/40">
                                  {/* Barra de composição */}
                                  {(() => {
                                    const m = tribMetrics ?? resolveTributarioMetrics(detalhes, histForDate, rule.valor_atual);
                                    const fmtBRL = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 }).format(v);
                                    return (
                                      <>
                                        {/* Três cartões: LP · CP · Excluído */}
                                        <div className="grid grid-cols-3 gap-2">
                                          <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800 p-2.5">
                                            <p className="text-[9px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1">Longo Prazo (LP)</p>
                                            <p className="font-mono text-base font-extrabold text-emerald-700 dark:text-emerald-300">{m.pctLP.toFixed(2)}%</p>
                                            <p className="font-mono text-[10px] text-emerald-600/80 dark:text-emerald-400/80">{fmtBRL(m.valor_lp)}</p>
                                          </div>
                                          <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-2.5">
                                            <p className="text-[9px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400 mb-1">Curto Prazo (CP)</p>
                                            <p className="font-mono text-base font-extrabold text-amber-700 dark:text-amber-300">{m.pctCP.toFixed(2)}%</p>
                                            <p className="font-mono text-[10px] text-amber-600/80 dark:text-amber-400/80">{fmtBRL(m.valor_cp)}</p>
                                          </div>
                                          <div className="rounded-lg border border-slate-200 bg-slate-50 dark:bg-slate-800/30 dark:border-slate-700 p-2.5">
                                            <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">FII (fora do LP)</p>
                                            <p className="font-mono text-base font-extrabold text-slate-600 dark:text-slate-300">{m.pctExc.toFixed(2)}%</p>
                                            <p className="font-mono text-[10px] text-slate-500/80 dark:text-slate-400/80">{fmtBRL(m.valor_excluido)}</p>
                                          </div>
                                        </div>

                                        {/* MM-10d + contadores */}
                                        <div className="flex items-center gap-4 flex-wrap text-[10px]">
                                          <div className="flex items-center gap-1.5">
                                            <span className="text-muted-foreground">p do dia:</span>
                                            <span className="font-mono font-semibold text-foreground">{m.p_dia.toFixed(2)}%</span>
                                          </div>
                                          <div className="flex items-center gap-1.5">
                                            <span className="text-muted-foreground">MM-10d:</span>
                                            <span className={cn("font-mono font-semibold", m.mm_10d >= 92 ? 'text-emerald-600' : m.mm_10d >= 90 ? 'text-amber-600' : 'text-red-600')}>{m.mm_10d.toFixed(2)}%</span>
                                          </div>
                                          <div className="flex items-center gap-1.5">
                                            <span className="text-muted-foreground">Eventos no ano:</span>
                                            <span className={cn("font-mono font-semibold", m.eventos_ano >= 3 ? 'text-red-600' : m.eventos_ano > 0 ? 'text-amber-600' : 'text-emerald-600')}>{m.eventos_ano}</span>
                                          </div>
                                          <div className="flex items-center gap-1.5">
                                            <span className="text-muted-foreground">Dias em violação:</span>
                                            <span className={cn("font-mono font-semibold", m.dias_violacao_ano >= 45 ? 'text-red-600' : m.dias_violacao_ano > 0 ? 'text-amber-600' : 'text-emerald-600')}>{m.dias_violacao_ano}</span>
                                          </div>
                                        </div>
                                      </>
                                    );
                                  })()}

                                  <MmTributariaChart
                                    fundo_cnpj={fundoCnpj}
                                    ano={
                                      anoFromDtPosicao(fundoDtposicao) ??
                                      new Date().getFullYear()
                                    }
                                    dataAte={dtPosicaoToIso(fundoDtposicao)}
                                    regra_codigo={rule.regra_codigo}
                                    className="pt-2"
                                  />
                                </div>
                              )}

                              {/* Metadata de qualidade de dados (apenas para regras fidc-concentracao) */}
                              {rule.regra_categoria === "fidc-concentracao" && (
                                <div className="flex items-center gap-4 flex-wrap pt-1 pb-2 border-b border-border/40 text-[10px]">
                                  {detalhes.data_referencia_estoque != null && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-muted-foreground">Estoque ref.:</span>
                                      <span className="font-mono font-semibold text-foreground">
                                        {String(detalhes.data_referencia_estoque).replace(/(\d{4})-(\d{2})-(\d{2})/, "$3/$2/$1")}
                                      </span>
                                    </div>
                                  )}
                                  {detalhes.base_calculo != null && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-muted-foreground">Base:</span>
                                      <span className="font-mono font-semibold text-foreground capitalize">
                                        {String(detalhes.base_calculo).replace(/_/g, " ")}
                                      </span>
                                    </div>
                                  )}
                                  {detalhes.usar_abatimento_pdd != null && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-muted-foreground">PDD:</span>
                                      <span className={`font-mono font-semibold ${detalhes.usar_abatimento_pdd ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground'}`}>
                                        {detalhes.usar_abatimento_pdd ? 'abatido' : 'não abatido'}
                                      </span>
                                    </div>
                                  )}
                                  {detalhes.origem_pl_utilizada != null && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-muted-foreground">PL:</span>
                                      <span className={`font-mono font-semibold ${
                                        detalhes.origem_pl_fallback && detalhes.origem_pl_utilizada !== 'fidc_header' && detalhes.origem_pl_utilizada !== 'pl_mes_anterior_posicao'
                                          ? 'text-amber-600 dark:text-amber-400'
                                          : detalhes.pl_sub_origem === 'fidc_header' || detalhes.origem_pl_utilizada === 'fidc_header'
                                            ? 'text-indigo-600 dark:text-indigo-400'
                                            : 'text-foreground'
                                      }`}>
                                        {labelOrigemPlConcentracao(detalhes)}
                                      </span>
                                    </div>
                                  )}
                                  {detalhes.total_recebiveis != null && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-muted-foreground">Recebíveis:</span>
                                      <span className="font-mono font-semibold text-foreground">
                                        {Number(detalhes.total_recebiveis).toLocaleString("pt-BR")}
                                        {detalhes.recebiveis_excluidos ? ` (${detalhes.recebiveis_excluidos} excluídos)` : ""}
                                      </span>
                                    </div>
                                  )}
                                  {detalhes.recebiveis_baixa_qualidade != null && Number(detalhes.recebiveis_baixa_qualidade) > 0 && (
                                    <div className="flex items-center gap-1.5 text-amber-600">
                                      <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
                                      <span>{Number(detalhes.recebiveis_baixa_qualidade)} sem chave de dedup</span>
                                    </div>
                                  )}
                                  {detalhes.qtd_ativos_coobrigacao_indeterminada != null && Number(detalhes.qtd_ativos_coobrigacao_indeterminada) > 0 && (
                                    <div className="flex items-center gap-1.5 text-amber-600">
                                      <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
                                      <span>{Number(detalhes.qtd_ativos_coobrigacao_indeterminada)} coobrig. indeterminada</span>
                                    </div>
                                  )}
                                </div>
                              )}

                              {rule.regra_categoria === "fidc-estrutura" && detalhes && (
                                <div className="grid grid-cols-2 gap-2 text-[10px] pb-2 border-b border-border/40">
                                  <div><span className="text-muted-foreground">PL JR:</span>{" "}
                                    {Number(detalhes.pl_jr ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 })}
                                  </div>
                                  <div><span className="text-muted-foreground">PL MEZ:</span>{" "}
                                    {Number(detalhes.pl_mez ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 })}
                                  </div>
                                  <div><span className="text-muted-foreground">PL SR:</span>{" "}
                                    {Number(detalhes.pl_sr ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 })}
                                  </div>
                                  <div><span className="text-muted-foreground">PL Classe:</span>{" "}
                                    {Number(detalhes.pl_classe ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 })}
                                  </div>
                                  {detalhes.indice_calculado != null && (
                                    <div className="col-span-2">
                                      <span className="text-muted-foreground">Índice:</span>{" "}
                                      {(Number(detalhes.indice_calculado) * 100).toFixed(2)}%
                                      {detalhes.excesso_cobertura != null && Number(detalhes.excesso_cobertura) > 0 && (
                                        <span className="text-muted-foreground ml-2">
                                          · Excesso: {Number(detalhes.excesso_cobertura).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 })}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Breakdown de componentes (para regras conjuntas) - OCULTO por padrão */}
                              {detalhes?.componentes_breakdown && Array.isArray(detalhes.componentes_breakdown) && detalhes.componentes_breakdown.length > 0 && false && (
                                <div className="space-y-3 pb-4 border-b border-blue-200/50">
                                  <div className="flex items-center gap-2">
                                    <div className="h-5 w-1 bg-blue-500 rounded" />
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-blue-700 dark:text-blue-400">
                                      Breakdown por Componente
                                    </span>
                                  </div>
                                  <div className="space-y-2 pl-3">
                                    {(detalhes.componentes_breakdown as any[]).map((comp, idx) => {
                                      return (
                                        <div key={idx} className="flex items-center justify-between px-2 py-1.5 rounded bg-blue-50/30 dark:bg-blue-950/10 text-xs">
                                          <div className="flex items-center gap-2 flex-1 min-w-0">
                                            <span className="text-[10px] font-semibold text-blue-900/60 dark:text-blue-200/60 shrink-0">
                                              {idx + 1}.
                                            </span>
                                            <span className="font-medium text-blue-900 dark:text-blue-100 truncate">
                                              {comp.regra_descricao || comp.valor}
                                            </span>
                                          </div>
                                          <div className="flex items-center gap-3 shrink-0">
                                            {comp.tipo !== 'regra' && (
                                              <>
                                                <div className="text-right">
                                                  <div className="font-mono text-xs font-semibold text-blue-700 dark:text-blue-300">
                                                    {formatPercentage(comp.exposicao_percentual)}
                                                  </div>
                                                </div>
                                                <div className="text-right">
                                                  <div className="font-mono text-xs text-muted-foreground">
                                                    {comp.ativos_count}
                                                  </div>
                                                </div>
                                              </>
                                            )}
                                          </div>
                                        </div>
                                      );
                                    })}
                                    <div className="flex items-center justify-between pt-2 mt-2 border-t border-blue-200/50 text-xs">
                                      <span className="font-bold text-blue-900 dark:text-blue-100">
                                        Total do Grupo
                                      </span>
                                      <div className="flex items-center gap-4">
                                        <div className="flex items-center gap-1.5">
                                          <span className="text-[10px] text-muted-foreground">Únicos:</span>
                                          <span className="font-mono font-semibold text-blue-700 dark:text-blue-300">
                                            {String(detalhes.ativos_unicos_count ?? "—")}
                                          </span>
                                        </div>
                                        <div className={cn("font-mono text-sm font-bold",
                                          rule.status === 'violacao' ? 'text-red-600' :
                                          rule.status === 'alerta' ? 'text-amber-600' : 'text-emerald-600'
                                        )}>
                                          {formatPercentage(rule.valor_atual)}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}

                              {/* Lista de ativos considerados */}
                              {(contributionAssets.length > 0 || (detalhes?.sacados_com_excecao as any[])?.length > 0) && (
                                <>
                                  <div className="flex items-center justify-between">
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                                      {rule.regra_categoria === "fidc-concentracao" && detalhes?.categoria_alvo
                                        ? `${String(detalhes.categoria_alvo)} considerados`
                                        : usingAtivosFallback
                                          ? "Ativos (posição + cache de classificação)"
                                          : "Ativos Considerados no Cálculo"}
                                    </span>
                                    <div className="flex items-center gap-6">
                                      <span className="text-[9px] font-bold text-muted-foreground uppercase min-w-[100px] text-right">Valor</span>
                                      {rule.regra_categoria === "fidc-concentracao" && detalhes?.usar_abatimento_pdd && (
                                        <span className="text-[9px] font-bold text-muted-foreground uppercase min-w-[90px] text-right">PDD</span>
                                      )}
                                      <span className="text-[9px] font-bold text-muted-foreground uppercase min-w-[60px] text-right">% PL</span>
                                      {rule.regra_categoria === "fidc-concentracao" && rule.valor_limite != null && (
                                        <span className="text-[9px] font-bold text-muted-foreground uppercase min-w-[28px] text-center">Status</span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="grid grid-cols-1 gap-1">
                                    {contributionAssets.map((asset, idx) => {
                                      const tipo: string = asset.tipo ?? '';
                                      const tipoBadge = (() => {
                                        if (tipo === 'imovel_direto') return { label: 'Imóvel', cls: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700' };
                                        if (tipo === 'imovel_csv')    return { label: 'Imóvel CSV', cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300' };
                                        if (tipo === 'rf_imob_csv')   return { label: 'RF Imob CSV', cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300' };
                                        if (['CRI','LCI','LIG','CCI','LH','CEPAC'].includes(tipo.toUpperCase())) return { label: tipo.toUpperCase(), cls: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300' };
                                        if (tipo.startsWith('rf_imob')) return { label: 'RF Imob.', cls: 'bg-violet-50 text-violet-700 border-violet-200' };
                                        if (tipo === 'csv')           return { label: 'CSV', cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300' };
                                        if (tipo === 'xml')           return { label: 'XML', cls: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-800/40 dark:text-slate-300' };
                                        if (tipo === 'pdd_excluida') return { label: 'PDD', cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300' };
                                        if (tipo === 'provisao_dc')  return { label: 'DC NC', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300' };
                                        // Badges tributário
                                        if (tipo === 'lp')       return { label: 'LP', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-700' };
                                        if (tipo === 'cp')       return { label: 'CP', cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300' };
                                        if (tipo === 'excluido') return { label: 'Excluído', cls: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800/40 dark:text-slate-400 dark:border-slate-600' };
                                        return null;
                                      })();
                                      const isGrupo = !!(asset as any).is_grupo_economico;
                                      const membros: { cnpj: string; nome: string }[] = (asset as any).membros ?? [];
                                      const grupoKey = `${idx}-${asset.cnpj}`;
                                      const grupoExpandido = expandedGrupos.has(grupoKey);

                                      return (
                                        <div key={idx} className="rounded transition-colors">
                                          <div className="flex items-center justify-between text-xs py-1.5 hover:bg-muted/30 px-2 rounded group">
                                          <div className="flex flex-col gap-0.5">
                                            <div className="flex items-center gap-1.5">
                                              <span className="font-semibold text-foreground/90 group-hover:text-primary transition-colors">{asset.nome}</span>
                                              {tipoBadge && (
                                                <span className={cn("text-[8px] font-bold border rounded px-1 py-0 leading-4 shrink-0", tipoBadge.cls)}>
                                                  {tipoBadge.label}
                                                </span>
                                              )}
                                              {isGrupo && (
                                                <button
                                                  type="button"
                                                  onClick={() => toggleGrupo(grupoKey)}
                                                  className="inline-flex items-center gap-0.5 text-[8px] font-bold border rounded px-1 py-0 leading-4 shrink-0 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700 hover:bg-blue-100 transition-colors"
                                                >
                                                  {grupoExpandido
                                                    ? <ChevronDown className="h-2.5 w-2.5" />
                                                    : <ChevronRight className="h-2.5 w-2.5" />
                                                  }
                                                  Grupo ({membros.length})
                                                </button>
                                              )}
                                            </div>
                                            {asset.cnpj && !isGrupo && (
                                              <span className="text-[9px] font-mono text-muted-foreground">
                                                {asset.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")}
                                              </span>
                                            )}
                                            {isGrupo && grupoExpandido && membros.length > 0 && (
                                              <div className="mt-1 ml-1 space-y-0.5 border-l-2 border-blue-200 dark:border-blue-700 pl-2">
                                                {membros.map((m, mi) => (
                                                  <div key={mi} className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
                                                    <span className="font-mono">{m.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")}</span>
                                                    {m.nome && <span className="truncate max-w-[180px]">— {m.nome}</span>}
                                                  </div>
                                                ))}
                                              </div>
                                            )}
                                          </div>
                                          <div className="flex items-center gap-6">
                                            <div className="flex items-center justify-end min-w-[100px]">
                                              <span className="font-mono text-foreground">
                                                {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(asset.valor)}
                                              </span>
                                            </div>
                                            {rule.regra_categoria === "fidc-concentracao" && detalhes?.usar_abatimento_pdd && (
                                              <div className="flex items-center justify-end min-w-[90px]">
                                                <span className="font-mono text-amber-600 dark:text-amber-400 text-[11px]">
                                                  {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((asset as any).pdd_abatido ?? 0)}
                                                </span>
                                              </div>
                                            )}
                                            <div className="flex items-center justify-end min-w-[60px]">
                                              <span className="font-mono text-primary font-bold">
                                                {((asset.percentual ?? (patliq ? (asset.valor ?? 0) / patliq : 0)) * 100).toFixed(2)}%
                                              </span>
                                            </div>
                                            {rule.regra_categoria === "fidc-concentracao" && rule.valor_limite != null && (() => {
                                              const pct = asset.percentual ?? (patliq ? (asset.valor ?? 0) / patliq : 0);
                                              const limiteAplicavel = (asset as any).limite_aplicavel ?? rule.valor_limite;
                                              const excede = pct > limiteAplicavel;
                                              return (
                                                <Tooltip>
                                                  <TooltipTrigger asChild>
                                                    <div className="flex items-center justify-center min-w-[28px]">
                                                      {excede
                                                        ? <XCircle className="h-4 w-4 text-red-500" />
                                                        : <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                                                      }
                                                    </div>
                                                  </TooltipTrigger>
                                                  <TooltipContent side="left" className="text-xs">
                                                    {excede
                                                      ? `Acima do limite (${(limiteAplicavel * 100).toFixed(2)}%)`
                                                      : `Dentro do limite (${(limiteAplicavel * 100).toFixed(2)}%)`
                                                    }
                                                  </TooltipContent>
                                                </Tooltip>
                                              );
                                            })()}
                                          </div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>

                                  {/* Sacados com exceção (ignorados na regra, mas visíveis) */}
                                  {(detalhes?.sacados_com_excecao as any[])?.length > 0 && (
                                    <>
                                      <div className="flex items-center justify-between mt-4 pt-3 border-t border-border/60">
                                        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                                          Sacados com Exceção (não considerados)
                                        </span>
                                        <span className="text-[10px] text-muted-foreground">
                                          {(detalhes?.sacados_com_excecao as any[])?.length} item(ns)
                                        </span>
                                      </div>
                                      <div className="grid grid-cols-1 gap-1 mt-1">
                                        {(detalhes?.sacados_com_excecao as any[]).map((asset: any, idx: number) => (
                                          <div key={idx} className="flex items-center justify-between text-xs py-1.5 bg-muted/20 px-2 rounded border border-dashed border-muted-foreground/30">
                                            <div className="flex flex-col gap-0.5">
                                              <div className="flex items-center gap-1.5">
                                                <span className="font-semibold text-muted-foreground">{asset.nome}</span>
                                                <span className="text-[8px] font-bold border rounded px-1 py-0 leading-4 shrink-0 bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300">
                                                  Exceção
                                                </span>
                                              </div>
                                              {asset.cnpj && (
                                                <span className="text-[9px] font-mono text-muted-foreground">
                                                  {String(asset.cnpj).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")}
                                                </span>
                                              )}
                                            </div>
                                            <div className="flex items-center gap-4">
                                              <div className="flex items-center justify-end min-w-[90px]">
                                                <span className="font-mono text-muted-foreground text-[11px]">
                                                  {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(asset.valor)}
                                                </span>
                                              </div>
                                              {detalhes?.usar_abatimento_pdd && (
                                                <div className="flex items-center justify-end min-w-[80px]">
                                                  <span className="font-mono text-amber-600 dark:text-amber-400 text-[11px]">
                                                    {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(asset.pdd_abatido ?? 0)}
                                                  </span>
                                                </div>
                                              )}
                                              <div className="flex items-center justify-end min-w-[50px]">
                                                <span className="font-mono text-muted-foreground text-[11px]">
                                                  {((asset.percentual ?? 0) * 100).toFixed(2)}%
                                                </span>
                                              </div>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </>
                                  )}
                                </>
                              )}

                              {/* Sem ativos individuais — orienta o usuário */}
                              {contributionAssets.length === 0 && !(detalhes?.sacados_com_excecao as any[])?.length && (
                                <p className="text-[11px] text-muted-foreground italic">
                                  {ativosFallbackLoading && rule.regra_categoria === "tributario"
                                    ? "Carregando ativos da posição..."
                                    : rule.regra_categoria === "tributario" && tribMetrics?.hasData
                                      ? "Detalhamento de ativos indisponível no resultado salvo. Clique em Rodar Verificação para atualizar."
                                      : "Nenhum ativo individual registrado. Rode a verificação novamente para atualizar o detalhamento."}
                                </p>
                              )}

                            </div>
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );

  if (maxHeight) {
    return (
      <ScrollArea className={cn("pr-0", className)} style={{ maxHeight }}>
        {content}
      </ScrollArea>
    );
  }

  return content;
}

export function RulesSheet({ fundoCnpj, fundoDtposicao, fundoIsin, trigger }: RulesSheetProps) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm" className="gap-2 bg-card h-8 text-xs">
            <ClipboardCheck className="h-3.5 w-3.5" />
            Regras
          </Button>
        )}
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md border-l border-border">
        <SheetHeader className="space-y-0.5 pb-4 border-b border-border mb-4">
          <SheetTitle className="text-sm font-bold uppercase tracking-wider flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-primary" />
            Compliance
          </SheetTitle>
          <SheetDescription className="text-xs font-mono">
            REF: {fundoDtposicao?.replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1")}
          </SheetDescription>
        </SheetHeader>

        <RulesList
          fundoCnpj={fundoCnpj}
          fundoDtposicao={fundoDtposicao}
          fundoIsin={fundoIsin}
          className="h-full"
          maxHeight="calc(100vh - 140px)"
        />
      </SheetContent>
    </Sheet>
  );
}

export function RulesStatusBadges({ 
  fundoCnpj, 
  fundoDtposicao,
  fundoIsin,
  compact = false 
}: { 
  fundoCnpj: string; 
  fundoDtposicao: string;
  /** ISIN da subclasse do fundo. Quando fornecido, filtra resultados por subclasse. */
  fundoIsin?: string | null;
  compact?: boolean;
}) {
  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["enquadramento-rules-summary", fundoCnpj, fundoDtposicao, fundoIsin],
    enabled: !!fundoCnpj && !!fundoDtposicao,
    staleTime: 30000,
    queryFn: async () => {
      let q = supabase
        .from("enquadramento_resultado" as any)
        .select("regra_codigo, regra_categoria, status, valor_atual, valor_limite, detalhes")
        .eq("fundo_cnpj", fundoCnpj)
        .eq("fundo_dtposicao", fundoDtposicao);
      if (fundoIsin) q = (q as any).eq("fundo_isin", fundoIsin);
      const { data, error } = await q;

      if (error) {
        console.error("Erro ao buscar resumo regras:", error);
        return [];
      }

      return data as Array<{
        regra_codigo: string;
        regra_categoria: string;
        status: string;
        valor_atual: number | null;
        valor_limite: number | null;
        detalhes: Record<string, unknown> | null;
      }>;
    },
  });

  if (isLoading) {
    return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />;
  }

  if (rules.length === 0) return null;

  // Group by category and get worst status
  const categoryStatus = rules.reduce((acc, rule) => {
    const effectiveStatus = resolveStoredComplianceStatus(rule);
    const current = acc[rule.regra_categoria];
    if (!current ||
        (effectiveStatus === 'violacao') ||
        (effectiveStatus === 'alerta' && current !== 'violacao')) {
      acc[rule.regra_categoria] = effectiveStatus;
    }
    return acc;
  }, {} as Record<string, string>);

  if (compact) {
    const hasViolation = Object.values(categoryStatus).includes('violacao');
    const hasAlert = Object.values(categoryStatus).includes('alerta');
    
    return (
      <div className="flex items-center gap-1">
        {hasViolation && <XCircle className="h-3.5 w-3.5 text-red-500" />}
        {hasAlert && !hasViolation && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
        {!hasViolation && !hasAlert && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {Object.entries(categoryStatus).map(([category, status]) => {
        const config = categoryConfig[category];
        const statusConf = statusConfig[status as keyof typeof statusConfig];
        if (!config || !statusConf) return null;
        
        const CategoryIcon = config.icon;
        const StatusIcon = statusConf.icon;

        return (
          <Badge
            key={category}
            variant="outline"
            className={cn(
              "text-[9px] gap-1 py-0 px-1.5 h-5",
              status === 'violacao' && "border-red-500/30 bg-red-500/5 text-red-600",
              status === 'alerta' && "border-amber-500/30 bg-amber-500/5 text-amber-600",
              status === 'ok' && "border-emerald-500/30 bg-emerald-500/5 text-emerald-600"
            )}
          >
            <CategoryIcon className="h-2.5 w-2.5" />
            <StatusIcon className="h-2.5 w-2.5" />
          </Badge>
        );
      })}
    </div>
  );
}
