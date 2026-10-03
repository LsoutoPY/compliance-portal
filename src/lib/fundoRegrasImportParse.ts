/**
 * Parser da planilha de vínculos fundo × regra (importação em lote).
 * Espelhado em supabase/functions/importar-fundo-regras/index.ts
 */

import {
  normalizeCnpj14,
  type FundoSubclasseItem,
} from "@/lib/fundoRegrasUtils";
import { normalizeHeaderKey, parseDataCampo } from "@/lib/cadastroPartesParse";

export type FundoRegrasImportAviso = {
  linha: number;
  campo?: string;
  problema: string;
  valor_original?: string;
};

export type LinhaFundoRegrasImportPreview = {
  linha: number;
  fundo_cnpj: string;
  fundo_isin: string;
  fundo_nome: string | null;
  codigo_regra: string;
  regra_id: string | null;
  dt_inicio_vigencia: string | null;
  dt_fim_vigencia: string | null;
  rejeitada: boolean;
  avisos: FundoRegrasImportAviso[];
};

const HEADER_ALIASES: Record<string, string[]> = {
  FUNDO_CNPJ: ["FUNDO_CNPJ", "CNPJ_FUNDO", "CNPJ", "CNPJ_DO_FUNDO"],
  FUNDO_NOME: ["FUNDO_NOME", "NOME_FUNDO", "NOME", "FUNDO"],
  FUNDO_ISIN: ["FUNDO_ISIN", "ISIN", "SUBCLASSE"],
  CODIGO_REGRA: ["CODIGO_REGRA", "CODIGO", "REGRA", "COD_REGRA", "CODIGO_DA_REGRA"],
  DT_INICIO: ["DT_INICIO_VIGENCIA", "DATA_INICIO", "INICIO_VIGENCIA", "VIGENCIA_INICIO"],
  DT_FIM: ["DT_FIM_VIGENCIA", "DATA_FIM", "FIM_VIGENCIA", "VIGENCIA_FIM"],
};

function mapHeaders(keys: string[]): Record<string, string> {
  const headerMap: Record<string, string> = {};
  for (const k of keys) {
    const norm = normalizeHeaderKey(k);
    for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(norm)) {
        headerMap[canonical] = k;
        break;
      }
    }
  }
  return headerMap;
}

function cellStr(row: Record<string, unknown>, col?: string): string {
  if (!col) return "";
  return String(row[col] ?? "").trim();
}

function normalizeCodigoRegra(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "_");
}

function buildFundoIndex(fundos: FundoSubclasseItem[]): {
  byCnpjIsin: Map<string, FundoSubclasseItem>;
  byNome: Map<string, FundoSubclasseItem[]>;
} {
  const byCnpjIsin = new Map<string, FundoSubclasseItem>();
  const byNome = new Map<string, FundoSubclasseItem[]>();

  for (const f of fundos) {
    byCnpjIsin.set(`${f.cnpj}|${f.isin}`, f);
    const nomeKey = f.nome.trim().toUpperCase();
    if (!nomeKey) continue;
    const list = byNome.get(nomeKey) ?? [];
    list.push(f);
    byNome.set(nomeKey, list);
  }

  return { byCnpjIsin, byNome };
}

function resolveFundo(
  row: Record<string, unknown>,
  headerMap: Record<string, string>,
  fundoIndex: ReturnType<typeof buildFundoIndex>,
): { cnpj: string; isin: string; nome: string | null; avisos: FundoRegrasImportAviso[] } {
  const avisos: FundoRegrasImportAviso[] = [];
  const cnpjRaw = cellStr(row, headerMap.FUNDO_CNPJ);
  const nomeRaw = cellStr(row, headerMap.FUNDO_NOME);
  const isinRaw = cellStr(row, headerMap.FUNDO_ISIN).toUpperCase();

  if (cnpjRaw) {
    const cnpj = normalizeCnpj14(cnpjRaw);
    if (cnpj.length !== 14) {
      avisos.push({ linha: 0, campo: "fundo_cnpj", problema: "cnpj_invalido", valor_original: cnpjRaw });
      return { cnpj: "", isin: "", nome: null, avisos };
    }
    const hit = fundoIndex.byCnpjIsin.get(`${cnpj}|${isinRaw}`);
    if (hit) return { cnpj, isin: isinRaw, nome: hit.nome, avisos };
    if (isinRaw) {
      avisos.push({
        linha: 0,
        campo: "fundo",
        problema: "fundo_nao_encontrado",
        valor_original: `${cnpjRaw} / ${isinRaw}`,
      });
      return { cnpj, isin: isinRaw, nome: null, avisos };
    }
    const anySubclass = [...fundoIndex.byCnpjIsin.values()].find((f) => f.cnpj === cnpj);
    if (anySubclass) {
      avisos.push({
        linha: 0,
        campo: "fundo_isin",
        problema: "isin_recomendado",
        valor_original: cnpjRaw,
      });
      return { cnpj, isin: "", nome: anySubclass.nome, avisos };
    }
    avisos.push({ linha: 0, campo: "fundo", problema: "fundo_nao_encontrado", valor_original: cnpjRaw });
    return { cnpj, isin: isinRaw, nome: null, avisos };
  }

  if (nomeRaw) {
    const matches = fundoIndex.byNome.get(nomeRaw.toUpperCase()) ?? [];
    if (matches.length === 1) {
      return { cnpj: matches[0].cnpj, isin: matches[0].isin, nome: matches[0].nome, avisos };
    }
    if (matches.length > 1) {
      avisos.push({
        linha: 0,
        campo: "fundo_nome",
        problema: "nome_ambiguo",
        valor_original: nomeRaw,
      });
      return { cnpj: "", isin: "", nome: nomeRaw, avisos };
    }
    avisos.push({ linha: 0, campo: "fundo_nome", problema: "fundo_nao_encontrado", valor_original: nomeRaw });
    return { cnpj: "", isin: "", nome: nomeRaw, avisos };
  }

  avisos.push({ linha: 0, campo: "fundo", problema: "fundo_obrigatorio" });
  return { cnpj: "", isin: "", nome: null, avisos };
}

export function parseLinhaFundoRegrasImport(
  row: Record<string, unknown>,
  headerMap: Record<string, string>,
  linha: number,
  fundoIndex: ReturnType<typeof buildFundoIndex>,
  regrasByCodigo: Map<string, string>,
  existentesKeys: Set<string>,
): LinhaFundoRegrasImportPreview {
  const avisos: FundoRegrasImportAviso[] = [];
  const fundo = resolveFundo(row, headerMap, fundoIndex);
  avisos.push(...fundo.avisos.map((a) => ({ ...a, linha })));

  const codigoRaw = cellStr(row, headerMap.CODIGO_REGRA);
  const codigo = normalizeCodigoRegra(codigoRaw);
  if (!codigo) {
    avisos.push({ linha, campo: "codigo_regra", problema: "codigo_obrigatorio" });
  } else if (!regrasByCodigo.has(codigo)) {
    avisos.push({ linha, campo: "codigo_regra", problema: "regra_nao_encontrada", valor_original: codigoRaw });
  }

  const dtInicioParsed = parseDataCampo(cellStr(row, headerMap.DT_INICIO));
  const dtFimParsed = parseDataCampo(cellStr(row, headerMap.DT_FIM));

  if (dtInicioParsed.invalid) {
    avisos.push({
      linha,
      campo: "dt_inicio_vigencia",
      problema: "data_invalida",
      valor_original: dtInicioParsed.valorOriginal,
    });
  }
  if (dtFimParsed.invalid) {
    avisos.push({
      linha,
      campo: "dt_fim_vigencia",
      problema: "data_invalida",
      valor_original: dtFimParsed.valorOriginal,
    });
  }

  const dtInicio = dtInicioParsed.date;
  const dtFim = dtFimParsed.date;
  if (dtInicio && dtFim && dtInicio > dtFim) {
    avisos.push({ linha, campo: "vigencia", problema: "inicio_maior_que_fim" });
  }

  const regraId = codigo ? regrasByCodigo.get(codigo) ?? null : null;
  const existKey =
    fundo.cnpj && regraId ? `${fundo.cnpj}|${fundo.isin}|${regraId}` : "";
  if (existKey && existentesKeys.has(existKey)) {
    avisos.push({ linha, campo: "vinculo", problema: "vinculo_ja_existe" });
  }

  const bloqueantes = new Set([
    "fundo_obrigatorio",
    "cnpj_invalido",
    "fundo_nao_encontrado",
    "nome_ambiguo",
    "codigo_obrigatorio",
    "regra_nao_encontrada",
    "data_invalida",
    "inicio_maior_que_fim",
    "vinculo_ja_existe",
  ]);
  const rejeitada = avisos.some((a) => bloqueantes.has(a.problema));

  return {
    linha,
    fundo_cnpj: fundo.cnpj,
    fundo_isin: fundo.isin,
    fundo_nome: fundo.nome,
    codigo_regra: codigo,
    regra_id: regraId,
    dt_inicio_vigencia: dtInicio,
    dt_fim_vigencia: dtFim,
    rejeitada,
    avisos,
  };
}

export function parseRowsFundoRegrasImport(
  rows: Record<string, unknown>[],
  fundos: FundoSubclasseItem[],
  regras: Array<{ id: string; codigo: string }>,
  existentesKeys: Set<string>,
): LinhaFundoRegrasImportPreview[] {
  if (!rows.length) return [];
  const headerMap = mapHeaders(Object.keys(rows[0] ?? {}));
  const fundoIndex = buildFundoIndex(fundos);
  const regrasByCodigo = new Map(
    regras.map((r) => [normalizeCodigoRegra(r.codigo), r.id]),
  );

  return rows.map((row, i) =>
    parseLinhaFundoRegrasImport(row, headerMap, i + 2, fundoIndex, regrasByCodigo, existentesKeys),
  );
}

export function mapFundoRegrasImportHeaders(keys: string[]): Record<string, string> {
  return mapHeaders(keys);
}

export function describeFundoRegrasImportProblema(problema: string): string {
  const labels: Record<string, string> = {
    fundo_obrigatorio: "Informe CNPJ ou nome do fundo",
    cnpj_invalido: "CNPJ inválido",
    fundo_nao_encontrado: "Fundo não encontrado no universo monitorado",
    nome_ambiguo: "Nome ambíguo — informe CNPJ ou ISIN",
    isin_recomendado: "CNPJ com múltiplas subclasses — ISIN recomendado",
    codigo_obrigatorio: "Código da regra obrigatório",
    regra_nao_encontrada: "Regra não encontrada no catálogo",
    data_invalida: "Data inválida",
    inicio_maior_que_fim: "Início da vigência posterior ao fim",
    vinculo_ja_existe: "Vínculo já cadastrado (ativo ou pendente)",
  };
  return labels[problema] ?? problema;
}
