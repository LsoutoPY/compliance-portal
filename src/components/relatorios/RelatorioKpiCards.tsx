import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatBRL } from "./relatorioUtils";

export type KpiVariant = "default" | "ok" | "alerta" | "violacao" | "pendente" | "pl";

export interface KpiItem {
  label: string;
  value: number | string;
  variant?: KpiVariant;
  isCurrency?: boolean;
}

const VARIANT_CLASS: Record<KpiVariant, string> = {
  default: "",
  ok: "bg-emerald-50/50 border-emerald-100",
  alerta: "bg-amber-50/50 border-amber-100",
  violacao: "bg-red-50/50 border-red-100",
  pendente: "bg-slate-50/50 border-slate-200",
  pl: "bg-blue-50/50 border-blue-100",
};

const VARIANT_TITLE: Record<KpiVariant, string> = {
  default: "",
  ok: "text-emerald-700",
  alerta: "text-amber-700",
  violacao: "text-red-700",
  pendente: "text-slate-600",
  pl: "text-blue-700",
};

const VARIANT_VALUE: Record<KpiVariant, string> = {
  default: "",
  ok: "text-emerald-700",
  alerta: "text-amber-700",
  violacao: "text-red-700",
  pendente: "text-slate-600",
  pl: "text-blue-700",
};

export function RelatorioKpiCards({ items }: { items: KpiItem[] }) {
  return (
    <div className={cn("grid gap-3", items.length <= 5 ? "grid-cols-2 md:grid-cols-5" : "grid-cols-2 md:grid-cols-3 lg:grid-cols-6")}>
      {items.map((item) => {
        const v = item.variant ?? "default";
        const display =
          typeof item.value === "number" && item.isCurrency ? formatBRL(item.value) : item.value;
        return (
          <Card key={item.label} className={cn(VARIANT_CLASS[v])}>
            <CardHeader className="pb-1">
              <CardTitle className={cn("text-xs", VARIANT_TITLE[v])}>{item.label}</CardTitle>
            </CardHeader>
            <CardContent className={cn("text-xl font-bold", VARIANT_VALUE[v])}>{display}</CardContent>
          </Card>
        );
      })}
    </div>
  );
}
