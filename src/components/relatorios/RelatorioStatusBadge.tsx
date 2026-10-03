import { cn } from "@/lib/utils";

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  ok: { label: "OK", className: "bg-emerald-50 text-emerald-700" },
  regular: { label: "Regular", className: "bg-emerald-50 text-emerald-700" },
  alerta: { label: "Alerta", className: "bg-amber-50 text-amber-700" },
  soft: { label: "Soft", className: "bg-amber-50 text-amber-700" },
  violacao: { label: "Violação", className: "bg-red-50 text-red-700" },
  hard: { label: "Hard", className: "bg-red-50 text-red-700" },
  breach: { label: "Breach", className: "bg-red-50 text-red-700" },
  pendente: { label: "Pendente", className: "bg-slate-50 text-slate-600" },
  sem_dados: { label: "Sem Dados", className: "bg-slate-50 text-slate-500" },
};

export function RelatorioStatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, className: "bg-muted text-muted-foreground" };
  return (
    <span
      className={cn(
        "inline-flex px-2 py-0.5 rounded text-[10px] font-bold uppercase",
        cfg.className,
      )}
    >
      {cfg.label}
    </span>
  );
}
