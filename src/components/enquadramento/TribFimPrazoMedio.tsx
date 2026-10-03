import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CheckCircle2, ChevronDown, ChevronUp, CalendarDays } from "lucide-react";
import { anoFromDtPosicao } from "@/components/tributario/MmTributariaChart";
import {
  ART4_MAX_DIAS_VIOLACAO_ANO,
  ART4_MAX_EVENTOS_ANO,
  art4EnquadramentoDisplay,
  calcularContadoresAnoArt4FromSeries,
  formatArt4EpisodioLabel,
  formatDataIsoBr,
  rowArt4FromEnquadramentoResultado,
  type Art4ContadoresAno,
} from "@/lib/tributarioArt4";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface TribFimAtivo {
  nome: string;
  cnpj: string | null;
  valor: number;
  percentual: number;
  prazo_dias: number | null;
  contribuicao: number;
  classificacao: "lp" | "cp" | "excluido" | "compromissada" | "rf";
  motivo: string;
  section: string;
  /** Presente quando o prazo do título RF foi calculado via fluxos nominais (Art. 4º §2º II) */
  metodo_prazo?: "vencimento" | "fluxo_nominal";
  qtd_fluxos?: number;
}

export interface TribFimDetalhes {
  prazo_medio_carteira: number;
  prazo_medio_formatado: string;
  limite_dias: number;
  alerta_dias: number;
  is_lp_tributario: boolean;
  total_valor_carteira: number;
  total_excluido: number;
  patliq: number;
  pl_total: number;
  descricao_status: string;
  resumo: {
    lp_valor: number;
    cp_valor: number;
    rf_valor: number;
    excl_valor: number;
  };
  ativos_contabilizados: TribFimAtivo[];
  data_referencia?: string;
  btg_prazo_medio?: number;
  eventos_ano?: number;
  dias_violacao_ano?: number;
  max_eventos_ano?: number;
  max_dias_violacao_ano?: number;
}

export interface TribFimPrazoMedioProps {
  detalhes: TribFimDetalhes | Record<string, unknown>;
  status: "ok" | "alerta" | "violacao";
  fundoNome?: string;
  fundoCnpj?: string;
  fundoDtposicao?: string;
  fundoIsin?: string | null;
  regraCodigo?: string;
}

function formatBRL(v: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(v);
}

function formatBRLFull(v: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(v);
}

function formatPrazo(v: number | null, comSinal = false): string {
  if (v == null) return "—";
  const s = comSinal && v > 0 ? "+" : comSinal && v < 0 ? "" : "";
  return `${s}${v.toFixed(2).replace(".", ",")}d`;
}

function formatPrazoLabel(v: number | null): string {
  if (v == null) return "—";
  return `${v.toFixed(2).replace(".", ",")} dias`;
}

function formatPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function corClassificacao(cl: string): string {
  const map: Record<string, string> = {
    lp: "#1D9E75",
    rf: "#378ADD",
    compromissada: "#BA7517",
    cp: "#E24B4A",
    excluido: "#888780",
  };
  return map[cl] ?? "#888780";
}

function labelClassificacao(cl: string, prazo: number | null): string {
  const map: Record<string, string> = {
    lp: "LP 366d",
    rf: prazo != null ? `RF ${Math.round(prazo)}d` : "RF",
    compromissada: "comp 1d",
    cp: "CP 1d",
    excluido: "excluído",
  };
  return map[cl] ?? cl;
}

const GRID_COLS = "2fr 80px 64px 64px 80px";

function ClassificacaoPill({
  classificacao,
  prazo,
}: {
  classificacao: string;
  prazo: number | null;
}) {
  const cor = corClassificacao(classificacao);
  return (
    <span
      className="shrink-0 font-medium leading-tight"
      style={{
        color: cor,
        backgroundColor: `${cor}1A`,
        fontSize: 10,
        padding: "1px 6px",
        borderRadius: 3,
      }}
    >
      {labelClassificacao(classificacao, prazo)}
    </span>
  );
}

function abbreviateNome(nome: string, max = 28): string {
  if (nome.length <= max) return nome;
  return `${nome.slice(0, max - 1)}…`;
}

function formatPrazoInteiro(v: number | null): string {
  if (v == null) return "—";
  return `${Math.round(v)}d`;
}

function formatContribuicao(v: number): string {
  return `${v.toFixed(2).replace(".", ",")}d`;
}

function inferClassificacao(raw: Record<string, unknown>): TribFimAtivo["classificacao"] {
  const explicit = raw.classificacao as TribFimAtivo["classificacao"] | undefined;
  if (explicit) return explicit;

  const tipo = String(raw.tipo ?? "");
  const prazo = raw.prazo_dias as number | null;
  const motivo = String(raw.motivo ?? "").toLowerCase();
  const section = String(raw.section ?? "").toLowerCase();

  if (prazo == null || tipo === "excluido" || motivo.includes("excluído") || motivo.includes("excluido")) {
    return "excluido";
  }
  if (motivo.includes("compromissada") || section.includes("termo")) {
    return "compromissada";
  }
  if (prazo === 366 || motivo.includes("§4º") || (motivo.includes("lp") && section === "cotas")) {
    return "lp";
  }
  if (section === "cotas" && prazo === 1) {
    return "cp";
  }
  if (section !== "cotas" && section !== "") {
    return "rf";
  }
  return prazo === 1 ? "cp" : "lp";
}

export function normalizeTribFimDetalhes(raw: Record<string, unknown>): TribFimDetalhes {
  const limite_dias = Number(raw.limite_dias ?? 365);
  const alerta_dias = Number(raw.alerta_dias ?? 367);
  const prazo_medio_carteira = Number(raw.prazo_medio_carteira ?? raw.prazo_medio_dias ?? 0);
  const patliq = Number(raw.patliq ?? raw.pl_total ?? 0);
  const pl_total = Number(raw.pl_total ?? patliq);

  const ativosRaw = (raw.ativos_contabilizados ?? []) as Record<string, unknown>[];
  const ativos_contabilizados: TribFimAtivo[] = ativosRaw.map((a) => {
    const classificacao = inferClassificacao(a);
    const prazo_dias = a.prazo_dias as number | null;
    const valor = Number(a.valor ?? 0);
    const contribuicao =
      a.contribuicao != null
        ? Number(a.contribuicao)
        : a.contribuicao_dias != null
          ? Number(a.contribuicao_dias)
          : 0;

    return {
      nome: String(a.nome ?? "—"),
      cnpj: (a.cnpj as string | null) ?? null,
      valor,
      percentual: Number(a.percentual ?? (pl_total > 0 ? valor / pl_total : 0)),
      prazo_dias: classificacao === "excluido" ? null : prazo_dias,
      contribuicao: classificacao === "excluido" ? 0 : contribuicao,
      classificacao,
      motivo: String(a.motivo ?? ""),
      section: String(a.section ?? ""),
      metodo_prazo: (a.metodo_prazo as "vencimento" | "fluxo_nominal" | undefined) ?? "vencimento",
      qtd_fluxos: a.qtd_fluxos != null ? Number(a.qtd_fluxos) : undefined,
    };
  });

  const resumoFromRaw = raw.resumo as TribFimDetalhes["resumo"] | undefined;
  const resumo =
    resumoFromRaw ??
    ativos_contabilizados.reduce(
      (acc, a) => {
        if (a.classificacao === "lp") acc.lp_valor += a.valor;
        else if (a.classificacao === "cp") acc.cp_valor += a.valor;
        else if (a.classificacao === "excluido") acc.excl_valor += a.valor;
        else acc.rf_valor += a.valor;
        return acc;
      },
      { lp_valor: 0, cp_valor: 0, rf_valor: 0, excl_valor: 0 },
    );

  const total_valor_carteira = Number(
    raw.total_valor_carteira ?? raw.valor_elegivel ?? ativos_contabilizados.reduce((s, a) => s + (a.prazo_dias != null ? a.valor : 0), 0),
  );
  const total_excluido = Number(raw.total_excluido ?? raw.valor_excluido ?? resumo.excl_valor);

  const classificacaoTrib = String(raw.classificacao_tributaria ?? "");
  const is_lp_tributario =
    raw.is_lp_tributario != null
      ? Boolean(raw.is_lp_tributario)
      : classificacaoTrib === "lp" || prazo_medio_carteira > limite_dias;

  return {
    prazo_medio_carteira,
    prazo_medio_formatado:
      String(raw.prazo_medio_formatado ?? "") ||
      `${prazo_medio_carteira.toFixed(2).replace(".", ",")} dias corridos`,
    limite_dias,
    alerta_dias,
    is_lp_tributario,
    total_valor_carteira,
    total_excluido,
    patliq,
    pl_total,
    descricao_status: String(raw.descricao_status ?? ""),
    resumo,
    ativos_contabilizados,
    data_referencia: raw.data_referencia
      ? String(raw.data_referencia)
      : raw.dt_posicao_efetiva
        ? String(raw.dt_posicao_efetiva)
        : undefined,
    btg_prazo_medio: raw.btg_prazo_medio != null ? Number(raw.btg_prazo_medio) : undefined,
    eventos_ano: raw.eventos_ano != null ? Number(raw.eventos_ano) : undefined,
    dias_violacao_ano:
      raw.dias_violacao_ano != null ? Number(raw.dias_violacao_ano) : undefined,
    max_eventos_ano:
      raw.max_eventos_ano != null ? Number(raw.max_eventos_ano) : ART4_MAX_EVENTOS_ANO,
    max_dias_violacao_ano:
      raw.max_dias_violacao_ano != null
        ? Number(raw.max_dias_violacao_ano)
        : ART4_MAX_DIAS_VIOLACAO_ANO,
  };
}

function effectiveStatus(
  status: TribFimPrazoMedioProps["status"],
  prazo: number,
  limite: number,
  alerta: number,
): TribFimPrazoMedioProps["status"] {
  if (prazo <= limite) return "violacao";
  if (prazo <= alerta) return "alerta";
  return status === "violacao" ? "violacao" : "ok";
}

/** Status efetivo para regras Art. 4º (FIM/FIDC) com base no prazo médio. */
export function effectiveTribArt4Status(
  status: TribFimPrazoMedioProps["status"],
  detalhes: Record<string, unknown> | null | undefined,
): TribFimPrazoMedioProps["status"] {
  const prazo = Number(detalhes?.prazo_medio_dias ?? detalhes?.prazo_medio_carteira ?? 0);
  const limite = Number(detalhes?.limite_dias ?? 365);
  const alerta = Number(detalhes?.alerta_dias ?? 367);
  if (!Number.isFinite(prazo) || prazo <= 0) return status;
  return effectiveStatus(status, prazo, limite, alerta);
}

function formatDataRef(iso?: string): string {
  if (!iso) return "—";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const ymd = iso.replace(/\D/g, "").slice(0, 8);
  if (ymd.length === 8) return `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}`;
  return iso;
}

const LEGEND_ITEMS = [
  { key: "lp", label: "cotas LP (366d fixos)" },
  { key: "rf", label: "títulos RF (dias corridos)" },
  { key: "compromissada", label: "compromissada (1d)" },
  { key: "excluido", label: "excluído" },
] as const;

function cnpjQueryVariants(cnpj: string): string[] {
  const clean = cnpj.replace(/\D/g, "").padStart(14, "0");
  const formatted = clean.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    "$1.$2.$3/$4-$5",
  );
  return [...new Set([cnpj, clean, formatted])].filter(Boolean);
}

function useArt4HistoricoAno(props: {
  fundoCnpj?: string;
  fundoDtposicao?: string;
  fundoIsin?: string | null;
  regraCodigo?: string;
  limiteDias: number;
  prazoAtual: number;
  dataReferencia?: string;
}): Art4ContadoresAno {
  const {
    fundoCnpj,
    fundoDtposicao,
    fundoIsin,
    regraCodigo,
    limiteDias,
    prazoAtual,
    dataReferencia,
  } = props;

  const empty: Art4ContadoresAno = {
    eventos_ano: 0,
    dias_violacao_ano: 0,
    episodios: [],
    dias_violacao: [],
  };

  const ano =
    (fundoDtposicao ? anoFromDtPosicao(fundoDtposicao) : null) ??
    (dataReferencia ? parseInt(dataReferencia.slice(0, 4), 10) : null) ??
    new Date().getFullYear();

  const query = useQuery({
    queryKey: [
      "art4-historico-ano",
      fundoCnpj,
      fundoIsin ?? "",
      ano,
      regraCodigo,
      limiteDias,
    ],
    enabled: Boolean(fundoCnpj && regraCodigo),
    staleTime: 30_000,
    queryFn: async (): Promise<Art4ContadoresAno> => {
      const variants = cnpjQueryVariants(fundoCnpj!);
      const isin = fundoIsin ?? "";

      let q = supabase
        .from("enquadramento_resultado" as any)
        .select("fundo_dtposicao, detalhes, valor_atual, fundo_isin")
        .in("fundo_cnpj", variants)
        .eq("regra_codigo", regraCodigo!)
        .gte("fundo_dtposicao", `${ano}0101`)
        .lte("fundo_dtposicao", `${ano}1231`)
        .order("fundo_dtposicao", { ascending: true });

      if (isin) q = q.eq("fundo_isin", isin);

      const { data, error } = await q;
      if (error) throw error;

      const rows = (data ?? [])
        .map((r) =>
          rowArt4FromEnquadramentoResultado({
            fundo_dtposicao: String((r as { fundo_dtposicao: string }).fundo_dtposicao),
            detalhes: (r as { detalhes: unknown }).detalhes,
            valor_atual: (r as { valor_atual: number | null }).valor_atual,
          }),
        )
        .filter((r): r is NonNullable<typeof r> => r != null);

      if (dataReferencia && prazoAtual > 0) {
        const idx = rows.findIndex((r) => r.data_referencia === dataReferencia);
        const entry = {
          data_referencia: dataReferencia,
          prazo_medio: prazoAtual,
          limite_dias: limiteDias,
        };
        if (idx >= 0) rows[idx] = entry;
        else rows.push(entry);
      }

      return calcularContadoresAnoArt4FromSeries(rows, limiteDias);
    },
  });

  return query.data ?? empty;
}

export function TribFimPrazoMedio({
  detalhes: rawDetalhes,
  status,
  fundoNome,
  fundoCnpj,
  fundoDtposicao,
  fundoIsin,
  regraCodigo,
}: TribFimPrazoMedioProps) {
  const [contribExpanded, setContribExpanded] = useState(false);

  const detalhes = useMemo(
    () => normalizeTribFimDetalhes(rawDetalhes as Record<string, unknown>),
    [rawDetalhes],
  );

  const {
    prazo_medio_carteira,
    limite_dias,
    alerta_dias,
    patliq,
    ativos_contabilizados,
    data_referencia,
    btg_prazo_medio,
    max_eventos_ano,
    max_dias_violacao_ano,
  } = detalhes;

  const dataRefIso = data_referencia
    ? data_referencia.includes("-")
      ? data_referencia.slice(0, 10)
      : `${data_referencia.slice(0, 4)}-${data_referencia.slice(4, 6)}-${data_referencia.slice(6, 8)}`
    : undefined;

  const contadoresAno = useArt4HistoricoAno({
    fundoCnpj,
    fundoDtposicao,
    fundoIsin,
    regraCodigo,
    limiteDias: limite_dias,
    prazoAtual: prazo_medio_carteira,
    dataReferencia: dataRefIso,
  });

  const effStatus = effectiveStatus(status, prazo_medio_carteira, limite_dias, alerta_dias);
  const enquadramento = art4EnquadramentoDisplay(effStatus);
  const margem = prazo_medio_carteira - limite_dias;
  const isLp = prazo_medio_carteira > limite_dias;
  const progressMax = Math.max(500, prazo_medio_carteira + 50, limite_dias + 50);

  const badgeConfig = (() => {
    if (effStatus === "violacao") {
      return {
        label: "CP tributário",
        className: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800",
        icon: null as typeof CheckCircle2 | null,
      };
    }
    if (effStatus === "alerta") {
      return {
        label: "LP — atenção",
        className: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800",
        icon: null,
      };
    }
    return {
      label: "LP tributário",
      className: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800",
      icon: CheckCircle2,
    };
  })();

  const ativosInline = useMemo(
    () =>
      [...ativos_contabilizados].sort((a, b) => {
        if (a.prazo_dias == null && b.prazo_dias == null) return 0;
        if (a.prazo_dias == null) return 1;
        if (b.prazo_dias == null) return -1;
        return b.contribuicao - a.contribuicao;
      }),
    [ativos_contabilizados],
  );

  const maxContrib = useMemo(
    () => Math.max(0, ...ativosInline.filter((a) => a.prazo_dias != null).map((a) => a.contribuicao)),
    [ativosInline],
  );

  const ativosTabela = useMemo(
    () => [...ativos_contabilizados].sort((a, b) => b.valor - a.valor),
    [ativos_contabilizados],
  );

  const totalValorAtivos = ativosTabela.reduce((s, a) => s + a.valor, 0);
  const totalPesoAtivos = ativosTabela.reduce((s, a) => s + a.percentual, 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        {fundoNome && (
          <span className="text-[11px] font-bold uppercase tracking-wider text-foreground">
            {fundoNome}
          </span>
        )}
        <Badge variant="outline" className="text-[9px] font-semibold uppercase tracking-wide">
          IN RFB 1.585/2015 — Art. 4º
        </Badge>
        <Badge variant="outline" className={cn("text-[9px] font-bold gap-1", badgeConfig.className)}>
          {badgeConfig.icon && <CheckCircle2 className="h-3 w-3" />}
          {badgeConfig.label}
        </Badge>
      </div>

      {/* Métricas */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2">
        <div className="rounded-lg border border-border/60 bg-card p-3">
          <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
            Prazo médio
          </p>
          <p
            className={cn(
              "font-mono text-lg font-extrabold",
              isLp ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
            )}
          >
            {formatPrazoLabel(prazo_medio_carteira)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {btg_prazo_medio != null
              ? `BTG reportou: ${formatPrazo(btg_prazo_medio)}`
              : detalhes.prazo_medio_formatado}
          </p>
        </div>

        <div className="rounded-lg border border-border/60 bg-card p-3">
          <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
            Limite LP
          </p>
          <p className="font-mono text-lg font-extrabold text-foreground">
            {formatPrazoLabel(limite_dias)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Art. 4º IN 1585</p>
        </div>

        <div className="rounded-lg border border-border/60 bg-card p-3">
          <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
            Margem
          </p>
          <p
            className={cn(
              "font-mono text-lg font-extrabold",
              margem >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
            )}
          >
            {formatPrazo(margem, true)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {margem >= 0 ? "acima do limite" : "abaixo do limite"}
          </p>
        </div>

        <div className="rounded-lg border border-border/60 bg-card p-3">
          <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
            PL do fundo
          </p>
          <p className="font-mono text-lg font-extrabold text-foreground">{formatBRL(patliq)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            ref. {formatDataRef(data_referencia)}
          </p>
        </div>

        <div className="rounded-lg border border-border/60 bg-card p-3">
          <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
            Enquadrado
          </p>
          <p className={cn("font-mono text-lg font-extrabold", enquadramento.className)}>
            {enquadramento.label}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{enquadramento.subtext}</p>
        </div>

        <Popover>
          <PopoverTrigger asChild disabled={contadoresAno.eventos_ano === 0}>
            <button
              type="button"
              className={cn(
                "rounded-lg border border-border/60 bg-card p-3 text-left transition-colors",
                contadoresAno.eventos_ano > 0 &&
                  "cursor-pointer hover:bg-muted/40 hover:border-border",
                contadoresAno.eventos_ano === 0 && "cursor-default",
              )}
            >
              <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
                Eventos no ano
              </p>
              <p
                className={cn(
                  "font-mono text-lg font-extrabold",
                  contadoresAno.eventos_ano >= max_eventos_ano
                    ? "text-red-600 dark:text-red-400"
                    : contadoresAno.eventos_ano >= max_eventos_ano - 1
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-foreground",
                )}
              >
                {contadoresAno.eventos_ano} / {max_eventos_ano}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {contadoresAno.eventos_ano > 0 ? "clique para ver datas" : "episódios CP"}
              </p>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-3" align="start">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
              Episódios de desenquadramento
            </p>
            <ul className="space-y-2">
              {contadoresAno.episodios.map((ep, i) => (
                <li key={`${ep.inicio}-${i}`} className="text-xs">
                  <span className="font-semibold text-foreground">Episódio {i + 1}</span>
                  <span className="block font-mono text-[11px] text-muted-foreground mt-0.5">
                    {formatArt4EpisodioLabel(ep)}
                  </span>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>

        <Popover>
          <PopoverTrigger asChild disabled={contadoresAno.dias_violacao_ano === 0}>
            <button
              type="button"
              className={cn(
                "rounded-lg border border-border/60 bg-card p-3 text-left transition-colors",
                contadoresAno.dias_violacao_ano > 0 &&
                  "cursor-pointer hover:bg-muted/40 hover:border-border",
                contadoresAno.dias_violacao_ano === 0 && "cursor-default",
              )}
            >
              <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
                Dias em violação
              </p>
              <p
                className={cn(
                  "font-mono text-lg font-extrabold",
                  contadoresAno.dias_violacao_ano >= max_dias_violacao_ano
                    ? "text-red-600 dark:text-red-400"
                    : contadoresAno.dias_violacao_ano >= max_dias_violacao_ano - 15
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-foreground",
                )}
              >
                {contadoresAno.dias_violacao_ano} / {max_dias_violacao_ano}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {contadoresAno.dias_violacao_ano > 0 ? "clique para ver datas" : "no ano-calendário"}
              </p>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-3 max-h-56 overflow-y-auto" align="start">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
              Dias em violação ({contadoresAno.dias_violacao_ano})
            </p>
            <ul className="space-y-1">
              {contadoresAno.dias_violacao.map((d) => (
                <li key={d} className="font-mono text-[11px] text-foreground">
                  {formatDataIsoBr(d)}
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      </div>

      {/* Legenda */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-muted-foreground">
        {LEGEND_ITEMS.map(({ key, label }) => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ backgroundColor: corClassificacao(key) }}
            />
            {label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
            style={{ backgroundColor: corClassificacao("cp") }}
          />
          cotas CP (1d fixo)
        </span>
      </div>

      {/* Contribuição por ativo — tabela com barras inline (recolhida por padrão) */}
      {ativosInline.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-card overflow-hidden">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-muted/30 transition-colors"
            onClick={() => setContribExpanded((v) => !v)}
            aria-expanded={contribExpanded}
          >
            <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
              Contribuição ao prazo médio por ativo
            </span>
            <span className="flex items-center gap-2 shrink-0">
              <span
                className={cn(
                  "font-mono text-[11px] font-bold tabular-nums",
                  isLp ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
                )}
              >
                {formatContribuicao(prazo_medio_carteira)}
              </span>
              {contribExpanded ? (
                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </span>
          </button>

          {contribExpanded && (
            <div className="px-3 pb-3 border-t border-border/40 pt-3">
              <div
                className="grid gap-x-2 gap-y-2 items-center text-xs"
                style={{ gridTemplateColumns: "180px 1fr 64px 64px" }}
              >
            {ativosInline.map((ativo, idx) => {
              const cor = corClassificacao(ativo.classificacao);
              const fillPct = maxContrib > 0 && ativo.prazo_dias != null
                ? (ativo.contribuicao / maxContrib) * 100
                : 0;

              return (
                <div key={`${ativo.nome}-${idx}`} className="contents">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="truncate text-[11px] font-medium text-foreground"
                      title={ativo.nome}
                    >
                      {abbreviateNome(ativo.nome)}
                    </span>
                    <span
                      className="shrink-0 text-[8px] font-bold border rounded px-1 py-0 leading-4"
                      style={{
                        color: cor,
                        borderColor: `${cor}40`,
                        backgroundColor: `${cor}12`,
                      }}
                    >
                      {labelClassificacao(ativo.classificacao, ativo.prazo_dias)}
                    </span>
                    {ativo.metodo_prazo === "fluxo_nominal" && (
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-blue-100 text-blue-700 text-[7px] font-bold px-1 py-0 leading-4 cursor-default select-none">
                              <CalendarDays className="h-2 w-2" />
                              Inc. II
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-[220px] text-xs">
                            Prazo calculado por WAM de fluxos nominais
                            {ativo.qtd_fluxos != null ? ` (${ativo.qtd_fluxos} fluxo${ativo.qtd_fluxos !== 1 ? "s" : ""})` : ""}.
                            Conforme Art. 4º §2º II IN RFB 1585/2015.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                  </div>

                  <div className="h-2 rounded bg-secondary overflow-hidden">
                    <div
                      className="h-full rounded transition-all"
                      style={{ width: `${fillPct}%`, backgroundColor: cor }}
                    />
                  </div>

                  <span className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                    {formatPrazoInteiro(ativo.prazo_dias)}
                  </span>

                  <span
                    className="text-right font-mono text-[11px] font-bold tabular-nums"
                    style={{ color: ativo.prazo_dias != null ? cor : undefined }}
                  >
                    {ativo.prazo_dias == null ? "—" : formatContribuicao(ativo.contribuicao)}
                  </span>
                </div>
              );
            })}

            {/* Linha total */}
            <span className="text-[11px] font-semibold text-foreground uppercase tracking-wide">
              total
            </span>
            <div className="h-2 rounded bg-secondary overflow-hidden">
              <div className="h-full w-full rounded" style={{ backgroundColor: "#1D9E75" }} />
            </div>
            <span className="text-right font-mono text-[11px] text-muted-foreground">—</span>
            <span className="text-right font-mono text-[11px] font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {formatContribuicao(prazo_medio_carteira)}
            </span>
              </div>

              {/* Card compacto: prazo médio | limite | margem + progresso */}
              <div className="mt-4 rounded-md border border-border/50 bg-muted/20 p-3 space-y-2">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-0.5">
                  Prazo médio
                </p>
                <p
                  className={cn(
                    "font-mono text-sm font-extrabold",
                    isLp ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
                  )}
                >
                  {formatContribuicao(prazo_medio_carteira)}
                </p>
              </div>
              <div>
                <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-0.5">
                  Limite
                </p>
                <p className="font-mono text-sm font-extrabold text-foreground">
                  {limite_dias}d
                </p>
              </div>
              <div>
                <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-0.5">
                  Margem
                </p>
                <p
                  className={cn(
                    "font-mono text-sm font-extrabold",
                    margem >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
                  )}
                >
                  {formatPrazo(margem, true)}
                </p>
              </div>
            </div>

            <div className="relative h-2 rounded bg-secondary overflow-visible">
              <div
                className="absolute inset-y-0 left-0 rounded"
                style={{
                  width: `${Math.min(100, (prazo_medio_carteira / progressMax) * 100)}%`,
                  backgroundColor: isLp ? "#1D9E75" : "#E24B4A",
                }}
              />
              <div
                className="absolute top-0 bottom-0 w-px border-l-2 border-dashed border-red-500"
                style={{ left: `${(limite_dias / progressMax) * 100}%` }}
                title={`Limite ${limite_dias}d`}
              />
            </div>
            <div className="flex justify-between text-[9px] font-mono text-muted-foreground">
              <span>0d</span>
              <span className="text-red-500">{limite_dias}d</span>
              <span>{Math.round(progressMax)}d</span>
            </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tabela detalhada de ativos */}
      {ativosTabela.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-card overflow-hidden px-3 py-2">
          {/* Cabeçalho */}
          <div
            className="grid gap-x-3 items-center text-[10px] font-medium lowercase text-muted-foreground pb-2"
            style={{
              gridTemplateColumns: GRID_COLS,
              borderBottom: "0.5px solid hsl(var(--border))",
            }}
          >
            <span>ativo</span>
            <span className="text-right">valor</span>
            <span className="text-right">prazo</span>
            <span className="text-right">peso</span>
            <span className="text-right">contribuição</span>
          </div>

          {/* Linhas de ativos */}
          {ativosTabela.map((ativo, idx) => {
            const cor = corClassificacao(ativo.classificacao);
            return (
              <div
                key={`${ativo.nome}-${idx}`}
                className="grid gap-x-3 items-center py-2 text-[11px]"
                style={{
                  gridTemplateColumns: GRID_COLS,
                  borderBottom: "0.5px solid hsl(var(--border))",
                }}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate font-medium text-foreground" title={ativo.nome}>
                    {ativo.nome}
                  </span>
                  <ClassificacaoPill
                    classificacao={ativo.classificacao}
                    prazo={ativo.prazo_dias}
                  />
                </div>
                <span className="text-right font-mono tabular-nums text-foreground">
                  {formatBRL(ativo.valor)}
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {formatPrazoInteiro(ativo.prazo_dias)}
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {formatPct(ativo.percentual)}
                </span>
                <span
                  className="text-right font-mono tabular-nums font-medium"
                  style={{ color: ativo.prazo_dias != null ? cor : undefined }}
                >
                  {ativo.prazo_dias == null ? "—" : formatContribuicao(ativo.contribuicao)}
                </span>
              </div>
            );
          })}

          {/* Linha total */}
          <div
            className="grid gap-x-3 items-center py-2 text-[11px] font-medium"
            style={{ gridTemplateColumns: GRID_COLS }}
          >
            <span className="lowercase text-foreground">total</span>
            <span className="text-right font-mono tabular-nums text-foreground">
              {formatBRL(totalValorAtivos)}
            </span>
            <span className="text-right font-mono text-muted-foreground">—</span>
            <span className="text-right font-mono tabular-nums text-foreground">
              {totalPesoAtivos > 0 ? formatPct(totalPesoAtivos) : "100%"}
            </span>
            <span
              className="text-right font-mono tabular-nums"
              style={{ color: "#1D9E75" }}
            >
              {formatContribuicao(prazo_medio_carteira)}
            </span>
          </div>

          {/* Rodapé regulatório */}
          <p className="text-[11px] text-muted-foreground leading-relaxed pt-3 mt-1">
            Prazo médio calculado conforme Art. 4º IN RFB 1.585/2015: cotas de fundo LP = 366 dias
            fixos (§4º), cotas de fundo CP = 1 dia fixo (§3º), títulos RF = dias corridos até
            vencimento (§2º I); quando cadastrado cronograma de amortizações intermediárias, prazo
            calculado por WAM de fluxos nominais (§2º II). FII, FIA, FIP, CCB e COE excluídos (§5º).
            Badges <span className="inline-flex items-center gap-0.5 rounded bg-blue-100 text-blue-700 font-bold px-1 text-[9px]"><CalendarDays className="h-2 w-2" />Inc. II</span> indicam títulos calculados pelo inciso II.
          </p>
        </div>
      )}
    </div>
  );
}
