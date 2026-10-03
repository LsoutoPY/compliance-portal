/** Origens de PL suportadas pelas regras CONCENTRACAO_* (parametros.origem_pl). */
export type OrigemPlConcentracaoFidc =
  | "pl_mes_anterior_posicao"
  | "pl_atual_xml"
  | "pl_mes_anterior_informe_mensal";

export const ORIGEM_PL_CONCENTRACAO_DEFAULT: OrigemPlConcentracaoFidc =
  "pl_mes_anterior_posicao";

export function formatDtposicaoYmd(ymd: string): string {
  if (ymd.length !== 8) return ymd;
  return `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}`;
}

/** Rótulo curto para UI (RulesSheet) a partir dos detalhes da regra. */
export function labelOrigemPlConcentracao(detalhes: Record<string, unknown>): string {
  const origem = detalhes.origem_pl_utilizada as string | undefined;
  const fallback = Boolean(detalhes.origem_pl_fallback);
  const sub = detalhes.pl_sub_origem as string | undefined;
  const refDate = detalhes.data_pl_referencia as string | undefined;
  const competencia =
    (detalhes.competencia_pl_referencia as string | undefined) ??
    (detalhes.competencia_informe_pl as string | undefined);

  if (origem === "pl_mes_anterior_posicao") {
    const hdr = sub === "fidc_header" ? " · Header FIDC" : "";
    const dt = refDate ? ` · ${formatDtposicaoYmd(refDate)}` : "";
    const fb = fallback ? " · fallback dia" : "";
    return `Posição mês ant.${hdr}${dt}${fb}`;
  }

  if (origem === "fidc_header") {
    return fallback ? "Header FIDC (fallback informe)" : "Header FIDC";
  }

  if (fallback) return "XML (fallback)";

  if (origem === "pl_mes_anterior_informe_mensal") {
    return competencia
      ? `Informe Mensal (${competencia.slice(0, 4)}/${competencia.slice(4, 6)})`
      : "Informe Mensal";
  }

  if (origem === "pl_atual_xml") return "PL do dia";

  return "XML";
}
