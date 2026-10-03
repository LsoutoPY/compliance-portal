/** CPF (11 dígitos) no final do nome: "NOME (185.097.848-41)". */
const CPF_FINAL_RE = /^(.*?)\s*\(\s*(\d{3}\.?\d{3}\.?\d{3}-?\d{2})\s*\)\s*$/;

export type CotistaLgpdPartes = {
  nome: string;
  documento: string | null;
};

export function separarDocumentoCotista(texto: string | null | undefined): CotistaLgpdPartes {
  const raw = String(texto ?? "").trim();
  if (!raw) return { nome: "", documento: null };

  const match = raw.match(CPF_FINAL_RE);
  if (!match) return { nome: raw, documento: null };

  const digits = match[2].replace(/\D/g, "");
  if (digits.length !== 11) return { nome: raw, documento: null };

  return { nome: match[1].trim() || raw, documento: match[2] };
}

export function mascararCpfExibicao(): string {
  return "***.***.***-**";
}

/** Texto seguro para exportação / cópia: nome + CPF mascarado. */
export function textoCotistaLgpd(texto: string | null | undefined): string {
  const { nome, documento } = separarDocumentoCotista(texto);
  if (!documento) return nome || "—";
  return `${nome} (${mascararCpfExibicao()})`;
}
