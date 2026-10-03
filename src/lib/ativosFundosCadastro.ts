import { supabase } from "@/integrations/supabase/client";

export type FundoCadastro = {
  id: string;
  estrutura: string | null;
  cnpj_classe: string | null;
  cnpj_fundo: string | null;
  isin: string | null;
  nome_comercial: string | null;
  nivel1_categoria: string | null;
  caracteristica_investidor: string | null;
  prazo_pagamento_resgate_dias: number | null;
  aberto_estatutariamente: string | null;
};

type RegistroCvm = {
  cnpj: string | null;
  tipo_registro: string;
  denominacao_social: string | null;
  nome_comercial: string | null;
  publico_alvo: string | null;
  condominio: string | null;
};

export type CadastroAtivo = {
  caracteristica: FundoCadastro | null;
  nome: string | null;
  condominio: string | null;
  publicoAlvo: string | null;
  fonte: "ANBIMA · ISIN" | "ANBIMA · CNPJ da classe" | "ANBIMA · CNPJ do fundo" | "CVM · classe" | "CVM · fundo" | null;
};

const cleanCnpj = (value: string | null | undefined) => (value || "").replace(/\D/g, "");
const cleanIsin = (value: string | null | undefined) => {
  const isin = (value || "").trim().toUpperCase();
  return isin.length === 12 && !isin.includes("*") ? isin : "";
};

function uniqueValue(values: Array<string | null | undefined>): string | null {
  const present = [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
  return present.length === 1 ? present[0] : null;
}

function pickClass(rows: FundoCadastro[]): FundoCadastro | null {
  const classes = rows.filter((row) => (row.estrutura || "").toLowerCase() === "classe");
  if (classes.length === 1) return classes[0];
  if (classes.length > 1) return null;
  const fundos = rows.filter((row) => (row.estrutura || "").toLowerCase() === "fundo");
  if (fundos.length === 1) return fundos[0];
  return rows.length === 1 ? rows[0] : null;
}

export function resolveCadastroAtivo(
  ativo: { cnpj: string | null; isin: string | null },
  caracteristicas: FundoCadastro[],
  registros: RegistroCvm[],
): CadastroAtivo {
  const cnpj = cleanCnpj(ativo.cnpj);
  const isin = cleanIsin(ativo.isin);
  const byIsin = isin
    ? caracteristicas.filter((row) => cleanIsin(row.isin) === isin
      && (!cnpj || cleanCnpj(row.cnpj_classe) === cnpj || cleanCnpj(row.cnpj_fundo) === cnpj))
    : [];
  const byClasse = cnpj ? caracteristicas.filter((row) => cleanCnpj(row.cnpj_classe) === cnpj) : [];
  const byFundo = cnpj ? caracteristicas.filter((row) => cleanCnpj(row.cnpj_fundo) === cnpj) : [];

  let caracteristica: FundoCadastro | null = null;
  let fonte: CadastroAtivo["fonte"] = null;
  if (byIsin.length === 1) {
    caracteristica = byIsin[0];
    fonte = "ANBIMA · ISIN";
  } else if (byClasse.length > 0) {
    caracteristica = pickClass(byClasse);
    if (caracteristica) fonte = "ANBIMA · CNPJ da classe";
  } else if (byFundo.length > 0) {
    caracteristica = pickClass(byFundo);
    if (caracteristica) fonte = "ANBIMA · CNPJ do fundo";
  }

  const registrosCnpj = cnpj ? registros.filter((row) => cleanCnpj(row.cnpj) === cnpj) : [];
  const classeCvm = registrosCnpj.find((row) => row.tipo_registro === "classe") || null;
  const fundoCvm = registrosCnpj.find((row) => row.tipo_registro === "fundo") || null;
  const cvm = classeCvm || fundoCvm;
  const publicoSubclasses = uniqueValue(
    registrosCnpj.filter((row) => row.tipo_registro === "subclasse").map((row) => row.publico_alvo),
  );
  const condominioSubclasses = uniqueValue(
    registrosCnpj.filter((row) => row.tipo_registro === "subclasse").map((row) => row.condominio),
  );

  if (!fonte && cvm) fonte = classeCvm ? "CVM · classe" : "CVM · fundo";

  return {
    caracteristica,
    nome: caracteristica?.nome_comercial || cvm?.nome_comercial || cvm?.denominacao_social || null,
    condominio: caracteristica?.aberto_estatutariamente || classeCvm?.condominio || fundoCvm?.condominio || condominioSubclasses,
    publicoAlvo: classeCvm?.publico_alvo || publicoSubclasses || caracteristica?.caracteristica_investidor || fundoCvm?.publico_alvo || null,
    fonte,
  };
}

export async function fetchCadastrosAtivos(ativos: Array<{ tipo_ativo: string; cnpj: string | null; isin: string | null }>) {
  const fundos = ativos.filter((ativo) => ativo.tipo_ativo === "FUNDO" || ativo.tipo_ativo === "FIDC");
  const cnpjs = [...new Set(fundos.map((ativo) => cleanCnpj(ativo.cnpj)).filter((cnpj) => cnpj.length === 14))];
  const isins = [...new Set(fundos.map((ativo) => cleanIsin(ativo.isin)).filter(Boolean))];
  if (cnpjs.length === 0 && isins.length === 0) return { caracteristicas: [] as FundoCadastro[], registros: [] as RegistroCvm[] };

  const columns = "id, estrutura, cnpj_classe, cnpj_fundo, isin, nome_comercial, nivel1_categoria, caracteristica_investidor, prazo_pagamento_resgate_dias, aberto_estatutariamente";
  const [porClasse, porFundo, porIsin, cvm] = await Promise.all([
    cnpjs.length ? supabase.from("fundos_caracteristicas" as any).select(columns).in("cnpj_classe", cnpjs) : Promise.resolve({ data: [], error: null }),
    cnpjs.length ? supabase.from("fundos_caracteristicas" as any).select(columns).in("cnpj_fundo", cnpjs) : Promise.resolve({ data: [], error: null }),
    isins.length ? supabase.from("fundos_caracteristicas" as any).select(columns).in("isin", isins) : Promise.resolve({ data: [], error: null }),
    cnpjs.length ? supabase.from("fund_master" as any).select("cnpj, tipo_registro, denominacao_social, nome_comercial, publico_alvo, condominio").in("cnpj", cnpjs) : Promise.resolve({ data: [], error: null }),
  ]);

  for (const result of [porClasse, porFundo, porIsin, cvm]) {
    if (result.error) throw result.error;
  }

  const byId = new Map<string, FundoCadastro>();
  for (const row of [...(porClasse.data || []), ...(porFundo.data || []), ...(porIsin.data || [])] as FundoCadastro[]) {
    byId.set(row.id, row);
  }

  return { caracteristicas: [...byId.values()], registros: (cvm.data || []) as RegistroCvm[] };
}
