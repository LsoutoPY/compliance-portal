import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Timer, TrendingUp, AlertCircle, ChevronDown, ChevronUp, List, CalendarDays } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface WamAtivo {
  id: string;
  nome: string;
  section: string;
  valor: number;
  prazos_em_dias: number | null;
  peso_pl: number;
  contribuicao_dias: number;
  /** Presente quando o prazo foi calculado via cronograma de fluxos (Art. 4º §2º II) */
  metodo_prazo_rf?: "fluxo_nominal";
}

interface PrazoMedioCarteiraProps {
  fundoCnpj: string;
  fundoDtposicao: string;
  totalPL: number;
}

const SECTION_LABELS: Record<string, string> = {
  titpublico: "Títulos Públicos",
  titprivado: "Títulos Privados",
  termorf: "Termo RF",
  acoes: "Ações",
  cotas: "Cotas",
  fidc: "FIDC",
};

function getSectionLabel(section: string): string {
  return SECTION_LABELS[(section || "").toLowerCase()] ?? section;
}

/**
 * Escala invertida: prazo longo = verde (esperado para fundos fechados/FIDC NP),
 * prazo curto = vermelho (sinal de alerta para ativos ilíquidos mal classificados).
 */
function getPrazoColor(dias: number): string {
  if (dias > 252) return "text-emerald-600";
  if (dias > 90)  return "text-blue-600";
  if (dias > 30)  return "text-amber-600";
  return "text-red-600";
}

function getPrazoBadgeStyle(dias: number): { variant: "default" | "secondary" | "outline" | "destructive"; className: string } {
  if (dias > 252) return { variant: "secondary", className: "bg-emerald-100 text-emerald-700 border border-emerald-200" };
  if (dias > 90)  return { variant: "secondary", className: "bg-blue-100 text-blue-700 border border-blue-200" };
  if (dias > 30)  return { variant: "outline",   className: "bg-amber-50 text-amber-700 border-amber-300" };
  return { variant: "destructive", className: "" };
}

function getPrazoLabel(dias: number): string {
  if (dias > 252) return "Longo Prazo";
  if (dias > 90)  return "Médio Prazo";
  if (dias > 30)  return "Curto Prazo";
  return "Muito Curto Prazo";
}

const formatBRL = (val: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(val);

const formatPerc = (val: number) =>
  `${(val * 100).toFixed(2)}%`;

export function PrazoMedioCarteira({
  fundoCnpj,
  fundoDtposicao,
  totalPL,
}: PrazoMedioCarteiraProps) {
  const [tabelaAberta, setTabelaAberta] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["prazo-medio-carteira", fundoCnpj, fundoDtposicao],
    enabled: !!fundoCnpj && !!fundoDtposicao,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data: resp, error } = await supabase.functions.invoke<{
        success: boolean;
        data: {
          prazoMedioCarteira: number | null;
          wamAtivos: WamAtivo[];
          totalPL: number;
        };
      }>("calculo-risco-liquidez", {
        body: { fundo_cnpj: fundoCnpj, fundo_dtposicao: fundoDtposicao },
      });
      if (error) throw error;
      if (!resp?.success) throw new Error("Erro ao calcular prazo médio");
      return resp.data;
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="h-8 w-1 bg-primary rounded-full" />
          <div className="space-y-1">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-3 w-72" />
          </div>
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="space-y-6">
        <SectionHeader />
        <Card className="border border-border/50">
          <CardContent className="p-6 flex items-center gap-3 text-muted-foreground">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <p className="text-sm">Não foi possível calcular o prazo médio da carteira.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { prazoMedioCarteira, wamAtivos } = data;
  const prazoArredondado = prazoMedioCarteira != null ? Math.round(prazoMedioCarteira) : null;

  // Agrupa por seção para exibir subtotais
  const groupedBySec = wamAtivos.reduce<Record<string, { valor: number; contribuicao: number; count: number }>>(
    (acc, a) => {
      const sec = (a.section || "").toLowerCase();
      if (!acc[sec]) acc[sec] = { valor: 0, contribuicao: 0, count: 0 };
      acc[sec].valor += a.valor;
      acc[sec].contribuicao += a.contribuicao_dias;
      acc[sec].count += 1;
      return acc;
    },
    {}
  );

  const semPrazoValor = wamAtivos
    .filter((a) => a.prazos_em_dias == null)
    .reduce((s, a) => s + a.valor, 0);
  const percSemPrazo = totalPL > 0 ? (semPrazoValor / totalPL) * 100 : 0;

  const badgeStyle = prazoArredondado != null ? getPrazoBadgeStyle(prazoArredondado) : null;

  return (
    <div className="space-y-6">
      <SectionHeader />

      {/* Card principal com o indicador */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border border-border/50 sm:col-span-1">
          <CardContent className="p-5 flex flex-col items-center justify-center gap-2 text-center h-full">
            <Timer className="h-8 w-8 text-primary/70" />
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Prazo Médio Ponderado
            </p>
            {prazoArredondado != null && badgeStyle ? (
              <>
                <p className={cn("text-4xl font-extrabold tracking-tight", getPrazoColor(prazoArredondado))}>
                  D+{prazoArredondado}
                </p>
                <Badge variant={badgeStyle.variant} className={cn("text-[10px]", badgeStyle.className)}>
                  {getPrazoLabel(prazoArredondado)}
                </Badge>
                <p className="text-[10px] text-muted-foreground">dias úteis</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Dados insuficientes</p>
            )}
          </CardContent>
        </Card>

        {/* Breakdown por seção */}
        <Card className="border border-border/50 sm:col-span-2">
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Composição do Prazo por Tipo
              </p>
            </div>
            {Object.entries(groupedBySec).map(([sec, g]) => {
              const percPl = totalPL > 0 ? (g.valor / totalPL) * 100 : 0;
              const prazoSecReal = totalPL > 0 && g.valor > 0
                ? (g.contribuicao / (g.valor / totalPL))
                : null;
              const prazoSecArred = prazoSecReal != null ? Math.round(prazoSecReal) : null;

              return (
                <div key={sec} className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold text-foreground truncate">
                      {getSectionLabel(sec)}
                    </span>
                    <span className="text-muted-foreground shrink-0">
                      ({g.count} ativo{g.count !== 1 ? "s" : ""})
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-muted-foreground w-16 text-right">
                      {percPl.toFixed(1)}% PL
                    </span>
                    {prazoSecArred != null ? (
                      <span className={cn("font-bold w-14 text-right", getPrazoColor(prazoSecArred))}>
                        D+{prazoSecArred}
                      </span>
                    ) : (
                      <span className="text-muted-foreground w-14 text-right">–</span>
                    )}
                    <span className="text-muted-foreground w-16 text-right text-[10px]">
                      {formatBRL(g.valor)}
                    </span>
                  </div>
                </div>
              );
            })}

            {percSemPrazo > 0.01 && (
              <div className="pt-2 border-t border-dashed border-amber-300/60 flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                  <span className="text-amber-700 font-semibold">Sem prazo mapeado</span>
                </div>
                <span className="text-amber-700 font-semibold">{percSemPrazo.toFixed(1)}% PL</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tabela detalhada dos ativos WAM — colapsável */}
      {wamAtivos.length > 0 && (
        <Card className="border border-border/50">
          {/* Header clicável para expandir/recolher */}
          <button
            type="button"
            onClick={() => setTabelaAberta((prev) => !prev)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors rounded-t-lg focus:outline-none"
          >
            <div className="flex items-center gap-2">
              <List className="h-4 w-4 text-muted-foreground" />
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Detalhamento por Ativo
              </span>
              <span className="text-[10px] text-muted-foreground">
                ({wamAtivos.length} ativo{wamAtivos.length !== 1 ? "s" : ""})
              </span>
            </div>
            {tabelaAberta
              ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
              : <ChevronDown className="h-4 w-4 text-muted-foreground" />
            }
          </button>

          {tabelaAberta && (
            <CardContent className="p-0 border-t border-border/50">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/30 border-b border-border/50">
                      <th className="text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-4 py-3">
                        Ativo
                      </th>
                      <th className="text-center text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-3 py-3">
                        Tipo
                      </th>
                      <th className="text-right text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-3 py-3">
                        Valor
                      </th>
                      <th className="text-right text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-3 py-3">
                        % PL
                      </th>
                      <th className="text-right text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-3 py-3">
                        Prazo (d.u.)
                      </th>
                      <th className="text-right text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-4 py-3">
                        Contribuição
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {wamAtivos.map((a, i) => (
                      <tr
                        key={`${a.id}-${i}`}
                        className="border-b border-border/30 hover:bg-muted/20 transition-colors"
                      >
                        <td className="px-4 py-2.5 font-medium text-foreground max-w-[220px] truncate">
                          {a.nome || "–"}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <Badge variant="outline" className="text-[9px] uppercase">
                            {getSectionLabel(a.section)}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right text-muted-foreground">
                          {formatBRL(a.valor)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-muted-foreground">
                          {formatPerc(a.peso_pl)}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {a.prazos_em_dias != null ? (
                            <span className="inline-flex items-center gap-1 justify-end">
                              <span className={cn("font-semibold", getPrazoColor(a.prazos_em_dias))}>
                                D+{Math.round(a.prazos_em_dias)}
                              </span>
                              {a.metodo_prazo_rf === "fluxo_nominal" && (
                                <TooltipProvider delayDuration={200}>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="inline-flex items-center gap-0.5 rounded bg-blue-100 text-blue-700 text-[8px] font-bold px-1 py-0.5 cursor-default select-none">
                                        <CalendarDays className="h-2.5 w-2.5" />
                                        Inc. II
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[200px] text-xs">
                                      Prazo calculado por WAM de fluxos nominais (Art. 4º §2º II IN RFB 1585/2015), não pelo vencimento final.
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                            </span>
                          ) : (
                            <span className="text-amber-500 font-semibold">–</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium text-foreground">
                          {a.contribuicao_dias.toFixed(2)} d
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {prazoArredondado != null && (
                    <tfoot>
                      <tr className="bg-muted/30 border-t border-border/50 font-bold">
                        <td colSpan={5} className="px-4 py-3 text-right text-sm text-foreground">
                          Prazo Médio Ponderado (WAM)
                        </td>
                        <td className={cn("px-4 py-3 text-right text-sm", getPrazoColor(prazoArredondado))}>
                          D+{prazoArredondado}
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}

function SectionHeader() {
  return (
    <div className="flex items-center gap-3">
      <div className="h-8 w-1 bg-primary rounded-full" />
      <div>
        <h3 className="text-lg font-bold tracking-tight text-foreground">
          Prazo Médio da Carteira
        </h3>
        <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
          Prazo Médio Ponderado (WAM) dos Ativos por % do PL
        </p>
      </div>
    </div>
  );
}
