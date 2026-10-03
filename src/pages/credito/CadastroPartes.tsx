import { useState, useRef, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2, FileUp, Users, AlertTriangle, CheckCircle2, Upload, History, Copy,
  ArrowUpDown, ArrowUp, ArrowDown, Pencil, Check, X,
} from "lucide-react";
import {
  formatBRL, cleanDoc, isValidCnpj, normalizeDoc,
  type LinhaImportPreview, type CadastroParteRow,
} from "@/lib/cadastroPartes";
import type { LinhaPropagacaoSugerida } from "@/lib/cadastroPartesPropagar";
import { buildExposicaoLimitePayload, type ExposicaoLimitePayload } from "@/lib/cadastroPartesExposicao";
import { ExposicaoLimiteTab } from "@/components/credito/ExposicaoLimiteTab";
import { AlertasCadastroTab } from "@/components/credito/AlertasCadastroTab";
import { cn } from "@/lib/utils";

async function invokeMultipart(
  name: string,
  formData: FormData,
): Promise<{ data: Record<string, unknown> | null; error: Error | null }> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  const sessionRes = await supabase.auth.getSession();
  const token = sessionRes.data.session?.access_token ?? anonKey;
  const resp = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
    body: formData,
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      msg = (j?.error as string) ?? msg;
    } catch { /* ignore */ }
    return { data: null, error: new Error(msg) };
  }
  return { data: await resp.json(), error: null };
}

interface FundoOpt {
  cnpj: string;
  nome: string;
}

interface ParteRow {
  id: string;
  fundo_cnpj: string;
  fundo_isin?: string;
  tipo_parte?: string;
  doc_cnpj_cpf: string;
  nome: string | null;
  escopo_limite: string;
  grupo_chave: string | null;
  limite_operacao: number | null;
  dt_validade: string | null;
  dt_analise: string | null;
  consultoria: string | null;
  status: string;
  observacoes: string | null;
  vigente: boolean;
  created_at: string;
}

type ParteSortKey = "nome" | "cnpj" | "limite" | "validade" | "dias" | "escopo" | "status";

interface ImportRow {
  id: string;
  fundo_cnpj: string;
  filename: string | null;
  data_base: string | null;
  consultoria: string | null;
  total_linhas: number;
  aceitas: number;
  rejeitadas: number;
  avisos: unknown[];
  created_at: string;
}

function formatCnpj(cnpj: string): string {
  const d = cnpj.replace(/\D/g, "");
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  return cnpj;
}

function diasAteValidade(dt: string | null): number | null {
  if (!dt) return null;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const alvo = new Date(dt + "T00:00:00");
  return Math.round((alvo.getTime() - hoje.getTime()) / 86400000);
}

type KpiFiltro = "vigentes" | "vence30" | "vencidos" | "pendente" | "total";

const KPI_LABELS: Record<KpiFiltro, string> = {
  vigentes: "Partes vigentes",
  vence30: "Vencem em até 30 dias",
  vencidos: "Cadastro vencido",
  pendente: "Revisão pendente",
  total: "Total cadastrados",
};

function classificarParte(p: ParteRow): Exclude<KpiFiltro, "total"> {
  if (!p.dt_validade) return "pendente";
  const dias = diasAteValidade(p.dt_validade);
  if (dias != null && dias < 0) return "vencidos";
  if (dias != null && dias <= 30) return "vence30";
  return "vigentes";
}

function filtrarPartesPorKpi(partes: ParteRow[], filtro: KpiFiltro): ParteRow[] {
  if (filtro === "total") return partes;
  return partes.filter((p) => classificarParte(p) === filtro);
}

function filtrarPartesPorBusca(partes: ParteRow[], busca: string): ParteRow[] {
  const q = busca.trim().toLowerCase();
  if (!q) return partes;
  const qDigits = q.replace(/\D/g, "");
  return partes.filter((p) => {
    if ((p.nome ?? "").toLowerCase().includes(q)) return true;
    if (qDigits.length > 0 && p.doc_cnpj_cpf.includes(qDigits)) return true;
    if (p.escopo_limite === "grupo" && (p.grupo_chave ?? "").toLowerCase().includes(q)) return true;
    return false;
  });
}

function statusOrdemParte(p: ParteRow): number {
  if (p.status !== "ativo") return 0;
  const dias = diasAteValidade(p.dt_validade);
  if (dias == null) return 1;
  if (dias < 0) return 2;
  if (dias <= 30) return 3;
  return 4;
}

function comparePartes(a: ParteRow, b: ParteRow, key: ParteSortKey, dir: "asc" | "desc"): number {
  const mul = dir === "asc" ? 1 : -1;
  let cmp = 0;

  switch (key) {
    case "nome":
      cmp = (a.nome ?? "").localeCompare(b.nome ?? "", "pt-BR");
      break;
    case "cnpj":
      cmp = a.doc_cnpj_cpf.localeCompare(b.doc_cnpj_cpf);
      break;
    case "limite":
      cmp = (a.limite_operacao ?? -1) - (b.limite_operacao ?? -1);
      break;
    case "validade": {
      const da = a.dt_validade ?? "";
      const db = b.dt_validade ?? "";
      if (!da && db) cmp = 1;
      else if (da && !db) cmp = -1;
      else cmp = da.localeCompare(db);
      break;
    }
    case "dias":
      cmp = (diasAteValidade(a.dt_validade) ?? -9999) - (diasAteValidade(b.dt_validade) ?? -9999);
      break;
    case "escopo": {
      const ea = a.escopo_limite === "grupo" ? `grupo ${a.grupo_chave ?? ""}` : "individual";
      const eb = b.escopo_limite === "grupo" ? `grupo ${b.grupo_chave ?? ""}` : "individual";
      cmp = ea.localeCompare(eb, "pt-BR");
      break;
    }
    case "status":
      cmp = statusOrdemParte(a) - statusOrdemParte(b);
      break;
  }

  return cmp * mul;
}

function ordenarPartes(partes: ParteRow[], sortKey: ParteSortKey, sortDir: "asc" | "desc"): ParteRow[] {
  return [...partes].sort((a, b) => comparePartes(a, b, sortKey, sortDir));
}

function SortHeaderIcon({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return <ArrowUpDown className="h-3 w-3 opacity-40 shrink-0" />;
  return dir === "asc"
    ? <ArrowUp className="h-3 w-3 shrink-0" />
    : <ArrowDown className="h-3 w-3 shrink-0" />;
}

interface ParteEditDraft {
  nome: string;
  doc_cnpj_cpf: string;
  limite_operacao: string;
  dt_validade: string;
  escopo_limite: "individual" | "grupo";
  grupo_chave: string;
  status: "ativo" | "suspenso" | "encerrado";
}

function parteToDraft(p: ParteRow): ParteEditDraft {
  return {
    nome: p.nome ?? "",
    doc_cnpj_cpf: p.doc_cnpj_cpf,
    limite_operacao: p.limite_operacao != null ? String(p.limite_operacao) : "",
    dt_validade: p.dt_validade ?? "",
    escopo_limite: p.escopo_limite === "grupo" ? "grupo" : "individual",
    grupo_chave: p.grupo_chave ?? "",
    status: (p.status === "suspenso" || p.status === "encerrado" ? p.status : "ativo"),
  };
}

interface PartesTableProps {
  rows: ParteRow[];
  sortKey: ParteSortKey;
  sortDir: "asc" | "desc";
  onSort: (key: ParteSortKey) => void;
  editingId?: string | null;
  editDraft?: ParteEditDraft | null;
  savingId?: string | null;
  onStartEdit?: (parte: ParteRow) => void;
  onCancelEdit?: () => void;
  onSaveEdit?: (parte: ParteRow) => void;
  onDraftChange?: (patch: Partial<ParteEditDraft>) => void;
}

function PartesTable({
  rows,
  sortKey,
  sortDir,
  onSort,
  editingId = null,
  editDraft = null,
  savingId = null,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDraftChange,
}: PartesTableProps) {
  const SortTh = ({
    label,
    field,
    className,
    align = "left",
  }: {
    label: string;
    field: ParteSortKey;
    className?: string;
    align?: "left" | "right" | "center";
  }) => (
    <TableHead className={cn("text-xs font-bold uppercase p-0", className)}>
      <button
        type="button"
        className={cn(
          "flex items-center gap-1 w-full px-2 py-2.5 hover:bg-muted/80 transition-colors",
          align === "right" && "justify-end",
          align === "center" && "justify-center",
        )}
        onClick={() => onSort(field)}
      >
        <span>{label}</span>
        <SortHeaderIcon active={sortKey === field} dir={sortDir} />
      </button>
    </TableHead>
  );

  return (
    <Table>
      <TableHeader className="bg-muted/60 sticky top-0 z-10">
        <TableRow>
          <SortTh label="Empresa" field="nome" className="min-w-[200px]" />
          <SortTh label="CNPJ" field="cnpj" className="min-w-[150px]" />
          <SortTh label="Limite R$" field="limite" className="min-w-[120px] text-right" align="right" />
          <SortTh label="Validade" field="validade" className="min-w-[140px]" />
          <SortTh label="Dias" field="dias" className="min-w-[70px]" align="center" />
          <SortTh label="Escopo" field="escopo" className="min-w-[100px]" />
          <SortTh label="Status" field="status" className="min-w-[130px] whitespace-nowrap" />
          {onStartEdit && <TableHead className="text-xs font-bold uppercase min-w-[80px] text-center">Ações</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((p) => {
          const editing = editingId === p.id && editDraft != null;
          const dias = editing
            ? diasAteValidade(editDraft.dt_validade || null)
            : diasAteValidade(p.dt_validade);
          const saving = savingId === p.id;

          return (
            <TableRow key={p.id} className={cn(editing && "bg-muted/30")}>
              <TableCell className="font-medium text-sm max-w-[280px]">
                {editing ? (
                  <Input
                    className="h-8 text-sm"
                    value={editDraft.nome}
                    onChange={(e) => onDraftChange?.({ nome: e.target.value })}
                    placeholder="Razão social"
                  />
                ) : (
                  <span className="truncate block" title={p.nome ?? ""}>{p.nome ?? "—"}</span>
                )}
              </TableCell>
              <TableCell className="font-mono text-xs whitespace-nowrap">
                {editing ? (
                  <Input
                    className="h-8 text-xs font-mono min-w-[150px]"
                    value={formatCnpj(editDraft.doc_cnpj_cpf)}
                    onChange={(e) => onDraftChange?.({ doc_cnpj_cpf: cleanDoc(e.target.value) })}
                    placeholder="00.000.000/0000-00"
                  />
                ) : (
                  formatCnpj(p.doc_cnpj_cpf)
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums text-sm whitespace-nowrap">
                {editing ? (
                  <Input
                    className="h-8 text-sm text-right tabular-nums min-w-[120px]"
                    type="number"
                    min={0}
                    step={0.01}
                    value={editDraft.limite_operacao}
                    onChange={(e) => onDraftChange?.({ limite_operacao: e.target.value })}
                    placeholder="0,00"
                  />
                ) : (
                  p.limite_operacao != null ? formatBRL(p.limite_operacao) : "—"
                )}
              </TableCell>
              <TableCell className="text-sm whitespace-nowrap">
                {editing ? (
                  <Input
                    className="h-8 text-sm min-w-[140px]"
                    type="date"
                    value={editDraft.dt_validade}
                    onChange={(e) => onDraftChange?.({ dt_validade: e.target.value })}
                  />
                ) : (
                  p.dt_validade
                    ? new Date(p.dt_validade + "T12:00:00").toLocaleDateString("pt-BR")
                    : "pendente"
                )}
              </TableCell>
              <TableCell className={cn("text-center tabular-nums text-sm", dias != null && dias < 0 && "text-red-600 font-semibold")}>
                {dias ?? "—"}
              </TableCell>
              <TableCell className="text-xs whitespace-nowrap">
                {editing ? (
                  <div className="flex flex-col gap-1">
                    <Select
                      value={editDraft.escopo_limite}
                      onValueChange={(v) => onDraftChange?.({
                        escopo_limite: v as "individual" | "grupo",
                        grupo_chave: v === "individual" ? "" : editDraft.grupo_chave,
                      })}
                    >
                      <SelectTrigger className="h-8 w-[112px] text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="individual">Individual</SelectItem>
                        <SelectItem value="grupo">Grupo</SelectItem>
                      </SelectContent>
                    </Select>
                    {editDraft.escopo_limite === "grupo" && (
                      <Input
                        className="h-8 text-xs min-w-[120px]"
                        placeholder="GRUPO_X"
                        value={editDraft.grupo_chave}
                        onChange={(e) => onDraftChange?.({ grupo_chave: e.target.value })}
                      />
                    )}
                  </div>
                ) : (
                  p.escopo_limite === "grupo" ? `Grupo ${p.grupo_chave}` : "Individual"
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {editing ? (
                  <Select
                    value={editDraft.status}
                    onValueChange={(v) => onDraftChange?.({ status: v as ParteEditDraft["status"] })}
                  >
                    <SelectTrigger className="h-8 w-[120px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ativo">Ativo</SelectItem>
                      <SelectItem value="suspenso">Suspenso</SelectItem>
                      <SelectItem value="encerrado">Encerrado</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  statusBadge(p, dias)
                )}
              </TableCell>
              {onStartEdit && (
                <TableCell className="text-center whitespace-nowrap">
                  {editing ? (
                    <div className="flex items-center justify-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-emerald-700 hover:text-emerald-800"
                        title="Salvar"
                        disabled={saving}
                        onClick={() => onSaveEdit?.(p)}
                      >
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-red-600"
                        title="Cancelar"
                        disabled={saving}
                        onClick={onCancelEdit}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-[#003D27]"
                      title="Editar parte"
                      disabled={editingId != null}
                      onClick={() => onStartEdit(p)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function statusBadge(parte: ParteRow, dias: number | null) {
  if (parte.status !== "ativo") {
    return <Badge variant="destructive">{parte.status}</Badge>;
  }
  if (dias == null) return <Badge className="bg-amber-500 hover:bg-amber-500">Revisão pendente</Badge>;
  if (dias < 0) return <Badge className="bg-amber-600 hover:bg-amber-600">Cad. vencido</Badge>;
  if (dias <= 30) return <Badge className="bg-amber-500 hover:bg-amber-500">Vence ≤30d</Badge>;
  return <Badge className="bg-emerald-600 hover:bg-emerald-600">OK</Badge>;
}

export default function CadastroPartes() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [fundoCnpj, setFundoCnpj] = useState("");
  const [busca, setBusca] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [previewLinhas, setPreviewLinhas] = useState<LinhaImportPreview[]>([]);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [propagarOpen, setPropagarOpen] = useState(false);
  const [propagarLoading, setPropagarLoading] = useState(false);
  const [fundoOrigemCnpj, setFundoOrigemCnpj] = useState("");
  const [propagarLinhas, setPropagarLinhas] = useState<LinhaPropagacaoSugerida[]>([]);
  const [propagarJaCadastradas, setPropagarJaCadastradas] = useState<{ doc_cnpj_cpf: string; nome: string | null }[]>([]);
  const [propagarMeta, setPropagarMeta] = useState<{ estoque_ref?: string; total_estoque?: number } | null>(null);
  const [kpiDialogOpen, setKpiDialogOpen] = useState(false);
  const [kpiFiltro, setKpiFiltro] = useState<KpiFiltro>("total");
  const [buscaKpi, setBuscaKpi] = useState("");
  const [vpLiquido, setVpLiquido] = useState(true);
  const [parteSortKey, setParteSortKey] = useState<ParteSortKey>("nome");
  const [parteSortDir, setParteSortDir] = useState<"asc" | "desc">("asc");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ParteEditDraft | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const { data: fundos = [], isLoading: loadingFundos, isError: erroFundos } = useQuery<FundoOpt[]>({
    queryKey: ["cadastro-partes-fundos"],
    queryFn: async () => {
      const seen = new Map<string, string>();

      const add = (cnpjRaw: string | null | undefined, nomeRaw: string | null | undefined) => {
        const cnpj = String(cnpjRaw ?? "").replace(/\D/g, "");
        if (cnpj.length !== 14) return;
        const nome = String(nomeRaw ?? "").trim() || formatCnpj(cnpj);
        if (!seen.has(cnpj)) seen.set(cnpj, nome);
      };

      // 1) FIDCs com estoque importado (fonte principal do módulo de crédito)
      const { data: estoqueImports, error: estoqueErr } = await supabase
        .from("importacoes_estoque_fidc")
        .select("fund_document, fund_name")
        .in("status", ["success", "partial_success"])
        .order("reference_date", { ascending: false })
        .limit(200);
      if (estoqueErr) console.warn("[cadastro-partes] estoque imports:", estoqueErr.message);
      for (const r of estoqueImports ?? []) {
        add(r.fund_document, r.fund_name);
      }

      // 2) Fundos já com cadastro de partes importado
      const { data: cadastroImports, error: cadErr } = await supabase
        .from("cadastro_partes_importacoes")
        .select("fundo_cnpj")
        .order("created_at", { ascending: false })
        .limit(100);
      if (!cadErr) {
        for (const r of cadastroImports ?? []) add(r.fundo_cnpj, null);
      }

      // 3) RPC padrão do projeto (regras / posição)
      if (seen.size === 0) {
        const { data: rpcFundos, error: rpcErr } = await supabase.rpc("get_fundos_para_regras");
        if (rpcErr) console.warn("[cadastro-partes] get_fundos_para_regras:", rpcErr.message);
        for (const r of (rpcFundos ?? []) as { fundo_cnpj: string; fundo_nome?: string }[]) {
          add(r.fundo_cnpj, r.fundo_nome);
        }
      }

      // 4) Fallback: qualquer fundo em posicao_carteira (sem filtro section=header)
      if (seen.size === 0) {
        const { data: posRows, error: posErr } = await supabase
          .from("posicao_carteira")
          .select("fundo_cnpj, nome_fundo, fundo_nome")
          .order("fundo_dtposicao", { ascending: false })
          .limit(500);
        if (posErr) throw posErr;
        for (const r of posRows ?? []) {
          add(r.fundo_cnpj, r.nome_fundo ?? r.fundo_nome);
        }
      }

      return Array.from(seen.entries())
        .map(([cnpj, nome]) => ({ cnpj, nome }))
        .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    },
  });

  const cnpjSel = fundoCnpj.replace(/\D/g, "");

  const { data: partes = [], isLoading: loadingPartes } = useQuery<ParteRow[]>({
    queryKey: ["cadastro-partes", cnpjSel],
    enabled: cnpjSel.length === 14,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fidc_cadastro_partes")
        .select("*")
        .eq("fundo_cnpj", cnpjSel)
        .eq("vigente", true)
        .order("nome");
      if (error) throw error;
      return data as ParteRow[];
    },
  });

  const { data: imports = [] } = useQuery<ImportRow[]>({
    queryKey: ["cadastro-partes-imports", cnpjSel],
    enabled: cnpjSel.length === 14,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cadastro_partes_importacoes")
        .select("*")
        .eq("fundo_cnpj", cnpjSel)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data as ImportRow[];
    },
  });

  const ultimoImport = imports[0] ?? null;

  const { data: estoqueCtx, isLoading: loadingEstoque } = useQuery({
    queryKey: ["cadastro-partes-estoque", cnpjSel],
    enabled: cnpjSel.length === 14,
    queryFn: async () => {
      const cnpjNorm = cnpjSel.padStart(14, "0").slice(-14);
      const { data: importsEstoque, error: impErr } = await supabase
        .from("importacoes_estoque_fidc")
        .select("id, reference_date, fund_document")
        .in("status", ["success", "partial_success"])
        .order("reference_date", { ascending: false })
        .limit(80);
      if (impErr) throw impErr;
      const match = (importsEstoque ?? []).find(
        (r) => cleanDoc(r.fund_document) === cnpjNorm,
      );
      if (!match) return { reference_date: null as string | null, rows: [] as Record<string, unknown>[] };

      const { data: estoque, error: estErr } = await supabase
        .from("estoque_fidc")
        .select("doc_cedente, nome_cedente, valor_presente, valor_nominal, valor_pdd, valor_pdd_geral")
        .eq("import_id", match.id)
        .limit(50000);
      if (estErr) throw estErr;
      return {
        reference_date: match.reference_date as string | null,
        rows: estoque ?? [],
      };
    },
  });

  const exposicaoPayload: ExposicaoLimitePayload | null = useMemo(() => {
    if (!estoqueCtx || cnpjSel.length !== 14) return null;
    const partesCadastro: CadastroParteRow[] = partes.map((p) => ({
      fundo_cnpj: p.fundo_cnpj,
      tipo_parte: "cedente" as const,
      doc_cnpj_cpf: p.doc_cnpj_cpf,
      nome: p.nome,
      escopo_limite: (p.escopo_limite as "individual" | "grupo") || "individual",
      grupo_chave: p.grupo_chave,
      limite_operacao: p.limite_operacao,
      dt_analise: p.dt_analise,
      dt_validade: p.dt_validade,
      numero_ata: null,
      consultoria: p.consultoria,
      status: (p.status as CadastroParteRow["status"]) || "ativo",
      observacoes: p.observacoes,
      vigente: p.vigente,
    }));
    const avisos = Array.isArray(ultimoImport?.avisos)
      ? (ultimoImport!.avisos as { linha?: number; campo?: string; problema?: string; valor_original?: string }[])
      : [];
    return buildExposicaoLimitePayload({
      partes: partesCadastro,
      estoqueRows: estoqueCtx.rows,
      reference_date: estoqueCtx.reference_date,
      vp_liquido: vpLiquido,
      importAvisos: avisos,
    });
  }, [estoqueCtx, partes, cnpjSel, vpLiquido, ultimoImport]);

  const semEstoque = cnpjSel.length === 14 && !loadingEstoque && (estoqueCtx?.rows.length ?? 0) === 0;

  const { data: fundosOrigem = [] } = useQuery({
    queryKey: ["cadastro-partes-fundos-origem", cnpjSel, fundos.length],
    enabled: cnpjSel.length === 14 && !loadingFundos && fundos.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fidc_cadastro_partes")
        .select("fundo_cnpj")
        .eq("vigente", true);
      if (error) throw error;
      const counts = new Map<string, number>();
      for (const r of data ?? []) {
        if (r.fundo_cnpj === cnpjSel) continue;
        counts.set(r.fundo_cnpj, (counts.get(r.fundo_cnpj) ?? 0) + 1);
      }
      return fundos
        .filter((f) => counts.has(f.cnpj))
        .map((f) => ({ ...f, qtd: counts.get(f.cnpj) ?? 0 }))
        .sort((a, b) => b.qtd - a.qtd);
    },
  });

  const partesFiltradas = useMemo(
    () => ordenarPartes(filtrarPartesPorBusca(partes, busca), parteSortKey, parteSortDir),
    [partes, busca, parteSortKey, parteSortDir],
  );

  const handleParteSort = useCallback((key: ParteSortKey) => {
    if (parteSortKey === key) {
      setParteSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setParteSortKey(key);
      setParteSortDir(key === "nome" || key === "validade" || key === "cnpj" ? "asc" : "desc");
    }
  }, [parteSortKey]);

  const kpis = useMemo(() => {
    const hoje = new Date().toISOString().slice(0, 10);
    let vencidos = 0;
    let vence30 = 0;
    let pendente = 0;
    let vigentes = 0;
    for (const p of partes) {
      if (!p.dt_validade) { pendente++; continue; }
      const dias = diasAteValidade(p.dt_validade);
      if (dias != null && dias < 0) vencidos++;
      else if (dias != null && dias <= 30) vence30++;
      else vigentes++;
    }
    return { vencidos, vence30, pendente, vigentes, total: partes.length };
  }, [partes]);

  const runDryRun = useCallback(async (file: File) => {
    if (cnpjSel.length !== 14) {
      toast({ variant: "destructive", title: "Selecione um fundo" });
      return;
    }
    setImportLoading(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("fundo_cnpj", cnpjSel);
    fd.append("dry_run", "true");
    const { data, error } = await invokeMultipart("importar-cadastro-partes", fd);
    setImportLoading(false);
    if (error || !data?.success) {
      toast({ variant: "destructive", title: "Erro no preview", description: error?.message ?? String(data?.error) });
      return;
    }
    const preview = data.preview as { linhas: LinhaImportPreview[] };
    setPreviewLinhas(preview.linhas ?? []);
    setImportFile(file);
    setImportOpen(true);
  }, [cnpjSel, toast]);

  const confirmImport = useCallback(async () => {
    if (!importFile || cnpjSel.length !== 14) return;
    setImportLoading(true);
    const fd = new FormData();
    fd.append("file", importFile);
    fd.append("fundo_cnpj", cnpjSel);
    fd.append("dry_run", "false");
    fd.append("linhas_confirmadas", JSON.stringify(previewLinhas.filter((l) => !l.rejeitada)));
    const { data, error } = await invokeMultipart("importar-cadastro-partes", fd);
    setImportLoading(false);
    if (error || !data?.success) {
      toast({ variant: "destructive", title: "Erro na importação", description: error?.message ?? String(data?.error) });
      return;
    }
    toast({ title: "Importação concluída", description: `${data.aceitas} parte(s) cadastrada(s)` });
    setImportOpen(false);
    setPreviewLinhas([]);
    setImportFile(null);
    queryClient.invalidateQueries({ queryKey: ["cadastro-partes", cnpjSel] });
    queryClient.invalidateQueries({ queryKey: ["cadastro-partes-imports", cnpjSel] });
  }, [importFile, cnpjSel, previewLinhas, toast, queryClient]);

  const updateLinhaPreview = (linha: number, patch: Partial<LinhaImportPreview>) => {
    setPreviewLinhas((prev) =>
      prev.map((l) => (l.linha === linha ? { ...l, ...patch } : l)),
    );
  };

  const buscarPropagacao = useCallback(async () => {
    if (cnpjSel.length !== 14 || fundoOrigemCnpj.length !== 14) {
      toast({ variant: "destructive", title: "Selecione o fundo origem" });
      return;
    }
    setPropagarLoading(true);
    const { data, error } = await supabase.functions.invoke("propagar-cadastro-partes", {
      body: {
        fundo_destino_cnpj: cnpjSel,
        fundo_origem_cnpj: fundoOrigemCnpj,
        dry_run: true,
      },
    });
    setPropagarLoading(false);
    if (error || !data?.success) {
      toast({
        variant: "destructive",
        title: "Erro ao buscar sugestões",
        description: error?.message ?? String(data?.error),
      });
      return;
    }
    const preview = data.preview as {
      sugeridas: LinhaPropagacaoSugerida[];
      ja_cadastradas: { doc_cnpj_cpf: string; nome: string | null }[];
      estoque_reference_date?: string;
      total_estoque_cedentes?: number;
    };
    setPropagarLinhas(preview.sugeridas ?? []);
    setPropagarJaCadastradas(preview.ja_cadastradas ?? []);
    setPropagarMeta({
      estoque_ref: preview.estoque_reference_date,
      total_estoque: preview.total_estoque_cedentes,
    });
    if ((preview.sugeridas ?? []).length === 0) {
      toast({
        title: "Nenhuma sugestão",
        description: "Não há cedentes em comum entre o cadastro origem e o estoque deste fundo.",
      });
    }
  }, [cnpjSel, fundoOrigemCnpj, toast]);

  const confirmarPropagacao = useCallback(async () => {
    const selecionadas = propagarLinhas.filter((l) => l.selecionada !== false);
    if (selecionadas.length === 0) {
      toast({ variant: "destructive", title: "Selecione ao menos uma parte" });
      return;
    }
    setPropagarLoading(true);
    const { data, error } = await supabase.functions.invoke("propagar-cadastro-partes", {
      body: {
        fundo_destino_cnpj: cnpjSel,
        fundo_origem_cnpj: fundoOrigemCnpj,
        dry_run: false,
        linhas_confirmadas: selecionadas,
      },
    });
    setPropagarLoading(false);
    if (error || !data?.success) {
      toast({
        variant: "destructive",
        title: "Erro na propagação",
        description: error?.message ?? String(data?.error),
      });
      return;
    }
    toast({
      title: "Cadastro propagado",
      description: `${data.inseridas} parte(s) copiada(s) para este fundo.`,
    });
    setPropagarOpen(false);
    setPropagarLinhas([]);
    setPropagarJaCadastradas([]);
    setPropagarMeta(null);
    queryClient.invalidateQueries({ queryKey: ["cadastro-partes", cnpjSel] });
    queryClient.invalidateQueries({ queryKey: ["cadastro-partes-imports", cnpjSel] });
    queryClient.invalidateQueries({ queryKey: ["cadastro-partes-fundos-origem", cnpjSel] });
  }, [propagarLinhas, cnpjSel, fundoOrigemCnpj, toast, queryClient]);

  const abrirPropagacao = () => {
    setPropagarLinhas([]);
    setPropagarJaCadastradas([]);
    setPropagarMeta(null);
    setFundoOrigemCnpj(fundosOrigem[0]?.cnpj ?? "");
    setPropagarOpen(true);
  };

  const togglePropagacaoLinha = (doc: string, checked: boolean) => {
    setPropagarLinhas((prev) =>
      prev.map((l) => (l.doc_cnpj_cpf === doc ? { ...l, selecionada: checked } : l)),
    );
  };

  const selecionadasPropagacao = propagarLinhas.filter((l) => l.selecionada !== false).length;

  const partesKpiDialog = useMemo(
    () => ordenarPartes(
      filtrarPartesPorBusca(filtrarPartesPorKpi(partes, kpiFiltro), buscaKpi),
      parteSortKey,
      parteSortDir,
    ),
    [partes, kpiFiltro, buscaKpi, parteSortKey, parteSortDir],
  );

  const abrirEditar = useCallback((parte: ParteRow) => {
    setEditingId(parte.id);
    setEditDraft(parteToDraft(parte));
  }, []);

  const cancelarEdicao = useCallback(() => {
    setEditingId(null);
    setEditDraft(null);
  }, []);

  const alterarDraft = useCallback((patch: Partial<ParteEditDraft>) => {
    setEditDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const confirmarEdicaoParte = useCallback(async (parte: ParteRow) => {
    if (!editDraft) return;

    const docNorm = normalizeDoc(editDraft.doc_cnpj_cpf);
    if (!isValidCnpj(docNorm)) {
      toast({ variant: "destructive", title: "CNPJ inválido", description: "Informe um CNPJ válido com 14 dígitos." });
      return;
    }

    const limiteStr = editDraft.limite_operacao.trim();
    let limite: number | null = null;
    if (limiteStr) {
      limite = Number(limiteStr);
      if (!Number.isFinite(limite) || limite < 0) {
        toast({ variant: "destructive", title: "Limite inválido", description: "Informe um valor numérico válido." });
        return;
      }
    }

    if (editDraft.escopo_limite === "grupo" && !editDraft.grupo_chave.trim()) {
      toast({ variant: "destructive", title: "Grupo obrigatório", description: "Informe a chave do grupo econômico." });
      return;
    }

    if (docNorm !== parte.doc_cnpj_cpf) {
      const duplicado = partes.some((p) => p.id !== parte.id && p.doc_cnpj_cpf === docNorm);
      if (duplicado) {
        toast({
          variant: "destructive",
          title: "CNPJ já cadastrado",
          description: "Já existe outra parte vigente com este CNPJ neste fundo.",
        });
        return;
      }
    }

    setSavingId(parte.id);
    try {
      const newId = crypto.randomUUID();
      const hoje = new Date().toISOString().slice(0, 10);
      const nota = `Editado manualmente em ${new Date().toLocaleDateString("pt-BR")}.`;
      const observacoes = parte.observacoes ? `${parte.observacoes}\n${nota}` : nota;

      const { error: updOffError } = await supabase
        .from("fidc_cadastro_partes")
        .update({ vigente: false })
        .eq("id", parte.id);
      if (updOffError) throw updOffError;

      const { error: insError } = await supabase.from("fidc_cadastro_partes").insert({
        id: newId,
        fundo_cnpj: parte.fundo_cnpj,
        fundo_isin: parte.fundo_isin ?? "",
        tipo_parte: parte.tipo_parte ?? "cedente",
        doc_cnpj_cpf: docNorm,
        nome: editDraft.nome.trim() || null,
        escopo_limite: editDraft.escopo_limite,
        grupo_chave: editDraft.escopo_limite === "grupo" ? editDraft.grupo_chave.trim() : null,
        limite_operacao: limite,
        dt_analise: hoje,
        dt_validade: editDraft.dt_validade || null,
        consultoria: parte.consultoria,
        status: editDraft.status,
        observacoes,
        vigente: true,
        import_id: null,
      });
      if (insError) {
        await supabase.from("fidc_cadastro_partes").update({ vigente: true }).eq("id", parte.id);
        throw insError;
      }

      const { error: updLinkError } = await supabase
        .from("fidc_cadastro_partes")
        .update({ substituido_por: newId })
        .eq("id", parte.id);
      if (updLinkError) throw updLinkError;

      toast({
        title: "Cadastro atualizado",
        description: editDraft.nome.trim() || formatCnpj(docNorm),
      });
      setEditingId(null);
      setEditDraft(null);
      queryClient.invalidateQueries({ queryKey: ["cadastro-partes", cnpjSel] });
    } catch (e) {
      const description =
        e instanceof Error
          ? e.message
          : e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e);
      toast({
        variant: "destructive",
        title: "Erro ao salvar",
        description,
      });
    } finally {
      setSavingId(null);
    }
  }, [editDraft, partes, toast, queryClient, cnpjSel]);

  const abrirKpiDialog = (filtro: KpiFiltro) => {
    setKpiFiltro(filtro);
    setBuscaKpi("");
    setKpiDialogOpen(true);
  };

  return (
    <Layout>
      <div className="space-y-6 p-6 max-w-[1600px] mx-auto">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-[#003D27]">Cadastro de Partes</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Cedentes/sacados aprovados em comitê — limites em R$ e validade do cadastro (planilha da consultoria).
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1 min-w-[280px]">
              <Label className="text-xs uppercase font-bold">Fundo</Label>
              <Select value={fundoCnpj} onValueChange={setFundoCnpj} disabled={loadingFundos}>
                <SelectTrigger>
                  <SelectValue placeholder={loadingFundos ? "Carregando fundos…" : fundos.length === 0 ? "Nenhum fundo encontrado" : "Selecione o fundo…"} />
                </SelectTrigger>
                <SelectContent>
                  {fundos.map((f) => (
                    <SelectItem key={f.cnpj} value={f.cnpj}>{f.nome}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {erroFundos && (
                <p className="text-[10px] text-red-600">Erro ao carregar fundos. Verifique conexão com o banco.</p>
              )}
              {!loadingFundos && !erroFundos && fundos.length === 0 && (
                <p className="text-[10px] text-amber-700">
                  Importe o estoque FIDC em Crédito &gt; Estoque ou a posição XML para habilitar a lista.
                </p>
              )}
            </div>
            <Button
              variant="outline"
              disabled={cnpjSel.length !== 14 || propagarLoading || fundosOrigem.length === 0}
              onClick={abrirPropagacao}
              title={fundosOrigem.length === 0 ? "Nenhum outro fundo com cadastro importado" : undefined}
            >
              <Copy className="h-4 w-4 mr-2" />
              Aproveitar de outro fundo
            </Button>
            <Button
              disabled={cnpjSel.length !== 14 || importLoading}
              onClick={() => fileRef.current?.click()}
              className="bg-[#003D27] hover:bg-[#197357]"
            >
              {importLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
              Importar planilha
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) runDryRun(f);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        {ultimoImport && (
          <p className="text-xs text-muted-foreground">
            Último import: {new Date(ultimoImport.created_at).toLocaleString("pt-BR")}
            {ultimoImport.consultoria ? ` · ${ultimoImport.consultoria}` : ""}
            {ultimoImport.filename ? ` · ${ultimoImport.filename}` : ""}
          </p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {([
            { key: "vigentes" as const, label: "Vigentes", value: kpis.vigentes, icon: CheckCircle2, color: "text-emerald-700" },
            { key: "vence30" as const, label: "Vencem ≤30d", value: kpis.vence30, icon: AlertTriangle, color: "text-amber-600" },
            { key: "vencidos" as const, label: "Vencidos", value: kpis.vencidos, icon: AlertTriangle, color: "text-red-600" },
            { key: "pendente" as const, label: "Revisão pendente", value: kpis.pendente, icon: AlertTriangle, color: "text-amber-600" },
            { key: "total" as const, label: "Total cadastrados", value: kpis.total, icon: Users, color: "text-[#003D27]" },
          ]).map((k) => (
            <Card
              key={k.key}
              className={cn(
                "cursor-pointer transition-colors hover:bg-muted/40 hover:border-[#003D27]/30",
                cnpjSel.length === 14 && k.value > 0 && "hover:shadow-sm",
              )}
              onClick={() => cnpjSel.length === 14 && abrirKpiDialog(k.key)}
            >
              <CardContent className="pt-4 pb-3 flex items-center gap-3">
                <k.icon className={cn("h-5 w-5", k.color)} />
                <div>
                  <p className="text-[10px] uppercase text-muted-foreground">{k.label}</p>
                  <p className={cn("text-xl font-bold tabular-nums", k.color)}>{k.value}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Tabs defaultValue="cadastro">
          <TabsList>
            <TabsTrigger value="cadastro">Cadastro</TabsTrigger>
            <TabsTrigger value="exposicao">Exposição × Limite</TabsTrigger>
            <TabsTrigger value="alertas">
              Alertas
              {(exposicaoPayload?.contadores_alerta.critico ?? 0) > 0 && (
                <Badge className="ml-1.5 h-4 min-w-4 px-1 text-[9px] bg-red-600">
                  {exposicaoPayload!.contadores_alerta.critico}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="importacoes">Importações</TabsTrigger>
          </TabsList>

          <TabsContent value="cadastro" className="mt-4">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-4">
                  <CardTitle className="text-base">Partes vigentes</CardTitle>
                  <Input
                    placeholder="Buscar nome ou CNPJ…"
                    className="max-w-xs h-8 text-sm"
                    value={busca}
                    onChange={(e) => setBusca(e.target.value)}
                  />
                </div>
              </CardHeader>
              <CardContent>
                {!cnpjSel && (
                  <p className="text-sm text-muted-foreground py-8 text-center">Selecione um fundo para ver o cadastro.</p>
                )}
                {cnpjSel && loadingPartes && (
                  <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
                )}
                {cnpjSel && !loadingPartes && partes.length > 0 && partesFiltradas.length === 0 && (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    Nenhuma parte encontrada para &quot;{busca.trim()}&quot;.
                  </p>
                )}
                {cnpjSel && !loadingPartes && partes.length === 0 && (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    Nenhuma parte cadastrada para este fundo.
                    {fundosOrigem.length > 0
                      ? " Importe a planilha da consultoria ou use “Aproveitar de outro fundo” para copiar cedentes presentes no estoque."
                      : " Importe a planilha da consultoria."}
                  </p>
                )}
                {partesFiltradas.length > 0 && (
                  <div className="max-h-[min(75vh,900px)] overflow-auto rounded-md border">
                    <PartesTable
                      rows={partesFiltradas}
                      sortKey={parteSortKey}
                      sortDir={parteSortDir}
                      onSort={handleParteSort}
                      editingId={editingId}
                      editDraft={editDraft}
                      savingId={savingId}
                      onStartEdit={abrirEditar}
                      onCancelEdit={cancelarEdicao}
                      onSaveEdit={confirmarEdicaoParte}
                      onDraftChange={alterarDraft}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="exposicao" className="mt-4">
            <ExposicaoLimiteTab
              fundoNome={fundos.find((f) => f.cnpj === fundoCnpj)?.nome ?? fundoCnpj}
              fundoCnpj={cnpjSel}
              payload={exposicaoPayload}
              loading={loadingEstoque || loadingPartes}
              semEstoque={semEstoque}
              vpLiquido={vpLiquido}
              onVpLiquidoChange={setVpLiquido}
            />
          </TabsContent>

          <TabsContent value="alertas" className="mt-4">
            <AlertasCadastroTab
              fundoNome={fundos.find((f) => f.cnpj === fundoCnpj)?.nome ?? fundoCnpj}
              fundoCnpj={cnpjSel}
              payload={exposicaoPayload}
              loading={loadingEstoque || loadingPartes}
            />
          </TabsContent>

          <TabsContent value="importacoes" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2"><History className="h-4 w-4" /> Histórico de importações</CardTitle>
              </CardHeader>
              <CardContent>
                {imports.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">Nenhuma importação registrada.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Data</TableHead>
                        <TableHead>Arquivo</TableHead>
                        <TableHead>Consultoria</TableHead>
                        <TableHead className="text-right">Aceitas</TableHead>
                        <TableHead className="text-right">Rejeitadas</TableHead>
                        <TableHead className="text-right">Avisos</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {imports.map((imp) => (
                        <TableRow key={imp.id}>
                          <TableCell className="text-sm">{new Date(imp.created_at).toLocaleString("pt-BR")}</TableCell>
                          <TableCell className="text-sm">{imp.filename ?? "—"}</TableCell>
                          <TableCell className="text-sm">{imp.consultoria ?? "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{imp.aceitas}</TableCell>
                          <TableCell className="text-right tabular-nums">{imp.rejeitadas}</TableCell>
                          <TableCell className="text-right tabular-nums">{Array.isArray(imp.avisos) ? imp.avisos.length : 0}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Dialog open={kpiDialogOpen} onOpenChange={setKpiDialogOpen}>
          <DialogContent className="max-w-[min(96vw,1200px)] w-full max-h-[90vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <div className="flex items-start justify-between gap-4 pr-6">
                <div>
                  <DialogTitle>{KPI_LABELS[kpiFiltro]}</DialogTitle>
                  <DialogDescription>
                    {partesKpiDialog.length} parte{partesKpiDialog.length !== 1 ? "s" : ""} nesta categoria
                    {fundos.find((f) => f.cnpj === fundoCnpj)?.nome ? ` · ${fundos.find((f) => f.cnpj === fundoCnpj)?.nome}` : ""}
                  </DialogDescription>
                </div>
                <Input
                  placeholder="Buscar nome ou CNPJ…"
                  className="max-w-xs h-8 text-sm shrink-0"
                  value={buscaKpi}
                  onChange={(e) => setBuscaKpi(e.target.value)}
                />
              </div>
            </DialogHeader>
            <div className="flex-1 min-h-0 overflow-auto rounded-md border">
              {partesKpiDialog.length === 0 ? (
                <p className="text-sm text-muted-foreground p-6 text-center">
                  {buscaKpi.trim() ? `Nenhuma parte encontrada para "${buscaKpi.trim()}".` : "Nenhuma parte nesta categoria."}
                </p>
              ) : (
                <PartesTable
                  rows={partesKpiDialog}
                  sortKey={parteSortKey}
                  sortDir={parteSortDir}
                  onSort={handleParteSort}
                  editingId={editingId}
                  editDraft={editDraft}
                  savingId={savingId}
                  onStartEdit={abrirEditar}
                  onCancelEdit={cancelarEdicao}
                  onSaveEdit={confirmarEdicaoParte}
                  onDraftChange={alterarDraft}
                />
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setKpiDialogOpen(false)}>Fechar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={importOpen} onOpenChange={setImportOpen}>
          <DialogContent className="max-w-[min(96vw,1280px)] w-full max-h-[90vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>Revisão do import</DialogTitle>
              <DialogDescription>
                Confira as linhas antes de confirmar. Para possíveis grupos econômicos, defina escopo e grupo_chave manualmente.
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 min-h-0 overflow-auto rounded-md border">
              <Table className="min-w-[1040px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead className="min-w-[180px]">Empresa</TableHead>
                    <TableHead className="min-w-[150px]">CNPJ</TableHead>
                    <TableHead className="text-right min-w-[110px]">Limite</TableHead>
                    <TableHead className="min-w-[100px]">Validade</TableHead>
                    <TableHead className="min-w-[120px]">Escopo</TableHead>
                    <TableHead className="min-w-[120px]">Grupo</TableHead>
                    <TableHead className="min-w-[140px] whitespace-nowrap">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewLinhas.map((l) => (
                    <TableRow key={l.linha} className={l.rejeitada ? "opacity-50" : ""}>
                      <TableCell className="w-10">{l.linha}</TableCell>
                      <TableCell className="text-sm max-w-[220px] truncate" title={l.empresa}>{l.empresa}</TableCell>
                      <TableCell className="font-mono text-xs whitespace-nowrap">{l.doc_cnpj_cpf ? formatCnpj(l.doc_cnpj_cpf) : "—"}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums whitespace-nowrap">
                        {l.limite_operacao != null ? formatBRL(l.limite_operacao) : "—"}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">{l.dt_validade ?? "pendente"}</TableCell>
                      <TableCell>
                        {!l.rejeitada && (
                          <Select
                            value={l.escopo_limite}
                            onValueChange={(v) => updateLinhaPreview(l.linha, { escopo_limite: v as "individual" | "grupo" })}
                          >
                            <SelectTrigger className="h-7 w-[112px] text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="individual">Individual</SelectItem>
                              <SelectItem value="grupo">Grupo</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      </TableCell>
                      <TableCell>
                        {!l.rejeitada && l.escopo_limite === "grupo" && (
                          <Input
                            className="h-7 w-[120px] text-xs"
                            placeholder="GRUPO_THX"
                            value={l.grupo_chave ?? ""}
                            onChange={(e) => updateLinhaPreview(l.linha, { grupo_chave: e.target.value || null })}
                          />
                        )}
                      </TableCell>
                      <TableCell className="min-w-[140px] whitespace-nowrap">
                        {l.rejeitada ? (
                          <Badge variant="destructive" className="whitespace-nowrap">{l.motivo_rejeicao}</Badge>
                        ) : l.avisos.length > 0 ? (
                          <Badge className="bg-amber-500 whitespace-nowrap">{l.avisos.length} aviso(s)</Badge>
                        ) : (
                          <Badge className="bg-emerald-600 whitespace-nowrap">OK</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setImportOpen(false)}>Cancelar</Button>
              <Button onClick={confirmImport} disabled={importLoading} className="bg-[#003D27]">
                {importLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <FileUp className="h-4 w-4 mr-2" />}
                Confirmar importação
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={propagarOpen} onOpenChange={setPropagarOpen}>
          <DialogContent className="max-w-[min(96vw,1100px)] w-full max-h-[90vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>Aproveitar cadastro de outro fundo</DialogTitle>
              <DialogDescription>
                Cruza o cadastro vigente do fundo origem com cedentes presentes no estoque do fundo selecionado ({fundos.find((f) => f.cnpj === fundoCnpj)?.nome ?? "destino"}).
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1 min-w-[280px] flex-1">
                <Label className="text-xs uppercase font-bold">Fundo origem (cadastro)</Label>
                <Select value={fundoOrigemCnpj} onValueChange={setFundoOrigemCnpj}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione o fundo com cadastro…" />
                  </SelectTrigger>
                  <SelectContent>
                    {fundosOrigem.map((f) => (
                      <SelectItem key={f.cnpj} value={f.cnpj}>
                        {f.nome} ({f.qtd} parte{f.qtd !== 1 ? "s" : ""})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="secondary"
                onClick={buscarPropagacao}
                disabled={propagarLoading || fundoOrigemCnpj.length !== 14}
              >
                {propagarLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Buscar sugestões
              </Button>
            </div>
            {propagarMeta && (
              <p className="text-xs text-muted-foreground">
                Estoque destino: {propagarMeta.total_estoque ?? 0} cedente(s)
                {propagarMeta.estoque_ref ? ` · ref. ${propagarMeta.estoque_ref}` : ""}
                {propagarJaCadastradas.length > 0 ? ` · ${propagarJaCadastradas.length} já cadastrada(s) neste fundo` : ""}
              </p>
            )}
            <div className="flex-1 min-h-0 overflow-auto rounded-md border">
              {propagarLinhas.length === 0 ? (
                <p className="text-sm text-muted-foreground p-6 text-center">
                  Selecione o fundo origem e clique em Buscar sugestões.
                </p>
              ) : (
                <Table className="min-w-[900px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={propagarLinhas.every((l) => l.selecionada !== false)}
                          onCheckedChange={(v) => {
                            const on = v === true;
                            setPropagarLinhas((prev) => prev.map((l) => ({ ...l, selecionada: on })));
                          }}
                        />
                      </TableHead>
                      <TableHead>Empresa</TableHead>
                      <TableHead>CNPJ</TableHead>
                      <TableHead className="text-right">Limite</TableHead>
                      <TableHead>Validade</TableHead>
                      <TableHead className="text-right">VP estoque</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {propagarLinhas.map((l) => (
                      <TableRow key={l.doc_cnpj_cpf}>
                        <TableCell>
                          <Checkbox
                            checked={l.selecionada !== false}
                            onCheckedChange={(v) => togglePropagacaoLinha(l.doc_cnpj_cpf, v === true)}
                          />
                        </TableCell>
                        <TableCell className="text-sm max-w-[200px] truncate" title={l.nome ?? ""}>{l.nome ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs whitespace-nowrap">{formatCnpj(l.doc_cnpj_cpf)}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums whitespace-nowrap">
                          {l.limite_operacao != null ? formatBRL(l.limite_operacao) : "—"}
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">{l.dt_validade ?? "pendente"}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums whitespace-nowrap">
                          {formatBRL(l.valor_presente_estoque)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPropagarOpen(false)}>Cancelar</Button>
              <Button
                onClick={confirmarPropagacao}
                disabled={propagarLoading || selecionadasPropagacao === 0}
                className="bg-[#003D27]"
              >
                {propagarLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                Copiar {selecionadasPropagacao} parte{selecionadasPropagacao !== 1 ? "s" : ""}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </Layout>
  );
}
