/** Lógica pura do motor de cadastro de partes — testável no Vitest. */

import {
  type CadastroParteRow,
  type CadastroPartesParams,
  type PoliticaCadastro,
  hydrateCadastroPartesParams,
  isCadastroVencido,
  formatBRL,
  cleanDoc,
} from "./cadastroPartes";

export type SeveridadeMotivo = "vedacao" | "alerta";

export interface MotivoCadastro {
  regra_codigo: string;
  regra_descricao: string;
  valor_atual: string | number | null;
  valor_limite: string | number | null;
  severidade?: SeveridadeMotivo;
}

export interface CadastroIndex {
  byDoc: Map<string, CadastroParteRow>;
  byGrupoChave: Map<string, CadastroParteRow[]>;
}

export function buildCadastroIndex(rows: CadastroParteRow[]): CadastroIndex {
  const byDoc = new Map<string, CadastroParteRow>();
  const byGrupoChave = new Map<string, CadastroParteRow[]>();

  for (const row of rows) {
    byDoc.set(row.doc_cnpj_cpf, row);
    if (row.escopo_limite === "grupo" && row.grupo_chave) {
      const list = byGrupoChave.get(row.grupo_chave) ?? [];
      list.push(row);
      byGrupoChave.set(row.grupo_chave, list);
    }
  }
  return { byDoc, byGrupoChave };
}

function applyPolitica(
  politica: PoliticaCadastro,
  codigo: string,
  descricao: string,
  valorAtual: string,
  valorLimite: string,
): MotivoCadastro {
  return {
    regra_codigo: codigo,
    regra_descricao: descricao,
    valor_atual: valorAtual,
    valor_limite: valorLimite,
    severidade: politica === "alertar" ? "alerta" : "vedacao",
  };
}

/** Com coobrigação do cedente, o cadastro do sacado não entra na elegibilidade. */
export function deveVerificarCadastroSacado(verificarSacado: boolean, temCoobrigacao: boolean): boolean {
  return verificarSacado && !temCoobrigacao;
}

export function evaluateCadastroParte(
  doc: string,
  nome: string,
  tipo: "cedente" | "sacado",
  dataCessao: string,
  index: CadastroIndex,
  params: CadastroPartesParams,
): MotivoCadastro[] {
  const motivos: MotivoCadastro[] = [];
  const cadastro = index.byDoc.get(doc);

  if (!cadastro) {
    motivos.push(
      applyPolitica(
        params.politica_nao_cadastrado,
        "CADASTRO_PARTE_INEXISTENTE",
        `${tipo === "cedente" ? "Cedente" : "Sacado"} não cadastrado`,
        nome || doc || "—",
        "cadastro obrigatório",
      ),
    );
    return motivos;
  }

  if (cadastro.status === "suspenso" || cadastro.status === "encerrado") {
    motivos.push({
      regra_codigo: "CADASTRO_PARTE_SUSPENSO",
      regra_descricao: `${tipo === "cedente" ? "Cedente" : "Sacado"} com cadastro ${cadastro.status}`,
      valor_atual: cadastro.status,
      valor_limite: "ativo",
      severidade: "vedacao",
    });
    return motivos;
  }

  if (!cadastro.dt_validade) {
    motivos.push(
      applyPolitica(
        params.politica_revisao_pendente,
        "CADASTRO_REVISAO_PENDENTE",
        "Revisão de cadastro pendente",
        nome || doc,
        "data de validade obrigatória",
      ),
    );
  } else if (isCadastroVencido(dataCessao, cadastro.dt_validade, params.validade_inclusiva)) {
    motivos.push(
      applyPolitica(
        params.politica_cadastro_vencido,
        "CADASTRO_PARTE_VENCIDO",
        "Cadastro vencido",
        dataCessao,
        cadastro.dt_validade,
      ),
    );
  }

  return motivos;
}

export function hasVeto(motivos: MotivoCadastro[]): boolean {
  return motivos.some((m) => m.severidade !== "alerta");
}

export function resolveLimiteGrupo(rows: CadastroParteRow[]): {
  limite: number | null;
  divergente: boolean;
} {
  const limites = rows
    .map((r) => r.limite_operacao)
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (limites.length === 0) return { limite: null, divergente: false };
  const min = Math.min(...limites);
  const max = Math.max(...limites);
  return { limite: min, divergente: min !== max };
}

export interface LimiteComiteContext {
  estoqueByDoc: Map<string, number>;
  proposedByDoc: Map<string, number>;
  recompraByDoc: Map<string, number>;
  estoqueByGrupoChave: Map<string, number>;
  proposedByGrupoChave: Map<string, number>;
  recompraByGrupoChave: Map<string, number>;
}

export function exposicaoProforma(estoque: number, proposta: number, recompra: number): number {
  return Math.max(0, estoque + proposta - recompra);
}

export function getExposicaoParaCadastro(
  cadastro: CadastroParteRow,
  ctx: LimiteComiteContext,
): number {
  if (cadastro.escopo_limite === "grupo" && cadastro.grupo_chave) {
    const chave = cadastro.grupo_chave;
    return exposicaoProforma(
      ctx.estoqueByGrupoChave.get(chave) ?? 0,
      ctx.proposedByGrupoChave.get(chave) ?? 0,
      ctx.recompraByGrupoChave.get(chave) ?? 0,
    );
  }
  const doc = cadastro.doc_cnpj_cpf;
  return exposicaoProforma(
    ctx.estoqueByDoc.get(doc) ?? 0,
    ctx.proposedByDoc.get(doc) ?? 0,
    ctx.recompraByDoc.get(doc) ?? 0,
  );
}

export interface LimiteComiteResult {
  doc: string;
  nome: string;
  grupoChave: string | null;
  escopo: "individual" | "grupo";
  estoque: number;
  proposto: number;
  total: number;
  limite: number | null;
  excedido: boolean;
  labelGrupo?: string;
}

export function evaluateLimitesComite(
  cadastros: CadastroParteRow[],
  index: CadastroIndex,
  ctx: LimiteComiteContext,
): LimiteComiteResult[] {
  const processedGrupos = new Set<string>();
  const results: LimiteComiteResult[] = [];

  for (const cadastro of cadastros) {
    if (cadastro.limite_operacao == null) continue;

    if (cadastro.escopo_limite === "grupo" && cadastro.grupo_chave) {
      if (processedGrupos.has(cadastro.grupo_chave)) continue;
      processedGrupos.add(cadastro.grupo_chave);
      const grupoRows = index.byGrupoChave.get(cadastro.grupo_chave) ?? [cadastro];
      const { limite } = resolveLimiteGrupo(grupoRows);
      if (limite == null) continue;
      const estoque = ctx.estoqueByGrupoChave.get(cadastro.grupo_chave) ?? 0;
      const proposto = ctx.proposedByGrupoChave.get(cadastro.grupo_chave) ?? 0;
      const recompra = ctx.recompraByGrupoChave.get(cadastro.grupo_chave) ?? 0;
      const total = exposicaoProforma(estoque, proposto, recompra);
      results.push({
        doc: cadastro.grupo_chave,
        nome: grupoRows.map((r) => r.nome).filter(Boolean).join(" + ") || cadastro.grupo_chave,
        grupoChave: cadastro.grupo_chave,
        escopo: "grupo",
        estoque,
        proposto,
        total,
        limite,
        excedido: total > limite,
        labelGrupo: cadastro.grupo_chave,
      });
      continue;
    }

    const estoque = ctx.estoqueByDoc.get(cadastro.doc_cnpj_cpf) ?? 0;
    const proposto = ctx.proposedByDoc.get(cadastro.doc_cnpj_cpf) ?? 0;
    const recompra = ctx.recompraByDoc.get(cadastro.doc_cnpj_cpf) ?? 0;
    const total = exposicaoProforma(estoque, proposto, recompra);
    results.push({
      doc: cadastro.doc_cnpj_cpf,
      nome: cadastro.nome ?? cadastro.doc_cnpj_cpf,
      grupoChave: null,
      escopo: "individual",
      estoque,
      proposto,
      total,
      limite: cadastro.limite_operacao,
      excedido: total > cadastro.limite_operacao,
    });
  }

  return results;
}

export function buildMotivoLimiteExcedido(result: LimiteComiteResult): MotivoCadastro {
  const sufixo = result.escopo === "grupo" ? ` (grupo ${result.labelGrupo})` : "";
  return {
    regra_codigo: "LIMITE_COMITE_EXCEDIDO",
    regra_descricao: `Limite de comitê excedido${sufixo}`,
    valor_atual: formatBRL(result.total),
    valor_limite: result.limite != null ? formatBRL(result.limite) : "—",
    severidade: "vedacao",
  };
}

export function docPertenceGrupoCadastro(
  doc: string,
  cadastro: CadastroParteRow,
  index: CadastroIndex,
): boolean {
  if (cadastro.escopo_limite !== "grupo" || !cadastro.grupo_chave) {
    return cadastro.doc_cnpj_cpf === doc;
  }
  const grupo = index.byGrupoChave.get(cadastro.grupo_chave) ?? [];
  return grupo.some((r) => r.doc_cnpj_cpf === doc);
}

export { hydrateCadastroPartesParams };
