/** Catálogo fixo — regras tributárias IN RFB 1585 (Art. 4º e 5º). */

export const TRIB_CODIGO_FIM = "TRIB_FIM_LP_365";
export const TRIB_CODIGO_FIDC = "TRIB_FIDC_LP_365";
export const TRIB_CODIGO_FIQ = "TRIB_FIQ_LP_90";

export const TRIB_CODIGOS = [TRIB_CODIGO_FIM, TRIB_CODIGO_FIDC, TRIB_CODIGO_FIQ] as const;

/** Padrão regulatório Art. 4º §5º VIII — FII fora do numerador LP. */
export const TRIB_TIPOS_EXCLUIDOS_PADRAO = ["FII"] as const;

export type TipoRegraTributaria = "tributario_prazo_medio_art4" | "tributario_fiq_art5";
export type VarianteArt4 = "fim" | "fidc";

export function isTipoRegraTributaria(tipo: string): tipo is TipoRegraTributaria {
  return tipo === "tributario_prazo_medio_art4" || tipo === "tributario_fiq_art5";
}

export function codigoFromTributario(
  tipo: TipoRegraTributaria,
  varianteArt4: VarianteArt4 = "fim",
): string {
  if (tipo === "tributario_fiq_art5") return TRIB_CODIGO_FIQ;
  return varianteArt4 === "fidc" ? TRIB_CODIGO_FIDC : TRIB_CODIGO_FIM;
}

export function tipoFromCodigoTributario(codigo: string): TipoRegraTributaria | null {
  if (codigo === TRIB_CODIGO_FIQ) return "tributario_fiq_art5";
  if (codigo === TRIB_CODIGO_FIM || codigo === TRIB_CODIGO_FIDC) return "tributario_prazo_medio_art4";
  return null;
}

export function varianteArt4FromCodigo(codigo: string): VarianteArt4 {
  return codigo === TRIB_CODIGO_FIDC ? "fidc" : "fim";
}

export type ParametrosTributarioArt4 = {
  tipo_regra: "tributario_prazo_medio_art4";
  norma: string;
  variante: VarianteArt4;
  limite_dias: number;
  alerta_dias: number;
  prazo_cota_lp: number;
  prazo_cota_cp: number;
};

export type ParametrosTributarioArt5 = {
  tipo_regra: "tributario_fiq_art5";
  norma: string;
  limite_mm: number;
  alerta_mm: number;
  janela_dias_uteis: number;
  max_eventos_ano: number;
  max_dias_violacao_ano: number;
  /** Marcado = PL − excluídos (carteira elegível); desmarcado = PL total do XML. */
  denominador_carteira_elegivel: boolean;
  /** Categorias ANBIMA (nivel1) das cotas investidas que não contam como LP. */
  tipos_excluidos_denominador: string[];
};

export function buildParametrosTributarioArt4(
  variante: VarianteArt4,
  limiteDias = 365,
  alertaDias = 367,
): ParametrosTributarioArt4 {
  return {
    tipo_regra: "tributario_prazo_medio_art4",
    norma: "IN RFB 1585/2015 Art. 4º",
    variante,
    limite_dias: limiteDias,
    alerta_dias: alertaDias,
    prazo_cota_lp: 366,
    prazo_cota_cp: 1,
  };
}

/** Lista para o formulário (preserva [] explícito). */
export function parseTiposExcluidosParam(
  p: Record<string, unknown> | null | undefined,
): string[] {
  const arr = p?.tipos_excluidos_denominador ?? p?.tipos_excluidos;
  if (Array.isArray(arr)) {
    return arr.map((t) => String(t).trim()).filter(Boolean);
  }
  return [...TRIB_TIPOS_EXCLUIDOS_PADRAO];
}

/** Lista para o motor quando parâmetro ausente (legado). */
export function tiposExcluidosParaCalculo(
  p: Record<string, unknown> | null | undefined,
): string[] {
  const arr = p?.tipos_excluidos_denominador ?? p?.tipos_excluidos;
  if (!Array.isArray(arr)) return [...TRIB_TIPOS_EXCLUIDOS_PADRAO];
  return arr.map((t) => String(t).trim()).filter(Boolean);
}

export function buildParametrosTributarioArt5(
  denominadorCarteiraElegivel: boolean,
  tiposExcluidos: string[],
  limiteMm = 90,
  alertaMm = 92,
): ParametrosTributarioArt5 {
  const tipos = tiposExcluidos.length > 0 ? tiposExcluidos : [...TRIB_TIPOS_EXCLUIDOS_PADRAO];
  return {
    tipo_regra: "tributario_fiq_art5",
    norma: "IN RFB 1585/2015 Art. 5º",
    limite_mm: limiteMm,
    alerta_mm: alertaMm,
    janela_dias_uteis: 10,
    max_eventos_ano: 3,
    max_dias_violacao_ano: 45,
    denominador_carteira_elegivel: denominadorCarteiraElegivel,
    tipos_excluidos_denominador: tipos,
  };
}

export function buildDescricaoTributario(
  tipo: TipoRegraTributaria,
  variante: VarianteArt4,
  limiteDias = 365,
  limiteMm = 90,
  denominadorCarteiraElegivel = false,
  tiposExcluidos: string[] = [...TRIB_TIPOS_EXCLUIDOS_PADRAO],
): string {
  if (tipo === "tributario_fiq_art5") {
    const base = denominadorCarteiraElegivel
      ? "PL sem tipos excluídos"
      : "PL total do fundo";
    const excl = tiposExcluidos.length > 0 ? tiposExcluidos.join(", ") : "FII";
    return `FIQ: mínimo ${limiteMm}% MM-10d em LP — excluídos: ${excl}; ${base} (IN RFB 1585 Art. 5º)`;
  }
  if (variante === "fidc") {
    return `FIDC: prazo médio tributário > ${limiteDias} dias (IN RFB 1585/2015 Art. 4º — estoque)`;
  }
  return `FIM: prazo médio tributário > ${limiteDias} dias (IN RFB 1585/2015 Art. 4º)`;
}

/** Categoria do orquestrador / enquadramento_resultado a partir do catálogo. */
export function categoriaEnquadramentoFromRegra(
  codigo: string,
  parametros?: Record<string, unknown> | null,
): string | null {
  const p = parametros ?? {};
  if (p.tipo_regra === "tributario_fiq_art5") return "tributario";
  if (p.tipo_regra === "fidc_subordinacao") return "fidc-estrutura";
  if (p.tipo_regra === "tributario_prazo_medio_art4") {
    return p.variante === "fidc" ? "tributario-art4-fidc" : "tributario-art4";
  }
  if (codigo === TRIB_CODIGO_FIQ) return "tributario";
  if (codigo === TRIB_CODIGO_FIDC) return "tributario-art4-fidc";
  if (codigo === TRIB_CODIGO_FIM) return "tributario-art4";
  return null;
}

export function hydrateTributarioFromParametros(
  codigo: string,
  p: Record<string, unknown> | null | undefined,
): {
  tipo: TipoRegraTributaria;
  varianteArt4: VarianteArt4;
  limiteDias: number;
  alertaDias: number;
  limiteMm: number;
  alertaMm: number;
  denominadorCarteiraElegivel: boolean;
  tiposExcluidos: string[];
} {
  const tipo =
    (p?.tipo_regra as TipoRegraTributaria | undefined) ??
    tipoFromCodigoTributario(codigo) ??
    "tributario_prazo_medio_art4";
  return {
    tipo,
    varianteArt4:
      (p?.variante as VarianteArt4 | undefined) ?? varianteArt4FromCodigo(codigo),
    limiteDias: Number(p?.limite_dias ?? 365),
    alertaDias: Number(p?.alerta_dias ?? 367),
    limiteMm: Number(p?.limite_mm ?? 90),
    alertaMm: Number(p?.alerta_mm ?? 92),
    denominadorCarteiraElegivel: p?.denominador_carteira_elegivel === true,
    tiposExcluidos: parseTiposExcluidosParam(p ?? undefined),
  };
}
