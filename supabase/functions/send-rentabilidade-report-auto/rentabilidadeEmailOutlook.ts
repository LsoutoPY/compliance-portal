/**
 * Bloco de fundos faltantes no e-mail — porte Deno de `src/lib/rentabilidadeEmailOutlook.ts`.
 */

import type { FundoXmlCoverageRow } from "./calc.ts";

export function resolveFundoLabel(
  cnpj: string,
  nome: string,
  siglasPorCnpj: Record<string, string>,
): string {
  const key = cnpj.replace(/\D/g, "");
  const sigla = siglasPorCnpj[key]?.trim();
  if (sigla) return sigla;
  const nomeTrim = nome.trim();
  if (nomeTrim) return nomeTrim;
  return cnpj;
}

function escHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildFaltantesEmailBlock(
  faltantes: FundoXmlCoverageRow[],
  siglasPorCnpj: Record<string, string>,
): string {
  if (faltantes.length === 0) return "";

  const faltantesNomes = faltantes
    .map((f) => resolveFundoLabel(f.cnpj_fundo, f.nome_fundo, siglasPorCnpj))
    .filter(Boolean);

  const listaHtml = faltantesNomes.map((n) => escHtml(n)).join(" · ");

  return `<div style="padding:8px 10px;background:#FFF8E6;border:1px solid #F0D878;border-radius:4px;font-size:11px;line-height:1.35;color:#5C4A00;">
    <strong>*${String(faltantes.length).padStart(2, "0")} fundos faltantes (XML)</strong>
    <div style="margin-top:4px;font-size:10px;color:#6B5A20;">${listaHtml}</div>
  </div>`;
}
