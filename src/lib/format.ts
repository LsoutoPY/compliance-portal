export function fmtBRL(v: number | null | undefined): string {
  if (v === undefined || v === null) return "—";
  return v.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  });
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v === undefined || v === null) return "—";
  return (
    (v * 100).toLocaleString("pt-BR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }) + "%"
  );
}

/** No mockup, valores ≥ 8 dígitos (sem "R$") viram compacto em milhões. */
export function fmtCompactBRL(v: number | null | undefined): string {
  if (v === undefined || v === null) return "—";
  const full = fmtBRL(v);
  const stripped = full.replace("R$", "").trim();
  if (stripped.length > 7) return (v / 1e6).toFixed(1) + "M";
  return full;
}

/**
 * O JSON do mockup capturou a linha de % da planilha nesses dois campos
 * (valores entre 0 e 1). O import real grava o valor absoluto em R$.
 */
export function fmtAlocacao(v: number | null | undefined): string {
  if (v === undefined || v === null) return "—";
  if (Math.abs(v) <= 1) return fmtPct(v, 2);
  return fmtBRL(v);
}
