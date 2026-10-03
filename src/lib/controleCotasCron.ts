import type { CronHorario } from "@/lib/monitoramentoCron";

export type { CronHorario };

export const DEFAULT_CONTROLE_COTAS_CRON_HORARIOS: CronHorario[] = [
  { id: "controle-cotas-import-manha", label: "Manhã", ativo: true, hora: 8, minuto: 0 },
  { id: "controle-cotas-import-tarde", label: "Tarde", ativo: true, hora: 18, minuto: 0 },
];

export function criarNovoHorarioControleCotas(existing: CronHorario[]): CronHorario {
  let n = existing.length + 1;
  let id = `controle-cotas-import-horario-${n}`;
  while (existing.some((h) => h.id === id)) {
    n += 1;
    id = `controle-cotas-import-horario-${n}`;
  }
  return { id, label: `Horário ${n}`, ativo: true, hora: 9, minuto: 0 };
}

export function horariosControleCotasFromConfig(
  cfg: Record<string, unknown> | null | undefined,
): CronHorario[] {
  if (cfg && Array.isArray(cfg.cron_horarios) && cfg.cron_horarios.length > 0) {
    return cfg.cron_horarios as CronHorario[];
  }
  return DEFAULT_CONTROLE_COTAS_CRON_HORARIOS;
}

/** Período padrão do botão "Importar via API": 1º dia do mês anterior → hoje. */
export function defaultControleCotasApiDateRange(): { inicio: string; fim: string } {
  const hoje = new Date();
  const primeiroDiaMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { inicio: fmt(primeiroDiaMesAnterior), fim: fmt(hoje) };
}
