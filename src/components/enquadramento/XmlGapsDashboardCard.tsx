import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
import { Loader2, AlertTriangle, XCircle, FileUp, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useXmlGaps } from "@/hooks/useXmlGaps";
import {
  formatGapDateYyyymmdd,
  gerarDiasUteis,
  listarAnosXmlGaps,
  type XmlGapPorFundo,
} from "@/lib/xmlGaps";

interface XmlGapsDashboardCardProps {
  dataFimYyyymmdd: string | null;
  dataFimLabel?: string;
}

function formatCnpj(cnpj: string) {
  const d = cnpj.replace(/\D/g, "").padStart(14, "0");
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

function FundoGapHeatmap({
  fundo,
  inicioYyyymmdd,
  fimYyyymmdd,
}: {
  fundo: XmlGapPorFundo;
  inicioYyyymmdd: string;
  fimYyyymmdd: string;
}) {
  const gapSet = useMemo(() => new Set(fundo.datas), [fundo.datas]);
  const dias = useMemo(
    () => gerarDiasUteis(inicioYyyymmdd, fimYyyymmdd),
    [inicioYyyymmdd, fimYyyymmdd],
  );

  return (
    <div className="flex flex-wrap gap-0.5 max-w-full">
      {dias.map((d) => {
        const isGap = gapSet.has(d);
        return (
          <div
            key={d}
            title={`${formatGapDateYyyymmdd(d)} — ${isGap ? "XML faltante" : "OK"}`}
            className={cn(
              "h-2.5 w-2.5 rounded-[2px] shrink-0",
              isGap ? "bg-red-500" : "bg-emerald-500/70",
            )}
          />
        );
      })}
    </div>
  );
}

export function XmlGapsDashboardCard({
  dataFimYyyymmdd,
  dataFimLabel,
}: XmlGapsDashboardCardProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [expandedFund, setExpandedFund] = useState<string | null>(null);

  const anoRef = dataFimYyyymmdd
    ? Number(dataFimYyyymmdd.slice(0, 4))
    : new Date().getFullYear();
  const anosDisponiveis = useMemo(
    () => (dataFimYyyymmdd ? listarAnosXmlGaps(dataFimYyyymmdd) : [anoRef]),
    [dataFimYyyymmdd, anoRef],
  );

  const [anoSelecionado, setAnoSelecionado] = useState(anoRef);

  useEffect(() => {
    setAnoSelecionado(anoRef);
  }, [anoRef, dataFimYyyymmdd]);

  const { grouped, isLoading, refetch, isFetching } = useXmlGaps({
    dataFimRefYyyymmdd: dataFimYyyymmdd,
    ano: anoSelecionado,
    enabled: !!dataFimYyyymmdd,
  });

  const { grouped: groupedCard, isLoading: loadingCard } = useXmlGaps({
    dataFimRefYyyymmdd: dataFimYyyymmdd,
    ano: anoRef,
    enabled: !!dataFimYyyymmdd,
  });

  if (!dataFimYyyymmdd || loadingCard) return null;
  if (!groupedCard.totalGaps) return null;

  const labelData = dataFimLabel ?? formatGapDateYyyymmdd(dataFimYyyymmdd);
  const janelaLabel =
    grouped.janelaInicio && grouped.janelaFim
      ? `${formatGapDateYyyymmdd(grouped.janelaInicio)} — ${formatGapDateYyyymmdd(grouped.janelaFim)}`
      : labelData;

  return (
    <>
      <Card
        className="cursor-pointer border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10 transition-colors border-l-4 border-l-amber-500"
        onClick={() => setOpen(true)}
      >
        <CardHeader className="flex flex-row items-center justify-between pb-1 pt-4 px-5">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            XMLs pendentes
          </CardTitle>
          <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-400">
            {groupedCard.totalFundosComGap} fundo{groupedCard.totalFundosComGap !== 1 ? "s" : ""}
          </Badge>
        </CardHeader>
        <CardContent className="px-5 pb-4">
          <p className="text-2xl font-extrabold text-amber-700 dark:text-amber-400 tabular-nums">
            {groupedCard.totalGaps}
            <span className="text-sm font-medium text-muted-foreground ml-2">
              gap{grouped.totalGaps !== 1 ? "s" : ""} em dias úteis
            </span>
          </p>
          <p className="text-xs text-amber-700/70 dark:text-amber-400/70 mt-1">
            Clique para ver mapa por fundo e por data →
          </p>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              Integridade de XML — dias úteis
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Fundos ativos (XML com cota válida nos últimos 10 dias) na janela{" "}
                  <span className="font-medium text-foreground">{janelaLabel}</span>.
                  Dias úteis (Seg–Sex) em que ao menos um fundo teve posição importada.
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Ano:</span>
                  <div className="flex items-center rounded-md border border-border overflow-hidden text-xs font-semibold">
                    {anosDisponiveis.map((ano) => (
                      <button
                        key={ano}
                        type="button"
                        className={cn(
                          "px-3 py-1 transition-colors border-r border-border last:border-r-0",
                          anoSelecionado === ano
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted",
                        )}
                        onClick={() => {
                          setAnoSelecionado(ano);
                          setExpandedFund(null);
                        }}
                      >
                        {ano}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : grouped.totalGaps === 0 ? (
            <div className="py-8 text-center space-y-2">
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                Nenhum gap em {anoSelecionado}
              </p>
              <p className="text-xs text-muted-foreground">
                Todos os fundos ativos com XML (cota válida) nos dias úteis de{" "}
                {janelaLabel}.
              </p>
            </div>
          ) : (
            <>
          <div className="flex items-center justify-between gap-2 -mt-1">
            <p className="text-xs text-muted-foreground">
              {grouped.totalGaps} gap{grouped.totalGaps !== 1 ? "s" : ""} ·{" "}
              {grouped.totalFundosComGap} fundo{grouped.totalFundosComGap !== 1 ? "s" : ""} ·{" "}
              universo: {grouped.totalFundosUniverso}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={isFetching}
                onClick={() => refetch()}
              >
                {isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : "Atualizar"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={() => {
                  setOpen(false);
                  navigate("/enquadramento/importar");
                }}
              >
                <FileUp className="h-3 w-3" />
                Importar XML
              </Button>
            </div>
          </div>

          {grouped.datasLoteCompleto.length > 0 && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 space-y-1">
              <p className="text-xs font-semibold text-red-700 dark:text-red-400 flex items-center gap-1">
                <XCircle className="w-3.5 h-3.5" />
                Lote completo não importado
              </p>
              <p className="text-xs font-mono text-red-600 dark:text-red-300">
                {grouped.datasLoteCompleto.map(formatGapDateYyyymmdd).join(" · ")}
              </p>
            </div>
          )}

          <Tabs defaultValue="por-fundo" className="flex-1 min-h-0 flex flex-col">
            <TabsList className="h-8 w-fit">
              <TabsTrigger value="por-fundo" className="text-xs">
                Por fundo
              </TabsTrigger>
              <TabsTrigger value="por-data" className="text-xs">
                Por data
              </TabsTrigger>
            </TabsList>

            <TabsContent value="por-fundo" className="flex-1 min-h-0 overflow-auto mt-3 space-y-2">
              {grouped.porFundo.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  Todos os gaps são de lote completo (nenhum fundo individual).
                </p>
              ) : (
                grouped.porFundo.map((fundo) => {
                  const key = `${fundo.fundo_cnpj}|${fundo.fundo_isin}`;
                  const expanded = expandedFund === key;
                  return (
                    <div
                      key={key}
                      className="rounded-md border border-border/60 p-3 space-y-2"
                    >
                      <button
                        type="button"
                        className="w-full flex items-start justify-between gap-2 text-left"
                        onClick={() => setExpandedFund(expanded ? null : key)}
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate" title={fundo.nome_fundo}>
                            {fundo.nome_fundo || formatCnpj(fundo.fundo_cnpj)}
                          </p>
                          <p className="text-[10px] text-muted-foreground font-mono">
                            {formatCnpj(fundo.fundo_cnpj)}
                            {fundo.fundo_isin ? ` · ${fundo.fundo_isin}` : ""}
                          </p>
                        </div>
                        <Badge variant="secondary" className="shrink-0 text-[10px]">
                          {fundo.datas.length} dia{fundo.datas.length !== 1 ? "s" : ""}
                        </Badge>
                      </button>

                      {expanded && grouped.janelaInicio && grouped.janelaFim ? (
                        <div className="space-y-2 pt-1 border-t border-border/40">
                          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <span className="h-2 w-2 rounded-[2px] bg-emerald-500/70" /> OK
                            </span>
                            <span className="flex items-center gap-1">
                              <span className="h-2 w-2 rounded-[2px] bg-red-500" /> Faltante
                            </span>
                          </div>
                          <FundoGapHeatmap
                            fundo={fundo}
                            inicioYyyymmdd={grouped.janelaInicio}
                            fimYyyymmdd={grouped.janelaFim}
                          />
                          <p className="text-xs font-mono text-amber-700 dark:text-amber-300">
                            {fundo.datasFmt.join(" · ")}
                          </p>
                        </div>
                      ) : (
                        <p className="text-xs font-mono text-amber-700/80 dark:text-amber-300/80 truncate">
                          {fundo.datasFmt.join(" · ")}
                        </p>
                      )}
                    </div>
                  );
                })
              )}
            </TabsContent>

            <TabsContent value="por-data" className="flex-1 min-h-0 overflow-auto mt-3">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="text-[10px] font-bold uppercase">Data</TableHead>
                    <TableHead className="text-[10px] font-bold uppercase">Fundos faltantes</TableHead>
                    <TableHead className="text-[10px] font-bold uppercase w-[80px]">Tipo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grouped.porData.map((item) => (
                    <TableRow key={item.data_faltante}>
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        {item.dataFmt}
                      </TableCell>
                      <TableCell className="text-xs">
                        {item.loteCompleto ? (
                          <span className="text-red-600 dark:text-red-400 font-medium">
                            Todos os {item.fundos.length} fundos
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            {item.fundos.map((f) => f.nome_fundo || f.fundo_cnpj).join(" · ")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {item.loteCompleto ? (
                          <Badge variant="destructive" className="text-[9px]">Lote</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[9px]">
                            {item.fundos.length}f
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
          </Tabs>

          <div className="flex items-center justify-end pt-2 border-t border-border/50">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs gap-1"
              onClick={() => {
                setOpen(false);
                navigate("/enquadramento/importar");
              }}
            >
              Ir para importação
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
