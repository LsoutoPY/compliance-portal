/**
 * Tabela matricial com colunas monetárias alinhadas à direita (font-mono)
 * e linha de total destacada.
 */
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { ReactNode } from "react";

export type MatrizColDef<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  headerClass?: string;
  cellClass?: string;
};

type Props<T> = {
  columns: MatrizColDef<T>[];
  rows: T[];
  getKey: (row: T) => string;
  totalRow?: ReactNode;
  isLoading?: boolean;
  emptyMessage?: string;
  className?: string;
  stickyHeader?: boolean;
};

export function MatrizTable<T>({
  columns,
  rows,
  getKey,
  totalRow,
  isLoading,
  emptyMessage = "Sem dados para o período selecionado.",
  className,
  stickyHeader,
}: Props<T>) {
  if (isLoading) {
    return (
      <div className={cn("space-y-1", className)}>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className={cn("rounded-md border border-border overflow-auto", className)}>
      <Table>
        <TableHeader className={cn(stickyHeader && "sticky top-0 z-10")}>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            {columns.map((col) => (
              <TableHead
                key={col.key}
                className={cn(
                  "text-xs text-muted-foreground font-semibold uppercase tracking-wide whitespace-nowrap",
                  col.headerClass,
                )}
              >
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="text-center text-muted-foreground text-sm py-8"
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={getKey(row)} className="hover:bg-muted/20">
                {columns.map((col) => (
                  <TableCell
                    key={col.key}
                    className={cn(
                      "text-sm py-2 tabular-nums",
                      col.cellClass,
                    )}
                  >
                    {col.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
          {totalRow && (
            <TableRow className="bg-muted/40 font-semibold border-t-2 border-border">
              {totalRow}
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
