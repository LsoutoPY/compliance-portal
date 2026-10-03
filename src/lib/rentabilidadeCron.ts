import type { CronHorario } from "@/lib/monitoramentoCron";

export type { CronHorario };

export const DEFAULT_RENTABILIDADE_CRON_HORARIOS: CronHorario[] = [
  { id: "rentabilidade-manha", label: "Manhã", ativo: true, hora: 10, minuto: 0 },
  { id: "rentabilidade-noite", label: "Noite", ativo: true, hora: 19, minuto: 0 },
];

export function criarNovoHorarioRentabilidade(existing: CronHorario[]): CronHorario {
  let n = existing.length + 1;
  let id = `rentabilidade-horario-${n}`;
  while (existing.some((h) => h.id === id)) {
    n += 1;
    id = `rentabilidade-horario-${n}`;
  }
  return { id, label: `Horário ${n}`, ativo: true, hora: 9, minuto: 0 };
}

/** Deriva cron_horarios da config salva, com fallback ao padrão (10h/19h). */
export function horariosRentabilidadeFromConfig(cfg: Record<string, unknown> | null | undefined): CronHorario[] {
  if (cfg && Array.isArray(cfg.cron_horarios) && cfg.cron_horarios.length > 0) {
    return cfg.cron_horarios as CronHorario[];
  }
  return DEFAULT_RENTABILIDADE_CRON_HORARIOS;
}
