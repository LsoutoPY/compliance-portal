import { useState, useCallback } from "react";

export type SortDirection = "none" | "asc" | "desc";

export function useRelatorioSort<T extends string>(initialKey: T) {
  const [sortConfig, setSortConfig] = useState<{ key: T; direction: SortDirection }>({
    key: initialKey,
    direction: "none",
  });

  const toggleSort = useCallback((key: T) => {
    setSortConfig((current) => {
      if (current.key !== key) return { key, direction: "asc" };
      if (current.direction === "none") return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      return { key, direction: "none" };
    });
  }, []);

  const getDirection = useCallback(
    (key: T): SortDirection => (sortConfig.key === key ? sortConfig.direction : "none"),
    [sortConfig],
  );

  return { sortConfig, toggleSort, getDirection };
}

export function getSortTitle(label: string, direction: SortDirection): string {
  if (direction === "asc") return `${label}: crescente`;
  if (direction === "desc") return `${label}: decrescente`;
  return `Clique para ordenar por ${label.toLowerCase()}`;
}

type SortValue = string | number | null | undefined;

export function sortRelatorioRows<T>(
  rows: T[],
  sortKey: string,
  direction: SortDirection,
  getValue: (row: T, key: string) => SortValue,
  statusPriority?: Record<string, number>,
  statusSortKey = "status",
): T[] {
  if (direction === "none") return rows;

  return [...rows].sort((a, b) => {
    const rawA = getValue(a, sortKey);
    const rawB = getValue(b, sortKey);

    let diff = 0;

    if (statusPriority && sortKey === statusSortKey) {
      const pa = statusPriority[String(rawA ?? "")] ?? 99;
      const pb = statusPriority[String(rawB ?? "")] ?? 99;
      diff = pa - pb;
    } else if (typeof rawA === "number" && typeof rawB === "number") {
      diff = rawA - rawB;
    } else if (rawA == null && rawB == null) {
      diff = 0;
    } else if (rawA == null) {
      diff = 1;
    } else if (rawB == null) {
      diff = -1;
    } else {
      diff = String(rawA).localeCompare(String(rawB), "pt-BR", { sensitivity: "base", numeric: true });
    }

    if (diff !== 0) return direction === "asc" ? diff : -diff;
    return String(getValue(a, "nome_fundo") ?? "").localeCompare(
      String(getValue(b, "nome_fundo") ?? ""),
      "pt-BR",
      { sensitivity: "base" },
    );
  });
}
