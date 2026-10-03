/** Normaliza nome de fundo para comparação (sem acentos, uppercase). */
function normalizeNomeFundo(nome: string | null | undefined): string {
  return (nome ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * Fundos exclusivos — lista de referência para separação na aba Resumo Fundos.
 * Nomes normalizados (sem acento, uppercase).
 */
const FUNDOS_EXCLUSIVOS = new Set(
  [
    "FMA QI FIF MULTIMERCADO CP RESP LIMITADA",
    "GATI QI FIF MULTIMERCADO CP RESP LIMITADA",
    "JUBIA QI FIF MULTIMERCADO CP RESP LIMITADA",
    "GUILE QI FIF MULTIMERCADO CREDITO PRIVADO",
    "FICFIF QI RM95",
    "PHISIQ QI GRAND SLAM FIF M CP RESP LIMITADA",
    "RMF QI FIF MULTIMERCADO RESP LIMITADA",
    "FICFIDC BIAJU",
    "CARPE DIEM BR QI FIM CP",
    "PORTFOLIO 173 FIF MULT CP RESP LIMITADA",
    "TAMBAU QI FIM CP",
    "MMCP QI FIF MULTIMERCADO CP RESP LIMITADA",
    "GAPE QI FIF MULTIMERCADO CP RESP LIMITADA",
    "NEVERGIVEUP QI FIF MULTI CP RESP LIMITADA",
  ].map(normalizeNomeFundo),
);

/**
 * Fundos que devem ser excluídos da lista de exclusivos.
 * Mesmo que correspondam a algum padrão, não serão considerados exclusivos.
 */
const FUNDOS_NAO_EXCLUSIVOS = new Set(
  [
    "RWM CP PREV FIC FIM",
  ].map(normalizeNomeFundo),
);

export function isFundoExclusivoRentabilidade(nome: string | null | undefined): boolean {
  const norm = normalizeNomeFundo(nome);
  if (!norm) return false;
  
  // Se está na lista de exclusões, não é exclusivo
  if (FUNDOS_NAO_EXCLUSIVOS.has(norm)) return false;
  
  if (FUNDOS_EXCLUSIVOS.has(norm)) return true;
  for (const ref of FUNDOS_EXCLUSIVOS) {
    if (norm.includes(ref)) return true;
  }
  return false;
}
