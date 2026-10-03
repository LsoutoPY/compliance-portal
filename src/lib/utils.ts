import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Detecta se um fundo é fechado a partir do campo `aberto_estatutariamente`.
 * Aceita os formatos: "Fechado", "Aberto", boolean, "S"/"N", null/undefined.
 */
export function isFundoFechado(aberto_estatutariamente: unknown): boolean {
  if (aberto_estatutariamente === null || aberto_estatutariamente === undefined) return false;
  if (aberto_estatutariamente === false) return true;
  if (aberto_estatutariamente === true) return false;
  const str = String(aberto_estatutariamente).trim().toLowerCase();
  if (str === 'fechado') return true;
  if (str === 'n') return true;
  return false;
}

/** FIDC NEXUM SR — classe excluída das notificações de liquidez (cálculo consolidado por CNPJ na JR). */
export function isFidcNexumSenior(nome: string | null | undefined): boolean {
  return /\bFIDC\s+NEXUM\s+SR\b/i.test(nome ?? "");
}

export function isFidcNexumJunior(nome: string | null | undefined): boolean {
  return /\bFIDC\s+NEXUM\s+JR\b/i.test(nome ?? "");
}

/** Alertas de liquidez por e-mail usam o resultado consolidado por CNPJ — apenas a JR dispara notificação. */
export function liquidezNotificacaoHabilitada(nomeFundo: string | null | undefined): boolean {
  return !isFidcNexumSenior(nomeFundo);
}
