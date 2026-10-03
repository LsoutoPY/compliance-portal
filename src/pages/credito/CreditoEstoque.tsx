import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Loader2, RefreshCw, Search, Database, Upload,
  ChevronLeft, ChevronRight, CheckCircle2, XCircle,
  Clock, AlertTriangle, Columns, ChevronUp, ChevronDown,
  ChevronsUpDown, Filter, X,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── helpers ───────────────────────────────────────────────────────────────────
const db = supabase as unknown as { from: (t: string) => any };

const fmt = {
  brl: (v: number | null | undefined) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 }).format(v ?? 0),
  num: (v: number | null | undefined) =>
    v == null ? "–" : v.toLocaleString("pt-BR"),
  pct: (v: number | null | undefined) =>
    v == null ? "–" : `${(Number(v) * 100).toFixed(4)}%`,
  date: (d: string | null | undefined) => {
    if (!d) return "–";
    const s = String(d).slice(0, 10);
    if (s.length < 10) return d;
    const [y, m, day] = s.split("-");
    return `${day}/${m}/${y}`;
  },
  datetime: (d: string | null | undefined) => {
    if (!d) return "–";
    try {
      return new Intl.DateTimeFormat("pt-BR", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      }).format(new Date(d));
    } catch { return d; }
  },
};

const PAGE_SIZE = 200;

// ── column definitions ────────────────────────────────────────────────────────
type ColType = "text" | "currency" | "number" | "date" | "rate" | "id";

interface ColDef {
  key: string;
  label: string;
  type: ColType;
  defaultVisible: boolean;
  group: string;
  minWidth?: string;
}

const COLUMNS: ColDef[] = [
  // Fundo
  { key: "nome_fundo",              label: "Fundo",                  type: "text",     defaultVisible: true,  group: "Fundo",         minWidth: "200px" },
  { key: "doc_fundo",               label: "CNPJ Fundo",             type: "text",     defaultVisible: true,  group: "Fundo",         minWidth: "150px" },
  { key: "nome_originador",         label: "Originador",             type: "text",     defaultVisible: false, group: "Fundo",         minWidth: "180px" },
  { key: "doc_originador",          label: "CNPJ Originador",        type: "text",     defaultVisible: false, group: "Fundo",         minWidth: "150px" },
  { key: "nome_cedente",            label: "Cedente",                type: "text",     defaultVisible: false, group: "Fundo",         minWidth: "180px" },
  { key: "doc_cedente",             label: "CNPJ Cedente",           type: "text",     defaultVisible: false, group: "Fundo",         minWidth: "150px" },
  // Sacado
  { key: "nome_sacado",             label: "Sacado",                 type: "text",     defaultVisible: true,  group: "Sacado",        minWidth: "180px" },
  { key: "doc_sacado",              label: "CNPJ Sacado",            type: "text",     defaultVisible: true,  group: "Sacado",        minWidth: "150px" },
  // Recebível
  { key: "tipo_recebivel",          label: "Tipo",                   type: "text",     defaultVisible: true,  group: "Recebível",     minWidth: "120px" },
  { key: "situacao_recebivel",      label: "Situação",               type: "text",     defaultVisible: true,  group: "Recebível",     minWidth: "140px" },
  { key: "faixa_pdd",               label: "Faixa PDD",              type: "text",     defaultVisible: false, group: "Recebível",     minWidth: "110px" },
  { key: "faixa_pdd_geral",         label: "Faixa PDD Geral",        type: "text",     defaultVisible: false, group: "Recebível",     minWidth: "130px" },
  { key: "tipo_pdd_geral",          label: "Tipo PDD Geral",         type: "text",     defaultVisible: false, group: "Recebível",     minWidth: "130px" },
  { key: "coobrigacao",             label: "Coobrigação",            type: "text",     defaultVisible: false, group: "Recebível",     minWidth: "110px" },
  { key: "nome",                    label: "Nome Recebível",         type: "text",     defaultVisible: false, group: "Recebível",     minWidth: "160px" },
  // Valores
  { key: "valor_presente",          label: "Valor Presente",         type: "currency", defaultVisible: true,  group: "Valores",       minWidth: "140px" },
  { key: "valor_nominal",           label: "Valor Nominal",          type: "currency", defaultVisible: true,  group: "Valores",       minWidth: "140px" },
  { key: "valor_aquisicao",         label: "Valor Aquisição",        type: "currency", defaultVisible: false, group: "Valores",       minWidth: "140px" },
  { key: "valor_pdd",               label: "PDD",                    type: "currency", defaultVisible: true,  group: "Valores",       minWidth: "120px" },
  { key: "valor_pdd_geral",         label: "PDD Geral",              type: "currency", defaultVisible: false, group: "Valores",       minWidth: "120px" },
  { key: "mora",                    label: "Mora",                   type: "currency", defaultVisible: false, group: "Valores",       minWidth: "110px" },
  { key: "multa",                   label: "Multa",                  type: "currency", defaultVisible: false, group: "Valores",       minWidth: "110px" },
  { key: "valor_nominal_iof",       label: "Nominal IOF",            type: "currency", defaultVisible: false, group: "Valores",       minWidth: "120px" },
  // Prazos
  { key: "prazo",                   label: "Prazo",                  type: "number",   defaultVisible: false, group: "Prazos/Taxas",  minWidth: "80px" },
  { key: "prazo_atual",             label: "Prazo Atual",            type: "number",   defaultVisible: true,  group: "Prazos/Taxas",  minWidth: "100px" },
  { key: "tx_recebivel",            label: "Taxa Recebível",         type: "rate",     defaultVisible: false, group: "Prazos/Taxas",  minWidth: "130px" },
  { key: "taxa_cessao",             label: "Taxa Cessão",            type: "rate",     defaultVisible: false, group: "Prazos/Taxas",  minWidth: "120px" },
  { key: "taxa_juros_vencidos",     label: "Juros Vencidos",         type: "rate",     defaultVisible: false, group: "Prazos/Taxas",  minWidth: "130px" },
  { key: "taxa_juros_indexador",    label: "Taxa Indexador",         type: "rate",     defaultVisible: false, group: "Prazos/Taxas",  minWidth: "130px" },
  { key: "tp_juros",                label: "Tipo Juros",             type: "text",     defaultVisible: false, group: "Prazos/Taxas",  minWidth: "110px" },
  { key: "defasagem",               label: "Defasagem",              type: "text",     defaultVisible: false, group: "Prazos/Taxas",  minWidth: "110px" },
  // Datas
  { key: "data_referencia",         label: "Data Ref.",              type: "date",     defaultVisible: true,  group: "Datas",         minWidth: "110px" },
  { key: "data_vencimento_ajustada",label: "Venc. Ajustado",         type: "date",     defaultVisible: true,  group: "Datas",         minWidth: "120px" },
  { key: "data_vencimento_original",label: "Venc. Original",         type: "date",     defaultVisible: false, group: "Datas",         minWidth: "120px" },
  { key: "data_emissao",            label: "Emissão",                type: "date",     defaultVisible: false, group: "Datas",         minWidth: "110px" },
  { key: "data_aquisicao",          label: "Aquisição",              type: "date",     defaultVisible: false, group: "Datas",         minWidth: "110px" },
  { key: "data_fundo",              label: "Data Fundo",             type: "date",     defaultVisible: false, group: "Datas",         minWidth: "110px" },
  { key: "data_carencia",           label: "Carência",               type: "date",     defaultVisible: false, group: "Datas",         minWidth: "110px" },
  // Identificadores
  { key: "seu_numero",              label: "Seu Número",             type: "id",       defaultVisible: true,  group: "Identificadores", minWidth: "140px" },
  { key: "nu_documento",            label: "Nº Documento",           type: "id",       defaultVisible: false, group: "Identificadores", minWidth: "140px" },
  { key: "codigo_origem",           label: "Cód. Origem",            type: "id",       defaultVisible: false, group: "Identificadores", minWidth: "120px" },
  { key: "codigo_finalidade",       label: "Cód. Finalidade",        type: "id",       defaultVisible: false, group: "Identificadores", minWidth: "130px" },
  { key: "id_registro",             label: "ID Registro",            type: "id",       defaultVisible: false, group: "Identificadores", minWidth: "130px" },
  { key: "chave_nfe",               label: "Chave NF-e",             type: "id",       defaultVisible: false, group: "Identificadores", minWidth: "180px" },
  // Cheque
  { key: "nu_banco_cheque",         label: "Banco Cheque",           type: "text",     defaultVisible: false, group: "Cheque",         minWidth: "110px" },
  { key: "nu_agencia_cheque",       label: "Agência Cheque",         type: "text",     defaultVisible: false, group: "Cheque",         minWidth: "120px" },
  { key: "nu_conta_cheque",         label: "Conta Cheque",           type: "text",     defaultVisible: false, group: "Cheque",         minWidth: "120px" },
  { key: "cmc7_cheque",             label: "CMC7",                   type: "text",     defaultVisible: false, group: "Cheque",         minWidth: "160px" },
];

const GROUPS = [...new Set(COLUMNS.map((c) => c.group))];

const BAD_SITUATIONS = [
  "inadimplente", "cobranca", "litigios", "judicial",
  "protestado", "recupera", "perda", "baixado",
];

function normStr(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function getSituacaoStyle(s: string | null | undefined) {
  if (!s) return "bg-muted/30 text-muted-foreground";
  const n = normStr(s);
  if (BAD_SITUATIONS.some((b) => n.includes(b))) return "bg-red-100 text-red-700";
  if (n.includes("vencid"))                       return "bg-orange-100 text-orange-700";
  if (n.includes("adimplente") || n.includes("a vencer") || n.includes("liquidado"))
                                                  return "bg-emerald-100 text-emerald-700";
  return "bg-sky-100 text-sky-700";
}

function isBadSituation(s: string | null | undefined) {
  if (!s) return false;
  return BAD_SITUATIONS.some((b) => normStr(s).includes(b));
}

function renderCell(col: ColDef, value: unknown): React.ReactNode {
  if (value == null || value === "") return <span className="text-muted-foreground/50">–</span>;
  const v = value as any;

  if (col.key === "situacao_recebivel") {
    return (
      <span className={cn("text-xs font-medium px-1.5 py-0.5 rounded whitespace-nowrap", getSituacaoStyle(String(v)))}>
        {String(v)}
      </span>
    );
  }
  if (col.type === "currency") return <span className="whitespace-nowrap">{fmt.brl(Number(v))}</span>;
  if (col.type === "date") return <span className="whitespace-nowrap">{fmt.date(String(v))}</span>;
  if (col.type === "number") return <span>{fmt.num(Number(v))}</span>;
  if (col.type === "rate") return <span className="whitespace-nowrap">{fmt.pct(Number(v))}</span>;
  return <span className="whitespace-nowrap">{String(v)}</span>;
}

// Rótulo de exibição para um valor bruto de uma coluna no filtro
function getColValueLabel(col: ColDef, raw: string): string {
  if (raw === "__EMPTY__") return "(Vazio)";
  if (col.type === "date") return fmt.date(raw);
  return raw;
}

// ── status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <Badge variant="outline">–</Badge>;
  const s = status.toLowerCase();
  if (s === "success")
    return <Badge className="bg-emerald-100 text-emerald-700 border border-emerald-200 gap-1 text-xs"><CheckCircle2 className="h-3 w-3" />Sucesso</Badge>;
  if (s === "partial_success")
    return <Badge className="bg-amber-100 text-amber-700 border border-amber-200 gap-1 text-xs"><AlertTriangle className="h-3 w-3" />Parcial</Badge>;
  if (s === "processing")
    return <Badge className="bg-blue-100 text-blue-700 border border-blue-200 gap-1 text-xs"><Clock className="h-3 w-3" />Processando</Badge>;
  return <Badge className="bg-red-100 text-red-700 border border-red-200 gap-1 text-xs"><XCircle className="h-3 w-3" />Erro</Badge>;
}

// ── types ─────────────────────────────────────────────────────────────────────
interface Importacao {
  id: string;
  created_at: string | null;
  file_name: string | null;
  fund_name: string | null;
  fund_document: string | null;
  reference_date: string | null;
  status: string | null;
  total_rows: number | null;
  imported_rows: number | null;
  rejected_rows: number | null;
  error_message: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
export default function CreditoEstoque() {
  const [fundoSelecionado, setFundoSelecionado] = useState<string>("all");
  const [dataSelecionada, setDataSelecionada]   = useState<string>("all");
  const [buscaSituacao, setBuscaSituacao]       = useState("");
  const [pagina, setPagina]                     = useState(0);

  // ── Sort / Filter por coluna ──
  const [sortCol, setSortCol]           = useState<string | null>(null);
  const [sortDir, setSortDir]           = useState<"asc" | "desc">("asc");
  // colFilters: { [colKey]: string[] } — array de valores SELECIONADOS; undefined = sem filtro
  const [colFilters, setColFilters]     = useState<Record<string, string[]>>({});
  const [filterOpen, setFilterOpen]     = useState<string | null>(null);
  const [filterSearch, setFilterSearch] = useState<string>("");

  const toggleSort = (key: string) => {
    if (sortCol === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(key); setSortDir("asc"); }
  };

  const clearFilter = (key: string) => {
    setColFilters((prev) => { const n = { ...prev }; delete n[key]; return n; });
    setFilterOpen(null);
  };

  const openFilterFor = (key: string) => {
    setFilterSearch("");
    setFilterOpen((prev) => (prev === key ? null : key));
  };

  // Visibilidade de colunas
  const defaultVisibility = useMemo(() =>
    Object.fromEntries(COLUMNS.map((c) => [c.key, c.defaultVisible])), []);
  const [colVisibility, setColVisibility] = useState<Record<string, boolean>>(defaultVisibility);
  const visibleCols = COLUMNS.filter((c) => colVisibility[c.key]);

  const toggleCol = (key: string) =>
    setColVisibility((prev) => ({ ...prev, [key]: !prev[key] }));

  const resetCols = () => setColVisibility(defaultVisibility);
  const showAllCols = () =>
    setColVisibility(Object.fromEntries(COLUMNS.map((c) => [c.key, true])));

  // ── importações ──
  const { data: importacoes = [], isLoading: loadingImports, refetch: refetchImports } = useQuery({
    queryKey: ["estoque-fidc-importacoes"],
    queryFn: async (): Promise<Importacao[]> => {
      const { data, error } = await db
        .from("importacoes_estoque_fidc")
        .select("id, created_at, file_name, fund_name, fund_document, reference_date, status, total_rows, imported_rows, rejected_rows, error_message")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 2 * 60 * 1000,
  });

  // Opções dos selects — usando fund_document original para match exato com doc_fundo
  const fundosDisponiveis = useMemo(() => {
    const seen = new Map<string, string>();
    for (const imp of importacoes) {
      const doc = imp.fund_document ?? "";
      if (doc && !seen.has(doc)) seen.set(doc, imp.fund_name ?? doc);
    }
    return Array.from(seen.entries()).map(([doc, name]) => ({ doc, name }));
  }, [importacoes]);

  const datasDisponiveis = useMemo(() => {
    const set = new Set<string>();
    for (const imp of importacoes) {
      if (imp.reference_date && (imp.status === "success" || imp.status === "partial_success"))
        set.add(String(imp.reference_date).slice(0, 10));
    }
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [importacoes]);

  // ── Verificar duplicidade: múltiplas importações para mesma data+fundo ──
  const duplicidadeInfo = useMemo(() => {
    if (fundoSelecionado === "all" || dataSelecionada === "all") return null;
    
    const importsParaFundoData = importacoes.filter(
      (imp) =>
        imp.fund_document === fundoSelecionado &&
        String(imp.reference_date).slice(0, 10) === dataSelecionada &&
        (imp.status === "success" || imp.status === "partial_success")
    );

    if (importsParaFundoData.length > 1) {
      return {
        qtd: importsParaFundoData.length,
        imports: importsParaFundoData.sort((a, b) => 
          (b.created_at ?? "").localeCompare(a.created_at ?? "")
        ),
      };
    }
    return null;
  }, [importacoes, fundoSelecionado, dataSelecionada]);

  // ── estoque (paginado) ──
  const filterActive = fundoSelecionado !== "all" || dataSelecionada !== "all";

  const selectAllCols = COLUMNS.map((c) => c.key).join(", ");

  const { data: estoqueData, isLoading: loadingEstoque, refetch: refetchEstoque } = useQuery({
    queryKey: ["estoque-fidc-rows", fundoSelecionado, dataSelecionada, pagina, buscaSituacao],
    enabled: filterActive,
    queryFn: async (): Promise<{ rows: Record<string, unknown>[]; count: number }> => {
      let q = db.from("estoque_fidc").select(selectAllCols, { count: "exact" });
      if (fundoSelecionado !== "all") q = q.eq("doc_fundo", fundoSelecionado);
      if (dataSelecionada   !== "all") q = q.eq("data_referencia", dataSelecionada);
      if (buscaSituacao.trim())        q = q.ilike("situacao_recebivel", `%${buscaSituacao.trim()}%`);
      q = q.order("data_referencia", { ascending: false }).range(pagina * PAGE_SIZE, (pagina + 1) * PAGE_SIZE - 1);
      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: (data as Record<string, unknown>[]) ?? [], count: count ?? 0 };
    },
    staleTime: 2 * 60 * 1000,
  });

  const rows      = estoqueData?.rows ?? [];
  const totalRows = estoqueData?.count ?? 0;
  const totalPages = Math.ceil(totalRows / PAGE_SIZE);

  // ── resumo cards ──
  const { data: resumo } = useQuery({
    queryKey: ["estoque-fidc-resumo", fundoSelecionado, dataSelecionada],
    enabled: filterActive,
    queryFn: async () => {
      let q = db.from("estoque_fidc").select("situacao_recebivel, valor_presente, valor_nominal, valor_pdd");
      if (fundoSelecionado !== "all") q = q.eq("doc_fundo", fundoSelecionado);
      if (dataSelecionada   !== "all") q = q.eq("data_referencia", dataSelecionada);
      const { data, error } = await q;
      if (error) return null;
      const all = (data ?? []) as { situacao_recebivel: string | null; valor_presente: number | null; valor_nominal: number | null; valor_pdd: number | null }[];
      const totalVP  = all.reduce((s, r) => s + (r.valor_presente ?? 0), 0);
      const totalVN  = all.reduce((s, r) => s + (r.valor_nominal ?? 0), 0);
      const totalPDD = all.reduce((s, r) => s + (r.valor_pdd ?? 0), 0);
      const inadimplente = all.filter((r) => isBadSituation(r.situacao_recebivel)).reduce((s, r) => s + (r.valor_presente ?? 0), 0);
      return { count: all.length, totalVP, totalVN, totalPDD, inadimplente };
    },
    staleTime: 2 * 60 * 1000,
  });

  // Valores únicos por coluna (para o filtro estilo Excel)
  const colUniqueValues = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const col of COLUMNS) {
      const seen = new Set<string>();
      for (const row of rows) {
        const val = row[col.key];
        seen.add(val == null || val === "" ? "__EMPTY__" : String(val));
      }
      result[col.key] = [...seen].sort((a, b) => {
        if (a === "__EMPTY__") return 1;
        if (b === "__EMPTY__") return -1;
        if (col.type === "currency" || col.type === "number" || col.type === "rate") {
          const na = Number(a), nb = Number(b);
          if (!isNaN(na) && !isNaN(nb)) return na - nb;
        }
        return a.localeCompare(b, "pt-BR");
      });
    }
    return result;
  }, [rows]);

  // Aplica sort + filter client-side na página atual
  const filteredSortedRows = useMemo(() => {
    let result = [...rows];
    // Filtros por coluna (multi-select estilo Excel)
    for (const [key, vals] of Object.entries(colFilters)) {
      if (vals.length === 0) {
        result = [];
        break;
      }
      const valSet = new Set(vals);
      result = result.filter((row) => {
        const cell = row[key];
        const cellStr = cell == null || cell === "" ? "__EMPTY__" : String(cell);
        return valSet.has(cellStr);
      });
    }
    // Ordenação
    if (sortCol) {
      const colDef = COLUMNS.find((c) => c.key === sortCol);
      result = [...result].sort((a, b) => {
        const va = a[sortCol] as unknown;
        const vb = b[sortCol] as unknown;
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (colDef?.type === "currency" || colDef?.type === "number" || colDef?.type === "rate") {
          const na = Number(va), nb = Number(vb);
          return sortDir === "asc" ? na - nb : nb - na;
        }
        const sa = String(va), sb = String(vb);
        return sortDir === "asc" ? sa.localeCompare(sb, "pt-BR") : sb.localeCompare(sa, "pt-BR");
      });
    }
    return result;
  }, [rows, colFilters, sortCol, sortDir]);

  const activeFilterCount = Object.keys(colFilters).length;

  const handleFiltroChange = () => setPagina(0);

  return (
    <Layout noScroll>
      {/* h-full funciona porque Layout noScroll propaga h-screen pela cadeia */}
      <div className="flex flex-col h-full overflow-hidden gap-3">
        {/* Header — altura fixa */}
        <div className="flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Estoque FIDC</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Tabela <code className="bg-muted px-1 rounded text-xs">estoque_fidc</code> — {COLUMNS.length} colunas disponíveis
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => { refetchImports(); refetchEstoque(); }}>
            <RefreshCw className="h-4 w-4 mr-2" /> Atualizar
          </Button>
        </div>

        {/* Tabs ocupa todo o espaço restante */}
        <Tabs defaultValue="estoque" className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <TabsList className="shrink-0">
            <TabsTrigger value="estoque" className="gap-2"><Database className="h-4 w-4" />Estoque</TabsTrigger>
            <TabsTrigger value="importacoes" className="gap-2"><Upload className="h-4 w-4" />Importações</TabsTrigger>
          </TabsList>

          {/* ──────────────── ABA ESTOQUE ──────────────── */}
          <TabsContent value="estoque" className="flex-1 min-h-0 flex flex-col overflow-hidden gap-3 mt-3 data-[state=inactive]:hidden">

            {/* Filtros — altura fixa */}
            <Card className="shrink-0">
              <CardContent className="p-4">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1 flex-1 min-w-[220px]">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Fundo</label>
                    <Select value={fundoSelecionado} onValueChange={(v) => { setFundoSelecionado(v); handleFiltroChange(); }}>
                      <SelectTrigger><SelectValue placeholder="Selecionar fundo..." /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todos os fundos</SelectItem>
                        {fundosDisponiveis.map(({ doc, name }) => (
                          <SelectItem key={doc} value={doc}>{name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1 flex-1 min-w-[160px]">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Data de Referência</label>
                    <Select value={dataSelecionada} onValueChange={(v) => { setDataSelecionada(v); handleFiltroChange(); }}>
                      <SelectTrigger><SelectValue placeholder="Selecionar data..." /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todas as datas</SelectItem>
                        {datasDisponiveis.map((d) => (
                          <SelectItem key={d} value={d}>{fmt.date(d)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1 flex-1 min-w-[160px]">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Situação</label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input className="pl-9" placeholder="Filtrar..." value={buscaSituacao}
                        onChange={(e) => { setBuscaSituacao(e.target.value); handleFiltroChange(); }} />
                    </div>
                  </div>

                  {/* Menu de colunas */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Colunas</label>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" className="gap-2">
                          <Columns className="h-4 w-4" />
                          <span className="hidden sm:inline">Colunas</span>
                          <Badge variant="secondary" className="ml-1 text-[10px] h-5 px-1.5">
                            {visibleCols.length}/{COLUMNS.length}
                          </Badge>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-64 max-h-[480px] overflow-y-auto">
                        <div className="flex items-center justify-between px-2 py-1.5 border-b">
                          <span className="text-xs font-semibold text-muted-foreground">Visibilidade das Colunas</span>
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={(e) => { e.preventDefault(); resetCols(); }}
                              className="text-[10px] text-blue-600 hover:underline"
                            >
                              Padrão
                            </button>
                            <span className="text-muted-foreground/50 text-[10px]">·</span>
                            <button
                              type="button"
                              onClick={(e) => { e.preventDefault(); showAllCols(); }}
                              className="text-[10px] text-blue-600 hover:underline"
                            >
                              Todas
                            </button>
                          </div>
                        </div>
                        {GROUPS.map((group) => (
                          <div key={group}>
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground py-1.5 px-2">
                              {group}
                            </DropdownMenuLabel>
                            {COLUMNS.filter((c) => c.group === group).map((col) => (
                              <DropdownMenuCheckboxItem
                                key={col.key}
                                checked={colVisibility[col.key]}
                                onCheckedChange={() => toggleCol(col.key)}
                                onSelect={(e) => e.preventDefault()}
                                className="text-xs"
                              >
                                {col.label}
                              </DropdownMenuCheckboxItem>
                            ))}
                            <DropdownMenuSeparator />
                          </div>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Aviso sem filtro — altura fixa */}
            {!filterActive && (
              <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 shrink-0">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                Selecione um fundo ou uma data para visualizar os dados.
              </div>
            )}

            {/* Alerta de duplicidade — múltiplas importações para mesma data */}
            {duplicidadeInfo && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 shrink-0">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 shrink-0 text-red-600 mt-0.5" />
                  <div className="flex-1 space-y-2">
                    <div className="text-sm font-semibold text-red-800">
                      ⚠️ Possível Duplicidade Detectada
                    </div>
                    <p className="text-sm text-red-700">
                      Existem <strong>{duplicidadeInfo.qtd} importações</strong> para o mesmo fundo e data de referência.
                      Isso pode indicar importação acidental do mesmo arquivo.
                    </p>
                    <div className="mt-3 space-y-1.5">
                      <p className="text-xs font-semibold text-red-800 uppercase tracking-wide">Importações encontradas:</p>
                      {duplicidadeInfo.imports.map((imp, idx) => (
                        <div key={imp.id} className="flex items-center gap-3 text-xs bg-white/50 rounded px-3 py-2 border border-red-100">
                          <Badge variant="outline" className={cn(
                            "shrink-0",
                            idx === 0 ? "bg-green-100 text-green-700 border-green-200" : "bg-gray-100 text-gray-600"
                          )}>
                            {idx === 0 ? "Mais recente" : `#${idx + 1}`}
                          </Badge>
                          <div className="flex-1 space-y-0.5">
                            <div className="font-mono text-[10px] text-muted-foreground">{imp.id}</div>
                            <div className="font-medium">{imp.file_name}</div>
                            <div className="text-muted-foreground">
                              {fmt.datetime(imp.created_at)} · {imp.imported_rows?.toLocaleString("pt-BR")} registros
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 p-3 bg-white/50 rounded border border-red-100">
                      <p className="text-xs text-red-800 font-medium mb-2">🔍 Como verificar:</p>
                      <ol className="text-xs text-red-700 space-y-1 list-decimal list-inside">
                        <li>Verifique se os arquivos têm conteúdos idênticos</li>
                        <li>Se for duplicata, delete a importação mais antiga ou desnecessária</li>
                        <li>Execute a query de análise no SQL Editor (arquivo <code className="bg-red-100 px-1 rounded">debug-duplicidade-estoque.sql</code>)</li>
                      </ol>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Cards resumo — altura fixa */}
            {resumo && (
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 shrink-0">
                {[
                  { label: "Registros",        value: resumo.count.toLocaleString("pt-BR"),   color: "text-foreground" },
                  { label: "Valor Presente",   value: fmt.brl(resumo.totalVP),                color: "text-emerald-700" },
                  { label: "Valor Nominal",    value: fmt.brl(resumo.totalVN),                color: "text-blue-700" },
                  { label: "PDD Total",        value: fmt.brl(resumo.totalPDD),               color: "text-amber-700" },
                  { label: "Inadimpl./Risco",  value: fmt.brl(resumo.inadimplente),           color: "text-red-600",
                    sub: resumo.totalVP > 0 ? `${((resumo.inadimplente / resumo.totalVP) * 100).toFixed(1)}% VP` : undefined },
                ].map(({ label, value, color, sub }) => (
                  <Card key={label}>
                    <CardContent className="p-4">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</p>
                      <p className={cn("text-lg font-extrabold mt-1 leading-tight", color)}>{value}</p>
                      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* Tabela — flex-1 para ocupar todo o espaço restante */}
            {loadingEstoque ? (
              <div className="flex items-center justify-center flex-1">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : rows.length > 0 ? (
              <Card className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {/* Barra de paginação topo — altura fixa */}
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50 bg-muted/20 shrink-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground">
                      {totalRows.toLocaleString("pt-BR")} registros
                      {totalPages > 1 && ` · pág ${pagina + 1}/${totalPages}`}
                      {" · "}{visibleCols.length} colunas
                    </span>
                    {filteredSortedRows.length !== rows.length && (
                      <span className="text-xs text-primary font-medium">
                        {filteredSortedRows.length} após filtro
                      </span>
                    )}
                    {activeFilterCount > 0 && (
                      <button
                        type="button"
                        onClick={() => { setColFilters({}); setFilterOpen(null); }}
                        className="flex items-center gap-1 text-[10px] text-destructive hover:underline"
                      >
                        <X className="w-3 h-3" /> Limpar {activeFilterCount} filtro{activeFilterCount > 1 ? "s" : ""}
                      </button>
                    )}
                    {sortCol && (
                      <button
                        type="button"
                        onClick={() => setSortCol(null)}
                        className="flex items-center gap-1 text-[10px] text-primary hover:underline"
                      >
                        <X className="w-3 h-3" /> Remover ordenação
                      </button>
                    )}
                  </div>
                  {totalPages > 1 && (
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <span className="text-xs text-muted-foreground px-1">{pagina + 1} / {totalPages}</span>
                      <Button variant="ghost" size="icon" className="h-7 w-7" disabled={pagina >= totalPages - 1} onClick={() => setPagina((p) => p + 1)}>
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>

                {/* Scroll ocupa exatamente o espaço restante do Card */}
                <div
                  className="flex-1 min-h-0 overflow-auto [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-muted/30 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/50"
                  style={{ overscrollBehavior: "contain" }}
                >
                  <table className="w-max min-w-full text-xs border-collapse">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-muted/80 backdrop-blur-sm border-b border-border/50">
                        {/* Coluna # fixa */}
                        <th className="sticky left-0 z-20 bg-muted/90 text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-3 py-2 border-r border-border/50 whitespace-nowrap">
                          #
                        </th>
                        {visibleCols.map((col) => {
                          const isSorted = sortCol === col.key;
                          const hasFilter = col.key in colFilters;
                          const activeVals = colFilters[col.key];
                          const isFilterOpen = filterOpen === col.key;
                          const isNum = col.type === "currency" || col.type === "number" || col.type === "rate";
                          const uniqueVals = colUniqueValues[col.key] ?? [];
                          const searchLower = filterSearch.toLowerCase();
                          const filteredUniqueVals = filterSearch.trim()
                            ? uniqueVals.filter((v) =>
                                getColValueLabel(col, v).toLowerCase().includes(searchLower) ||
                                v.toLowerCase().includes(searchLower)
                              )
                            : uniqueVals;

                          const isValueChecked = (val: string) =>
                            !hasFilter || (activeVals ?? []).includes(val);

                          const handleToggleValue = (val: string) => {
                            if (!hasFilter) {
                              // Sem filtro = todos selecionados → desmarcar um cria filtro explícito
                              setColFilters((p) => ({
                                ...p,
                                [col.key]: uniqueVals.filter((v) => v !== val),
                              }));
                              return;
                            }
                            const current = activeVals ?? [];
                            if (current.includes(val)) {
                              setColFilters((p) => ({
                                ...p,
                                [col.key]: current.filter((v) => v !== val),
                              }));
                            } else {
                              const newVals = [...current, val];
                              if (newVals.length >= uniqueVals.length) clearFilter(col.key);
                              else setColFilters((p) => ({ ...p, [col.key]: newVals }));
                            }
                          };

                          return (
                            <th
                              key={col.key}
                              className={cn("text-muted-foreground px-2 py-0 border-border/30 whitespace-nowrap align-top", isNum ? "text-right" : "text-left")}
                              style={{ minWidth: col.minWidth }}
                            >
                              <div className={cn("flex items-center gap-1 py-2", isNum ? "flex-row-reverse" : "flex-row")}>
                                {/* Sort */}
                                <button
                                  type="button"
                                  onClick={() => toggleSort(col.key)}
                                  className="flex items-center gap-0.5 hover:text-foreground transition-colors group"
                                >
                                  <span className="text-[10px] font-bold uppercase tracking-wider">{col.label}</span>
                                  {isSorted
                                    ? sortDir === "asc"
                                      ? <ChevronUp className="w-3 h-3 text-primary shrink-0" />
                                      : <ChevronDown className="w-3 h-3 text-primary shrink-0" />
                                    : <ChevronsUpDown className="w-3 h-3 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
                                  }
                                </button>
                                {/* Filter — dropdown estilo Excel */}
                                <DropdownMenu
                                  open={isFilterOpen}
                                  onOpenChange={(open) => {
                                    if (open) { setFilterSearch(""); setFilterOpen(col.key); }
                                    else setFilterOpen(null);
                                  }}
                                >
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      type="button"
                                      title={hasFilter ? `${(activeVals ?? []).length} de ${uniqueVals.length} selecionados` : "Filtrar"}
                                      className={cn(
                                        "p-0.5 rounded hover:bg-muted transition-colors shrink-0",
                                        hasFilter ? "text-primary bg-primary/10" : "text-muted-foreground/40 hover:text-foreground"
                                      )}
                                    >
                                      <Filter className="w-3 h-3" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent
                                    align="start"
                                    className="w-56 p-0 flex flex-col"
                                    style={{ maxHeight: "min(320px, 60vh)" }}
                                    onCloseAutoFocus={(e) => e.preventDefault()}
                                  >
                                    {/* Busca */}
                                    <div className="p-2 border-b shrink-0">
                                      <div className="relative">
                                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                                        <input
                                          autoFocus
                                          placeholder="Buscar..."
                                          value={filterSearch}
                                          onChange={(e) => setFilterSearch(e.target.value)}
                                          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setFilterOpen(null); }}
                                          onClick={(e) => e.stopPropagation()}
                                          className="w-full text-xs pl-6 pr-2 py-1 border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                                        />
                                      </div>
                                    </div>
                                    {/* Ações rápidas */}
                                    <div className="flex items-center gap-3 px-3 py-1.5 border-b shrink-0 bg-muted/30">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          clearFilter(col.key);
                                          setFilterSearch("");
                                        }}
                                        className="text-[10px] text-blue-600 hover:underline"
                                      >
                                        Selecionar todos
                                      </button>
                                      <span className="text-muted-foreground/40 text-[10px]">·</span>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setColFilters((p) => ({ ...p, [col.key]: [] }));
                                        }}
                                        className="text-[10px] text-blue-600 hover:underline"
                                      >
                                        Limpar
                                      </button>
                                    </div>
                                    {/* Lista de valores */}
                                    <div className="overflow-y-auto flex-1">
                                      {filteredUniqueVals.length === 0 ? (
                                        <p className="text-[10px] text-muted-foreground text-center py-3">Sem resultados</p>
                                      ) : (
                                        filteredUniqueVals.map((val) => (
                                          <DropdownMenuCheckboxItem
                                            key={val}
                                            checked={isValueChecked(val)}
                                            onCheckedChange={() => handleToggleValue(val)}
                                            onSelect={(e) => e.preventDefault()}
                                            className="text-xs py-1"
                                          >
                                            {val === "__EMPTY__"
                                              ? <span className="italic text-muted-foreground">(Vazio)</span>
                                              : <span className="truncate max-w-[180px] block">{getColValueLabel(col, val)}</span>
                                            }
                                          </DropdownMenuCheckboxItem>
                                        ))
                                      )}
                                    </div>
                                    {hasFilter && (
                                      <div className="px-3 py-1.5 border-t bg-muted/20 shrink-0">
                                        <span className="text-[10px] text-muted-foreground">
                                          {(activeVals ?? []).length} de {uniqueVals.length} selecionado{(activeVals ?? []).length !== 1 ? "s" : ""}
                                        </span>
                                      </div>
                                    )}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSortedRows.map((row, i) => (
                        <tr key={String(row.id ?? i)} className="hover:bg-muted/30 transition-colors border-b border-border/20">
                          <td className="sticky left-0 z-10 bg-background border-r border-border/30 px-3 py-2 text-muted-foreground/60 font-mono text-[10px]">
                            {pagina * PAGE_SIZE + i + 1}
                          </td>
                          {visibleCols.map((col) => (
                            <td
                              key={col.key}
                              className={cn(
                                "px-3 py-2",
                                col.type === "currency" || col.type === "number" || col.type === "rate"
                                  ? "text-right tabular-nums"
                                  : "text-left",
                                col.type === "id" ? "font-mono text-[10px] text-muted-foreground" : ""
                              )}
                            >
                              {renderCell(col, row[col.key])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Barra paginação rodapé — altura fixa */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/50 bg-muted/10 shrink-0">
                    <span className="text-xs text-muted-foreground">
                      Página {pagina + 1} de {totalPages} · {PAGE_SIZE} por página
                    </span>
                    <div className="flex items-center gap-1">
                      <Button variant="outline" size="sm" disabled={pagina === 0} onClick={() => setPagina(0)}>Primeira</Button>
                      <Button variant="outline" size="sm" disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button variant="outline" size="sm" disabled={pagina >= totalPages - 1} onClick={() => setPagina((p) => p + 1)}>
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                      <Button variant="outline" size="sm" disabled={pagina >= totalPages - 1} onClick={() => setPagina(totalPages - 1)}>Última</Button>
                    </div>
                  </div>
                )}
              </Card>
            ) : filterActive ? (
              <div className="text-center py-12 text-muted-foreground text-sm">
                Nenhum registro encontrado para os filtros selecionados.
              </div>
            ) : null}
          </TabsContent>

          {/* ──────────────── ABA IMPORTAÇÕES ──────────────── */}
          <TabsContent value="importacoes" className="flex-1 min-h-0 flex flex-col overflow-hidden gap-3 mt-3 data-[state=inactive]:hidden">
            {loadingImports ? (
              <div className="flex items-center justify-center flex-1"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : (
              <Card className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <CardHeader className="pb-3 shrink-0">
                  <CardTitle className="text-base">
                    Histórico de Importações
                    <span className="ml-2 text-sm font-normal text-muted-foreground">({importacoes.length})</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0 flex-1 min-h-0 flex flex-col overflow-hidden">
                  <div className="flex-1 min-h-0 overflow-auto">
                    <table className="w-max min-w-full text-xs border-collapse">
                      <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
                        <tr>
                          {["Data", "Fundo", "CNPJ", "Referência", "Arquivo", "Status", "Total", "Importados", "Rejeitados"].map((h) => (
                            <th key={h} className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-3 py-2.5 border-b border-border/50 text-left whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {importacoes.length === 0 ? (
                          <tr><td colSpan={9} className="text-center text-muted-foreground py-8">Nenhuma importação encontrada.</td></tr>
                        ) : importacoes.map((imp) => (
                          <tr key={imp.id} className="hover:bg-muted/20 border-b border-border/20 transition-colors">
                            <td className="px-3 py-2 whitespace-nowrap">{fmt.datetime(imp.created_at)}</td>
                            <td className="px-3 py-2 font-medium max-w-[200px] truncate" title={imp.fund_name ?? ""}>{imp.fund_name ?? "–"}</td>
                            <td className="px-3 py-2 font-mono">{imp.fund_document ?? "–"}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{fmt.date(imp.reference_date)}</td>
                            <td className="px-3 py-2 text-muted-foreground max-w-[160px] truncate" title={imp.file_name ?? ""}>{imp.file_name ?? "–"}</td>
                            <td className="px-3 py-2"><StatusBadge status={imp.status} /></td>
                            <td className="px-3 py-2 text-right tabular-nums">{imp.total_rows?.toLocaleString("pt-BR") ?? "–"}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-emerald-700 font-medium">{imp.imported_rows?.toLocaleString("pt-BR") ?? "–"}</td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {(imp.rejected_rows ?? 0) > 0
                                ? <span className="text-red-600 font-medium">{imp.rejected_rows?.toLocaleString("pt-BR")}</span>
                                : <span className="text-muted-foreground">0</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}

            {importacoes.filter((i) => i.error_message).length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-red-600 flex items-center gap-2">
                    <XCircle className="h-4 w-4" />Erros de Importação
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {importacoes.filter((i) => i.error_message).map((i) => (
                    <div key={i.id} className="rounded border border-red-200 bg-red-50 p-3 text-xs">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-semibold text-red-700">{i.fund_name ?? i.fund_document ?? i.id}</span>
                        <span className="text-red-500">{fmt.datetime(i.created_at)}</span>
                      </div>
                      <p className="text-red-700 font-mono break-all">{i.error_message}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
}

