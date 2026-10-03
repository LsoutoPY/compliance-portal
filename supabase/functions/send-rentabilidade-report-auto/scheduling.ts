/**
 * Regras de agendamento do envio automático de rentabilidade:
 * - O fluxo principal avança para a próxima data disponível sem ficar bloqueado.
 * - Quando nao ha data nova, uma fila derivada dos logs reverifica uma data
 *   parcial antiga por disparo, sem concorrencia com o fluxo principal.
 * - 10h: envia parcial se houver XML; 19h: reenvia se ficou completo ou se o conjunto
 *   de fundos mudou; se ainda parcial e igual, não reenvia.
 */

export interface EnvioLogRow {
  data_referencia: string;
  origem: string;
  status: string;
  status_cobertura: string | null;
  fundos_incluidos: string[] | null;
  created_at?: string | null;
}

export function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Data encerrada = envio manual bem-sucedido OU auto com cobertura completa. */
export function isDateClosed(envios: EnvioLogRow[], dataRef: string): boolean {
  return envios.some((e) => {
    if (e.status !== "enviado" || e.data_referencia !== dataRef) return false;
    if (e.origem === "manual") return true;
    return e.status_cobertura === "completo";
  });
}

/** Maior data_referencia já encerrada (manual sempre encerra; auto só se completo). */
export function lastClosedDate(envios: EnvioLogRow[]): string | null {
  const closed = enviadosClosedDates(envios);
  return closed.length > 0 ? closed.sort().at(-1)! : null;
}

function enviadosClosedDates(envios: EnvioLogRow[]): string[] {
  const enviados = envios.filter((e) => e.status === "enviado");
  return [
    ...new Set(
      enviados
        .filter((e) => e.origem === "manual" || e.status_cobertura === "completo")
        .map((e) => e.data_referencia),
    ),
  ];
}

/**
 * Determina a data de referência do próximo envio automático (1 por disparo).
 * Manual e auto contam; datas parciais são reavaliadas no mesmo dia e deixam de
 * bloquear o cursor no dia seguinte.
 * 
 * IMPORTANTE: Retorna null se não há data candidata — o caller deve buscar
 * a próxima data disponível em posicao_carteira (evita travar em finais de semana).
 */
export function resolveProximaDataReferencia(
  envios: EnvioLogRow[],
  hoje: string,
): { data: string | null; motivo?: string; lastClosed?: string } {
  const enviados = envios.filter((e) => e.status === "enviado");
  // Tentativas adiadas também avançam o cursor principal. Caso contrário,
  // uma data nova abaixo do mínimo (status "agendado") seria escolhida em
  // todos os horários e bloquearia a rotação das parciais anteriores.
  const tentativas = envios.filter((e) => e.status === "enviado" || e.status === "agendado");
  const datesAttempted = [...new Set(tentativas.map((e) => e.data_referencia))].sort();

  // Reabre uma data parcial somente no mesmo dia BRT em que ela foi enviada.
  // Sem este limite, uma data que nunca ficar completa bloqueia para sempre as
  // datas seguintes: o cron volta à mesma data e o dedup pula todos os envios.
  const openDates = datesAttempted.filter((d) => !isDateClosed(enviados, d) && d <= hoje);
  const openDatesSentToday = openDates.filter((dataRef) =>
    dataRef === hoje &&
    tentativas.some((envio) =>
      envio.data_referencia === dataRef &&
      envio.created_at != null &&
      brtDateFromTimestamp(envio.created_at) === hoje
    )
  );
  if (openDatesSentToday.length > 0) {
    return { data: openDatesSentToday.sort().at(-1)! };
  }

  const lastComplete = lastClosedDate(enviados);
  const lastAttempted = datesAttempted.at(-1) ?? null;
  const cursorDate = [lastComplete, lastAttempted]
    .filter((d): d is string => d != null)
    .sort()
    .at(-1) ?? null;

  // Retorna null + lastClosed para o caller buscar próxima data útil com XML
  if (cursorDate && cursorDate >= hoje) {
    return { data: null, motivo: "aguardando_proxima_data", lastClosed: cursorDate };
  }

  // O cursor considera também a última tentativa parcial antiga. Assim ela não
  // impede o avanço para o próximo dia que já possui XML.
  return { data: null, motivo: "buscar_proxima_data_disponivel", lastClosed: cursorDate ?? undefined };
}

/**
 * Escolhe uma data parcial antiga sem bloquear a data nova.
 * A rotação usa a atividade mais recente de qualquer status, inclusive a
 * auditoria "agendado" gravada quando a reverificação não encontra mudança.
 */
export function selectPartialRetryCandidate(
  envios: EnvioLogRow[],
  hoje: string,
): string | null {
  const enviados = envios.filter((e) => e.status === "enviado");
  const tentativas = envios.filter((e) => e.status === "enviado" || e.status === "agendado");
  const partialDates = [
    ...new Set(
      tentativas
        .filter((e) => e.origem === "auto" && e.status_cobertura === "parcial")
        .map((e) => e.data_referencia),
    ),
  ].filter((dataRef) => dataRef < hoje && !isDateClosed(enviados, dataRef));

  if (partialDates.length === 0) return null;

  const lastActivity = new Map<string, string>();
  for (const envio of envios) {
    if (!partialDates.includes(envio.data_referencia) || !envio.created_at) continue;
    const current = lastActivity.get(envio.data_referencia);
    if (!current || envio.created_at > current) {
      lastActivity.set(envio.data_referencia, envio.created_at);
    }
  }

  return partialDates
    .sort((a, b) => {
      const activityCompare = (lastActivity.get(a) ?? "").localeCompare(lastActivity.get(b) ?? "");
      return activityCompare !== 0 ? activityCompare : a.localeCompare(b);
    })[0];
}

/**
 * Garante uma unica carga pesada por disparo do cron.
 * Datas novas tem prioridade; a fila parcial usa os horarios seguintes quando
 * o cursor principal estiver em dia.
 */
export function chooseAutomaticProcessingDate(
  nextAvailableDate: string | null,
  partialRetryDate: string | null,
): { data: string | null; retryParcial: boolean } {
  if (nextAvailableDate) {
    return { data: nextAvailableDate, retryParcial: false };
  }
  if (partialRetryDate) {
    return { data: partialRetryDate, retryParcial: true };
  }
  return { data: null, retryParcial: false };
}

function brtDateFromTimestamp(timestamp: string): string | null {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Dedup intra-dia: parcial→completo, faltantes↓ ou conjunto de fundo_key mudou → envia de novo. */
export function shouldSkipAutoSend(
  ultimoAuto: (Pick<EnvioLogRow, "status_cobertura" | "fundos_incluidos"> & { qtd_faltantes?: number | null }) | null,
  fundosIncluidos: string[],
  statusCoberturaAtual: "completo" | "parcial",
  qtdFaltantesAtual?: number,
): { skip: boolean; motivo?: string } {
  if (!ultimoAuto) {
    return { skip: false };
  }

  if (ultimoAuto.status_cobertura === "parcial" && statusCoberturaAtual === "completo") {
    return { skip: false };
  }

  if (
    ultimoAuto.qtd_faltantes != null &&
    qtdFaltantesAtual != null &&
    qtdFaltantesAtual < ultimoAuto.qtd_faltantes
  ) {
    return { skip: false };
  }

  const anterior = [...(ultimoAuto.fundos_incluidos ?? [])].sort();
  const atual = [...fundosIncluidos].sort();
  if (JSON.stringify(anterior) !== JSON.stringify(atual)) {
    return { skip: false };
  }

  return { skip: true, motivo: "sem_mudanca_desde_ultimo_envio" };
}
