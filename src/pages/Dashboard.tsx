import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchParesMonitorados, buildParKey } from "@/lib/fundosMonitorados";
import { Layout } from "@/components/Layout";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import {
  BarChart3,
  CheckCircle2,
  XCircle,
  ClipboardList,
  Loader2,
  ChevronRight,
  TrendingUp,
  PieChart,
  Calendar as CalendarIcon,
  Clock,
  Cpu,
  AlertTriangle,
  Layers,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { format, parse } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";
import { XmlGapsDashboardCard } from "@/components/enquadramento/XmlGapsDashboardCard";
import { formatGapDateYyyymmdd } from "@/lib/xmlGaps";
import {
  normalizeCnpj14,
  populateFundoNomeMapFromPosicao,
  resolveFundoNomeFromMap,
  fundPairKey,
  isFundoRegraAtivaParaEnquadramento,
} from "@/lib/fundoRegrasUtils";

export default function Dashboard() {
  const navigate = useNavigate();
  const [listModal, setListModal] = useState<"enquadrados" | "desenquadrados" | null>(null);
  const [regrasView, setRegrasView] = useState<"consolidada" | "por-fundo">("consolidada");
  const [adminView, setAdminView] = useState<"investidores" | "investidos">("investidores");
  const [detailModal, setDetailModal] = useState<{
    type: "asset" | "admin" | "gestor";
    title: string;
    columnLabel: string; // "Fundo Investidor" ou "Fundo Investido"
    items: { cnpj: string; name: string }[];
  } | null>(null);

  const [date, setDate] = useState<Date | undefined>(undefined);
  const formatDateToDB = (d: Date) => format(d, "yyyyMMdd");

  // Datas disponíveis (posicao_carteira)
  const { data: availableDates = [] } = useQuery({
    queryKey: ["dashboard-available-dates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("posicao_carteira")
        .select("fundo_dtposicao")
        .in("section", ["caixa", "despesas"])
        .order("fundo_dtposicao", { ascending: false })
        .limit(10000);
      if (error) throw error;
      const unique = Array.from(new Set(data?.map((d) => d.fundo_dtposicao) || [])).filter(Boolean) as string[];
      return unique.sort((a, b) => b.localeCompare(a));
    },
  });

  // Sempre iniciar na data mais recente disponível
  useEffect(() => {
    if (availableDates.length > 0 && !date) {
      setDate(parse(availableDates[0], "yyyyMMdd", new Date()));
    }
  }, [availableDates, date]);

  const dateStr = date ? formatDateToDB(date) : null;
  const availableDatesMap = useMemo(() => new Set(availableDates), [availableDates]);

  // Fundos monitorados com status de enquadramento para data selecionada
  const { data: fundsStatus = [], isLoading: loadingFunds } = useQuery({
    queryKey: ["dashboard-funds-status", dateStr],
    enabled: !!dateStr,
    queryFn: async () => {
      if (!dateStr) return [];

      // Pares monitorados — apenas gestoras da allowlist
      const paresMonitorados = await fetchParesMonitorados(dateStr);
      if (!paresMonitorados.length) return [];

      const { data: enquadramentoData } = await supabase
        .from("enquadramento_resultado" as any)
        .select("fundo_cnpj, status")
        .eq("fundo_dtposicao", dateStr);

      const statusMap = new Map<string, string>();
      (enquadramentoData || []).forEach((item: { fundo_cnpj: string; status: string }) => {
        const current = statusMap.get(item.fundo_cnpj);
        if (item.status === "violacao" || !current) statusMap.set(item.fundo_cnpj, item.status);
        else if (item.status === "alerta" && current !== "violacao") statusMap.set(item.fundo_cnpj, item.status);
      });

      return paresMonitorados.map((par) => {
        const st = statusMap.get(par.fundo_cnpj);
        const desenquadrado = st === "violacao" || st === "alerta";
        return {
          nome_fundo: par.nome_fundo || par.fundo_cnpj,
          fundo_cnpj: par.fundo_cnpj,
          status: desenquadrado ? "desenquadrado" : "enquadrado",
          statusDetail: st || "ok",
        };
      });
    },
  });

  const enquadrados = fundsStatus.filter((f) => f.status === "enquadrado");
  const desenquadrados = fundsStatus.filter((f) => f.status === "desenquadrado");

  const { data: processamentoInfo = { processados: 0, pendentes: 0, total: 0 }, isLoading: loadingProcessamento } =
    useQuery({
      queryKey: ["dashboard-processamento", dateStr],
      enabled: !!dateStr,
      queryFn: async () => {
        if (!dateStr) return { processados: 0, pendentes: 0, total: 0 };
        const pares = await fetchParesMonitorados(dateStr);
        const db = supabase as unknown as {
          rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
        };
        const { data, error } = await db.rpc("get_pares_pendentes_enquadramento_data", { p_data: dateStr });
        if (error) throw error;
        const pendentes = (data as unknown[] | null)?.length ?? 0;
        return {
          total: pares.length,
          pendentes,
          processados: Math.max(0, pares.length - pendentes),
        };
      },
    });

  // Regras associadas: total, média por fundo e fundos sem regras
  const { data: regrasInfo = { total: 0, porFundo: [], fundosSemRegras: 0, mediaPorFundo: 0 }, isLoading: loadingRegras } =
    useQuery({
    queryKey: ["dashboard-regras", dateStr],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fundo_regras")
        .select("fundo_cnpj, fundo_isin, regra_id, ativo, status_aprovacao");

      if (error) throw error;
      const rows = ((data || []) as Array<{
        fundo_cnpj: string;
        fundo_isin?: string | null;
        regra_id: string;
        ativo?: boolean | null;
        status_aprovacao?: string | null;
      }>).filter(isFundoRegraAtivaParaEnquadramento);

      const byFund = new Map<string, number>();
      rows.forEach((r) => {
        const key = fundPairKey(r.fundo_cnpj, r.fundo_isin);
        byFund.set(key, (byFund.get(key) || 0) + 1);
      });

      const cnpjsNorm = [...new Set(rows.map((r) => normalizeCnpj14(r.fundo_cnpj)))];
      const nameMap = new Map<string, string>();

      if (cnpjsNorm.length > 0) {
        const cnpjQueryValues = [...new Set([...rows.map((r) => r.fundo_cnpj), ...cnpjsNorm])];
        const { data: posByCnpj } = await supabase
          .from("posicao_carteira")
          .select("fundo_cnpj, fundo_isin, fundo_nome, nome_fundo")
          .in("fundo_cnpj", cnpjQueryValues)
          .order("fundo_dtposicao", { ascending: false })
          .limit(10000);

        populateFundoNomeMapFromPosicao(nameMap, posByCnpj || [], cnpjsNorm);

        const missing = cnpjsNorm.filter((c) => !resolveFundoNomeFromMap(nameMap, c, ""));
        if (missing.length > 0) {
          const { data: fcData } = await supabase
            .from("fundos_caracteristicas" as any)
            .select("cnpj_classe, cnpj_fundo, nome_comercial")
            .or(`cnpj_classe.in.(${missing.join(",")}),cnpj_fundo.in.(${missing.join(",")})`);

          (fcData as Array<{ cnpj_classe?: string; cnpj_fundo?: string; nome_comercial?: string }>)?.forEach(
            (n) => {
              if (!n.nome_comercial) return;
              for (const cnpj of [n.cnpj_classe, n.cnpj_fundo]) {
                if (!cnpj) continue;
                const norm = normalizeCnpj14(cnpj);
                if (missing.includes(norm)) {
                  nameMap.set(`${norm}|`, n.nome_comercial);
                }
              }
            },
          );
        }
      }

      const porFundo = Array.from(byFund.entries())
        .map(([key, count]) => {
          const [fundo_cnpj, fundo_isin = ""] = key.split("|");
          return {
            fundo_cnpj,
            fundo_isin,
            count,
            nome_fundo: resolveFundoNomeFromMap(nameMap, fundo_cnpj, fundo_isin),
          };
        })
        .sort((a, b) => b.count - a.count);

      let fundosSemRegras = 0;
      if (dateStr) {
        const pares = await fetchParesMonitorados(dateStr);
        const comRegras = new Set(byFund.keys());
        fundosSemRegras = pares.filter(
          (p) => !comRegras.has(buildParKey(p.fundo_cnpj, p.fundo_isin)),
        ).length;
      }

      const fundosComRegras = porFundo.length;
      const mediaPorFundo = fundosComRegras > 0 ? rows.length / fundosComRegras : 0;

      return { total: rows.length, porFundo, fundosSemRegras, mediaPorFundo };
    },
  });

  const totalRegrasAssociadas = regrasInfo.total;
  const regrasPorFundo = regrasInfo.porFundo;
  const fundosSemRegras = regrasInfo.fundosSemRegras;
  const mediaRegrasPorFundo = regrasInfo.mediaPorFundo;

  // Top 5 ativos mais concentrados
  const { data: topAssets = [], isLoading: loadingTopAssets } = useQuery({
    queryKey: ["dashboard-top-assets", dateStr],
    enabled: !!dateStr,
    queryFn: async () => {
      if (!dateStr) return [];

      // fundo_cnpj = fundo investidor (quem detém a posição)
      const { data, error } = await supabase
        .from("posicao_carteira")
        .select("valor_padrao, codativo, isin, cnpjemissor, cnpjfundo, section, fundo_cnpj")
        .eq("fundo_dtposicao", dateStr);

      if (error) throw error;
      if (!data) return [];

      // Filtra apenas ativos reais (exclui headers de fundos e metadados)
      const assets = data.filter(
        (item) =>
          item.section &&
          !["header", "despesas", "provisao"].includes(item.section) &&
          (item.valor_padrao || 0) > 0
      );

      const totalUniverseValue = assets.reduce((sum, item) => sum + (item.valor_padrao || 0), 0);

      // Agrupa por identificador único (CNPJ ou Nome)
      const groupedAssets = new Map<string, { name: string; value: number; count: number; fundos: Set<string> }>();

      // Coletar CNPJs para buscar nomes
      const cnpjsToFetch = new Set<string>();
      assets.forEach(item => {
        if (item.cnpjfundo) cnpjsToFetch.add(item.cnpjfundo);
        if (item.cnpjemissor) cnpjsToFetch.add(item.cnpjemissor);
      });

      // Buscar nomes
      const nameMap = new Map<string, string>();
      if (cnpjsToFetch.size > 0) {
        const uniqueCnpjs = Array.from(cnpjsToFetch);
        // Buscar em lotes de 1000 se necessário, mas aqui simplificado
        const { data: namesData } = await supabase
          .from("fundos_caracteristicas" as any)
          .select("cnpj_classe, cnpj_fundo, nome_comercial")
          .or(`cnpj_classe.in.(${uniqueCnpjs.join(',')}),cnpj_fundo.in.(${uniqueCnpjs.join(',')})`);
        
        (namesData as any[])?.forEach(n => {
          if (n.nome_comercial) {
            if (n.cnpj_classe) nameMap.set(n.cnpj_classe, n.nome_comercial);
            if (n.cnpj_fundo) nameMap.set(n.cnpj_fundo, n.nome_comercial);
          }
        });
      }

      assets.forEach((item) => {
        const id = item.cnpjemissor || item.cnpjfundo || item.codativo || item.isin || "Outros";
        let name = item.codativo || item.isin || id;
        
        // Tenta melhorar o nome
        if (item.cnpjfundo && nameMap.has(item.cnpjfundo)) name = nameMap.get(item.cnpjfundo)!;
        else if (item.cnpjemissor && nameMap.has(item.cnpjemissor)) name = nameMap.get(item.cnpjemissor)!;
        else if (item.section === 'titpublico') name = `Tít. Público ${item.codativo || ''}`;

        const val = item.valor_padrao || 0;

        const current = groupedAssets.get(id);
        if (current) {
          current.value += val;
          current.count += 1;
          if (item.fundo_cnpj) current.fundos.add(item.fundo_cnpj);
        } else {
          groupedAssets.set(id, { 
            name, 
            value: val, 
            count: 1, 
            fundos: new Set(item.fundo_cnpj ? [item.fundo_cnpj] : []) 
          });
        }
      });

      // Ordena por valor total (concentração financeira) e pega top 5
      const sorted = Array.from(groupedAssets.values())
        .sort((a, b) => b.value - a.value)
        .slice(0, 5)
        .map((asset) => ({
          ...asset,
          percentage: totalUniverseValue > 0 ? (asset.value / totalUniverseValue) * 100 : 0,
          fundos: Array.from(asset.fundos)
        }));

      return sorted;
    },
  });

  // Concentração por Administrador (Ativos Investidos)
  const { data: topAdmins = [], isLoading: loadingAdmins } = useQuery({
    queryKey: ["dashboard-top-admins", dateStr],
    enabled: !!dateStr,
    queryFn: async () => {
      if (!dateStr) return [];

      // 1. Pegar todos os ativos que são fundos (cotas)
      const { data: assets, error } = await supabase
        .from("posicao_carteira")
        .select("valor_padrao, cnpjfundo, fundo_cnpj")
        .eq("fundo_dtposicao", dateStr)
        .eq("section", "cotas")
        .not("cnpjfundo", "is", null);

      if (error) throw error;
      if (!assets || assets.length === 0) return [];

      const totalValue = assets.reduce((sum, item) => sum + (item.valor_padrao || 0), 0);
      const uniqueCnpjs = [...new Set(assets.map(a => a.cnpjfundo))];

      // 2. Buscar administradores desses fundos
      let adminMap = new Map<string, string>();
      
      try {
        const { data: adminData, error: adminError } = await supabase
          .from("fundos_caracteristicas" as any)
          .select("cnpj_classe, cnpj_fundo, administrador")
          .or(`cnpj_classe.in.(${uniqueCnpjs.join(',')}),cnpj_fundo.in.(${uniqueCnpjs.join(',')})`);
        
        if (!adminError && adminData) {
          adminData.forEach((d: any) => {
            const adm = d.administrador || "Não Informado";
            if (d.cnpj_classe) adminMap.set(d.cnpj_classe, adm);
            if (d.cnpj_fundo) adminMap.set(d.cnpj_fundo, adm);
          });
        }
      } catch (e) {
        console.warn("Erro ao buscar administradores:", e);
      }

      // Buscar nomes dos fundos investidos (cnpjfundo)
      const nameMapInvestidos = new Map<string, string>();
      try {
        const { data: nomesData } = await supabase
          .from("fundos_caracteristicas" as any)
          .select("cnpj_classe, cnpj_fundo, nome_comercial")
          .or(`cnpj_classe.in.(${uniqueCnpjs.join(',')}),cnpj_fundo.in.(${uniqueCnpjs.join(',')})`);
        (nomesData as any[])?.forEach((n: any) => {
          if (n.nome_comercial) {
            if (n.cnpj_classe) nameMapInvestidos.set(n.cnpj_classe, n.nome_comercial);
            if (n.cnpj_fundo) nameMapInvestidos.set(n.cnpj_fundo, n.nome_comercial);
          }
        });
      } catch (_) {}

      // 3. Agrupar valores por administrador - guardar fundos INVESTIDOS (cnpjfundo)
      const grouped = new Map<string, { value: number; fundosInvestidos: Set<string> }>();
      assets.forEach(asset => {
        const adm = adminMap.get(asset.cnpjfundo!) || "Não Identificado";
        const val = asset.valor_padrao || 0;
        
        const current = grouped.get(adm);
        if (current) {
          current.value += val;
          if (asset.cnpjfundo) current.fundosInvestidos.add(asset.cnpjfundo);
        } else {
          grouped.set(adm, { 
            value: val, 
            fundosInvestidos: new Set(asset.cnpjfundo ? [asset.cnpjfundo] : []) 
          });
        }
      });

      // 4. Ordenar e retornar top 5
      return Array.from(grouped.entries())
        .sort((a, b) => b[1].value - a[1].value)
        .slice(0, 5)
        .map(([name, data]) => ({
          name,
          value: data.value,
          percentage: totalValue > 0 ? (data.value / totalValue) * 100 : 0,
          fundosInvestidos: Array.from(data.fundosInvestidos).map(cnpj => ({
            cnpj,
            name: nameMapInvestidos.get(cnpj) || cnpj
          }))
        }));
    }
  });

  // Concentração por Administrador (Fundos Investidores — nossos próprios fundos monitorados)
  const { data: topAdminsInvestidores = [], isLoading: loadingAdminsInvestidores } = useQuery({
    queryKey: ["dashboard-top-admins-investidores", dateStr],
    enabled: !!dateStr,
    queryFn: async () => {
      if (!dateStr) return [];

      // fundo_nomeadm e fundo_patliq são campos de cabeçalho presentes em qualquer section
      const { data, error } = await supabase
        .from("posicao_carteira")
        .select("fundo_cnpj, nome_fundo, fundo_nomeadm, fundo_patliq")
        .eq("fundo_dtposicao", dateStr)
        .in("section", ["caixa", "despesas"])
        .not("fundo_cnpj", "is", null);

      if (error) throw error;
      if (!data || data.length === 0) return [];

      // Deduplica por fundo_cnpj (pode haver múltiplas linhas por fundo)
      const fundMap = new Map<string, { cnpj: string; name: string; admin: string; pl: number }>();
      data.forEach((row: any) => {
        if (!fundMap.has(row.fundo_cnpj)) {
          fundMap.set(row.fundo_cnpj, {
            cnpj: row.fundo_cnpj,
            name: row.nome_fundo || row.fundo_cnpj,
            admin: row.fundo_nomeadm?.trim() || "Não Identificado",
            pl: row.fundo_patliq || 0,
          });
        }
      });

      const funds = Array.from(fundMap.values());
      const totalPL = funds.reduce((sum, f) => sum + f.pl, 0);

      // Agrupa por administrador, pesando pelo PL do fundo
      const grouped = new Map<string, { value: number; fundos: { cnpj: string; name: string }[] }>();
      funds.forEach((fund) => {
        const adm = fund.admin || "Não Identificado";
        const existing = grouped.get(adm);
        if (existing) {
          existing.value += fund.pl;
          existing.fundos.push({ cnpj: fund.cnpj, name: fund.name });
        } else {
          grouped.set(adm, { value: fund.pl, fundos: [{ cnpj: fund.cnpj, name: fund.name }] });
        }
      });

      return Array.from(grouped.entries())
        .sort((a, b) => b[1].value - a[1].value)
        .slice(0, 5)
        .map(([name, d]) => ({
          name,
          value: d.value,
          percentage: totalPL > 0 ? (d.value / totalPL) * 100 : 0,
          fundos: d.fundos,
        }));
    },
  });

  // Concentração por Gestor (Ativos Investidos)
  const { data: topGestores = [], isLoading: loadingGestores } = useQuery({
    queryKey: ["dashboard-top-gestores", dateStr],
    enabled: !!dateStr,
    queryFn: async () => {
      if (!dateStr) return [];

      const { data: assets, error } = await supabase
        .from("posicao_carteira")
        .select("valor_padrao, cnpjfundo")
        .eq("fundo_dtposicao", dateStr)
        .eq("section", "cotas")
        .not("cnpjfundo", "is", null);

      if (error) throw error;
      if (!assets || assets.length === 0) return [];

      const totalValue = assets.reduce((sum, item) => sum + (item.valor_padrao || 0), 0);
      const uniqueCnpjs = [...new Set(assets.map(a => a.cnpjfundo))];

      let gestorMap = new Map<string, string>();
      
      try {
        const { data: gestorData, error: gestorError } = await supabase
          .from("fundos_caracteristicas" as any)
          .select("cnpj_classe, cnpj_fundo, gestor")
          .or(`cnpj_classe.in.(${uniqueCnpjs.join(',')}),cnpj_fundo.in.(${uniqueCnpjs.join(',')})`);
        
        if (!gestorError && gestorData) {
          gestorData.forEach((d: any) => {
            const gest = d.gestor || "Não Informado";
            if (d.cnpj_classe) gestorMap.set(d.cnpj_classe, gest);
            if (d.cnpj_fundo) gestorMap.set(d.cnpj_fundo, gest);
          });
        }
      } catch (e) {
        console.warn("Erro ao buscar gestores:", e);
      }

      const grouped = new Map<string, number>();
      assets.forEach(asset => {
        const gest = gestorMap.get(asset.cnpjfundo!) || "Não Identificado";
        const val = asset.valor_padrao || 0;
        grouped.set(gest, (grouped.get(gest) || 0) + val);
      });

      return Array.from(grouped.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, value]) => ({
          name,
          value,
          percentage: totalValue > 0 ? (value / totalValue) * 100 : 0
        }));
    }
  });

  const formatCnpj = (cnpj: string) =>
    cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold tracking-tight text-foreground uppercase tracking-wider flex items-center gap-2">
              <BarChart3 className="h-6 w-6 text-primary" />
              Dashboard
            </h1>
            <p className="text-sm text-muted-foreground font-medium uppercase tracking-wide">
              Indicadores consolidados de monitoramento de enquadramento
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-muted-foreground">Data de referência:</span>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-8 w-[180px] justify-start text-left font-normal text-xs",
                  !date && "text-muted-foreground"
                )}
                >
                  <CalendarIcon className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                  {date ? (
                    <span className="font-semibold">
                      {format(date, "dd/MM/yyyy", { locale: ptBR })}
                    </span>
                  ) : (
                    <span>Selecionar data</span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={date}
                  onSelect={setDate}
                  locale={ptBR}
                  modifiers={{
                    hasData: (d) => availableDatesMap.has(formatDateToDB(d)),
                    hasDataSelected: (d) =>
                      !!date && formatDateToDB(d) === formatDateToDB(date) && availableDatesMap.has(formatDateToDB(d))
                  }}
                  modifiersClassNames={{
                    hasData: "font-bold text-primary underline underline-offset-4 decoration-primary/50",
                    hasDataSelected: "underline decoration-primary-foreground/80 underline-offset-2"
                  }}
                />
              </PopoverContent>
            </Popover>
            {dateStr && availableDates[0] === dateStr && (
              <span className="text-[10px] text-muted-foreground">
                (mais recente)
              </span>
            )}
          </div>
        </div>

        {/* Cards de indicadores — enquadramento */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <Card
            className="cursor-pointer hover:shadow-lg transition-all duration-200 border-l-4 border-l-emerald-500 bg-emerald-50/30 dark:bg-emerald-950/20 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/30"
            onClick={() => setListModal("enquadrados")}
          >
            <CardHeader className="flex flex-row items-center justify-between pb-1 pt-5 px-5">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                Enquadrados
              </CardTitle>
              <div className="p-1.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              </div>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              {loadingFunds ? (
                <Loader2 className="h-9 w-9 animate-spin text-emerald-400 mt-1" />
              ) : (
                <span className="text-4xl font-extrabold text-emerald-600 tabular-nums">{enquadrados.length}</span>
              )}
              <p className="text-xs text-emerald-700/60 dark:text-emerald-400/60 mt-1.5 font-medium">
                Clique para ver a listagem →
              </p>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:shadow-lg transition-all duration-200 border-l-4 border-l-red-500 bg-red-50/30 dark:bg-red-950/20 hover:bg-red-50/50 dark:hover:bg-red-950/30"
            onClick={() => setListModal("desenquadrados")}
          >
            <CardHeader className="flex flex-row items-center justify-between pb-1 pt-5 px-5">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-red-700 dark:text-red-400">
                Desenquadrados
              </CardTitle>
              <div className="p-1.5 rounded-full bg-red-100 dark:bg-red-900/40">
                <XCircle className="h-4 w-4 text-red-600" />
              </div>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              {loadingFunds ? (
                <Loader2 className="h-9 w-9 animate-spin text-red-400 mt-1" />
              ) : (
                <span className="text-4xl font-extrabold text-red-600 tabular-nums">{desenquadrados.length}</span>
              )}
              <p className="text-xs text-red-700/60 dark:text-red-400/60 mt-1.5 font-medium">
                Clique para ver a listagem →
              </p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-blue-500 bg-blue-50/30 dark:bg-blue-950/20">
            <CardHeader className="flex flex-row items-center justify-between pb-1 pt-5 px-5">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400">
                Fundos Processados
              </CardTitle>
              <div className="p-1.5 rounded-full bg-blue-100 dark:bg-blue-900/40">
                <Cpu className="h-4 w-4 text-blue-600" />
              </div>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              {loadingProcessamento ? (
                <Loader2 className="h-9 w-9 animate-spin text-blue-400 mt-1" />
              ) : (
                <>
                  <span className="text-4xl font-extrabold text-blue-600 tabular-nums">
                    {processamentoInfo.processados}
                  </span>
                  <p className="text-xs text-blue-700/60 dark:text-blue-400/60 mt-1.5 font-medium">
                    de {processamentoInfo.total} monitorados com cálculo na data
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-amber-500 bg-amber-50/30 dark:bg-amber-950/20">
            <CardHeader className="flex flex-row items-center justify-between pb-1 pt-5 px-5">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                Pendentes de Processamento
              </CardTitle>
              <div className="p-1.5 rounded-full bg-amber-100 dark:bg-amber-900/40">
                <Clock className="h-4 w-4 text-amber-600" />
              </div>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              {loadingProcessamento ? (
                <Loader2 className="h-9 w-9 animate-spin text-amber-400 mt-1" />
              ) : (
                <>
                  <span className="text-4xl font-extrabold text-amber-600 tabular-nums">
                    {processamentoInfo.pendentes}
                  </span>
                  <p className="text-xs text-amber-700/60 dark:text-amber-400/60 mt-1.5 font-medium">
                    pares sem enquadramento calculado na data
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Cards — regras associadas */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border-l-4 border-l-primary/70 bg-primary/5 dark:bg-primary/10">
            <CardHeader className="flex flex-row items-center justify-between pb-1 pt-5 px-5">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-primary/80">
                Total Regras Associadas
              </CardTitle>
              <div className="p-1.5 rounded-full bg-primary/10">
                <ClipboardList className="h-4 w-4 text-primary" />
              </div>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              {loadingRegras ? (
                <Loader2 className="h-9 w-9 animate-spin text-primary/40 mt-1" />
              ) : (
                <span className="text-4xl font-extrabold text-primary tabular-nums">{totalRegrasAssociadas}</span>
              )}
              <p className="text-xs text-muted-foreground mt-1.5">Vínculos ativos aprovados</p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-[#003D27]/70 bg-[#003D27]/5 dark:bg-[#003D27]/15">
            <CardHeader className="flex flex-row items-center justify-between pb-1 pt-5 px-5">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-[#003D27] dark:text-emerald-400">
                Regras por Fundo
              </CardTitle>
              <div className="p-1.5 rounded-full bg-[#003D27]/10">
                <Layers className="h-4 w-4 text-[#003D27] dark:text-emerald-400" />
              </div>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              {loadingRegras ? (
                <Loader2 className="h-9 w-9 animate-spin text-primary/40 mt-1" />
              ) : (
                <>
                  <span className="text-4xl font-extrabold text-[#003D27] dark:text-emerald-400 tabular-nums">
                    {mediaRegrasPorFundo.toFixed(1)}
                  </span>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    média · {regrasPorFundo.length} fundo(s) com regras
                  </p>
                </>
              )}
              {!loadingRegras && regrasPorFundo.length > 0 && (
                <Tabs value={regrasView} onValueChange={(v) => setRegrasView(v as "consolidada" | "por-fundo")} className="mt-3">
                  <TabsList className="h-7 text-xs bg-background/60">
                    <TabsTrigger value="consolidada" className="text-[10px]">Consolidada</TabsTrigger>
                    <TabsTrigger value="por-fundo" className="text-[10px]">Por fundo</TabsTrigger>
                  </TabsList>
                  <TabsContent value="consolidada" className="mt-2 text-[10px] text-muted-foreground">
                    Média de vínculos por fundo monitorado com regras.
                  </TabsContent>
                  <TabsContent value="por-fundo" className="mt-2 max-h-[120px] overflow-y-auto">
                    <div className="space-y-1 text-xs">
                      {regrasPorFundo.slice(0, 10).map(({ fundo_cnpj, fundo_isin, count, nome_fundo }) => (
                        <div key={`${fundo_cnpj}|${fundo_isin}`} className="flex items-center justify-between py-1 border-b border-border/40 last:border-0">
                          <span className="truncate max-w-[180px]" title={nome_fundo ?? formatCnpj(fundo_cnpj)}>
                            {nome_fundo ?? formatCnpj(fundo_cnpj)}
                          </span>
                          <Badge variant="secondary" className="text-[10px]">{count}</Badge>
                        </div>
                      ))}
                    </div>
                  </TabsContent>
                </Tabs>
              )}
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-orange-500 bg-orange-50/30 dark:bg-orange-950/20">
            <CardHeader className="flex flex-row items-center justify-between pb-1 pt-5 px-5">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-orange-700 dark:text-orange-400">
                Fundos sem Regras
              </CardTitle>
              <div className="p-1.5 rounded-full bg-orange-100 dark:bg-orange-900/40">
                <AlertTriangle className="h-4 w-4 text-orange-600" />
              </div>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              {loadingRegras ? (
                <Loader2 className="h-9 w-9 animate-spin text-orange-400 mt-1" />
              ) : (
                <span className="text-4xl font-extrabold text-orange-600 tabular-nums">{fundosSemRegras}</span>
              )}
              <p className="text-xs text-orange-700/60 dark:text-orange-400/60 mt-1.5 font-medium">
                monitorados na data sem vínculo ativo
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Card oculto: só aparece quando há gaps de XML na janela até a data de referência */}
        {dateStr && (
          <XmlGapsDashboardCard
            dataFimYyyymmdd={dateStr}
            dataFimLabel={date ? format(date, "dd/MM/yyyy", { locale: ptBR }) : formatGapDateYyyymmdd(dateStr)}
          />
        )}

        {/* Gráficos — 3 colunas */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Top 5 Ativos */}
          <Card className="border-border shadow-sm">
            <CardHeader className="pb-2 border-b border-border/50">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <PieChart className="h-4 w-4 text-primary" />
                Top 5 Ativos Mais Concentrados
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Ativos com maior exposição financeira em todo o universo de fundos.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
              {loadingTopAssets ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : topAssets.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">Nenhum dado disponível.</p>
              ) : (
                <div className="space-y-3">
                  {topAssets.map((asset, idx) => (
                    <div
                      key={idx}
                      className="group cursor-pointer hover:bg-muted/40 rounded-md p-2 -mx-2 transition-colors"
                      onClick={() => setDetailModal({
                        type: "asset",
                        title: `Fundos investidos em: ${asset.name}`,
                        columnLabel: "Fundo Investidor",
                        items: asset.fundos.map(cnpj => ({
                          cnpj,
                          name: fundsStatus.find(f => f.fundo_cnpj === cnpj)?.nome_fundo || cnpj
                        }))
                      })}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center">
                          {idx + 1}
                        </span>
                        <span className="text-xs font-medium truncate flex-1 group-hover:text-primary transition-colors" title={asset.name}>
                          {asset.name}
                        </span>
                        <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
                          {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact" }).format(asset.value)}
                          <span className="opacity-60 ml-0.5">({asset.count}x)</span>
                        </span>
                      </div>
                      <div className="flex items-center gap-2 pl-7">
                        <Progress value={asset.percentage} className="h-1.5 flex-1" />
                        <span className="text-[10px] font-bold w-8 text-right tabular-nums text-primary">
                          {asset.percentage.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Concentração por Administrador */}
          <Card className="border-border shadow-sm">
            <CardHeader className="pb-2 border-b border-border/50">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-primary" />
                    Concentração por Administrador
                  </CardTitle>
                  <CardDescription className="text-xs mt-0.5">
                    {adminView === "investidores"
                      ? "PL dos fundos monitorados agrupado por administrador."
                      : "Exposição financeira por administrador dos fundos investidos."}
                  </CardDescription>
                </div>
                <div className="flex shrink-0 items-center rounded-md border border-border overflow-hidden text-[10px] font-semibold">
                  <button
                    className={cn(
                      "px-2.5 py-1 transition-colors",
                      adminView === "investidores"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted"
                    )}
                    onClick={() => setAdminView("investidores")}
                  >
                    Investidores
                  </button>
                  <button
                    className={cn(
                      "px-2.5 py-1 transition-colors border-l border-border",
                      adminView === "investidos"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted"
                    )}
                    onClick={() => setAdminView("investidos")}
                  >
                    Investidos
                  </button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-3">
              {(adminView === "investidores" ? loadingAdminsInvestidores : loadingAdmins) ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (adminView === "investidores" ? topAdminsInvestidores : topAdmins).length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">Nenhum dado disponível.</p>
              ) : (
                <div className="space-y-3">
                  {(adminView === "investidores" ? topAdminsInvestidores : topAdmins).map((item, idx) => {
                    const drillItems =
                      adminView === "investidores"
                        ? (item as typeof topAdminsInvestidores[0]).fundos
                        : (item as typeof topAdmins[0]).fundosInvestidos;
                    const fundCount = drillItems?.length ?? 0;
                    return (
                      <div
                        key={idx}
                        className="group cursor-pointer hover:bg-muted/40 rounded-md p-2 -mx-2 transition-colors"
                        onClick={() =>
                          setDetailModal({
                            type: "admin",
                            title:
                              adminView === "investidores"
                                ? `Fundos investidores administrados por: ${item.name}`
                                : `Fundos investidos administrados por: ${item.name}`,
                            columnLabel:
                              adminView === "investidores" ? "Fundo Investidor" : "Fundo Investido",
                            items: drillItems ?? [],
                          })
                        }
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center">
                            {idx + 1}
                          </span>
                          <span className="text-xs font-medium truncate flex-1 group-hover:text-primary transition-colors" title={item.name}>
                            {item.name}
                          </span>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 font-normal text-muted-foreground">
                              {fundCount}f
                            </Badge>
                            <span className="text-[10px] text-muted-foreground tabular-nums">
                              {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact" }).format(item.value)}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 pl-7">
                          <Progress value={item.percentage} className="h-1.5 flex-1" />
                          <span className="text-[10px] font-bold w-8 text-right tabular-nums text-primary">
                            {item.percentage.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Concentração por Gestor */}
          <Card className="border-border shadow-sm">
            <CardHeader className="pb-2 border-b border-border/50">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" />
                Concentração por Gestor
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Exposição financeira por gestor dos fundos investidos.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
              {loadingGestores ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : topGestores.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">Nenhum dado disponível.</p>
              ) : (
                <div className="space-y-3">
                  {topGestores.map((item, idx) => (
                    <div key={idx} className="group rounded-md p-2 -mx-2">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center">
                          {idx + 1}
                        </span>
                        <span className="text-xs font-medium truncate flex-1" title={item.name}>
                          {item.name}
                        </span>
                        <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
                          {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact" }).format(item.value)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 pl-7">
                        <Progress value={item.percentage} className="h-1.5 flex-1" />
                        <span className="text-[10px] font-bold w-8 text-right tabular-nums text-primary">
                          {item.percentage.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Modais de listagem */}
        <Dialog open={!!listModal} onOpenChange={(o) => !o && setListModal(null)}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>
                {listModal === "enquadrados"
                  ? "Fundos Enquadrados"
                  : "Fundos Desenquadrados"}
              </DialogTitle>
              <DialogDescription>
                {listModal === "enquadrados"
                  ? `${enquadrados.length} fundo(s) em conformidade com todas as regras.`
                  : `${desenquadrados.length} fundo(s) com violação ou alerta.`}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-auto border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="text-[10px] font-bold uppercase">Fundo</TableHead>
                    <TableHead className="text-[10px] font-bold uppercase">CNPJ</TableHead>
                    <TableHead className="text-[10px] font-bold uppercase w-[80px] text-right">Ação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(listModal === "enquadrados" ? enquadrados : desenquadrados).map((f) => (
                    <TableRow key={f.fundo_cnpj} className="hover:bg-muted/30">
                      <TableCell className="font-medium truncate max-w-[280px]" title={f.nome_fundo}>
                        {f.nome_fundo}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {formatCnpj(f.fundo_cnpj)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => {
                            setListModal(null);
                            navigate(`/enquadramento/carteira/${f.fundo_cnpj}`);
                          }}
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </DialogContent>
        </Dialog>
        {/* Modal de Detalhes (Drill-down) */}
        <Dialog open={!!detailModal} onOpenChange={(o) => !o && setDetailModal(null)}>
          <DialogContent className="max-w-xl max-h-[80vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
                Detalhamento de Concentração
              </DialogTitle>
              <DialogDescription className="text-base font-semibold text-foreground">
                {detailModal?.title}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-auto border rounded-md mt-2">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="text-[10px] font-bold uppercase">{detailModal?.columnLabel || "Fundo"}</TableHead>
                    <TableHead className="text-[10px] font-bold uppercase w-[120px]">CNPJ</TableHead>
                    <TableHead className="text-[10px] font-bold uppercase w-[60px] text-right">Ação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detailModal?.items.map((item) => (
                    <TableRow key={item.cnpj} className="hover:bg-muted/30">
                      <TableCell className="font-medium text-xs truncate max-w-[280px]" title={item.name}>
                        {item.name}
                      </TableCell>
                      <TableCell className="font-mono text-[10px] text-muted-foreground">
                        {item.cnpj.length === 14 ? formatCnpj(item.cnpj) : item.cnpj}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => {
                            setDetailModal(null);
                            navigate(`/enquadramento/carteira/${item.cnpj}`);
                          }}
                        >
                          <ChevronRight className="h-3 w-3" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {detailModal?.items.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center py-4 text-xs text-muted-foreground">
                        Nenhum fundo encontrado.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </Layout>
  );
}
