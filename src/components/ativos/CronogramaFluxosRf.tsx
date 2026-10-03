/**
 * CronogramaFluxosRf
 *
 * Painel de gestão manual do cronograma de amortizações/juros de um título RF.
 * Permite:
 *  - Visualizar todos os fluxos cadastrados em titulo_rf_fluxo
 *  - Adicionar novos fluxos linha a linha (formulário inline)
 *    - Modo R$: valor absoluto digitado diretamente
 *    - Modo %: porcentagem do valor de face de referência (calculado automaticamente)
 *  - Excluir fluxos individualmente ou limpar todos
 *  - Visualizar o WAM preview em dias corridos e dias úteis
 *
 * Modo porcentagem:
 *  O usuário define um "Valor de face" de referência (estado local, não persistido no banco).
 *  Para cada fluxo, digita a porcentagem (ex: 50%) e o sistema calcula R$ = face × pct / 100.
 *  O valor armazenado em titulo_rf_fluxo é sempre o valor em R$ calculado.
 *
 * Requisito: o ativo deve ter isin ou codigo_cetip_selic para que possamos
 * construir a chave canônica "isin:BR..." ou "cetip:CODIGO".
 */

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  CalendarDays,
  Plus,
  Trash2,
  RefreshCw,
  AlertCircle,
  Info,
  Loader2,
  CheckCircle2,
  Percent,
  DollarSign,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// ──────────────────────────────────────────────────────────────
// Tipos
// ──────────────────────────────────────────────────────────────

type TipoFluxo = "amortizacao" | "juros" | "residual";

interface FluxoRow {
  id: string;
  chave_ativo: string;
  data_pagamento: string;
  valor_nominal: number;
  tipo_fluxo: TipoFluxo;
  ordem: number | null;
  arquivo_origem: string | null;
  criado_em: string;
}

interface NovoFluxo {
  data_pagamento: string;
  valor_nominal: string;
  tipo_fluxo: TipoFluxo;
}

type ModoEntrada = "brl" | "pct";

const TIPO_LABELS: Record<TipoFluxo, string> = {
  amortizacao: "Amortização",
  juros: "Juros",
  residual: "Residual / Bullet",
};

const TIPO_COLORS: Record<TipoFluxo, string> = {
  amortizacao: "bg-blue-100 text-blue-700 border-blue-200",
  juros: "bg-violet-100 text-violet-700 border-violet-200",
  residual: "bg-amber-100 text-amber-700 border-amber-200",
};

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function chaveCanonica(isin: string | null, cetip: string | null): string | null {
  if (isin) return `isin:${isin.trim().toUpperCase()}`;
  if (cetip) return `cetip:${cetip.trim().toUpperCase()}`;
  return null;
}

function calcularWamCorridos(fluxos: FluxoRow[], dtHoje: Date): number | null {
  const MS = 24 * 60 * 60 * 1000;
  const futuros = fluxos
    .map((f) => {
      const dt = new Date(`${f.data_pagamento}T12:00:00Z`);
      const dias = Math.round((dt.getTime() - dtHoje.getTime()) / MS);
      return dias > 0 ? { dias, vn: f.valor_nominal } : null;
    })
    .filter((x): x is { dias: number; vn: number } => x !== null);
  if (!futuros.length) return null;
  const soma = futuros.reduce((s, f) => s + f.vn, 0);
  if (soma <= 0) return null;
  return futuros.reduce((s, f) => s + f.vn * f.dias, 0) / soma;
}

function calcularWamUteis(fluxos: FluxoRow[], dtHoje: Date): number | null {
  function diasUteis(d1: Date, d2: Date): number {
    let count = 0;
    const cur = new Date(d1);
    cur.setUTCDate(cur.getUTCDate() + 1);
    while (cur <= d2) {
      const dow = cur.getUTCDay();
      if (dow !== 0 && dow !== 6) count++;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return count;
  }
  const futuros = fluxos
    .map((f) => {
      const dt = new Date(`${f.data_pagamento}T12:00:00Z`);
      const du = diasUteis(dtHoje, dt);
      return du > 0 ? { du, vn: f.valor_nominal } : null;
    })
    .filter((x): x is { du: number; vn: number } => x !== null);
  if (!futuros.length) return null;
  const soma = futuros.reduce((s, f) => s + f.vn, 0);
  if (soma <= 0) return null;
  return futuros.reduce((s, f) => s + f.vn * f.du, 0) / soma;
}

function formatBRL(v: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 2,
  }).format(v);
}

// ──────────────────────────────────────────────────────────────
// Componente
// ──────────────────────────────────────────────────────────────

interface CronogramaFluxosRfProps {
  ativoId: string;
  isin: string | null;
  codigoCetip: string | null;
  nomeAtivo: string;
  usaFluxoIntermediario: boolean;
  onUsaFluxoChange?: () => void;
}

const NOVO_FLUXO_VAZIO: NovoFluxo = {
  data_pagamento: "",
  valor_nominal: "",
  tipo_fluxo: "amortizacao",
};

export function CronogramaFluxosRf({
  ativoId,
  isin,
  codigoCetip,
  nomeAtivo,
  usaFluxoIntermediario,
  onUsaFluxoChange,
}: CronogramaFluxosRfProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const chave = chaveCanonica(isin, codigoCetip);

  const [novoFluxo, setNovoFluxo] = useState<NovoFluxo>(NOVO_FLUXO_VAZIO);
  const [formAberto, setFormAberto] = useState(false);
  // Modo de entrada do valor: "brl" (absoluto) ou "pct" (% do valor de face)
  const [modoEntrada, setModoEntrada] = useState<ModoEntrada>("brl");
  // Valor de face de referência (R$) — usado no modo porcentagem; persistido apenas no estado local
  const [valorFace, setValorFace] = useState<string>("");
  // Percentual digitado no modo "%"
  const [pctInput, setPctInput] = useState<string>("");

  /** R$ calculado a partir do modo atual de entrada. */
  const valorCalculado = useMemo((): number | null => {
    if (modoEntrada === "brl") {
      const v = Number(novoFluxo.valor_nominal.replace(",", "."));
      return v > 0 ? v : null;
    }
    const face = Number(valorFace.replace(",", "."));
    const pct = Number(pctInput.replace(",", "."));
    if (face > 0 && pct > 0 && pct <= 100) return (face * pct) / 100;
    return null;
  }, [modoEntrada, novoFluxo.valor_nominal, valorFace, pctInput]);

  // ── Query: carregar fluxos ──────────────────────────────────
  const { data: fluxos = [], isLoading, refetch } = useQuery<FluxoRow[]>({
    queryKey: ["titulo-rf-fluxo", chave],
    enabled: !!chave,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("titulo_rf_fluxo" as any)
        .select("*")
        .eq("chave_ativo", chave as string)
        .order("data_pagamento", { ascending: true });
      if (error) throw error;
      return (data ?? []) as FluxoRow[];
    },
  });

  // ── WAM preview ────────────────────────────────────────────
  const dtHoje = useMemo(() => {
    const d = new Date();
    d.setUTCHours(12, 0, 0, 0);
    return d;
  }, []);

  const wamCorridos = useMemo(() => calcularWamCorridos(fluxos, dtHoje), [fluxos, dtHoje]);
  const wamUteis = useMemo(() => calcularWamUteis(fluxos, dtHoje), [fluxos, dtHoje]);
  const somaNominal = useMemo(() => fluxos.reduce((s, f) => s + f.valor_nominal, 0), [fluxos]);
  const fluxosFuturos = useMemo(() => fluxos.filter((f) => new Date(`${f.data_pagamento}T12:00:00Z`) > dtHoje), [fluxos, dtHoje]);

  // ── Mutation: inserir fluxo ─────────────────────────────────
  const addMutation = useMutation({
    mutationFn: async ({ data_pagamento, tipo_fluxo, valor }: { data_pagamento: string; tipo_fluxo: TipoFluxo; valor: number }) => {
      if (!data_pagamento || valor <= 0) {
        throw new Error("Data e valor são obrigatórios e o valor deve ser positivo.");
      }
      const { error } = await supabase
        .from("titulo_rf_fluxo" as any)
        .upsert(
          {
            chave_ativo: chave,
            ativo_id: ativoId,
            data_pagamento,
            valor_nominal: valor,
            tipo_fluxo,
            arquivo_origem: "manual",
          },
          { onConflict: "chave_ativo,data_pagamento,tipo_fluxo,valor_nominal" },
        );
      if (error) throw error;

      // Garantir usa_fluxo_intermediario = true no ativo
      await supabase
        .from("ativos" as any)
        .update({ usa_fluxo_intermediario: true, metodo_prazo_rf: "fluxo_nominal" })
        .eq("id", ativoId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["titulo-rf-fluxo", chave] });
      qc.invalidateQueries({ queryKey: ["ativos"] });
      setNovoFluxo(NOVO_FLUXO_VAZIO);
      setPctInput("");
      setFormAberto(false);
      onUsaFluxoChange?.();
      toast({ title: "Fluxo adicionado", description: "O cronograma foi atualizado." });
    },
    onError: (e: any) => {
      toast({ title: "Erro ao adicionar", description: e?.message, variant: "destructive" });
    },
  });

  // ── Mutation: excluir fluxo ─────────────────────────────────
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("titulo_rf_fluxo" as any)
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["titulo-rf-fluxo", chave] });
      // Se não há mais fluxos, desativar usa_fluxo_intermediario
      const { data: remaining } = await supabase
        .from("titulo_rf_fluxo" as any)
        .select("id")
        .eq("chave_ativo", chave as string)
        .limit(1);
      if ((remaining ?? []).length === 0) {
        await supabase
          .from("ativos" as any)
          .update({ usa_fluxo_intermediario: false, metodo_prazo_rf: "vencimento" })
          .eq("id", ativoId);
        qc.invalidateQueries({ queryKey: ["ativos"] });
        onUsaFluxoChange?.();
      }
      toast({ title: "Fluxo excluído" });
    },
    onError: (e: any) => {
      toast({ title: "Erro ao excluir", description: e?.message, variant: "destructive" });
    },
  });

  // ── Mutation: limpar todos ──────────────────────────────────
  const clearAllMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("titulo_rf_fluxo" as any)
        .delete()
        .eq("chave_ativo", chave as string);
      if (error) throw error;
      await supabase
        .from("ativos" as any)
        .update({ usa_fluxo_intermediario: false, metodo_prazo_rf: "vencimento" })
        .eq("id", ativoId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["titulo-rf-fluxo", chave] });
      qc.invalidateQueries({ queryKey: ["ativos"] });
      onUsaFluxoChange?.();
      toast({ title: "Cronograma limpo", description: "Todos os fluxos foram removidos." });
    },
    onError: (e: any) => {
      toast({ title: "Erro ao limpar", description: e?.message, variant: "destructive" });
    },
  });

  if (!chave) {
    return (
      <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-700 flex items-start gap-2">
        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
        <p>
          Este ativo não possui ISIN nem código CETIP/SELIC cadastrado.
          Adicione um desses identificadores para gerenciar o cronograma de fluxos.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header do painel */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">Cronograma de Fluxos</span>
          {usaFluxoIntermediario && (
            <Badge className="text-[9px] bg-blue-100 text-blue-700 border border-blue-200 hover:bg-blue-100">
              Inc. II ativo
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => refetch()}
                  className="p-1.5 rounded hover:bg-muted transition-colors"
                >
                  <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Recarregar fluxos</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <span className="text-[10px] font-mono text-muted-foreground">{chave}</span>
        </div>
      </div>

      {/* Info regulatória */}
      <div className="rounded-md bg-muted/50 border border-border/50 p-3 text-xs text-muted-foreground flex items-start gap-2">
        <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        <span>
          Fluxos cadastrados aqui ativam o cálculo pelo{" "}
          <strong>Art. 4º §2º II IN RFB 1585/2015</strong> (WAM de fluxos nominais)
          em substituição ao inciso I (vencimento final) para cálculo tributário e de liquidez.
        </span>
      </div>

      {/* WAM preview */}
      {fluxos.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border border-border/60 bg-card p-3 text-center">
            <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
              WAM tributário
            </p>
            <p className="text-lg font-extrabold font-mono text-blue-600">
              {wamCorridos != null ? `${wamCorridos.toFixed(0)}d` : "—"}
            </p>
            <p className="text-[9px] text-muted-foreground">corridos</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-card p-3 text-center">
            <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
              WAM liquidez
            </p>
            <p className="text-lg font-extrabold font-mono text-violet-600">
              {wamUteis != null ? `${wamUteis.toFixed(0)}d` : "—"}
            </p>
            <p className="text-[9px] text-muted-foreground">úteis</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-card p-3 text-center">
            <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
              Fluxos
            </p>
            <p className="text-lg font-extrabold font-mono text-foreground">
              {fluxosFuturos.length}
              <span className="text-xs font-normal text-muted-foreground">/{fluxos.length}</span>
            </p>
            <p className="text-[9px] text-muted-foreground">futuros/total</p>
          </div>
        </div>
      )}

      {/* Tabela de fluxos */}
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : fluxos.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          <CalendarDays className="h-8 w-8 mx-auto mb-2 opacity-30" />
          <p>Nenhum fluxo cadastrado.</p>
          <p className="text-xs mt-1">
            Adicione manualmente abaixo ou use o upload de CSV/XLSX.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/30 border-b border-border/50">
                <th className="text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-3 py-2">
                  Data
                </th>
                <th className="text-right text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-3 py-2">
                  Valor (R$)
                </th>
                <th className="text-center text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-3 py-2">
                  Tipo
                </th>
                <th className="text-right text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-3 py-2">
                  Dias (corr.)
                </th>
                <th className="w-8 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {fluxos.map((f) => {
                const dtPag = new Date(`${f.data_pagamento}T12:00:00Z`);
                const diasCorridos = Math.round((dtPag.getTime() - dtHoje.getTime()) / (24 * 60 * 60 * 1000));
                const passado = diasCorridos <= 0;
                return (
                  <tr
                    key={f.id}
                    className={cn(
                      "border-b border-border/30 transition-colors",
                      passado ? "bg-muted/20 opacity-60" : "hover:bg-muted/20",
                    )}
                  >
                    <td className="px-3 py-2 font-mono">
                      {f.data_pagamento}
                      {passado && (
                        <span className="ml-1 text-[9px] text-muted-foreground">(vencido)</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {formatBRL(f.valor_nominal)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <Badge
                        variant="outline"
                        className={cn("text-[9px] capitalize", TIPO_COLORS[f.tipo_fluxo])}
                      >
                        {TIPO_LABELS[f.tipo_fluxo]}
                      </Badge>
                    </td>
                    <td className={cn("px-3 py-2 text-right font-mono tabular-nums", passado ? "text-muted-foreground" : "text-foreground")}>
                      {passado ? "—" : `${diasCorridos}d`}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => deleteMutation.mutate(f.id)}
                        disabled={deleteMutation.isPending}
                        className="p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-colors text-muted-foreground"
                        title="Excluir fluxo"
                      >
                        {deleteMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {fluxos.length > 0 && (
              <tfoot>
                <tr className="bg-muted/30 border-t border-border/50 font-semibold text-xs">
                  <td className="px-3 py-2 text-muted-foreground">
                    Total ({fluxos.length} fluxo{fluxos.length !== 1 ? "s" : ""})
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {formatBRL(somaNominal)}
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* Formulário: novo fluxo */}
      {formAberto ? (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
          {/* Cabeçalho com toggle R$ / % */}
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-foreground">Novo fluxo</p>
            <div className="flex items-center rounded-md border border-border overflow-hidden text-[10px] font-bold">
              <button
                type="button"
                onClick={() => setModoEntrada("brl")}
                className={cn(
                  "flex items-center gap-1 px-2.5 py-1 transition-colors",
                  modoEntrada === "brl"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                <DollarSign className="h-3 w-3" />
                R$
              </button>
              <button
                type="button"
                onClick={() => setModoEntrada("pct")}
                className={cn(
                  "flex items-center gap-1 px-2.5 py-1 transition-colors",
                  modoEntrada === "pct"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                <Percent className="h-3 w-3" />
                %
              </button>
            </div>
          </div>

          {/* Valor de face — só visível no modo % */}
          {modoEntrada === "pct" && (
            <div className="rounded-md bg-blue-50 border border-blue-200 p-2.5 space-y-1.5">
              <Label className="text-[10px] uppercase tracking-wide text-blue-700 font-semibold">
                Valor de face de referência (R$) *
              </Label>
              <p className="text-[10px] text-blue-600">
                Principal total do título. Ex: R$ 1.000.000 → 50% = R$ 500.000 por parcela.
              </p>
              <Input
                type="number"
                step="1"
                min="0.01"
                placeholder="Ex: 1000000"
                className="h-8 text-xs bg-white border-blue-300 focus:border-blue-500"
                value={valorFace}
                onChange={(e) => setValorFace(e.target.value)}
                autoFocus
              />
            </div>
          )}

          {/* Linha: Data + Valor (R$ ou %) + Tipo */}
          <div className={cn("grid gap-2", modoEntrada === "pct" ? "grid-cols-3" : "grid-cols-3")}>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Data *
              </Label>
              <Input
                type="date"
                className="h-8 text-xs"
                value={novoFluxo.data_pagamento}
                onChange={(e) => setNovoFluxo((v) => ({ ...v, data_pagamento: e.target.value }))}
              />
            </div>

            <div className="space-y-1">
              {modoEntrada === "brl" ? (
                <>
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Valor (R$) *
                  </Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0.01"
                    placeholder="0,00"
                    className="h-8 text-xs"
                    value={novoFluxo.valor_nominal}
                    onChange={(e) => setNovoFluxo((v) => ({ ...v, valor_nominal: e.target.value }))}
                  />
                </>
              ) : (
                <>
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Percentual (%) *
                  </Label>
                  <div className="relative">
                    <Input
                      type="number"
                      step="0.01"
                      min="0.01"
                      max="100"
                      placeholder="50"
                      className="h-8 text-xs pr-8"
                      value={pctInput}
                      onChange={(e) => setPctInput(e.target.value)}
                    />
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-bold pointer-events-none">
                      %
                    </span>
                  </div>
                  {/* Preview do valor calculado */}
                  <p className={cn(
                    "text-[10px] font-mono",
                    valorCalculado != null ? "text-blue-700 font-semibold" : "text-muted-foreground",
                  )}>
                    {valorCalculado != null
                      ? `= ${formatBRL(valorCalculado)}`
                      : "informe face e %"}
                  </p>
                </>
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Tipo
              </Label>
              <Select
                value={novoFluxo.tipo_fluxo}
                onValueChange={(v) =>
                  setNovoFluxo((prev) => ({ ...prev, tipo_fluxo: v as TipoFluxo }))
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="amortizacao">Amortização</SelectItem>
                  <SelectItem value="juros">Juros</SelectItem>
                  <SelectItem value="residual">Residual / Bullet</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Rodapé do formulário */}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-8 text-xs gap-1.5"
              disabled={
                addMutation.isPending ||
                !novoFluxo.data_pagamento ||
                valorCalculado == null
              }
              onClick={() => {
                if (!valorCalculado) return;
                addMutation.mutate({
                  data_pagamento: novoFluxo.data_pagamento,
                  tipo_fluxo: novoFluxo.tipo_fluxo,
                  valor: valorCalculado,
                });
              }}
            >
              {addMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" />
              )}
              Salvar
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                setFormAberto(false);
                setNovoFluxo(NOVO_FLUXO_VAZIO);
                setPctInput("");
              }}
            >
              Cancelar
            </Button>
            {modoEntrada === "pct" && valorCalculado != null && (
              <span className="text-[10px] text-muted-foreground ml-1">
                Será salvo como {formatBRL(valorCalculado)}
              </span>
            )}
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs gap-1.5 w-full"
          onClick={() => setFormAberto(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          Adicionar fluxo
        </Button>
      )}

      {/* Limpar todos */}
      {fluxos.length > 0 && (
        <>
          <Separator />
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-muted-foreground">
              {usaFluxoIntermediario
                ? "Inciso II ativo — reprocesse o enquadramento após alterações."
                : "Inciso II desativado — adicione fluxos para ativá-lo."}
            </p>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[10px] text-destructive hover:text-destructive gap-1 hover:bg-destructive/10"
                  disabled={clearAllMutation.isPending}
                >
                  {clearAllMutation.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                  Limpar todos os fluxos
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Limpar cronograma?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Todos os {fluxos.length} fluxo(s) de <strong>{nomeAtivo}</strong> serão excluídos
                    e o ativo voltará a usar o inciso I (vencimento final).
                    Esta ação não pode ser desfeita.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive hover:bg-destructive/90"
                    onClick={() => clearAllMutation.mutate()}
                  >
                    Limpar
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </>
      )}
    </div>
  );
}
