import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
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
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  fmtCnpj,
  fmtData,
  type FundoXmlCoverageRow,
} from "@/hooks/useRentabilidadeCalc";

interface FundosComXmlIndicatorProps {
  dataRefIso: string | null;
  dataRefLabel?: string;
  total: number;
  importados: number;
  faltantes: FundoXmlCoverageRow[];
  isLoading?: boolean;
  variant?: "card" | "compact";
  className?: string;
}

export function FundosComXmlIndicator({
  dataRefIso,
  dataRefLabel,
  total,
  importados,
  faltantes,
  isLoading = false,
  variant = "card",
  className,
}: FundosComXmlIndicatorProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const hasFaltantes = faltantes.length > 0;
  const labelData = dataRefLabel ?? (dataRefIso ? fmtData(dataRefIso) : "—");

  const handleOpen = () => {
    if (dataRefIso && hasFaltantes) setDialogOpen(true);
  };

  const content = isLoading || !dataRefIso ? (
    <Skeleton
      className={cn(
        variant === "compact" ? "h-4 w-16" : "h-7 w-24",
      )}
    />
  ) : variant === "compact" ? (
    <span
      className={cn(
        "tabular-nums font-bold",
        importados < total && "text-amber-700 dark:text-amber-500",
      )}
    >
      {importados}
      <span className="text-muted-foreground font-bold"> / {total}</span>
    </span>
  ) : (
    <>
      <p
        className={cn(
          "font-semibold tabular-nums text-lg",
          importados < total && "text-amber-700 dark:text-amber-500",
        )}
      >
        {importados}{" "}
        <span className="text-muted-foreground font-normal">/ {total}</span>
      </p>
      <p className="text-[11px] text-muted-foreground mt-0.5">
        {hasFaltantes
          ? `${faltantes.length} faltante${faltantes.length !== 1 ? "s" : ""} — clique para listar`
          : "Todos os fundos ativos com XML nesta data"}
      </p>
      <p className="text-[10px] text-muted-foreground/80 mt-0.5">
        Universo por classe (fundo_key); inativos há mais de 10 dias fora da
        contagem · PL via fundo_patliq (import-xml)
      </p>
    </>
  );

  const indicator = (
    <>
      {variant === "card" ? (
        <Card
          className={cn(
            "transition-colors",
            hasFaltantes && dataRefIso && "cursor-pointer hover:bg-muted/40",
            className,
          )}
          onClick={handleOpen}
          title={
            hasFaltantes ? "Clique para ver fundos sem XML nesta data" : undefined
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
              Fundos com XML
            </CardTitle>
          </CardHeader>
          <CardContent>{content}</CardContent>
        </Card>
      ) : (
        <div
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--surface-card)] px-3 text-sm font-medium transition-colors whitespace-nowrap",
            hasFaltantes && dataRefIso && "cursor-pointer hover:bg-muted/40",
            className,
          )}
          onClick={handleOpen}
          title={
            hasFaltantes
              ? `${faltantes.length} faltante${faltantes.length !== 1 ? "s" : ""} — clique para listar`
              : "Todos os fundos ativos com XML nesta data"
          }
        >
          <span className="text-foreground">Fundos com XML</span>
          {content}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>XML faltante em {labelData}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground -mt-2">
            {importados} de {total} fundos ativos com posição importada nesta
            data (último XML nos últimos 10 dias).
          </p>
          {faltantes.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Nenhum fundo faltante.
            </p>
          ) : (
            <div className="overflow-auto flex-1 -mx-1">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fundo</TableHead>
                    <TableHead>CNPJ</TableHead>
                    <TableHead>ISIN</TableHead>
                    <TableHead>Administrador</TableHead>
                    <TableHead className="text-right">Último XML</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {faltantes.map((f) => (
                    <TableRow key={f.fundo_key}>
                      <TableCell className="font-medium">
                        {f.nome_fundo || "—"}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {fmtCnpj(f.cnpj_fundo)}
                      </TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">
                        {f.fundo_isin || "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {f.administrador || "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {f.ultima_data_iso ? fmtData(f.ultima_data_iso) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );

  return indicator;
}
