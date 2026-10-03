import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  buildVsCDITooltipLines,
  fmtPct,
  fmtPctCDI,
} from "@/hooks/useRentabilidadeCalc";

function pctColor(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v > 0) return "text-emerald-600 dark:text-emerald-400";
  if (v < 0) return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

export function RetComPctCdiCell({
  retornoPct,
  pctCdi,
  cdiBenchPct = null,
  cdiPlusPct = null,
  retornoLabel = "Retorno 12 meses",
  cdiLabel = "CDI acum. 12M",
  duAnual = 1,
  size = "sm",
}: {
  retornoPct: number | null;
  pctCdi: number | null;
  cdiBenchPct?: number | null;
  cdiPlusPct?: number | null;
  retornoLabel?: string;
  cdiLabel?: string;
  duAnual?: number;
  size?: "sm" | "lg";
}) {
  const showPctCdi =
    retornoPct != null &&
    retornoPct >= 0 &&
    pctCdi != null &&
    pctCdi >= 0;

  const tooltipLines = buildVsCDITooltipLines(
    retornoPct,
    cdiBenchPct,
    cdiPlusPct,
    pctCdi,
    retornoLabel,
    cdiLabel,
    duAnual,
  );
  const hasTooltip = tooltipLines.length > 0;

  const valueClass =
    size === "lg" ? "text-lg font-semibold" : "text-xs font-medium";

  const content = (
    <div
      className={cn(
        "leading-snug space-y-0.5",
        size === "lg" ? "" : "text-right text-xs",
        hasTooltip && "cursor-help",
      )}
    >
      <div className={cn(valueClass, pctColor(retornoPct))}>
        {fmtPct(retornoPct)}
      </div>
      {showPctCdi && (
        <div
          className={
            size === "lg" ? "text-sm text-muted-foreground" : "text-muted-foreground"
          }
        >
          {fmtPctCDI(pctCdi)}
        </div>
      )}
    </div>
  );

  if (!hasTooltip) return content;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="left" className="max-w-[280px] text-xs space-y-1">
        {tooltipLines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
