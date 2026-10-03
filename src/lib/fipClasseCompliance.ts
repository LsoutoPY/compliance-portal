export type ComplianceStatus = "ok" | "alerta" | "violacao";

interface ResolveFipClasseComplianceInput {
  storedValue: number | null;
  storedStatus: ComplianceStatus;
  minimumLimit: number | null;
  alertLimit?: number | null;
  totalParticipacoes?: number | null;
  patliq?: number | null;
  percParticipacoesSemBonus?: number | null;
  bonus5pct?: number | null;
  considerarCapitalSubscr: boolean;
  emCarenciaMinimoAlocacao?: boolean;
}

export interface FipClasseCompliancePresentation {
  value: number | null;
  status: ComplianceStatus;
}

export interface StoredComplianceRule {
  regra_codigo?: string | null;
  status: string;
  valor_atual?: number | null;
  valor_limite?: number | null;
  detalhes?: Record<string, unknown> | null;
}

/**
 * Mantém o percentual exibido e o status da regra FIP sincronizados com o toggle
 * de capital subscrito. Esta função afeta somente a apresentação da CLASSE_FIP_90.
 */
export function resolveFipClasseCompliance({
  storedValue,
  storedStatus,
  minimumLimit,
  alertLimit,
  totalParticipacoes,
  patliq,
  percParticipacoesSemBonus,
  bonus5pct,
  considerarCapitalSubscr,
  emCarenciaMinimoAlocacao = false,
}: ResolveFipClasseComplianceInput): FipClasseCompliancePresentation {
  if (emCarenciaMinimoAlocacao) {
    return {
      value: storedValue,
      status: storedStatus === "violacao" ? "ok" : storedStatus,
    };
  }

  let value = storedValue;

  if (considerarCapitalSubscr) {
    if (
      Number.isFinite(totalParticipacoes) &&
      Number.isFinite(bonus5pct) &&
      Number(patliq) > 0 &&
      Number(bonus5pct) > 0
    ) {
      value = (Number(totalParticipacoes) + Number(bonus5pct)) / Number(patliq);
    }
  } else if (Number.isFinite(percParticipacoesSemBonus)) {
    value = Number(percParticipacoesSemBonus);
  }

  if (!Number.isFinite(value) || !Number.isFinite(minimumLimit)) {
    return { value, status: storedStatus };
  }

  const currentValue = Number(value);
  const minimum = Number(minimumLimit);
  if (currentValue < minimum) return { value: currentValue, status: "violacao" };

  if (Number.isFinite(alertLimit) && Number(alertLimit) > minimum && currentValue < Number(alertLimit)) {
    return { value: currentValue, status: "alerta" };
  }

  return { value: currentValue, status: "ok" };
}

/**
 * Resolve o status efetivo de uma regra persistida. Para CLASSE_FIP_90, usa o
 * bônus de capital subscrito salvo em detalhes; todas as demais regras mantêm
 * exatamente o status gravado pelo motor.
 */
export function resolveStoredComplianceStatus(rule: StoredComplianceRule): ComplianceStatus {
  const storedStatus: ComplianceStatus =
    rule.status === "violacao" || rule.status === "alerta" ? rule.status : "ok";

  if ((rule.regra_codigo || "").toUpperCase() !== "CLASSE_FIP_90") {
    return storedStatus;
  }

  const detalhes = rule.detalhes;
  return resolveFipClasseCompliance({
    storedValue: rule.valor_atual ?? null,
    storedStatus,
    minimumLimit: rule.valor_limite ?? null,
    alertLimit: typeof detalhes?.limite_alerta === "number"
      ? detalhes.limite_alerta
      : rule.valor_limite === 0.9
        ? 0.92
        : null,
    totalParticipacoes: typeof detalhes?.total_participacoes === "number"
      ? detalhes.total_participacoes
      : null,
    patliq: typeof detalhes?.patliq === "number" ? detalhes.patliq : null,
    percParticipacoesSemBonus: typeof detalhes?.perc_participacoes_sem_bonus === "number"
      ? detalhes.perc_participacoes_sem_bonus
      : null,
    bonus5pct: typeof detalhes?.bonus_5pct_cap_subscrito === "number"
      ? detalhes.bonus_5pct_cap_subscrito
      : null,
    considerarCapitalSubscr: true,
    emCarenciaMinimoAlocacao: detalhes?.em_carencia_minimo_alocacao === true,
  }).status;
}
