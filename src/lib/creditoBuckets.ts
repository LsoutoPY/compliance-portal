/** Taxonomia canônica única do módulo de crédito (UI + métricas). */

export const BUCKETS_CANONICOS = [
  "Adimplente",
  "1-30",
  "31-60",
  "61-90",
  "91-180",
  "180+",
] as const;

export type BucketCanonico = (typeof BUCKETS_CANONICOS)[number];

export const BUCKET_ORDEM: Record<BucketCanonico, number> = {
  Adimplente: 0,
  "1-30": 1,
  "31-60": 2,
  "61-90": 3,
  "91-180": 4,
  "180+": 5,
};

export const BUCKET_LABELS: Record<number, string> = {
  0: "Adimplente",
  1: "1–30 dias",
  2: "31–60 dias",
  3: "61–90 dias",
  4: "91–180 dias",
  5: "180+ dias",
};

export const BUCKET_COLORS: Record<number, string> = {
  0: "#16a34a",
  1: "#65a30d",
  2: "#ca8a04",
  3: "#d97706",
  4: "#ea580c",
  5: "#991b1b",
};

/** Over90 = faixas 91–180 + 180+ (ordem ≥ 4). */
export const OVER90_BUCKET_ORDENS = [4, 5] as const;

export function bucketFromDelay(days: number): BucketCanonico {
  if (days <= 0) return "Adimplente";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  if (days <= 180) return "91-180";
  return "180+";
}

export function bucketOrdemFromDelay(days: number): number {
  return BUCKET_ORDEM[bucketFromDelay(days)];
}

export function rollMigracaoLabel(origem: number, destino: number): string {
  const o = BUCKET_LABELS[origem] ?? `B${origem}`;
  const d = BUCKET_LABELS[destino] ?? `B${destino}`;
  return `${o} → ${d}`;
}

export function rollMigracaoProximaLabel(origem: number): string {
  if (origem >= 5) return "—";
  return rollMigracaoLabel(origem, origem + 1);
}
