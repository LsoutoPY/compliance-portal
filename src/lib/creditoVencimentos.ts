/** Mesmos intervalos exclusivos usados por vw_credito_matriz_visao_geral. */
export const JANELAS_VENCIMENTO = [
  { key: "vp_vence_esta_semana", label: "Esta semana", min: 0, max: 7 },
  { key: "vp_vence_este_mes", label: "Este mês", min: 8, max: 30 },
  { key: "vp_vence_proximo_mes", label: "Próximo mês", min: 31, max: 60 },
  { key: "vp_vence_3_meses", label: "Até 3 meses", min: 61, max: 90 },
  { key: "vp_vence_6_meses", label: "Até 6 meses", min: 91, max: 180 },
  { key: "vp_vence_acima_6_meses", label: "> 6 meses", min: 181, max: null },
] as const;

export type JanelaVencimento = (typeof JANELAS_VENCIMENTO)[number];

export type VencimentoRecebivel = {
  id: string;
  doc_fundo: string;
  nome_fundo: string | null;
  doc_cedente: string | null;
  nome_cedente: string | null;
  nome_sacado: string | null;
  chave_ativo: string | null;
  data_vencimento_base: string;
  valor_base: number;
  valor_nominal: number | null;
};

export const formatValorVencimento = (valor: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(valor);

export type OrdemVencimentos = "vencimento" | "cedente" | "valor";

export function filtrarOrdenarVencimentos(rows: VencimentoRecebivel[], busca: string, ordem: OrdemVencimentos) {
  const normalizar = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
  const termo = normalizar(busca.trim());
  return rows.filter((r) => normalizar([
    r.nome_cedente, r.doc_cedente, r.nome_fundo, r.doc_fundo, r.nome_sacado, r.chave_ativo,
  ].join(" ")).includes(termo)).sort((a, b) => {
    if (ordem === "valor") return b.valor_base - a.valor_base || a.id.localeCompare(b.id);
    if (ordem === "cedente") {
      const cmp = (a.nome_cedente || a.doc_cedente || "").localeCompare(b.nome_cedente || b.doc_cedente || "", "pt-BR");
      if (cmp) return cmp;
    }
    return a.data_vencimento_base.localeCompare(b.data_vencimento_base) || a.id.localeCompare(b.id);
  });
}
