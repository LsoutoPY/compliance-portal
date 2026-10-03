/**
 * Resolução de grupo visual por nó — cor do nó no mapa.
 *
 * Ordem de resolução (afeta só cor de preenchimento/borda do nó):
 *   1. CNPJ gestor ou admin na tabela mapa_fundos_grupos → A/B/C/H/R
 *   2. Nome contém CVPAR e fundo NÃO monitorado → CVPAR
 *   3. Fundo monitorado (gestores_monitorados) → CASA
 *   4. Qualquer outro → EXT (cor neutra)
 *
 * Subordinação de tranches NÃO entra aqui — ver isTrancheSubordinada.
 */

import { supabase } from "@/integrations/supabase/client";
import { normalizeCnpjDigits } from "@/lib/fundosMonitorados";

export type GrupoNo = "A" | "B" | "C" | "H" | "R" | "CVPAR" | "CASA" | "EXT";

export interface GrupoConfig {
  cnpj: string;
  tipo: "gestor" | "admin";
  grupo: string;
}

export const GRUPO_LABEL: Record<GrupoNo, string> = {
  A: "Quadrante A",
  B: "Quadrante B",
  C: "Quadrante C",
  H: "Hieron",
  R: "REAG / Arandu",
  CVPAR: "CVPAR (externo)",
  CASA: "Monitorado",
  EXT: "Externo",
};

/** Paleta única de cor de nó — rede e organograma. */
export const GRUPO_COR: Record<GrupoNo, string> = {
  A: "#2563EB",
  B: "#0EA5E9",
  C: "#7C3AED",
  H: "#6B7280",
  R: "#D97706",
  CVPAR: "#F472B6",
  CASA: "#6366f1",
  EXT: "#475569",
};

export async function fetchGruposConfig(): Promise<GrupoConfig[]> {
  const { data, error } = await (supabase as any)
    .from("mapa_fundos_grupos")
    .select("cnpj, tipo, grupo")
    .eq("ativo", true);
  if (error) {
    // Tabela ainda não migrada — fail-open, mapa funciona com EXT/CASA
    console.warn("[fetchGruposConfig]", error.message);
    return [];
  }
  return (data ?? []) as GrupoConfig[];
}

/**
 * Constrói um Map CNPJ→GrupoNo a partir da lista de configs.
 *
 * Regra de prioridade: gestor > admin para o mesmo CNPJ.
 *
 * Nota sobre B/C (ou qualquer A/B/C) com mesmo CNPJ de gestora:
 *   Na prática, fundos B e C são geridos por CNPJs distintos (entidades legais separadas).
 *   Se dois grupos compartilhassem exatamente o mesmo CNPJ gestor, a tabela
 *   mapa_fundos_grupos rejeita o segundo INSERT pelo unique (cnpj, tipo) — erro explícito,
 *   não comportamento silencioso. Nesse caso, cadastrar o segundo grupo via tipo='admin'
 *   (CNPJ do administrador) é a saída correta.
 */
export function buildGrupoMap(configs: GrupoConfig[]): Map<string, GrupoNo> {
  const map = new Map<string, GrupoNo>();
  for (const c of configs) {
    const cnpj = normalizeCnpjDigits(c.cnpj);
    if (!cnpj) continue;
    if (!map.has(cnpj) || c.tipo === "gestor") {
      map.set(cnpj, c.grupo as GrupoNo);
    }
  }
  return map;
}

/**
 * Resolve o grupo visual de um nó.
 * Parâmetros:
 *   cnpjGestor  — fundo_cnpjgestor do XML
 *   cnpjAdm     — fundo_cnpjadm do XML
 *   nomeFundo   — nome do fundo
 *   cnpjFundo   — CNPJ do fundo (para checar monitorados)
 *   grupoMap    — pré-construído com buildGrupoMap
 *   monitoredCnpjs — set de CNPJs (14 dígitos) de fundos monitorados
 */
export function resolveGrupoNo(
  cnpjGestor: string | null | undefined,
  cnpjAdm: string | null | undefined,
  nomeFundo: string,
  cnpjFundo: string,
  grupoMap: Map<string, GrupoNo>,
  monitoredCnpjs: Set<string>,
): GrupoNo {
  const g = normalizeCnpjDigits(cnpjGestor);
  if (g && grupoMap.has(g)) return grupoMap.get(g)!;

  const a = normalizeCnpjDigits(cnpjAdm);
  if (a && grupoMap.has(a)) return grupoMap.get(a)!;

  if (/CVPAR/i.test(nomeFundo) && !monitoredCnpjs.has(normalizeCnpjDigits(cnpjFundo))) {
    return "CVPAR";
  }

  if (monitoredCnpjs.has(normalizeCnpjDigits(cnpjFundo))) return "CASA";

  return "EXT";
}
