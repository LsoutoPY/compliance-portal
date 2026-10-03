/**
 * Exposição × Limite e alertas do Cadastro de Partes (estoque FIDC + cadastro vigente).
 */

import {
  cleanDoc,
  formatBRL,
  type CadastroParteRow,
} from "./cadastroPartes";
import { buildCadastroIndex, resolveLimiteGrupo } from "./cadastroPartesMotor";

export type StatusExposicao = "BREACH" | "NAO_CADASTRADO" | "CAD_VENCIDO" | "ATENCAO" | "OK";
export type SeveridadeAlerta = "critico" | "alerta" | "info";

export const STATUS_ORDEM: Record<StatusExposicao, number> = {
  BREACH: 0,
  NAO_CADASTRADO: 1,
  CAD_VENCIDO: 2,
  ATENCAO: 3,
  OK: 4,
};

export const STATUS_LABEL: Record<StatusExposicao, string> = {
  BREACH: "Estouro",
  NAO_CADASTRADO: "Não cadastrado",
  CAD_VENCIDO: "Cad. vencido",
  ATENCAO: "Atenção",
  OK: "OK",
};

export const MOTOR_POR_STATUS: Partial<Record<StatusExposicao, string>> = {
  BREACH: "LIMITE_COMITE_EXCEDIDO",
  NAO_CADASTRADO: "CADASTRO_PARTE_INEXISTENTE",
  CAD_VENCIDO: "CADASTRO_PARTE_VENCIDO",
};

export interface EstoqueCedenteAgg {
  doc: string;
  nome: string;
  bruta: number;
  liquida: number;
  qtd_titulos: number;
}

export interface FilhoGrupoExposicao {
  doc: string;
  nome: string;
  exposicao_bruta: number;
  exposicao_liquida: number;
  qtd_titulos: number;
}

export interface LinhaExposicaoLimite {
  id: string;
  tipo: "individual" | "grupo" | "nao_cadastrado";
  parte: string;
  doc: string;
  grupoChave?: string;
  cadastrado: boolean;
  exposicao_bruta: number;
  exposicao_liquida: number;
  limite_operacao: number | null;
  pct_uso: number | null;
  dt_validade: string | null;
  qtd_titulos: number;
  status: StatusExposicao;
  statusOrdem: number;
  motivo_motor?: string;
  filhos?: FilhoGrupoExposicao[];
  diasValidade?: number | null;
}

export interface AlertaCadastroParte {
  id: string;
  severidade: SeveridadeAlerta;
  titulo: string;
  descricao: string;
  motivo_motor?: string;
  itens: {
    doc: string;
    nome: string;
    exposicao?: number;
    pct_uso?: number | null;
    limite?: number | null;
    dias?: number | null;
    qtd_titulos?: number;
    grupoChave?: string;
  }[];
}

export interface ExposicaoLimitePayload {
  reference_date: string | null;
  data_hoje: string;
  vp_liquido: boolean;
  linhas: LinhaExposicaoLimite[];
  total_carteira_bruta: number;
  total_carteira_liquida: number;
  alertas: AlertaCadastroParte[];
  contadores_alerta: { critico: number; alerta: number; info: number };
}

export interface EstoqueRowInput {
  doc_cedente?: string | null;
  nome_cedente?: string | null;
  valor_presente?: number | null;
  valor_nominal?: number | null;
  valor_pdd?: number | null;
  valor_pdd_geral?: number | null;
}

export interface ImportAvisoInput {
  linha?: number;
  campo?: string;
  problema?: string;
  valor_original?: string;
}

function diasAte(data: string | null, hoje: string): number | null {
  if (!data) return null;
  const a = new Date(hoje + "T00:00:00");
  const b = new Date(data + "T00:00:00");
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function vpBrutoRow(row: EstoqueRowInput): number {
  const vn = Number(row.valor_nominal) || 0;
  const vp = Number(row.valor_presente) || 0;
  return vn > 0 ? vn : vp;
}

function vpLiquidoRow(row: EstoqueRowInput, usarPdd: boolean): number {
  const bruta = vpBrutoRow(row);
  if (!usarPdd) return bruta;
  const pdd = Number(row.valor_pdd_geral) || Number(row.valor_pdd) || 0;
  return Math.max(0, bruta - pdd);
}

export function agregarEstoquePorCedente(
  rows: EstoqueRowInput[],
  usarPdd = true,
): Map<string, EstoqueCedenteAgg> {
  const map = new Map<string, EstoqueCedenteAgg>();
  for (const row of rows) {
    const doc = cleanDoc(row.doc_cedente);
    if (!doc) continue;
    const bruta = vpBrutoRow(row);
    const liquida = vpLiquidoRow(row, usarPdd);
    const nome = String(row.nome_cedente ?? "").trim() || doc;
    const cur = map.get(doc);
    if (cur) {
      cur.bruta += bruta;
      cur.liquida += liquida;
      cur.qtd_titulos += 1;
      if (!cur.nome && nome) cur.nome = nome;
    } else {
      map.set(doc, { doc, nome, bruta, liquida, qtd_titulos: 1 });
    }
  }
  return map;
}

export function resolveStatusExposicao(input: {
  cadastrado: boolean;
  exposicao: number;
  limite: number | null;
  dt_validade: string | null;
  hoje: string;
}): StatusExposicao {
  const { cadastrado, exposicao, limite, dt_validade, hoje } = input;
  if (!cadastrado) return "NAO_CADASTRADO";
  if (limite != null && limite > 0 && exposicao > limite) return "BREACH";
  if (dt_validade && dt_validade < hoje) return "CAD_VENCIDO";
  const pct = limite != null && limite > 0 ? (exposicao / limite) * 100 : null;
  if (pct != null && pct >= 85) return "ATENCAO";
  return "OK";
}

function piorValidadeGrupo(rows: CadastroParteRow[], hoje: string): {
  dt_validade: string | null;
  dias: number | null;
  algumVencido: boolean;
} {
  let dt: string | null = null;
  let dias: number | null = null;
  let algumVencido = false;
  for (const r of rows) {
    if (!r.dt_validade) continue;
    const d = diasAte(r.dt_validade, hoje);
    if (d != null && d < 0) algumVencido = true;
    if (dias == null || (d != null && d < dias)) {
      dias = d;
      dt = r.dt_validade;
    }
  }
  return { dt_validade: dt, dias, algumVencido };
}

export function buildExposicaoLimitePayload(input: {
  partes: CadastroParteRow[];
  estoqueRows: EstoqueRowInput[];
  reference_date: string | null;
  data_hoje?: string;
  vp_liquido?: boolean;
  importAvisos?: ImportAvisoInput[];
}): ExposicaoLimitePayload {
  const hoje = input.data_hoje ?? new Date().toISOString().slice(0, 10);
  const vpLiquido = input.vp_liquido !== false;
  const estoqueMap = agregarEstoquePorCedente(input.estoqueRows, vpLiquido);
  const index = buildCadastroIndex(input.partes);
  const linhas: LinhaExposicaoLimite[] = [];
  const processedGrupos = new Set<string>();
  const processedDocs = new Set<string>();

  let totalBruta = 0;
  let totalLiquida = 0;
  for (const agg of estoqueMap.values()) {
    totalBruta += agg.bruta;
    totalLiquida += agg.liquida;
  }

  const exposicaoValor = (doc: string) => {
    const agg = estoqueMap.get(doc);
    if (!agg) return { bruta: 0, liquida: 0, qtd: 0, nome: doc };
    return {
      bruta: agg.bruta,
      liquida: agg.liquida,
      qtd: agg.qtd_titulos,
      nome: agg.nome,
    };
  };

  for (const parte of input.partes) {
    if (parte.escopo_limite === "grupo" && parte.grupo_chave) {
      if (processedGrupos.has(parte.grupo_chave)) continue;
      processedGrupos.add(parte.grupo_chave);
      const grupoRows = index.byGrupoChave.get(parte.grupo_chave) ?? [parte];
      for (const g of grupoRows) processedDocs.add(g.doc_cnpj_cpf);

      const filhos: FilhoGrupoExposicao[] = grupoRows.map((g) => {
        const ex = exposicaoValor(g.doc_cnpj_cpf);
        return {
          doc: g.doc_cnpj_cpf,
          nome: g.nome ?? ex.nome,
          exposicao_bruta: ex.bruta,
          exposicao_liquida: ex.liquida,
          qtd_titulos: ex.qtd,
        };
      });

      const exposicao_bruta = filhos.reduce((s, f) => s + f.exposicao_bruta, 0);
      const exposicao_liquida = filhos.reduce((s, f) => s + f.exposicao_liquida, 0);
      const qtd_titulos = filhos.reduce((s, f) => s + f.qtd_titulos, 0);
      const { limite } = resolveLimiteGrupo(grupoRows);
      const val = piorValidadeGrupo(grupoRows, hoje);
      const status = resolveStatusExposicao({
        cadastrado: true,
        exposicao: exposicao_liquida,
        limite,
        dt_validade: val.algumVencido ? val.dt_validade : val.dt_validade,
        hoje,
      });
      const pct_uso = limite != null && limite > 0 ? (exposicao_liquida / limite) * 100 : null;

      if (exposicao_liquida <= 0 && status === "OK") continue;

      linhas.push({
        id: `grupo:${parte.grupo_chave}`,
        tipo: "grupo",
        parte: grupoRows.map((g) => g.nome).filter(Boolean).join(" + ") || parte.grupo_chave,
        doc: parte.grupo_chave,
        grupoChave: parte.grupo_chave,
        cadastrado: true,
        exposicao_bruta,
        exposicao_liquida,
        limite_operacao: limite,
        pct_uso,
        dt_validade: val.dt_validade,
        qtd_titulos,
        status,
        statusOrdem: STATUS_ORDEM[status],
        motivo_motor: MOTOR_POR_STATUS[status],
        filhos,
        diasValidade: val.dias,
      });
      continue;
    }

    if (processedDocs.has(parte.doc_cnpj_cpf)) continue;
    processedDocs.add(parte.doc_cnpj_cpf);

    const ex = exposicaoValor(parte.doc_cnpj_cpf);
    const status = resolveStatusExposicao({
      cadastrado: true,
      exposicao: ex.liquida,
      limite: parte.limite_operacao,
      dt_validade: parte.dt_validade,
      hoje,
    });
    const pct_uso =
      parte.limite_operacao != null && parte.limite_operacao > 0
        ? (ex.liquida / parte.limite_operacao) * 100
        : null;

    if (ex.liquida <= 0 && status === "OK") continue;

    linhas.push({
      id: `doc:${parte.doc_cnpj_cpf}`,
      tipo: "individual",
      parte: parte.nome ?? ex.nome,
      doc: parte.doc_cnpj_cpf,
      cadastrado: true,
      exposicao_bruta: ex.bruta,
      exposicao_liquida: ex.liquida,
      limite_operacao: parte.limite_operacao,
      pct_uso,
      dt_validade: parte.dt_validade,
      qtd_titulos: ex.qtd,
      status,
      statusOrdem: STATUS_ORDEM[status],
      motivo_motor: MOTOR_POR_STATUS[status],
      diasValidade: diasAte(parte.dt_validade, hoje),
    });
  }

  for (const [doc, agg] of estoqueMap) {
    if (index.byDoc.has(doc)) continue;
    if (agg.liquida <= 0) continue;
    const status: StatusExposicao = "NAO_CADASTRADO";
    linhas.push({
      id: `nc:${doc}`,
      tipo: "nao_cadastrado",
      parte: agg.nome,
      doc,
      cadastrado: false,
      exposicao_bruta: agg.bruta,
      exposicao_liquida: agg.liquida,
      limite_operacao: null,
      pct_uso: null,
      dt_validade: null,
      qtd_titulos: agg.qtd_titulos,
      status,
      statusOrdem: STATUS_ORDEM[status],
      motivo_motor: MOTOR_POR_STATUS[status],
    });
  }

  linhas.sort((a, b) => {
    if (a.statusOrdem !== b.statusOrdem) return a.statusOrdem - b.statusOrdem;
    return (b.pct_uso ?? 0) - (a.pct_uso ?? 0) || b.exposicao_liquida - a.exposicao_liquida;
  });

  const alertas = buildAlertasCadastroPartes(linhas, input.partes, hoje, input.importAvisos ?? []);

  return {
    reference_date: input.reference_date,
    data_hoje: hoje,
    vp_liquido: vpLiquido,
    linhas,
    total_carteira_bruta: totalBruta,
    total_carteira_liquida: totalLiquida,
    alertas,
    contadores_alerta: {
      critico: alertas.filter((a) => a.severidade === "critico").length,
      alerta: alertas.filter((a) => a.severidade === "alerta").length,
      info: alertas.filter((a) => a.severidade === "info").length,
    },
  };
}

export function buildAlertasCadastroPartes(
  linhas: LinhaExposicaoLimite[],
  partes: CadastroParteRow[],
  hoje: string,
  importAvisos: ImportAvisoInput[],
): AlertaCadastroParte[] {
  const alertas: AlertaCadastroParte[] = [];

  const breaches = linhas.filter((l) => l.status === "BREACH");
  if (breaches.length > 0) {
    alertas.push({
      id: "breach",
      severidade: "critico",
      titulo: `Limite de comitê excedido (${breaches.length})`,
      descricao: "Exposição VP líquida acima do limite cadastrado em comitê.",
      motivo_motor: "LIMITE_COMITE_EXCEDIDO",
      itens: breaches.map((l) => ({
        doc: l.doc,
        nome: l.parte,
        exposicao: l.exposicao_liquida,
        pct_uso: l.pct_uso,
        limite: l.limite_operacao,
        grupoChave: l.grupoChave,
        qtd_titulos: l.qtd_titulos,
      })),
    });
  }

  const naoCad = linhas.filter((l) => l.status === "NAO_CADASTRADO" && l.exposicao_liquida > 0);
  if (naoCad.length > 0) {
    alertas.push({
      id: "nao-cadastrado",
      severidade: "critico",
      titulo: `Cedentes não cadastrados com exposição (${naoCad.length})`,
      descricao: "Partes com títulos no estoque sem cadastro vigente no comitê.",
      motivo_motor: "CADASTRO_PARTE_INEXISTENTE",
      itens: naoCad.map((l) => ({
        doc: l.doc,
        nome: l.parte,
        exposicao: l.exposicao_liquida,
        qtd_titulos: l.qtd_titulos,
      })),
    });
  }

  const vencidos = linhas.filter(
    (l) => l.status === "CAD_VENCIDO" && l.cadastrado && l.exposicao_liquida > 0,
  );
  if (vencidos.length > 0) {
    alertas.push({
      id: "cad-vencido",
      severidade: "alerta",
      titulo: `Cadastro vencido com exposição (${vencidos.length})`,
      descricao: "Partes com validade expirada e títulos ainda no estoque.",
      motivo_motor: "CADASTRO_PARTE_VENCIDO",
      itens: vencidos.map((l) => ({
        doc: l.doc,
        nome: l.parte,
        exposicao: l.exposicao_liquida,
        pct_uso: l.pct_uso,
        limite: l.limite_operacao,
        dias: l.diasValidade,
        grupoChave: l.grupoChave,
        qtd_titulos: l.qtd_titulos,
      })),
    });
  }

  const vence30 = partes.filter((p) => {
    if (!p.dt_validade) return false;
    const d = diasAte(p.dt_validade, hoje);
    return d != null && d >= 0 && d <= 30;
  });
  if (vence30.length > 0) {
    alertas.push({
      id: "vence-30",
      severidade: "alerta",
      titulo: `Cadastro vence em até 30 dias (${vence30.length})`,
      descricao: "Renovação de comitê recomendada antes do vencimento.",
      itens: vence30.map((p) => ({
        doc: p.doc_cnpj_cpf,
        nome: p.nome ?? p.doc_cnpj_cpf,
        dias: diasAte(p.dt_validade, hoje),
      })),
    });
  }

  const revisaoPendente = partes.filter((p) => !p.dt_validade);
  if (revisaoPendente.length > 0) {
    alertas.push({
      id: "revisao-pendente",
      severidade: "info",
      titulo: `Revisão de cadastro pendente (${revisaoPendente.length})`,
      descricao: "Partes sem data de validade definida na planilha de comitê.",
      motivo_motor: "CADASTRO_REVISAO_PENDENTE",
      itens: revisaoPendente.map((p) => ({
        doc: p.doc_cnpj_cpf,
        nome: p.nome ?? p.doc_cnpj_cpf,
      })),
    });
  }

  const avisosData = importAvisos.filter(
    (a) =>
      String(a.problema ?? "").includes("data_invalida") ||
      String(a.campo ?? "").toLowerCase().includes("validade") ||
      String(a.campo ?? "").toLowerCase().includes("analise"),
  );
  if (avisosData.length > 0) {
    alertas.push({
      id: "import-data-invalida",
      severidade: "info",
      titulo: `Datas inválidas no último import (${avisosData.length})`,
      descricao: "Linhas com datas não reconhecidas na planilha importada — revisar no histórico de importações.",
      itens: avisosData.slice(0, 20).map((a, i) => ({
        doc: `L${a.linha ?? i + 1}`,
        nome: `${a.campo ?? "data"}: ${a.valor_original ?? "—"}`,
      })),
    });
  }

  const ordem: Record<SeveridadeAlerta, number> = { critico: 0, alerta: 1, info: 2 };
  alertas.sort((a, b) => ordem[a.severidade] - ordem[b.severidade]);
  return alertas;
}

export function exposicaoExibicao(linha: LinhaExposicaoLimite, vpLiquido: boolean): number {
  return vpLiquido ? linha.exposicao_liquida : linha.exposicao_bruta;
}

export function formatExposicao(valor: number): string {
  return formatBRL(valor);
}
