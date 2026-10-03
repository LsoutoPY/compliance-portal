/** Formatação executiva de alertas de risco de crédito. */

import { formatPct, formatPctPoints } from "@/lib/creditoIndicadores";
import { LIMITE_CONCENTRACAO_RECOMENDADO } from "@/lib/creditoScore";

export type AlertaRisco = {
  doc_fundo: string;
  nome_fundo: string;
  data_referencia?: string;
  tipo_alerta: string;
  indicador: string;
  severidade: string;
  mensagem: string;
};

export type ConcentracaoParte = {
  doc_fundo: string;
  nome_fundo?: string;
  tipo_parte: string;
  doc_parte: string;
  nome_parte: string;
  exposicao_over90: number;
  pct_do_over90: number;
  ranking: number;
};

export type AlertaExecutivo = {
  id: string;
  titulo: string;
  subtitulo?: string;
  nomeParte?: string;
  labelParte?: string;
  valorDestaque?: string;
  limiteRecomendado?: string;
  severidade: "info" | "alerta" | "critico";
  fundo: string;
};

const TITULOS: Record<string, string> = {
  concentracao_top1_over90: "Concentração elevada de inadimplência",
  coverage_npl: "Coverage NPL abaixo do limite",
  aderencia_pdd: "Aderência PDD insuficiente",
  gap_relativo: "Gap de provisão elevado",
  over90: "Over90 em deterioração",
  over180: "Over180 em deterioração",
};

function pctFromMessage(msg: string): number | null {
  const m = /([\d,.]+)\s*%/.exec(msg);
  if (!m) return null;
  return parseFloat(m[1].replace(",", ".")) / 100;
}

export function buildAlertasExecutivos(
  alertas: AlertaRisco[],
  concentracao: ConcentracaoParte[],
): AlertaExecutivo[] {
  const topCedenteByFundo = new Map<string, ConcentracaoParte>();
  concentracao
    .filter((c) => c.tipo_parte === "cedente" && c.ranking === 1)
    .forEach((c) => topCedenteByFundo.set(c.doc_fundo, c));

  return alertas.map((a, i) => {
    const sev = (a.severidade === "critico" ? "critico" : a.severidade === "info" ? "info" : "alerta") as AlertaExecutivo["severidade"];

    if (a.indicador === "concentracao_top1_over90") {
      const top = topCedenteByFundo.get(a.doc_fundo);
      const pct = top?.pct_do_over90 ?? pctFromMessage(a.mensagem) ?? 0;
      return {
        id: `${a.doc_fundo}-conc-${i}`,
        titulo: TITULOS.concentracao_top1_over90,
        labelParte: "Cedente",
        nomeParte: top?.nome_parte || top?.doc_parte || "—",
        valorDestaque: `${(pct * 100).toFixed(2).replace(".", ",")}% do Over90`,
        limiteRecomendado: `Limite recomendado: ${(LIMITE_CONCENTRACAO_RECOMENDADO * 100).toFixed(0)}%`,
        severidade: sev,
        fundo: a.nome_fundo,
      };
    }

    if (a.indicador === "coverage_npl") {
      const pct = pctFromMessage(a.mensagem);
      return {
        id: `${a.doc_fundo}-cov-${i}`,
        titulo: TITULOS.coverage_npl,
        valorDestaque: pct != null ? formatPct(pct) : a.mensagem,
        limiteRecomendado: "Limite mínimo: 80%",
        severidade: sev,
        fundo: a.nome_fundo,
      };
    }

    if (a.indicador === "aderencia_pdd") {
      const pct = pctFromMessage(a.mensagem);
      return {
        id: `${a.doc_fundo}-ader-${i}`,
        titulo: TITULOS.aderencia_pdd,
        valorDestaque: pct != null ? formatPct(pct) : a.mensagem,
        limiteRecomendado: "Limite mínimo: 90%",
        severidade: sev,
        fundo: a.nome_fundo,
      };
    }

    if (a.tipo_alerta === "salto" && a.indicador === "over90") {
      const pp = a.mensagem.match(/([\d,.]+)\s*p\.p\./i);
      return {
        id: `${a.doc_fundo}-salto-${i}`,
        titulo: TITULOS.over90,
        valorDestaque: pp ? formatPctPoints(parseFloat(pp[1].replace(",", ".")) / 100) : a.mensagem,
        severidade: sev,
        fundo: a.nome_fundo,
      };
    }

    if (a.tipo_alerta === "tendencia" && a.indicador === "over90") {
      return {
        id: `${a.doc_fundo}-tend-${i}`,
        titulo: "Tendência de deterioração",
        valorDestaque: "Over90 crescente por 3 meses",
        severidade: sev,
        fundo: a.nome_fundo,
      };
    }

    return {
      id: `${a.doc_fundo}-gen-${i}`,
      titulo: TITULOS[a.indicador] ?? "Alerta de risco",
      valorDestaque: a.mensagem,
      severidade: sev,
      fundo: a.nome_fundo,
    };
  });
}

export function severidadeStyles(sev: AlertaExecutivo["severidade"]) {
  switch (sev) {
    case "critico":
      return {
        border: "border-red-200",
        bg: "bg-red-50",
        titulo: "text-red-900",
        texto: "text-red-800",
        muted: "text-red-700/80",
      };
    case "alerta":
      return {
        border: "border-amber-200",
        bg: "bg-amber-50",
        titulo: "text-amber-900",
        texto: "text-amber-900",
        muted: "text-amber-800/80",
      };
    default:
      return {
        border: "border-blue-200",
        bg: "bg-blue-50",
        titulo: "text-blue-900",
        texto: "text-blue-800",
        muted: "text-blue-700/80",
      };
  }
}
