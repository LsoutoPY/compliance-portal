import { useState, useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { CvmInformesPanel } from "@/components/CvmInformesPanel";
import "./import-workspace.css";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Upload, 
  FileCode, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  Trash2,
  Loader2,
  FileUp,
  Terminal,
  ChevronDown,
  ChevronUp,
  Table2,
  Droplets,
  Users,
  Calendar,
  Receipt,
  Briefcase,
  Landmark,
  Database,
  History,
  Info,
  Wallet,
  TrendingUp,
  Layers,
  FileSpreadsheet,
  CloudDownload,
  ShieldCheck,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import * as XLSX from "xlsx";

// ── Parser ANBIMA (executa no browser para evitar WORKER_RESOURCE_LIMIT) ──────
interface AnbimaFundoRecord {
  codigo_anbima: string | null;
  estrutura: string | null;
  nome_comercial: string | null;
  denominacao_social: string | null;
  cnpj_classe: string | null;
  cnpj_fundo: string | null;
  isin: string | null;
  status: string | null;
  data_inicio_atividade: string | null;
  quantidade_subclasses: number | null;
  categoria_anbima: string | null;
  tipo_anbima: string | null;
  composicao_fundo: string | null;
  aberto_estatutariamente: string | null;
  fundo_esg: string | null;
  tributacao_alvo: string | null;
  administrador: string | null;
  gestor_principal: string | null;
  primeiro_aporte: string | null;
  tipo_investidor: string | null;
  caracteristica_investidor: string | null;
  cota_abertura: string | null;
  aplicacao_inicial_minima: number | null;
  prazo_pagamento_resgate_dias: number | null;
  adaptado_175: string | null;
  codigo_cvm_subclasse: string | null;
  foco_atuacao: string | null;
  nivel1_categoria: string | null;
  nivel2_categoria: string | null;
  nivel3_subcategoria: string | null;
  updated_at: string;
}

const ANBIMA_HEADER_MAP: Array<{ fragments: string[]; field: keyof AnbimaFundoRecord }> = [
  { fragments: ['codigo anbima', 'cod anbima', 'codigo_anbima'],       field: 'codigo_anbima' },
  { fragments: ['estrutura'],                                            field: 'estrutura' },
  { fragments: ['nome comercial'],                                       field: 'nome_comercial' },
  { fragments: ['denominacao social', 'denominacao_social'],             field: 'denominacao_social' },
  { fragments: ['cnpj da classe', 'cnpj classe', 'cnpj_classe'],        field: 'cnpj_classe' },
  { fragments: ['cnpj do fundo', 'cnpj fundo', 'cnpj_fundo'],           field: 'cnpj_fundo' },
  { fragments: ['codigo isin', 'cod isin', 'isin da cota', 'isin subclasse', 'isin'], field: 'isin' },
  { fragments: ['status'],                                               field: 'status' },
  { fragments: ['data de inicio', 'data inicio atividade', 'inicio ativ'], field: 'data_inicio_atividade' },
  { fragments: ['quantidade de subclass', 'qtd subclass'],              field: 'quantidade_subclasses' },
  { fragments: ['categoria anbima', 'categoria_anbima'],                 field: 'categoria_anbima' },
  { fragments: ['tipo anbima', 'tipo_anbima'],                           field: 'tipo_anbima' },
  { fragments: ['composicao do fundo', 'composicao fundo', 'composicao_fundo'], field: 'composicao_fundo' },
  { fragments: ['aberto estatutariamente', 'aberto_estad'],             field: 'aberto_estatutariamente' },
  { fragments: ['fundo esg', 'esg'],                                    field: 'fundo_esg' },
  { fragments: ['tributacao alvo', 'tributacao_alvo'],                  field: 'tributacao_alvo' },
  { fragments: ['gestor principal', 'gestor_principal'],                field: 'gestor_principal' },
  { fragments: ['administrador'],                                        field: 'administrador' },
  { fragments: ['primeiro aporte', 'primeiro_aporte'],                  field: 'primeiro_aporte' },
  { fragments: ['caracteristica do investidor', 'caracteristica invest', 'caracteristica_investidor'], field: 'caracteristica_investidor' },
  { fragments: ['tipo de investidor', 'tipo investidor', 'tipo_investidor'], field: 'tipo_investidor' },
  { fragments: ['cota de abertura', 'cota abertura', 'cota_abertura'],  field: 'cota_abertura' },
  { fragments: ['aplicacao inicial', 'aplic inicial', 'aplic minima'],  field: 'aplicacao_inicial_minima' },
  { fragments: ['prazo de pagamento', 'prazo pagamento resgate', 'prazo resgate dias', 'prazo_pagamento'], field: 'prazo_pagamento_resgate_dias' },
  { fragments: ['adaptado 175', 'adapt 175', 'adaptado_175'],          field: 'adaptado_175' },
  { fragments: ['codigo cvm da subclasse', 'cod cvm subclasse', 'codigo_cvm_subclasse'], field: 'codigo_cvm_subclasse' },
  { fragments: ['foco de atuacao', 'foco atuacao', 'foco_atuacao'],    field: 'foco_atuacao' },
  { fragments: ['nivel 1', 'nivel1', 'nivel i '],                      field: 'nivel1_categoria' },
  { fragments: ['nivel 2', 'nivel2', 'nivel ii'],                      field: 'nivel2_categoria' },
  { fragments: ['nivel 3', 'nivel3', 'nivel iii', 'subcategoria'],     field: 'nivel3_subcategoria' },
];

function _normalizeAnbimaHeader(h: unknown): string {
  return String(h ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function _parseAnbimaCnpj(val: unknown): string | null {
  if (val == null) return null;
  const d = String(val).replace(/\D/g, '');
  return d.length === 0 ? null : d.padStart(14, '0').slice(-14);
}
/** Anos fora deste intervalo viram null — evita serial Excel mal lido (IDs/códigos) gerarem datas tipo ano 29222 e o Postgres falhar em timestamptz. */
const ANBIMA_DATE_MIN_YEAR = 1900;
const ANBIMA_DATE_MAX_YEAR = 2100;

function _anbimaYearInRange(y: number): boolean {
  return Number.isFinite(y) && y >= ANBIMA_DATE_MIN_YEAR && y <= ANBIMA_DATE_MAX_YEAR;
}

function _parseAnbimaDate(val: unknown): string | null {
  if (val == null || val === '') return null;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0) return null;
    // Só trata como serial Excel se estiver na faixa plausível (~1900–2400). Valores grandes são IDs/códigos.
    const serial = Math.floor(val);
    if (serial < 1 || serial > 200_000) return null;
    const dt = new Date((serial - 25569) * 86400 * 1000);
    if (isNaN(dt.getTime())) return null;
    const y = dt.getUTCFullYear();
    if (!_anbimaYearInRange(y)) return null;
    return `${y}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }
  const s = String(val).trim();
  const dmY = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmY) {
    const y = parseInt(dmY[3], 10);
    if (!_anbimaYearInRange(y)) return null;
    return `${dmY[3]}-${dmY[2]}-${dmY[1]}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const y = parseInt(s.slice(0, 4), 10);
    if (!_anbimaYearInRange(y)) return null;
    return s.slice(0, 10);
  }
  const p = new Date(s);
  if (isNaN(p.getTime())) return null;
  const y = p.getFullYear();
  if (!_anbimaYearInRange(y)) return null;
  return p.toISOString().slice(0, 10);
}
function _parseAnbimaNumber(val: unknown): number | null {
  if (val == null || val === '') return null;
  if (typeof val === 'number') return isNaN(val) ? null : val;
  const n = parseFloat(String(val).replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}
function _parseAnbimaText(val: unknown): string | null {
  if (val == null) return null;
  const s = String(val).trim();
  return s === '' || s.toLowerCase() === 'nan' || s.toLowerCase() === 'null' ? null : s;
}

/** Texto exibido na célula (.w), evitando que "C0000…" vire número e perca o prefixo C/S. */
function _readAnbimaCellDisplay(ws: XLSX.WorkSheet, rowIdx: number, colIdx: number): unknown {
  const addr = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
  const cell = ws[addr] as { w?: string; v?: unknown } | undefined;
  if (cell == null) return null;
  const w = cell.w != null ? String(cell.w).trim() : "";
  if (w !== "") return cell.w;
  return cell.v ?? null;
}

/** Código ANBIMA (ex.: C0000638234, S0000651771). Prefira texto na planilha; número puro não é aceito (perde C/S). */
function _parseAnbimaCodigoAnbima(val: unknown): string | null {
  if (val == null || val === "") return null;
  if (typeof val === "number" && Number.isFinite(val)) {
    return null;
  }
  let s = String(val).trim().replace(/\u00A0/g, " ");
  if (s === "" || /^nan$/i.test(s) || /^null$/i.test(s)) return null;
  s = s.replace(/^['"]|['"]$/g, "").trim();
  const up = s.toUpperCase();
  if (/^[CS]\d{8,14}$/.test(up)) return up;
  return null;
}

async function parseAnbimaXlsx(file: File): Promise<AnbimaFundoRecord[]> {
  const arrayBuffer = await file.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(arrayBuffer), {
    type: 'array', cellDates: false, cellNF: false, cellHTML: false, cellText: false, raw: false,
  });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const allRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: false });

  // Localiza cabeçalho
  let headerIdx = -1;
  for (let i = 0; i < Math.min(10, allRows.length); i++) {
    const row = allRows[i] as unknown[];
    const nonEmpty = row.filter(c => c != null && String(c).trim() !== '');
    if (nonEmpty.length >= 4) {
      const norm = row.map(_normalizeAnbimaHeader);
      if (norm.some(h => ANBIMA_HEADER_MAP.some(m => m.fragments.some(f => h.includes(f))))) {
        headerIdx = i;
        break;
      }
    }
  }
  if (headerIdx === -1) throw new Error('Cabeçalho não reconhecido. Verifique se é a planilha ANBIMA FUNDOS-175-CARACTERISTICAS-PUBLICO.');

  const headers = (allRows[headerIdx] as unknown[]).map(h => String(h ?? ''));
  const colMap = new Map<number, keyof AnbimaFundoRecord>();
  const usedFields = new Set<keyof AnbimaFundoRecord>();
  headers.forEach((raw, colIdx) => {
    const norm = _normalizeAnbimaHeader(raw);
    if (!norm) return;
    for (const { fragments, field } of ANBIMA_HEADER_MAP) {
      if (usedFields.has(field)) continue;
      if (fragments.some(f => norm.includes(f))) { colMap.set(colIdx, field); usedFields.add(field); break; }
    }
  });

  const now = new Date().toISOString();
  const records: AnbimaFundoRecord[] = [];

  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const row = allRows[i] as unknown[];
    if (!row || row.every(c => c == null || String(c).trim() === '')) continue;

    const rec: Partial<AnbimaFundoRecord> = { updated_at: now };
    for (const [idx, field] of colMap) {
      const val = field === "codigo_anbima" ? _readAnbimaCellDisplay(ws, i, idx) : row[idx];
      switch (field) {
        case "codigo_anbima":
          rec.codigo_anbima = _parseAnbimaCodigoAnbima(val);
          break;
        case "cnpj_classe":
        case "cnpj_fundo":
          rec[field] = _parseAnbimaCnpj(val);
          break;
        case "data_inicio_atividade":
        case "primeiro_aporte":
          rec[field] = _parseAnbimaDate(val);
          break;
        case "quantidade_subclasses": {
          const n = _parseAnbimaNumber(val);
          rec[field] = n != null ? Math.round(n) : null;
          break;
        }
        case "aplicacao_inicial_minima":
        case "prazo_pagamento_resgate_dias":
          rec[field] = _parseAnbimaNumber(val);
          break;
        default:
          rec[field] = _parseAnbimaText(val);
      }
    }
    if (!rec.cnpj_classe && !rec.cnpj_fundo) continue;
    records.push(rec as AnbimaFundoRecord);
  }

  return records;
}

/** Tamanho máximo do JSON por POST (caracteres). Alinhado ao limite da Edge Function (~2,5 MB em bytes). */
const ANBIMA_IMPORT_MAX_BODY_CHARS = 1_200_000;

async function postFundosCaracteristicasBatches(
  records: AnbimaFundoRecord[],
  baseFilename: string,
  url: string,
  accessToken: string | undefined,
): Promise<{ upserted: number; inserted: number }> {
  let upserted = 0;
  let inserted = 0;
  let off = 0;
  const n = records.length;
  /** Começa pequeno; lotes grandes geram 502 no gateway antes do worker. */
  const initialChunk = 80;

  while (off < n) {
    let end = Math.min(off + initialChunk, n);
    let slice = records.slice(off, end);
    let body = JSON.stringify({
      records: slice,
      filename: `${baseFilename} (${off + 1}–${end}/${n})`,
    });

    while (body.length > ANBIMA_IMPORT_MAX_BODY_CHARS && end > off + 1) {
      end = off + Math.max(1, Math.floor((end - off) / 2));
      slice = records.slice(off, end);
      body = JSON.stringify({
        records: slice,
        filename: `${baseFilename} (${off + 1}–${end}/${n})`,
      });
    }

    if (body.length > ANBIMA_IMPORT_MAX_BODY_CHARS) {
      throw new Error(
        'Um único registro gera payload acima do limite. Verifique linhas com texto muito longo na planilha.',
      );
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    const text = await res.text();
    let json: {
      success?: boolean;
      error?: string;
      summary?: {
        total: number;
        upserted_com_codigo_anbima: number;
        inserted_sem_codigo_anbima: number;
      };
    };
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        res.ok
          ? 'Resposta inválida do servidor.'
          : `Falha HTTP ${res.status}. Se o log mostrar dezenas de MB em uma única requisição, o site em produção ainda não está com o envio em lotes — faça deploy do front-end.`,
      );
    }

    if (!res.ok || !json.success) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }

    upserted += json.summary?.upserted_com_codigo_anbima ?? 0;
    inserted += json.summary?.inserted_sem_codigo_anbima ?? 0;
    off = end;
  }

  return { upserted, inserted };
}
// ── Fim do parser ANBIMA ───────────────────────────────────────────────────────

interface ProcessResult {
  filename: string;
  success: boolean;
  records: number;
  fundo_cnpj?: string;
  fundo_dtposicao?: string;
  nome_fundo?: string;
  validation?: {
    plInformado: number;
    plCalculado: number;
    diffPerc: number;
    status: string;
  };
  newAssets?: {
    tipo_ativo: string;
    descricao: string | null;
    isin: string | null;
    cnpj: string | null;
    ticker: string | null;
  }[];
  errors?: string[];
  error?: string;
}

interface ImportResponse {
  success: boolean;
  summary: {
    totalFiles: number;
    successFiles: number;
    errorFiles: number;
    totalRecords: number;
  };
  results: ProcessResult[];
  error?: string;
}

interface NewAssetSummaryItem {
  key: string;
  label: string;
}

interface MatrizAnbimaResponse {
  success: boolean;
  filename?: string;
  recordsInserted?: number;
  message?: string;
  error?: string;
  inserted?: number;
}


interface ResgatesResponse {
  success: boolean;
  recordsInserted?: number;
  message?: string;
  error?: string;
}

interface ControleCotasResponse {
  success: boolean;
  recordsRaw?: number;
  recordsSerie?: number;
  recordsMetricas?: number;
  clientesImpactados?: string[];
  errors?: string[];
  message?: string;
  error?: string;
}

interface FidcMensalImportResponse {
  success: boolean;
  competencia?: string;
  competencias?: string[];
  zip_url?: string;
  data_referencia?: string;
  files_processed?: string[];
  imported?: number;
  cotistas_importados?: number;
  carga_completa?: boolean;
  aviso?: string;
  errors: string[];
}

interface DespesasArquivoResult {
  arquivo: string;
  formato: string;
  total: number;
  inserted: number;
  skipped: number;
  erros: string[];
}

interface DespesasImportResponse {
  ok: boolean;
  total_arquivos: number;
  total_registros: number;
  total_importados: number;
  arquivos: DespesasArquivoResult[];
  error?: string;
}

interface EstoqueFidcImportResponse {
  success: boolean;
  import_id?: string;
  fund_name?: string | null;
  fund_document?: string | null;
  reference_date?: string | null;
  total_rows?: number;
  imported_rows?: number;
  rejected_rows?: number;
  status?: string;
  errors?: string[];
  message?: string;
  duplicate_warning?: string | null;
  error?: string;
}

interface ImportacaoEstoqueFidc {
  id: string;
  created_at: string;
  file_name: string;
  fund_name: string | null;
  fund_document: string | null;
  reference_date: string | null;
  status: string;
  total_rows: number;
  imported_rows: number;
  rejected_rows: number;
  error_message: string | null;
}

/** Tenta extrair uma data ISO (YYYY-MM-DD) a partir do nome do arquivo */
function extractDateFromFilename(filename: string): string {
  // YYYY-MM-DD
  let m = filename.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
  // YYYYMMDD (com validação de mês/dia)
  m = filename.match(/(?<!\d)(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // DD/MM/YYYY ou DD-MM-YYYY
  m = filename.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[3]}-${m[2]}-${m[1]}`;
  return "";
}

function parseValorBrasil(v: unknown): number {
  if (v == null) return 0;
  let n: number;
  if (typeof v === "number" && !isNaN(v)) {
    n = v;
  } else {
    const s = String(v).trim().replace(/\./g, "").replace(",", ".");
    n = parseFloat(s);
    if (isNaN(n)) return 0;
  }
  // Heurística: valores >= 1e9 podem estar em centavos (9.443.493.089 centavos = 94.434.930,89 R$)
  return n >= 1e9 ? n / 100 : n;
}

function extrairNomeInvestidor(texto: string): string | null {
  if (!texto?.includes("Investidor:")) return null;
  const s = texto.split("Investidor:").pop()?.trim() ?? "";
  if (s.includes(" Valor de Cota:")) return s.split(" Valor de Cota:")[0].trim();
  if (s.includes("Valor de Cota:")) return s.split("Valor de Cota:")[0].trim();
  return s || null;
}

async function parsePosicaoCotasXlsx(file: File): Promise<{ fundo: string; cotista: string; valor: number }[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const rows: { fundo: string; cotista: string; valor: number }[] = [];
  let fundo = "Fundo não identificado";

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
    const fundoCell = ws["B1"];
    if (fundoCell?.v) fundo = String(fundoCell.v).trim();

    let currentInvestor: string | null = null;
    const maxCol = Math.min(range.e.c + 1, 25);

    for (let r = range.s.r; r <= range.e.r; r++) {
      let rowText = "";
      for (let c = 0; c < maxCol; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell?.v) rowText += " " + String(cell.v).trim();
      }

      if (rowText.includes("Investidor:")) currentInvestor = extrairNomeInvestidor(rowText);
      if (!currentInvestor) continue;

      const rowLower = rowText.toLowerCase();
      if (!rowLower.includes("total")) continue;

      let v = parseValorBrasil(ws[XLSX.utils.encode_cell({ r, c: 6 })]?.v);
      if (v <= 0) v = parseValorBrasil(ws[XLSX.utils.encode_cell({ r, c: 5 })]?.v);
      if (v <= 0) v = parseValorBrasil(ws[XLSX.utils.encode_cell({ r, c: 14 })]?.v);
      if (v > 0) rows.push({ fundo, cotista: currentInvestor, valor: v });
    }
    if (rows.length > 0) break;
  }
  return rows;
}

interface XmlGapRow {
  fundo_cnpj: string;
  nome_fundo: string;
  data_faltante: string;
}

function ontemBr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

interface BtgImportJobResult {
  cnpj: string;
  nome: string;
  data: string;
  status: "ok" | "skipped" | "error";
  filename?: string;
  records?: number;
  error?: string;
}

interface BtgImportResponse {
  success: boolean;
  summary: {
    totalJobs: number;
    skipped: number;
    successFiles: number;
    errorFiles: number;
    totalRecords: number;
    partial?: boolean;
  };
  jobs: BtgImportJobResult[];
  importResults?: ImportResponse[];
  log: string[];
  error?: string;
}

interface SinqiaImportJobResult {
  codigo: string;
  nome: string;
  data: string;
  status: "ok" | "skipped" | "error";
  filename?: string;
  records?: number;
  error?: string;
}

interface SinqiaImportResponse {
  success: boolean;
  summary: BtgImportResponse["summary"];
  jobs: SinqiaImportJobResult[];
  importResults?: ImportResponse[];
  log: string[];
  error?: string;
}

export default function ImportXml() {
  type ImportTab = "xml" | "cvm" | "matriz" | "fip" | "fidc" | "estoque-fidc" | "despesas" | "carteira-finvest" | "caixa-fluxo" | "fundos-caracteristicas";
  const isImportTab = (value: string | undefined): value is ImportTab =>
    value === "xml" ||
    value === "cvm" ||
    value === "matriz" ||
    value === "fip" ||
    value === "fidc" ||
    value === "estoque-fidc" ||
    value === "despesas" ||
    value === "fundos-caracteristicas";

  const [files, setFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [results, setResults] = useState<ProcessResult[] | null>(null);
  const [summary, setSummary] = useState<ImportResponse["summary"] | null>(null);
  const [isLogExpanded, setIsLogExpanded] = useState(false);

  // Matriz ANBIMA
  const [matrizFile, setMatrizFile] = useState<File | null>(null);
  const [isMatrizUploading, setIsMatrizUploading] = useState(false);
  const [matrizResult, setMatrizResult] = useState<MatrizAnbimaResponse | null>(null);


  // Resgates (Histórico)
  const [resgatesFile, setResgatesFile] = useState<File | null>(null);
  const [isResgatesUploading, setIsResgatesUploading] = useState(false);
  const [resgatesResult, setResgatesResult] = useState<ResgatesResponse | null>(null);
  const [resgatesDataRef, setResgatesDataRef] = useState<string>("");

  // Controle Cotas — multi-arquivo
  const [cotasFiles, setCotasFiles] = useState<Array<{ file: File; date: string }>>([]);
  const [isCotasUploading, setIsCotasUploading] = useState(false);
  const [cotasProgress, setCotasProgress] = useState<{ current: number; total: number } | null>(null);
  const [cotasBatchResults, setCotasBatchResults] = useState<Array<{
    filename: string;
    date: string;
    success: boolean;
    recordsSerie?: number;
    recordsMetricas?: number;
    clientesImpactados?: string[];
    message?: string;
    errors?: string[];
    error?: string;
  }>>([]);
  const [cotasDataFallback, setCotasDataFallback] = useState<string>("");

  // ── Carteira Finvest ────────────────────────────────────────────────────
  interface FinvestFileResult {
    filename: string;
    success: boolean;
    import_id?: string;
    data_posicao?: string;
    fundos_processados?: string[];
    total_rows?: number;
    imported_rows?: number;
    rejected_rows?: number;
    consolidados?: number;
    flags_revisao?: number;
    somente_csv?: number;
    parse_errors?: string[];
    error?: string;
  }
  const [finvestFiles, setFinvestFiles] = useState<File[]>([]);
  const [isFinvestUploading, setIsFinvestUploading] = useState(false);
  const [finvestProgress, setFinvestProgress] = useState<{ current: number; total: number } | null>(null);
  const [finvestResults, setFinvestResults] = useState<FinvestFileResult[]>([]);

  // Características ANBIMA
  interface FundosCaracteristicasResult {
    success: boolean;
    filename?: string;
    summary?: {
      total: number;
      upserted_com_codigo_anbima: number;
      inserted_sem_codigo_anbima: number;
    };
    message?: string;
    error?: string;
  }
  const [fundosCaractFile, setFundosCaractFile] = useState<File | null>(null);
  const [isFundosCaractUploading, setIsFundosCaractUploading] = useState(false);
  const [fundosCaractResult, setFundosCaractResult] = useState<FundosCaracteristicasResult | null>(null);

  // Caixa Fluxo Financeiro
  interface CaixaFluxoPorFundo { cnpj: string; nome: string | null; count: number; }
  interface CaixaFluxoResult {
    success: boolean;
    inserted?: number;
    linhasResgate?: number;
    totalLinhas?: number;
    colunasDetectadas?: Record<string, number>;
    porFundo?: CaixaFluxoPorFundo[];
    message?: string;
    error?: string;
  }
  const [caixaFluxoFile, setCaixaFluxoFile] = useState<File | null>(null);
  const [isCaixaFluxoUploading, setIsCaixaFluxoUploading] = useState(false);
  const [caixaFluxoResult, setCaixaFluxoResult] = useState<CaixaFluxoResult | null>(null);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const navState = location.state as { tab?: string; competencia?: string } | null;
  const defaultTab: ImportTab = isImportTab(navState?.tab)
    ? navState.tab
    : (location.pathname.startsWith("/liquidez") ? "matriz" : "cvm");
  const [activeTab, setActiveTab] = useState<ImportTab>(defaultTab);

  // FIP Informe Quadrimestral
  const [isFipImporting, setIsFipImporting] = useState(false);
  const [fipImportResult, setFipImportResult] = useState<{ success: boolean; imported: number; errors: string[] } | null>(null);
  
  // FIDC Informe Mensal
  const [isFidcMensalImporting, setIsFidcMensalImporting] = useState(false);
  const [fidcMensalImportResult, setFidcMensalImportResult] = useState<FidcMensalImportResponse | null>(null);

  // Despesas Fundos
  const [despesasFiles, setDespesasFiles] = useState<File[]>([]);
  const [isDespesasUploading, setIsDespesasUploading] = useState(false);
  const [despesasResult, setDespesasResult] = useState<DespesasImportResponse | null>(null);

  // Estoque FIDC (Frontis)
  const [estoqueFidcFile, setEstoqueFidcFile] = useState<File | null>(null);
  const [isEstoqueFidcUploading, setIsEstoqueFidcUploading] = useState(false);
  const [estoqueFidcResult, setEstoqueFidcResult] = useState<EstoqueFidcImportResponse | null>(null);
  const [estoqueFidcHistory, setEstoqueFidcHistory] = useState<ImportacaoEstoqueFidc[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // ── Gaps de XML ─────────────────────────────────────────────────────────
  const [xmlGaps, setXmlGaps] = useState<XmlGapRow[]>([]);
  const [isLoadingXmlGaps, setIsLoadingXmlGaps] = useState(false);

  // ── Importação automática BTG ───────────────────────────────────────────
  const [btgDataIni, setBtgDataIni] = useState(ontemBr());
  const [btgDataFim, setBtgDataFim] = useState(ontemBr());
  const [btgApenasFaltantes, setBtgApenasFaltantes] = useState(true);
  const [isBtgImporting, setIsBtgImporting] = useState(false);
  const [btgPopoverOpen, setBtgPopoverOpen] = useState(false);
  const [btgLog, setBtgLog] = useState<string[] | null>(null);
  const [btgSummary, setBtgSummary] = useState<BtgImportResponse["summary"] | null>(null);

  // ── Importação automática Finvest / Sinqia ───────────────────────────────
  const [sinqiaDataIni, setSinqiaDataIni] = useState(ontemBr());
  const [sinqiaDataFim, setSinqiaDataFim] = useState(ontemBr());
  const [sinqiaApenasFaltantes, setSinqiaApenasFaltantes] = useState(true);
  const [isSinqiaImporting, setIsSinqiaImporting] = useState(false);
  const [sinqiaPopoverOpen, setSinqiaPopoverOpen] = useState(false);
  const [sinqiaLog, setSinqiaLog] = useState<string[] | null>(null);
  const [sinqiaSummary, setSinqiaSummary] = useState<SinqiaImportResponse["summary"] | null>(null);

  const newAssetsSummary = (() => {
    const uniqueAssets = new Map<string, NewAssetSummaryItem>();
    let filesWithNewAssets = 0;

    for (const result of results || []) {
      const assets = result.newAssets || [];
      if (assets.length > 0) {
        filesWithNewAssets++;
      }

      for (const asset of assets) {
        const identity = [asset.tipo_ativo, asset.cnpj, asset.isin, asset.ticker, asset.descricao]
          .filter(Boolean)
          .join("|");
        const key = identity || `${asset.tipo_ativo}|sem-identificador`;

        if (!uniqueAssets.has(key)) {
          uniqueAssets.set(key, {
            key,
            label: `[${asset.tipo_ativo}] ${asset.descricao || asset.isin || asset.cnpj || asset.ticker || "Sem identificação"}`
          });
        }
      }
    }

    return {
      total: uniqueAssets.size,
      filesWithNewAssets,
      preview: Array.from(uniqueAssets.values()).slice(0, 5)
    };
  })();

  useEffect(() => {
    setActiveTab(isImportTab(navState?.tab) ? navState.tab : (location.pathname.startsWith("/liquidez") ? "matriz" : "cvm"));
  }, [location.pathname, navState?.tab]);

  useEffect(() => {
    if (activeTab === 'estoque-fidc') {
      loadEstoqueFidcHistory();
    }
    if (activeTab === 'xml') {
      loadXmlGaps();
    }
  }, [activeTab]);

  useEffect(() => {
    const today = new Date();
    const yyyymmdd =
      `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    setResgatesDataRef(yyyymmdd);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    const droppedFiles = Array.from(e.dataTransfer.files).filter(
      file => file.name.toLowerCase().endsWith('.xml')
    );
    
    if (droppedFiles.length === 0) {
      toast({
        title: "Arquivos inválidos",
        description: "Por favor, selecione apenas arquivos XML.",
        variant: "destructive"
      });
      return;
    }

    setFiles(prev => [...prev, ...droppedFiles]);
    setResults(null);
    setSummary(null);
  }, [toast]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selectedFiles = Array.from(e.target.files).filter(
        file => file.name.toLowerCase().endsWith('.xml')
      );
      setFiles(prev => [...prev, ...selectedFiles]);
      setResults(null);
      setSummary(null);
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const clearAll = () => {
    setFiles([]);
    setResults(null);
    setSummary(null);
    setUploadProgress(0);
  };

  const handleUpload = async () => {
    if (files.length === 0) return;

    setIsUploading(true);
    setUploadProgress(10);
    setResults(null);
    setSummary(null);

    try {
      const formData = new FormData();
      files.forEach(file => {
        formData.append('files', file);
      });

      setUploadProgress(30);

      const { data, error } = await supabase.functions.invoke<ImportResponse>('import-xml', {
        body: formData
      });

      setUploadProgress(90);

      if (error) {
        throw new Error(error.message);
      }

      if (data) {
        setResults(data.results);
        setSummary(data.summary);

        if (data.success) {
          const totalNewAssets = (data.results || []).reduce(
            (acc, result) => acc + (result.newAssets?.length || 0),
            0
          );
          toast({
            title: "Importação concluída!",
            description: totalNewAssets > 0
              ? `${data.summary.totalRecords} registros importados de ${data.summary.successFiles} arquivo(s) e ${totalNewAssets} ativo(s) novo(s) detectado(s).`
              : `${data.summary.totalRecords} registros importados de ${data.summary.successFiles} arquivo(s).`,
          });
        } else {
          toast({
            title: "Importação com erros",
            description: `${data.summary.errorFiles} arquivo(s) falharam.`,
            variant: "destructive"
          });
        }
      }

    } catch (error) {
      console.error('Erro na importação:', error);
      toast({
        title: "Erro na importação",
        description: error instanceof Error ? error.message : "Erro desconhecido",
        variant: "destructive"
      });
    } finally {
      setIsUploading(false);
      setUploadProgress(100);
      loadXmlGaps();
    }
  };

  const handleBtgImport = async () => {
    setIsBtgImporting(true);
    setBtgLog(null);
    setBtgSummary(null);
    setResults(null);
    setSummary(null);

    try {
      const { data, error } = await supabase.functions.invoke<BtgImportResponse>("import-btg-xml", {
        body: {
          data_inicial: btgDataIni.trim(),
          data_final: btgDataFim.trim(),
          apenas_faltantes: btgApenasFaltantes,
        },
      });

      if (error) throw new Error(error.message);

      if (!data) throw new Error("Resposta vazia da importação BTG");

      setBtgLog(data.log ?? []);
      setBtgSummary(data.summary ?? null);

      const flatResults: ProcessResult[] = [];
      for (const batch of data.importResults ?? []) {
        flatResults.push(...(batch.results ?? []));
      }
      if (flatResults.length > 0) {
        setResults(flatResults);
        setSummary({
          totalFiles: data.summary.successFiles + data.summary.errorFiles,
          successFiles: data.summary.successFiles,
          errorFiles: data.summary.errorFiles,
          totalRecords: data.summary.totalRecords,
        });
      }

      if (data.success || (data.summary.errorFiles === 0 && data.summary.skipped > 0)) {
        toast({
          title: data.summary.successFiles > 0 ? "Importação BTG concluída" : "Nenhum XML novo",
          description: data.summary.partial
            ? `${data.summary.successFiles} XML(s) importado(s) (parcial — execute novamente para continuar).`
            : data.summary.successFiles > 0
              ? `${data.summary.successFiles} XML(s) importado(s), ${data.summary.skipped} ignorado(s).`
              : `Todos os ${data.summary.skipped} fundo(s)/data já estavam importados.`,
        });
      } else {
        toast({
          title: "Importação BTG com erros",
          description: data.error || `${data.summary.errorFiles} falha(s), ${data.summary.skipped} ignorado(s).`,
          variant: "destructive",
        });
      }

      await loadXmlGaps();
      queryClient.invalidateQueries({ queryKey: ["fundos-xml-coverage"] });
    } catch (err) {
      console.error("Erro na importação BTG:", err);
      toast({
        title: "Erro na importação BTG",
        description: err instanceof Error ? err.message : "Erro desconhecido",
        variant: "destructive",
      });
    } finally {
      setIsBtgImporting(false);
    }
  };

  const handleSinqiaImport = async () => {
    setIsSinqiaImporting(true);
    setSinqiaLog(null);
    setSinqiaSummary(null);
    setResults(null);
    setSummary(null);

    try {
      const { data, error } = await supabase.functions.invoke<SinqiaImportResponse>("import-sinqia-xml", {
        body: {
          data_inicial: sinqiaDataIni.trim(),
          data_final: sinqiaDataFim.trim(),
          apenas_faltantes: sinqiaApenasFaltantes,
        },
      });

      if (error) {
        const body = await (error as { context?: Response }).context?.json?.().catch(() => null) as
          | Partial<SinqiaImportResponse>
          | null;
        if (body?.log?.length) setSinqiaLog(body.log);
        const msg = body?.error ?? (error as Error).message;
        throw new Error(msg);
      }
      if (!data) throw new Error("Resposta vazia da importação Finvest");

      setSinqiaLog(data.log ?? []);
      setSinqiaSummary(data.summary ?? null);

      const flatResults: ProcessResult[] = [];
      for (const batch of data.importResults ?? []) {
        flatResults.push(...(batch.results ?? []));
      }
      if (flatResults.length > 0) {
        setResults(flatResults);
        setSummary({
          totalFiles: data.summary.successFiles + data.summary.errorFiles,
          successFiles: data.summary.successFiles,
          errorFiles: data.summary.errorFiles,
          totalRecords: data.summary.totalRecords,
        });
      }

      if (data.success || (data.summary.errorFiles === 0 && data.summary.skipped > 0)) {
        toast({
          title: data.summary.successFiles > 0 ? "Importação Finvest concluída" : "Nenhum XML novo",
          description: data.summary.partial
            ? `${data.summary.successFiles} XML(s) importado(s) (parcial — execute novamente).`
            : data.summary.successFiles > 0
              ? `${data.summary.successFiles} XML(s) importado(s), ${data.summary.skipped} ignorado(s).`
              : `Todos os ${data.summary.skipped} fundo(s)/data já estavam importados.`,
        });
      } else {
        toast({
          title: "Importação Finvest com erros",
          description: data.error || `${data.summary.errorFiles} falha(s), ${data.summary.skipped} ignorado(s).`,
          variant: "destructive",
        });
      }

      await loadXmlGaps();
      queryClient.invalidateQueries({ queryKey: ["fundos-xml-coverage"] });
    } catch (err) {
      console.error("Erro na importação Finvest:", err);
      toast({
        title: "Erro na importação Finvest",
        description: err instanceof Error ? err.message : "Erro desconhecido",
        variant: "destructive",
      });
    } finally {
      setIsSinqiaImporting(false);
    }
  };

  const handleMatrizUpload = async () => {
    if (!matrizFile) return;

    setIsMatrizUploading(true);
    setMatrizResult(null);

    try {
      const formData = new FormData();
      formData.append("file", matrizFile);

      const { data, error } = await supabase.functions.invoke<MatrizAnbimaResponse>("import-matriz-anbima", {
        body: formData,
      });

      if (error) throw new Error(error.message || "Falha ao invocar import-matriz-anbima");

      if (data) {
        setMatrizResult(data);
        if (data.success) {
          void queryClient.invalidateQueries({ queryKey: ["matriz-anbima"] });
          void queryClient.invalidateQueries({ queryKey: ["matriz-anbima-filters"] });
          toast({
            title: "Matriz ANBIMA atualizada!",
            description: data.message || `${data.recordsInserted} registros importados.`,
          });
        } else {
          toast({
            title: "Erro na importação",
            description: data.error,
            variant: "destructive",
          });
        }
      }
    } catch (err) {
      console.error("Erro ao importar Matriz ANBIMA:", err);
      setMatrizResult({ success: false, error: err instanceof Error ? err.message : "Erro desconhecido" });
      toast({
        title: "Erro na importação",
        description: err instanceof Error ? err.message : "Erro ao importar Matriz ANBIMA",
        variant: "destructive",
      });
    } finally {
      setIsMatrizUploading(false);
    }
  };


  const handleResgatesUpload = async () => {
    if (!resgatesFile) return;

    setIsResgatesUploading(true);
    setResgatesResult(null);

    try {
      const formData = new FormData();
      formData.append("file", resgatesFile);
      if (resgatesDataRef) formData.append("data_referencia", resgatesDataRef);

      const { data, error } = await supabase.functions.invoke<ResgatesResponse>("import-resgates-movimentacoes", {
        body: formData,
      });

      if (error) throw new Error(error.message || "Falha ao invocar import-resgates-movimentacoes");

      const responseData: ResgatesResponse = data ?? { success: false, error: "Resposta vazia da função" };
      setResgatesResult(responseData);

      if (responseData.success) {
        toast({
          title: "Resgates importados!",
          description: responseData.message || `${responseData.recordsInserted} registros importados.`,
        });
      } else {
        toast({
          title: "Erro na importação",
          description: responseData.error,
          variant: "destructive",
        });
      }
    } catch (err) {
      console.error("Erro ao importar resgates:", err);
      setResgatesResult({
        success: false,
        error: err instanceof Error ? err.message : "Erro ao importar resgates",
      });
      toast({
        title: "Erro na importação",
        description: err instanceof Error ? err.message : "Erro ao importar histórico de resgates",
        variant: "destructive",
      });
    } finally {
      setIsResgatesUploading(false);
    }
  };

  const addCotasFiles = (newFiles: File[]) => {
    const valid = newFiles.filter((f) => /\.(xls|xlsx|csv)$/i.test(f.name));
    const invalidCount = newFiles.length - valid.length;
    if (invalidCount > 0) {
      toast({
        title: "Arquivos ignorados",
        description: `${invalidCount} arquivo(s) com formato inválido (use XLS, XLSX ou CSV).`,
        variant: "destructive",
      });
    }
    if (valid.length === 0) return;
    setCotasFiles((prev) => {
      const existingNames = new Set(prev.map((e) => e.file.name));
      const toAdd = valid
        .filter((f) => !existingNames.has(f.name))
        .map((f) => ({ file: f, date: extractDateFromFilename(f.name) || cotasDataFallback }));
      return [...prev, ...toAdd];
    });
  };

  const handleCotasUpload = async () => {
    const pending = cotasFiles.filter((e) => e.date);
    if (pending.length === 0) return;

    setIsCotasUploading(true);
    setCotasBatchResults([]);
    setCotasProgress({ current: 0, total: pending.length });

    const results: typeof cotasBatchResults = [];

    for (let i = 0; i < pending.length; i++) {
      setCotasProgress({ current: i + 1, total: pending.length });
      const { file, date } = pending[i];
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("data_posicao", date);

        const { data, error } = await supabase.functions.invoke<ControleCotasResponse>("import-controle-cotas", {
          body: formData,
        });

        if (error) throw new Error(error.message || "Falha ao invocar import-controle-cotas");
        const resp: ControleCotasResponse = data ?? { success: false, error: "Resposta vazia" };

        results.push({
          filename: file.name,
          date,
          success: resp.success,
          recordsSerie: resp.recordsSerie,
          recordsMetricas: resp.recordsMetricas,
          clientesImpactados: resp.clientesImpactados,
          message: resp.message,
          errors: resp.errors,
          error: resp.error,
        });
      } catch (err) {
        results.push({
          filename: file.name,
          date,
          success: false,
          error: err instanceof Error ? err.message : "Erro desconhecido",
        });
      }
      setCotasBatchResults([...results]);
    }

    setIsCotasUploading(false);
    setCotasProgress(null);

    const totalSuccess = results.filter((r) => r.success).length;
    const totalSerie = results.reduce((s, r) => s + (r.recordsSerie ?? 0), 0);
    toast({
      title: `${totalSuccess} de ${results.length} arquivo(s) importado(s)`,
      description: totalSerie > 0 ? `${totalSerie} cotas consolidadas na série histórica.` : undefined,
      variant: totalSuccess < results.length ? "destructive" : "default",
    });
  };

  const loadEstoqueFidcHistory = async () => {
    setIsLoadingHistory(true);
    try {
      // Cast necessário até supabase gen types ser executado após a migration
      const client = supabase as unknown as { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const { data, error } = await client
        .from('importacoes_estoque_fidc')
        .select('id, created_at, file_name, fund_name, fund_document, reference_date, status, total_rows, imported_rows, rejected_rows, error_message')
        .order('created_at', { ascending: false })
        .limit(10);
      if (!error && data) {
        setEstoqueFidcHistory(data as ImportacaoEstoqueFidc[]);
      }
    } catch (err) {
      console.error('Erro ao carregar histórico de importações FIDC:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const loadXmlGaps = async () => {
    setIsLoadingXmlGaps(true);
    try {
      const { data, error } = await supabase.rpc('get_xml_gaps' as never);
      if (!error && data) {
        setXmlGaps(data as XmlGapRow[]);
      }
    } catch (err) {
      console.error('Erro ao carregar gaps de XML:', err);
    } finally {
      setIsLoadingXmlGaps(false);
    }
  };

  const handleEstoqueFidcUpload = async () => {
    if (!estoqueFidcFile) return;
    setIsEstoqueFidcUploading(true);
    setEstoqueFidcResult(null);

    try {
      const formData = new FormData();
      formData.append('file', estoqueFidcFile);

      const { data, error } = await supabase.functions.invoke<EstoqueFidcImportResponse>(
        'import-estoque-fidc',
        { body: formData }
      );

      if (error) throw new Error(error.message || 'Falha ao invocar import-estoque-fidc');

      const responseData: EstoqueFidcImportResponse = data ?? {
        success: false,
        error: 'Resposta vazia da função',
      };
      setEstoqueFidcResult(responseData);

      if (responseData.success) {
        toast({
          title: 'Estoque FIDC importado!',
          description: responseData.message || `${responseData.imported_rows} registros importados.`,
        });
        await loadEstoqueFidcHistory();
      } else {
        toast({
          title: 'Erro na importação',
          description: responseData.error || 'Falha ao importar estoque FIDC.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      console.error('Erro ao importar Estoque FIDC:', err);
      const errMsg = err instanceof Error ? err.message : 'Erro desconhecido';
      setEstoqueFidcResult({ success: false, error: errMsg });
      toast({
        title: 'Erro na importação',
        description: errMsg,
        variant: 'destructive',
      });
    } finally {
      setIsEstoqueFidcUploading(false);
    }
  };

  const addFinvestFiles = (newFiles: File[]) => {
    const csvOnly = newFiles.filter((f) =>
      f.name.toLowerCase().endsWith(".csv") || f.name.toLowerCase().endsWith(".txt"),
    );
    setFinvestFiles((prev) => {
      const existingNames = new Set(prev.map((f) => f.name));
      return [...prev, ...csvOnly.filter((f) => !existingNames.has(f.name))];
    });
    setFinvestResults([]);
  };

  const handleFinvestUpload = async () => {
    if (finvestFiles.length === 0) return;
    setIsFinvestUploading(true);
    setFinvestResults([]);
    setFinvestProgress({ current: 0, total: finvestFiles.length });

    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    const results: FinvestFileResult[] = [];

    for (let i = 0; i < finvestFiles.length; i++) {
      const file = finvestFiles[i];
      setFinvestProgress({ current: i + 1, total: finvestFiles.length });

      try {
        const formData = new FormData();
        formData.append("file", file);

        const { data, error } = await supabase.functions.invoke(
          "import-carteira-finvest",
          {
            body: formData,
            headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
          },
        );

        if (error) throw new Error(error.message || "Falha ao invocar import-carteira-finvest");

        const resp = data ?? { success: false, error: "Resposta vazia" };
        results.push({ filename: file.name, ...resp });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Erro inesperado";
        results.push({ filename: file.name, success: false, error: msg });
      }

      setFinvestResults([...results]);
    }

    const totalSuccess = results.filter((r) => r.success).length;
    const totalImported = results.reduce((s, r) => s + (r.imported_rows ?? 0), 0);
    const totalFlags = results.reduce((s, r) => s + (r.flags_revisao ?? 0), 0);

    toast({
      title:
        totalSuccess === finvestFiles.length
          ? "Carteira Finvest importada!"
          : `${totalSuccess}/${finvestFiles.length} arquivo(s) importado(s)`,
      description: `${totalImported} itens gravados · ${totalFlags} flag(s) de revisão.`,
      variant: totalSuccess < finvestFiles.length ? "destructive" : "default",
    });

    setIsFinvestUploading(false);
    setFinvestProgress(null);
  };

  const handleCaixaFluxoUpload = async () => {
    if (!caixaFluxoFile) return;
    setIsCaixaFluxoUploading(true);
    setCaixaFluxoResult(null);

    try {
      const formData = new FormData();
      formData.append("file", caixaFluxoFile);

      const { data, error } = await supabase.functions.invoke(
        "import-caixa-fluxo-financeiro",
        { body: formData }
      );

      const result: CaixaFluxoResult = data ?? { success: false, error: error?.message ?? "Resposta vazia" };
      setCaixaFluxoResult(result);

      if (result.success) {
        setCaixaFluxoFile(null);
        toast({
          title: "Fluxo financeiro importado!",
          description: result.message ?? `${result.inserted ?? 0} registro(s) importado(s).`,
        });
      } else {
        toast({
          title: "Erro na importação",
          description: result.error ?? "Não foi possível importar o arquivo.",
          variant: "destructive",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro inesperado";
      setCaixaFluxoResult({ success: false, error: msg });
      toast({ title: "Erro na importação", description: msg, variant: "destructive" });
    } finally {
      setIsCaixaFluxoUploading(false);
    }
  };

  const handleDespesasUpload = async () => {
    if (despesasFiles.length === 0) return;
    setIsDespesasUploading(true);
    setDespesasResult(null);

    try {
      const formData = new FormData();
      despesasFiles.forEach((f) => formData.append('files', f));

      const { data, error } = await supabase.functions.invoke<DespesasImportResponse>(
        'import-despesas-fundo',
        { body: formData }
      );

      if (error) throw new Error(error.message || 'Falha ao invocar import-despesas-fundo');

      const responseData: DespesasImportResponse = data ?? {
        ok: false, total_arquivos: 0, total_registros: 0, total_importados: 0, arquivos: [],
        error: 'Resposta vazia da função',
      };
      setDespesasResult(responseData);

      if (responseData.ok) {
        toast({
          title: 'Despesas importadas!',
          description: `${responseData.total_importados} lançamentos importados de ${responseData.total_arquivos} arquivo(s).`,
        });
      } else {
        toast({
          title: 'Erro na importação',
          description: responseData.error || 'Falha ao importar despesas.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Erro desconhecido';
      setDespesasResult({ ok: false, total_arquivos: 0, total_registros: 0, total_importados: 0, arquivos: [], error: errMsg });
      toast({ title: 'Erro na importação', description: errMsg, variant: 'destructive' });
    } finally {
      setIsDespesasUploading(false);
    }
  };

  const FORMATO_LABELS: Record<string, string> = {
    intrag_xls:  'Intrag/Itaú XLS',
    btg_xlsx:    'BTG XLSX',
    cvpar_csv:   'CVPAR CSV',
    unknown:     'Formato desconhecido',
  };

  const formatCnpj = (cnpj: string) => {
    if (!cnpj || cnpj.length !== 14) return cnpj;
    return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  };

  const formatDate = (date: string) => {
    if (!date || date.length !== 8) return date;
    return `${date.slice(6, 8)}/${date.slice(4, 6)}/${date.slice(0, 4)}`;
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(value);
  };

  const renderLog = () => {
    if (!results || !summary) return null;

    return (
      <Card className="bg-[#1e1e1e] text-[#d4d4d4] font-mono text-sm border-none shadow-2xl overflow-hidden">
        <button 
          onClick={() => setIsLogExpanded(!isLogExpanded)}
          className="w-full flex items-center justify-between border-b border-[#333] px-6 py-4 hover:bg-[#252525] transition-colors group"
        >
          <div className="flex items-center gap-2 text-[#fff]">
            <Terminal className="w-4 h-4 text-[#888] group-hover:text-[#fff] transition-colors" />
            <span className="text-xs font-bold uppercase tracking-wider opacity-80 group-hover:opacity-100 transition-opacity">
              Terminal de Importação
            </span>
          </div>
          <div className="flex items-center gap-3">
            {!isLogExpanded && (
              <span className="text-[10px] text-[#888] font-sans">Clique para expandir o log detalhado</span>
            )}
            {isLogExpanded ? (
              <ChevronUp className="w-4 h-4 text-[#888]" />
            ) : (
              <ChevronDown className="w-4 h-4 text-[#888]" />
            )}
          </div>
        </button>

        {isLogExpanded && (
          <CardContent className="p-0 animate-in slide-in-from-top-2 duration-200">
            <ScrollArea className="h-[500px] w-full p-6">
              <div className="space-y-1">
                <p className="text-[#888]">{"=".repeat(60)}</p>
                <p className="text-[#4ec9b0] font-bold">  IMPORTACAO DE POSICOES DE FUNDOS</p>
                <p className="text-[#9cdcfe]">  {summary.totalFiles} arquivos XML encontrados</p>
                <p className="text-[#888]">{"=".repeat(60)}</p>
                <br />

                {results.map((result, index) => (
                  <div key={index} className="mb-4">
                    <p className="text-[#ce9178]">[{result.filename}]</p>
                    {result.success ? (
                      <>
                        {result.validation && (
                          <p className="ml-4 text-[#dcdcaa]">
                            {`> Validacao PL: Informado=${new Intl.NumberFormat('pt-BR').format(result.validation.plInformado)} | `}
                            {`Calculado=${new Intl.NumberFormat('pt-BR').format(result.validation.plCalculado)} | `}
                            <span className={result.validation.diffPerc <= 1 ? "text-[#4ec9b0]" : "text-[#ce9178]"}>
                              {result.validation.status}
                            </span>
                          </p>
                        )}
                        <p className="ml-4 text-[#4ec9b0]">
                          {`[OK] ${formatCnpj(result.fundo_cnpj || '')} | ${formatDate(result.fundo_dtposicao || '')} | ${result.records} registros`}
                        </p>
                        {result.newAssets && result.newAssets.length > 0 && (
                          <div className="ml-4 mt-1 text-[#ce9178] opacity-80">
                            <p className="text-xs font-bold mb-1 underline">Novos ativos cadastrados:</p>
                            {result.newAssets.map((asset, i) => (
                              <p key={i} className="text-[11px] ml-2">
                                {`- [${asset.tipo_ativo}] ${asset.descricao || asset.isin || asset.cnpj || asset.ticker}`}
                              </p>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="ml-4 text-[#f44747]">{`  > ERRO: ${result.error}`}</p>
                    )}
                  </div>
                ))}

                <br />
                <p className="text-[#888]">{"=".repeat(60)}</p>
                <p className="text-[#4ec9b0] font-bold">  RESUMO</p>
                <p className="text-[#888]">{"=".repeat(60)}</p>
                <p className="text-[#9cdcfe]">  Arquivos processados: {summary.totalFiles}</p>
                <p className="text-[#9cdcfe]">  Arquivos com sucesso: {summary.successFiles}</p>
                <p className="text-[#f44747]">  Arquivos com erro: {summary.errorFiles}</p>
                <p className="text-[#4ec9b0]">  Total de registros importados: {summary.totalRecords}</p>
                <p className="text-[#888]">{"=".repeat(60)}</p>
              </div>
            </ScrollArea>
          </CardContent>
        )}
      </Card>
    );
  };

  return (
    <Layout>
      <div className="import-workspace">
        <div className="import-workspace__intro">
          <div>
            <span className="import-workspace__eyebrow">Central de importações</span>
            <h1>Atualizar dados</h1>
            <p>Escolha a fonte, confira o período e atualize os dados dos fundos em poucos passos.</p>
          </div>
          <div className="import-workspace__help">
            <ShieldCheck aria-hidden="true" />
            <span>Fontes e arquivos registrados para auditoria</span>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ImportTab)} className="import-workspace__layout">
          <TabsList className="import-page-tabs" aria-label="Fontes de importação">
            <span className="import-page-tabs__heading">Principais</span>
            <TabsTrigger value="cvm">
              <CloudDownload aria-hidden="true" />
              Informes CVM
            </TabsTrigger>
            <TabsTrigger value="xml">
              <FileCode className="w-3 h-3" />
              Posição (XML)
            </TabsTrigger>
            <span className="import-page-tabs__heading import-page-tabs__heading--secondary">Outras fontes</span>
            <TabsTrigger value="matriz">
              <Table2 className="w-3 h-3" />
              Matriz ANBIMA
            </TabsTrigger>
            <TabsTrigger value="fip">
              <Briefcase className="w-3 h-3" />
              FIP Informe
            </TabsTrigger>
            <TabsTrigger value="fidc">
              <Landmark className="w-3 h-3" />
              FIDC Informe
            </TabsTrigger>
            <TabsTrigger value="estoque-fidc">
              <Database className="w-3 h-3" />
              Estoque FIDC
            </TabsTrigger>
            <TabsTrigger value="despesas">
              <Wallet className="w-3 h-3" />
              Despesas
            </TabsTrigger>
            <TabsTrigger value="fundos-caracteristicas">
              <FileSpreadsheet className="w-3 h-3" />
              Cadastro ANBIMA
            </TabsTrigger>
          </TabsList>

          <TabsContent value="cvm" className="space-y-6 mt-6">
            <CvmInformesPanel initialCompetencia={navState?.competencia} />
          </TabsContent>

          <TabsContent value="xml" className="space-y-6 mt-6">
        {/* Card de Gaps de XML */}
        {(() => {
          if (isLoadingXmlGaps) {
            return (
              <Card className="border-amber-500/30 bg-amber-500/5">
                <CardContent className="pt-4 pb-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Verificando integridade dos XMLs...
                </CardContent>
              </Card>
            );
          }

          if (xmlGaps.length === 0) {
            return (
              <Card className="border-green-500/30 bg-green-500/5">
                <CardContent className="pt-4 pb-4 flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                  <CheckCircle2 className="w-4 h-4" />
                  Todos os XMLs em dia — nenhum gap detectado nos últimos 90 dias.
                </CardContent>
              </Card>
            );
          }

          // Agrupar por data para detectar "lote não importado" (todos os fundos ausentes)
          const totalFundosAtivos = new Set(xmlGaps.map(r => r.fundo_cnpj)).size;
          const porData = xmlGaps.reduce<Record<string, Set<string>>>((acc, row) => {
            if (!acc[row.data_faltante]) acc[row.data_faltante] = new Set();
            acc[row.data_faltante].add(row.fundo_cnpj);
            return acc;
          }, {});
          const datasLoteCompleto = Object.entries(porData)
            .filter(([, fundos]) => fundos.size >= totalFundosAtivos)
            .map(([dt]) => dt);

          // Agrupar por fundo (apenas gaps individuais, excluindo lotes completos)
          const grouped = xmlGaps
            .filter(row => !datasLoteCompleto.includes(row.data_faltante))
            .reduce<Record<string, { nome_fundo: string; datas: string[] }>>((acc, row) => {
              const d = row.data_faltante;
              const fmt = `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;
              if (!acc[row.fundo_cnpj]) acc[row.fundo_cnpj] = { nome_fundo: row.nome_fundo, datas: [] };
              acc[row.fundo_cnpj].datas.push(fmt);
              return acc;
            }, {});

          const totalGaps = xmlGaps.length;
          const totalFundosComGap = new Set(xmlGaps.map(r => r.fundo_cnpj)).size;

          return (
            <Card className="border-amber-500/40 bg-amber-500/5">
              <CardHeader className="pb-3 pt-4">
                <CardTitle className="text-sm flex items-center gap-2 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="w-4 h-4" />
                  XMLs pendentes — {totalFundosComGap} fundo{totalFundosComGap !== 1 ? 's' : ''} · {totalGaps} gap{totalGaps !== 1 ? 's' : ''} nos últimos 45 dias
                  <button
                    className="ml-auto text-xs font-normal underline underline-offset-2 text-amber-600 dark:text-amber-400 hover:opacity-80"
                    onClick={loadXmlGaps}
                  >
                    Atualizar
                  </button>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0 pb-4 space-y-4">
                {/* Datas com lote completo ausente */}
                {datasLoteCompleto.length > 0 && (
                  <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 space-y-1">
                    <p className="text-xs font-semibold text-red-700 dark:text-red-400 flex items-center gap-1">
                      <XCircle className="w-3 h-3" />
                      Lote completo não importado — todos os fundos ausentes
                    </p>
                    <p className="text-xs font-mono text-red-600 dark:text-red-300">
                      {datasLoteCompleto
                        .sort()
                        .reverse()
                        .map(d => `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`)
                        .join(' · ')}
                    </p>
                  </div>
                )}

                {/* Gaps individuais por fundo */}
                {Object.keys(grouped).length > 0 && (
                  <div className="space-y-2">
                    {Object.entries(grouped).map(([cnpj, { nome_fundo, datas }]) => (
                      <div key={cnpj} className="flex flex-col sm:flex-row sm:items-baseline gap-1 text-sm">
                        <span className="font-medium text-foreground min-w-0 sm:w-64 shrink-0 truncate" title={nome_fundo}>
                          {nome_fundo || cnpj}
                        </span>
                        <span className="text-muted-foreground">→</span>
                        <span className="text-amber-700 dark:text-amber-300 font-mono text-xs">
                          {datas.join(' · ')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })()}

        {/* APIs automáticas — acima do upload manual */}
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap justify-end gap-2">
          <Popover open={btgPopoverOpen} onOpenChange={setBtgPopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "gap-1.5 shrink-0 transition-colors",
                  btgPopoverOpen &&
                    "bg-[#197357] text-white border-[#197357] hover:bg-[#197357] hover:text-white font-semibold",
                )}
              >
                <CloudDownload className="w-4 h-4" />
                Importar XMLs BTG
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(calc(100vw-2rem),42rem)] p-0 shadow-sm">
              <div className="border-b px-4 py-3 flex items-center justify-between gap-3">
                <p className="text-sm font-semibold tracking-tight">Importação automática — BTG</p>
                <span className="text-[11px] text-muted-foreground font-mono shrink-0">
                  funds.btgpactual.com
                </span>
              </div>
              <div className="p-4 flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor="btg-data-ini" className="text-xs text-muted-foreground font-normal">
                    Data inicial
                  </Label>
                  <Input
                    id="btg-data-ini"
                    value={btgDataIni}
                    onChange={(e) => setBtgDataIni(e.target.value)}
                    placeholder="DD/MM/AAAA"
                    disabled={isBtgImporting}
                    className="h-8 w-[7.5rem] text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="btg-data-fim" className="text-xs text-muted-foreground font-normal">
                    Data final
                  </Label>
                  <Input
                    id="btg-data-fim"
                    value={btgDataFim}
                    onChange={(e) => setBtgDataFim(e.target.value)}
                    placeholder="DD/MM/AAAA"
                    disabled={isBtgImporting}
                    className="h-8 w-[7.5rem] text-sm"
                  />
                </div>
                <div className="flex items-center gap-2 sm:pb-1">
                  <Checkbox
                    id="btg-apenas-faltantes"
                    checked={btgApenasFaltantes}
                    onCheckedChange={(v) => setBtgApenasFaltantes(v === true)}
                    disabled={isBtgImporting}
                  />
                  <Label htmlFor="btg-apenas-faltantes" className="text-xs font-normal cursor-pointer whitespace-nowrap">
                    Apenas fundos Faltantes
                  </Label>
                </div>
                <Button
                  size="sm"
                  className="gap-1.5 sm:ml-auto bg-[#197357] hover:bg-[#197357]/90 text-white"
                  onClick={handleBtgImport}
                  disabled={isBtgImporting || isUploading || isSinqiaImporting}
                >
                  {isBtgImporting ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Importando...
                    </>
                  ) : (
                    "Executar"
                  )}
                </Button>
              </div>
              {(isBtgImporting || btgLog) && (
                <div className="border-t px-4 py-3">
                  {isBtgImporting && !btgLog?.length && (
                    <p className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Baixando e importando via API BTG...
                    </p>
                  )}
                  {btgLog && btgLog.length > 0 && (
                    <ScrollArea className="h-32 w-full">
                      <pre className="text-[11px] font-mono whitespace-pre-wrap text-muted-foreground leading-relaxed">
                        {btgLog.join("\n")}
                      </pre>
                    </ScrollArea>
                  )}
                </div>
              )}
            </PopoverContent>
          </Popover>

          <Popover open={sinqiaPopoverOpen} onOpenChange={setSinqiaPopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "gap-1.5 shrink-0 transition-colors",
                  sinqiaPopoverOpen &&
                    "bg-[#197357] text-white border-[#197357] hover:bg-[#197357] hover:text-white font-semibold",
                )}
              >
                <CloudDownload className="w-4 h-4" />
                Importar XMLs Finvest
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(calc(100vw-2rem),42rem)] p-0 shadow-sm">
              <div className="border-b px-4 py-3 flex items-center justify-between gap-3">
                <p className="text-sm font-semibold tracking-tight">Importação automática — Finvest</p>
                <span className="text-[11px] text-muted-foreground font-mono shrink-0">
                  sistema09.finvestdigital.com.br
                </span>
              </div>
              <div className="p-4 flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor="sinqia-data-ini" className="text-xs text-muted-foreground font-normal">
                    Data inicial
                  </Label>
                  <Input
                    id="sinqia-data-ini"
                    value={sinqiaDataIni}
                    onChange={(e) => setSinqiaDataIni(e.target.value)}
                    placeholder="DD/MM/AAAA"
                    disabled={isSinqiaImporting}
                    className="h-8 w-[7.5rem] text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sinqia-data-fim" className="text-xs text-muted-foreground font-normal">
                    Data final
                  </Label>
                  <Input
                    id="sinqia-data-fim"
                    value={sinqiaDataFim}
                    onChange={(e) => setSinqiaDataFim(e.target.value)}
                    placeholder="DD/MM/AAAA"
                    disabled={isSinqiaImporting}
                    className="h-8 w-[7.5rem] text-sm"
                  />
                </div>
                <div className="flex items-center gap-2 sm:pb-1">
                  <Checkbox
                    id="sinqia-apenas-faltantes"
                    checked={sinqiaApenasFaltantes}
                    onCheckedChange={(v) => setSinqiaApenasFaltantes(v === true)}
                    disabled={isSinqiaImporting}
                  />
                  <Label htmlFor="sinqia-apenas-faltantes" className="text-xs font-normal cursor-pointer whitespace-nowrap">
                    Apenas fundos Faltantes
                  </Label>
                </div>
                <Button
                  size="sm"
                  className="gap-1.5 sm:ml-auto bg-[#197357] hover:bg-[#197357]/90 text-white"
                  onClick={handleSinqiaImport}
                  disabled={isSinqiaImporting || isUploading || isBtgImporting}
                >
                  {isSinqiaImporting ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Importando...
                    </>
                  ) : (
                    "Executar"
                  )}
                </Button>
              </div>
              {(isSinqiaImporting || sinqiaLog) && (
                <div className="border-t px-4 py-3">
                  {isSinqiaImporting && !sinqiaLog?.length && (
                    <p className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Baixando e importando via API Sinqia...
                    </p>
                  )}
                  {sinqiaLog && sinqiaLog.length > 0 && (
                    <ScrollArea className="h-32 w-full">
                      <pre className="text-[11px] font-mono whitespace-pre-wrap text-muted-foreground leading-relaxed">
                        {sinqiaLog.join("\n")}
                      </pre>
                    </ScrollArea>
                  )}
                </div>
              )}
            </PopoverContent>
          </Popover>
          </div>
          {(btgSummary && !btgPopoverOpen) || (sinqiaSummary && !sinqiaPopoverOpen) ? (
            <div className="text-xs text-muted-foreground text-right space-y-0.5">
              {btgSummary && !btgPopoverOpen && (
                <p>
                  BTG: {btgSummary.successFiles} importado(s) · {btgSummary.skipped} ignorado(s)
                  {btgSummary.errorFiles > 0 ? ` · ${btgSummary.errorFiles} erro(s)` : ""}
                </p>
              )}
              {sinqiaSummary && !sinqiaPopoverOpen && (
                <p>
                  Finvest: {sinqiaSummary.successFiles} importado(s) · {sinqiaSummary.skipped} ignorado(s)
                  {sinqiaSummary.errorFiles > 0 ? ` · ${sinqiaSummary.errorFiles} erro(s)` : ""}
                </p>
              )}
            </div>
          ) : null}
        </div>

        {/* Upload Area - XML */}
        <Card className="border-dashed">
          <CardContent className="pt-6">
            <div
              className={cn(
                "relative border-2 border-dashed rounded-lg p-8 transition-colors",
                "hover:border-primary/50 hover:bg-accent/30",
                "flex flex-col items-center justify-center gap-4 text-center",
                isUploading && "pointer-events-none opacity-50"
              )}
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); }}
            >
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Upload className="w-8 h-8 text-primary" />
              </div>
              <div>
                <p className="font-medium">Arraste e solte seus arquivos XML aqui</p>
                <p className="text-sm text-muted-foreground mt-1">ou clique para selecionar</p>
              </div>
              <input
                type="file"
                accept=".xml"
                multiple
                onChange={handleFileSelect}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={isUploading}
              />
            </div>
          </CardContent>
        </Card>

        {/* File List */}
        {files.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg">Arquivos selecionados</CardTitle>
                  <CardDescription>{files.length} arquivo(s)</CardDescription>
                </div>
                <Button variant="ghost" size="sm" onClick={clearAll} disabled={isUploading}>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Limpar
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[200px] w-full rounded-md border p-4">
                <div className="space-y-2">
                  {files.map((file, index) => (
                    <div 
                      key={`${file.name}-${index}`}
                      className="flex items-center justify-between p-2 rounded-md bg-accent/50"
                    >
                      <div className="flex items-center gap-3">
                        <FileCode className="w-5 h-5 text-primary" />
                        <div>
                          <p className="text-sm font-medium">{file.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {(file.size / 1024).toFixed(1)} KB
                          </p>
                        </div>
                      </div>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-8 w-8"
                        onClick={() => removeFile(index)}
                        disabled={isUploading}
                      >
                        <XCircle className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>

              {/* Upload Progress */}
              {isUploading && (
                <div className="mt-4 space-y-2">
                  <Progress value={uploadProgress} className="h-2" />
                  <p className="text-sm text-muted-foreground text-center">
                    Processando arquivos...
                  </p>
                </div>
              )}

              {/* Upload Button */}
              <Button 
                className="w-full mt-4" 
                onClick={handleUpload}
                disabled={isUploading || files.length === 0}
              >
                {isUploading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Importando...
                  </>
                ) : (
                  <>
                    <FileUp className="w-4 h-4 mr-2" />
                    Importar {files.length} arquivo(s)
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Results Summary and Log */}
        {(summary || results) && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {summary && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center gap-2">
                    {summary.errorFiles === 0 ? (
                      <CheckCircle2 className="w-5 h-5 text-green-500" />
                    ) : (
                      <AlertTriangle className="w-5 h-5 text-yellow-500" />
                    )}
                    Resumo da Importação
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="text-center p-3 rounded-lg bg-accent/50">
                      <p className="text-2xl font-bold">{summary.totalFiles}</p>
                      <p className="text-xs text-muted-foreground">Total de Arquivos</p>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-green-500/10">
                      <p className="text-2xl font-bold text-green-600">{summary.successFiles}</p>
                      <p className="text-xs text-muted-foreground">Sucesso</p>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-red-500/10">
                      <p className="text-2xl font-bold text-red-600">{summary.errorFiles}</p>
                      <p className="text-xs text-muted-foreground">Erros</p>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-primary/10">
                      <p className="text-2xl font-bold text-primary">{summary.totalRecords}</p>
                      <p className="text-xs text-muted-foreground">Registros</p>
                    </div>
                  </div>
                  {newAssetsSummary.total > 0 && (
                    <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                      <p className="text-sm font-semibold text-amber-700">
                        {newAssetsSummary.total} ativo(s) novo(s) detectado(s) em {newAssetsSummary.filesWithNewAssets} arquivo(s).
                      </p>
                      {newAssetsSummary.preview.length > 0 && (
                        <p className="mt-1 text-xs text-amber-800">
                          {newAssetsSummary.preview.map((asset) => asset.label).join(" | ")}
                          {newAssetsSummary.total > newAssetsSummary.preview.length ? " | ..." : ""}
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {renderLog()}
          </div>
        )}
          </TabsContent>

          <TabsContent value="matriz" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Droplets className="w-5 h-5 text-primary" />
                      Matriz ANBIMA - Risco de Liquidez
                    </CardTitle>
                    <CardDescription>
                      Faça upload do CSV de parâmetros de referência (report_fliq_*.csv). Os dados são atualizados mensalmente no site da ANBIMA.
                    </CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate("/liquidez/matriz-anbima")}
                    className="shrink-0"
                  >
                    <Table2 className="w-4 h-4 mr-2" />
                    Ver dados importados
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div
                  className={cn(
                    "relative border-2 border-dashed rounded-lg p-8 transition-colors",
                    "hover:border-primary/50 hover:bg-accent/30",
                    "flex flex-col items-center justify-center gap-4 text-center",
                    isMatrizUploading && "pointer-events-none opacity-50"
                  )}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files[0];
                    if (f?.name.toLowerCase().endsWith(".csv")) setMatrizFile(f);
                    else toast({ title: "Arquivo inválido", description: "Use um arquivo CSV.", variant: "destructive" });
                  }}
                  onDragOver={(e) => { e.preventDefault(); }}
                >
                  <Upload className="w-8 h-8 text-primary" />
                  <div>
                    <p className="font-medium">Arraste o CSV aqui ou clique para selecionar</p>
                    <p className="text-sm text-muted-foreground mt-1">Formato: data,periodo,classe,segmento_investidor,tipo_metodologia,metrica,prazo,valor</p>
                  </div>
                  <input
                    type="file"
                    accept=".csv"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    disabled={isMatrizUploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) setMatrizFile(f);
                    }}
                  />
                </div>

                {matrizFile && (
                  <div className="flex items-center justify-between p-3 rounded-md bg-accent/50">
                    <div className="flex items-center gap-3">
                      <Table2 className="w-5 h-5 text-primary" />
                      <div>
                        <p className="text-sm font-medium">{matrizFile.name}</p>
                        <p className="text-xs text-muted-foreground">{(matrizFile.size / 1024).toFixed(1)} KB</p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => { setMatrizFile(null); setMatrizResult(null); }}
                      disabled={isMatrizUploading}
                    >
                      <XCircle className="w-4 h-4" />
                    </Button>
                  </div>
                )}

                <Button
                  className="w-full"
                  onClick={handleMatrizUpload}
                  disabled={!matrizFile || isMatrizUploading}
                >
                  {isMatrizUploading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Importando...
                    </>
                  ) : (
                    <>
                      <FileUp className="w-4 h-4 mr-2" />
                      Importar Matriz ANBIMA
                    </>
                  )}
                </Button>

                {matrizResult && (
                  <Card className={matrizResult.success ? "border-green-500/50" : "border-red-500/50"}>
                    <CardContent className="pt-4 flex items-center gap-3">
                      {matrizResult.success ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                      ) : (
                        <AlertTriangle className="w-5 h-5 text-red-500" />
                      )}
                      <div>
                        <p className="font-medium">{matrizResult.success ? "Importação concluída" : "Erro"}</p>
                        <p className="text-sm text-muted-foreground">
                          {matrizResult.success ? matrizResult.message : matrizResult.error}
                        </p>
                        {matrizResult.recordsInserted != null && (
                          <p className="text-xs text-muted-foreground mt-1">{matrizResult.recordsInserted} registros</p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </CardContent>
            </Card>
          </TabsContent>


          <TabsContent value="resgates" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Receipt className="w-5 h-5 text-primary" />
                    Histórico de Resgates
                  </CardTitle>
                  <CardDescription>
                    Importe planilhas de movimentações (passivo.relatório.movimentações-*.xlsx). Apenas linhas com
                    RESGATE são importadas. São calculados dias até pagamento e vértice para a Análise Vértice a Vértice.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col sm:flex-row gap-4 items-start">
                  <div className="space-y-2">
                    <label className="text-sm font-medium flex items-center gap-2">
                      <Calendar className="w-4 h-4" />
                      Data de referência
                    </label>
                    <input
                      type="date"
                      value={
                        resgatesDataRef
                          ? `${resgatesDataRef.slice(0, 4)}-${resgatesDataRef.slice(4, 6)}-${resgatesDataRef.slice(6, 8)}`
                          : ""
                      }
                      onChange={(e) => {
                        const d = e.target.value.replace(/-/g, "");
                        setResgatesDataRef(d);
                      }}
                      className="flex h-9 w-[180px] rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                    />
                  </div>
                </div>

                <div
                  className={cn(
                    "relative border-2 border-dashed rounded-lg p-8 transition-colors",
                    "hover:border-primary/50 hover:bg-accent/30",
                    "flex flex-col items-center justify-center gap-4 text-center",
                    isResgatesUploading && "pointer-events-none opacity-50"
                  )}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files[0];
                    if (f?.name.toLowerCase().endsWith(".xlsx")) setResgatesFile(f);
                    else
                      toast({
                        title: "Arquivo inválido",
                        description: "Use um arquivo XLSX (passivo.relatório.movimentações-*.xlsx).",
                        variant: "destructive",
                      });
                  }}
                  onDragOver={(e) => e.preventDefault()}
                >
                  <Upload className="w-8 h-8 text-primary" />
                  <div>
                    <p className="font-medium">Arraste o XLSX aqui ou clique para selecionar</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      passivo.relatório.movimentações-*.xlsx
                    </p>
                  </div>
                  <input
                    type="file"
                    accept=".xlsx"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    disabled={isResgatesUploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) setResgatesFile(f);
                    }}
                  />
                </div>

                {resgatesFile && (
                  <div className="flex items-center justify-between p-3 rounded-md bg-accent/50">
                    <div className="flex items-center gap-3">
                      <Receipt className="w-5 h-5 text-primary" />
                      <div>
                        <p className="text-sm font-medium">{resgatesFile.name}</p>
                        <p className="text-xs text-muted-foreground">{(resgatesFile.size / 1024).toFixed(1)} KB</p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setResgatesFile(null);
                        setResgatesResult(null);
                      }}
                      disabled={isResgatesUploading}
                    >
                      <XCircle className="w-4 h-4" />
                    </Button>
                  </div>
                )}

                <Button
                  className="w-full"
                  onClick={handleResgatesUpload}
                  disabled={!resgatesFile || isResgatesUploading}
                >
                  {isResgatesUploading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Importando...
                    </>
                  ) : (
                    <>
                      <FileUp className="w-4 h-4 mr-2" />
                      Importar Resgates
                    </>
                  )}
                </Button>

                {resgatesResult && (
                  <Card className={resgatesResult.success ? "border-green-500/50" : "border-red-500/50"}>
                    <CardContent className="pt-4 flex items-center gap-3">
                      {resgatesResult.success ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                      ) : (
                        <AlertTriangle className="w-5 h-5 text-red-500" />
                      )}
                      <div>
                        <p className="font-medium">{resgatesResult.success ? "Importação concluída" : "Erro"}</p>
                        <p className="text-sm text-muted-foreground">
                          {resgatesResult.success ? resgatesResult.message : resgatesResult.error}
                        </p>
                        {resgatesResult.recordsInserted != null && (
                          <p className="text-xs text-muted-foreground mt-1">{resgatesResult.recordsInserted} registros</p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="fip" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Briefcase className="w-5 h-5 text-primary" />
                  Informe Quadrimestral FIP
                </CardTitle>
                <CardDescription>
                  Importa o Informe Quadrimestral FIP da CVM (capital subscrito) para o banco de dados. Usado na regra CLASSE_FIP_90 para o bônus de 5% quando o fundo está desenquadrado.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Os dados são baixados diretamente do portal de dados abertos da CVM. Serão importados os anos 2024 e 2025.
                </p>
                <Button
                  className="w-full"
                  onClick={async () => {
                    setIsFipImporting(true);
                    setFipImportResult(null);
                    try {
                      const { data, error } = await supabase.functions.invoke<{ success: boolean; imported: number; errors: string[] }>("import-fip-informe-quadrimestral", {
                        body: { anos: [2024, 2025] },
                      });
                      if (error) throw new Error(error.message);
                      setFipImportResult(data ?? { success: false, imported: 0, errors: ["Resposta vazia"] });
                      if (data?.success) {
                        toast({ title: "Importação concluída", description: `${data.imported} registros importados.` });
                      } else if (data?.errors?.length) {
                        toast({ title: "Importação com erros", description: data.errors.join("; "), variant: "destructive" });
                      }
                    } catch (e) {
                      setFipImportResult({ success: false, imported: 0, errors: [String(e)] });
                      toast({ title: "Erro", description: String(e), variant: "destructive" });
                    } finally {
                      setIsFipImporting(false);
                    }
                  }}
                  disabled={isFipImporting}
                >
                  {isFipImporting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Importando...
                    </>
                  ) : (
                    <>
                      <FileUp className="w-4 h-4 mr-2" />
                      Importar Informe Quadrimestral FIP
                    </>
                  )}
                </Button>
                {fipImportResult && (
                  <Card className={fipImportResult.success ? "border-green-500/50" : "border-red-500/50"}>
                    <CardContent className="pt-4 flex items-center gap-3">
                      {fipImportResult.success ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                      ) : (
                        <AlertTriangle className="w-5 h-5 text-red-500" />
                      )}
                      <div>
                        <p className="font-medium">{fipImportResult.success ? "Importação concluída" : "Erro"}</p>
                        <p className="text-sm text-muted-foreground">{fipImportResult.imported} registros importados</p>
                        {fipImportResult.errors?.length > 0 && (
                          <p className="text-xs text-muted-foreground mt-1">{fipImportResult.errors.join("; ")}</p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="fidc" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Landmark className="w-5 h-5 text-primary" />
                  Informe Mensal FIDC
                </CardTitle>
                <CardDescription>
                  Baixa o ZIP do Informe Mensal FIDC na CVM e importa TAB_V, TAB_VI, TAB_IV Parte A (PL) e TAB_X_1 (número de cotistas por subclasse). Se o mês mais recente ainda estiver incompleto, também importa o mês anterior completo.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Cada competência importada substitui só os registros daquele mês. O número de cotistas vem da TAB_X_1; o ZIP do mês corrente na CVM costuma ficar incompleto nas primeiras semanas.
                </p>
                <Button
                  className="w-full"
                  onClick={async () => {
                    setIsFidcMensalImporting(true);
                    setFidcMensalImportResult(null);
                    try {
                      const { data, error } = await supabase.functions.invoke<FidcMensalImportResponse>("import-fidc-informe-mensal");
                      if (error) throw new Error(error.message);

                      const responseData: FidcMensalImportResponse = data ?? { success: false, errors: ["Resposta vazia da função"] };
                      setFidcMensalImportResult(responseData);

                      if (responseData.success) {
                        const meses = responseData.competencias?.length
                          ? responseData.competencias.join(", ")
                          : responseData.competencia ?? "competência não informada";
                        toast({
                          title: "Importação FIDC concluída",
                          description: `${responseData.imported ?? 0} registros · ${responseData.cotistas_importados ?? 0} linhas de cotistas (${meses}).`,
                        });
                      } else {
                        toast({
                          title: "Importação FIDC com erros",
                          description: responseData.errors?.join("; ") || "Falha na importação",
                          variant: "destructive",
                        });
                      }
                    } catch (e) {
                      const errMsg = e instanceof Error ? e.message : String(e);
                      setFidcMensalImportResult({ success: false, errors: [errMsg] });
                      toast({ title: "Erro", description: errMsg, variant: "destructive" });
                    } finally {
                      setIsFidcMensalImporting(false);
                    }
                  }}
                  disabled={isFidcMensalImporting}
                >
                  {isFidcMensalImporting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Importando...
                    </>
                  ) : (
                    <>
                      <FileUp className="w-4 h-4 mr-2" />
                      Importar Informe Mensal FIDC
                    </>
                  )}
                </Button>

                {fidcMensalImportResult && (
                  <Card className={fidcMensalImportResult.success ? "border-green-500/50" : "border-red-500/50"}>
                    <CardContent className="pt-4 flex items-center gap-3">
                      {fidcMensalImportResult.success ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                      ) : (
                        <AlertTriangle className="w-5 h-5 text-red-500" />
                      )}
                      <div>
                        <p className="font-medium">{fidcMensalImportResult.success ? "Importação concluída" : "Erro"}</p>
                        <p className="text-sm text-muted-foreground">
                          {(fidcMensalImportResult.imported ?? 0)} registros importados
                          {fidcMensalImportResult.competencias?.length
                            ? ` | competências ${fidcMensalImportResult.competencias.join(", ")}`
                            : fidcMensalImportResult.competencia
                              ? ` | competência ${fidcMensalImportResult.competencia}`
                              : ""}
                          {fidcMensalImportResult.cotistas_importados != null
                            ? ` | ${fidcMensalImportResult.cotistas_importados} linhas de cotistas (TAB_X_1)`
                            : ""}
                        </p>
                        {fidcMensalImportResult.data_referencia && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Data de referência do arquivo: {fidcMensalImportResult.data_referencia}
                          </p>
                        )}
                        {fidcMensalImportResult.aviso && (
                          <p className="text-xs text-amber-700 mt-1">{fidcMensalImportResult.aviso}</p>
                        )}
                        {fidcMensalImportResult.files_processed && fidcMensalImportResult.files_processed.length > 0 && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Arquivos processados: {fidcMensalImportResult.files_processed.length}
                          </p>
                        )}
                        {fidcMensalImportResult.errors?.length > 0 && (
                          <p className="text-xs text-muted-foreground mt-1">{fidcMensalImportResult.errors.join("; ")}</p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ============================================================ */}
          {/* ABA: Estoque FIDC (Frontis)                                    */}
          {/* ============================================================ */}
          <TabsContent value="estoque-fidc" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Database className="w-5 h-5 text-primary" />
                    Estoque FIDC — Frontis
                  </CardTitle>
                  <CardDescription>
                    Importe planilhas de estoque de recebíveis FIDC extraídas do Frontis (CSV delimitado por ";").
                    Suporta múltiplos meses. Cada upload gera um lote rastreável independente.
                    Formato esperado: <code className="text-xs bg-muted px-1 rounded">CNPJ_Estoque_NomeFundo_*.csv</code>
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">

                {/* Área de upload */}
                <div
                  className={cn(
                    "relative border-2 border-dashed rounded-lg p-8 transition-colors",
                    "hover:border-primary/50 hover:bg-accent/30",
                    "flex flex-col items-center justify-center gap-4 text-center",
                    isEstoqueFidcUploading && "pointer-events-none opacity-50"
                  )}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files[0];
                    if (f?.name.toLowerCase().endsWith('.csv')) {
                      setEstoqueFidcFile(f);
                      setEstoqueFidcResult(null);
                    } else {
                      toast({
                        title: 'Arquivo inválido',
                        description: 'Use um arquivo CSV exportado do Frontis.',
                        variant: 'destructive',
                      });
                    }
                  }}
                  onDragOver={(e) => e.preventDefault()}
                >
                  <Upload className="w-8 h-8 text-primary" />
                  <div>
                    <p className="font-medium">Arraste o CSV do Frontis aqui ou clique para selecionar</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Arquivo CSV separado por ponto e vírgula (;) com 48 colunas do Frontis
                    </p>
                  </div>
                  <input
                    type="file"
                    accept=".csv"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    disabled={isEstoqueFidcUploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        setEstoqueFidcFile(f);
                        setEstoqueFidcResult(null);
                      }
                    }}
                  />
                </div>

                {/* Preview do arquivo selecionado */}
                {estoqueFidcFile && (
                  <div className="flex items-center justify-between p-3 rounded-md bg-accent/50">
                    <div className="flex items-center gap-3">
                      <Database className="w-5 h-5 text-primary" />
                      <div>
                        <p className="text-sm font-medium">{estoqueFidcFile.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {(estoqueFidcFile.size / 1024).toFixed(1)} KB
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setEstoqueFidcFile(null);
                        setEstoqueFidcResult(null);
                      }}
                      disabled={isEstoqueFidcUploading}
                    >
                      <XCircle className="w-4 h-4" />
                    </Button>
                  </div>
                )}

                {/* Botão importar */}
                <Button
                  className="w-full"
                  onClick={handleEstoqueFidcUpload}
                  disabled={!estoqueFidcFile || isEstoqueFidcUploading}
                >
                  {isEstoqueFidcUploading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Importando...
                    </>
                  ) : (
                    <>
                      <FileUp className="w-4 h-4 mr-2" />
                      Importar Estoque FIDC
                    </>
                  )}
                </Button>

                {/* Resultado da importação */}
                {estoqueFidcResult && (
                  <Card className={estoqueFidcResult.success ? 'border-green-500/50' : 'border-red-500/50'}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        {estoqueFidcResult.success ? (
                          <CheckCircle2 className="w-5 h-5 text-green-500" />
                        ) : (
                          <AlertTriangle className="w-5 h-5 text-red-500" />
                        )}
                        {estoqueFidcResult.success ? 'Importação concluída' : 'Erro na importação'}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {/* Alerta de duplicidade */}
                      {estoqueFidcResult.duplicate_warning && (
                        <div className="flex items-start gap-2 p-2 rounded-md bg-amber-500/10 border border-amber-500/30">
                          <Info className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                          <p className="text-xs text-amber-700">{estoqueFidcResult.duplicate_warning}</p>
                        </div>
                      )}

                      {/* Resumo numérico */}
                      {estoqueFidcResult.success && (
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          <div className="text-center p-2 rounded-lg bg-accent/50">
                            <p className="text-xl font-bold">{estoqueFidcResult.total_rows ?? 0}</p>
                            <p className="text-xs text-muted-foreground">Total lidas</p>
                          </div>
                          <div className="text-center p-2 rounded-lg bg-green-500/10">
                            <p className="text-xl font-bold text-green-600">{estoqueFidcResult.imported_rows ?? 0}</p>
                            <p className="text-xs text-muted-foreground">Importadas</p>
                          </div>
                          <div className="text-center p-2 rounded-lg bg-red-500/10">
                            <p className="text-xl font-bold text-red-600">{estoqueFidcResult.rejected_rows ?? 0}</p>
                            <p className="text-xs text-muted-foreground">Rejeitadas</p>
                          </div>
                          <div className="text-center p-2 rounded-lg bg-primary/10">
                            <p className="text-sm font-bold text-primary truncate" title={estoqueFidcResult.reference_date ?? ''}>
                              {estoqueFidcResult.reference_date
                                ? estoqueFidcResult.reference_date.split('-').reverse().join('/')
                                : '—'}
                            </p>
                            <p className="text-xs text-muted-foreground">Data Ref.</p>
                          </div>
                        </div>
                      )}

                      {/* Identificação do fundo */}
                      {estoqueFidcResult.fund_name && (
                        <p className="text-sm text-muted-foreground">
                          <span className="font-medium">Fundo:</span> {estoqueFidcResult.fund_name}
                          {estoqueFidcResult.fund_document && ` (${estoqueFidcResult.fund_document})`}
                        </p>
                      )}

                      {/* Mensagem de erro principal */}
                      {!estoqueFidcResult.success && estoqueFidcResult.error && (
                        <p className="text-sm text-red-600">{estoqueFidcResult.error}</p>
                      )}

                      {/* Avisos/erros de linha */}
                      {estoqueFidcResult.errors && estoqueFidcResult.errors.length > 0 && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                            {estoqueFidcResult.errors.length} aviso(s)/observação(ões) — clique para expandir
                          </summary>
                          <ScrollArea className="mt-2 h-[120px] w-full rounded border p-2 bg-muted/30">
                            <div className="space-y-1">
                              {estoqueFidcResult.errors.map((e, i) => (
                                <p key={i} className="text-muted-foreground leading-relaxed">{e}</p>
                              ))}
                            </div>
                          </ScrollArea>
                        </details>
                      )}
                    </CardContent>
                  </Card>
                )}
              </CardContent>
            </Card>

            {/* Histórico de importações */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <History className="w-4 h-4" />
                    Histórico de Importações
                  </CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={loadEstoqueFidcHistory}
                    disabled={isLoadingHistory}
                  >
                    {isLoadingHistory ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      'Atualizar'
                    )}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {isLoadingHistory ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-sm text-muted-foreground">Carregando histórico...</span>
                  </div>
                ) : estoqueFidcHistory.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">
                    Nenhuma importação registrada ainda.
                  </p>
                ) : (
                  <ScrollArea className="w-full">
                    <div className="space-y-2 min-w-[600px]">
                      {/* Cabeçalho */}
                      <div className="grid grid-cols-[1fr_1fr_1fr_80px_60px_60px_60px_80px] gap-2 px-3 py-1">
                        <p className="text-xs font-medium text-muted-foreground">Data/Hora</p>
                        <p className="text-xs font-medium text-muted-foreground">Arquivo</p>
                        <p className="text-xs font-medium text-muted-foreground">Fundo</p>
                        <p className="text-xs font-medium text-muted-foreground">Data Ref.</p>
                        <p className="text-xs font-medium text-muted-foreground text-right">Total</p>
                        <p className="text-xs font-medium text-muted-foreground text-right">Import.</p>
                        <p className="text-xs font-medium text-muted-foreground text-right">Rejeit.</p>
                        <p className="text-xs font-medium text-muted-foreground text-center">Status</p>
                      </div>

                      {estoqueFidcHistory.map((item) => {
                        const statusColor =
                          item.status === 'success'
                            ? 'text-green-600 bg-green-500/10'
                            : item.status === 'partial_success'
                              ? 'text-amber-600 bg-amber-500/10'
                              : item.status === 'processing'
                                ? 'text-blue-600 bg-blue-500/10'
                                : 'text-red-600 bg-red-500/10';
                        const statusLabel =
                          item.status === 'success' ? 'Sucesso'
                            : item.status === 'partial_success' ? 'Parcial'
                              : item.status === 'processing' ? 'Processando'
                                : item.status === 'error' ? 'Erro'
                                  : item.status;

                        const createdAt = new Date(item.created_at);
                        const dateStr = createdAt.toLocaleDateString('pt-BR');
                        const timeStr = createdAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                        const refDate = item.reference_date
                          ? item.reference_date.split('-').reverse().join('/')
                          : '—';

                        return (
                          <div
                            key={item.id}
                            className="grid grid-cols-[1fr_1fr_1fr_80px_60px_60px_60px_80px] gap-2 items-center px-3 py-2 rounded-md bg-accent/30 hover:bg-accent/50 transition-colors"
                            title={item.error_message ?? undefined}
                          >
                            <p className="text-xs truncate">{dateStr} {timeStr}</p>
                            <p className="text-xs truncate" title={item.file_name}>{item.file_name}</p>
                            <p className="text-xs truncate" title={item.fund_name ?? ''}>
                              {item.fund_name ?? <span className="text-muted-foreground italic">—</span>}
                            </p>
                            <p className="text-xs">{refDate}</p>
                            <p className="text-xs text-right">{item.total_rows}</p>
                            <p className="text-xs text-right text-green-600">{item.imported_rows}</p>
                            <p className="text-xs text-right text-red-600">{item.rejected_rows}</p>
                            <div className="flex justify-center">
                              <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', statusColor)}>
                                {statusLabel}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </TabsContent>
          {/* ============================================================ */}
          {/* ABA: Despesas Fundos                                          */}
          {/* ============================================================ */}
          <TabsContent value="despesas" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Wallet className="w-5 h-5 text-primary" />
                    Despesas Operacionais dos Fundos
                  </CardTitle>
                  <CardDescription>
                    Importe relatórios de despesas dos custodiantes. Formatos suportados:
                    <strong> Relatório Mensal de Despesas Intrag/Itaú</strong> (.xls),
                    <strong> Extrato de Caixa BTG</strong> (.xlsx) e
                    <strong> Extrato de Caixa CVPAR</strong> (.csv).
                    Múltiplos arquivos e custodiantes podem ser enviados juntos.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Área de upload */}
                <div
                  className={cn(
                    "relative border-2 border-dashed rounded-lg p-8 transition-colors",
                    "hover:border-primary/50 hover:bg-accent/30",
                    "flex flex-col items-center justify-center gap-4 text-center",
                    isDespesasUploading && "pointer-events-none opacity-50"
                  )}
                  onDrop={(e) => {
                    e.preventDefault();
                    const dropped = Array.from(e.dataTransfer.files).filter((f) => {
                      const ext = f.name.split('.').pop()?.toLowerCase();
                      return ext === 'csv' || ext === 'xls' || ext === 'xlsx';
                    });
                    if (dropped.length > 0) {
                      setDespesasFiles((prev) => [...prev, ...dropped]);
                      setDespesasResult(null);
                    } else {
                      toast({ title: 'Arquivo inválido', description: 'Use .csv, .xls ou .xlsx.', variant: 'destructive' });
                    }
                  }}
                  onDragOver={(e) => e.preventDefault()}
                >
                  <Upload className="w-8 h-8 text-primary" />
                  <div>
                    <p className="font-medium">Arraste os arquivos aqui ou clique para selecionar</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Intrag .xls · BTG .xlsx · CVPAR .csv — múltiplos arquivos suportados
                    </p>
                  </div>
                  <input
                    type="file"
                    accept=".csv,.xls,.xlsx"
                    multiple
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    disabled={isDespesasUploading}
                    onChange={(e) => {
                      if (e.target.files) {
                        setDespesasFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
                        setDespesasResult(null);
                      }
                    }}
                  />
                </div>

                {/* Lista de arquivos selecionados */}
                {despesasFiles.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">{despesasFiles.length} arquivo(s) selecionado(s)</p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setDespesasFiles([]); setDespesasResult(null); }}
                        disabled={isDespesasUploading}
                      >
                        <Trash2 className="w-3 h-3 mr-1" />
                        Limpar
                      </Button>
                    </div>
                    <ScrollArea className="h-[120px] w-full rounded-md border p-3">
                      <div className="space-y-1">
                        {despesasFiles.map((f, i) => (
                          <div key={`${f.name}-${i}`} className="flex items-center justify-between p-2 rounded bg-accent/50">
                            <div className="flex items-center gap-2 min-w-0">
                              <Wallet className="w-3.5 h-3.5 text-primary shrink-0" />
                              <span className="text-xs truncate">{f.name}</span>
                              <span className="text-[10px] text-muted-foreground shrink-0">
                                {(f.size / 1024).toFixed(0)} KB
                              </span>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0"
                              onClick={() => setDespesasFiles((prev) => prev.filter((_, idx) => idx !== i))}
                              disabled={isDespesasUploading}
                            >
                              <XCircle className="w-3 h-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </div>
                )}

                {/* Botão importar */}
                <Button
                  className="w-full"
                  onClick={handleDespesasUpload}
                  disabled={despesasFiles.length === 0 || isDespesasUploading}
                >
                  {isDespesasUploading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Importando...
                    </>
                  ) : (
                    <>
                      <FileUp className="w-4 h-4 mr-2" />
                      Importar Despesas ({despesasFiles.length} arquivo{despesasFiles.length !== 1 ? 's' : ''})
                    </>
                  )}
                </Button>

                {/* Resultado */}
                {despesasResult && (
                  <Card className={despesasResult.ok ? 'border-green-500/50' : 'border-red-500/50'}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        {despesasResult.ok ? (
                          <CheckCircle2 className="w-5 h-5 text-green-500" />
                        ) : (
                          <AlertTriangle className="w-5 h-5 text-red-500" />
                        )}
                        {despesasResult.ok ? 'Importação concluída' : 'Erro na importação'}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {/* Resumo geral */}
                      {despesasResult.ok && (
                        <div className="grid grid-cols-3 gap-3">
                          <div className="text-center p-2 rounded-lg bg-accent/50">
                            <p className="text-xl font-bold">{despesasResult.total_registros}</p>
                            <p className="text-xs text-muted-foreground">Lançamentos lidos</p>
                          </div>
                          <div className="text-center p-2 rounded-lg bg-green-500/10">
                            <p className="text-xl font-bold text-green-600">{despesasResult.total_importados}</p>
                            <p className="text-xs text-muted-foreground">Importados</p>
                          </div>
                          <div className="text-center p-2 rounded-lg bg-muted/50">
                            <p className="text-xl font-bold text-muted-foreground">
                              {despesasResult.total_registros - despesasResult.total_importados}
                            </p>
                            <p className="text-xs text-muted-foreground">Já existentes</p>
                          </div>
                        </div>
                      )}

                      {/* Detalhe por arquivo */}
                      {despesasResult.arquivos.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Detalhe por arquivo
                          </p>
                          {despesasResult.arquivos.map((arq, i) => (
                            <div key={i} className="p-2 rounded-md bg-accent/30 space-y-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-medium truncate" title={arq.arquivo}>{arq.arquivo}</span>
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                                  {FORMATO_LABELS[arq.formato] ?? arq.formato}
                                </span>
                              </div>
                              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                <span>{arq.total} lidos</span>
                                <span className="text-green-600 font-medium">{arq.inserted} importados</span>
                                {arq.skipped > 0 && <span>{arq.skipped} já existiam</span>}
                              </div>
                              {arq.erros.length > 0 && (
                                <p className="text-xs text-red-600">{arq.erros.join(' | ')}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Erro global */}
                      {!despesasResult.ok && despesasResult.error && (
                        <p className="text-sm text-red-600">{despesasResult.error}</p>
                      )}
                    </CardContent>
                  </Card>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ─── Controle Cotas ─────────────────────────────────────────── */}
          <TabsContent value="cotas" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <TrendingUp className="w-5 h-5 text-primary" />
                    Controle Cotas
                  </CardTitle>
                  <CardDescription>
                    Importe um ou vários relatórios "Consulta Cotas Carteira por Data" (XLS, XLSX ou CSV) de uma só vez.
                    A data é detectada automaticamente pelo nome do arquivo. Se não encontrada, usa a data de fallback.
                    Cada arquivo consolida a série histórica e recalcula métricas de risco: retorno diário, desvio padrão, alerta 3σ e VaR 95% via EWMA.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">

                {/* Data de fallback */}
                <div className="flex flex-col sm:flex-row gap-4 items-start">
                  <div className="space-y-2">
                    <label className="text-sm font-medium flex items-center gap-2">
                      <Calendar className="w-4 h-4" />
                      Data de fallback
                      <span className="text-xs font-normal text-muted-foreground">(usada quando não há data no nome do arquivo)</span>
                    </label>
                    <input
                      type="date"
                      value={cotasDataFallback}
                      onChange={(e) => setCotasDataFallback(e.target.value)}
                      className="flex h-9 w-[180px] rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                    />
                  </div>
                </div>

                {/* Área drag-and-drop — aceita múltiplos arquivos */}
                <div
                  className={cn(
                    "relative border-2 border-dashed rounded-lg p-8 transition-colors",
                    "hover:border-primary/50 hover:bg-accent/30",
                    "flex flex-col items-center justify-center gap-4 text-center",
                    isCotasUploading && "pointer-events-none opacity-50"
                  )}
                  onDrop={(e) => {
                    e.preventDefault();
                    addCotasFiles(Array.from(e.dataTransfer.files));
                  }}
                  onDragOver={(e) => e.preventDefault()}
                >
                  <Upload className="w-8 h-8 text-primary" />
                  <div>
                    <p className="font-medium">Arraste um ou vários arquivos aqui ou clique para selecionar</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Consulta Cotas Carteira por Data — XLS, XLSX ou CSV
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Dica: inclua a data no nome do arquivo (ex.: <code className="bg-muted px-1 rounded">cotas_20260312.xlsx</code>)
                    </p>
                  </div>
                  <input
                    type="file"
                    accept=".xls,.xlsx,.csv"
                    multiple
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    disabled={isCotasUploading}
                    onChange={(e) => {
                      if (e.target.files) addCotasFiles(Array.from(e.target.files));
                      e.target.value = "";
                    }}
                  />
                </div>

                {/* Lista de arquivos selecionados */}
                {cotasFiles.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">{cotasFiles.length} arquivo(s) na fila</p>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7 text-muted-foreground"
                        onClick={() => { setCotasFiles([]); setCotasBatchResults([]); }}
                        disabled={isCotasUploading}
                      >
                        Limpar tudo
                      </Button>
                    </div>

                    <div className="rounded-md border divide-y max-h-72 overflow-y-auto">
                      {cotasFiles.map((entry, idx) => {
                        const resultIdx = cotasBatchResults.findIndex((r) => r.filename === entry.file.name && r.date === entry.date);
                        const result = resultIdx >= 0 ? cotasBatchResults[resultIdx] : null;
                        const isProcessing = isCotasUploading && cotasProgress && cotasProgress.current - 1 === idx;

                        return (
                          <div key={`${entry.file.name}-${idx}`} className={cn(
                            "flex items-center gap-3 px-3 py-2",
                            result?.success === true && "bg-green-50/50 dark:bg-green-950/10",
                            result?.success === false && "bg-red-50/50 dark:bg-red-950/10",
                          )}>
                            {/* Status icon */}
                            <div className="shrink-0">
                              {isProcessing ? (
                                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                              ) : result?.success === true ? (
                                <CheckCircle2 className="w-4 h-4 text-green-500" />
                              ) : result?.success === false ? (
                                <AlertTriangle className="w-4 h-4 text-red-500" />
                              ) : (
                                <TrendingUp className="w-4 h-4 text-muted-foreground" />
                              )}
                            </div>

                            {/* Nome e tamanho */}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate" title={entry.file.name}>{entry.file.name}</p>
                              <div className="flex items-center gap-3 flex-wrap">
                                <p className="text-xs text-muted-foreground">{(entry.file.size / 1024).toFixed(1)} KB</p>
                                {result?.success === true && (
                                  <div className="space-y-0.5">
                                    <p className="text-xs text-green-600">
                                      {result.recordsSerie ?? 0} cotas · {result.clientesImpactados?.length ?? 0} clientes
                                    </p>
                                    {((result.recordsSerie ?? 0) > 0 && (result.recordsMetricas ?? 0) === 0) && (
                                      <p className="text-[11px] text-amber-600">
                                        Serie salva, mas sem metricas. Verifique historico insuficiente ou data_posicao incorreta.
                                      </p>
                                    )}
                                  </div>
                                )}
                                {result?.success === false && (
                                  <p className="text-xs text-red-600 truncate" title={result.error}>{result.error}</p>
                                )}
                              </div>
                            </div>

                            {/* Seletor de data por arquivo */}
                            <div className="shrink-0">
                              <input
                                type="date"
                                value={entry.date}
                                onChange={(e) => setCotasFiles((prev) =>
                                  prev.map((item, i) => i === idx ? { ...item, date: e.target.value } : item)
                                )}
                                disabled={isCotasUploading}
                                className="flex h-7 w-[138px] rounded border border-input bg-transparent px-2 text-xs shadow-sm disabled:opacity-50"
                              />
                              {!entry.date && (
                                <p className="text-[10px] text-amber-600 mt-0.5 text-center">data obrigatória</p>
                              )}
                            </div>

                            {/* Remover */}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="shrink-0 h-7 w-7"
                              onClick={() => setCotasFiles((prev) => prev.filter((_, i) => i !== idx))}
                              disabled={isCotasUploading}
                            >
                              <XCircle className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Barra de progresso */}
                {cotasProgress && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Processando arquivo {cotasProgress.current} de {cotasProgress.total}...</span>
                      <span>{Math.round((cotasProgress.current / cotasProgress.total) * 100)}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-300 rounded-full"
                        style={{ width: `${(cotasProgress.current / cotasProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Botão de importação */}
                <Button
                  className="w-full"
                  onClick={handleCotasUpload}
                  disabled={cotasFiles.length === 0 || cotasFiles.every((e) => !e.date) || isCotasUploading}
                >
                  {isCotasUploading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Importando {cotasProgress ? `${cotasProgress.current}/${cotasProgress.total}` : "..."}
                    </>
                  ) : (
                    <>
                      <FileUp className="w-4 h-4 mr-2" />
                      Importar {cotasFiles.length > 0 ? `${cotasFiles.filter((e) => e.date).length} arquivo(s)` : "Controle Cotas"}
                    </>
                  )}
                </Button>

                {cotasFiles.some((e) => !e.date) && !isCotasUploading && (
                  <p className="text-xs text-amber-600 text-center">
                    {cotasFiles.filter((e) => !e.date).length} arquivo(s) sem data — defina a data de fallback ou edite individualmente.
                  </p>
                )}

                {/* Resumo agregado dos resultados */}
                {cotasBatchResults.length > 0 && !isCotasUploading && (
                  <Card className={
                    cotasBatchResults.every((r) => r.success)
                      ? "border-green-500/50"
                      : cotasBatchResults.some((r) => r.success)
                      ? "border-amber-500/50"
                      : "border-red-500/50"
                  }>
                    <CardContent className="pt-4 space-y-3">
                      <div className="flex items-center gap-3">
                        {cotasBatchResults.every((r) => r.success) ? (
                          <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />
                        ) : (
                          <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                        )}
                        <div>
                          <p className="font-medium">
                            {cotasBatchResults.filter((r) => r.success).length} de {cotasBatchResults.length} arquivo(s) importado(s) com sucesso
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {cotasBatchResults.reduce((s, r) => s + (r.recordsSerie ?? 0), 0)} cotas na série ·{" "}
                            {cotasBatchResults.reduce((s, r) => s + (r.recordsMetricas ?? 0), 0)} métricas recalculadas
                          </p>
                          {cotasBatchResults.some((r) => r.success && (r.recordsSerie ?? 0) > 0 && (r.recordsMetricas ?? 0) === 0) && (
                            <p className="text-xs text-amber-600 mt-1">
                              Pelo menos um arquivo foi salvo na série, mas não gerou métricas. Isso normalmente indica histórico insuficiente
                              ou data de referência incorreta no upload.
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Erros por arquivo */}
                      {cotasBatchResults.some((r) => !r.success || (r.errors && r.errors.length > 0)) && (
                        <div className="space-y-1">
                          {cotasBatchResults.filter((r) => !r.success || (r.errors && r.errors.length > 0)).map((r, i) => (
                            <div key={i} className="rounded-md bg-muted/40 p-2 space-y-0.5">
                              <p className="text-xs font-medium text-muted-foreground truncate">{r.filename}</p>
                              {r.error && <p className="text-xs text-red-600">{r.error}</p>}
                              {r.errors?.map((e, j) => (
                                <p key={j} className="text-xs text-red-600">{e}</p>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ─── Carteira Finvest ──────────────────────────────────────────── */}
          <TabsContent value="carteira-finvest" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Layers className="w-5 h-5 text-primary" />
                  Carteira Diária Finvest
                </CardTitle>
                <CardDescription>
                  Importe um ou vários arquivos "Carteira Diária" exportados pelo administrador Finvest (CSV separado por ";", encoding latin-1).
                  Arraste arquivos de tipos diferentes de uma vez: FII, FIP, FIC — cada um é processado individualmente e os fundos
                  são identificados automaticamente dentro de cada arquivo.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">

                {/* Área drag-and-drop — múltiplos arquivos */}
                <div
                  className={cn(
                    "relative border-2 border-dashed rounded-lg p-8 transition-colors",
                    "hover:border-primary/50 hover:bg-accent/30",
                    "flex flex-col items-center justify-center gap-4 text-center",
                    isFinvestUploading && "pointer-events-none opacity-50",
                  )}
                  onDrop={(e) => {
                    e.preventDefault();
                    addFinvestFiles(Array.from(e.dataTransfer.files));
                  }}
                  onDragOver={(e) => e.preventDefault()}
                >
                  <FileSpreadsheet className="w-8 h-8 text-primary" />
                  <div>
                    <p className="font-medium">Arraste um ou vários arquivos CSV aqui ou clique para selecionar</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Carteira Diária Finvest — CSV (layout LayCrtDia) · FII, FIP, FIC
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Exemplo: <code className="bg-muted px-1 rounded">Carteira Diária - 260316_140223.csv</code>
                    </p>
                  </div>
                  <input
                    type="file"
                    accept=".csv,.txt"
                    multiple
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    disabled={isFinvestUploading}
                    onChange={(e) => {
                      if (e.target.files) addFinvestFiles(Array.from(e.target.files));
                      e.target.value = "";
                    }}
                  />
                </div>

                {/* Lista de arquivos na fila */}
                {finvestFiles.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">{finvestFiles.length} arquivo(s) na fila</p>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7 text-muted-foreground"
                        onClick={() => { setFinvestFiles([]); setFinvestResults([]); }}
                        disabled={isFinvestUploading}
                      >
                        Limpar tudo
                      </Button>
                    </div>

                    <div className="rounded-md border divide-y max-h-64 overflow-y-auto">
                      {finvestFiles.map((file, idx) => {
                        const result = finvestResults.find((r) => r.filename === file.name);
                        const isProcessing =
                          isFinvestUploading &&
                          finvestProgress &&
                          finvestProgress.current - 1 === idx;

                        return (
                          <div
                            key={`${file.name}-${idx}`}
                            className={cn(
                              "flex items-center gap-3 px-3 py-2",
                              result?.success === true && "bg-green-50/50 dark:bg-green-950/10",
                              result?.success === false && "bg-red-50/50 dark:bg-red-950/10",
                            )}
                          >
                            {/* Ícone de status */}
                            <div className="shrink-0">
                              {isProcessing ? (
                                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                              ) : result?.success === true ? (
                                <CheckCircle2 className="w-4 h-4 text-green-500" />
                              ) : result?.success === false ? (
                                <AlertTriangle className="w-4 h-4 text-red-500" />
                              ) : (
                                <FileSpreadsheet className="w-4 h-4 text-muted-foreground" />
                              )}
                            </div>

                            {/* Nome e resultado resumido */}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate" title={file.name}>{file.name}</p>
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
                                {result?.success === true && (
                                  <p className="text-xs text-green-600">
                                    {result.imported_rows ?? 0} itens
                                    {(result.fundos_processados?.length ?? 0) > 0 && ` · ${result.fundos_processados!.join(", ")}`}
                                    {(result.flags_revisao ?? 0) > 0 && (
                                      <span className="text-amber-600"> · {result.flags_revisao} flag(s)</span>
                                    )}
                                  </p>
                                )}
                                {result?.success === false && (
                                  <p className="text-xs text-red-600 truncate" title={result.error}>{result.error}</p>
                                )}
                              </div>
                            </div>

                            {/* Remover */}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="shrink-0 h-7 w-7"
                              onClick={() =>
                                setFinvestFiles((prev) => prev.filter((_, i) => i !== idx))
                              }
                              disabled={isFinvestUploading}
                            >
                              <XCircle className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Barra de progresso */}
                {finvestProgress && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Processando arquivo {finvestProgress.current} de {finvestProgress.total}...</span>
                      <span>{Math.round((finvestProgress.current / finvestProgress.total) * 100)}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-300 rounded-full"
                        style={{ width: `${(finvestProgress.current / finvestProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Botão de importação */}
                <Button
                  className="w-full"
                  onClick={handleFinvestUpload}
                  disabled={finvestFiles.length === 0 || isFinvestUploading}
                >
                  {isFinvestUploading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Importando {finvestProgress ? `${finvestProgress.current}/${finvestProgress.total}` : "..."}
                    </>
                  ) : (
                    <>
                      <FileUp className="w-4 h-4 mr-2" />
                      Importar {finvestFiles.length > 0 ? `${finvestFiles.length} arquivo(s)` : "Carteira Finvest"}
                    </>
                  )}
                </Button>

                {/* Resumo agregado dos resultados */}
                {finvestResults.length > 0 && !isFinvestUploading && (
                  <Card className={
                    finvestResults.every((r) => r.success)
                      ? "border-green-500/50"
                      : finvestResults.some((r) => r.success)
                      ? "border-amber-500/50"
                      : "border-red-500/50"
                  }>
                    <CardContent className="pt-4 space-y-3">
                      <div className="flex items-start gap-3">
                        {finvestResults.every((r) => r.success) ? (
                          <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
                        ) : (
                          <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                        )}
                        <div className="flex-1 space-y-2">
                          <p className="font-medium">
                            {finvestResults.filter((r) => r.success).length} de {finvestResults.length} arquivo(s) importado(s) com sucesso
                          </p>

                          {/* Métricas agregadas */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            <div className="rounded-md bg-muted/40 p-2 text-center">
                              <p className="text-lg font-bold">
                                {finvestResults.reduce((s, r) => s + (r.imported_rows ?? 0), 0)}
                              </p>
                              <p className="text-xs text-muted-foreground">Itens importados</p>
                            </div>
                            <div className="rounded-md bg-green-50 dark:bg-green-950/20 p-2 text-center">
                              <p className="text-lg font-bold text-green-700 dark:text-green-400">
                                {finvestResults.reduce((s, r) => s + (r.consolidados ?? 0), 0)}
                              </p>
                              <p className="text-xs text-muted-foreground">Consolidados c/ XML</p>
                            </div>
                            <div className={cn(
                              "rounded-md p-2 text-center",
                              finvestResults.reduce((s, r) => s + (r.flags_revisao ?? 0), 0) > 0
                                ? "bg-amber-50 dark:bg-amber-950/20"
                                : "bg-muted/40",
                            )}>
                              <p className={cn(
                                "text-lg font-bold",
                                finvestResults.reduce((s, r) => s + (r.flags_revisao ?? 0), 0) > 0
                                  && "text-amber-700 dark:text-amber-400",
                              )}>
                                {finvestResults.reduce((s, r) => s + (r.flags_revisao ?? 0), 0)}
                              </p>
                              <p className="text-xs text-muted-foreground">Flags revisão</p>
                            </div>
                            <div className="rounded-md bg-muted/40 p-2 text-center">
                              <p className="text-lg font-bold">
                                {finvestResults.reduce((s, r) => s + (r.somente_csv ?? 0), 0)}
                              </p>
                              <p className="text-xs text-muted-foreground">Somente CSV</p>
                            </div>
                          </div>

                          {/* Alerta de flags */}
                          {finvestResults.reduce((s, r) => s + (r.flags_revisao ?? 0), 0) > 0 && (
                            <div className="flex items-start gap-1.5 rounded-md bg-amber-50 dark:bg-amber-950/20 p-2 text-amber-800 dark:text-amber-300">
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                              <p className="text-xs">
                                Existem itens com divergência material (&gt;5%) entre CSV e XML.
                                Revise os registros com <code>status_consolidacao = 'flag_revisao'</code> na tabela <strong>posicao_consolidada</strong>.
                              </p>
                            </div>
                          )}

                          {/* Erros por arquivo */}
                          {finvestResults.some((r) => !r.success || (r.parse_errors?.length ?? 0) > 0) && (
                            <div className="space-y-1 pt-1">
                              {finvestResults
                                .filter((r) => !r.success || (r.parse_errors?.length ?? 0) > 0)
                                .map((r, i) => (
                                  <div key={i} className="rounded-md bg-muted/40 p-2 space-y-0.5">
                                    <p className="text-xs font-medium text-muted-foreground truncate">{r.filename}</p>
                                    {r.error && <p className="text-xs text-red-600">{r.error}</p>}
                                    {r.parse_errors?.map((e, j) => (
                                      <p key={j} className="text-xs text-amber-600">{e}</p>
                                    ))}
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Informativo sobre a consolidação */}
                <Card className="border-dashed bg-muted/30">
                  <CardContent className="pt-4">
                    <div className="flex items-start gap-2">
                      <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                      <div className="text-xs text-muted-foreground space-y-1">
                        <p><strong>Como funciona a consolidação:</strong></p>
                        <ul className="list-disc list-inside space-y-0.5 ml-1">
                          <li><strong>Somente CSV:</strong> item existe no Finvest mas não no XML para este fundo/data.</li>
                          <li><strong>Consolidado OK:</strong> mesmo item encontrado no XML com granularidade equivalente.</li>
                          <li><strong>Refinado CSV:</strong> XML tem classificação genérica; CSV traz detalhe analítico superior.</li>
                          <li><strong>Flag revisão:</strong> divergência de valor &gt;5% entre as duas fontes — requer análise manual.</li>
                        </ul>
                        <p className="pt-1">
                          Os módulos de <strong>Liquidez</strong>, <strong>Enquadramento</strong> e <strong>Crédito</strong> podem consumir
                          a tabela <code className="bg-muted px-1 rounded">posicao_consolidada</code> para acesso à classificação enriquecida.
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Aba: Fluxo Financeiro (CaixaFluxoFinanceiro) ── */}
          <TabsContent value="caixa-fluxo" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-primary" />
                  Fluxo Financeiro — CaixaFluxoFinanceiro
                </CardTitle>
                <CardDescription>
                  Importe a planilha <strong>CaixaFluxoFinanceiro.xlsx</strong> exportada pelo administrador.
                  O CNPJ do fundo é lido automaticamente da coluna <strong>"CNPJ da classe"</strong> de cada linha —
                  um único arquivo pode conter dados de múltiplos fundos.
                  Apenas registros com subtipo <strong>"Resgate de/do portfólio investido"</strong> são gravados.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">

                {/* Área drag-and-drop */}
                <div
                  className={cn(
                    "relative border-2 border-dashed rounded-lg p-8 transition-colors",
                    "hover:border-primary/50 hover:bg-accent/30",
                    "flex flex-col items-center justify-center gap-4 text-center",
                    isCaixaFluxoUploading && "pointer-events-none opacity-50"
                  )}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files[0];
                    if (f?.name.toLowerCase().endsWith(".xlsx")) {
                      setCaixaFluxoFile(f);
                      setCaixaFluxoResult(null);
                    } else {
                      toast({ title: "Arquivo inválido", description: "Selecione um arquivo .xlsx.", variant: "destructive" });
                    }
                  }}
                  onDragOver={(e) => e.preventDefault()}
                >
                  <FileSpreadsheet className="w-8 h-8 text-primary" />
                  <div>
                    <p className="font-medium">
                      {caixaFluxoFile ? caixaFluxoFile.name : "Arraste o XLSX aqui ou clique para selecionar"}
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      CaixaFluxoFinanceiro*.xlsx
                    </p>
                  </div>
                  <input
                    type="file"
                    accept=".xlsx"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    disabled={isCaixaFluxoUploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) { setCaixaFluxoFile(f); setCaixaFluxoResult(null); }
                      e.target.value = "";
                    }}
                  />
                </div>

                {/* Botão + resultado */}
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Button
                      onClick={handleCaixaFluxoUpload}
                      disabled={!caixaFluxoFile || isCaixaFluxoUploading}
                      className="h-9"
                    >
                      {isCaixaFluxoUploading ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin mr-2" />
                          Importando...
                        </>
                      ) : (
                        <>
                          <FileUp className="w-4 h-4 mr-2" />
                          Importar (todos os fundos)
                        </>
                      )}
                    </Button>

                    {caixaFluxoFile && !isCaixaFluxoUploading && !caixaFluxoResult && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 text-muted-foreground text-xs"
                        onClick={() => setCaixaFluxoFile(null)}
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-1" />
                        Limpar
                      </Button>
                    )}
                  </div>

                  {/* Resultado de erro */}
                  {caixaFluxoResult && !caixaFluxoResult.success && (
                    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 dark:bg-red-950/20 p-3">
                      <XCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                      <p className="text-sm text-red-700 dark:text-red-400">{caixaFluxoResult.error}</p>
                    </div>
                  )}

                  {/* Resultado de sucesso — breakdown por fundo */}
                  {caixaFluxoResult?.success && (caixaFluxoResult.inserted ?? 0) > 0 && (
                    <div className="rounded-md border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 p-3 space-y-2">
                      <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="w-4 h-4" />
                        {caixaFluxoResult.message ?? `${caixaFluxoResult.inserted ?? 0} registro(s) importado(s).`}
                      </div>
                      {caixaFluxoResult.porFundo && caixaFluxoResult.porFundo.length > 0 && (
                        <div className="divide-y divide-emerald-100 dark:divide-emerald-900 rounded border border-emerald-200 bg-white dark:bg-emerald-950/30 overflow-hidden">
                          {caixaFluxoResult.porFundo.map((f) => (
                            <div key={f.cnpj} className="flex items-center gap-3 px-3 py-2 text-xs">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                              <span className="font-medium flex-1 truncate">{f.nome ?? f.cnpj}</span>
                              <span className="font-mono text-muted-foreground text-[10px]">{f.cnpj}</span>
                              <span className="font-mono font-semibold text-emerald-700">{f.count} reg.</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Diagnóstico quando 0 resgates importados */}
                  {caixaFluxoResult?.success && (caixaFluxoResult.inserted ?? 0) === 0 && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
                      <div className="flex items-start gap-1.5">
                        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                        <div className="text-sm text-amber-700 dark:text-amber-400 space-y-1">
                          <p className="font-medium">{caixaFluxoResult.message}</p>
                          {caixaFluxoResult.totalLinhas !== undefined && (
                            <p className="text-xs">
                              Linhas lidas: <strong>{caixaFluxoResult.totalLinhas}</strong> · 
                              Resgates de portfólio: <strong>{caixaFluxoResult.linhasResgate ?? 0}</strong>
                            </p>
                          )}
                          {caixaFluxoResult.colunasDetectadas && (
                            <p className="text-xs font-mono">
                              Colunas: subtipo=col{caixaFluxoResult.colunasDetectadas.subtipo ?? '?'} · 
                              data=col{caixaFluxoResult.colunasDetectadas.data_liquidacao ?? '?'} · 
                              cnpj=col{caixaFluxoResult.colunasDetectadas.cnpj_classe ?? '—'}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Informativo */}
                <Card className="border-dashed bg-muted/30">
                  <CardContent className="pt-4">
                    <div className="flex items-start gap-2">
                      <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                      <div className="text-xs text-muted-foreground space-y-1">
                        <p><strong>Como funciona:</strong></p>
                        <ul className="list-disc list-inside space-y-0.5 ml-1">
                          <li>O CNPJ do fundo analisador é lido da coluna <strong>"CNPJ da classe"</strong> de cada linha.</li>
                          <li>Um arquivo pode conter múltiplos fundos — todos são importados em uma única operação.</li>
                          <li>Reimport seguro: ao importar o mesmo arquivo, os registros anteriores são substituídos.</li>
                          <li>Após a importação, acesse <strong>Liquidez → Descasamento Operacional</strong> para visualizar a análise.</li>
                          <li>Os dados também alimentam a coluna <strong>"Resg. Ativos"</strong> na tabela Vértice a Vértice de cada fundo.</li>
                        </ul>
                      </div>
                    </div>
                  </CardContent>
                </Card>

              </CardContent>
            </Card>
          </TabsContent>

          {/* ============================================================ */}
          {/* ABA: Cadastro ANBIMA (fundos_caracteristicas)                 */}
          {/* ============================================================ */}
          <TabsContent value="fundos-caracteristicas" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <FileSpreadsheet className="w-5 h-5 text-primary" />
                    Cadastro de Fundos ANBIMA
                  </CardTitle>
                  <CardDescription>
                    Importe a planilha <strong>FUNDOS-175-CARACTERISTICAS-PUBLICO.xlsx</strong> da ANBIMA
                    para atualizar ou incluir novos fundos e subclasses. Registros existentes são
                    atualizados pelo <strong>código ANBIMA</strong>; campos manuais (despesa
                    operacional, prazo de duração) são preservados.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Área de upload */}
                <div
                  className={cn(
                    "relative border-2 border-dashed rounded-lg p-8 transition-colors",
                    "hover:border-primary/50 hover:bg-accent/30",
                    "flex flex-col items-center justify-center gap-4 text-center",
                    isFundosCaractUploading && "pointer-events-none opacity-50"
                  )}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files[0];
                    const ext = f?.name.split('.').pop()?.toLowerCase();
                    if (f && (ext === 'xlsx' || ext === 'xls')) {
                      setFundosCaractFile(f);
                      setFundosCaractResult(null);
                    } else {
                      toast({ title: 'Arquivo inválido', description: 'Envie um .xlsx ou .xls da ANBIMA.', variant: 'destructive' });
                    }
                  }}
                  onDragOver={(e) => e.preventDefault()}
                >
                  <FileSpreadsheet className="w-8 h-8 text-primary" />
                  <div>
                    <p className="font-medium">Arraste o arquivo aqui ou clique para selecionar</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      FUNDOS-175-CARACTERISTICAS-PUBLICO.xlsx · apenas 1 arquivo
                    </p>
                  </div>
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    className="absolute inset-0 opacity-0 cursor-pointer"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        setFundosCaractFile(f);
                        setFundosCaractResult(null);
                      }
                      e.target.value = '';
                    }}
                  />
                </div>

                {/* Arquivo selecionado */}
                {fundosCaractFile && (
                  <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <FileSpreadsheet className="w-4 h-4 text-primary shrink-0" />
                      <span className="truncate max-w-xs">{fundosCaractFile.name}</span>
                      <span className="text-muted-foreground text-xs">
                        ({(fundosCaractFile.size / 1024 / 1024).toFixed(1)} MB)
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => { setFundosCaractFile(null); setFundosCaractResult(null); }}
                    >
                      ×
                    </Button>
                  </div>
                )}

                {/* Botão importar */}
                <Button
                  disabled={!fundosCaractFile || isFundosCaractUploading}
                  onClick={async () => {
                    if (!fundosCaractFile) return;
                    setIsFundosCaractUploading(true);
                    setFundosCaractResult(null);
                    try {
                      const { data: { session } } = await supabase.auth.getSession();

                      // ── Parse + mapeamento completo no browser ──────────────
                      // Evita WORKER_RESOURCE_LIMIT: o Edge Function recebe apenas
                      // o array final de registros tipados (payload ~300 KB vs 8 MB).
                      const records = await parseAnbimaXlsx(fundosCaractFile);
                      if (!records.length) throw new Error('Nenhum registro válido encontrado na planilha.');

                      const url = `${(supabase as any).supabaseUrl}/functions/v1/import-fundos-caracteristicas`;
                      const { upserted, inserted } = await postFundosCaracteristicasBatches(
                        records,
                        fundosCaractFile.name,
                        url,
                        session?.access_token,
                      );

                      const total = upserted + inserted;
                      const json = {
                        success: true as const,
                        filename: fundosCaractFile.name,
                        summary: {
                          total,
                          upserted_com_codigo_anbima: upserted,
                          inserted_sem_codigo_anbima: inserted,
                        },
                        message: `Importação concluída. ${upserted} com código ANBIMA; ${inserted} sem código; ${total} no total.`,
                      };
                      setFundosCaractResult(json);
                      toast({ title: 'Importação concluída', description: json.message });
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : 'Erro desconhecido';
                      setFundosCaractResult({ success: false, error: msg });
                      toast({ title: 'Erro', description: msg, variant: 'destructive' });
                    } finally {
                      setIsFundosCaractUploading(false);
                    }
                  }}
                  className="w-full"
                >
                  {isFundosCaractUploading ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Importando...</>
                  ) : (
                    <><FileUp className="w-4 h-4 mr-2" /> Importar Cadastro ANBIMA</>
                  )}
                </Button>

                {/* Resultado */}
                {fundosCaractResult && (
                  <div className={cn(
                    "rounded-lg border p-4 space-y-3",
                    fundosCaractResult.success
                      ? "border-green-500/30 bg-green-500/5"
                      : "border-red-500/30 bg-red-500/5"
                  )}>
                    <div className="flex items-center gap-2">
                      {fundosCaractResult.success
                        ? <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                        : <XCircle className="w-4 h-4 text-red-600 shrink-0" />
                      }
                      <p className={cn(
                        "text-sm font-medium",
                        fundosCaractResult.success ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
                      )}>
                        {fundosCaractResult.success ? fundosCaractResult.message : fundosCaractResult.error}
                      </p>
                    </div>

                    {fundosCaractResult.success && fundosCaractResult.summary && (
                      <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                        <div className="rounded-md bg-background border px-3 py-2">
                          <p className="text-2xl font-bold text-foreground">{fundosCaractResult.summary.total}</p>
                          <p>Total processado</p>
                        </div>
                        <div className="rounded-md bg-background border px-3 py-2">
                          <p className="text-2xl font-bold text-foreground">{fundosCaractResult.summary.upserted_com_codigo_anbima}</p>
                          <p>Com código ANBIMA</p>
                        </div>
                        <div className="rounded-md bg-background border px-3 py-2">
                          <p className="text-2xl font-bold text-foreground">{fundosCaractResult.summary.inserted_sem_codigo_anbima}</p>
                          <p>Sem código (novo)</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

        </Tabs>
      </div>
    </Layout>
  );
}
