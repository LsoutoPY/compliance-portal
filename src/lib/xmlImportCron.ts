import type { CronHorario } from "@/lib/monitoramentoCron";

export type { CronHorario };
export type XmlImportFonte = "btg" | "finvest";

export const DEFAULT_BTG_CRON_HORARIOS: CronHorario[] = [
  { id: "xml-import-btg-manha", label: "BTG Manhã", ativo: true, hora: 7, minuto: 30 },
  { id: "xml-import-btg-tarde", label: "BTG Tarde", ativo: true, hora: 17, minuto: 30 },
];

export const DEFAULT_FINVEST_CRON_HORARIOS: CronHorario[] = [
  { id: "xml-import-finvest-manha", label: "Finvest Manhã", ativo: true, hora: 8, minuto: 0 },
  { id: "xml-import-finvest-tarde", label: "Finvest Tarde", ativo: true, hora: 18, minuto: 0 },
];

export function criarNovoHorarioXmlImport(
  existing: CronHorario[],
  prefix: "xml-import-btg" | "xml-import-finvest",
): CronHorario {
  let n = existing.length + 1;
  let id = `${prefix}-horario-${n}`;
  while (existing.some((h) => h.id === id)) {
    n += 1;
    id = `${prefix}-horario-${n}`;
  }
  const labelPrefix = prefix.includes("btg") ? "BTG" : "Finvest";
  return { id, label: `${labelPrefix} Horário ${n}`, ativo: true, hora: 9, minuto: 0 };
}

export function horariosBtgFromConfig(cfg: Record<string, unknown> | null | undefined): CronHorario[] {
  if (cfg && Array.isArray(cfg.btg_cron_horarios) && cfg.btg_cron_horarios.length > 0) {
    return cfg.btg_cron_horarios as CronHorario[];
  }
  return DEFAULT_BTG_CRON_HORARIOS;
}

export function horariosFinvestFromConfig(cfg: Record<string, unknown> | null | undefined): CronHorario[] {
  if (cfg && Array.isArray(cfg.finvest_cron_horarios) && cfg.finvest_cron_horarios.length > 0) {
    return cfg.finvest_cron_horarios as CronHorario[];
  }
  return DEFAULT_FINVEST_CRON_HORARIOS;
}

function formatBrDate(d: Date): string {
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

/** Período calculado a partir de dias de calendário retroativos (data final = ontem). */
export function dateRangeFromDiasCalendario(dias: number): { data_inicial: string; data_final: string } {
  const n = Math.max(1, Math.min(30, Math.floor(dias)));
  const fim = new Date();
  fim.setHours(12, 0, 0, 0);
  fim.setDate(fim.getDate() - 1);

  const ini = new Date(fim);
  ini.setDate(ini.getDate() - (n - 1));

  return { data_inicial: formatBrDate(ini), data_final: formatBrDate(fim) };
}

export function labelJobXmlImport(jobname: string, horarios: CronHorario[]): string {
  const h = horarios.find((x) => x.id === jobname);
  if (h) return `${h.label} (${String(h.hora).padStart(2, "0")}:${String(h.minuto).padStart(2, "0")} BRT)`;
  return jobname;
}
