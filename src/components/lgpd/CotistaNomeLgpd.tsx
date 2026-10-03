import { mascararCpfExibicao, separarDocumentoCotista } from "@/lib/lgpdCotista";
import { cn } from "@/lib/utils";

type CotistaNomeLgpdProps = {
  valor: string | null | undefined;
  className?: string;
};

/** Exibe o nome do cotista e borra o CPF entre parênteses (LGPD). */
export function CotistaNomeLgpd({ valor, className }: CotistaNomeLgpdProps) {
  const { nome, documento } = separarDocumentoCotista(valor);

  if (!documento) {
    return <span className={className}>{nome || "—"}</span>;
  }

  return (
    <span className={cn("inline-flex items-baseline gap-1 min-w-0", className)}>
      <span className="truncate">{nome}</span>
      <span
        className="inline-block shrink-0 select-none blur-[6px] opacity-80 pointer-events-none"
        aria-hidden
      >
        ({mascararCpfExibicao()})
      </span>
      <span className="sr-only">CPF oculto por LGPD</span>
    </span>
  );
}
