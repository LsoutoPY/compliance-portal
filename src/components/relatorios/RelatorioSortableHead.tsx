import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ChevronsUpDown, ChevronUp, ChevronDown } from "lucide-react";
import { getSortTitle, type SortDirection } from "./useRelatorioSort";

function renderSortIcon(direction: SortDirection) {
  if (direction === "none") return <ChevronsUpDown className="h-3 w-3 text-muted-foreground/50" />;
  if (direction === "asc") return <ChevronUp className="h-3 w-3 text-primary" />;
  return <ChevronDown className="h-3 w-3 text-primary" />;
}

interface RelatorioSortableHeadProps {
  label: string;
  sortKey: string;
  direction: SortDirection;
  onSort: (key: string) => void;
  align?: "left" | "center" | "right";
  className?: string;
  /** Conteúdo extra (ex.: filtro popover) ao lado do botão de ordenação */
  trailing?: React.ReactNode;
}

export function RelatorioSortableHead({
  label,
  sortKey,
  direction,
  onSort,
  align = "left",
  className,
  trailing,
}: RelatorioSortableHeadProps) {
  const alignClass =
    align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";

  return (
    <TableHead className={cn("text-[10px] font-bold uppercase", className)}>
      <div className={cn("flex items-center gap-1", alignClass)}>
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          title={getSortTitle(label, direction)}
          className={cn(
            "inline-flex items-center gap-1 tracking-wider hover:text-foreground transition-colors",
            direction !== "none" ? "text-primary" : "text-muted-foreground",
          )}
        >
          <span>{label}</span>
          {renderSortIcon(direction)}
        </button>
        {trailing}
      </div>
    </TableHead>
  );
}
