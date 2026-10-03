import { addMonths, format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CompetenciaNavigatorProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

function navegarCompetencia(value: string, quantidade: number) {
  return format(addMonths(parseISO(`${value}-01`), quantidade), "yyyy-MM");
}

export function CompetenciaNavigator({ value, onChange, className }: CompetenciaNavigatorProps) {
  const competenciaAtual = format(new Date(), "yyyy-MM");
  const podeAvancar = value < competenciaAtual;
  const label = format(parseISO(`${value}-01`), "MMMM 'de' yyyy", { locale: ptBR });

  return (
    <div
      className={cn("flex h-9 w-[172px] items-center rounded-md border bg-background", className)}
      role="group"
      aria-label="Navegar pela competência"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-muted-foreground"
        onClick={() => onChange(navegarCompetencia(value, -1))}
        aria-label="Competência anterior"
        title="Competência anterior"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>

      <span className="min-w-0 flex-1 whitespace-nowrap text-center text-xs font-medium" aria-live="polite">
        {label}
      </span>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-muted-foreground"
        onClick={() => onChange(navegarCompetencia(value, 1))}
        disabled={!podeAvancar}
        aria-label="Próxima competência"
        title="Próxima competência"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
