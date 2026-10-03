/**
 * Parser da planilha de cadastro de partes (consultoria).
 * Usado nos testes Vitest; lógica espelhada em importar-cadastro-partes.
 */

import type { ImportAviso, LinhaImportPreview } from "./cadastroPartes";

function cleanDoc(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

function normalizeDoc(docRaw: unknown): string {
  const digits = cleanDoc(docRaw);
  if (!digits) return "";
  if (digits.length <= 11) return digits.padStart(11, "0");
  return digits.padStart(14, "0");
}

function calcCnpjCheckDigit(base: string, weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += Number(base[i]) * weights[i];
  const mod = sum % 11;
  return mod < 2 ? 0 : 11 - mod;
}

function isValidCnpj(cnpj: string): boolean {
  const d = normalizeDoc(cnpj);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = calcCnpjCheckDigit(d.slice(0, 12), w1);
  const d2 = calcCnpjCheckDigit(d.slice(0, 12) + d1, w2);
  return d.slice(12) === `${d1}${d2}`;
}

function isValidCpf(cpf: string): boolean {
  const d = normalizeDoc(cpf);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i);
  let mod = (sum * 10) % 11;
  if (mod === 10) mod = 0;
  if (mod !== Number(d[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(d[i]) * (11 - i);
  mod = (sum * 10) % 11;
  if (mod === 10) mod = 0;
  return mod === Number(d[10]);
}

function isValidDoc(doc: string): boolean {
  const d = normalizeDoc(doc);
  if (d.length === 14) return isValidCnpj(d);
  if (d.length === 11) return isValidCpf(d);
  return false;
}

function detectPossivelGrupo(empresa: string, observacoes: string): boolean {
  const text = `${empresa} ${observacoes}`.toUpperCase();
  return text.includes("(GRUPO)") || text.includes("GRUPO ");
}

/** Aceita CNPJ válido ou 13 dígitos com zero-pad (ex. Mineradora Aroeira). */
export function isAcceptableImportDoc(docRaw: unknown, doc: string): boolean {
  if (isValidDoc(doc)) return true;
  const digits = cleanDoc(docRaw);
  return digits.length === 13 && doc.length === 14;
}

export interface ParseDataResult {
  date: string | null;
  pendente: boolean;
  invalid: boolean;
  valorOriginal: string;
}

export interface ParseLimiteResult {
  value: number | null;
  rejeitar: boolean;
  problema?: string;
  valorOriginal: string;
}

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

export function normalizeHeaderKey(h: string): string {
  return String(h ?? "")
    .replace(/\r\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function mapHeadersFromKeys(keys: string[]): Record<string, string> {
  const headerMap: Record<string, string> = {};
  for (const k of keys) {
    if (k.startsWith("__EMPTY")) continue;
    const norm = normalizeHeaderKey(k);
    if (norm.includes("FIDC")) headerMap.FIDC = k;
    else if (norm === "EMPRESA" || norm.includes("EMPRESA")) headerMap.EMPRESA = k;
    else if (norm === "CNPJ" || norm.includes("CNPJ")) headerMap.CNPJ = k;
    else if (norm.includes("ORIGINACAO") || norm.includes("GERENTE")) headerMap.ORIGINACAO = k;
    else if (norm === "STATUS" || norm.includes("STATUS")) headerMap.STATUS = k;
    else if (norm.includes("DATA") && norm.includes("ANALISE")) headerMap.DATA_DA_ANALISE = k;
    else if (norm === "REVISAO" || norm.includes("REVISAO")) headerMap.REVISAO = k;
    else if (norm === "CONSULTORIA") headerMap.CONSULTORIA = k;
    else if (norm.includes("RENOVACAO")) headerMap.RENOVACAO = k;
    else if (norm.includes("OBSERV")) headerMap.OBSERVACOES = k;
  }
  return headerMap;
}

function formatUtcYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const ms = EXCEL_EPOCH_MS + Math.round(serial * 86400000);
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (y < 2000 || y > 2100) return null;
  return formatUtcYmd(d);
}

function valorOriginalStr(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export function parseLimiteCampo(v: unknown): ParseLimiteResult {
  const valorOriginal = valorOriginalStr(v);
  if (v == null || v === "") {
    return { value: null, rejeitar: true, problema: "limite_ausente", valorOriginal };
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return { value: v, rejeitar: false, valorOriginal };
  }

  let s = String(v).trim().replace(/\u00a0/g, " ");
  if (!s) return { value: null, rejeitar: true, problema: "limite_ausente", valorOriginal };

  if (/[A-Za-z]/.test(s.replace(/R\$/gi, "").replace(/\s/g, ""))) {
    return { value: null, rejeitar: true, problema: "limite_nao_numerico", valorOriginal: s };
  }

  s = s.replace(/R\$\s?/gi, "").replace(/\s/g, "");
  if (s.includes(".") && s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length <= 2) {
      s = `${parts[0].replace(/\./g, "")}.${parts[1]}`;
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, "");
  }

  const n = Number(s);
  if (!Number.isFinite(n)) {
    return { value: null, rejeitar: true, problema: "limite_nao_numerico", valorOriginal };
  }
  return { value: n, rejeitar: false, valorOriginal };
}

export function parseDataCampo(v: unknown): ParseDataResult {
  const valorOriginal = valorOriginalStr(v);

  if (v == null || v === "") {
    return { date: null, pendente: false, invalid: false, valorOriginal };
  }

  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getUTCFullYear();
    if (y < 2000 || y > 2100) {
      return { date: null, pendente: false, invalid: true, valorOriginal };
    }
    return { date: formatUtcYmd(v), pendente: false, invalid: false, valorOriginal };
  }

  if (typeof v === "number" && Number.isFinite(v)) {
    const iso = excelSerialToIso(v);
    if (!iso) return { date: null, pendente: false, invalid: true, valorOriginal };
    return { date: iso, pendente: false, invalid: false, valorOriginal };
  }

  const s = String(v).trim().replace(/\u00a0/g, " ");
  const lower = s.toLowerCase();
  if (lower === "pendente") {
    return { date: null, pendente: true, invalid: false, valorOriginal: s };
  }

  const isoPrefix = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoPrefix) {
    const year = Number(isoPrefix[1]);
    const month = Number(isoPrefix[2]);
    const day = Number(isoPrefix[3]);
    const dt = new Date(Date.UTC(year, month - 1, day));
    if (
      dt.getUTCFullYear() !== year ||
      dt.getUTCMonth() !== month - 1 ||
      dt.getUTCDate() !== day ||
      year < 2000 ||
      year > 2100
    ) {
      return { date: null, pendente: false, invalid: true, valorOriginal: s };
    }
    return { date: `${isoPrefix[1]}-${isoPrefix[2]}-${isoPrefix[3]}`, pendente: false, invalid: false, valorOriginal: s };
  }

  const br = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (br) {
    const day = Number(br[1]);
    const month = Number(br[2]);
    const year = Number(br[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) {
      return { date: null, pendente: false, invalid: true, valorOriginal: s };
    }
    const dt = new Date(Date.UTC(year, month - 1, day));
    if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
      return { date: null, pendente: false, invalid: true, valorOriginal: s };
    }
    return {
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      pendente: false,
      invalid: false,
      valorOriginal: s,
    };
  }

  return { date: null, pendente: false, invalid: true, valorOriginal: s };
}

export function parseLinhaPlanilhaConsultoria(
  row: Record<string, unknown>,
  headerMap: Record<string, string>,
  linha: number,
): LinhaImportPreview {
  const avisos: ImportAviso[] = [];
  const get = (key: string) => {
    const col = headerMap[key];
    return col != null ? row[col] : null;
  };

  const empresa = String(get("EMPRESA") ?? "").trim();
  const cnpjRaw = get("CNPJ");
  const doc = normalizeDoc(cnpjRaw);
  const limiteParsed = parseLimiteCampo(get("STATUS"));
  const dtAnalise = parseDataCampo(get("DATA_DA_ANALISE"));
  const revisao = parseDataCampo(get("REVISAO"));
  const consultoria = String(get("CONSULTORIA") ?? "").trim() || null;
  const observacoesRaw = String(get("OBSERVACOES") ?? "").trim() || null;

  if (!doc) {
    return {
      linha, empresa, doc_cnpj_cpf: "", limite_operacao: null,
      dt_analise: null, dt_validade: null, consultoria, observacoes: observacoesRaw,
      escopo_limite: "individual", grupo_chave: null,
      avisos: [{ linha, campo: "CNPJ", problema: "cnpj_ausente", valor_original: String(cnpjRaw ?? "") }],
      rejeitada: true, motivo_rejeicao: "CNPJ ausente",
    };
  }

  if (!isAcceptableImportDoc(cnpjRaw, doc)) {
    return {
      linha, empresa, doc_cnpj_cpf: doc, limite_operacao: limiteParsed.value,
      dt_analise: dtAnalise.date, dt_validade: null, consultoria, observacoes: observacoesRaw,
      escopo_limite: "individual", grupo_chave: null,
      avisos: [{ linha, campo: "CNPJ", problema: "cnpj_invalido", valor_original: String(cnpjRaw ?? "") }],
      rejeitada: true, motivo_rejeicao: "CNPJ/CPF inválido",
    };
  }

  if (limiteParsed.rejeitar) {
    return {
      linha, empresa, doc_cnpj_cpf: doc, limite_operacao: null,
      dt_analise: dtAnalise.date, dt_validade: null, consultoria, observacoes: observacoesRaw,
      escopo_limite: "individual", grupo_chave: null,
      avisos: [{
        linha, campo: "STATUS", problema: limiteParsed.problema ?? "limite_nao_numerico",
        valor_original: limiteParsed.valorOriginal,
      }],
      rejeitada: true,
      motivo_rejeicao: limiteParsed.problema === "limite_ausente" ? "Limite ausente" : "Limite não numérico",
    };
  }

  if (dtAnalise.invalid) {
    avisos.push({
      linha, campo: "DATA DA ANÁLISE", problema: "data_invalida", valor_original: dtAnalise.valorOriginal,
    });
  }

  let dtValidade: string | null = null;
  if (revisao.pendente) {
    avisos.push({
      linha, campo: "REVISÃO", problema: "revisao_pendente", valor_original: revisao.valorOriginal,
    });
  } else if (revisao.invalid) {
    avisos.push({
      linha, campo: "REVISÃO", problema: "data_invalida", valor_original: revisao.valorOriginal,
    });
  } else {
    dtValidade = revisao.date;
  }

  if (detectPossivelGrupo(empresa, observacoesRaw ?? "")) {
    avisos.push({
      linha, campo: "OBSERVAÇÕES", problema: "possivel_grupo",
      valor_original: `${empresa} | ${observacoesRaw ?? ""}`,
    });
  }

  return {
    linha, empresa, doc_cnpj_cpf: doc,
    limite_operacao: limiteParsed.value,
    dt_analise: dtAnalise.invalid ? null : dtAnalise.date,
    dt_validade: dtValidade,
    consultoria, observacoes: observacoesRaw,
    escopo_limite: "individual", grupo_chave: null,
    avisos, rejeitada: false,
  };
}

export function parseRowsCadastroPartes(rows: Record<string, unknown>[]): LinhaImportPreview[] {
  if (rows.length === 0) return [];
  const headerMap = mapHeadersFromKeys(Object.keys(rows[0] ?? {}));
  return rows.map((row, i) => parseLinhaPlanilhaConsultoria(row, headerMap, i + 2));
}
