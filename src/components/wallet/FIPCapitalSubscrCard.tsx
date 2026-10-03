import { Switch } from "@/design-system/components/forms/Switch";
import { cn } from "@/lib/utils";

interface FIPCapitalSubscrCardProps {
  vlCapSubscr: number;
  bonus5pct: number;
  considerando: boolean;
  onConsiderarChange: (value: boolean) => void;
  className?: string;
}

const formatBRL = (value: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(value);

export function FIPCapitalSubscrCard({
  vlCapSubscr,
  bonus5pct,
  considerando,
  onConsiderarChange,
  className,
}: FIPCapitalSubscrCardProps) {
  return (
    <section className={cn("wallet-summary__fip", className)} aria-label="Capital subscrito FIP">
      <span className="wallet-summary__metric-label">5% do capital subscrito</span>
      <strong>{formatBRL(bonus5pct)}</strong>
      <span className="wallet-summary__metric-share">Capital subscrito: {formatBRL(vlCapSubscr)}</span>
      <Switch
        label="Considerar no cálculo"
        checked={considerando}
        onChange={(event) => onConsiderarChange(event.target.checked)}
      />
    </section>
  );
}
