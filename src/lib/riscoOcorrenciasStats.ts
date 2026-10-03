export interface RiscoFundoIdentity {
  fundo_cnpj: string;
  fundo_isin: string | null;
}

function normalizeCnpj(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits || value.trim().toUpperCase();
}

function normalizeIsin(value: string | null): string | null {
  const normalized = value?.replace(/\s/g, "").toUpperCase() ?? "";
  return normalized || null;
}

/**
 * Conta fundos/classes afetados sem repetir ocorrências do mesmo fundo.
 *
 * O CNPJ é a chave principal. ISINs diferentes preservam classes distintas
 * associadas ao mesmo CNPJ; registros sem ISIN são absorvidos pela classe
 * conhecida e não criam uma duplicidade artificial.
 */
export function countFundosAfetados(items: readonly RiscoFundoIdentity[]): number {
  const isinsByCnpj = new Map<string, Set<string>>();

  for (const item of items) {
    const cnpj = normalizeCnpj(item.fundo_cnpj);
    const isins = isinsByCnpj.get(cnpj) ?? new Set<string>();
    const isin = normalizeIsin(item.fundo_isin);
    if (isin) isins.add(isin);
    isinsByCnpj.set(cnpj, isins);
  }

  return [...isinsByCnpj.values()].reduce(
    (total, isins) => total + Math.max(1, isins.size),
    0,
  );
}
