export type CronHorario = {
  id: string;
  label: string;
  ativo: boolean;
  hora: number;
  minuto: number;
};

export const DEFAULT_CRON_HORARIOS: CronHorario[] = [
  { id: "monitoramento-meio-dia", label: "Meio-dia", ativo: true, hora: 12, minuto: 0 },
  { id: "monitoramento-tarde", label: "Tarde", ativo: true, hora: 18, minuto: 30 },
];

export function formatHoraBrt(h: number, m: number) {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Converte expressão cron UTC (M H * * DOW) para rótulo legível em BRT */
export function cronUtcParaLabelBrt(schedule: string): string {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return schedule;

  const minute = Number(parts[0]);
  const hourUtc = Number(parts[1]);
  const dow = parts[4];

  if (Number.isNaN(minute) || Number.isNaN(hourUtc)) return schedule;

  let totalMin = hourUtc * 60 + minute - 3 * 60;
  if (totalMin < 0) totalMin += 24 * 60;

  const hBrt = Math.floor(totalMin / 60);
  const mBrt = totalMin % 60;

  let dowLabel = `dias ${dow}`;
  if (dow === "1-5") dowLabel = "seg–sex";
  else if (dow === "*") dowLabel = "todos os dias";

  return `${formatHoraBrt(hBrt, mBrt)} BRT (${dowLabel})`;
}

export function slugifyCronId(label: string) {
  const base = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `monitoramento-${base || "horario"}`;
}

export function criarNovoHorario(existing: CronHorario[]): CronHorario {
  let n = existing.length + 1;
  let id = `monitoramento-horario-${n}`;
  while (existing.some((h) => h.id === id)) {
    n += 1;
    id = `monitoramento-horario-${n}`;
  }
  return { id, label: `Horário ${n}`, ativo: true, hora: 9, minuto: 0 };
}

/** Deriva cron_horarios de colunas legadas (antes da migration JSON) */
export function horariosFromLegacy(cfg: Record<string, unknown>): CronHorario[] {
  if (Array.isArray(cfg.cron_horarios) && cfg.cron_horarios.length > 0) {
    return cfg.cron_horarios as CronHorario[];
  }
  return [
    {
      id: "monitoramento-meio-dia",
      label: "Meio-dia",
      ativo: Boolean(cfg.cron_meio_dia_ativo ?? true),
      hora: Number(cfg.cron_meio_dia_hora ?? 12),
      minuto: Number(cfg.cron_meio_dia_minuto ?? 0),
    },
    {
      id: "monitoramento-tarde",
      label: "Tarde",
      ativo: Boolean(cfg.cron_tarde_ativo ?? true),
      hora: Number(cfg.cron_tarde_hora ?? 18),
      minuto: Number(cfg.cron_tarde_minuto ?? 30),
    },
  ];
}

export function labelJobCron(
  job: { jobname: string; schedule: string },
  horarios: CronHorario[],
): string {
  const cfg = horarios.find((h) => h.id === job.jobname);
  if (cfg) {
    return `${cfg.label} — ${formatHoraBrt(cfg.hora, cfg.minuto)} BRT (seg–sex)`;
  }
  return `${job.jobname} — ${cronUtcParaLabelBrt(job.schedule)}`;
}
