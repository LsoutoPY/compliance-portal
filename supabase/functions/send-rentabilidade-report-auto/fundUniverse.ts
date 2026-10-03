export interface FundUniverseCandidate {
  fundoCnpj: string | null;
  cnpjGestor: string | null;
}

/**
 * Une o cache historico com os fundos encontrados na data do relatorio.
 * O cache preserva fundos temporariamente ausentes; a leitura da data inclui
 * imediatamente fundos novos mesmo se o upsert do cache tiver falhado.
 */
export function mergeFundUniverseCnpjs(
  cacheCandidates: FundUniverseCandidate[],
  currentDateCandidates: FundUniverseCandidate[],
  gestoresSet: Set<string>,
  normalizeCnpjDigits: (cnpj: string | null | undefined) => string,
): string[] {
  const cnpjs = new Set<string>();

  for (const candidate of [...cacheCandidates, ...currentDateCandidates]) {
    const fundoCnpj = candidate.fundoCnpj?.trim();
    if (!fundoCnpj) continue;

    if (gestoresSet.size > 0) {
      const gestor = normalizeCnpjDigits(candidate.cnpjGestor);
      if (!gestor || !gestoresSet.has(gestor)) continue;
    }

    cnpjs.add(fundoCnpj);
  }

  return [...cnpjs].sort();
}
