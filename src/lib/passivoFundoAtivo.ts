import { normalizeCnpjDigits } from "@/lib/fundosMonitorados";

function foldingKey(name: string): string {
  return (name || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s*\(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\)\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * Fundos que não são (mais) da nossa gestão e devem ficar inativos
 * na aba Passivo Fundos, mesmo que ainda existam posições importadas.
 */
const FUNDOS_PASSIVO_INATIVOS_NOME: RegExp[] = [
  /\bBOTANICH\b/,
  /(^|[^A-Z0-9])M4([^A-Z0-9]|$)/,
];

/** NEXUM JR/SR é da casa; o código Finvest 36517588 gera um CNPJ legado inexistente. */
const FUNDOS_PASSIVO_SEMPRE_ATIVOS_NOME: RegExp[] = [/\bNEXUM\b/];
const CNPJ_PASSIVO_CANONICO: Record<string, string> = {
  "36517588000100": "36517586000103",
};

export function cnpjPassivoCanonico(cnpj: string | null | undefined): string {
  const digits = normalizeCnpjDigits(cnpj);
  return CNPJ_PASSIVO_CANONICO[digits] ?? digits;
}

export function isFundoPassivoInativoPorNome(nome: string | null | undefined): boolean {
  const key = foldingKey(String(nome ?? ""));
  if (!key) return false;
  return FUNDOS_PASSIVO_INATIVOS_NOME.some((re) => re.test(key));
}

function isFundoPassivoSempreAtivoPorNome(nome: string | null | undefined): boolean {
  const key = foldingKey(String(nome ?? ""));
  if (!key) return false;
  return FUNDOS_PASSIVO_SEMPRE_ATIVOS_NOME.some((re) => re.test(key));
}

export function isFundoPassivoInativo(opts: {
  nome: string | null | undefined;
  cnpj?: string | null;
  universoMonitorado: Set<string> | null;
}): boolean {
  if (isFundoPassivoInativoPorNome(opts.nome)) return true;
  if (isFundoPassivoSempreAtivoPorNome(opts.nome)) return false;

  const universo = opts.universoMonitorado;
  if (!universo || universo.size === 0) return false;

  const cnpj = cnpjPassivoCanonico(opts.cnpj);
  if (cnpj.length !== 14) return false;

  return !universo.has(cnpj);
}
