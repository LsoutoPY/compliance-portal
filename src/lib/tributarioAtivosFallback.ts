import { supabase } from "@/integrations/supabase/client";

export interface TributarioAtivoDisplay {
  nome: string;
  cnpj: string | null;
  valor: number;
  percentual: number;
  tipo: string;
  motivo?: string;
}

function cnpjVariants(cnpj: string): string[] {
  const clean = cnpj.replace(/\D/g, "").padStart(14, "0");
  const formatted = clean.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    "$1.$2.$3/$4-$5",
  );
  return [...new Set([cnpj, clean, formatted])].filter(Boolean);
}

function dtPosicaoVariants(raw: string): string[] {
  const ymd = raw.replace(/\D/g, "").slice(0, 8);
  const set = new Set<string>([raw, ymd]);
  if (ymd.length === 8) {
    set.add(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`);
    set.add(`${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}`);
  }
  return [...set].filter(Boolean);
}

function formatCnpj(c14: string): string {
  return c14.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

/** Reconstrói lista de ativos a partir da posição + cache de classificação LP/CP. */
export async function fetchTributarioAtivosFallback(
  fundoCnpj: string,
  fundoDtposicao: string,
  dataReferenciaIso: string,
): Promise<TributarioAtivoDisplay[]> {
  const cnpjVars = cnpjVariants(fundoCnpj);
  const dtVars = dtPosicaoVariants(fundoDtposicao);

  const { data: posicoes, error: posError } = await supabase
    .from("posicao_carteira" as any)
    .select("valor_padrao, cnpjfundo, cnpjemissor, nomecomercial, section, fundo_patliq")
    .in("fundo_cnpj", cnpjVars)
    .in("fundo_dtposicao", dtVars);

  if (posError) throw posError;

  const cotaRows = (posicoes ?? []).filter(
    (r: { section?: string | null }) =>
      String(r.section ?? "").toLowerCase().trim() === "cotas",
  );

  if (cotaRows.length === 0) return [];

  const totalPL =
    Number(cotaRows[0]?.fundo_patliq ?? 0) ||
    cotaRows.reduce((s: number, r: { valor_padrao?: number | null }) => s + (Number(r.valor_padrao) || 0), 0);

  const cnpjsInvestidos = new Set<string>();
  for (const row of cotaRows) {
    const raw = row.cnpjfundo || row.cnpjemissor;
    if (!raw) continue;
    cnpjsInvestidos.add(String(raw).replace(/\D/g, "").padStart(14, "0"));
  }

  const cnpjArr = [...cnpjsInvestidos];
  const classMap = new Map<string, { classificacao: string; motivo: string | null }>();

  if (cnpjArr.length > 0 && dataReferenciaIso) {
    const classCnpjVars = cnpjArr.flatMap((c) => cnpjVariants(c));
    const { data: classifs } = await supabase
      .from("fundo_classificacao_tributaria" as any)
      .select("fundo_cnpj, classificacao, motivo")
      .eq("data_referencia", dataReferenciaIso)
      .in("fundo_cnpj", classCnpjVars);

    for (const c of classifs ?? []) {
      const key = String(c.fundo_cnpj).replace(/\D/g, "").padStart(14, "0");
      classMap.set(key, {
        classificacao: String(c.classificacao ?? "cp"),
        motivo: c.motivo ?? null,
      });
    }
  }

  const charMap = new Map<string, { nome: string | null; tributacao_alvo: string | null }>();
  if (cnpjArr.length > 0) {
    const charCnpjVars = cnpjArr.flatMap((c) => cnpjVariants(c));
    const [{ data: byClasse }, { data: byFundo }] = await Promise.all([
      supabase
        .from("fundos_caracteristicas" as any)
        .select("cnpj_classe, cnpj_fundo, nome_comercial, tributacao_alvo")
        .in("cnpj_classe", charCnpjVars),
      supabase
        .from("fundos_caracteristicas" as any)
        .select("cnpj_classe, cnpj_fundo, nome_comercial, tributacao_alvo")
        .in("cnpj_fundo", charCnpjVars),
    ]);

    for (const c of [...(byClasse ?? []), ...(byFundo ?? [])]) {
      const entry = {
        nome: c.nome_comercial ?? null,
        tributacao_alvo: c.tributacao_alvo ?? null,
      };
      for (const key of [
        String(c.cnpj_classe ?? "").replace(/\D/g, "").padStart(14, "0"),
        String(c.cnpj_fundo ?? "").replace(/\D/g, "").padStart(14, "0"),
      ]) {
        if (key && key !== "00000000000000" && !charMap.has(key)) {
          charMap.set(key, entry);
        }
      }
    }
  }

  const ativos: TributarioAtivoDisplay[] = [];

  for (const row of cotaRows) {
    const valor = Number(row.valor_padrao ?? 0) || 0;
    if (valor === 0) continue;

    const cnpjRaw = row.cnpjfundo || row.cnpjemissor;
    const cnpj14 = cnpjRaw
      ? String(cnpjRaw).replace(/\D/g, "").padStart(14, "0")
      : "";

    const classif = cnpj14 ? classMap.get(cnpj14) : undefined;
    const char = cnpj14 ? charMap.get(cnpj14) : undefined;

    let tipo = classif?.classificacao ?? "cp";
    if (!classif && char?.tributacao_alvo) {
      const ta = String(char.tributacao_alvo).toLowerCase();
      if (ta.includes("lp")) tipo = "lp";
      else if (ta.includes("cp")) tipo = "cp";
      else if (ta.includes("exclu")) tipo = "excluido";
    }

    const nomeBase =
      char?.nome?.trim() ||
      String(row.nomecomercial ?? "").trim() ||
      (cnpj14 ? formatCnpj(cnpj14) : "Fundo investido");

    ativos.push({
      nome: `[${tipo.toUpperCase()}] ${nomeBase}`,
      cnpj: cnpj14 || null,
      valor,
      percentual: totalPL > 0 ? valor / totalPL : 0,
      tipo,
      motivo:
        classif?.motivo ??
        (classif ? undefined : "Classificação estimada — rode a verificação para detalhamento oficial"),
    });
  }

  return ativos.sort((a, b) => b.valor - a.valor);
}
