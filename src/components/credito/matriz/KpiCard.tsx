import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ReactNode } from "react";

type Variant = "ok" | "atencao" | "critico" | "info" | "neutral";

const variantClasses: Record<Variant, string> = {
  ok:      "border-emerald-500/30 bg-emerald-500/5",
  atencao: "border-yellow-500/30 bg-yellow-500/5",
  critico: "border-red-500/30 bg-red-500/5",
  info:    "border-blue-500/30 bg-blue-500/5",
  neutral: "border-border bg-card",
};

const labelClasses: Record<Variant, string> = {
  ok:      "text-emerald-400",
  atencao: "text-yellow-400",
  critico: "text-red-400",
  info:    "text-blue-400",
  neutral: "text-muted-foreground",
};

type Props = {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  variant?: Variant;
  isLoading?: boolean;
  className?: string;
  tooltip?: ReactNode;
};

export function KpiCard({ label, value, sub, variant = "neutral", isLoading, className, tooltip }: Props) {
  const card = (
    <div className={cn("rounded-lg border p-4 flex flex-col gap-1", variantClasses[variant], className)}>
      <span className="text-[10px] uppercase tracking-widest font-medium text-muted-foreground">
        {label}
      </span>
      {isLoading ? (
        <Skeleton className="h-7 w-28 mt-1" />
      ) : (
        <span className={cn("text-2xl font-bold font-mono tabular-nums", labelClasses[variant])}>
          {value}
        </span>
      )}
      {sub && !isLoading && (
        <span className="text-xs text-muted-foreground mt-0.5">{sub}</span>
      )}
    </div>
  );

  if (!tooltip) return card;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-help outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
            {card}
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm p-3 text-xs leading-relaxed" side="bottom">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
