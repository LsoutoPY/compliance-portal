/** Contadores de desenquadramento — mínimo % PL em FIDC (67%, 50%, etc.). */

/** Regra 67% / concentração FIDC — até 2 episódios em 12 meses. */
export const MIN_ALOC_MAX_EVENTOS_12M = 2;
/** Art. caput 50% em cotas FIDC — no máximo 1 episódio (redução abaixo de 50%). */
export const MIN_ALOC_MAX_EVENTOS_12M_COTAS_50 = 1;
export const MIN_ALOC_MAX_DIAS_VIOLACAO_12M = 30;

export function normalizeLimiteMinFrac(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n >= 2 ? n / 100 : n;
}

/** Mínimo 50% em cotas de FIDC — limite regulatório de 1 evento/12 meses. */
export function isRegraMin50CotasFidc(limiteMin: number | null | undefined): boolean {
  const lim = normalizeLimiteMinFrac(limiteMin);
  return lim != null && Math.abs(lim - 0.5) < 0.001;
}

export function resolveMaxEventosMinAloc12m(
  limiteMin: number | null | undefined,
  detalhes?: Record<string, unknown> | null,
): number {
  if (detalhes?.max_eventos_12m != null) {
    const n = Number(detalhes.max_eventos_12m);
    if (Number.isFinite(n)) return n;
  }
  const lim =
    normalizeLimiteMinFrac(limiteMin) ??
    normalizeLimiteMinFrac(detalhes?.limite_min);
  if (isRegraMin50CotasFidc(lim)) return MIN_ALOC_MAX_EVENTOS_12M_COTAS_50;
  return MIN_ALOC_MAX_EVENTOS_12M;
}

export type MinAlocStatus = "ok" | "alerta" | "violacao";

export interface MinAlocSerieDia {
  fundo_dtposicao: string;
  status: MinAlocStatus;
}

export interface MinAlocEpisodio {
  inicio: string;
  fim: string;
  dias: number;
  datas: string[];
}

export interface MinAlocContadores12m {
  eventos_12m: number;
  dias_violacao_12m: number;
  episodios: MinAlocEpisodio[];
  dias_violacao: string[];
}

export function ymdPosicaoToIso(fundo_dtposicao: string): string | null {
  const ymd = fundo_dtposicao.replace(/\D/g, "").slice(0, 8);
  if (ymd.length !== 8) return null;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

export function isoToYmdPosicao(iso: string): string {
  return iso.replace(/\D/g, "").slice(0, 8);
}

/** Janela móvel de 12 meses até a data de posição (inclusive). */
export function rolling12mBoundsYmd(fundoDtposicao: string): { fromYmd: string; toYmd: string } {
  const toYmd = fundoDtposicao.replace(/\D/g, "").slice(0, 8);
  const y = parseInt(toYmd.slice(0, 4), 10);
  const m = parseInt(toYmd.slice(4, 6), 10) - 1;
  const d = parseInt(toYmd.slice(6, 8), 10);
  const end = new Date(y, m, d);
  const start = new Date(end);
  start.setMonth(start.getMonth() - 12);
  const pad = (n: number) => String(n).padStart(2, "0");
  const fromYmd =
    `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}`;
  return { fromYmd, toYmd };
}

function normalizeCategoriaToken(c: string): string {
  return c.toUpperCase().replace(/\s/g, "");
}

/** Regra relacional/classe de mínimo % PL em FIDC (67%, 50%, etc.). */
export function isRegraMinAlocacaoFidc(rule: {
  regra_codigo?: string;
  regra_categoria?: string;
  detalhes?: Record<string, unknown> | null;
  valor_limite?: number | null;
}): boolean {
  const codigo = (rule.regra_codigo ?? "").toUpperCase();
  if (codigo === "CLASSE_FIDC_67" || codigo.startsWith("CLASSE_FIDC_")) return true;
  if ((rule.regra_categoria ?? "").toLowerCase() === "classe" && codigo.includes("FIDC")) {
    return true;
  }

  const d = rule.detalhes ?? {};
  if (d?.regra_min_alocacao_fidc === true) return true;
  if (d.regra_min_67_fii_fidc === true) return true;

  const limiteMin = d.limite_min != null ? Number(d.limite_min) : null;
  const cat = String(d.categoria_alvo ?? "");
  if (limiteMin != null && limiteMin > 0 && categoriaEnvolveFidc(cat)) return true;

  return false;
}

export function categoriaEnvolveFidc(targetCategoria: string): boolean {
  const tokens = targetCategoria
    .split(",")
    .map((c) => normalizeCategoriaToken(c))
    .filter(Boolean);
  return tokens.some(
    (t) =>
      t.startsWith("FIDC") ||
      t === "FICFIDC" ||
      t.includes("FICFIDC") ||
      t === "FIDCNP",
  );
}

export function isViolacaoMinAlocacaoStatus(status: string): boolean {
  return status === "violacao";
}

/** Episódios contíguos com status violacao. */
export function extrairEpisodiosMinAlocFromSeries(rows: MinAlocSerieDia[]): MinAlocEpisodio[] {
  if (!rows.length) return [];

  const sorted = [...rows].sort((a, b) =>
    a.fundo_dtposicao.localeCompare(b.fundo_dtposicao),
  );

  const episodios: MinAlocEpisodio[] = [];
  let current: MinAlocEpisodio | null = null;

  for (const r of sorted) {
    const violacao = isViolacaoMinAlocacaoStatus(r.status);
    if (violacao) {
      if (!current) {
        current = {
          inicio: r.fundo_dtposicao,
          fim: r.fundo_dtposicao,
          dias: 1,
          datas: [r.fundo_dtposicao],
        };
      } else {
        current.fim = r.fundo_dtposicao;
        current.dias += 1;
        current.datas.push(r.fundo_dtposicao);
      }
    } else if (current) {
      episodios.push(current);
      current = null;
    }
  }
  if (current) episodios.push(current);

  return episodios;
}

export function calcularContadoresMinAloc12mFromSeries(
  rows: MinAlocSerieDia[],
  fundoDtposicaoAtual?: string,
  statusAtual?: MinAlocStatus,
): MinAlocContadores12m {
  const map = new Map<string, MinAlocSerieDia>();
  for (const r of rows) map.set(r.fundo_dtposicao, r);

  if (fundoDtposicaoAtual && statusAtual) {
    const ymd = fundoDtposicaoAtual.replace(/\D/g, "").slice(0, 8);
    map.set(ymd, { fundo_dtposicao: ymd, status: statusAtual });
  }

  const sorted = [...map.values()].sort((a, b) =>
    a.fundo_dtposicao.localeCompare(b.fundo_dtposicao),
  );

  const episodios = extrairEpisodiosMinAlocFromSeries(sorted);
  const dias_violacao = episodios.flatMap((e) => e.datas);

  return {
    eventos_12m: episodios.length,
    dias_violacao_12m: dias_violacao.length,
    episodios,
    dias_violacao,
  };
}

/** Status efetivo: limites regulatórios 2 eventos / 30 dias em 12 meses. */
export function effectiveMinAlocacaoStatus(
  status: MinAlocStatus,
  detalhes: Record<string, unknown> | null | undefined,
): MinAlocStatus {
  const eventos =
    num(detalhes?.eventos_12m) ?? num(detalhes?.eventos_ano) ?? 0;
  const dias =
    num(detalhes?.dias_violacao_12m) ?? num(detalhes?.dias_violacao_ano) ?? 0;
  const maxEv = resolveMaxEventosMinAloc12m(
    num(detalhes?.limite_min) ?? undefined,
    detalhes,
  );
  const maxDias =
    num(detalhes?.max_dias_violacao_12m) ??
    num(detalhes?.max_dias_violacao_ano) ??
    MIN_ALOC_MAX_DIAS_VIOLACAO_12M;

  if (eventos >= maxEv || dias >= maxDias) return "violacao";
  return status;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function formatYmdPosicaoBr(ymd: string): string {
  const clean = ymd.replace(/\D/g, "").slice(0, 8);
  if (clean.length !== 8) return ymd;
  return `${clean.slice(6, 8)}/${clean.slice(4, 6)}/${clean.slice(0, 4)}`;
}

export function formatMinAlocEpisodioLabel(ep: MinAlocEpisodio): string {
  const ini = formatYmdPosicaoBr(ep.inicio);
  if (ep.dias <= 1) return ini;
  return `${ini} – ${formatYmdPosicaoBr(ep.fim)} (${ep.dias}d)`;
}
