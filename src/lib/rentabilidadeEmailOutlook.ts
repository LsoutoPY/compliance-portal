/**
 * Helpers para abrir rascunho de e-mail de rentabilidade no Outlook.
 */

import type { FundoXmlCoverageRow } from "@/hooks/useRentabilidadeCalc";

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

export function buildRentabilidadeEmailIntro(
  dataFormatada: string,
  faltantes: FundoXmlCoverageRow[],
  siglasPorCnpj: Record<string, string>,
): { plainIntro: string; htmlIntro: string } {
  const temFaltantes = faltantes.length > 0;
  const faltantesNomes = faltantes
    .map((f) => resolveFundoLabel(f.cnpj_fundo, f.nome_fundo, siglasPorCnpj))
    .filter(Boolean)
    .join(", ");

  const corpoPrincipal = `Segue rentabilidade dos fundos com referência em ${dataFormatada}.`;

  const faltantesLine = temFaltantes
    ? `\n\n*${String(faltantes.length).padStart(2, "0")} fundos faltantes (${faltantesNomes})`
    : "";

  const plainIntro =
    `Prezados,\n\n` +
    `${corpoPrincipal}${faltantesLine}\n\n` +
    `Enviado automaticamente`;

  const faltantesHtml = temFaltantes
    ? `<p style="font-family:Calibri,Arial,sans-serif;font-size:11px;margin:0 0 8px 0;"><strong>*${String(faltantes.length).padStart(2, "0")} fundos faltantes</strong> (${escHtml(faltantesNomes)})</p>`
    : "";

  const htmlIntro =
    `<p style="font-family:Calibri,Arial,sans-serif;font-size:11px;margin:0 0 8px 0;">Prezados,</p>` +
    `<p style="font-family:Calibri,Arial,sans-serif;font-size:11px;margin:0 0 8px 0;">${escHtml(corpoPrincipal)}</p>` +
    faltantesHtml +
    `<p style="font-family:Calibri,Arial,sans-serif;font-size:11px;margin:0 0 12px 0;">Enviado automaticamente</p>`;

  return { plainIntro, htmlIntro };
}

function escHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildRentabilidadeEmailClipboardContent(
  htmlIntro: string,
  tableHtml: string,
  plainIntro: string,
  tablePlain: string,
): { html: string; plainText: string; tableOnlyHtml: string; tableOnlyPlain: string } {
  return {
    html: `<div style="font-family:Calibri,Arial,sans-serif;font-size:11px;">${htmlIntro}${tableHtml}</div>`,
    plainText: `${plainIntro}\n\n${tablePlain}`,
    tableOnlyHtml: tableHtml,
    tableOnlyPlain: tablePlain,
  };
}

function copyViaHiddenElement(html: string, plainText: string): boolean {
  if (typeof document === "undefined") return false;

  window.focus();

  const container = document.createElement("div");
  container.contentEditable = "true";
  container.innerHTML = html;
  container.setAttribute("aria-hidden", "true");
  Object.assign(container.style, {
    position: "fixed",
    left: "-9999px",
    top: "0",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.appendChild(container);

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(container);
  selection?.removeAllRanges();
  selection?.addRange(range);

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }

  selection?.removeAllRanges();
  document.body.removeChild(container);

  if (ok) return true;

  const textarea = document.createElement("textarea");
  textarea.value = plainText;
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    position: "fixed",
    left: "-9999px",
    top: "0",
  });
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

/** Copia tabela para colar no Outlook. Falha silenciosa se a aba perdeu foco. */
export async function copyRentabilidadeEmailToClipboard(
  html: string,
  plainText: string,
): Promise<boolean> {
  if (typeof window !== "undefined") {
    window.focus();
  }

  const htmlForClipboard = `<html><body><!--StartFragment-->${html}<!--EndFragment--></body></html>`;

  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([htmlForClipboard], { type: "text/html" }),
          "text/plain": new Blob([plainText], { type: "text/plain" }),
        }),
      ]);
      return true;
    }

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(plainText);
      return true;
    }
  } catch {
    // Clipboard API bloqueada (Document is not focused) — tenta fallback abaixo
  }

  return copyViaHiddenElement(html, plainText);
}

export function openRentabilidadeEmailDraft(
  dataFormatada: string,
  plainIntro: string,
): void {
  const assunto = encodeURIComponent(`Rentabilidade dos fundos - ${dataFormatada}`);
  const corpo = encodeURIComponent(plainIntro);
  window.location.href = `mailto:?subject=${assunto}&body=${corpo}`;
}
