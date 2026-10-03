import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import {
  MIN_ALOC_MAX_DIAS_VIOLACAO_12M,
  calcularContadoresMinAloc12mFromSeries,
  resolveMaxEventosMinAloc12m,
  formatMinAlocEpisodioLabel,
  formatYmdPosicaoBr,
  rolling12mBoundsYmd,
  type MinAlocContadores12m,
  type MinAlocStatus,
} from "@/lib/minAlocacaoContadores";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

function cnpjQueryVariants(cnpj: string): string[] {
  const clean = cnpj.replace(/\D/g, "").padStart(14, "0");
  const formatted = clean.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    "$1.$2.$3/$4-$5",
  );
  return [...new Set([cnpj, clean, formatted])].filter(Boolean);
}

function useMinAlocHistorico12m(props: {
  fundoCnpj?: string;
  fundoDtposicao?: string;
  fundoIsin?: string | null;
  regraCodigo?: string;
  statusAtual?: MinAlocStatus;
}): MinAlocContadores12m {
  const { fundoCnpj, fundoDtposicao, fundoIsin, regraCodigo, statusAtual } = props;

  const empty: MinAlocContadores12m = {
    eventos_12m: 0,
    dias_violacao_12m: 0,
    episodios: [],
    dias_violacao: [],
  };

  const bounds =
    fundoDtposicao != null ? rolling12mBoundsYmd(fundoDtposicao) : null;

  const query = useQuery({
    queryKey: [
      "min-aloc-historico-12m",
      fundoCnpj,
      fundoIsin ?? "",
      regraCodigo,
      bounds?.fromYmd,
      bounds?.toYmd,
    ],
    enabled: Boolean(fundoCnpj && fundoDtposicao && regraCodigo && bounds),
    staleTime: 30_000,
    queryFn: async (): Promise<MinAlocContadores12m> => {
      const variants = cnpjQueryVariants(fundoCnpj!);
      const isin = fundoIsin ?? "";

      let q = supabase
        .from("enquadramento_resultado" as any)
        .select("fundo_dtposicao, status")
        .in("fundo_cnpj", variants)
        .eq("regra_codigo", regraCodigo!)
        .gte("fundo_dtposicao", bounds!.fromYmd)
        .lte("fundo_dtposicao", bounds!.toYmd)
        .order("fundo_dtposicao", { ascending: true });

      if (isin) q = q.eq("fundo_isin", isin);

      const { data, error } = await q;
      if (error) throw error;

      const rows = (data ?? []).map((r: { fundo_dtposicao: string; status: string }) => ({
        fundo_dtposicao: String(r.fundo_dtposicao).replace(/\D/g, "").slice(0, 8),
        status: r.status as MinAlocStatus,
      }));

      return calcularContadoresMinAloc12mFromSeries(
        rows,
        fundoDtposicao,
        statusAtual,
      );
    },
  });

  if (query.data) return query.data;
  return empty;
}

export interface MinAlocacaoContadoresProps {
  fundoCnpj: string;
  fundoDtposicao: string;
  fundoIsin?: string | null;
  regraCodigo: string;
  status: MinAlocStatus;
  detalhes?: Record<string, unknown> | null;
  valorLimite?: number | null;
  className?: string;
}

export function MinAlocacaoContadores({
  fundoCnpj,
  fundoDtposicao,
  fundoIsin,
  regraCodigo,
  status,
  detalhes,
  valorLimite,
  className,
}: MinAlocacaoContadoresProps) {
  const contadoresHook = useMinAlocHistorico12m({
    fundoCnpj,
    fundoDtposicao,
    fundoIsin,
    regraCodigo,
    statusAtual: status,
  });

  const maxEventos = resolveMaxEventosMinAloc12m(
    valorLimite ?? (detalhes?.limite_min != null ? Number(detalhes.limite_min) : null),
    detalhes,
  );
  const maxDias =
    Number(detalhes?.max_dias_violacao_12m ?? detalhes?.max_dias_violacao_ano) ||
    MIN_ALOC_MAX_DIAS_VIOLACAO_12M;

  const contadores =
    detalhes?.eventos_12m != null || detalhes?.dias_violacao_12m != null
      ? {
          eventos_12m: Number(detalhes.eventos_12m ?? 0),
          dias_violacao_12m: Number(detalhes.dias_violacao_12m ?? 0),
          episodios: contadoresHook.episodios,
          dias_violacao: contadoresHook.dias_violacao,
        }
      : contadoresHook;

  return (
    <div className={cn("grid grid-cols-2 gap-3 max-w-md", className)}>
      <Popover>
        <PopoverTrigger asChild disabled={contadores.eventos_12m === 0}>
          <button
            type="button"
            className={cn(
              "rounded-lg border border-border/60 bg-card p-3 text-left transition-colors",
              contadores.eventos_12m > 0 &&
                "cursor-pointer hover:bg-muted/40 hover:border-border",
              contadores.eventos_12m === 0 && "cursor-default",
            )}
          >
            <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
              Eventos (12 meses)
            </p>
            <p
              className={cn(
                "font-mono text-lg font-extrabold",
                contadores.eventos_12m >= maxEventos
                  ? "text-red-600 dark:text-red-400"
                  : contadores.eventos_12m >= maxEventos - 1
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-foreground",
              )}
            >
              {contadores.eventos_12m} / {maxEventos}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {contadores.eventos_12m > 0 ? "clique para ver datas" : "sem episódios"}
            </p>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3" align="start">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
            Episódios de desenquadramento
          </p>
          <ul className="space-y-2">
            {contadores.episodios.map((ep, i) => (
              <li key={`${ep.inicio}-${i}`} className="text-xs">
                <span className="font-semibold text-foreground">Episódio {i + 1}</span>
                <span className="block font-mono text-[11px] text-muted-foreground mt-0.5">
                  {formatMinAlocEpisodioLabel(ep)}
                </span>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild disabled={contadores.dias_violacao_12m === 0}>
          <button
            type="button"
            className={cn(
              "rounded-lg border border-border/60 bg-card p-3 text-left transition-colors",
              contadores.dias_violacao_12m > 0 &&
                "cursor-pointer hover:bg-muted/40 hover:border-border",
              contadores.dias_violacao_12m === 0 && "cursor-default",
            )}
          >
            <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
              Dias em violação
            </p>
            <p
              className={cn(
                "font-mono text-lg font-extrabold",
                contadores.dias_violacao_12m >= maxDias
                  ? "text-red-600 dark:text-red-400"
                  : contadores.dias_violacao_12m >= maxDias - 10
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-foreground",
              )}
            >
              {contadores.dias_violacao_12m} / {maxDias}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {contadores.dias_violacao_12m > 0 ? "clique para ver datas" : "nos últimos 12 meses"}
            </p>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3 max-h-56 overflow-y-auto" align="start">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
            Dias em violação ({contadores.dias_violacao_12m})
          </p>
          <ul className="space-y-1">
            {contadores.dias_violacao.map((d) => (
              <li key={d} className="font-mono text-[11px] text-muted-foreground">
                {formatYmdPosicaoBr(d)}
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
