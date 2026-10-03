import { cn } from "@/lib/utils";
import { SEVERITY_CLASSES, corSeveridade } from "@/lib/creditoMatriz";

type Sev = "ok" | "atencao" | "critico";

type Props = {
  sev?: Sev;
  /** Calcula a severidade automaticamente a partir de um percentual (0-1) */
  pct?: number;
  className?: string;
};

const labels: Record<Sev, string> = {
  ok:      "OK",
  atencao: "Atenção",
  critico: "Crítico",
};

export function BadgeSeveridade({ sev, pct, className }: Props) {
  const resolved: Sev = sev ?? (pct != null ? corSeveridade(pct) : "ok");
  const cls = SEVERITY_CLASSES[resolved];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
        cls.badge,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", cls.dot)} />
      {labels[resolved]}
    </span>
  );
}
