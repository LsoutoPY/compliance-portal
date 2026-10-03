import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ChevronRight,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";

const VERTICES_PADRAO = [0, 1, 2, 3, 4, 5, 10, 21, 42, 63, 126];

/** Limiar OK por prazo do fundo (racional ANBIMA): Prazo > D+120 → 1,05; D+60 a D+120 ou ≤ D+60 ou null → 1,10 */
function getLimiarOk(prazoFundoDias: number | null | undefined): number {
  if (prazoFundoDias == null) return 1.1;
  return prazoFundoDias > 120 ? 1.05 : 1.1;
}

/** Status: HARD (indice < 1), SOFT (1 ≤ indice < limiarOk), OK (indice ≥ limiarOk) */
function getStatus(indice: number, limiarOk: number): "ok" | "alerta" | "violacao" {
  if (indice < 1) return "violacao";
  if (indice < limiarOk) return "alerta";
  return "ok";
}
const CLASSES = ["Multimercados", "Cambial", "Renda Fixa", "RF DI", "Renda Fixa Crédito", "Ações"];
const SEGMENTOS = ["PRIVATE", "PJ", "VAREJO", "EFPC", "INSTITUCIONAIS", "OUTROS"];
const METRICAS = ["media_simples", "EWMA_94", "EWMA_97"];
const TIPO_METODOLOGIA = "Resgate Dados Consolidados";

interface VerticeRow {
  vertice: number;
  ativoVertice: number;
  probabilidade: number;
  ativoAcumulado: number;
  passivoAcumulado: number;
  indice: number;
  status: "ok" | "alerta" | "violacao";
  indiceAcumulado: number;
  estadoAcumulado: "ok" | "alerta" | "violacao";
}

interface LiquidezFundDetailProps {
  fundoCnpj: string;
  fundoDtposicao: string;
  nomeFundo?: string;
  onStatusChange?: (status: "ok" | "alerta" | "violacao") => void;
}

export function LiquidezFundDetail({ fundoCnpj, fundoDtposicao, nomeFundo, onStatusChange }: LiquidezFundDetailProps) {
  const navigate = useNavigate();
  const [classe, setClasse] = useState<string>("Multimercados");
  const [segmento, setSegmento] = useState<string>("PRIVATE");
  const [metrica, setMetrica] = useState<string>("media_simples");
  const [resgatesSolicitados, setResgatesSolicitados] = useState<number | null>(null);

  const { data: walletData, isLoading } = useQuery({
    queryKey: ["liquidez-wallet", fundoCnpj, fundoDtposicao],
    enabled: !!fundoCnpj && !!fundoDtposicao,
    queryFn: async () => {
      const { data: walletData, error } = await supabase
        .from("posicao_carteira")
        .select("*, ativos(id, cnpj, tipo_ativo, validado)")
        .eq("fundo_cnpj", fundoCnpj)
        .eq("fundo_dtposicao", fundoDtposicao)
        .order("valor_padrao", { ascending: false });
      if (error) throw error;

      const uniqueCnpjs = [...new Set(
        (walletData || [])
          .map((i: any) => (i.section === "cotas" ? i.cnpjfundo : i.cnpjemissor))
          .filter(Boolean)
      )] as string[];

      let charData: any[] = [];
      if (uniqueCnpjs.length > 0) {
        const { data } = await supabase
          .from("fundos_caracteristicas" as any)
          .select("cnpj_classe, cnpj_fundo, nome_comercial, prazo_pagamento_resgate_dias")
          .or(`cnpj_classe.in.(${uniqueCnpjs.join(",")}),cnpj_fundo.in.(${uniqueCnpjs.join(",")})`);
        charData = (data as any[]) || [];
      }

      const infoMap = new Map<string, { nome: string | null; prazo: number | null }>();
      charData.forEach((c) => {
        const info = { nome: c.nome_comercial ?? null, prazo: c.prazo_pagamento_resgate_dias ?? null };
        if (c.cnpj_classe) infoMap.set(c.cnpj_classe, info);
        if (c.cnpj_fundo) infoMap.set(c.cnpj_fundo, info);
      });

      return (walletData || []).map((item: any) => {
        const key = item.section === "cotas" ? item.cnpjfundo : item.cnpjemissor;
        const info = (key && infoMap.get(key)) || null;
        return {
          ...item,
          nome_comercial_ativo: info?.nome ?? null,
          prazo_pagamento_resgate_dias: info?.prazo ?? null,
          validado: item.ativos?.validado ?? true,
        };
      });
    },
  });

  const { data: mainFundChar } = useQuery({
    queryKey: ["liquidez-fund-char", fundoCnpj],
    enabled: !!fundoCnpj,
    queryFn: async () => {
      const { data } = await supabase
        .from("fundos_caracteristicas" as any)
        .select("prazo_pagamento_resgate_dias")
        .or(`cnpj_classe.eq.${fundoCnpj},cnpj_fundo.eq.${fundoCnpj}`)
        .or("estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo")
        .limit(1)
        .maybeSingle();
      return data as any;
    },
  });

  const periodo = useMemo(() => {
    if (!fundoDtposicao) return "";
    const y = fundoDtposicao.slice(0, 4);
    const m = fundoDtposicao.slice(4, 6);
    return `${m}/${y}`;
  }, [fundoDtposicao]);

  const { data: matrizProbs = [] } = useQuery({
    queryKey: ["matriz-probs", classe, segmento, metrica, periodo],
    enabled: !!periodo,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matriz_anbima")
        .select("prazo, valor")
        .eq("classe", classe)
        .eq("segmento_investidor", segmento)
        .eq("tipo_metodologia", TIPO_METODOLOGIA)
        .eq("metrica", metrica)
        .eq("periodo", periodo);
      if (error) throw error;
      return (data || []) as { prazo: number; valor: number }[];
    },
  });

  const probMap = useMemo(() => {
    const m = new Map<number, number>();
    matrizProbs.forEach((p) => m.set(p.prazo, p.valor));
    return m;
  }, [matrizProbs]);

  const vertices = useMemo(() => {
    const base = [...VERTICES_PADRAO];
    const prazoFundo = mainFundChar?.prazo_pagamento_resgate_dias;
    if (prazoFundo != null && prazoFundo >= 0 && !base.includes(prazoFundo)) {
      base.push(prazoFundo);
      base.sort((a, b) => a - b);
    }
    return base;
  }, [mainFundChar?.prazo_pagamento_resgate_dias]);

  const totalPL = walletData?.[0]?.fundo_patliq || 0;

  const limiarOk = getLimiarOk(mainFundChar?.prazo_pagamento_resgate_dias);

  const { worstStatus } = useMemo(() => {
    if (!walletData || walletData.length === 0) return { tabelaVertices: [] as VerticeRow[], worstStatus: "ok" as const };

    const validSections = new Set(["cotas", "titpublico", "titprivado", "termorf", "caixa", "acoes", "participacoes", "fidc", "imoveis"]);
    const rowsWithPrazo = walletData
      .filter((a: any) => validSections.has((a.section || "").toLowerCase()))
      .map((a: any) => ({
        valor: a.valor_padrao || 0,
        prazo: a.section?.toLowerCase() === "caixa" ? 0 : (a.prazo_pagamento_resgate_dias ?? 999),
      }))
      .filter((r) => r.valor > 0);

    const result: VerticeRow[] = [];
    let worstStatus: "ok" | "alerta" | "violacao" = "ok";

    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i];
      const prevVertice = i > 0 ? vertices[i - 1] : -1;
      const ativoVertice = rowsWithPrazo
        .filter((r) => r.prazo > prevVertice && r.prazo <= v)
        .reduce((s, r) => s + r.valor, 0);

      const ativoAcumulado = rowsWithPrazo.filter((r) => r.prazo <= v).reduce((s, r) => s + r.valor, 0);
      const menores = vertices.filter((x) => x <= v);
      const prob = v === 0 ? 0 : (probMap.get(v) ?? (menores.length > 0 ? probMap.get(Math.max(...menores)) : undefined) ?? 0);
      const resgates = resgatesSolicitados ?? 0;
      const passivoAcumulado = totalPL * prob + resgates;

      const indice = passivoAcumulado > 0 ? ativoAcumulado / passivoAcumulado : 1;
      const indiceAcumulado = passivoAcumulado > 0 ? ativoAcumulado / passivoAcumulado : 1;

      const status = getStatus(indice, limiarOk);
      const estadoAcumulado = getStatus(indiceAcumulado, limiarOk);

      if (status === "violacao" || estadoAcumulado === "violacao") worstStatus = "violacao";
      else if ((status === "alerta" || estadoAcumulado === "alerta") && worstStatus !== "violacao") worstStatus = "alerta";
    }

    return { worstStatus };
  }, [walletData, vertices, probMap, totalPL, resgatesSolicitados, limiarOk]);

  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  useEffect(() => {
    onStatusChangeRef.current?.(worstStatus);
  }, [worstStatus]);

  const handleClick = () => {
    navigate(`/liquidez/monitoramento-fundo/${fundoCnpj}/${fundoDtposicao}`);
  };

  if (isLoading) return <Skeleton className="h-24 w-full" />;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => e.key === "Enter" && handleClick()}
      className="flex flex-col sm:flex-row items-center justify-between gap-4 p-6 bg-card border rounded-lg shadow-sm cursor-pointer hover:bg-muted/30 hover:border-primary/30 transition-colors"
    >
      <div className="flex items-center gap-4 flex-1 min-w-0">
        <div className={cn(
          "p-3 rounded-full shrink-0",
          worstStatus === "ok" ? "bg-emerald-100 text-emerald-600" :
          worstStatus === "alerta" ? "bg-amber-100 text-amber-600" :
          "bg-red-100 text-red-600"
        )}>
          {worstStatus === "ok" ? <CheckCircle2 className="w-8 h-8" /> :
           worstStatus === "alerta" ? <AlertTriangle className="w-8 h-8" /> :
           <XCircle className="w-8 h-8" />}
        </div>
        <div className="space-y-1 min-w-0">
          <h3 className="text-lg font-semibold tracking-tight truncate">{nomeFundo || "Fundo"}</h3>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={cn(
              "text-sm px-3 py-1 font-bold uppercase tracking-wide",
              worstStatus === "ok" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
              "bg-amber-50 text-amber-700 border-amber-200"
            )}>
              {worstStatus === "ok" ? "Enquadrado" : "Pendente de atualização"}
            </Badge>
            {worstStatus !== "ok" && (
              <span className="text-xs text-muted-foreground">Clique para ver detalhes.</span>
            )}
          </div>
        </div>
      </div>

      <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
    </div>
  );
}
