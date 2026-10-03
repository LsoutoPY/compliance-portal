/** Cruzamento cadastro (origem) × estoque (destino) para propagação entre fundos. */

export interface ParteCadastroOrigem {
  id: string;
  doc_cnpj_cpf: string;
  nome: string | null;
  limite_operacao: number | null;
  dt_validade: string | null;
  dt_analise: string | null;
  escopo_limite: string;
  grupo_chave: string | null;
  consultoria: string | null;
  observacoes: string | null;
  tipo_parte: string;
  status: string;
}

export interface CedenteEstoqueResumo {
  doc_cnpj_cpf: string;
  nome: string | null;
  valor_presente_total: number;
}

export interface LinhaPropagacaoSugerida {
  origem_id: string;
  doc_cnpj_cpf: string;
  nome: string | null;
  limite_operacao: number | null;
  dt_validade: string | null;
  dt_analise: string | null;
  escopo_limite: string;
  grupo_chave: string | null;
  consultoria: string | null;
  observacoes: string | null;
  tipo_parte: string;
  valor_presente_estoque: number;
  selecionada: boolean;
}

export interface LinhaPropagacaoJaCadastrada {
  doc_cnpj_cpf: string;
  nome: string | null;
  valor_presente_estoque: number;
}

export interface ResultadoPropagacaoPreview {
  sugeridas: LinhaPropagacaoSugerida[];
  ja_cadastradas: LinhaPropagacaoJaCadastrada[];
  total_origem: number;
  total_estoque_cedentes: number;
}

export function buildPropagacaoPreview(
  origemPartes: ParteCadastroOrigem[],
  estoqueCedentes: CedenteEstoqueResumo[],
  destinoDocs: Set<string>,
): ResultadoPropagacaoPreview {
  const estoqueMap = new Map<string, CedenteEstoqueResumo>();
  for (const c of estoqueCedentes) {
    if (c.doc_cnpj_cpf) estoqueMap.set(c.doc_cnpj_cpf, c);
  }

  const sugeridas: LinhaPropagacaoSugerida[] = [];
  const ja_cadastradas: LinhaPropagacaoJaCadastrada[] = [];

  for (const p of origemPartes) {
    if (p.status !== "ativo" || p.tipo_parte !== "cedente") continue;
    const est = estoqueMap.get(p.doc_cnpj_cpf);
    if (!est) continue;

    if (destinoDocs.has(p.doc_cnpj_cpf)) {
      ja_cadastradas.push({
        doc_cnpj_cpf: p.doc_cnpj_cpf,
        nome: p.nome,
        valor_presente_estoque: est.valor_presente_total,
      });
      continue;
    }

    sugeridas.push({
      origem_id: p.id,
      doc_cnpj_cpf: p.doc_cnpj_cpf,
      nome: p.nome,
      limite_operacao: p.limite_operacao,
      dt_validade: p.dt_validade,
      dt_analise: p.dt_analise,
      escopo_limite: p.escopo_limite,
      grupo_chave: p.grupo_chave,
      consultoria: p.consultoria,
      observacoes: p.observacoes,
      tipo_parte: p.tipo_parte,
      valor_presente_estoque: est.valor_presente_total,
      selecionada: true,
    });
  }

  sugeridas.sort((a, b) => (a.nome ?? "").localeCompare(b.nome ?? "", "pt-BR"));
  ja_cadastradas.sort((a, b) => (a.nome ?? "").localeCompare(b.nome ?? "", "pt-BR"));

  return {
    sugeridas,
    ja_cadastradas,
    total_origem: origemPartes.length,
    total_estoque_cedentes: estoqueMap.size,
  };
}
