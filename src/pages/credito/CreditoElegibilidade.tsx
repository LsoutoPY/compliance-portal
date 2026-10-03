import { useState, useRef, useCallback, Fragment } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2, CheckCircle2, XCircle, ShieldCheck, FileUp,
  ChevronDown, ChevronRight, AlertTriangle, History, FileDown, FileText, Sheet,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  exportHistoricoPDF,
  exportHistoricoExcel,
  exportAnalisePDF,
  exportAnaliseExcel,
  exportHistoricoItemPDF,
  exportHistoricoItemExcel,
  type HistoricoItem,
} from "@/utils/elegibilidade-export";

// ── CSV mini-parser: extract unique cedentes ────────────────────────────────
interface CedenteCoobrigacao {
  doc: string;
  nome: string;
  coobrigacao: boolean; // true = COM coobrigação
}

function parseCedentesCsv(text: string): CedenteCoobrigacao[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const norm = (h: string) =>
    h.toUpperCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  const headers = lines[0].split(";").map(h => norm(h.trim()));
  const cedenteIdx = headers.indexOf("NM_CEDENTE");
  const docIdx = headers.indexOf("CPF_CNPJ_CEDENTE");
  if (cedenteIdx === -1 || docIdx === -1) return [];
  const seen = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(";");
    const doc = (cols[docIdx] ?? "").trim().replace(/\D/g, "");
    const nome = (cols[cedenteIdx] ?? "").trim();
    if (doc && nome && !seen.has(doc)) seen.set(doc, nome);
  }
  return Array.from(seen.entries()).map(([doc, nome]) => ({ doc, nome, coobrigacao: true }));
}

// ── Auth-aware function invoker (solves 401 with FormData) ──────────────────
async function invokeFunction(
  name: string,
  body: FormData,
): Promise<{ data: any; error: Error | null }> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

  const sessionRes = await supabase.auth.getSession();
  const token = sessionRes.data.session?.access_token ?? anonKey;

  const resp = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
    },
    body,
  });

  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      msg = j?.error ?? j?.message ?? msg;
    } catch {
      msg = (await resp.text().catch(() => msg)) || msg;
    }
    return { data: null, error: new Error(msg) };
  }

  const data = await resp.json().catch(() => ({}));
  return { data, error: null };
}

// ── Dropzone Component ──────────────────────────────────────────────────────

interface DropzoneProps {
  accept: string;
  label: string;
  sublabel: string;
  icon: React.ReactNode;
  loading: boolean;
  loadingText: string;
  onFile: (file: File) => void;
  disabled?: boolean;
}

function Dropzone({ accept, label, sublabel, icon, loading, loadingText, onFile, disabled }: DropzoneProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!loading && !disabled) setDragging(true);
  }, [loading, disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    if (loading || disabled) return;
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  }, [loading, disabled, onFile]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
    if (inputRef.current) inputRef.current.value = "";
  }, [onFile]);

  return (
    <div
      className={`
        relative border-2 border-dashed rounded-lg p-8 text-center cursor-pointer
        transition-colors duration-150
        ${dragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/30"}
        ${loading ? "opacity-60 pointer-events-none" : ""}
        ${disabled ? "opacity-40 pointer-events-none" : ""}
      `}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => !loading && !disabled && inputRef.current?.click()}
    >
      <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={handleChange} />
      <div className="flex flex-col items-center gap-2">
        {loading ? (
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
        ) : (
          icon
        )}
        <div>
          <p className="text-sm font-medium">{loading ? loadingText : label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{sublabel}</p>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatBRL(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function formatPct(v: number): string {
  return `${v.toFixed(2)}%`;
}
function formatDias(v: number): string {
  return `${Math.round(v)} dias`;
}

/** fundo_dtposicao em YYYYMMDD (ou similar); retorna pt-BR ou — */
function formatDataPosicaoPl(raw: string | null | undefined): string {
  if (raw == null || String(raw).trim() === "") return "—";
  const s = String(raw).replace(/\D/g, "");
  if (s.length === 8) {
    const y = s.slice(0, 4);
    const m = s.slice(4, 6);
    const d = s.slice(6, 8);
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    if (!Number.isNaN(dt.getTime())) return dt.toLocaleDateString("pt-BR");
  }
  return String(raw);
}
function formatDataEstoque(raw: string | null | undefined): string {
  if (raw == null || String(raw).trim() === "") return "—";
  // Suporta YYYY-MM-DD (ISO) e YYYYMMDD
  const s = String(raw).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const dt = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (!Number.isNaN(dt.getTime())) return dt.toLocaleDateString("pt-BR");
  }
  const compact = s.replace(/\D/g, "");
  if (compact.length === 8) {
    const dt = new Date(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)) - 1, Number(compact.slice(6, 8)));
    if (!Number.isNaN(dt.getTime())) return dt.toLocaleDateString("pt-BR");
  }
  return s;
}
function fmtCnpj(d: string): string {
  const c = d.replace(/\D/g, "");
  if (c.length === 14) return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  return d;
}

// ── Types ───────────────────────────────────────────────────────────────────

interface ValidacaoResult {
  success: boolean;
  import_id?: string;
  fundo_cnpj?: string;
  fundo_nome?: string;
  fundo_isin_resolvido?: string | null;
  regras_aplicadas?: number;
  carteira_atual?: {
    qtd_recebiveis: number;
    vp_total: number;
    pdd_total: number;
    prazo_medio_pond: number;
    perc_pl_alocado: number;
    pl: number;
    pl_header_raw?: number;
    pl_origem?: "xml" | "fidc_header";
    /** Data da posição em posicao_carteira (fundo_dtposicao), ex. YYYYMMDD */
    pl_data_posicao?: string | null;
    /** Data de referência do estoque utilizado (reference_date de importacoes_estoque_fidc) */
    estoque_data_referencia?: string | null;
  };
  cessao_proposta?: {
    total_dcs: number;
    vp_total_proposto: number;
    elegiveis: number;
    inelegiveis: number;
    enquadram: number;
    desenquadram: number;
    vp_elegiveis: number;
  };
  recompras?: {
    total: number;
    vp: number;
  };
  proforma?: {
    vp_total: number;
    perc_pl: number;
    prazo_medio_pond: number;
    espaco_livre: number;
  };
  motivos_rejeicao?: { regra_codigo: string; regra_descricao: string; count: number }[];
  regras_checklist?: {
    regra_codigo: string;
    regra_descricao: string;
    modo: string;
    rejeicoes: number;
    total_dcs: number;
    status: "ok" | "violacao";
    valor_atual: string | null;
    valor_limite: string | null;
    detalhes_dcs: {
      ds_seu_numero: string;
      nm_sacado: string;
      nm_cedente: string;
      vl_pago: number;
      prazo: number;
      valor_atual: any;
      valor_limite: any;
    }[];
    submotivos_cadastro?: { codigo: string; descricao: string; count: number }[];
    breakdown?: {
      tipo_item: "cedente" | "sacado" | "dc";
      tipo_linha?: "resumo" | "titulo" | "taxa" | "cadastro_limite";
      origem?: "estoque" | "csv" | "proforma";
      label: string;
      doc: string;
      documento?: string;
      cedente?: string;
      sacado?: string;
      prazo?: number;
      dt_vencimento?: string | null;
      total_aquisicao?: number | null;
      coobrigacao?: string | null;
      valor_rs?: number;
      estoque_rs?: number;
      proposto_rs?: number;
      total_rs?: number;
      pct_pl?: number;
      limite_pct_pl?: number;
      valor_atual_texto?: string;
      limite_texto?: string;
      pct_uso_limite?: number | null;
      valor_extra?: string;
      status: "ok" | "violacao";
    }[];
    detalhes_origem?: {
      tipo_item: "cedente" | "sacado" | "dc";
      tipo_linha?: "resumo" | "titulo" | "taxa";
      origem?: "estoque" | "csv" | "proforma";
      label: string;
      doc: string;
      documento?: string;
      cedente?: string;
      sacado?: string;
      prazo?: number;
      dt_vencimento?: string | null;
      total_aquisicao?: number | null;
      coobrigacao?: string | null;
      valor_rs?: number;
      estoque_rs?: number;
      proposto_rs?: number;
      total_rs?: number;
      pct_pl?: number;
      limite_pct_pl?: number;
      valor_atual_texto?: string;
      limite_texto?: string;
      valor_extra?: string;
      status: "ok" | "violacao";
    }[];
  }[];
  coobrigacao_cedentes?: Record<string, boolean>;
  resultados?: {
    ds_seu_numero: string;
    nm_sacado: string;
    nm_cedente: string;
    cpf_cnpj_cedente: string;
    vl_pago: number;
    prazo: number;
    tipo_operacao?: "AQUISICAO" | "RECOMPRA";
    elegivel: boolean | null;
    enquadra?: boolean | null;
    motivos: { regra_codigo: string; regra_descricao: string; valor_atual: any; valor_limite: any }[];
  }[];
  error?: string;
}

const DESCRICAO_CADASTRO_PARTES =
  "Cadastro de partes — vigência de cedentes/sacados e limite de comitê";

function descricaoChecklistRegra(rc: { regra_codigo: string; regra_descricao: string; modo?: string }): string {
  if (
    rc.modo === "cadastro" ||
    rc.regra_codigo === "CESSAO_CADASTRO_PARTES" ||
    rc.regra_codigo.startsWith("CESSAO_CADASTRO_PARTES_")
  ) {
    if (/investidor profissional|% do pl/i.test(rc.regra_descricao)) return DESCRICAO_CADASTRO_PARTES;
  }
  return rc.regra_descricao;
}

// ── Component ───────────────────────────────────────────────────────────────

export default function CreditoElegibilidade() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [activeTab, setActiveTab] = useState("validar");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ValidacaoResult | null>(null);
  const [simuladoEm, setSimuladoEm] = useState<Date | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);
  const [exportingItemId, setExportingItemId] = useState<string | null>(null);
  const [expandedDc, setExpandedDc] = useState<string | null>(null);
  const [expandedRegra, setExpandedRegra] = useState<string | null>(null);

  // ── Coobrigação dialog ───────────────────────────────────────────────────
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [coobrigacaoOpen, setCoobrigacaoOpen] = useState(false);
  const [cedentesCoob, setCedentesCoob] = useState<CedenteCoobrigacao[]>([]);

  // ── Queries ─────────────────────────────────────────────────────────────

  const { data: historico = [] } = useQuery({
    queryKey: ["elegibilidade-historico"],
    queryFn: async () => {
      const { data } = await supabase
        .from("cessao_importacoes" as any)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      return (data || []) as any[];
    },
  });

  // ── Handlers ────────────────────────────────────────────────────────────

  // Etapa 1: arquivo selecionado → parse cedentes → abrir dialog
  const handleFileSelected = useCallback((file: File) => {
    setPendingFile(file);
    setResult(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = (e.target?.result as string) ?? "";
      const cedentes = parseCedentesCsv(text);
      if (cedentes.length === 0) {
        // CSV sem colunas reconhecidas ou sem cedentes — enviar diretamente sem coobrigação
        handleUploadCessao(file, {});
        return;
      }
      setCedentesCoob(cedentes);
      setCoobrigacaoOpen(true);
    };
    reader.readAsText(file, "iso-8859-1");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Etapa 2: coobrigação confirmada → enviar para o motor
  const handleUploadCessao = useCallback(async (
    file: File,
    coobrigacaoMap: Record<string, boolean>,
  ) => {
    setCoobrigacaoOpen(false);
    setUploading(true);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("coobrigacao_cedentes", JSON.stringify(coobrigacaoMap));
      const { data, error } = await invokeFunction("validar-cessao-elegibilidade", formData);
      if (error) throw error;
      setResult(data as ValidacaoResult);
      if (data?.success) {
        setSimuladoEm(new Date());
        const cp = data.cessao_proposta;
        const recomp = data.recompras;
        const recompDesc = recomp && recomp.total > 0 ? ` · ${recomp.total} recompra(s)` : "";
        toast({
          title: "Cessão validada",
          description: `${cp?.enquadram ?? 0} enquadram de ${cp?.total_dcs ?? 0} DCs (${cp?.elegiveis ?? 0} elegíveis, ${cp?.desenquadram ?? 0} desenquadram)${recompDesc}`,
        });
        qc.invalidateQueries({ queryKey: ["elegibilidade-historico"] });
      } else {
        toast({ title: "Erro na validação", description: data?.error || "Erro desconhecido", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Erro", description: err.message || "Falha ao validar cessão", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }, [toast, qc]);

  // ── Handlers de exportação ───────────────────────────────────────────────

  const handleExportAnalisePDF = useCallback(async () => {
    if (!result || !simuladoEm) return;
    setExportingPdf(true);
    try {
      await exportAnalisePDF({
        simuladoEm,
        fundo_cnpj: result.fundo_cnpj,
        fundo_nome: result.fundo_nome,
        carteira_atual: result.carteira_atual,
        cessao_proposta: result.cessao_proposta,
        proforma: result.proforma,
        regras_checklist: result.regras_checklist?.map(rc => ({
          regra_codigo: rc.regra_codigo,
          regra_descricao: rc.regra_descricao,
          modo: rc.modo,
          rejeicoes: rc.rejeicoes,
          total_dcs: rc.total_dcs,
          status: rc.status,
          valor_atual: rc.valor_atual,
          valor_limite: rc.valor_limite,
          breakdown: rc.breakdown,
          detalhes_dcs: rc.detalhes_dcs,
          submotivos_cadastro: rc.submotivos_cadastro,
        })),
        resultados: result.resultados,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao gerar PDF";
      toast({ title: "Erro ao exportar PDF", description: msg, variant: "destructive" });
    } finally {
      setExportingPdf(false);
    }
  }, [result, simuladoEm, toast]);

  const handleExportAnaliseExcel = useCallback(async () => {
    if (!result || !simuladoEm) return;
    setExportingXlsx(true);
    try {
      await exportAnaliseExcel({
        simuladoEm,
        fundo_cnpj: result.fundo_cnpj,
        fundo_nome: result.fundo_nome,
        carteira_atual: result.carteira_atual,
        cessao_proposta: result.cessao_proposta,
        proforma: result.proforma,
        regras_checklist: result.regras_checklist?.map(rc => ({
          regra_codigo: rc.regra_codigo,
          regra_descricao: rc.regra_descricao,
          modo: rc.modo,
          rejeicoes: rc.rejeicoes,
          total_dcs: rc.total_dcs,
          status: rc.status,
          valor_atual: rc.valor_atual,
          valor_limite: rc.valor_limite,
          breakdown: rc.breakdown,
          detalhes_dcs: rc.detalhes_dcs,
          submotivos_cadastro: rc.submotivos_cadastro,
        })),
        resultados: result.resultados,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao gerar Excel";
      toast({ title: "Erro ao exportar Excel", description: msg, variant: "destructive" });
    } finally {
      setExportingXlsx(false);
    }
  }, [result, simuladoEm, toast]);

  const handleExportHistoricoPDF = useCallback(async () => {
    setExportingPdf(true);
    try {
      await exportHistoricoPDF(historico as HistoricoItem[]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao gerar PDF";
      toast({ title: "Erro ao exportar PDF", description: msg, variant: "destructive" });
    } finally {
      setExportingPdf(false);
    }
  }, [historico, toast]);

  const handleExportHistoricoExcel = useCallback(async () => {
    setExportingXlsx(true);
    try {
      await exportHistoricoExcel(historico as HistoricoItem[]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao gerar Excel";
      toast({ title: "Erro ao exportar Excel", description: msg, variant: "destructive" });
    } finally {
      setExportingXlsx(false);
    }
  }, [historico, toast]);

  const fetchResultadosAnaliticos = useCallback(async (importId: string) => {
    const { data } = await supabase
      .from("cessao_resultado_analitico" as any)
      .select("ds_seu_numero,nm_cedente,cpf_cnpj_cedente,nm_sacado,vl_pago,prazo,elegivel,enquadra,motivos_rejeicao,tipo_operacao")
      .eq("import_id", importId);
    return (data || []).map((r: any) => ({
      ds_seu_numero: r.ds_seu_numero,
      nm_cedente: r.nm_cedente,
      cpf_cnpj_cedente: r.cpf_cnpj_cedente,
      nm_sacado: r.nm_sacado,
      vl_pago: r.vl_pago,
      prazo: r.prazo,
      tipo_operacao: r.tipo_operacao ?? "AQUISICAO",
      elegivel: r.elegivel,
      enquadra: r.enquadra,
      motivos: r.motivos_rejeicao ?? [],
    }));
  }, []);

  const handleExportItemPDF = useCallback(async (h: Record<string, unknown>) => {
    setExportingItemId(h.id as string);
    try {
      const resultados = await fetchResultadosAnaliticos(h.id as string);
      await exportHistoricoItemPDF({ ...h, resultados });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao gerar PDF";
      toast({ title: "Erro ao exportar PDF", description: msg, variant: "destructive" });
    } finally {
      setExportingItemId(null);
    }
  }, [fetchResultadosAnaliticos, toast]);

  const handleExportItemExcel = useCallback(async (h: Record<string, unknown>) => {
    setExportingItemId(h.id as string);
    try {
      const resultados = await fetchResultadosAnaliticos(h.id as string);
      await exportHistoricoItemExcel({ ...h, resultados });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao gerar Excel";
      toast({ title: "Erro ao exportar Excel", description: msg, variant: "destructive" });
    } finally {
      setExportingItemId(null);
    }
  }, [fetchResultadosAnaliticos, toast]);

  // ── Render ──────────────────────────────────────────────────────────────

  const r = result;
  const ca = r?.carteira_atual;
  const cp = r?.cessao_proposta;
  const pf = r?.proforma;
  const recomp = r?.recompras;

  return (
    <Layout>
      <div className="max-w-[1400px] mx-auto space-y-5 p-6">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-7 h-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Elegibilidade de Cessões</h1>
            <p className="text-sm text-muted-foreground">
              Simulação de cessão FIDC — regras gerenciadas em{" "}
              <a href="/regras" className="underline text-primary hover:text-primary/80">Regras de Compliance</a>
            </p>
          </div>
        </div>

        {/* ── Dialog: Coobrigação por cedente ── */}
        <Dialog open={coobrigacaoOpen} onOpenChange={setCoobrigacaoOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-primary" />
                Coobrigação dos Cedentes
              </DialogTitle>
              <DialogDescription className="text-xs">
                O CSV não contém informação de coobrigação. Indique abaixo se cada cedente desta cessão possui ou não coobrigação com o fundo. Esta informação é usada no cálculo da concentração de DCs sem coobrigação.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border divide-y max-h-72 overflow-y-auto">
              {cedentesCoob.map((c, i) => (
                <div key={c.doc} className="flex items-center justify-between px-4 py-2.5 gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{c.nome}</p>
                    <p className="text-[10px] text-muted-foreground font-mono">{c.doc}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-[11px] font-semibold ${c.coobrigacao ? "text-emerald-700" : "text-red-600"}`}>
                      {c.coobrigacao ? "Com coob." : "Sem coob."}
                    </span>
                    <Switch
                      id={`coob-${c.doc}`}
                      checked={c.coobrigacao}
                      onCheckedChange={(val) =>
                        setCedentesCoob(prev => prev.map((x, xi) => xi === i ? { ...x, coobrigacao: val } : x))
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">
              <strong>Com coobrigação</strong> = cedente mantém a garantia de crédito (switch <em>ativo</em>).{" "}
              <strong>Sem coobrigação</strong> = todo o risco fica com o fundo (switch <em>inativo</em>).
            </p>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setCoobrigacaoOpen(false)}>Cancelar</Button>
              <Button
                onClick={() => {
                  if (!pendingFile) return;
                  const map = Object.fromEntries(cedentesCoob.map(c => [c.doc, c.coobrigacao]));
                  handleUploadCessao(pendingFile, map);
                }}
              >
                Confirmar e Validar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="validar" className="gap-1.5"><ShieldCheck className="w-3.5 h-3.5" />Simular Cessão</TabsTrigger>
            <TabsTrigger value="historico" className="gap-1.5"><History className="w-3.5 h-3.5" />Histórico</TabsTrigger>
          </TabsList>

          {/* ══════════════ TAB SIMULAR ══════════════ */}
          <TabsContent value="validar" className="space-y-4">
            <Card>
              <CardContent className="pt-6">
                <Dropzone
                  accept=".csv"
                  label="Importar CSV de Cessão"
                  sublabel="Arraste o arquivo CSV da cessão analítica aqui ou clique para selecionar. O fundo é identificado automaticamente pelo CNPJ_FUNDO no CSV."
                  icon={<FileUp className="w-8 h-8 text-muted-foreground" />}
                  loading={uploading}
                  loadingText="Validando cessão..."
                  onFile={handleFileSelected}
                />
              </CardContent>
            </Card>

            {r?.success && ca && cp && pf && (
              <>
                {/* KPI Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                  {/* Carteira Atual */}
                  <Card className="border-blue-200 shadow-sm">
                    <CardHeader className="pb-3 pt-5 px-5 border-b border-blue-100 bg-blue-50/40 dark:bg-blue-950/10">
                      <CardTitle className="text-base font-semibold text-blue-700">Carteira Atual</CardTitle>
                      <CardDescription className="text-xs">Antes da cessão</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2 px-5 py-4">
                      <KpiRow
                        label="Estoque (data ref.)"
                        value={formatDataEstoque(ca.estoque_data_referencia)}
                      />
                      <KpiRow
                        label="Data da posição (PL)"
                        value={formatDataPosicaoPl(ca.pl_data_posicao)}
                      />
                      <KpiRow
                        label="PL considerado"
                        value={ca.pl > 0 ? formatBRL(ca.pl) : "—"}
                        hint={
                          ca.pl_origem === "fidc_header" && ca.pl_header_raw != null && ca.pl_header_raw !== ca.pl
                            ? `Ativos + a receber (PL XML: ${formatBRL(ca.pl_header_raw)})`
                            : ca.pl_origem === "xml" && ca.pl_header_raw != null && ca.pl_header_raw === ca.pl
                              ? "Patrimônio líquido da posição (fundo_patliq)"
                              : undefined
                        }
                      />
                      <KpiRow label="Qtd Recebíveis" value={ca.qtd_recebiveis.toLocaleString("pt-BR")} />
                      <KpiRow label="VP Total Estoque" value={formatBRL(ca.vp_total)} />
                      <KpiRow label="PDD Total" value={formatBRL(ca.pdd_total)} />
                      <KpiRow label="Prazo Médio Pond." value={formatDias(ca.prazo_medio_pond)} />
                      <KpiRow label="% PL Alocado" value={formatPct(ca.perc_pl_alocado)} />
                    </CardContent>
                  </Card>

                  {/* Cessão Proposta */}
                  <Card className="border-amber-200 shadow-sm">
                    <CardHeader className="pb-3 pt-5 px-5 border-b border-amber-100 bg-amber-50/40 dark:bg-amber-950/10">
                      <CardTitle className="text-base font-semibold text-amber-700">Cessão Proposta</CardTitle>
                      <CardDescription className="text-xs truncate">{r.fundo_nome}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2 px-5 py-4">
                      <KpiRow label="Qtd DCs Propostos" value={cp.total_dcs.toLocaleString("pt-BR")} />
                      <KpiRow label="VP Total Proposto" value={formatBRL(cp.vp_total_proposto)} />
                      <div className="flex justify-between items-center py-0.5">
                        <span className="text-xs text-muted-foreground">DCs Elegíveis</span>
                        <Badge variant="default" className="bg-emerald-600 text-xs px-2 py-0.5">{cp.elegiveis}</Badge>
                      </div>
                      <div className="flex justify-between items-center py-0.5">
                        <span className="text-xs text-muted-foreground">DCs Inelegíveis</span>
                        <Badge variant="destructive" className="text-xs px-2 py-0.5">{cp.inelegiveis}</Badge>
                      </div>
                      <div className="flex justify-between items-center py-0.5">
                        <span className="text-xs text-muted-foreground">Enquadram</span>
                        <Badge className="bg-emerald-600 text-xs px-2 py-0.5">{cp.enquadram}</Badge>
                      </div>
                      <div className="flex justify-between items-center py-0.5">
                        <span className="text-xs text-muted-foreground">Desenquadram</span>
                        <Badge variant={cp.desenquadram > 0 ? "destructive" : "secondary"} className="text-xs px-2 py-0.5">{cp.desenquadram}</Badge>
                      </div>
                      <div className="flex justify-between items-center py-0.5">
                        <span className="text-xs text-muted-foreground">VP Elegíveis</span>
                        <span className="text-sm font-semibold">{formatBRL(cp.vp_elegiveis)}</span>
                      </div>
                      {recomp && recomp.total > 0 && (
                        <>
                          <div className="border-t border-border/50 my-1" />
                          <div className="flex justify-between items-center py-0.5">
                            <span className="text-xs text-muted-foreground">Recompras</span>
                            <Badge variant="secondary" className="text-xs px-2 py-0.5 text-slate-600">{recomp.total} DCs</Badge>
                          </div>
                          <div className="flex justify-between items-center py-0.5">
                            <span className="text-xs text-muted-foreground">VP Recompras</span>
                            <span className="text-sm font-medium text-slate-500">{formatBRL(recomp.vp)}</span>
                          </div>
                        </>
                      )}
                    </CardContent>
                  </Card>

                  {/* Pró-Forma */}
                  <Card className="border-emerald-200 shadow-sm">
                    <CardHeader className="pb-3 pt-5 px-5 border-b border-emerald-100 bg-emerald-50/40 dark:bg-emerald-950/10">
                      <CardTitle className="text-base font-semibold text-emerald-700">Carteira Pró-Forma</CardTitle>
                      <CardDescription className="text-xs">Após cessão dos que enquadram</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2 px-5 py-4">
                      <KpiRow
                        label="Ref. PL (mesma data)"
                        value={formatDataPosicaoPl(ca.pl_data_posicao)}
                      />
                      <KpiRow label="VP Total Pró-Forma" value={formatBRL(pf.vp_total)} />
                      <KpiRow label="% PL Pró-Forma" value={formatPct(pf.perc_pl)} />
                      <KpiRow label="Prazo Médio Pond." value={formatDias(pf.prazo_medio_pond)} />
                      <KpiRow label="Espaço Livre" value={formatBRL(pf.espaco_livre)} />
                    </CardContent>
                  </Card>
                </div>

                {/* Checklist de Regras Avaliadas */}
                {r.regras_checklist && r.regras_checklist.length > 0 && (
                  <Card className="shadow-sm">
                    <CardHeader className="pb-3 pt-5 px-5 border-b">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div>
                          <CardTitle className="text-base flex items-center gap-2">
                            <ShieldCheck className="w-5 h-5 text-primary" /> Verificação de Regras Pré-Trade
                          </CardTitle>
                          <CardDescription className="text-xs mt-0.5">
                            {r.regras_checklist.length} regras avaliadas — evidência de enquadramento
                            {simuladoEm && (
                              <span className="ml-1 text-muted-foreground">
                                · Análise: {simuladoEm.toLocaleDateString("pt-BR")} às {simuladoEm.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                              </span>
                            )}
                          </CardDescription>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5 text-xs border-[#003D27] text-[#003D27] hover:bg-[#003D27]/5"
                            onClick={handleExportAnalisePDF}
                            disabled={exportingPdf}
                          >
                            {exportingPdf
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <FileDown className="w-3.5 h-3.5" />
                            }
                            PDF
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5 text-xs border-[#003D27] text-[#003D27] hover:bg-[#003D27]/5"
                            onClick={handleExportAnaliseExcel}
                            disabled={exportingXlsx}
                          >
                            {exportingXlsx
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <FileDown className="w-3.5 h-3.5" />
                            }
                            Excel
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="px-5 py-4">
                      <div className="rounded-md border border-border overflow-hidden">
                        <Table>
                          <TableHeader className="bg-muted/60">
                            <TableRow>
                              <TableHead className="text-xs font-bold uppercase w-[36px]"></TableHead>
                              <TableHead className="text-xs font-bold uppercase">Regra de Cessão</TableHead>
                              <TableHead className="text-xs font-bold uppercase w-[120px]">Modo</TableHead>
                              <TableHead className="text-xs font-bold uppercase w-[160px]">Valor Atual</TableHead>
                              <TableHead className="text-xs font-bold uppercase w-[160px]">Limite</TableHead>
                              <TableHead className="text-xs font-bold uppercase w-[120px]">Rejeições</TableHead>
                              <TableHead className="text-xs font-bold uppercase w-[70px] text-center">Status</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {r.regras_checklist.map(rc => {
                              const isExpanded = expandedRegra === rc.regra_codigo;
                              const cadastroLimiteRows = rc.modo === "cadastro" ? (rc.breakdown ?? []) : [];
                              const hasCadastroLimiteRows = cadastroLimiteRows.length > 0;
                              const hasBreakdown = rc.breakdown && rc.breakdown.length > 0;
                              const resumoRows = rc.modo === "cadastro"
                                ? []
                                : (rc.breakdown?.filter(b => (b.tipo_linha ?? "resumo") === "resumo") ?? []);
                              const tituloRows = rc.breakdown?.filter(b => b.tipo_linha === "titulo") ?? [];
                              const taxaRows = rc.breakdown?.filter(b => b.tipo_linha === "taxa") ?? [];
                              const hasResumoRows = resumoRows.length > 0;
                              const hasTaxaRows = taxaRows.length > 0;
                              // tituloRows só são renderizados quando não há taxaRows (modo taxa usa bloco próprio)
                              const renderTituloRows = taxaRows.length === 0
                                ? (tituloRows.length > 0 ? tituloRows : (!hasResumoRows ? rc.breakdown : []))
                                : [];
                              const hasDetalhesOrigem = rc.detalhes_origem && rc.detalhes_origem.length > 0;
                              const hasViolationDcs = rc.detalhes_dcs && rc.detalhes_dcs.length > 0;
                              const hasSubmotivosCadastro = rc.submotivos_cadastro && rc.submotivos_cadastro.length > 0;
                              const hasDetails = hasBreakdown || hasDetalhesOrigem || hasViolationDcs || hasSubmotivosCadastro || hasCadastroLimiteRows;
                              const isConcentracao = rc.modo === "concentracao" || rc.breakdown?.some(b => b.tipo_item !== "dc");
                              return (
                                <Fragment key={rc.regra_codigo}>
                                  <TableRow
                                    className={`${rc.status === "violacao" && rc.rejeicoes > 0 ? "bg-red-50/50 dark:bg-red-950/10" : rc.status === "violacao" && rc.rejeicoes === 0 ? "bg-amber-50/40 dark:bg-amber-950/10" : ""} ${hasDetails ? "cursor-pointer hover:bg-muted/30" : ""}`}
                                    onClick={() => hasDetails && setExpandedRegra(isExpanded ? null : rc.regra_codigo)}
                                  >
                                    <TableCell className="px-3 py-3">
                                      {hasDetails ? (
                                        isExpanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />
                                      ) : null}
                                    </TableCell>
                                    <TableCell className="py-3">
                                      <div className="space-y-1">
                                        <p className="text-sm">{descricaoChecklistRegra(rc)}</p>
                                        <Badge variant="outline" className="font-mono text-[10px]">{rc.regra_codigo}</Badge>
                                      </div>
                                    </TableCell>
                                    <TableCell className="py-3">
                                      <Badge variant="secondary" className="text-xs">
                                        {rc.modo === "cadastro"
                                          ? "Cadastro"
                                          : rc.modo === "individual"
                                            ? "Individual"
                                            : rc.modo === "proforma"
                                              ? "Pró-forma"
                                              : "Concentração"}
                                      </Badge>
                                    </TableCell>
                                    <TableCell className="py-3">
                                      <span className="text-sm text-muted-foreground">
                                        {rc.modo === "cadastro"
                                          ? (rc.rejeicoes > 0 ? `${rc.rejeicoes} cedente(s)` : "—")
                                          : (rc.valor_atual ?? "—")}
                                      </span>
                                    </TableCell>
                                    <TableCell className="py-3">
                                      <span className="text-sm text-muted-foreground">
                                        {rc.modo === "cadastro" ? "cadastro vigente" : (rc.valor_limite ?? "—")}
                                      </span>
                                    </TableCell>
                                    <TableCell className="py-3">
                                      {rc.rejeicoes === 0 ? (
                                        <span className="text-sm text-emerald-700 font-medium">0 / {rc.total_dcs} DCs</span>
                                      ) : (
                                        <span className="text-sm text-red-700 font-semibold">{rc.rejeicoes} / {rc.total_dcs} DCs</span>
                                      )}
                                    </TableCell>
                                    <TableCell className="text-center">
                                      {rc.status === "ok" ? (
                                        <CheckCircle2 className="w-5 h-5 text-emerald-600 mx-auto" />
                                      ) : rc.rejeicoes === 0 ? (
                                        /* Violação vem só do estoque — cessão pode prosseguir */
                                        <span className="inline-flex items-center justify-center gap-1">
                                          <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                                          <AlertTriangle className="w-4 h-4 text-amber-500" />
                                        </span>
                                      ) : (
                                        <XCircle className="w-5 h-5 text-red-600 mx-auto" />
                                      )}
                                    </TableCell>
                                  </TableRow>
                                  {isExpanded && hasDetails && (
                                    <TableRow>
                                      <TableCell colSpan={7} className="p-0 bg-muted/20">
                                        <div className="px-6 py-3 space-y-4">

                                          {/* ── Submotivos de cadastro (CESSAO_CADASTRO_PARTES) ── */}
                                          {hasSubmotivosCadastro && (
                                            <div>
                                              <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                                                Motivos de cadastro
                                              </p>
                                              <div className="rounded border border-border overflow-hidden">
                                                <Table>
                                                  <TableHeader className="bg-muted/50">
                                                    <TableRow>
                                                      <TableHead className="text-xs font-bold uppercase">Motivo</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase font-mono w-[200px]">Código</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase w-[100px] text-right">DCs</TableHead>
                                                    </TableRow>
                                                  </TableHeader>
                                                  <TableBody>
                                                    {rc.submotivos_cadastro!.map((sm) => (
                                                      <TableRow key={sm.codigo}>
                                                        <TableCell className="text-sm py-2.5">{sm.descricao}</TableCell>
                                                        <TableCell>
                                                          <Badge variant="outline" className="font-mono text-[10px]">{sm.codigo}</Badge>
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums text-sm font-semibold text-red-700 py-2.5">
                                                          {sm.count}
                                                        </TableCell>
                                                      </TableRow>
                                                    ))}
                                                  </TableBody>
                                                </Table>
                                              </div>
                                            </div>
                                          )}

                                          {/* ── Limite comitê por cedente da cessão ── */}
                                          {hasCadastroLimiteRows && (
                                            <div>
                                              <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                                                Cedentes da cessão — exposição pró-forma vs limite de comitê
                                              </p>
                                              <div className="rounded border border-border overflow-hidden">
                                                <Table>
                                                  <TableHeader className="bg-muted/50">
                                                    <TableRow>
                                                      <TableHead className="text-xs font-bold uppercase">Cedente</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase font-mono">CNPJ / Grupo</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase w-[120px] text-right">Estoque (R$)</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase w-[120px] text-right">CSV (R$)</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase w-[130px] text-right">Exposição (R$)</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase w-[130px] text-right">Limite comitê</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase w-[80px] text-right">% uso</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase w-[120px]">Validade</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase w-[60px] text-center">Status</TableHead>
                                                    </TableRow>
                                                  </TableHeader>
                                                  <TableBody>
                                                    {cadastroLimiteRows.map((brow, idx) => (
                                                      <TableRow
                                                        key={`cad-lim-${brow.doc}-${idx}`}
                                                        className={brow.status === "violacao" ? "bg-red-50/70 dark:bg-red-950/20" : ""}
                                                      >
                                                        <TableCell className="text-sm font-medium py-2.5">{brow.label}</TableCell>
                                                        <TableCell className="font-mono text-xs text-muted-foreground py-2.5">{brow.doc || "—"}</TableCell>
                                                        <TableCell className="text-right tabular-nums text-sm py-2.5">
                                                          {brow.estoque_rs != null ? brow.estoque_rs.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums text-sm py-2.5">
                                                          {brow.proposto_rs != null ? brow.proposto_rs.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
                                                        </TableCell>
                                                        <TableCell className={`text-right tabular-nums text-sm font-semibold py-2.5 ${brow.status === "violacao" ? "text-red-700" : ""}`}>
                                                          {brow.valor_atual_texto ?? (brow.total_rs != null ? brow.total_rs.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—")}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums text-sm text-muted-foreground py-2.5">
                                                          {brow.limite_texto ?? "—"}
                                                        </TableCell>
                                                        <TableCell className={`text-right tabular-nums text-sm font-bold py-2.5 ${brow.pct_uso_limite != null && brow.pct_uso_limite > 100 ? "text-red-700" : "text-emerald-700"}`}>
                                                          {brow.pct_uso_limite != null ? `${brow.pct_uso_limite.toFixed(1)}%` : "—"}
                                                        </TableCell>
                                                        <TableCell className="text-xs text-muted-foreground py-2.5">{brow.valor_extra ?? "—"}</TableCell>
                                                        <TableCell className="text-center py-2.5">
                                                          {brow.status === "ok"
                                                            ? <CheckCircle2 className="w-4 h-4 text-emerald-600 mx-auto" />
                                                            : <XCircle className="w-4 h-4 text-red-600 mx-auto" />}
                                                        </TableCell>
                                                      </TableRow>
                                                    ))}
                                                  </TableBody>
                                                </Table>
                                              </div>
                                            </div>
                                          )}

                                          {/* ── Breakdown: resumos / composição ── */}
                                          {hasResumoRows && (() => {
                                            const isPrazoMedioComposicao = /^CESSAO_PRAZO_MEDIO_/.test(rc.regra_codigo);
                                            return (
                                            <div>
                                              <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                                                {resumoRows.some(rw => rw.origem === "estoque" || rw.origem === "csv" || rw.origem === "proforma")
                                                  ? "Composição do Pró-forma"
                                                  : rc.breakdown[0]?.tipo_item === "sacado"
                                                    ? "Sacados — exposição pró-forma (estoque + cessão elegível)"
                                                    : "Cedentes — exposição pró-forma (estoque + cessão elegível)"}
                                              </p>
                                              <div className="rounded border border-border overflow-hidden">
                                                <Table>
                                                  <TableHeader className="bg-muted/50">
                                                    <TableRow>
                                                      <TableHead className="text-xs font-bold uppercase">Linha</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase font-mono">Doc</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase w-[140px] text-right">Estoque (R$)</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase w-[140px] text-right">CSV Importado (R$)</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase w-[140px] text-right">Total (R$)</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase w-[110px] text-right">{isPrazoMedioComposicao ? "Valor Atual" : "% PL"}</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase w-[100px] text-right">Limite</TableHead>
                                                      <TableHead className="text-xs font-bold uppercase w-[60px] text-center">Status</TableHead>
                                                    </TableRow>
                                                  </TableHeader>
                                                  <TableBody>
                                                    {(resumoRows.length > 0 ? resumoRows : rc.breakdown).map((brow, idx) => (
                                                      <TableRow
                                                        key={`${brow.origem ?? brow.doc}-${idx}`}
                                                        className={brow.status === "violacao" ? "bg-red-50/70 dark:bg-red-950/20" : ""}
                                                      >
                                                        <TableCell className="text-sm font-medium py-2.5">
                                                          <div className="flex items-center gap-2">
                                                            {brow.origem === "estoque" && <Badge variant="outline" className="text-[10px]">Estoque_FIDC</Badge>}
                                                            {brow.origem === "csv" && <Badge variant="outline" className="text-[10px]">CSV</Badge>}
                                                            {brow.origem === "proforma" && <Badge variant="secondary" className="text-[10px]">Pró-forma</Badge>}
                                                            <span>{brow.label}</span>
                                                          </div>
                                                        </TableCell>
                                                        <TableCell className="font-mono text-xs text-muted-foreground py-2.5">{brow.doc || "—"}</TableCell>
                                                        <TableCell className="text-right tabular-nums text-sm py-2.5">
                                                          {brow.estoque_rs != null ? brow.estoque_rs.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums text-sm py-2.5">
                                                          {brow.proposto_rs != null ? brow.proposto_rs.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums text-sm font-semibold py-2.5">
                                                          {brow.total_rs != null ? brow.total_rs.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
                                                        </TableCell>
                                                        <TableCell className={`text-right tabular-nums text-sm font-bold py-2.5 ${brow.status === "violacao" ? "text-red-700" : "text-emerald-700"}`}>
                                                          {isPrazoMedioComposicao
                                                            ? (brow.valor_atual_texto ?? "—")
                                                            : brow.pct_pl != null
                                                              ? `${brow.pct_pl.toFixed(2)}%`
                                                              : "—"}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums text-sm text-muted-foreground py-2.5">
                                                          {isPrazoMedioComposicao
                                                            ? (brow.limite_texto ?? rc.valor_limite ?? "—")
                                                            : brow.limite_pct_pl != null
                                                              ? `${brow.limite_pct_pl.toFixed(2)}%`
                                                              : "—"}
                                                        </TableCell>
                                                        <TableCell className="text-center py-2.5">
                                                          {brow.status === "ok"
                                                            ? <CheckCircle2 className="w-4 h-4 text-emerald-600 mx-auto" />
                                                            : <XCircle className="w-4 h-4 text-red-600 mx-auto" />}
                                                        </TableCell>
                                                      </TableRow>
                                                    ))}
                                                  </TableBody>
                                                </Table>
                                              </div>
                                            </div>
                                            );
                                          })()}

                                          {/* ── Breakdown: Taxa por cessão / cedente ── */}
                                          {hasTaxaRows && (
                                            <div>
                                              <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-2">
                                                Cessões avaliadas ({taxaRows.length})
                                              </p>
                                              <div className="rounded border border-border overflow-hidden">
                                                <Table>
                                                  <TableHeader className="bg-muted/40">
                                                    <TableRow>
                                                      <TableHead className="text-[9px] font-bold uppercase">Cedente / Cessão</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase font-mono">CNPJ</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[110px] text-right">CDI Vigente</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[160px] text-right">Valor Apurado</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[160px] text-right">Limite</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[60px] text-center">Status</TableHead>
                                                    </TableRow>
                                                  </TableHeader>
                                                  <TableBody>
                                                    {taxaRows.map((brow, idx) => (
                                                      <TableRow
                                                        key={`taxa-${brow.doc}-${idx}`}
                                                        className={brow.status === "violacao" ? "bg-red-50/70 dark:bg-red-950/20" : ""}
                                                      >
                                                        <TableCell className="text-[11px] font-medium">{brow.label}</TableCell>
                                                        <TableCell className="font-mono text-[9px] text-muted-foreground">{brow.doc || "—"}</TableCell>

                                                        {/* CDI Vigente */}
                                                        <TableCell className="text-right tabular-nums text-[11px] text-muted-foreground">
                                                          {brow.estoque_rs != null && brow.estoque_rs > 0
                                                            ? `${brow.estoque_rs.toFixed(2)}% a.a.`
                                                            : "—"}
                                                        </TableCell>

                                                        {/* Valor Apurado: % a.a. + % CDI */}
                                                        <TableCell className="text-right">
                                                          <div className={`tabular-nums text-[12px] font-bold leading-tight ${brow.status === "violacao" ? "text-red-700" : "text-emerald-700"}`}>
                                                            {brow.pct_pl != null ? `${brow.pct_pl.toFixed(2)}% a.a.` : "—"}
                                                          </div>
                                                          {brow.valor_extra && (
                                                            <div className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
                                                              {brow.valor_extra}% CDI
                                                            </div>
                                                          )}
                                                        </TableCell>

                                                        {/* Limite: N% CDI + valor a.a. equivalente */}
                                                        <TableCell className="text-right">
                                                          <div className="text-[11px] font-semibold leading-tight text-foreground">
                                                            {brow.proposto_rs != null
                                                              ? `≥ ${brow.proposto_rs.toFixed(0)}% CDI`
                                                              : brow.limite_pct_pl != null
                                                                ? `≥ ${brow.limite_pct_pl.toFixed(2)}% a.a.`
                                                                : "—"}
                                                          </div>
                                                          {brow.proposto_rs != null && brow.limite_pct_pl != null && (
                                                            <div className="text-[10px] text-muted-foreground mt-0.5">
                                                              (≥ {brow.limite_pct_pl.toFixed(2)}% a.a.)
                                                            </div>
                                                          )}
                                                        </TableCell>

                                                        <TableCell className="text-center">
                                                          {brow.status === "ok"
                                                            ? <CheckCircle2 className="w-4 h-4 text-emerald-600 mx-auto" />
                                                            : <XCircle className="w-4 h-4 text-red-600 mx-auto" />}
                                                        </TableCell>
                                                      </TableRow>
                                                    ))}
                                                  </TableBody>
                                                </Table>
                                              </div>
                                            </div>
                                          )}

                                          {/* ── Breakdown: DCs individuais ── */}
                                          {renderTituloRows.length > 0 && !hasDetalhesOrigem && (
                                            <div>
                                              <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-2">
                                                Títulos avaliados ({renderTituloRows.length})
                                              </p>
                                              <div className="rounded border border-border overflow-hidden">
                                                <Table>
                                                  <TableHeader className="bg-muted/40">
                                                    <TableRow>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[70px]">Origem</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase">Nº Documento</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase">Cedente</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase">Sacado</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[95px]">DT_VENCIMENTO</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[110px] text-right">TOTAL_AQUISICAO</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[50px] text-center">Status</TableHead>
                                                    </TableRow>
                                                  </TableHeader>
                                                  <TableBody>
                                                    {renderTituloRows.map((brow, idx) => (
                                                      <TableRow
                                                        key={`${brow.label}-${idx}`}
                                                        className={brow.status === "violacao" ? "bg-red-50/70 dark:bg-red-950/20" : ""}
                                                      >
                                                        <TableCell className="text-center">
                                                          <Badge variant="outline" className="text-[9px]">
                                                            {brow.origem === "estoque" ? "Estoque" : brow.origem === "csv" ? "CSV" : "Pró-forma"}
                                                          </Badge>
                                                        </TableCell>
                                                        <TableCell className="font-mono text-[10px]">{brow.documento || brow.label}</TableCell>
                                                        <TableCell className="text-[11px]">{brow.cedente || "—"}</TableCell>
                                                        <TableCell className="text-[11px]">{brow.sacado || "—"}</TableCell>
                                                        <TableCell className="text-[11px]">{brow.dt_vencimento || "—"}</TableCell>
                                                        <TableCell className="text-right tabular-nums text-[11px]">
                                                          {brow.total_aquisicao != null
                                                            ? brow.total_aquisicao.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                                                            : "—"}
                                                        </TableCell>
                                                        <TableCell className="text-center">
                                                          {brow.status === "ok"
                                                            ? <CheckCircle2 className="w-4 h-4 text-emerald-600 mx-auto" />
                                                            : <XCircle className="w-4 h-4 text-red-600 mx-auto" />}
                                                        </TableCell>
                                                      </TableRow>
                                                    ))}
                                                  </TableBody>
                                                </Table>
                                              </div>
                                            </div>
                                          )}

                                          {/* ── Detalhe por origem: estoque e CSV ── */}
                                          {hasDetalhesOrigem && (
                                            <div>
                                              <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-2">
                                                Títulos que compõem o Pró-forma ({rc.detalhes_origem.length})
                                              </p>
                                              <div className="rounded border border-border overflow-hidden">
                                                <Table>
                                                  <TableHeader className="bg-muted/40">
                                                    <TableRow>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[70px]">Origem</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase">Documento</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase">Cedente</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase">Sacado</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[95px]">DT_VENCIMENTO</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[110px] text-right">TOTAL_AQUISICAO</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[90px] text-right">Valor</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[60px] text-right">Prazo</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[70px] text-center">Coob.</TableHead>
                                                    </TableRow>
                                                  </TableHeader>
                                                  <TableBody>
                                                    {rc.detalhes_origem.map((row, idx) => (
                                                      <TableRow key={`${row.origem}-${row.documento}-${idx}`}>
                                                        <TableCell className="text-center">
                                                          <Badge variant="outline" className="text-[9px]">
                                                            {row.origem === "estoque" ? "Estoque" : row.origem === "csv" ? "CSV" : "Pró-forma"}
                                                          </Badge>
                                                        </TableCell>
                                                        <TableCell className="font-mono text-[10px]">{row.documento || row.label || "—"}</TableCell>
                                                        <TableCell className="text-[11px]">{row.cedente || "—"}</TableCell>
                                                        <TableCell className="text-[11px]">{row.sacado || "—"}</TableCell>
                                                        <TableCell className="text-[11px]">{row.dt_vencimento || "—"}</TableCell>
                                                        <TableCell className="text-right tabular-nums text-[11px]">
                                                          {row.total_aquisicao != null
                                                            ? row.total_aquisicao.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                                                            : "—"}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums text-[11px]">
                                                          {row.valor_rs != null ? row.valor_rs.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
                                                        </TableCell>
                                                        <TableCell className="text-right text-[11px]">{row.prazo != null ? `${row.prazo} du` : "—"}</TableCell>
                                                        <TableCell className="text-center text-[11px]">{row.coobrigacao ?? "—"}</TableCell>
                                                      </TableRow>
                                                    ))}
                                                  </TableBody>
                                                </Table>
                                              </div>
                                            </div>
                                          )}

                                          {/* ── Detalhes de DCs que violaram (complementar) ── */}
                                          {hasViolationDcs && (
                                            <div>
                                              <p className="text-[10px] font-semibold text-red-700 uppercase mb-2">
                                                DCs com violação — detalhe ({rc.detalhes_dcs.length})
                                              </p>
                                              <div className="rounded border border-border overflow-hidden">
                                                <Table>
                                                  <TableHeader className="bg-muted/40">
                                                    <TableRow>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[70px]">Origem</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase">Nº Documento</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase">Cedente</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase">Sacado</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[110px]">Valor Pago</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[70px]">Prazo</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[140px]">Valor Atual</TableHead>
                                                      <TableHead className="text-[9px] font-bold uppercase w-[140px]">Limite</TableHead>
                                                    </TableRow>
                                                  </TableHeader>
                                                  <TableBody>
                                                    {rc.detalhes_dcs.map((dc, idx) => (
                                                      <TableRow key={`${dc.ds_seu_numero}-${idx}`} className="text-[11px] bg-red-50/40">
                                                        <TableCell className="text-center">
                                                          <Badge variant="outline" className="text-[9px]">CSV</Badge>
                                                        </TableCell>
                                                        <TableCell className="font-mono text-[10px]">{dc.ds_seu_numero}</TableCell>
                                                        <TableCell>{dc.nm_cedente || "—"}</TableCell>
                                                        <TableCell>{dc.nm_sacado || "—"}</TableCell>
                                                        <TableCell className="text-right tabular-nums">
                                                          {dc.vl_pago?.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? "—"}
                                                        </TableCell>
                                                        <TableCell className="text-right">{dc.prazo} du</TableCell>
                                                        <TableCell><span className="text-[10px] text-red-700">{dc.valor_atual != null ? String(dc.valor_atual) : "—"}</span></TableCell>
                                                        <TableCell><span className="text-[10px]">{dc.valor_limite != null ? String(dc.valor_limite) : "—"}</span></TableCell>
                                                      </TableRow>
                                                    ))}
                                                  </TableBody>
                                                </Table>
                                              </div>
                                            </div>
                                          )}

                                        </div>
                                      </TableCell>
                                    </TableRow>
                                  )}
                                </Fragment>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {r.regras_aplicadas === 0 && (
                  <Card className="border-amber-300">
                    <CardContent className="pt-6">
                      <div className="flex items-center gap-2 text-amber-700">
                        <AlertTriangle className="w-5 h-5" />
                        <div>
                          <p className="font-medium">Nenhuma regra configurada para este fundo</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {r.fundo_isin_resolvido ? (
                              <>Subclasse identificada: <span className="font-mono">{r.fundo_isin_resolvido}</span>. </>
                            ) : (
                              <>Não foi possível identificar a subclasse (ISIN) pelo nome do fundo no CSV. </>
                            )}
                            Associe <strong>CESSAO_CADASTRO_PARTES</strong>, <strong>CESSAO_CONDICAO</strong> ou <strong>CONCENTRACAO_*</strong> em{" "}
                            <a href="/regras-relacionais" className="underline text-primary">Regras Relacionais</a>.
                            Cadastro de cedentes/limites:{" "}
                            <a href="/credito/cadastro-partes" className="underline text-primary">Cadastro Partes</a>
                            {r.fundo_isin_resolvido
                              ? " para esta subclasse ou com opção \"todas subclasses\" (ISIN vazio)."
                              : ", preferencialmente com \"todas subclasses\" ou ISIN correto."}
                            {" "}Cadastro em{" "}
                            <a href="/regras" className="underline text-primary">Regras de Compliance</a>.
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Tabela de Resultados */}
                {r.resultados && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">
                        Detalhamento por DC ({r.resultados.length})
                        {recomp && recomp.total > 0 && (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            — {r.resultados.length - recomp.total} aquisições + {recomp.total} recompras
                          </span>
                        )}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ScrollArea className="h-[400px] rounded-md border">
                        <Table>
                          <TableHeader className="sticky top-0 z-10 bg-muted/95">
                            <TableRow>
                              <TableHead className="w-[30px]"></TableHead>
                              <TableHead className="text-[10px] font-bold">Nº Documento</TableHead>
                              <TableHead className="text-[10px] font-bold">Cedente</TableHead>
                              <TableHead className="text-[10px] font-bold">Sacado</TableHead>
                              <TableHead className="text-right text-[10px] font-bold">Valor</TableHead>
                              <TableHead className="text-right text-[10px] font-bold">Prazo</TableHead>
                              <TableHead className="text-[10px] font-bold text-center">Origem</TableHead>
                              <TableHead className="text-[10px] font-bold text-center">Coob.</TableHead>
                              <TableHead className="text-[10px] font-bold">Elegível</TableHead>
                              <TableHead className="text-[10px] font-bold">Enquadra</TableHead>
                              <TableHead className="text-[10px] font-bold">Motivos</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {r.resultados.map((dc, idx) => {
                              const isRecompraRow = dc.tipo_operacao === "RECOMPRA";
                              const recompraAvaliada = isRecompraRow && dc.elegivel !== null;
                              const docCedente = (dc.cpf_cnpj_cedente ?? "").replace(/\D/g, "");
                              const temCoob = r.coobrigacao_cedentes
                                ? (r.coobrigacao_cedentes[docCedente] ?? true)
                                : true;
                              return (
                              <Fragment key={idx}>
                                <TableRow
                                  className={`hover:bg-muted/50 ${isRecompraRow ? "bg-slate-50/60 dark:bg-slate-900/20" : "cursor-pointer"} ${recompraAvaliada ? "cursor-pointer" : ""}`}
                                  onClick={() => (!isRecompraRow || recompraAvaliada) && setExpandedDc(expandedDc === dc.ds_seu_numero ? null : dc.ds_seu_numero)}
                                >
                                  <TableCell className="py-1">
                                    {((!isRecompraRow || recompraAvaliada) && dc.motivos.length > 0) ? (
                                      expandedDc === dc.ds_seu_numero
                                        ? <ChevronDown className="w-3.5 h-3.5" />
                                        : <ChevronRight className="w-3.5 h-3.5" />
                                    ) : null}
                                  </TableCell>
                                  <TableCell className="text-[11px] py-1 font-mono">{dc.ds_seu_numero}</TableCell>
                                  <TableCell className="text-[11px] py-1 max-w-[140px] truncate">{dc.nm_cedente || "—"}</TableCell>
                                  <TableCell className="text-[11px] py-1 max-w-[140px] truncate">{dc.nm_sacado}</TableCell>
                                  <TableCell className="text-[11px] py-1 text-right">{formatBRL(dc.vl_pago)}</TableCell>
                                  <TableCell className="text-[11px] py-1 text-right">{dc.prazo}d</TableCell>
                                  <TableCell className="py-1 text-center">
                                    {isRecompraRow
                                      ? <Badge variant="secondary" className="text-[9px] text-slate-500 border-slate-300">RECOMPRA</Badge>
                                      : <Badge variant="outline" className="text-[9px]">CSV</Badge>
                                    }
                                  </TableCell>
                                  <TableCell className="py-1 text-center">
                                    {isRecompraRow
                                      ? <span className="text-[10px] text-muted-foreground">—</span>
                                      : (
                                        <Badge
                                          variant={temCoob ? "secondary" : "outline"}
                                          className={`text-[9px] font-bold ${temCoob ? "text-emerald-700 border-emerald-300" : "text-red-600 border-red-300"}`}
                                        >
                                          {temCoob ? "S" : "N"}
                                        </Badge>
                                      )
                                    }
                                  </TableCell>
                                  <TableCell className="py-1">
                                    {isRecompraRow && !recompraAvaliada
                                      ? <span className="text-[10px] text-muted-foreground">—</span>
                                      : dc.elegivel
                                        ? <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                                        : <XCircle className="w-4 h-4 text-red-500" />
                                    }
                                  </TableCell>
                                  <TableCell className="py-1">
                                    {isRecompraRow && !recompraAvaliada
                                      ? <span className="text-[10px] text-muted-foreground">—</span>
                                      : dc.enquadra
                                        ? <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                                        : dc.elegivel
                                          ? <XCircle className="w-4 h-4 text-amber-500" />
                                          : <span className="text-[10px] text-muted-foreground">—</span>
                                    }
                                  </TableCell>
                                  <TableCell className="text-[11px] py-1 text-muted-foreground">
                                    {isRecompraRow && !recompraAvaliada
                                      ? <span className="text-slate-400">recompra</span>
                                      : dc.motivos.length > 0 ? `${dc.motivos.length} regra(s)` : "—"}
                                  </TableCell>
                                </TableRow>
                                {expandedDc === dc.ds_seu_numero && dc.motivos.length > 0 && (
                                  <TableRow>
                                    <TableCell colSpan={11} className="bg-red-50/50 py-2 px-8">
                                      <div className="space-y-1">
                                        {dc.motivos.map((m, mi) => (
                                          <div key={mi} className="flex items-center gap-2 text-[11px]">
                                            <XCircle className="w-3 h-3 text-red-500 shrink-0" />
                                            <span className="font-medium text-red-700">{m.regra_codigo}:</span>
                                            <span className="text-muted-foreground">{m.regra_descricao}</span>
                                            <span className="text-red-600 font-mono">atual={String(m.valor_atual)} / limite={String(m.valor_limite)}</span>
                                          </div>
                                        ))}
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
                )}
              </>
            )}

            {r && !r.success && (
              <Card className="border-red-300">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2 text-red-600">
                    <XCircle className="w-5 h-5" />
                    <span className="font-medium">Erro: {r.error}</span>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ══════════════ TAB HISTÓRICO ══════════════ */}
          <TabsContent value="historico" className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <CardTitle className="text-sm">Histórico de Validações</CardTitle>
                    <CardDescription className="text-xs">{historico.length} registros — evidência para auditoria</CardDescription>
                  </div>
                  {historico.length > 0 && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-xs border-[#003D27] text-[#003D27] hover:bg-[#003D27]/5"
                        onClick={handleExportHistoricoPDF}
                        disabled={exportingPdf}
                      >
                        {exportingPdf ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
                        PDF
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-xs border-[#003D27] text-[#003D27] hover:bg-[#003D27]/5"
                        onClick={handleExportHistoricoExcel}
                        disabled={exportingXlsx}
                      >
                        {exportingXlsx ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
                        Excel
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {historico.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">Nenhuma validação realizada ainda.</p>
                ) : (
                  <ScrollArea className="h-[500px] rounded-md border">
                    <Table>
                      <TableHeader className="sticky top-0 z-10 bg-muted/95">
                        <TableRow>
                          <TableHead className="text-[10px] font-bold">Data</TableHead>
                          <TableHead className="text-[10px] font-bold">Fundo</TableHead>
                          <TableHead className="text-[10px] font-bold">Arquivo</TableHead>
                          <TableHead className="text-right text-[10px] font-bold">Total DCs</TableHead>
                          <TableHead className="text-right text-[10px] font-bold">Elegíveis</TableHead>
                          <TableHead className="text-right text-[10px] font-bold">Enquadram</TableHead>
                          <TableHead className="text-right text-[10px] font-bold">Desenquad.</TableHead>
                          <TableHead className="text-right text-[10px] font-bold">VP Proposto</TableHead>
                          <TableHead className="text-[10px] font-bold">Status</TableHead>
                          <TableHead className="w-[40px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {historico.map((h: any) => {
                          const isExportingThis = exportingItemId === h.id;
                          return (
                          <TableRow key={h.id}>
                            <TableCell className="text-[11px] py-1.5">{new Date(h.created_at).toLocaleDateString("pt-BR")}</TableCell>
                            <TableCell className="text-[11px] py-1.5 max-w-[200px] truncate">{h.fundo_nome || fmtCnpj(h.fundo_cnpj)}</TableCell>
                            <TableCell className="text-[11px] py-1.5 max-w-[150px] truncate">{h.filename || "—"}</TableCell>
                            <TableCell className="text-[11px] py-1.5 text-right">{h.total_dcs}</TableCell>
                            <TableCell className="text-[11px] py-1.5 text-right font-medium text-emerald-600">{h.elegiveis}</TableCell>
                            <TableCell className="text-[11px] py-1.5 text-right font-medium text-emerald-600">{h.enquadram ?? h.elegiveis}</TableCell>
                            <TableCell className="text-[11px] py-1.5 text-right font-medium text-red-600">{h.desenquadram ?? 0}</TableCell>
                            <TableCell className="text-[11px] py-1.5 text-right">{formatBRL(Number(h.vp_total_proposto) || 0)}</TableCell>
                            <TableCell className="py-1.5">
                              <Badge variant={h.status === "success" ? "default" : "destructive"} className="text-[9px]">
                                {h.status === "success" ? "OK" : h.status}
                              </Badge>
                            </TableCell>
                            <TableCell className="py-1.5 pr-2">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-muted-foreground hover:text-[#003D27] hover:bg-[#003D27]/8"
                                    disabled={isExportingThis}
                                    title="Exportar operação"
                                  >
                                    {isExportingThis
                                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      : <FileDown className="w-3.5 h-3.5" />
                                    }
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-40">
                                  <DropdownMenuItem
                                    className="gap-2 text-xs cursor-pointer"
                                    onClick={() => handleExportItemPDF(h as Record<string, unknown>)}
                                  >
                                    <FileText className="w-3.5 h-3.5 text-red-600 shrink-0" />
                                    Exportar PDF
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    className="gap-2 text-xs cursor-pointer"
                                    onClick={() => handleExportItemExcel(h as Record<string, unknown>)}
                                  >
                                    <Sheet className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
                                    Exportar Excel
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableCell>
                          </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
}

function KpiRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="py-0.5">
      <div className="flex justify-between items-center">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-sm font-semibold">{value}</span>
      </div>
      {hint && (
        <p className="text-[10px] text-muted-foreground/80 text-right mt-0.5">{hint}</p>
      )}
    </div>
  );
}
