/** Origem do PL utilizado no enquadramento. */
export type PatliqOrigem = "xml" | "csv" | "fidc_header";

export interface PatliqHeaderFields {
  fundo_valorativos?: number | null;
  fundo_valorreceber?: number | null;
  fundo_valorpagar?: number | null;
  fundo_vlcotasresgatar?: number | null;
}

/** Limiar (R$): valorreceber material no header ANBIMA — alinhado ao import-xml. */
export const PL_RECEBER_MIN_DIFF = 50_000;

/** PL pelo header ANBIMA: valorativos + valorreceber − valorpagar − vlcotasresgatar. */
export function calcPlHeaderAnbima(header: PatliqHeaderFields): number {
  const va = Number(header.fundo_valorativos ?? 0) || 0;
  const vr = Number(header.fundo_valorreceber ?? 0) || 0;
  const vp = Number(header.fundo_valorpagar ?? 0) || 0;
  const vlc = Number(header.fundo_vlcotasresgatar ?? 0) || 0;
  if (va <= 0 && vr <= 0) return 0;
  return va + vr - vp - vlc;
}

/**
 * Corrige PL gravado errado na importação (va − vp, sem valorreceber) quando o header
 * ainda traz valorreceber material — típico de FIDC QI LOANS em 06/05–26/05.
 */
export function resolvePlFidcFromHeaderWhenStoredTooLow(
  plHeaderRaw: number,
  header: PatliqHeaderFields,
): number | null {
  const vr = Number(header.fundo_valorreceber ?? 0) || 0;
  const plCalc = calcPlHeaderAnbima(header);
  if (plCalc <= 0) return null;
  const diff = plCalc - plHeaderRaw;
  if (vr > PL_RECEBER_MIN_DIFF && diff > PL_RECEBER_MIN_DIFF && plCalc > plHeaderRaw * 1.05) {
    return plCalc;
  }
  return null;
}

export function isFundoFidcNivel1(nivel1: string | null | undefined): boolean {
  const u = String(nivel1 ?? "")
    .toUpperCase()
    .replace(/\s/g, "");
  return u === "FIDC" || u === "FIDCNP";
}

/** PL FIDC no enquadramento/cessão: valorativos + valorreceber (sem subtrair a pagar). */
export function calcPlFidcHeader(valorativos: number, valorreceber: number): number {
  return valorativos + valorreceber;
}

/**
 * Resolve o PL FIDC a partir dos campos de header.
 * Parâmetro useGuard: quando false, retorna va+vr direto (usado quando pl_formula='va_vr').
 * Quando true, aplica guard para não retornar PL menor que o XML (usado na correção de PL subdimensionado).
 */
export function resolvePlFidcFromHeader(
  header: PatliqHeaderFields,
  baseXml: number = 0,
  useGuard: boolean = true,
): number | null {
  const pl = calcPlFidcHeader(
    Number(header.fundo_valorativos ?? 0) || 0,
    Number(header.fundo_valorreceber ?? 0) || 0,
  );
  if (pl <= 0) return null;
  // Quando pl_formula='va_vr', sempre usa va+vr e ignora fundo_patliq do XML.
  return useGuard ? Math.max(pl, baseXml) : pl;
}

export interface ResolvePatliqInput {
  fundoPatliq: number;
  header: PatliqHeaderFields;
  nivel1Categoria?: string | null;
  nomeFundo?: string | null;
  csvPL?: number;
  /** Legado: quando true, não substitui PL pelo CSV Finvest. */
  patliqSomaFidc?: boolean;
  /**
   * Fórmula de PL para FIDCs (coluna pl_formula de fundos_caracteristicas).
   * 'va_vr' → usa valorativos + valorreceber ao vivo (Nexum JR mode).
   * null/undefined → usa fundo_patliq armazenado (padrão para todos os FIDCs).
   */
  plFormula?: string | null;
}

export interface ResolvePatliqResult {
  totalPL: number;
  /** PL efetivo exibido (FIDC header ou fundo_patliq bruto). */
  xmlPL: number;
  /** fundo_patliq gravado na importação (valorativos − valorpagar − vlcotasresgatar). */
  plHeaderRaw: number;
  plFidc: number | null;
  hasPLDiscrepancy: boolean;
  origem: PatliqOrigem;
}

export function resolvePatliqEnquadramento(input: ResolvePatliqInput): ResolvePatliqResult {
  const plHeaderRaw = input.fundoPatliq || 0;
  const csvPL = input.csvPL || 0;
  const isFidc =
    isFundoFidcNivel1(input.nivel1Categoria) ||
    String(input.nomeFundo ?? "").toUpperCase().includes("FIDC");

  // va+vr ao vivo quando pl_formula = 'va_vr' (modo Nexum JR).
  const usaVaVr = isFidc && input.plFormula === "va_vr";
  const plFidcVaVr = usaVaVr ? resolvePlFidcFromHeader(input.header, plHeaderRaw, true) : null;
  // FIDC sem va_vr: corrige fundo_patliq subdimensionado se o header tem valorreceber material.
  const plFidcCorrigido =
    !usaVaVr && isFidc ? resolvePlFidcFromHeaderWhenStoredTooLow(plHeaderRaw, input.header) : null;
  const plFidc = plFidcVaVr ?? plFidcCorrigido;
  const xmlPL = plFidc ?? plHeaderRaw;
  const skipCsvOverride = Boolean(input.patliqSomaFidc) || plFidc != null;
  const hasPLDiscrepancy = csvPL > 0 && xmlPL !== csvPL && !skipCsvOverride;
  const totalPL = hasPLDiscrepancy ? csvPL : xmlPL;
  const origem: PatliqOrigem = hasPLDiscrepancy ? "csv" : plFidc != null ? "fidc_header" : "xml";

  return { totalPL, xmlPL, plHeaderRaw, plFidc, hasPLDiscrepancy, origem };
}
