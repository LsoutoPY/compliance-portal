/**
 * Edge Function: import-passivo-fundos
 *
 * Aceita upload de arquivos de passivo de fundos (CSV) e dados pré-parseados
 * de XLSX (posicao_cotas, Itaú/Intrag) enviados pelo frontend. Unifica em passivo_fundos.
 *
 * Formatos suportados:
 * - Passivo_Finvest.wm.csv (sep ";") -> FINVEST: Col D=Fundo, L=Cotista, AB=Valor
 *   (layout alternativo: Col A=nome da classe, Col D=CNPJ 14 dígitos → nome em A, CNPJ gravado direto)
 * - Passivo_Finvest.Growth.csv (sep ";") -> Finvest.Growth: mesmo layout
 * - Passivos_BTG.csv (sep ",") -> BTG: Col A=Fundo, H=Cotista, T=Valor; CNPJ do fundo em coluna B–F (ou próximas, exc. cotista/valor) quando existir 14 dígitos
 * - posicao_cotas_json: JSON com array [{fundo, cotista, valor}] parseado no frontend
 * - itau_passivo_json: JSON com array [{cliente, cpf, conta, fundo, cnpj_fundo, saldo_liquido}] parseado no frontend (Itaú/Intrag)
 * - finvest_passivo_json: JSON com array [{fundo, cotista, valor, cnpj_fundo}] da API Sinqia (import-sinqia-passivo)
 *
 * Request: multipart/form-data
 *   - files: arquivos CSV
 *   - posicao_cotas_json: (opcional) JSON string com dados de XLSX já parseados
 *   - itau_passivo_json: (opcional) JSON string com dados de XLSX do Itaú/Intrag já parseados
 *   - finvest_passivo_json: (opcional) JSON string com dados da API Finvest/Sinqia
 *   - data_posicao: (opcional) YYYYMMDD, default = hoje
 *
 * Substituição por data: remove e reinsere apenas os fundos presentes no upload
 * (por administradora + nome do fundo), preservando outras subclasses/fontes na mesma data.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface PassivoRow {
  administradora: string;
  fundo: string;
  cotista: string;
  valor: number;
  /** CNPJ lido do próprio CSV (col D quando é classe/CNPJ), evita match errado por nome */
  fundo_cnpj_arquivo?: string | null;
}

interface DeParaLookup {
  exactMap: Map<string, number>;
  nomeEntries: Array<{ normalized: string; compact: string; codigo: number }>;
}

function normalizePossiblyCentValue(valor: number, raw?: string): number {
  if (!Number.isFinite(valor)) return 0;
  if (!Number.isInteger(valor)) return valor;
  const hasExplicitDecimals = raw ? /[.,]\d{1,2}$/.test(raw) : false;
  if (hasExplicitDecimals) return valor;
  return valor >= 1e9 ? valor / 100 : valor;
}

function parseValorBrasil(v: string | number | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === 'number' && !isNaN(v)) {
    return normalizePossiblyCentValue(v);
  }

  const raw = String(v)
    .trim()
    .replace(/\s/g, '')
    .replace(/^R\$/, '')
    .replace(/[^\d,.-]/g, '');

  if (!raw) return 0;

  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  const hasComma = lastComma >= 0;
  const hasDot = lastDot >= 0;

  let normalized = raw;

  if (hasComma && hasDot) {
    if (lastComma > lastDot) {
      normalized = raw.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = raw.replace(/,/g, '');
    }
  } else if (hasComma) {
    const decimalDigits = raw.length - lastComma - 1;
    normalized = decimalDigits > 0 && decimalDigits <= 2
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw.replace(/,/g, '');
  } else if (hasDot) {
    const decimalDigits = raw.length - lastDot - 1;
    normalized = decimalDigits > 0 && decimalDigits <= 2
      ? raw.replace(/,/g, '')
      : raw.replace(/\./g, '');
  }

  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return 0;

  return normalizePossiblyCentValue(parsed, raw);
}

/** Remove aspas no início/fim e normaliza espaços */
function sanitizeText(val: string | null | undefined): string {
  return String(val ?? '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectSource(filename: string): string | null {
  const lower = filename.toLowerCase();
  if (lower.includes('finvest') && (lower.includes('wm') || lower.includes('.wm.'))) return 'FINVEST';
  if (lower.includes('finvest') && lower.includes('growth')) return 'Finvest.Growth';
  if (lower.includes('btg')) return 'BTG';
  if (lower.startsWith('posicao_cotas_fundo_') && lower.endsWith('.xlsx')) return 'Posição Cotas';
  return null;
}

/** Conteúdo tem prioridade sobre o nome — ex.: "Posição de Cotistas.csv" da FINVEST (28+ colunas) */
function detectImportSource(filename: string, content: string): string | null {
  return detectSourceByContent(content) || detectSource(filename);
}

/** Fallback: detecta fonte pelo layout do CSV quando o nome do arquivo não ajuda */
function detectSourceByContent(content: string): string | null {
  const lines = content.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  if (lines.length === 0) return null;

  let maxSemi = 0;
  let maxComma = 0;
  for (const line of lines) {
    const semiCols = line.split(';').length;
    const commaCols = line.split(',').length;
    if (semiCols > maxSemi) maxSemi = semiCols;
    if (commaCols > maxComma) maxComma = commaCols;
  }

  // Layout FINVEST: usamos colunas 3, 11 e 27 (>= 28 colunas)
  if (maxSemi >= 28) return 'FINVEST';
  // Layout BTG: usamos colunas 0, 7 e 19 (>= 20 colunas)
  if (maxComma >= 20) return 'BTG';
  // CSV tabular (fundo · cotista · valor)
  if (maxSemi >= 3 || maxComma >= 3) return 'TABULAR';
  return null;
}

function normalizeHeaderCellPassivo(h: unknown): string {
  return String(h ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ');
}

function isPassivoMetaLabel(text: string): boolean {
  const n = normalizeFundName(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n || n.length < 2) return true;
  const blocked = new Set([
    'CONTA DA CLASSE',
    'CONTA DA SUBCLASSE',
    'CONTA DA CLASSE/SUBCLASSE',
    'CLASSE/SUBCLASSE',
    'SUBTOTAL',
    'TOTAL GERAL',
    'TOTAL',
    'FUNDO NAO IDENTIFICADO',
    'COTISTA',
    'COTISTAS',
    'INVESTIDOR',
    'INVESTIDORES',
    'NOME DO FUNDO',
    'NOME DO COTISTA',
    'CLIENTE',
    'FUNDO',
    'RAZAO SOCIAL',
  ]);
  if (blocked.has(n)) return true;
  if (n.startsWith('TOTAL ') || n.endsWith(' TOTAL')) return true;
  if (n.includes('CONTA DA CLASSE') || n.includes('CLASSE/SUBCLASSE')) return true;
  return false;
}

function isInvalidPassivoFundoName(text: string): boolean {
  if (isPassivoMetaLabel(text)) return true;
  const raw = String(text ?? '').trim();
  if (!raw || raw.length < 3) return true;
  const lower = raw.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (/\.(xlsx?|xltx?|csv)$/i.test(lower)) return true;
  if (/posi(cao|ção)\s*(de\s*)?cotistas?/i.test(lower)) return true;
  if (/passivo\s*(de\s*)?fundos?/i.test(lower)) return true;
  if (/^posi(cao|ção)\s*cotas?$/i.test(lower)) return true;
  if (/^(relatorio|planilha|exportacao|exportação)\b/i.test(lower)) return true;
  return false;
}

function isPassivoMetaCotista(text: string): boolean {
  if (isInvalidPassivoFundoName(text)) return true;
  const n = String(text ?? '').trim().toLowerCase();
  return n === 'total' || n.startsWith('total ');
}

function detectCsvDelimiter(content: string): ',' | ';' {
  const lines = content.split(/\r?\n/).filter((l) => l.trim()).slice(0, 8);
  let semi = 0;
  let comma = 0;
  for (const line of lines) {
    semi += (line.match(/;/g) || []).length;
    comma += (line.match(/,/g) || []).length;
  }
  return semi > comma ? ';' : ',';
}

function parseCsvLineDelim(line: string, delim: ',' | ';'): string[] {
  if (delim === ',') return parseCsvLine(line);
  const cols: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (inQuotes) {
      cur += c;
    } else if (c === delim) {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  cols.push(cur.trim());
  return cols;
}

function parseValorFromCsvCell(v: string | null | undefined, useBtgCentavos: boolean): number {
  if (useBtgCentavos) return parseBtgValor(v);
  return parseValorBrasil(v);
}

/** CSV tabular: cabeçalho com fundo · cotista/cliente · valor/saldo (ex.: Posição de Cotistas_btg.csv) */
function parseCsvTabular(content: string, administradora: string): PassivoRow[] {
  const rows: PassivoRow[] = [];
  const delim = detectCsvDelimiter(content);
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const useBtgCentavos = administradora === 'BTG';

  for (let hi = 0; hi < Math.min(20, lines.length); hi++) {
    const header = parseCsvLineDelim(lines[hi], delim).map(normalizeHeaderCellPassivo);
    const colCotista = header.findIndex(
      (h) =>
        h === 'cotista' ||
        h === 'cliente' ||
        h === 'investidor' ||
        h.includes('nome cotista') ||
        h.includes('nome do cotista') ||
        h.includes('razao social'),
    );
    const colFundo = header.findIndex(
      (h) =>
        h === 'fundo' ||
        h.includes('nome fundo') ||
        h.includes('nome do fundo') ||
        h === 'classe' ||
        h.includes('nome classe') ||
        h === 'produto' ||
        h === 'carteira',
    );
    const colValor = header.findIndex(
      (h) =>
        (h.includes('valor') && !h.includes('cota') && !h.includes('unit')) ||
        h.includes('saldo') ||
        h.includes('posicao') ||
        h.includes('financeiro') ||
        h.includes('participacao') ||
        h.includes('bruto') ||
        h.includes('liquido') ||
        h === 'pl' ||
        h.includes('vl posicao'),
    );
    const colCnpj = header.findIndex((h) => h.includes('cnpj'));

    if (colCotista < 0 || colFundo < 0 || colValor < 0) continue;

    for (let i = hi + 1; i < lines.length; i++) {
      const cols = parseCsvLineDelim(lines[i], delim);
      const fundo = normalizeFundName(sanitizeText(String(cols[colFundo] ?? '')));
      const cotista = sanitizeText(String(cols[colCotista] ?? ''));
      const valor = parseValorFromCsvCell(cols[colValor], useBtgCentavos);
      if (!fundo || !cotista || valor <= 0) continue;
      if (isInvalidPassivoFundoName(fundo) || isPassivoMetaCotista(cotista)) continue;
      const fundo_cnpj_arquivo = colCnpj >= 0 ? extractCnpj14FromCell(cols[colCnpj]) : null;
      rows.push({
        administradora,
        fundo,
        cotista,
        valor,
        ...(fundo_cnpj_arquivo ? { fundo_cnpj_arquivo } : {}),
      });
    }
    if (rows.length > 0) break;
  }
  return rows;
}

/** Normaliza nome do fundo para matching - alinha com header do XML (posicao_carteira) */
function normalizeFundName(name: string): string {
  if (!name) return "";
  const normalized = name
    .normalize("NFC")
    .replace(/\uFFFD/g, "")
    .toUpperCase()
    .replace(/\s*-\s*FIC\s+FIM\s*$/i, "")
    .replace(/\s+FIC\s+FIM\s*$/i, "")
    .replace(/\s*-\s*FIM\s*$/i, "")
    .replace(/\s+FUNDO\s+DE\s+INVESTIMENTO\s*$/i, "")
    .replace(/\s+EM\s+COTAS\s+DE\s+FUNDOS\s+DE\s+INVESTIMENTO\s*$/i, "")
    .replace(/\s+EM\s+COTAS\s+DE\s*$/i, "")
    .replace(/\s+MULTIMERCADO\s*$/i, "")
    .replace(/\s+CRÉDITO\s+PRIVADO\s*$/i, "")
    .replace(/\s+CREDITO\s+PRIVADO\s*$/i, "")
    .replace(/\s+FIC\s*$/i, "")
    .replace(/\s+FI\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const aliases: Record<string, string> = {
    "NEXUM FIDC": "FIDC NEXUM JR",
    "FIDC NEXUM": "FIDC NEXUM JR",
    "NEXUM FIDC SR": "FIDC NEXUM SR",
    "FIDC NEXUM SR": "FIDC NEXUM SR",
    "FICFIF QI ALVORADA": "FICFIF QI ALVORA",
  };
  return aliases[normalized] ?? normalized;
}

/** Código Finvest 36517588 gerava CNPJ inexistente; JR e SR compartilham o CNPJ da classe. */
function canonicalizeCnpjPassivo(cnpj: string | null | undefined): string | null {
  const d = normalizeCnpj14Passivo(cnpj);
  if (!d) return null;
  if (d === "36517588000100") return "36517586000103";
  return d;
}

/** Extrai CNPJ de 14 dígitos de célula (texto ou formatado). Notação científica (3,39E+13) não é confiável — retorna null */
function extractCnpj14FromCell(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/[eE]/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 14) return digits;
  if (digits.length > 14) return digits.slice(-14);
  return null;
}

function colALooksLikeFundName(s: string): boolean {
  const t = String(s ?? '').trim();
  if (t.length < 3) return false;
  return /[A-Za-zÀ-ÿ]/.test(t);
}

function parseCsvFinvest(content: string, administradora: string): PassivoRow[] {
  const rows: PassivoRow[] = [];
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  /** Propaga nome/CNPJ da subclasse — linhas de cotista vêm com col A vazia e col D = CNPJ */
  let lastFundo = '';
  let lastCnpj: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(';');
    if (cols.length < 28) continue;
    const colA = sanitizeText(String(cols[0] ?? ''));
    const colD = sanitizeText(String(cols[3] ?? ''));
    const colCotista = sanitizeText(String(cols[11] ?? ''));
    const lowerD = colD.toLowerCase();
    if (
      i === 0 &&
      (lowerD === 'fundo' ||
        colCotista.toLowerCase() === 'cotista' ||
        (lowerD.includes('cnpj') && !extractCnpj14FromCell(colD)))
    ) {
      continue;
    }

    const cnpjColD = extractCnpj14FromCell(colD);
    const colAIsFundo =
      colALooksLikeFundName(colA) && !isInvalidPassivoFundoName(normalizeFundName(colA));
    const colDIsFundo =
      !cnpjColD &&
      colALooksLikeFundName(colD) &&
      !isInvalidPassivoFundoName(normalizeFundName(colD));

    if (colAIsFundo) {
      lastFundo = normalizeFundName(colA);
      if (cnpjColD) lastCnpj = cnpjColD;
    } else if (colDIsFundo) {
      lastFundo = normalizeFundName(colD);
    } else if (cnpjColD && lastFundo) {
      lastCnpj = cnpjColD;
    }

    let fundo: string;
    let fundo_cnpj_arquivo: string | null | undefined;

    if (colAIsFundo) {
      fundo = normalizeFundName(colA);
      fundo_cnpj_arquivo = cnpjColD ?? lastCnpj ?? undefined;
    } else if (colDIsFundo) {
      fundo = normalizeFundName(colD);
      fundo_cnpj_arquivo = lastCnpj ?? undefined;
    } else if (lastFundo) {
      fundo = lastFundo;
      fundo_cnpj_arquivo = cnpjColD ?? lastCnpj ?? undefined;
    } else {
      continue;
    }

    const cotista = colCotista;
    const valor = parseValorBrasil(cols[27]);
    if (!fundo || fundo === 'nan' || !cotista || cotista === 'nan' || valor <= 0) continue;
    if (isInvalidPassivoFundoName(fundo) || isPassivoMetaCotista(cotista)) continue;
    rows.push({ administradora, fundo, cotista, valor, fundo_cnpj_arquivo });
  }
  return rows;
}

/** Parse CSV (RFC 4180): vírgulas dentro de aspas; "" dentro de campo = aspas literais */
function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (inQuotes) {
      cur += c;
    } else if (c === ',') {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  cols.push(cur.trim());
  return cols;
}

/**
 * O CSV do BTG armazena valores monetários como CENTAVOS inteiros (sem ponto decimal).
 * Ex: "706572228" = 706.572.228 centavos = R$ 7.065.722,28
 * Se o valor parseado for inteiro → divide por 100.
 * Se vier com fração real (ex: ",28") → já está em reais, mantém.
 */
function parseBtgValor(v: string | null | undefined): number {
  const raw = v == null ? '' : String(v).trim().replace(/\s/g, '').replace(/^R\$/, '').replace(/[^\d,.-]/g, '');
  if (!raw) return 0;

  const lastComma = raw.lastIndexOf(',');
  const lastDot   = raw.lastIndexOf('.');
  const hasComma  = lastComma >= 0;
  const hasDot    = lastDot >= 0;

  let n: number;
  if (hasComma && hasDot) {
    n = lastComma > lastDot
      ? parseFloat(raw.replace(/\./g, '').replace(',', '.'))
      : parseFloat(raw.replace(/,/g, ''));
  } else if (hasComma) {
    const dec = raw.length - lastComma - 1;
    n = dec > 0 && dec <= 2 ? parseFloat(raw.replace(',', '.')) : parseFloat(raw.replace(/,/g, ''));
  } else if (hasDot) {
    const dec = raw.length - lastDot - 1;
    n = dec > 0 && dec <= 2 ? parseFloat(raw) : parseFloat(raw.replace(/\./g, ''));
  } else {
    n = parseFloat(raw);
  }

  if (!Number.isFinite(n) || n <= 0) return 0;

  // BTG: inteiros são centavos → divide por 100
  // Valores com fração (ex: 7065722.28) já estão em reais → mantém
  return Number.isInteger(n) ? n / 100 : n;
}

/**
 * BTG: CNPJ do fundo costuma vir em colunas após o nome (B–F) ou antes do valor; não usar col 0 (nome), 7 (cotista), 19 (valor).
 */
function findCnpj14InBtgRow(cols: string[]): string | null {
  const skip = new Set([0, 7, 19]);
  const early = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
  for (const i of early) {
    if (i >= cols.length) continue;
    const c = extractCnpj14FromCell(sanitizeText(String(cols[i] ?? '')));
    if (c) return c;
  }
  for (let i = 20; i < cols.length; i++) {
    if (skip.has(i)) continue;
    const c = extractCnpj14FromCell(sanitizeText(String(cols[i] ?? '')));
    if (c) return c;
  }
  return null;
}

function parseCsvBtg(content: string): PassivoRow[] {
  const rows: PassivoRow[] = [];
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 20) continue;
    const colFundo = sanitizeText(String(cols[0] ?? ''));
    const colCotista = sanitizeText(String(cols[7] ?? ''));
    if (i === 0 && (colFundo.toLowerCase() === 'fundo' || colCotista.toLowerCase() === 'cotista')) continue;
    const fundo = normalizeFundName(colFundo);
    const cotista = colCotista;
    const valor = parseBtgValor(cols[19]);
    if (!fundo || fundo === 'nan' || !cotista || cotista === 'nan' || valor <= 0) continue;
    if (isInvalidPassivoFundoName(fundo) || isPassivoMetaCotista(cotista)) continue;
    const fundo_cnpj_arquivo = findCnpj14InBtgRow(cols);
    rows.push({
      administradora: 'BTG',
      fundo,
      cotista,
      valor,
      ...(fundo_cnpj_arquivo ? { fundo_cnpj_arquivo } : {}),
    });
  }
  return rows;
}

/** Tokeniza nome de fundo para matching por overlap de palavras */
function tokenize(name: string): Set<string> {
  const stopWords = new Set(['DE', 'DO', 'DA', 'DOS', 'DAS', 'EM', 'E', 'A', 'O', 'NO', 'NA', 'COM', 'POR', 'PARA', 'CNPJ']);
  return new Set(
    name
      .toUpperCase()
      .replace(/[^A-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !stopWords.has(w))
  );
}

/** Calcula score de similaridade por overlap de tokens (Jaccard-like, ponderado pelo menor conjunto) */
function tokenSimilarity(a: string, b: string): number {
  const tokA = tokenize(a);
  const tokB = tokenize(b);
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokA) {
    if (tokB.has(t)) overlap++;
    else {
      for (const tb of tokB) {
        if (tb.startsWith(t) || t.startsWith(tb)) { overlap += 0.7; break; }
      }
    }
  }
  const minSize = Math.min(tokA.size, tokB.size);
  return overlap / minSize;
}

function aggregateByCotista(rows: PassivoRow[]): PassivoRow[] {
  const map = new Map<string, PassivoRow>();
  for (const r of rows) {
    const key = `${r.administradora}|${r.fundo}|${r.cotista}`;
    const existing = map.get(key);
    if (existing) {
      existing.valor += r.valor;
      if (r.fundo_cnpj_arquivo && !existing.fundo_cnpj_arquivo) {
        existing.fundo_cnpj_arquivo = r.fundo_cnpj_arquivo;
      }
    } else {
      map.set(key, { ...r });
    }
  }
  return Array.from(map.values());
}

/** Extrai CPF ou CNPJ embutido no nome do cotista, ex: "NOME ( 068.556.108-97 )" ou "FUNDO ( 61.846.544/0001-63 )" */
function extractCpfCnpjFromCotista(cotista: string): string | null {
  if (!cotista) return null;
  const match = cotista.match(/\(\s*([\d]{3}\.[\d]{3}\.[\d]{3}-[\d]{2}|[\d]{2}\.[\d]{3}\.[\d]{3}\/[\d]{4}-[\d]{2})\s*\)/);
  if (match) return match[1].replace(/\D/g, '');
  return null;
}

/** Extrai número de conta do cotista. Suporta: P/C, C/C, CC, e sequência de dígitos no final (BTG) */
function extractContaFromCotista(cotista: string): string | null {
  if (!cotista) return null;
  const s = String(cotista).trim();
  // P/C (XP e BTG): "XP...P/C497092" ou "BANCO BTG...P/C 000578993"
  let match = s.match(/P\/C\s*(\d+)/i) || s.match(/P\/C(\d+)/i);
  if (match) return normalizeContaNumero(match[1]);
  // C/C (BTG usa às vezes): "C/C 000578993"
  match = s.match(/C\/C\s*(\d+)/i) || s.match(/C\/C(\d+)/i);
  if (match) return normalizeContaNumero(match[1]);
  // CC (abreviação): "CC 000578993"
  match = s.match(/\bCC\s*(\d+)/i);
  if (match) return normalizeContaNumero(match[1]);
  // Sequência de 6+ dígitos no final (comum em BTG quando vem só o número)
  match = s.match(/(\d{6,})$/);
  if (match) return normalizeContaNumero(match[1]);
  return null;
}

/** Alias para compatibilidade */
function extractContaXpFromCotista(cotista: string): string | null {
  return extractContaFromCotista(cotista);
}

/** Normaliza números de conta: mantém apenas dígitos e remove zeros à esquerda */
function normalizeContaNumero(val: string | null | undefined): string | null {
  if (!val) return null;
  const digits = String(val).replace(/\D/g, '');
  if (!digits) return null;
  const withoutLeadingZeros = digits.replace(/^0+/, '');
  return withoutLeadingZeros || '0';
}

/** Normaliza nome para match (remove acentos, uppercase, trim) */
function normalizeNomeForMatch(name: string): string {
  return (name || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/["'`´]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove espaços para comparação de nomes "colados" (metade do nome etc.) */
function compactNome(name: string): string {
  return normalizeNomeForMatch(name).replace(/\s+/g, '');
}

function tokenizeNome(name: string): string[] {
  const stopWords = new Set([
    'DE', 'DO', 'DA', 'DOS', 'DAS', 'E', 'EM', 'NO', 'NA', 'PARA', 'COM',
    'CORRETORA', 'INVESTIMENTOS', 'BANCO', 'DTVM', 'CTVM', 'S', 'A', 'SA'
  ]);
  return normalizeNomeForMatch(name)
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !stopWords.has(w));
}

const SUBCLASSE_DISCRIMINATORS = new Set([
  'JR', 'SR', 'JUNIOR', 'SENIOR', 'CP', 'LP', 'I', 'II', 'III', 'IV', 'V',
]);

function extractSubclasseDiscriminators(name: string): Set<string> {
  return new Set(
    normalizeFundName(name)
      .split(/\s+/)
      .filter((t) => SUBCLASSE_DISCRIMINATORS.has(t)),
  );
}

function subclasseDiscriminatorsCompatible(a: string, b: string): boolean {
  const da = extractSubclasseDiscriminators(a);
  const db = extractSubclasseDiscriminators(b);
  if (da.size === 0 || db.size === 0) return true;
  for (const t of da) {
    if (db.has(t)) return true;
  }
  return false;
}

/** Variantes distintas no mesmo “eixo” (ex.: FIP QI TURBI vs FIP TURBI 2.0) — não cruzar CNPJ. */
function passivoFundNamesAreDistinctVariants(a: string, b: string): boolean {
  const na = normalizeFundName(a);
  const nb = normalizeFundName(b);
  if (!na || !nb || na === nb) return false;

  const versionRe = /\b(2\.0|3\.0|T2\.0|T3\.0)\b/;
  const aHasVer = versionRe.test(na);
  const bHasVer = versionRe.test(nb);
  if (aHasVer !== bHasVer) return true;

  const aHasQi = /\bQI\b/.test(na);
  const bHasQi = /\bQI\b/.test(nb);
  if (aHasQi !== bHasQi && (/\bTURBI\b/.test(na) || /\bTURBI\b/.test(nb))) return true;

  return false;
}

function nomeSimilarity(a: string, b: string): number {
  if (!subclasseDiscriminatorsCompatible(a, b)) return 0;
  if (passivoFundNamesAreDistinctVariants(a, b)) return 0;

  const aCompact = compactNome(a);
  const bCompact = compactNome(b);
  if (!aCompact || !bCompact) return 0;

  if (aCompact === bCompact) return 1;
  if (aCompact.length >= 6 && bCompact.includes(aCompact)) return 0.92;
  if (bCompact.length >= 6 && aCompact.includes(bCompact)) return 0.92;

  const tokA = tokenizeNome(a);
  const tokB = tokenizeNome(b);
  if (tokA.length === 0 || tokB.length === 0) return 0;

  let overlap = 0;
  for (const t of tokA) {
    if (tokB.includes(t)) {
      overlap++;
      continue;
    }
    for (const tb of tokB) {
      if (tb.startsWith(t) || t.startsWith(tb)) {
        overlap += 0.7;
        break;
      }
    }
  }
  return overlap / Math.max(tokA.length, tokB.length);
}

/** Busca passivo_cotista_de_para e retorna mapa para lookup de codigo_cliente */
async function buildDeParaLookup(supabaseClient: ReturnType<typeof createClient>): Promise<DeParaLookup> {
  const { data } = await supabaseClient
    .from("passivo_cotista_de_para")
    .select("codigo_cliente, nome_cliente, conta_xp, conta_btg, cpf_cnpj");
  const exactMap = new Map<string, number>();
  const nomeEntries: Array<{ normalized: string; compact: string; codigo: number }> = [];
  for (const row of (data || []) as { codigo_cliente: number; nome_cliente: string | null; conta_xp: string | null; conta_btg: string | null; cpf_cnpj: string | null }[]) {
    const contaXp = normalizeContaNumero(row.conta_xp);
    if (contaXp) {
      exactMap.set('xp:' + contaXp, row.codigo_cliente);
    }
    const contaBtg = normalizeContaNumero(row.conta_btg);
    if (contaBtg) {
      exactMap.set('btg:' + contaBtg, row.codigo_cliente);
    }
    const cpfCnpj = row.cpf_cnpj ? String(row.cpf_cnpj).replace(/\D/g, '') : null;
    if (cpfCnpj && cpfCnpj.length >= 11) {
      exactMap.set('cpf:' + cpfCnpj, row.codigo_cliente);
    }
    if (row.nome_cliente && String(row.nome_cliente).trim()) {
      const normalized = normalizeNomeForMatch(row.nome_cliente);
      const compact = compactNome(row.nome_cliente);
      if (normalized && !exactMap.has("nome:" + normalized)) {
        exactMap.set("nome:" + normalized, row.codigo_cliente);
      }
      if (normalized && compact) {
        nomeEntries.push({ normalized, compact, codigo: row.codigo_cliente });
      }
    }
  }
  return { exactMap, nomeEntries };
}

/** Resolve codigo_clt para um cotista usando o mapa De-Para */
function resolveCodigoClt(cotista: string, deParaLookup: DeParaLookup): number | null {
  if (!cotista) return null;

  const { exactMap, nomeEntries } = deParaLookup;

  // 1) Conta extraída (P/C, C/C, CC ou dígitos no final)
  const conta = extractContaFromCotista(cotista);
  if (conta) {
    const byXp = exactMap.get('xp:' + conta);
    if (byXp) return byXp;
    const byBtg = exactMap.get('btg:' + conta);
    if (byBtg) return byBtg;
  }

  // 1.5) CPF/CNPJ embutido no nome do cotista: "NOME ( 068.556.108-97 )"
  const cpfCnpj = extractCpfCnpjFromCotista(cotista);
  if (cpfCnpj) {
    const byCpf = exactMap.get('cpf:' + cpfCnpj);
    if (byCpf) return byCpf;
  }

  // 2) Nome exato normalizado
  const normalizedCotista = normalizeNomeForMatch(cotista);
  const nomeKey = "nome:" + normalizedCotista;
  const byNome = exactMap.get(nomeKey);
  if (byNome) return byNome;

  // 3) BTG numérico direto
  const contaNumericaDireta = normalizeContaNumero(cotista);
  if (contaNumericaDireta) {
    const byBtgDireta = exactMap.get("btg:" + contaNumericaDireta);
    if (byBtgDireta) return byBtgDireta;
  }

  // 4) Fuzzy nome (para casos de nome "pela metade")
  let bestCodigo: number | null = null;
  let bestScore = 0;
  let secondBest = 0;
  for (const entry of nomeEntries) {
    const score = nomeSimilarity(normalizedCotista, entry.normalized);
    if (score > bestScore) {
      secondBest = bestScore;
      bestScore = score;
      bestCodigo = entry.codigo;
    } else if (score > secondBest) {
      secondBest = score;
    }
  }

  // Aceita fuzzy somente com score bom e sem empate próximo
  if (bestCodigo != null && bestScore >= 0.78 && (bestScore - secondBest) >= 0.06) {
    return bestCodigo;
  }
  return null;
}

interface SubclasseInfo {
  isin: string;
  nome_comercial: string | null;
  denominacao_social: string | null;
}

interface FundIdentityContext {
  cnpjNomeMap: Map<string, string[]>;
  subclassesPorCnpj: Map<string, SubclasseInfo[]>;
  identityByNome: Map<string, { cnpj: string; isin: string | null }>;
}

function normalizeCnpj14Passivo(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = String(v).replace(/\D/g, '');
  if (d.length === 14) return d;
  if (d.length > 14) return d.slice(-14);
  return null;
}

function normalizeIsinPassivo(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim().toUpperCase();
  if (!s || s.includes('*')) return null;
  return s;
}

function registerIdentityByNome(
  map: Map<string, { cnpj: string; isin: string | null }>,
  nome: string | null | undefined,
  cnpjRaw: string | null | undefined,
  isinRaw: string | null | undefined,
) {
  const norm = normalizeFundName(String(nome ?? ''));
  const cnpj = normalizeCnpj14Passivo(cnpjRaw);
  if (!norm || !cnpj) return;
  const isin = normalizeIsinPassivo(isinRaw);
  const existing = map.get(norm);
  if (!existing) {
    map.set(norm, { cnpj, isin });
    return;
  }
  if (isin && !existing.isin) {
    map.set(norm, { cnpj, isin });
    return;
  }
  // Mesmo nome normalizado com ISINs distintos (ex.: cadastro só "FIDC NEXUM" para JR e SR)
  if (isin && existing.isin && isin !== existing.isin) {
    map.delete(norm);
  }
}

async function loadFundIdentityContext(): Promise<FundIdentityContext> {
  const cnpjNomeMap = new Map<string, string[]>();
  const subclassesPorCnpj = new Map<string, SubclasseInfo[]>();
  const identityByNome = new Map<string, { cnpj: string; isin: string | null }>();

  const { data: carteiraNomes } = await supabase
    .from('posicao_carteira')
    .select('fundo_cnpj, fundo_isin, nome_fundo, fundo_nome')
    .not('fundo_cnpj', 'is', null);

  for (const row of (carteiraNomes || []) as any[]) {
    const cnpjKey = normalizeCnpj14Passivo(row.fundo_cnpj);
    if (!cnpjKey) continue;
    const names = cnpjNomeMap.get(cnpjKey) || [];
    if (row.nome_fundo && !names.includes(row.nome_fundo)) names.push(row.nome_fundo);
    if (row.fundo_nome && !names.includes(row.fundo_nome)) names.push(row.fundo_nome);
    cnpjNomeMap.set(cnpjKey, names);
    registerIdentityByNome(identityByNome, row.nome_fundo, cnpjKey, row.fundo_isin);
    registerIdentityByNome(identityByNome, row.fundo_nome, cnpjKey, row.fundo_isin);
  }

  const { data: fcData } = await supabase
    .from('fundos_caracteristicas')
    .select('cnpj_fundo, cnpj_classe, isin, nome_comercial, denominacao_social');

  for (const row of (fcData || []) as any[]) {
    const cnpjKey = normalizeCnpj14Passivo(row.cnpj_fundo) || normalizeCnpj14Passivo(row.cnpj_classe);
    if (!cnpjKey) continue;

    const names = cnpjNomeMap.get(cnpjKey) || [];
    if (row.nome_comercial && !names.includes(row.nome_comercial)) names.push(row.nome_comercial);
    if (row.denominacao_social && !names.includes(row.denominacao_social)) names.push(row.denominacao_social);
    cnpjNomeMap.set(cnpjKey, names);

    const isinNorm = normalizeIsinPassivo(row.isin);
    if (isinNorm) {
      if (!subclassesPorCnpj.has(cnpjKey)) subclassesPorCnpj.set(cnpjKey, []);
      const arr = subclassesPorCnpj.get(cnpjKey)!;
      if (!arr.find((s) => s.isin === isinNorm)) {
        arr.push({
          isin: isinNorm,
          nome_comercial: row.nome_comercial || null,
          denominacao_social: row.denominacao_social || null,
        });
      }
      registerIdentityByNome(identityByNome, row.nome_comercial, cnpjKey, isinNorm);
      registerIdentityByNome(identityByNome, row.denominacao_social, cnpjKey, isinNorm);
    }
  }

  return { cnpjNomeMap, subclassesPorCnpj, identityByNome };
}

function resolveCnpjFromName(fundoName: string, cnpjNomeMap: Map<string, string[]>): string | null {
  const normalizedPassivo = normalizeFundName(fundoName);
  let bestCnpj: string | null = null;
  let bestScore = 0;

  for (const [cnpj, names] of cnpjNomeMap) {
    for (const name of names) {
      const normalizedName = normalizeFundName(name);

      if (normalizedPassivo === normalizedName) {
        return cnpj;
      }

      if (normalizedPassivo.length >= 10 && normalizedName.length >= 10) {
        if (passivoFundNamesAreDistinctVariants(normalizedPassivo, normalizedName)) continue;
        if (normalizedName.includes(normalizedPassivo) || normalizedPassivo.includes(normalizedName)) {
          if (0.9 > bestScore) {
            bestCnpj = cnpj;
            bestScore = 0.9;
          }
          continue;
        }
      }

      const sim = nomeSimilarity(normalizedPassivo, normalizedName);
      if (sim > bestScore && sim >= 0.78) {
        bestCnpj = cnpj;
        bestScore = sim;
      }
    }
    if (bestScore >= 1) break;
  }

  return bestCnpj;
}

function resolveIsinForPassivo(
  fundoName: string,
  cnpj: string | null,
  ctx: FundIdentityContext,
): string | null {
  const normName = normalizeFundName(fundoName);
  const direct = ctx.identityByNome.get(normName);
  if (direct?.isin) return direct.isin;

  if (cnpj) {
    const subclasses = ctx.subclassesPorCnpj.get(cnpj);
    if (subclasses && subclasses.length === 1) return subclasses[0].isin;
    if (subclasses && subclasses.length > 1) {
      for (const sc of subclasses) {
        for (const nome of [sc.nome_comercial, sc.denominacao_social]) {
          if (nome && normalizeFundName(nome) === normName) return sc.isin;
        }
      }

      let bestScore = 0;
      let bestIsin: string | null = null;
      let ambiguous = false;
      for (const sc of subclasses) {
        for (const nome of [sc.nome_comercial, sc.denominacao_social]) {
          if (!nome) continue;
          const score = nomeSimilarity(fundoName, nome);
          if (score > bestScore) {
            bestScore = score;
            bestIsin = sc.isin;
            ambiguous = false;
          } else if (score > 0 && score === bestScore && bestIsin !== sc.isin) {
            ambiguous = true;
          }
        }
      }
      if (!ambiguous && bestScore >= 0.85) return bestIsin;
    }
  }

  let bestScore = 0;
  let bestIsin: string | null = null;
  let ambiguous = false;
  for (const [nomeKey, identity] of ctx.identityByNome) {
    if (!identity.isin) continue;
    if (cnpj && identity.cnpj !== cnpj) continue;
    const score = nomeSimilarity(normName, nomeKey);
    if (score > bestScore && score >= 0.85) {
      bestScore = score;
      bestIsin = identity.isin;
      ambiguous = false;
    } else if (score > 0 && score === bestScore && score >= 0.85 && bestIsin !== identity.isin) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : bestIsin;
}

async function backfillPassivoIsinNullRows(ctx: FundIdentityContext): Promise<number> {
  const { data: rows } = await supabase
    .from('passivo_fundos')
    .select('id, fundo, fundo_cnpj, fundo_isin')
    .is('fundo_isin', null)
    .limit(50000);

  let updated = 0;
  for (const row of (rows || []) as { id: string; fundo: string; fundo_cnpj: string | null; fundo_isin: string | null }[]) {
    const cnpj = normalizeCnpj14Passivo(row.fundo_cnpj);
    const isin = resolveIsinForPassivo(row.fundo, cnpj, ctx);
    if (!isin) continue;
    const { error } = await supabase
      .from('passivo_fundos')
      .update({ fundo_isin: isin })
      .eq('id', row.id);
    if (!error) updated++;
  }
  return updated;
}

serve(async (req: Request) => {
  console.log('[import-passivo-fundos] Recebendo requisição:', req.method);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Content-Type deve ser multipart/form-data. Envie os arquivos no campo "files".',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const formData = await req.formData();
    const dataPosicaoParam = formData.get('data_posicao') as string | null;
    const today = new Date();
    const dataPosicao =
      dataPosicaoParam && /^\d{8}$/.test(dataPosicaoParam)
        ? dataPosicaoParam
        : `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

    const allRows: PassivoRow[] = [];

    // Dados de posição cotas (XLSX parseado no frontend)
    const posicaoCotasStr = formData.get('posicao_cotas_json') as string | null;
    if (posicaoCotasStr) {
      try {
        const parsed = JSON.parse(posicaoCotasStr) as Array<{ fundo: string; cotista: string; valor: number }>;
        for (const p of parsed) {
          const valor = parseValorBrasil(p.valor);
          if (p.fundo && p.cotista && valor > 0) {
            allRows.push({
              administradora: 'Posição Cotas',
              fundo: normalizeFundName(sanitizeText(String(p.fundo))),
              cotista: sanitizeText(String(p.cotista)),
              valor,
            });
          }
        }
        if (parsed.length > 0) console.log('[import-passivo-fundos] Recebidos', parsed.length, 'registros de posicao_cotas');
      } catch (e) {
        console.warn('[import-passivo-fundos] Erro ao parsear posicao_cotas_json:', e);
      }
    }

    // Dados de passivo Finvest via API Sinqia (import-sinqia-passivo)
    const finvestPassivoStr = formData.get('finvest_passivo_json') as string | null;
    if (finvestPassivoStr) {
      try {
        const parsed = JSON.parse(finvestPassivoStr) as Array<{
          fundo: string;
          cotista: string;
          valor: number;
          cnpj_fundo?: string;
        }>;
        for (const p of parsed) {
          const valor = parseValorBrasil(p.valor);
          if (!p.fundo || !p.cotista || valor <= 0) continue;
          const fundo_cnpj_arquivo = canonicalizeCnpjPassivo(extractCnpj14FromCell(String(p.cnpj_fundo ?? '')));
          allRows.push({
            administradora: 'FINVEST.API',
            fundo: normalizeFundName(sanitizeText(String(p.fundo))),
            cotista: sanitizeText(String(p.cotista)),
            valor,
            ...(fundo_cnpj_arquivo ? { fundo_cnpj_arquivo } : {}),
          });
        }
        if (parsed.length > 0) {
          console.log('[import-passivo-fundos] Recebidos', parsed.length, 'registros de finvest_passivo (API)');
        }
      } catch (e) {
        console.warn('[import-passivo-fundos] Erro ao parsear finvest_passivo_json:', e);
      }
    }

    // Dados de passivo Itaú/Intrag (XLSX parseado no frontend)
    const itauPassivoStr = formData.get('itau_passivo_json') as string | null;
    if (itauPassivoStr) {
      try {
        const parsed = JSON.parse(itauPassivoStr) as Array<{
          cliente: string;
          cpf: string;
          conta: string | null;
          fundo: string;
          cnpj_fundo: string;
          saldo_liquido: number;
        }>;
        for (const p of parsed) {
          const valor = parseValorBrasil(p.saldo_liquido);
          if (!p.cliente || !p.fundo || valor <= 0) continue;
          // Formata cotista como "NOME ( CPF )" para que extractCpfCnpjFromCotista resolva o codigo_clt
          const cpf = sanitizeText(String(p.cpf ?? ''));
          const cotista = cpf ? `${sanitizeText(p.cliente)} ( ${cpf} )` : sanitizeText(p.cliente);
          // CNPJ do fundo já vem formatado no arquivo (ex: "39.470.241/0001-30")
          const fundo_cnpj_arquivo = extractCnpj14FromCell(String(p.cnpj_fundo ?? ''));
          allRows.push({
            administradora: 'ITAU',
            fundo: normalizeFundName(sanitizeText(String(p.fundo))),
            cotista,
            valor,
            ...(fundo_cnpj_arquivo ? { fundo_cnpj_arquivo } : {}),
          });
        }
        if (parsed.length > 0) console.log('[import-passivo-fundos] Recebidos', parsed.length, 'registros de itau_passivo');
      } catch (e) {
        console.warn('[import-passivo-fundos] Erro ao parsear itau_passivo_json:', e);
      }
    }

    // Arquivos CSV
    const files = formData.getAll('files');
    const fileList = Array.isArray(files) ? files : files ? [files] : [];

    for (const file of fileList) {
      if (!(file instanceof File)) continue;
      const filename = file.name;

      // Lê como bytes e tenta UTF-8 primeiro; se houver caracteres de substituição (U+FFFD),
      // redecodifica com windows-1252 (encoding padrão de arquivos Windows/BTG/FINVEST)
      const buf = await file.arrayBuffer();
      let content = new TextDecoder('utf-8').decode(buf);
      if (content.includes('\uFFFD')) {
        content = new TextDecoder('windows-1252').decode(buf);
      }
      const source = detectImportSource(filename, content);
      if (!source) {
        console.log('[import-passivo-fundos] Ignorando arquivo (formato não reconhecido):', filename);
        continue;
      }

      const adminFromName = filename.toLowerCase().includes('btg')
        ? 'BTG'
        : filename.toLowerCase().includes('finvest')
          ? source === 'Finvest.Growth'
            ? 'Finvest.Growth'
            : 'FINVEST'
          : 'Posição Cotas';

      const finvestAdmin = source === 'Finvest.Growth' ? 'Finvest.Growth' : 'FINVEST';

      if (source === 'TABULAR') {
        const tabular = parseCsvTabular(content, adminFromName);
        if (tabular.length > 0) allRows.push(...tabular);
        else {
          const finvestRows = parseCsvFinvest(content, finvestAdmin);
          if (finvestRows.length > 0) allRows.push(...finvestRows);
          else {
            const btgRows = parseCsvBtg(content);
            if (btgRows.length > 0) allRows.push(...btgRows);
          }
        }
      } else if (source === 'BTG') {
        const btgRows = parseCsvBtg(content);
        if (btgRows.length > 0) allRows.push(...btgRows);
        else allRows.push(...parseCsvTabular(content, 'BTG'));
      } else if (source === 'FINVEST' || source === 'Finvest.Growth') {
        const finvestRows = parseCsvFinvest(content, finvestAdmin);
        if (finvestRows.length > 0) allRows.push(...finvestRows);
        else allRows.push(...parseCsvTabular(content, finvestAdmin));
      } else {
        const finvestRows = parseCsvFinvest(content, finvestAdmin);
        if (finvestRows.length > 0) allRows.push(...finvestRows);
        else allRows.push(...parseCsvTabular(content, adminFromName));
      }
      console.log('[import-passivo-fundos] Processado:', filename, '->', source);
    }

    const aggregated = aggregateByCotista(allRows);
    if (aggregated.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Nenhum registro válido encontrado nos arquivos. Verifique os formatos.',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Match De-Para: buscar cadastro mestre e resolver codigo_clt para cada cotista
    let codigosVinculados = 0;
    const deParaLookup = await buildDeParaLookup(supabase);
    for (const r of aggregated) {
      const codigo = resolveCodigoClt(r.cotista, deParaLookup);
      if (codigo != null) {
        (r as any).codigo_clt = codigo;
        codigosVinculados++;
      }
    }
    if (deParaLookup.exactMap.size > 0 || deParaLookup.nomeEntries.length > 0) {
      console.log(`[import-passivo-fundos] De-Para: ${codigosVinculados}/${aggregated.length} cotistas com codigo_clt`);
    }

    const identityCtx = await loadFundIdentityContext();
    const fundIdentityCache = new Map<string, { cnpj: string | null; isin: string | null }>();
    for (const r of aggregated) {
      if (fundIdentityCache.has(r.fundo)) continue;
      const normName = normalizeFundName(r.fundo);
      const cnpjFromFile = canonicalizeCnpjPassivo(r.fundo_cnpj_arquivo);
      const cnpjFromIdentity = identityCtx.identityByNome.get(normName)?.cnpj ?? null;
      const cnpj = canonicalizeCnpjPassivo(cnpjFromFile ?? cnpjFromIdentity ?? resolveCnpjFromName(r.fundo, identityCtx.cnpjNomeMap));
      const isin = resolveIsinForPassivo(r.fundo, cnpj, identityCtx);
      fundIdentityCache.set(r.fundo, { cnpj, isin });
      if (!cnpj) console.warn(`[import-passivo-fundos] Sem match CNPJ para: "${r.fundo}"`);
      if (cnpj && !isin) console.warn(`[import-passivo-fundos] Sem match ISIN para: "${r.fundo}" (CNPJ ${cnpj})`);
    }
    const cnpjsVinculados = [...fundIdentityCache.values()].filter((v) => v.cnpj).length;
    const isinsVinculados = [...fundIdentityCache.values()].filter((v) => v.isin).length;
    console.log(`[import-passivo-fundos] Identidade: ${cnpjsVinculados}/${fundIdentityCache.size} CNPJs, ${isinsVinculados}/${fundIdentityCache.size} ISINs`);

    // Substituir só os fundos deste upload — preserva JR/SR/outros na mesma administradora e data
    const fundosPorAdmin = new Map<string, Set<string>>();
    for (const r of aggregated) {
      const admin = String(r.administradora ?? '').trim();
      const fundo = String(r.fundo ?? '').trim();
      if (!admin || !fundo) continue;
      if (!fundosPorAdmin.has(admin)) fundosPorAdmin.set(admin, new Set());
      fundosPorAdmin.get(admin)!.add(fundo);
    }
    let fundosSubstituidos = 0;
    for (const [admin, fundos] of fundosPorAdmin) {
      for (const fundo of fundos) {
        const { error: delErr } = await supabase
          .from('passivo_fundos')
          .delete()
          .eq('data_posicao', dataPosicao)
          .eq('administradora', admin)
          .eq('fundo', fundo);
        if (delErr) {
          console.error(`[import-passivo-fundos] Erro ao deletar ${admin}/${fundo} (${dataPosicao}):`, delErr);
        } else {
          fundosSubstituidos++;
        }
      }
    }
    const administradorasImportadas = [...fundosPorAdmin.keys()];
    console.log(
      `[import-passivo-fundos] Substituídos ${fundosSubstituidos} fundo(s) em ${dataPosicao}:`,
      [...fundosPorAdmin.entries()].map(([a, fs]) => `${a}=[${[...fs].join(', ')}]`).join('; '),
    );

    const records = aggregated.map((r) => {
      const identity = fundIdentityCache.get(r.fundo);
      return {
        administradora: r.administradora,
        fundo: r.fundo,
        fundo_cnpj: identity?.cnpj ?? normalizeCnpj14Passivo(r.fundo_cnpj_arquivo),
        fundo_isin: identity?.isin ?? null,
        cotista: r.cotista,
        valor: r.valor,
        data_posicao: dataPosicao,
        codigo_clt: (r as any).codigo_clt ?? null,
      };
    });

    const BATCH = 200;
    let total = 0;
    let omitIsinColumn = false;

    const insertBatch = async (batch: Record<string, unknown>[]) => {
      const payload = omitIsinColumn
        ? batch.map(({ fundo_isin: _isin, ...rest }) => rest)
        : batch;
      return supabase.from('passivo_fundos').insert(payload);
    };

    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH);
      let { error } = await insertBatch(batch);
      if (error && !omitIsinColumn && /fundo_isin/i.test(error.message)) {
        console.warn('[import-passivo-fundos] Coluna fundo_isin ausente — reinsert sem ISIN. Rode a migration 20260615120000.');
        omitIsinColumn = true;
        ({ error } = await insertBatch(batch));
      }
      if (error) {
        console.error('[import-passivo-fundos] Erro no batch:', error);
        return new Response(
          JSON.stringify({
            success: false,
            error: `Erro ao inserir dados: ${error.message}`,
            inserted: total,
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      total += batch.length;
    }

    console.log('[import-passivo-fundos] Importados', total, 'registros para data', dataPosicao);

    let isinsBackfill = 0;
    try {
      isinsBackfill = await backfillPassivoIsinNullRows(identityCtx);
      if (isinsBackfill > 0) {
        console.log(`[import-passivo-fundos] Backfill ISIN: ${isinsBackfill} registros históricos atualizados`);
      }
    } catch (e) {
      console.warn('[import-passivo-fundos] Erro no backfill de ISIN:', e);
    }

    const fundosSubstituidosLista = [...fundosPorAdmin.entries()]
      .flatMap(([admin, fundos]) => [...fundos].map((f) => `${f} (${admin})`));

    const msgParts = [
      `Passivo importado: ${total} registros`,
      `${cnpjsVinculados} fundos com CNPJ`,
      `${isinsVinculados} fundos com ISIN`,
      `fundos substituídos: ${fundosSubstituidosLista.join(', ') || '—'}`,
    ];
    if (codigosVinculados > 0) msgParts.push(`${codigosVinculados} cotistas com Código Cliente`);
    msgParts.push(`(${dataPosicao.slice(6, 8)}/${dataPosicao.slice(4, 6)}/${dataPosicao.slice(0, 4)})`);

    return new Response(
      JSON.stringify({
        success: true,
        recordsInserted: total,
        cnpjsVinculados,
        isinsVinculados,
        isinsBackfill,
        codigosCltVinculados: codigosVinculados,
        dataPosicao,
        administradorasSubstituidas: administradorasImportadas,
        fundosSubstituidos: fundosSubstituidosLista,
        message: msgParts.join(', ') + '.',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[import-passivo-fundos] Erro:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
