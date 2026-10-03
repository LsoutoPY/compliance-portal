/**
 * Mapeamento dos resultados de liquidez para fundos fechados (trilha separada).
 */

import type { LiquidezProcessedFundData } from "@/lib/liquidezProcessedResults";

type FundoFechadoAnalisePayload = {
  dispPL?: number | null;
  mesesCobertura?: number | null;
  statusCoberturaDespesa?: string | null;
  fonteDespesa?: string | null;
};

type CalculoLiquidezPayload = {
  isFundoFechado?: boolean;
  fundoFechadoAnalise?: FundoFechadoAnalisePayload | null;
  totalPL?: number;
};

export function mapCalculoToProcessedFechado(
  d: CalculoLiquidezPayload
): Pick<
  LiquidezProcessedFundData,
  | "mesesCobertura"
  | "dispPL"
  | "statusCobertura"
  | "fonteDespesa"
  | "indiceLiquidez"
  | "status"
  | "intermediateStatus"
> {
  const ffa = d.fundoFechadoAnalise;
  if (!ffa) {
    return {
      mesesCobertura: null,
      dispPL: null,
      statusCobertura: "indisponivel",
      fonteDespesa: null,
      indiceLiquidez: null,
      status: "pendente",
      intermediateStatus: null,
    };
  }

  const cs = ffa.statusCoberturaDespesa ?? "indisponivel";
  const status =
    cs === "ok" || cs === "alerta" || cs === "violacao" ? cs : "pendente";

  return {
    mesesCobertura: ffa.mesesCobertura ?? null,
    dispPL: ffa.dispPL ?? null,
    statusCobertura: cs,
    fonteDespesa: ffa.fonteDespesa ?? null,
    indiceLiquidez: ffa.mesesCobertura ?? null,
    status,
    intermediateStatus: null,
  };
}

export const FONTE_DESPESA_LABELS: Record<string, string> = {
  conferencia_taxas: "Controle Taxas",
  provisoes_xml: "Provisões XML (taxas)",
  despesas_fundo: "Despesas (adm.)",
  media_historica: "Média histórica",
  manual: "Manual",
};
