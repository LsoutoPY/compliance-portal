import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Clock, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Asset } from "./WalletTable";

interface LiquidityControlProps {
  assets: Asset[];
  prazoFundoDias?: number | null;
  totalPL: number;
}

interface LiquidityRow {
  valor: number;
  prazoResgateDias: number | null;
}

const formatBRL = (val: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(val);

const formatPerc = (val: number) => `${val.toFixed(2)}%`;

export function LiquidityControl({ assets, prazoFundoDias, totalPL }: LiquidityControlProps) {
  // Montar linhas de liquidez a partir dos mesmos assets da Composição da Carteira
  const rows = useMemo((): LiquidityRow[] => {
    const validSections = new Set(["cotas", "titpublico", "titprivado", "termorf", "caixa", "acoes", "participacoes", "fidc", "imoveis"]);
    const result: LiquidityRow[] = [];

    assets.forEach((a) => {
      const section = (a.section || "").toLowerCase();
      const val = a.valor_padrao || 0;
      if (val <= 0 || !validSections.has(section)) return;

      let prazo: number | null = null;
      if (section === "caixa") {
        prazo = 0;
      } else {
        prazo = a.prazo_pagamento_resgate_dias ?? null;
      }

      result.push({
        valor: val,
        prazoResgateDias: prazo,
      });
    });

    return result;
  }, [assets]);

  const faixas = useMemo(() => {
    const base = [
      { id: "d0d5", label: "D+0 até D+5", match: (p: number | null) => p != null && p >= 0 && p <= 5 },
      { id: "d6d30", label: "D+6 até D+30", match: (p: number | null) => p != null && p > 5 && p <= 30 },
      { id: "d31d60", label: "D+31 até D+60", match: (p: number | null) => p != null && p > 30 && p <= 60 },
      { id: "d61d252", label: "D+61 até D+252", match: (p: number | null) => p != null && p > 60 && p <= 252 },
    ];

    const computed = base.map((bucket) => {
      const ativosNaFaixa = rows.filter((a) => bucket.match(a.prazoResgateDias));
      const valor = ativosNaFaixa.reduce((sum, a) => sum + a.valor, 0);
      const percentual = totalPL > 0 ? (valor / totalPL) * 100 : 0;
      return { id: bucket.id, label: bucket.label, valor, percentual, count: ativosNaFaixa.length, isPrazoFundo: false };
    });

    if (prazoFundoDias != null && prazoFundoDias >= 0) {
      const atePrazo = rows.filter((a) => a.prazoResgateDias != null && a.prazoResgateDias <= prazoFundoDias);
      const valor = atePrazo.reduce((sum, a) => sum + a.valor, 0);
      const percentual = totalPL > 0 ? (valor / totalPL) * 100 : 0;
      computed.push({
        id: "prazo-fundo",
        label: `Até prazo do fundo (D+${prazoFundoDias})`,
        valor,
        percentual,
        count: atePrazo.length,
        isPrazoFundo: true,
      });
    }

    return computed;
  }, [rows, prazoFundoDias, totalPL]);

  const semPrazo = useMemo(() => rows.filter((a) => a.prazoResgateDias == null), [rows]);
  const totalSemPrazo = semPrazo.reduce((s, a) => s + a.valor, 0);
  const percSemPrazo = totalPL > 0 ? (totalSemPrazo / totalPL) * 100 : 0;

  if (rows.length === 0) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="h-8 w-1 bg-blue-500 rounded-full" />
        <div>
          <h3 className="text-lg font-bold tracking-tight text-foreground">Controle de Liquidez</h3>
          <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
            Distribuição da carteira por prazo de resgate
          </p>
        </div>
      </div>

      <Card className="border border-border/50">
        <CardContent className="p-4 space-y-4">
          {faixas.map((f) => (
            <div key={f.id} className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Clock className={cn("h-4 w-4 shrink-0", f.isPrazoFundo ? "text-blue-600" : "text-muted-foreground")} />
                  <span className={cn("text-xs font-semibold truncate", f.isPrazoFundo ? "text-blue-700" : "text-foreground")}>
                    {f.label}
                  </span>
                  {f.isPrazoFundo && (
                    <Badge variant="outline" className="text-[9px] border-blue-300 text-blue-600 bg-blue-50">
                      Prazo Fundo
                    </Badge>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-xs font-bold">{formatPerc(f.percentual)}</p>
                  <p className="text-[10px] text-muted-foreground">{formatBRL(f.valor)}</p>
                </div>
              </div>
              <Progress value={Math.min(f.percentual, 100)} className="h-2.5" />
              <p className="text-[10px] text-muted-foreground">{f.count} ativo(s)</p>
            </div>
          ))}

          {semPrazo.length > 0 && (
            <div className="pt-2 border-t border-dashed border-amber-300/60 space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  <span className="text-xs font-semibold text-amber-700">Sem prazo</span>
                </div>
                <div className="text-right">
                  <p className="text-xs font-bold text-amber-700">{formatPerc(percSemPrazo)}</p>
                  <p className="text-[10px] text-muted-foreground">{formatBRL(totalSemPrazo)}</p>
                </div>
              </div>
              <Progress value={Math.min(percSemPrazo, 100)} className="h-2.5" />
              <p className="text-[10px] text-muted-foreground">{semPrazo.length} ativo(s)</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
