import { cn } from "@/lib/utils";

interface UtilizacaoBarProps {
  pct: number | null;
  className?: string;
}

/** Barra de utilização: preenchimento até 100%, marcador no limite, vermelho além de 100%. */
export function UtilizacaoBar({ pct, className }: UtilizacaoBarProps) {
  if (pct == null || !Number.isFinite(pct)) {
    return <span className="text-muted-foreground text-[10px]">—</span>;
  }

  const fillPct = Math.min(Math.max(pct, 0), 100);
  const overflowPct = Math.max(0, pct - 100);
  const fillColor =
    pct > 100 ? "bg-red-600" : pct >= 85 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <div className={cn("relative h-3.5 w-full min-w-[108px] rounded-sm bg-muted/80", className)}>
      <div
        className={cn("absolute inset-y-0 left-0 rounded-sm transition-all", fillColor)}
        style={{ width: `${fillPct}%` }}
      />
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-foreground/50 z-10"
        style={{ left: "100%", transform: "translateX(-1px)" }}
        title="Limite 100%"
      />
      {overflowPct > 0 && (
        <div
          className="absolute top-0 bottom-0 bg-red-700/90 rounded-r-sm"
          style={{
            left: "100%",
            width: `${Math.min(overflowPct, 40)}%`,
          }}
        />
      )}
    </div>
  );
}
