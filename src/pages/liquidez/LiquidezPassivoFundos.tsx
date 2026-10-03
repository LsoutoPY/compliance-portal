import { useState, useMemo, useEffect, Fragment } from "react";
import { isFundoFechado } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Users,
  Search,
  Loader2,
  Building2,
  TrendingUp,
  FileUp,
  Download,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Upload,
  XCircle,
  CheckCircle2,
  AlertTriangle,
  FileSpreadsheet,
  Calendar,
  ArrowLeftRight,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { buildPassivoViewKeyResolver, dedupePassivoForView, isPassivoMetaLabel, isPassivoMetaCotista, isInvalidPassivoFundoName, type PassivoFundoRow } from "@/lib/passivoFundoMatch";
import { fetchUniversoCnpjsMonitorados } from "@/lib/fundosMonitorados";
import { isFundoPassivoInativo } from "@/lib/passivoFundoAtivo";
import { textoCotistaLgpd } from "@/lib/lgpdCotista";
import { CotistaNomeLgpd } from "@/components/lgpd/CotistaNomeLgpd";
import { RelatorioSortableHead } from "@/components/relatorios/RelatorioSortableHead";
import { sortRelatorioRows, useRelatorioSort } from "@/components/relatorios/useRelatorioSort";

// ── helpers de parse ──────────────────────────────────────────────────────────
function normalizePossiblyCentValue(valor: number, raw?: string): number {
  if (!Number.isFinite(valor)) return 0;
  if (!Number.isInteger(valor)) return valor;
  const hasExplicitDecimals = raw ? /[.,]\d{1,2}$/.test(raw) : false;
  if (hasExplicitDecimals) return valor;
  return valor >= 1e9 ? valor / 100 : valor;
}

function parseValorBrasil(v: unknown): number {
  if (v == null) return 0;

  if (typeof v === "number") {
    return normalizePossiblyCentValue(v);
  }

  const raw = String(v)
    .trim()
    .replace(/\s/g, "")
    .replace(/^R\$/, "")
    .replace(/[^\d,.-]/g, "");

  if (!raw) return 0;

  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  const hasComma = lastComma >= 0;
  const hasDot = lastDot >= 0;

  let normalized = raw;

  if (hasComma && hasDot) {
    if (lastComma > lastDot) {
      normalized = raw.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = raw.replace(/,/g, "");
    }
  } else if (hasComma) {
    const decimalDigits = raw.length - lastComma - 1;
    normalized = decimalDigits > 0 && decimalDigits <= 2
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(/,/g, "");
  } else if (hasDot) {
    const decimalDigits = raw.length - lastDot - 1;
    normalized = decimalDigits > 0 && decimalDigits <= 2
      ? raw.replace(/,/g, "")
      : raw.replace(/\./g, "");
  }

  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return 0;

  return normalizePossiblyCentValue(parsed, raw);
}

function extrairNomeInvestidor(texto: string): string | null {
  for (const prefix of ["Investidor:", "Cotista:", "Cliente:"]) {
    if (!texto.includes(prefix)) continue;
    const s = texto.split(prefix).pop()?.trim() ?? "";
    if (s.includes(" Valor de Cota:")) return s.split(" Valor de Cota:")[0].trim();
    if (s.includes("Valor de Cota:")) return s.split("Valor de Cota:")[0].trim();
    if (s.includes(" Valor:")) return s.split(" Valor:")[0].trim();
    return s || null;
  }
  return null;
}

function rowHasCotistaMarker(rowText: string): boolean {
  return /Investidor:|Cotista:|Cliente:/i.test(rowText);
}

function normalizeHeaderCell(h: unknown): string {
  return String(h ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ");
}

/** Fundo no cabeçalho — só célula após rótulo "Fundo" ou nome de aba que pareça fundo (nunca título do arquivo) */
function extractFundoFromSheetMeta(matrix: unknown[][], sheetName: string): string {
  for (let r = 0; r < Math.min(15, matrix.length); r++) {
    const row = matrix[r] as unknown[];
    for (let c = 0; c < Math.min(12, row?.length ?? 0); c++) {
      const label = normalizeHeaderCell(row[c]);
      if (label === "fundo" || label.startsWith("fundo ") || label.includes("nome do fundo")) {
        const next = String(row[c + 1] ?? "").trim();
        if (next.length >= 3 && !isInvalidPassivoFundoName(next)) return next;
      }
    }
  }
  const sn = sheetName.trim();
  if (sn && !/^plan\d+$/i.test(sn) && !/^sheet\d+$/i.test(sn) && !isInvalidPassivoFundoName(sn)) {
    return sn;
  }
  return "";
}

/** Quando o cabeçalho não nomeia a coluna de valor, infere pela coluna com mais números */
function findBestValorColumn(
  matrix: unknown[][],
  headerRowIdx: number,
  excludeCols: number[],
): number {
  const exclude = new Set(excludeCols.filter((c) => c >= 0));
  const width = Math.max(...matrix.slice(headerRowIdx, headerRowIdx + 20).map((r) => r?.length ?? 0), 0);
  let bestCol = -1;
  let bestScore = 0;
  for (let col = 0; col < width; col++) {
    if (exclude.has(col)) continue;
    let score = 0;
    for (let r = headerRowIdx + 1; r < Math.min(matrix.length, headerRowIdx + 25); r++) {
      const v = parseValorBrasil((matrix[r] as unknown[])?.[col]);
      if (v > 0) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCol = col;
    }
  }
  return bestScore >= 2 ? bestCol : -1;
}

async function describeXlsxLayout(file: File): Promise<string> {
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.SheetNames[0] ?? "?";
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: "" }) as unknown[][];
    const preview = matrix
      .slice(0, 4)
      .map((row) => (row as unknown[]).slice(0, 8).map((c) => String(c ?? "").slice(0, 24)).join(" | "))
      .join("; ");
    return `Aba "${sheet}": ${preview || "(vazia)"}`;
  } catch {
    return "";
  }
}

/**
 * Planilha tabular consolidada (ex.: Posição de Cotistas.xlsx)
 * Colunas típicas: fundo · cotista/cliente · valor/saldo
 */
async function parsePosicaoCotistasTabularXlsx(
  file: File,
): Promise<{ fundo: string; cotista: string; valor: number }[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const out: { fundo: string; cotista: string; valor: number }[] = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }) as unknown[][];
    if (!matrix.length) continue;

    for (let hi = 0; hi < Math.min(40, matrix.length); hi++) {
      const header = (matrix[hi] as unknown[]).map(normalizeHeaderCell);

      const colCotista = header.findIndex(
        (h) =>
          h === "cotista" ||
          h === "cliente" ||
          h === "investidor" ||
          h.includes("nome cotista") ||
          h.includes("nome do cotista") ||
          h.includes("razao social") ||
          h === "nome",
      );
      const colFundo = header.findIndex(
        (h) =>
          h === "fundo" ||
          h.includes("nome fundo") ||
          h.includes("nome do fundo") ||
          h === "classe" ||
          h.includes("nome classe") ||
          h.includes("classe de") ||
          h === "produto" ||
          h === "carteira" ||
          h === "ativo",
      );
      const colValor = header.findIndex(
        (h) =>
          (h.includes("valor") && !h.includes("cota") && !h.includes("unit")) ||
          h.includes("saldo") ||
          h.includes("posicao") ||
          h.includes("financeiro") ||
          h.includes("participacao") ||
          h.includes("bruto") ||
          h.includes("liquido") ||
          h === "pl" ||
          h.includes("vl posicao") ||
          h.includes("pos em"),
      );

      const hasCotista = colCotista >= 0;
      let colValorResolved = colValor;
      const hasFundo = colFundo >= 0;
      if (!hasCotista) continue;
      if (colValorResolved < 0) {
        colValorResolved = findBestValorColumn(matrix, hi, [colCotista, colFundo]);
      }
      if (colValorResolved < 0) continue;
      // Planilha consolidada: exige coluna de fundo — não usa título do arquivo
      if (!hasFundo) continue;

      for (let i = hi + 1; i < matrix.length; i++) {
        const row = matrix[i] as unknown[];
        const cotista = String(row[colCotista] ?? "").trim();
        const fundo = String(row[colFundo] ?? "").trim();
        const valor = parseValorBrasil(row[colValorResolved]);
        if (!cotista || !fundo || valor <= 0) continue;
        if (isInvalidPassivoFundoName(fundo) || isPassivoMetaCotista(cotista)) continue;
        out.push({ fundo, cotista, valor });
      }

      if (out.length > 0) break;
    }
    if (out.length > 0) break;
  }

  return out;
}

async function parsePosicaoCotasXlsx(file: File): Promise<{ fundo: string; cotista: string; valor: number }[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const rows: { fundo: string; cotista: string; valor: number }[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }) as unknown[][];
    let fundo = extractFundoFromSheetMeta(matrix, sheetName);
    if (!fundo) {
      const b1 = ws["B1"]?.v ? String(ws["B1"].v).trim() : "";
      if (b1 && !isInvalidPassivoFundoName(b1)) fundo = b1;
    }
    if (!fundo || isInvalidPassivoFundoName(fundo)) continue;
    let currentInvestor: string | null = null;
    const maxCol = Math.min(range.e.c + 1, 30);
    for (let r = range.s.r; r <= range.e.r; r++) {
      let rowText = "";
      for (let c = 0; c < maxCol; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell?.v) rowText += " " + String(cell.v).trim();
      }
      if (rowHasCotistaMarker(rowText)) currentInvestor = extrairNomeInvestidor(rowText);
      if (!currentInvestor) continue;
      const rowLower = rowText.toLowerCase();
      if (!rowLower.includes("total")) continue;
      let v = parseValorBrasil(ws[XLSX.utils.encode_cell({ r, c: 6 })]?.v);
      if (v <= 0) v = parseValorBrasil(ws[XLSX.utils.encode_cell({ r, c: 5 })]?.v);
      if (v <= 0) v = parseValorBrasil(ws[XLSX.utils.encode_cell({ r, c: 14 })]?.v);
      if (v <= 0) v = parseValorBrasil(ws[XLSX.utils.encode_cell({ r, c: 7 })]?.v);
      if (v > 0 && !isPassivoMetaCotista(currentInvestor)) {
        rows.push({ fundo, cotista: currentInvestor, valor: v });
      }
    }
    if (rows.length > 0) break;
  }
  return rows;
}

async function parsePassivoXlsx(file: File): Promise<{
  posicaoCotas: { fundo: string; cotista: string; valor: number }[];
  itau: { cliente: string; cpf: string; conta: string | null; fundo: string; cnpj_fundo: string; saldo_liquido: number }[];
}> {
  const tabular = await parsePosicaoCotistasTabularXlsx(file);
  if (tabular.length > 0) return { posicaoCotas: tabular, itau: [] };

  const posicaoCotas = (await parsePosicaoCotasXlsx(file)).filter(
    (r) => !isInvalidPassivoFundoName(r.fundo),
  );
  if (posicaoCotas.length > 0) return { posicaoCotas, itau: [] };

  const itau = await parseItauPassivoXlsx(file);
  return { posicaoCotas: [], itau: [] };
}

/** Detecta e parseia planilha de passivo do Itaú/Intrag.
 *  Layout esperado: cliente | CPF | conta | fundo | CNPJ Fundo | saldo_liquido
 *  Retorna [] se os cabeçalhos não baterem (arquivo não é do Itaú).
 */
async function parseItauPassivoXlsx(file: File): Promise<{
  cliente: string;
  cpf: string;
  conta: string | null;
  fundo: string;
  cnpj_fundo: string;
  saldo_liquido: number;
}[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true }) as unknown[][];
  if (!matrix || matrix.length < 2) return [];

  const header = matrix[0].map((h) => String(h ?? "").trim().toLowerCase());
  const colCliente = header.indexOf("cliente");
  const colCpf = header.indexOf("cpf");
  const colConta = header.indexOf("conta");
  const colFundo = header.indexOf("fundo");
  const colCnpj = header.findIndex((h) => h.includes("cnpj"));
  const colSaldo = header.findIndex((h) => h.includes("saldo"));

  // Validação mínima: precisa ter cliente, fundo e saldo
  if (colCliente < 0 || colFundo < 0 || colSaldo < 0) return [];

  const rows: { cliente: string; cpf: string; conta: string | null; fundo: string; cnpj_fundo: string; saldo_liquido: number }[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i] as unknown[];
    const cliente = String(row[colCliente] ?? "").trim();
    const fundo = String(row[colFundo] ?? "").trim();
    const saldo_liquido = parseValorBrasil(row[colSaldo]);
    if (!cliente || !fundo || saldo_liquido <= 0) continue;
    rows.push({
      cliente,
      cpf: colCpf >= 0 ? String(row[colCpf] ?? "").trim() : "",
      conta: colConta >= 0 ? String(row[colConta] ?? "").trim() || null : null,
      fundo,
      cnpj_fundo: colCnpj >= 0 ? String(row[colCnpj] ?? "").trim() : "",
      saldo_liquido,
    });
  }
  return rows;
}

export default function LiquidezPassivoFundos() {
  const LATEST_BY_FUND = "__latest_by_fund__";

type PassivoFundSummarySortKey =
  | "fundo"
  | "admin"
  | "dataPosicao"
  | "pl"
  | "cotistas"
  | "maiorPct"
  | "top5Pct"
  | "concentracao";

const PASSIVO_CONC_SORT_PRIORITY: Record<string, number> = {
  alta: 0,
  media: 1,
  baixa: 2,
  fechado: 3,
};

function passivoFundConcStatus(isFechado: boolean, top5Pct: number): string {
  if (isFechado) return "fechado";
  if (top5Pct >= 0.8) return "alta";
  if (top5Pct >= 0.5) return "media";
  return "baixa";
}
  const [selectedDate, setSelectedDate] = useState<string>(LATEST_BY_FUND);
  const [busca, setBusca] = useState("");
  const [selectedAdmin, setSelectedAdmin] = useState<string>("all");
  const [filtroStatusFundo, setFiltroStatusFundo] = useState<"ativos" | "inativos" | "todos">("ativos");
  const [expandedFund, setExpandedFund] = useState<string | null>(null);
  const { sortConfig, toggleSort, getDirection } = useRelatorioSort<PassivoFundSummarySortKey>("pl");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // ── estado: importar passivo ─────────────────────────────────────────────
  const [showPassivoDialog, setShowPassivoDialog] = useState(false);
  const [passivoFiles, setPassivoFiles] = useState<File[]>([]);
  const [passivoDataPosicao, setPassivoDataPosicao] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  });
  const [isPassivoUploading, setIsPassivoUploading] = useState(false);
  const [passivoResult, setPassivoResult] = useState<{ success: boolean; message?: string; error?: string; recordsInserted?: number } | null>(null);

  // ── estado: importar de-para ─────────────────────────────────────────────
  const [showDeParaDialog, setShowDeParaDialog] = useState(false);
  const [deParaFile, setDeParaFile] = useState<File | null>(null);
  const [isDeParaUploading, setIsDeParaUploading] = useState(false);
  const [deParaResult, setDeParaResult] = useState<{ success: boolean; message?: string; error?: string; recordsInserted?: number } | null>(null);
  const [isSinqiaPassivoImporting, setIsSinqiaPassivoImporting] = useState(false);
  const [showSinqiaPassivoConfirm, setShowSinqiaPassivoConfirm] = useState(false);

  const resolvePassivoApiDate = (): string => {
    if (selectedDate !== LATEST_BY_FUND && /^\d{8}$/.test(selectedDate)) {
      return selectedDate;
    }
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  };

  const handleSinqiaPassivoImport = async () => {
    setIsSinqiaPassivoImporting(true);
    try {
      const dataPosicao = resolvePassivoApiDate();
      const { data, error } = await supabase.functions.invoke<{
        success: boolean;
        message?: string;
        error?: string;
        recordsInserted?: number;
        positionsFetched?: number;
        log?: string[];
      }>("import-sinqia-passivo", {
        body: { data_posicao: dataPosicao },
      });

      if (error) {
        const body = await (error as { context?: Response }).context?.json?.().catch(() => null) as
          | { error?: string; log?: string[] }
          | null;
        throw new Error(body?.error ?? error.message);
      }
      if (!data?.success) {
        throw new Error(data?.error ?? "Falha na importação Finvest");
      }

      toast({
        title: "Passivo Finvest atualizado",
        description: data.message
          ?? `${data.recordsInserted ?? 0} registro(s) importado(s) (${data.positionsFetched ?? 0} da API).`,
      });
      await queryClient.invalidateQueries({ queryKey: ["passivo-fundos"] });
      await queryClient.invalidateQueries({ queryKey: ["passivo-dates"] });
      await queryClient.invalidateQueries({ queryKey: ["passivo-fundos-char"] });
    } catch (err) {
      toast({
        title: "Erro ao atualizar Finvest",
        description: err instanceof Error ? err.message : "Erro desconhecido",
        variant: "destructive",
      });
    } finally {
      setIsSinqiaPassivoImporting(false);
    }
  };

  const handlePassivoUpload = async () => {
    if (passivoFiles.length === 0) return;
    setIsPassivoUploading(true);
    setPassivoResult(null);
    try {
      const formData = new FormData();
      const csvFiles = passivoFiles.filter((f) => f.name.toLowerCase().endsWith(".csv"));
      const xlsxFiles = passivoFiles.filter((f) => f.name.toLowerCase().endsWith(".xlsx"));

      csvFiles.forEach((f) => formData.append("files", f));

      const allPosicaoRows: { fundo: string; cotista: string; valor: number }[] = [];
      const allItauRows: {
        cliente: string;
        cpf: string;
        conta: string | null;
        fundo: string;
        cnpj_fundo: string;
        saldo_liquido: number;
      }[] = [];

      for (const file of xlsxFiles) {
        const parsed = await parsePassivoXlsx(file);
        if (parsed.posicaoCotas.length > 0) {
          allPosicaoRows.push(...parsed.posicaoCotas);
        } else if (parsed.itau.length > 0) {
          allItauRows.push(...parsed.itau);
        }
      }

      if (allPosicaoRows.length > 0) {
        formData.append("posicao_cotas_json", JSON.stringify(allPosicaoRows));
      }
      if (allItauRows.length > 0) {
        formData.append("itau_passivo_json", JSON.stringify(allItauRows));
      }

      if (
        csvFiles.length === 0 &&
        allPosicaoRows.length === 0 &&
        allItauRows.length === 0
      ) {
        const hints = await Promise.all(xlsxFiles.map((f) => describeXlsxLayout(f)));
        const layoutHint = hints.filter(Boolean).join(" · ");
        throw new Error(
          layoutHint
            ? `Nenhum registro reconhecido. Layout detectado: ${layoutHint}. Confira se há colunas fundo, cotista e valor (ou layout Posição Cotas com "Investidor:").`
            : "Nenhum registro reconhecido nos arquivos. Use CSV (FINVEST/BTG) ou XLSX (Posição Cotas / Cotistas, ou Itaú).",
        );
      }

      if (passivoDataPosicao) formData.append("data_posicao", passivoDataPosicao);
      const { data, error } = await supabase.functions.invoke("import-passivo-fundos", { body: formData });
      if (error) {
        const detail =
          data && typeof data === "object" && "error" in data
            ? String((data as { error?: string }).error)
            : error.message;
        throw new Error(detail || "Falha ao invocar import-passivo-fundos");
      }
      const res = data ?? { success: false, error: "Resposta vazia" };
      setPassivoResult(res);
      if (res.success) {
        toast({ title: "Passivo importado!", description: res.message || `${res.recordsInserted} registros.` });
        setPassivoFiles([]);
        queryClient.invalidateQueries({ queryKey: ["passivo-fundos"] });
        queryClient.invalidateQueries({ queryKey: ["passivo-dates"] });
        queryClient.invalidateQueries({ queryKey: ["passivo-fundos-char"] });
      } else {
        toast({ title: "Erro na importação", description: res.error, variant: "destructive" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro desconhecido";
      setPassivoResult({ success: false, error: msg });
      toast({ title: "Erro na importação", description: msg, variant: "destructive" });
    } finally {
      setIsPassivoUploading(false);
    }
  };

  const handleDeParaUpload = async () => {
    if (!deParaFile) return;
    setIsDeParaUploading(true);
    setDeParaResult(null);
    try {
      const buf = await deParaFile.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const jsonData = XLSX.utils.sheet_to_json(ws);
      const { data, error } = await supabase.functions.invoke("import-passivo-de-para", {
        body: { de_para_json: JSON.stringify(jsonData) },
      });
      if (error) throw new Error(error.message || "Falha ao invocar import-passivo-de-para");
      const res = data ?? { success: false, error: "Resposta vazia" };
      setDeParaResult(res);
      if (res.success) {
        toast({ title: "De-Para importado!", description: res.message || `${res.recordsInserted} registros.` });
        setDeParaFile(null);
        queryClient.invalidateQueries({ queryKey: ["passivo-fundos"] });
      } else {
        toast({ title: "Erro na importação", description: res.error, variant: "destructive" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro desconhecido";
      setDeParaResult({ success: false, error: msg });
      toast({ title: "Erro na importação", description: msg, variant: "destructive" });
    } finally {
      setIsDeParaUploading(false);
    }
  };

  const handleDownloadDeParaTemplate = () => {
    const headers = [["Nº", "Nome Clt.", "CPF_CNPJ", "Conta XP", "Conta BTG", "Status"]];
    const examples = [
      [1, "João da Silva", "123.456.789-00", "497092", "578993", "Ativo"],
      [2, "Maria Souza", "987.654.321-00", "", "1406279", "Ativo"],
    ];
    const ws = XLSX.utils.aoa_to_sheet([...headers, ...examples]);
    ws["!cols"] = [{ wch: 6 }, { wch: 35 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "De-Para");
    XLSX.writeFile(wb, "modelo_de_para_cotistas.xlsx");
  };

  const formatBRL = (v: number) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);

  const normalizeForMatch = (name: string) =>
    (name || "")
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
      .replace(/\s+CP\s*$/i, "")
      .replace(/\s+LP\s*$/i, "")
      .replace(/\s+FIC\s*$/i, "")
      .replace(/\s+FI\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();

  /** Remove acentos para cruzar passivo ↔ nome_comercial (Unicode pode diferir mesmo com texto “igual”) */
  const foldingKey = (name: string) =>
    (name || "")
      .normalize("NFC")
      .replace(/\uFFFD/g, "")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();

  const handleRefresh = async () => {
    try {
      setIsRefreshing(true);
      await queryClient.invalidateQueries({ queryKey: ["passivo-dates"] });
      await refetchDates();
      await queryClient.invalidateQueries({ queryKey: ["passivo-fundos"] });
      await queryClient.invalidateQueries({ queryKey: ["passivo-fundos-char"] });
      await refetchRawData();
      toast({ title: "Dados atualizados" });
    } catch (error) {
      toast({
        title: "Erro ao atualizar",
        description: error instanceof Error ? error.message : "Falha ao recarregar os dados",
        variant: "destructive",
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  const { data: dates = [], isLoading: loadingDates, refetch: refetchDates } = useQuery({
    queryKey: ["passivo-dates"],
    queryFn: async () => {
      const { data } = await supabase
        .from("passivo_fundos")
        .select("data_posicao");
      const unique = [...new Set((data || []).map((d: any) => d.data_posicao))].filter(Boolean) as string[];
      return unique.sort((a, b) => b.localeCompare(a));
    },
  });

  const mostRecentDate = dates[0] || "";
  const isLatestByFundMode = selectedDate === LATEST_BY_FUND;
  const activeDate = isLatestByFundMode ? mostRecentDate : selectedDate;

  useEffect(() => {
    if (dates.length === 0) return;
    if (!isLatestByFundMode && !dates.includes(selectedDate)) {
      setSelectedDate(LATEST_BY_FUND);
    }
  }, [dates, selectedDate, isLatestByFundMode]);

  const { data: rawData = [], isLoading, refetch: refetchRawData } = useQuery({
    queryKey: ["passivo-fundos", selectedDate],
    enabled: isLatestByFundMode || !!activeDate,
    queryFn: async () => {
      const pageSize = 1000;
      const allRows: PassivoFundoRow[] = [];
      let from = 0;

      while (true) {
        let query = supabase
          .from("passivo_fundos")
          .select("*")
          .order("data_posicao", { ascending: false })
          .order("valor", { ascending: false })
          .range(from, from + pageSize - 1);

        if (!isLatestByFundMode) {
          query = query.eq("data_posicao", activeDate);
        }

        const { data, error } = await query;
        if (error) throw error;
        const batch = (data || []) as PassivoFundoRow[];
        allRows.push(...batch);
        if (batch.length < pageSize) break;
        from += pageSize;
      }

      return allRows;
    },
  });

  /** Visualização: identidade por CNPJ+nome (sem administradora), posição mais recente */
  const displayData = useMemo(
    () => dedupePassivoForView(rawData as PassivoFundoRow[]),
    [rawData],
  );

  const viewKeyOf = useMemo(
    () => buildPassivoViewKeyResolver(rawData as PassivoFundoRow[]),
    [rawData],
  );

  const { fundCnpjs, fundNames } = useMemo(() => {
    const cnpjs = [...new Set(
      (displayData as any[])
        .map((r: any) => String(r.fundo_cnpj || "").replace(/\D/g, ""))
        .filter((cnpj: string) => cnpj.length === 14)
    )].sort();
    const names = [...new Set(
      (displayData as any[])
        .map((r: any) => (r.fundo || "").trim())
        .filter(Boolean)
    )].sort();
    return { fundCnpjs: cnpjs, fundNames: names };
  }, [displayData]);

  const isFechadoValue = (val: unknown): boolean => {
    return isFundoFechado(val);
  };

  const { data: universoMonitorado = null } = useQuery({
    queryKey: ["universo-cnpjs-monitorados-passivo"],
    queryFn: fetchUniversoCnpjsMonitorados,
    staleTime: 10 * 60_000,
  });

  const { data: fundCharMap = { byCnpj: new Map<string, boolean>(), byName: new Map<string, boolean>(), cnpjByName: new Map<string, string>() } } = useQuery({
    queryKey: ["passivo-fundos-char", fundCnpjs.join(","), fundNames.join(",")],
    enabled: fundCnpjs.length > 0 || fundNames.length > 0,
    staleTime: 0,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const fmtCnpj = (d: string) =>
        d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d;

      const allCnpjVariants = [...new Set([...fundCnpjs, ...fundCnpjs.map(fmtCnpj)])];

      const sel = "cnpj_classe, cnpj_fundo, nome_comercial, denominacao_social, aberto_estatutariamente";

      /** NFC/NFD/NFKC/NFKD: passivo e cadastro podem divergir em Unicode e o .in() falha em silêncio */
      const expandNameVariants = (names: string[]): string[] => {
        const set = new Set<string>();
        for (const n of names) {
          if (!n) continue;
          set.add(n);
          try {
            set.add(n.normalize("NFC"));
            set.add(n.normalize("NFD"));
            set.add(n.normalize("NFKC"));
            set.add(n.normalize("NFKD"));
          } catch {
            /* ignore */
          }
        }
        return [...set].filter(Boolean);
      };

      const charsByClasse: any[] = [];
      const charsByFundo: any[] = [];
      
      if (allCnpjVariants.length > 0) {
        const chunk = 80;
        for (let i = 0; i < allCnpjVariants.length; i += chunk) {
          const slice = allCnpjVariants.slice(i, i + chunk);
          const [{ data: cClasse }, { data: cFundo }] = await Promise.all([
            supabase.from("fundos_caracteristicas" as any).select(sel).in("cnpj_classe", slice).or("estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo"),
            supabase.from("fundos_caracteristicas" as any).select(sel).in("cnpj_fundo", slice).or("estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo")
          ]);
          charsByClasse.push(...(cClasse || []));
          charsByFundo.push(...(cFundo || []));
        }
      }

      // .in(nome_comercial) em lotes + variantes Unicode (evita cadastro "Fechado" ignorado)
      const nameVariants = expandNameVariants(fundNames);
      const charsByName: any[] = [];
      if (nameVariants.length > 0) {
        const chunk = 80;
        for (let i = 0; i < nameVariants.length; i += chunk) {
          const slice = nameVariants.slice(i, i + chunk);
          const { data } = await supabase
            .from("fundos_caracteristicas" as any)
            .select(sel)
            .in("nome_comercial", slice);
          charsByName.push(...(data || []));
        }
      }

      // Dedup por cnpj_classe (evita linhas repetidas das variantes de nome)
      const seenRow = new Set<string>();
      const dedupeChars = (rows: any[]) =>
        rows.filter((c: any) => {
          const id = `${c.cnpj_classe || ""}|${c.cnpj_fundo || ""}|${c.nome_comercial || ""}`;
          if (seenRow.has(id)) return false;
          seenRow.add(id);
          return true;
        });

      // Mapa por CNPJ (fallback)
      const byCnpj = new Map<string, boolean>();
      const byName = new Map<string, boolean>();
      const cnpjByName = new Map<string, string>();

      const registerNomeFechado = (raw: string | null | undefined, fechado: boolean, cnpj?: string | null) => {
        const nome = String(raw ?? "").trim();
        if (!nome) return;
        byName.set(nome, fechado);
        byName.set(normalizeForMatch(nome), fechado);
        byName.set(foldingKey(nome), fechado);
        const cnpjDigits = cnpj ? String(cnpj).replace(/\D/g, "") : "";
        if (cnpjDigits.length === 14) {
          cnpjByName.set(nome, cnpjDigits);
          cnpjByName.set(normalizeForMatch(nome), cnpjDigits);
          cnpjByName.set(foldingKey(nome), cnpjDigits);
        }
      };

      const registerCharRow = (c: any) => {
        const fechado = isFechadoValue(c.aberto_estatutariamente);
        const kClasse = c.cnpj_classe ? String(c.cnpj_classe).replace(/\D/g, "") : null;
        const kFundo = c.cnpj_fundo ? String(c.cnpj_fundo).replace(/\D/g, "") : null;
        const cnpjCadastro = kClasse || kFundo;
        for (const k of [kClasse, kFundo]) {
          if (k) byCnpj.set(k, fechado);
        }
        registerNomeFechado(c.nome_comercial, fechado, cnpj_classe || c.cnpj_fundo);
        registerNomeFechado(c.denominacao_social, fechado, cnpj_classe || c.cnpj_fundo);
      };

      for (const c of dedupeChars([...(charsByClasse || []), ...(charsByFundo || [])])) {
        registerCharRow(c);
      }

      // Mesma linha do cadastro: também preenche byCnpj (ex.: CNPJ 33913629000181 + nome TAMBAÚ)
      for (const c of dedupeChars(charsByName || [])) {
        registerCharRow(c);
      }

      return { byCnpj, byName, cnpjByName };
    },
  });

  const admins = useMemo(() => {
    const set = new Set(rawData.map((r: any) => r.administradora));
    return [...set].sort();
  }, [rawData]);

  const filtered = useMemo(() => {
    let rows = displayData;
    if (selectedAdmin !== "all") rows = rows.filter((r: any) => r.administradora === selectedAdmin);
    if (busca.trim()) {
      const t = busca.toLowerCase();
      rows = rows.filter(
        (r: any) =>
          (r.fundo || "").toLowerCase().includes(t) ||
          (r.cotista || "").toLowerCase().includes(t) ||
          String(r.codigo_clt ?? "").toLowerCase().includes(t)
      );
    }
    return rows;
  }, [displayData, selectedAdmin, busca]);

  const fundSummary = useMemo(() => {
    const keysPerDisplayName = new Map<string, Set<string>>();
    for (const r of filtered as any[]) {
      const label = foldingKey(String(r.fundo ?? ""));
      if (!label) continue;
      if (!keysPerDisplayName.has(label)) keysPerDisplayName.set(label, new Set());
      keysPerDisplayName.get(label)!.add(viewKeyOf(r));
    }

    const formatCnpjLabel = (cnpj: string) =>
      cnpj.length === 14
        ? cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
        : cnpj;

    const map = new Map<string, {
      viewKey: string;
      fundo: string;
      nome_fundo: string;
      admin: string;
      cnpj: string | null;
      dataPosicao: string;
      pl: number;
      cotistas: number;
      maiorPct: number;
      top5Pct: number;
      isFechado: boolean;
      rows: any[];
    }>();
    for (const r of filtered as any[]) {
      const viewKey = viewKeyOf(r);
      if (!map.has(viewKey)) {
        const baseName = String(r.fundo ?? "").trim();
        const dupName = (keysPerDisplayName.get(foldingKey(baseName))?.size ?? 0) > 1;
        const cnpjDigits = r.fundo_cnpj ? String(r.fundo_cnpj).replace(/\D/g, "") : "";
        const fundoLabel =
          dupName && cnpjDigits.length === 14
            ? `${baseName} (${formatCnpjLabel(cnpjDigits)})`
            : baseName;
        map.set(viewKey, {
          viewKey,
          fundo: fundoLabel,
          nome_fundo: fundoLabel,
          admin: r.administradora,
          cnpj: cnpjDigits || null,
          dataPosicao: String(r.data_posicao ?? ""),
          pl: 0,
          cotistas: 0,
          maiorPct: 0,
          top5Pct: 0,
          isFechado: false,
          rows: [],
        });
      }
      const s = map.get(viewKey)!;
      const valor = Number(r.valor) || 0;
      s.pl += valor;
      s.cotistas += 1;
      s.rows.push({ ...r, valor });
    }
    for (const [, s] of map) {
      s.rows.sort((a: any, b: any) => b.valor - a.valor);
      // CNPJ: qualquer linha do fundo pode ter o vínculo (não só a primeira)
      const anyRowCnpj = s.rows.find((r: any) => r.fundo_cnpj);
      if (anyRowCnpj?.fundo_cnpj) {
        s.cnpj = String(anyRowCnpj.fundo_cnpj).replace(/\D/g, "");
      }
      // CNPJ: cadastro por nome tem prioridade (corrige vínculo errado no passivo importado)
      const nomeBase = String(s.fundo ?? "").replace(/\s*\(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\)\s*$/, "").trim();
      const cnpjCadastro =
        fundCharMap.cnpjByName.get(nomeBase) ??
        fundCharMap.cnpjByName.get(normalizeForMatch(nomeBase)) ??
        fundCharMap.cnpjByName.get(foldingKey(nomeBase));
      if (cnpjCadastro) s.cnpj = cnpjCadastro;

      // Nome: exato + normalizeForMatch (sufixos FIC/FIM) + foldingKey (sem acento)
      const nomeKey = String(s.fundo ?? "").trim();
      const byNameResult =
        fundCharMap.byName.get(nomeKey) ??
        fundCharMap.byName.get(normalizeForMatch(nomeKey)) ??
        fundCharMap.byName.get(foldingKey(nomeKey));
      const byCnpjResult = s.cnpj && s.cnpj.length === 14 ? fundCharMap.byCnpj.get(s.cnpj) : undefined;
      // Cadastro por CNPJ tem prioridade: ao corrigir fundo_cnpj no banco, a concentração acompanha
      s.isFechado = byCnpjResult !== undefined ? byCnpjResult : (byNameResult ?? false);
      if (s.pl > 0) {
        s.maiorPct = (s.rows[0]?.valor || 0) / s.pl;
        s.top5Pct = s.rows.slice(0, 5).reduce((acc: number, r: any) => acc + r.valor, 0) / s.pl;
      }
    }
    return [...map.values()];
  }, [filtered, fundCharMap, viewKeyOf]);

  type FundSummaryRow = {
    viewKey: string;
    fundo: string;
    nome_fundo: string;
    admin: string;
    cnpj: string | null;
    dataPosicao: string;
    pl: number;
    cotistas: number;
    maiorPct: number;
    top5Pct: number;
    isFechado: boolean;
    isInativo: boolean;
    rows: any[];
  };

  const fundSummaryComStatus = useMemo<FundSummaryRow[]>(() => {
    return fundSummary.map((s) => {
      const nomeBase = String(s.nome_fundo ?? s.fundo ?? "")
        .replace(/\s*\(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\)\s*$/, "")
        .trim();
      return {
        ...s,
        isInativo: isFundoPassivoInativo({
          nome: nomeBase,
          cnpj: s.cnpj,
          universoMonitorado,
        }),
      };
    });
  }, [fundSummary, universoMonitorado]);

  const visibleFundSummary = useMemo(() => {
    const buscaAtiva = busca.trim().length > 0;
    return fundSummaryComStatus.filter((s) => {
      if (filtroStatusFundo === "todos") return true;
      if (filtroStatusFundo === "inativos") return s.isInativo;
      if (!s.isInativo) return true;
      return buscaAtiva;
    });
  }, [fundSummaryComStatus, filtroStatusFundo, busca]);

  const qtdInativosOcultos = useMemo(
    () => fundSummaryComStatus.filter((s) => s.isInativo).length,
    [fundSummaryComStatus],
  );

  const sortedFundSummary = useMemo(() => {
    const getValue = (row: FundSummaryRow, key: string) => {
      switch (key as PassivoFundSummarySortKey) {
        case "fundo":
          return row.fundo;
        case "admin":
          return row.admin;
        case "dataPosicao":
          return row.dataPosicao;
        case "pl":
          return row.pl;
        case "cotistas":
          return row.cotistas;
        case "maiorPct":
          return row.maiorPct;
        case "top5Pct":
          return row.top5Pct;
        case "concentracao":
          return passivoFundConcStatus(row.isFechado, row.top5Pct);
        default:
          return null;
      }
    };

    if (sortConfig.direction === "none") {
      return [...visibleFundSummary].sort((a, b) => b.pl - a.pl);
    }

    return sortRelatorioRows(
      visibleFundSummary,
      sortConfig.key,
      sortConfig.direction,
      getValue,
      PASSIVO_CONC_SORT_PRIORITY,
      "concentracao",
    );
  }, [visibleFundSummary, sortConfig]);

  const totalFundos = visibleFundSummary.length;

  const totalCotistas = useMemo(() => {
    const byFund = new Map<string, Set<string>>();
    for (const s of visibleFundSummary) {
      const set = new Set<string>();
      for (const r of s.rows) {
        const cotista = (r.cotista || "").trim();
        if (cotista) set.add(cotista);
      }
      byFund.set(s.viewKey, set);
    }
    return Array.from(byFund.values()).reduce((acc, set) => acc + set.size, 0);
  }, [visibleFundSummary]);

  const totalValor = useMemo(
    () => visibleFundSummary.reduce((acc, s) => acc + s.pl, 0),
    [visibleFundSummary],
  );

  const formatDate = (d: string) =>
    d ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : "-";

  const handleExportExcel = async (fundoViewKey?: string) => {
    const visibleKeys = new Set(visibleFundSummary.map((s) => s.viewKey));
    const rowsToExport = fundoViewKey
      ? filtered.filter((r: any) => viewKeyOf(r) === fundoViewKey)
      : filtered.filter((r: any) => visibleKeys.has(viewKeyOf(r)));

    if (rowsToExport.length === 0) return;

    const [{ data: posicaoData }, { data: charData }] = await Promise.all([
      supabase.from("posicao_carteira").select("nome_fundo, fundo_cnpj, fundo_dtposicao").order("fundo_dtposicao", { ascending: false }),
      supabase.from("fundos_caracteristicas" as any).select("cnpj_fundo, cnpj_classe, nome_comercial"),
    ]);

    const fundMap = new Map<string, { nome: string; cnpj: string }>();
    (posicaoData || []).forEach((r: any) => {
      if (r.nome_fundo && r.fundo_cnpj) {
        const key = normalizeForMatch(r.nome_fundo);
        if (!fundMap.has(key)) fundMap.set(key, { nome: r.nome_fundo.trim(), cnpj: r.fundo_cnpj });
      }
    });
    (charData || []).forEach((r: any) => {
      const nome = r.nome_comercial || "";
      const cnpj = r.cnpj_fundo || r.cnpj_classe || "";
      if (nome && cnpj) {
        const key = normalizeForMatch(nome);
        if (!fundMap.has(key)) fundMap.set(key, { nome: nome.trim(), cnpj });
      }
    });

    const fmtCnpj = (c: string) => {
      const d = (c || "").replace(/\D/g, "");
      if (d.length !== 14) return c || "";
      return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
    };

    // Data mais recente entre as linhas exportadas
    const allDates = [...new Set(
      (rowsToExport as any[]).map((r: any) => r.data_posicao as string).filter(Boolean)
    )].sort((a, b) => b.localeCompare(a));
    const mostRecentDate = allDates[0] ? formatDate(allDates[0]) : "—";

    // Estatísticas do relatório
    const fundosUnicos = new Set((rowsToExport as any[]).map((r: any) => viewKeyOf(r))).size;
    const cotistasUnicos = new Set((rowsToExport as any[]).map((r: any) => r.cotista)).size;
    const valorTotal = (rowsToExport as any[]).reduce((s: number, r: any) => s + (Number(r.valor) || 0), 0);

    // ── Paleta do sistema ────────────────────────────────────────────
    const EX_C = {
      GREEN_DARK: "FF00734A",
      GRAY_HEAD:  "FF5B6066",
      GRAY_SUB:   "FFF2F4F6",
      GRAY_ALT:   "FFF9FAFB",
      WHITE:      "FFFFFFFF",
      INK:        "FF1A1A2E",
      INK_LIGHT:  "FF5B6066",
      BORDER:     "FFD1D5DB",
    };
    const thin: ExcelJS.Border = { style: "thin", color: { argb: EX_C.BORDER } };
    const brd = { top: thin, left: thin, bottom: thin, right: thin };
    const applyFill = (cell: ExcelJS.Cell, argb: string) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = "CVPAR Quadrante";
    wb.created = new Date();

    // ── Aba 1: Resumo ──────────────────────────────────────────────
    const wsR = wb.addWorksheet("Resumo", { properties: { tabColor: { argb: "0000734A" } } });
    wsR.columns = [{ width: 34 }, { width: 26 }];

    const addTitle = (ws: ExcelJS.Worksheet, t: string) => {
      const r = ws.addRow([t]);
      ws.mergeCells(r.number, 1, r.number, 2);
      applyFill(r.getCell(1), EX_C.GREEN_DARK);
      r.getCell(1).font = { bold: true, color: { argb: EX_C.WHITE }, size: 11, name: "Calibri" };
      r.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
      r.height = 24;
    };
    const addSection = (ws: ExcelJS.Worksheet, t: string) => {
      const r = ws.addRow([t]);
      ws.mergeCells(r.number, 1, r.number, 2);
      applyFill(r.getCell(1), EX_C.GRAY_HEAD);
      r.getCell(1).font = { bold: true, color: { argb: EX_C.WHITE }, size: 9, name: "Calibri" };
      r.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
      r.height = 20;
    };
    const addKV = (ws: ExcelJS.Worksheet, key: string, value: string | number) => {
      const r = ws.addRow([key, value]);
      applyFill(r.getCell(1), EX_C.GRAY_SUB);
      r.getCell(1).font = { bold: true, size: 9, name: "Calibri", color: { argb: EX_C.INK_LIGHT } };
      r.getCell(2).font = { size: 9, name: "Calibri", color: { argb: EX_C.INK } };
      r.getCell(1).border = brd;
      r.getCell(2).border = brd;
      r.height = 16;
    };

    addTitle(wsR, "RELATÓRIO DE PASSIVO DE FUNDOS — CVPAR QUADRANTE");
    wsR.addRow([]);
    addSection(wsR, "INFORMAÇÕES GERAIS");
    addKV(wsR, "Data de Referência", mostRecentDate);
    addKV(wsR, "Modo", isLatestByFundMode ? "Última posição por fundo" : `Data selecionada: ${formatDate(activeDate)}`);
    wsR.addRow([]);
    addSection(wsR, "RESUMO");
    addKV(wsR, "Total de Fundos", fundosUnicos);
    addKV(wsR, "Total de Cotistas", cotistasUnicos);
    addKV(wsR, "Valor Total (R$)",
      new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(valorTotal)
    );
    wsR.addRow([]);
    addKV(wsR, "Gerado em", new Date().toLocaleString("pt-BR"));

    // ── Aba 2: Passivo ─────────────────────────────────────────────
    const wsP = wb.addWorksheet("Passivo", { properties: { tabColor: { argb: "005B6066" } } });
    wsP.columns = [
      { width: 14 },  // Data Posição
      { width: 22 },  // Administradora
      { width: 50 },  // Fundo
      { width: 22 },  // CNPJ Fundo
      { width: 12 },  // Cód. Clt.
      { width: 38 },  // Cotista
      { width: 20 },  // Valor
    ];

    const hdrs = ["Data Posição", "Administradora", "Fundo", "CNPJ Fundo", "Cód. Clt.", "Cotista", "Valor (R$)"];
    const hRow = wsP.addRow(hdrs);
    for (let c = 1; c <= hdrs.length; c++) {
      const cell = hRow.getCell(c);
      applyFill(cell, EX_C.GRAY_HEAD);
      cell.font = { bold: true, color: { argb: EX_C.WHITE }, size: 9, name: "Calibri" };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = brd;
    }
    hRow.height = 28;

    (rowsToExport as any[]).forEach((row: any, idx: number) => {
      const isAlt = idx % 2 !== 0;
      const key = normalizeForMatch(row.fundo);
      const match = fundMap.get(key);
      const valor = Number(row.valor) || 0;
      const cnpj = match?.cnpj || row.fundo_cnpj || "";

      const codClt = row.codigo_clt != null && row.codigo_clt !== "" ? Number(row.codigo_clt) : null;
      const dRow = wsP.addRow([
        formatDate(row.data_posicao),
        row.administradora || "—",
        match?.nome || row.fundo || "—",
        fmtCnpj(cnpj),
        codClt != null && !Number.isNaN(codClt) ? codClt : "—",
        textoCotistaLgpd(row.cotista),
        valor,
      ]);

      for (let c = 1; c <= hdrs.length; c++) {
        const cell = dRow.getCell(c);
        applyFill(cell, isAlt ? EX_C.GRAY_ALT : EX_C.WHITE);
        cell.font = { size: 9, name: "Calibri", color: { argb: EX_C.INK } };
        cell.border = brd;
      }
      dRow.getCell(1).alignment = { horizontal: "center" };
      dRow.getCell(4).alignment = { horizontal: "center" };
      dRow.getCell(5).alignment = { horizontal: "center" };
      dRow.getCell(7).numFmt = '"R$" #,##0.00';
      dRow.getCell(7).alignment = { horizontal: "right" };
      dRow.height = 16;
    });

    wsP.views = [{ state: "frozen", ySplit: 1 }];

    // ── Download ───────────────────────────────────────────────────
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const exportRef = allDates[0] || (isLatestByFundMode ? "ultimas" : activeDate);
    const fundoSuffix = fundoViewKey
      ? `_${String((rowsToExport as any[])[0]?.fundo ?? fundoViewKey).replace(/[^a-zA-Z0-9\u00C0-\u024F\s-]/g, "_").slice(0, 40).trim()}`
      : "";
    a.download = `Passivo_Fundos_${exportRef}${fundoSuffix}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight flex items-center gap-2 uppercase">
              <Users className="w-5 h-5" />
              Passivo Fundos
            </h1>
            <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
              Concentração de cotistas por fundo •{" "}
              {isLatestByFundMode ? "Última posição por fundo" : `Data exibida: ${formatDate(activeDate)}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1"
              onClick={handleRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
              {isRefreshing ? "Atualizando..." : "Atualizar"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs gap-1"
                  disabled={filtered.length === 0}
                >
                  <Download className="w-3.5 h-3.5" />
                  Excel
                  <ChevronDown className="w-3.5 h-3.5 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[220px]">
                <DropdownMenuItem onClick={() => handleExportExcel()}>
                  Exportar consolidado (todos os fundos)
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Exportar fundo específico</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-[300px] overflow-y-auto">
                    {sortedFundSummary.map((s) => {
                      const key = s.viewKey;
                      return (
                        <DropdownMenuItem
                          key={key}
                          onClick={() => handleExportExcel(key)}
                          className="max-w-[280px]"
                        >
                          <span className="truncate" title={s.fundo}>
                            {s.fundo}
                          </span>
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs gap-1 border-violet-300 text-violet-800 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950"
                  onClick={() => setShowSinqiaPassivoConfirm(true)}
                  disabled={isSinqiaPassivoImporting}
                >
                  {isSinqiaPassivoImporting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  {isSinqiaPassivoImporting ? "Buscando..." : "Atualizar Finvest"}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs text-xs">
                Busca posição de cotistas na API Finvest/Sinqia e importa automaticamente (18 fundos).
              </TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 text-xs gap-1">
                  <FileUp className="w-3.5 h-3.5" />
                  Importar
                  <ChevronDown className="w-3 h-3 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[210px]">
                <DropdownMenuItem onClick={() => { setPassivoResult(null); setShowPassivoDialog(true); }}>
                  <Upload className="w-4 h-4 mr-2 text-blue-500" />
                  Importar Passivo Fundos
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => { setDeParaResult(null); setShowDeParaDialog(true); }}>
                  <ArrowLeftRight className="w-4 h-4 mr-2 text-emerald-500" />
                  Importar De-Para Cotistas
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {loadingDates || isLoading ? (
          <div className="flex flex-col items-center justify-center py-32 space-y-3">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground font-medium uppercase tracking-widest">Carregando...</p>
          </div>
        ) : dates.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center space-y-4">
              <Users className="h-12 w-12 text-muted-foreground/40" />
              <div className="space-y-1">
                <p className="text-base font-semibold">Nenhum dado de passivo importado</p>
                <p className="text-sm text-muted-foreground max-w-md">
                  Importe planilhas de passivo (FINVEST, BTG, Posição Cotas) na aba Importações.
                </p>
              </div>
              <Button onClick={() => navigate("/enquadramento/importar")} className="mt-2">
                <FileUp className="w-4 h-4 mr-2" />
                Ir para Importações
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Card>
                <CardContent className="pt-4 flex items-center gap-3">
                  <div className="p-2 bg-blue-500/10 rounded-lg">
                    <Building2 className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{totalFundos}</p>
                    <p className="text-[10px] text-muted-foreground font-bold uppercase">Fundos</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 flex items-center gap-3">
                  <div className="p-2 bg-emerald-500/10 rounded-lg">
                    <Users className="w-5 h-5 text-emerald-600" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{totalCotistas}</p>
                    <p className="text-[10px] text-muted-foreground font-bold uppercase">Cotistas</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 flex items-center gap-3">
                  <div className="p-2 bg-amber-500/10 rounded-lg">
                    <TrendingUp className="w-5 h-5 text-amber-600" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{formatBRL(totalValor)}</p>
                    <p className="text-[10px] text-muted-foreground font-bold uppercase">Valor Total</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Buscar por fundo, cotista ou Cód. Clt..."
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  className="pl-9 h-8 text-xs"
                />
              </div>
              <Select value={selectedDate} onValueChange={setSelectedDate}>
                <SelectTrigger className="w-[150px] h-8 text-xs">
                  <SelectValue placeholder="Data" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={LATEST_BY_FUND}>Mais recente por fundo</SelectItem>
                  {dates.map((d) => (
                    <SelectItem key={d} value={d}>
                      {formatDate(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={selectedAdmin} onValueChange={setSelectedAdmin}>
                <SelectTrigger className="w-[180px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas administradoras</SelectItem>
                  {admins.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filtroStatusFundo} onValueChange={(v) => setFiltroStatusFundo(v as "ativos" | "inativos" | "todos")}>
                <SelectTrigger className="w-[170px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ativos">Só fundos ativos</SelectItem>
                  <SelectItem value="inativos">Só inativos</SelectItem>
                  <SelectItem value="todos">Todos os fundos</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Resumo por Fundo</CardTitle>
                <CardDescription className="text-xs">
                  {sortedFundSummary.length} fundos •{" "}
                  {isLatestByFundMode ? "Mostrando a última posição de cada fundo" : `Data selecionada: ${formatDate(activeDate)}`}
                  {filtroStatusFundo === "ativos" && qtdInativosOcultos > 0 && (
                    <> • {qtdInativosOcultos} inativo{qtdInativosOcultos === 1 ? "" : "s"} oculto{qtdInativosOcultos === 1 ? "" : "s"} (sem gestão atual)</>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[575px] w-full rounded-md border">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-muted/95">
                      <TableRow>
                        <TableHead className="w-[40px]"></TableHead>
                        <RelatorioSortableHead
                          label="Fundo"
                          sortKey="fundo"
                          direction={getDirection("fundo")}
                          onSort={(k) => toggleSort(k as PassivoFundSummarySortKey)}
                        />
                        <RelatorioSortableHead
                          label="Admin"
                          sortKey="admin"
                          direction={getDirection("admin")}
                          onSort={(k) => toggleSort(k as PassivoFundSummarySortKey)}
                        />
                        <RelatorioSortableHead
                          label="Data Posição"
                          sortKey="dataPosicao"
                          direction={getDirection("dataPosicao")}
                          onSort={(k) => toggleSort(k as PassivoFundSummarySortKey)}
                          className="whitespace-nowrap"
                        />
                        <RelatorioSortableHead
                          label="PL Cotistas"
                          sortKey="pl"
                          direction={getDirection("pl")}
                          onSort={(k) => toggleSort(k as PassivoFundSummarySortKey)}
                          align="right"
                        />
                        <RelatorioSortableHead
                          label="Qtd Cotistas"
                          sortKey="cotistas"
                          direction={getDirection("cotistas")}
                          onSort={(k) => toggleSort(k as PassivoFundSummarySortKey)}
                          align="right"
                        />
                        <RelatorioSortableHead
                          label="Maior Cotista %"
                          sortKey="maiorPct"
                          direction={getDirection("maiorPct")}
                          onSort={(k) => toggleSort(k as PassivoFundSummarySortKey)}
                          align="right"
                        />
                        <RelatorioSortableHead
                          label="Top 5 %"
                          sortKey="top5Pct"
                          direction={getDirection("top5Pct")}
                          onSort={(k) => toggleSort(k as PassivoFundSummarySortKey)}
                          align="right"
                        />
                        <RelatorioSortableHead
                          label="Concentração"
                          sortKey="concentracao"
                          direction={getDirection("concentracao")}
                          onSort={(k) => toggleSort(k as PassivoFundSummarySortKey)}
                        />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedFundSummary.map((s) => {
                        const fundKey = s.viewKey;
                        const concStatus = s.isFechado
                          ? "fechado"
                          : s.top5Pct >= 0.8
                            ? "alta"
                            : s.top5Pct >= 0.5
                              ? "media"
                              : "baixa";
                        const isExpanded = expandedFund === fundKey;

                        return (
                          <Fragment key={fundKey}>
                            <TableRow
                              className={`h-10 cursor-pointer hover:bg-muted/50 ${s.isInativo ? "opacity-60" : ""}`}
                              onClick={() => setExpandedFund(isExpanded ? null : fundKey)}
                            >
                              <TableCell className="p-2 text-center">
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                )}
                              </TableCell>
                              <TableCell className="text-xs font-medium max-w-[280px]" title={s.fundo}>
                                <span className="inline-flex items-center gap-1.5 min-w-0">
                                  <span className="truncate">{s.fundo}</span>
                                  {s.isInativo && (
                                    <Badge variant="secondary" className="text-[9px] h-5 shrink-0">Inativo</Badge>
                                  )}
                                </span>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">{s.admin}</TableCell>
                              <TableCell className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                                {s.dataPosicao ? formatDate(s.dataPosicao) : "—"}
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs">{formatBRL(s.pl)}</TableCell>
                              <TableCell className="text-right font-mono text-xs">{s.cotistas}</TableCell>
                              <TableCell className="text-right font-mono text-xs font-bold">
                                {(s.maiorPct * 100).toFixed(1)}%
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs font-bold">
                                {(s.top5Pct * 100).toFixed(1)}%
                              </TableCell>
                              <TableCell>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="inline-block">
                                      {concStatus === "fechado" ? (
                                        <Badge className="bg-slate-500/10 text-slate-700 border-slate-200 text-[9px] h-5 cursor-help">Fechado</Badge>
                                      ) : concStatus === "alta" ? (
                                        <Badge className="bg-red-500/10 text-red-700 border-red-200 text-[9px] h-5 cursor-help">Alta</Badge>
                                      ) : concStatus === "media" ? (
                                        <Badge className="bg-amber-500/10 text-amber-700 border-amber-200 text-[9px] h-5 cursor-help">Média</Badge>
                                      ) : (
                                        <Badge className="bg-emerald-500/10 text-emerald-700 border-emerald-200 text-[9px] h-5 cursor-help">Baixa</Badge>
                                      )}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-[240px] text-xs">
                                    {concStatus === "fechado" && (
                                      <p>Fundo fechado: a regra de concentração de cotistas não se aplica.</p>
                                    )}
                                    {concStatus === "alta" && (
                                      <p>Top 5 cotistas representam ≥ 80% do PL — concentração elevada.</p>
                                    )}
                                    {concStatus === "media" && (
                                      <p>Top 5 cotistas representam entre 50% e 80% do PL — concentração moderada.</p>
                                    )}
                                    {concStatus === "baixa" && (
                                      <p>Top 5 cotistas representam &lt; 50% do PL — concentração baixa.</p>
                                    )}
                                  </TooltipContent>
                                </Tooltip>
                              </TableCell>
                            </TableRow>
                            {isExpanded && (
                              <TableRow className="bg-muted/10 hover:bg-muted/10">
                                <TableCell colSpan={9} className="p-0">
                                  <div className="p-4 border-b">
                                    <h4 className="text-xs font-bold uppercase text-muted-foreground mb-3 px-1">Detalhamento de Cotistas</h4>
                                    <div className="rounded-md border bg-background">
                                      <ScrollArea className="h-[350px]">
                                        <Table>
                                          <TableHeader className="bg-muted/30 sticky top-0">
                                            <TableRow className="h-8">
                                              <TableHead className="text-[10px] h-8">Cód. Clt.</TableHead>
                                              <TableHead className="text-[10px] h-8">Cotista</TableHead>
                                              <TableHead className="text-right text-[10px] h-8">Valor</TableHead>
                                              <TableHead className="text-right text-[10px] h-8">% PL</TableHead>
                                            </TableRow>
                                          </TableHeader>
                                          <TableBody>
                                            {s.rows.map((row: any, idx: number) => (
                                              <TableRow key={idx} className="h-8 hover:bg-muted/30">
                                                <TableCell className="text-[11px] py-1 font-mono font-medium">{row.codigo_clt ?? "—"}</TableCell>
                                                <TableCell className="text-[11px] py-1">
                                                  <CotistaNomeLgpd valor={row.cotista} />
                                                </TableCell>
                                                <TableCell className="text-[11px] py-1 text-right font-mono">{formatBRL(row.valor)}</TableCell>
                                                <TableCell className="text-[11px] py-1 text-right font-mono">
                                                  {s.pl > 0 ? ((row.valor / s.pl) * 100).toFixed(2) : "0.00"}%
                                                </TableCell>
                                              </TableRow>
                                            ))}
                                          </TableBody>
                                        </Table>
                                      </ScrollArea>
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* ── Dialog: Confirmar atualização Finvest API ───────────────────── */}
      <Dialog open={showSinqiaPassivoConfirm} onOpenChange={setShowSinqiaPassivoConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <RefreshCw className="w-4 h-4 text-violet-500" />
              Atualizar passivo Finvest (API)
            </DialogTitle>
            <DialogDescription className="text-xs space-y-2">
              <span className="block">
                Busca cotistas dos 18 fundos Finvest na API Sinqia para a data{" "}
                <strong>{formatDate(resolvePassivoApiDate())}</strong>.
              </span>
              <span className="block text-muted-foreground">
                Não altera fundos BTG, Itaú ou Posição Cotas. Só atualiza a fonte Finvest (API).
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setShowSinqiaPassivoConfirm(false)}>
              Cancelar
            </Button>
            <Button
              size="sm"
              className="bg-violet-600 hover:bg-violet-700"
              disabled={isSinqiaPassivoImporting}
              onClick={async () => {
                setShowSinqiaPassivoConfirm(false);
                await handleSinqiaPassivoImport();
              }}
            >
              {isSinqiaPassivoImporting ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Buscando...</>
              ) : (
                "Confirmar atualização"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Dialog: Importar Passivo Fundos ─────────────────────────────── */}
      <Dialog open={showPassivoDialog} onOpenChange={setShowPassivoDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Upload className="w-4 h-4 text-blue-500" />
              Importar Passivo Fundos
            </DialogTitle>
            <DialogDescription className="text-xs">
              Formatos suportados: FINVEST WM/Growth (CSV), BTG (CSV), Posição Cotas (XLSX
              posicao_cotas_fundo_*.xlsx), Itaú/Intrag (XLSX com colunas cliente · CPF · conta · fundo · CNPJ Fundo · saldo_liquido).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-1">
            <div className="space-y-1">
              <label className="text-xs font-medium flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5" />
                Data da posição
              </label>
              <input
                type="date"
                value={
                  passivoDataPosicao
                    ? `${passivoDataPosicao.slice(0, 4)}-${passivoDataPosicao.slice(4, 6)}-${passivoDataPosicao.slice(6, 8)}`
                    : ""
                }
                onChange={(e) => setPassivoDataPosicao(e.target.value.replace(/-/g, ""))}
                className="flex h-8 w-[160px] rounded-md border border-input bg-transparent px-3 py-1 text-xs shadow-sm"
              />
            </div>

            <div
              className="relative border-2 border-dashed rounded-lg p-6 flex flex-col items-center gap-3 text-center hover:border-primary/50 hover:bg-accent/30 transition-colors"
              onDrop={(e) => {
                e.preventDefault();
                const dropped = Array.from(e.dataTransfer.files).filter(
                  (f) =>
                    f.name.toLowerCase().endsWith(".csv") ||
                    f.name.toLowerCase().endsWith(".xlsx")
                );
                if (dropped.length > 0) setPassivoFiles((prev) => [...prev, ...dropped]);
              }}
              onDragOver={(e) => e.preventDefault()}
            >
              <Upload className="w-7 h-7 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Arraste ou clique para selecionar</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Passivo_Finvest*.csv · Passivos_BTG.csv · posicao_cotas_fundo_*.xlsx · Posição de Cotistas.xlsx · posicoes_clientes_fundos.xlsx (Itaú)
                </p>
              </div>
              <input
                type="file"
                accept=".csv,.xlsx"
                multiple
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={isPassivoUploading}
                onChange={(e) => {
                  if (e.target.files) setPassivoFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
                }}
              />
            </div>

            {passivoFiles.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium">{passivoFiles.length} arquivo(s)</p>
                <div className="rounded-md border divide-y max-h-[120px] overflow-y-auto">
                  {passivoFiles.map((f, i) => (
                    <div key={`${f.name}-${i}`} className="flex items-center justify-between px-2 py-1">
                      <span className="text-xs truncate flex-1">{f.name}</span>
                      <button
                        onClick={() => setPassivoFiles((prev) => prev.filter((_, idx) => idx !== i))}
                        disabled={isPassivoUploading}
                        className="ml-2 text-muted-foreground hover:text-destructive"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {passivoResult && (
              <div className={`flex items-start gap-2 p-3 rounded-md border text-xs ${passivoResult.success ? "border-green-500/40 bg-green-500/5" : "border-red-500/40 bg-red-500/5"}`}>
                {passivoResult.success
                  ? <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
                  : <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />}
                <p>{passivoResult.success ? passivoResult.message : passivoResult.error}</p>
              </div>
            )}

            <Button
              className="w-full"
              onClick={handlePassivoUpload}
              disabled={passivoFiles.length === 0 || isPassivoUploading}
            >
              {isPassivoUploading ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Importando...</>
              ) : (
                <><FileUp className="w-4 h-4 mr-2" />Importar Passivo Fundos</>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Dialog: Importar De-Para Cotistas ───────────────────────────── */}
      <Dialog open={showDeParaDialog} onOpenChange={setShowDeParaDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <ArrowLeftRight className="w-4 h-4 text-emerald-500" />
              Importar De-Para Cotistas
            </DialogTitle>
            <DialogDescription className="text-xs">
              Planilha com mapeamento de cotistas → código de cliente. Colunas: <strong>Nº · Nome Clt. · CPF_CNPJ · Conta XP · Conta BTG · Status</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5 w-full border-dashed"
              onClick={handleDownloadDeParaTemplate}
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
              Baixar planilha modelo (.xlsx)
            </Button>

            <div
              className="relative border-2 border-dashed rounded-lg p-6 flex flex-col items-center gap-3 text-center hover:border-primary/50 hover:bg-accent/30 transition-colors"
              onDrop={(e) => {
                e.preventDefault();
                const f = Array.from(e.dataTransfer.files).find((f) => f.name.toLowerCase().endsWith(".xlsx"));
                if (f) setDeParaFile(f);
              }}
              onDragOver={(e) => e.preventDefault()}
            >
              <ArrowLeftRight className="w-7 h-7 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Arraste ou clique para selecionar</p>
                <p className="text-xs text-muted-foreground mt-0.5">Arquivo XLSX do De-Para</p>
              </div>
              {deParaFile && (
                <div className="flex items-center gap-2 text-xs bg-accent px-3 py-1.5 rounded-md">
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  <span className="truncate max-w-[200px]">{deParaFile.name}</span>
                  <button onClick={() => setDeParaFile(null)} className="text-muted-foreground hover:text-destructive">
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              <input
                type="file"
                accept=".xlsx"
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={isDeParaUploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setDeParaFile(f);
                }}
              />
            </div>

            {deParaResult && (
              <div className={`flex items-start gap-2 p-3 rounded-md border text-xs ${deParaResult.success ? "border-green-500/40 bg-green-500/5" : "border-red-500/40 bg-red-500/5"}`}>
                {deParaResult.success
                  ? <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
                  : <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />}
                <p>{deParaResult.success ? deParaResult.message : deParaResult.error}</p>
              </div>
            )}

            <Button
              className="w-full"
              onClick={handleDeParaUpload}
              disabled={!deParaFile || isDeParaUploading}
            >
              {isDeParaUploading ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Importando...</>
              ) : (
                <><ArrowLeftRight className="w-4 h-4 mr-2" />Importar De-Para</>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
