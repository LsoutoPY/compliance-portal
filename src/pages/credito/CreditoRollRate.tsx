/**
 * Roll Rate — buckets canônicos unificados (Adimplente … 180+).
 * Recovery Rate indisponível — requer fluxo de caixa.
 */

import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { supabase } from "@/integrations/supabase/client";
import { BUCKET_COLORS, BUCKET_LABELS, rollMigracaoProximaLabel } from "@/lib/creditoBuckets";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  TrendingDown,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronUp,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from "recharts";

// ──────────────────────────────────────────────────────────────
// Types (conforme colunas das views SQL)
// ──────────────────────────────────────────────────────────────

type EstoquePorFaixa = {
  data_referencia: string;
  doc_fundo: string;
  nome_fundo: string;
  faixa_calculada: number;
  faixa_descricao: string;
  bucket_ordem?: number;
  bucket_canonico?: string;
  quantidade_ativos: number;
  valor_total: number;
  percentual_estoque: number;
};

type EstoqueBaseDrill = {
  chave_ativo: string;
  nome_cedente: string | null;
  doc_cedente: string | null;
  nome_sacado: string | null;
  doc_sacado: string | null;
  valor_base: number;
  seu_numero: string | null;
  nu_documento: string | null;
};

type RollRate = {
  mes_origem: string;
  mes_destino: string;
  doc_fundo: string;
  nome_fundo: string;
  faixa_origem: number;
  migracao: string;
  bucket_origem?: string;
  qtd_ativos_origem: number;
  qtd_ativos_migrados: number;
  valor_origem_total: number;
  valor_migrado_para_faixa_seguinte: number;
  roll_rate: number | null;
};

type Media3m = {
  doc_fundo: string;
  nome_fundo: string;
  faixa_origem: number;
  migracao: string;
  media_3m: number | null;
  meses_utilizados: number;
  mes_mais_antigo: string;
  mes_mais_recente: string;
  media_incompleta: boolean;
};

type MatrizMigracao = {
  mes_origem: string;
  mes_destino: string;
  doc_fundo: string;
  nome_fundo: string;
  faixa_origem: number;
  faixa_destino: number;
  quantidade_ativos: number;
  valor_migrado: number;
};

type ResumoGerencial = {
  doc_fundo: string;
  nome_fundo: string;
  data_referencia: string;
  carteira_total: number;
  total_em_atraso: number;
  total_over90: number;
  total_over180?: number;
  total_perda?: number;
  qtd_ativos_total: number;
  qtd_ativos_em_atraso: number;
  qtd_ativos_perda?: number;
  pct_em_atraso: number;
  pct_over90: number;
  pct_over180: number;
  pct_perda?: number;
  qtd_piorou_ultimo_mes: number;
  qtd_curou_ultimo_mes: number;
  qtd_entrou_em_perda_ultimo_mes: number;
  valor_entrou_em_perda_ultimo_mes?: number;
  qtd_entrou_em_atraso_ultimo_mes: number;
  valor_entrou_em_atraso_ultimo_mes: number;
  indice_melhoria_faixa?: number | null;
};

type Alerta = {
  tipo_alerta: string;
  data_referencia: string;
  doc_fundo: string;
  nome_fundo: string;
  referencia: string;
  quantidade: number;
  descricao: string;
};

// ──────────────────────────────────────────────────────────────
// Formatação
// ──────────────────────────────────────────────────────────────

const fmtBRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v || 0);

const fmtPct = (v: number | null, decimals = 2) =>
  v == null ? "—" : `${((v || 0) * 100).toFixed(decimals)}%`;

const fmtPctDirect = (v: number | null, decimals = 2) =>
  v == null ? "—" : `${(v || 0).toFixed(decimals)}%`;

const fmtDate = (d: string) => {
  if (!d) return "—";
  const dt = new Date(d + "T00:00:00");
  return isNaN(dt.getTime()) ? d : new Intl.DateTimeFormat("pt-BR").format(dt);
};

// ──────────────────────────────────────────────────────────────
// Helper: Supabase client sem tipagem estrita para views novas
// (as views não estão nos tipos gerados; serão atualizados após
//  rodar `supabase gen types typescript`)
// ──────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (t: string) => any };

// ──────────────────────────────────────────────────────────────
// Componente: Card de Resumo Gerencial
// ──────────────────────────────────────────────────────────────
function ResumoCards({ resumo }: { resumo: ResumoGerencial | null }) {
  if (!resumo) return null;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase text-muted-foreground">Carteira Total</CardTitle>
        </CardHeader>
        <CardContent className="text-lg font-bold">{fmtBRL(resumo.carteira_total)}</CardContent>
      </Card>
      <Card className={resumo.pct_over90 > 0.10 ? "border-red-400" : ""}>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase text-muted-foreground">Over 90 dias</CardTitle>
        </CardHeader>
        <CardContent className={cn("text-lg font-bold", resumo.pct_over90 > 0.10 && "text-red-600")}>
          {fmtPct(resumo.pct_over90)}
        </CardContent>
      </Card>
      <Card className={resumo.pct_over180 > 0.05 ? "border-red-600" : ""}>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase text-muted-foreground">Over180 (180+)</CardTitle>
        </CardHeader>
        <CardContent className={cn("text-lg font-bold", resumo.pct_over180 > 0 && "text-red-700")}>
          {fmtPct(resumo.pct_over180)}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase text-muted-foreground">Índice Melhoria Faixa</CardTitle>
        </CardHeader>
        <CardContent className="text-lg font-bold">
          {resumo.indice_melhoria_faixa != null ? fmtPct(resumo.indice_melhoria_faixa) : "—"}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase text-muted-foreground">Ativos Monitorados</CardTitle>
        </CardHeader>
        <CardContent className="text-lg font-bold">{resumo.qtd_ativos_total}</CardContent>
      </Card>
      {/* Variações do último mês */}
      <Card className={resumo.qtd_entrou_em_atraso_ultimo_mes > 0 ? "border-amber-400" : ""}>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase text-muted-foreground">Novo Atraso (últ. mês)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-bold text-amber-600">{resumo.qtd_entrou_em_atraso_ultimo_mes}</p>
          <p className="text-xs text-muted-foreground mt-1">{fmtBRL(resumo.valor_entrou_em_atraso_ultimo_mes)}</p>
        </CardContent>
      </Card>
      <Card className={resumo.qtd_entrou_em_perda_ultimo_mes > 0 ? "border-red-500" : ""}>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase text-muted-foreground">Entrou 180+ (últ. mês)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-bold text-red-600">{resumo.qtd_entrou_em_perda_ultimo_mes}</p>
          {resumo.valor_entrou_em_perda_ultimo_mes != null && (
            <p className="text-xs text-muted-foreground mt-1">{fmtBRL(resumo.valor_entrou_em_perda_ultimo_mes)}</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase text-muted-foreground">Pioraram (últ. mês)</CardTitle>
        </CardHeader>
        <CardContent className="text-lg font-bold text-orange-600">{resumo.qtd_piorou_ultimo_mes}</CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase text-muted-foreground">Curaram (últ. mês)</CardTitle>
        </CardHeader>
        <CardContent className="text-lg font-bold text-green-600">{resumo.qtd_curou_ultimo_mes}</CardContent>
      </Card>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Drill-down: operações por bucket
// ──────────────────────────────────────────────────────────────

function consolidateByChave(rows: EstoqueBaseDrill[]): EstoqueBaseDrill[] {
  const map = new Map<string, EstoqueBaseDrill>();
  for (const r of rows) {
    const ex = map.get(r.chave_ativo);
    if (!ex) {
      map.set(r.chave_ativo, { ...r });
    } else {
      ex.valor_base += r.valor_base;
    }
  }
  return Array.from(map.values()).sort((a, b) => b.valor_base - a.valor_base);
}

function aggregatePartes(
  ops: EstoqueBaseDrill[],
  tipo: "cedente" | "sacado",
): { nome: string; doc: string; valor: number; qtd: number }[] {
  const map = new Map<string, { nome: string; doc: string; valor: number; qtd: number }>();
  for (const r of ops) {
    const doc = tipo === "cedente" ? r.doc_cedente : r.doc_sacado;
    const nome = tipo === "cedente" ? r.nome_cedente : r.nome_sacado;
    const key = doc || nome || "—";
    const cur = map.get(key) ?? { nome: nome || "—", doc: doc || "—", valor: 0, qtd: 0 };
    cur.valor += r.valor_base;
    cur.qtd += 1;
    map.set(key, cur);
  }
  return Array.from(map.values()).sort((a, b) => b.valor - a.valor);
}

function PartesResumoTable({
  titulo,
  labelColuna,
  rows,
}: {
  titulo: string;
  labelColuna: string;
  rows: { nome: string; doc: string; valor: number; qtd: number }[];
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{titulo}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead>{labelColuna}</TableHead>
                <TableHead className="text-right">Qtd.</TableHead>
                <TableHead className="text-right">Valor (VP)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 10).map((r) => (
                <TableRow key={`${r.doc}-${r.nome}`}>
                  <TableCell className="font-medium max-w-[180px] truncate" title={r.nome}>
                    {r.nome}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.qtd.toLocaleString("pt-BR")}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{fmtBRL(r.valor)}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground py-4">
                    Sem dados
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function FaixaDrillDownPanel({
  docFundo,
  dataReferencia,
  bucketOrdem,
  onClose,
}: {
  docFundo: string;
  dataReferencia: string;
  bucketOrdem: number;
  onClose: () => void;
}) {
  const { data: rawRows = [], isLoading } = useQuery({
    queryKey: ["rollrate-faixa-drill", docFundo, dataReferencia, bucketOrdem],
    enabled: !!docFundo && !!dataReferencia && bucketOrdem != null,
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_estoque_fidc_base")
        .select("chave_ativo, nome_cedente, doc_cedente, nome_sacado, doc_sacado, valor_base, seu_numero, nu_documento")
        .eq("doc_fundo", docFundo)
        .eq("data_referencia", dataReferencia)
        .eq("bucket_ordem", bucketOrdem)
        .order("valor_base", { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as EstoqueBaseDrill[];
    },
  });

  const operacoes = useMemo(() => consolidateByChave(rawRows), [rawRows]);
  const topCedentes = useMemo(() => aggregatePartes(operacoes, "cedente"), [operacoes]);
  const topSacados = useMemo(() => aggregatePartes(operacoes, "sacado"), [operacoes]);
  const label = BUCKET_LABELS[bucketOrdem] ?? `Bucket ${bucketOrdem}`;
  const totalVp = operacoes.reduce((s, r) => s + r.valor_base, 0);

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold flex items-center gap-2">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: BUCKET_COLORS[bucketOrdem] ?? "#64748b" }}
            />
            Detalhe — {label}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {operacoes.length.toLocaleString("pt-BR")} ativo(s) · {fmtBRL(totalVp)} em valor presente
            {rawRows.length >= 2000 && " · exibindo até 2.000 registros"}
          </p>
        </div>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={onClose} title="Fechar">
          <X className="w-4 h-4" />
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="grid md:grid-cols-2 gap-4">
            <PartesResumoTable titulo="Top Cedentes" labelColuna="Cedente" rows={topCedentes} />
            <PartesResumoTable titulo="Top Sacados" labelColuna="Sacado" rows={topSacados} />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Operações na faixa</CardTitle>
              <CardDescription className="text-xs">
                Cedente, sacado e valor presente por ativo (consolidado por chave).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="bg-card border border-border rounded-lg overflow-hidden max-h-[320px] overflow-y-auto">
                <Table>
                  <TableHeader className="bg-muted/30 sticky top-0 z-10">
                    <TableRow>
                      <TableHead>Cedente</TableHead>
                      <TableHead>Sacado</TableHead>
                      <TableHead className="text-right">Valor (VP)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {operacoes.map((r) => (
                      <TableRow key={r.chave_ativo}>
                        <TableCell className="max-w-[180px] truncate font-medium" title={r.nome_cedente ?? r.doc_cedente ?? ""}>
                          {r.nome_cedente || r.doc_cedente || "—"}
                        </TableCell>
                        <TableCell className="max-w-[180px] truncate" title={r.nome_sacado ?? r.doc_sacado ?? ""}>
                          {r.nome_sacado || r.doc_sacado || "—"}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{fmtBRL(r.valor_base)}</TableCell>
                      </TableRow>
                    ))}
                    {operacoes.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center text-muted-foreground py-6">
                          Nenhuma operação nesta faixa.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Componente: Gráfico + Tabela de Estoque por Faixa
// ──────────────────────────────────────────────────────────────
function EstoquePorFaixaSection({
  rows,
  docFundo,
  dataReferencia,
}: {
  rows: EstoquePorFaixa[];
  docFundo: string;
  dataReferencia: string;
}) {
  const [selectedOrdem, setSelectedOrdem] = useState<number | null>(null);

  useEffect(() => {
    setSelectedOrdem(null);
  }, [docFundo, dataReferencia]);

  const chartData = rows.map((r) => {
    const ordem = r.bucket_ordem ?? r.faixa_calculada;
    return {
      name: BUCKET_LABELS[ordem] ?? r.bucket_canonico ?? r.faixa_descricao,
      valor: r.valor_total,
      pct: r.percentual_estoque,
      ordem,
    };
  });

  const toggleBucket = (ordem: number) => {
    setSelectedOrdem((prev) => (prev === ordem ? null : ordem));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingDown className="w-4 h-4 text-primary" />
          Distribuição por Bucket de Atraso
        </CardTitle>
        <CardDescription className="text-xs">
          Buckets canônicos: Adimplente · 1–30 · 31–60 · 61–90 · 91–180 · 180+.
          Base: valor_presente. Clique em uma faixa para ver cedentes, sacados e operações.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis
                tickFormatter={(v) =>
                  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${(v / 1_000).toFixed(0)}K`
                }
                width={52}
                tick={{ fontSize: 10 }}
              />
              <Tooltip
                formatter={(value: number, name: string) =>
                  name === "pct" ? `${value.toFixed(2)}%` : fmtBRL(value)
                }
              />
              <Bar
                dataKey="valor"
                name="Valor (VP)"
                radius={[3, 3, 0, 0]}
                cursor="pointer"
                onClick={(_data, index) => {
                  const entry = chartData[index];
                  if (entry) toggleBucket(entry.ordem);
                }}
              >
                {chartData.map((entry, idx) => (
                  <Cell
                    key={`cell-${idx}`}
                    fill={BUCKET_COLORS[entry.ordem] ?? "#64748b"}
                    opacity={selectedOrdem == null || selectedOrdem === entry.ordem ? 1 : 0.35}
                    stroke={selectedOrdem === entry.ordem ? "#0f172a" : undefined}
                    strokeWidth={selectedOrdem === entry.ordem ? 2 : 0}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead>Bucket</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead className="text-right">Qtd. Ativos</TableHead>
                <TableHead className="text-right">Valor (VP)</TableHead>
                <TableHead className="text-right">% Carteira</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const ordem = r.bucket_ordem ?? r.faixa_calculada;
                const isSelected = selectedOrdem === ordem;
                return (
                  <TableRow
                    key={ordem}
                    className={cn(
                      "cursor-pointer transition-colors hover:bg-muted/50",
                      isSelected && "bg-primary/5 ring-1 ring-inset ring-primary/40",
                      !isSelected && ordem >= 4 && "bg-red-50/30",
                      !isSelected && ordem >= 1 && ordem < 4 && "bg-amber-50/30",
                    )}
                    onClick={() => toggleBucket(ordem)}
                  >
                    <TableCell className="font-bold" style={{ color: BUCKET_COLORS[ordem] ?? "#64748b" }}>
                      {BUCKET_LABELS[ordem] ?? r.bucket_canonico ?? r.faixa_descricao}
                    </TableCell>
                    <TableCell className="text-sm">{r.faixa_descricao}</TableCell>
                    <TableCell className="text-right">{r.quantidade_ativos.toLocaleString("pt-BR")}</TableCell>
                    <TableCell className="text-right font-medium">{fmtBRL(r.valor_total)}</TableCell>
                    <TableCell className="text-right">{fmtPctDirect(r.percentual_estoque)}</TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                    Nenhum dado disponível para o fundo/data selecionado.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {selectedOrdem != null && docFundo && dataReferencia && (
          <FaixaDrillDownPanel
            docFundo={docFundo}
            dataReferencia={dataReferencia}
            bucketOrdem={selectedOrdem}
            onClose={() => setSelectedOrdem(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────
// Componente: Tabela de Roll Rate
// ──────────────────────────────────────────────────────────────
function RollRateTable({ rows }: { rows: RollRate[] }) {
  // Agrupa por par de meses
  const parsMeses = useMemo(() => {
    const s = new Set(rows.map((r) => `${r.mes_origem}|${r.mes_destino}`));
    return Array.from(s).map((k) => {
      const [orig, dest] = k.split("|");
      return { key: k, mes_origem: orig, mes_destino: dest };
    }).sort((a, b) => a.mes_origem.localeCompare(b.mes_origem));
  }, [rows]);

  const [parAtivo, setParAtivo] = useState<string>(() => parsMeses[parsMeses.length - 1]?.key ?? "");
  const parEfetivo = parAtivo || (parsMeses[parsMeses.length - 1]?.key ?? "");

  const rowsFiltradas = useMemo(
    () => rows.filter((r) => `${r.mes_origem}|${r.mes_destino}` === parEfetivo),
    [rows, parEfetivo]
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <CardTitle className="text-sm">Roll Rate por Bucket</CardTitle>
            <CardDescription className="text-xs mt-1">
              Fórmula: valor migrado bucket N→N+1 / valor total em N no mês origem.
              Curas e permanências não entram no numerador.
            </CardDescription>
          </div>
          {parsMeses.length > 0 && (
            <Select value={parEfetivo} onValueChange={setParAtivo}>
              <SelectTrigger className="w-[280px] h-8 text-xs shrink-0">
                <SelectValue placeholder="Par de meses" />
              </SelectTrigger>
              <SelectContent>
                {parsMeses.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {fmtDate(p.mes_origem)} → {fmtDate(p.mes_destino)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader className="bg-muted/30">
            <TableRow>
              <TableHead>Migração</TableHead>
              <TableHead className="text-right">Ativos Orig.</TableHead>
              <TableHead className="text-right">Ativos Migr.</TableHead>
              <TableHead className="text-right">Valor Orig. (VP)</TableHead>
              <TableHead className="text-right">Valor Migr. (VP)</TableHead>
              <TableHead className="text-right font-bold">Roll Rate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rowsFiltradas.map((r) => {
              const rr = r.roll_rate ?? 0;
              const isHigh = rr > 0.3;
              const isMedium = rr > 0.1 && rr <= 0.3;
              return (
                <TableRow key={`${r.faixa_origem}`}>
                  <TableCell className="font-bold">{r.migracao}</TableCell>
                  <TableCell className="text-right">{r.qtd_ativos_origem}</TableCell>
                  <TableCell className="text-right">{r.qtd_ativos_migrados}</TableCell>
                  <TableCell className="text-right">{fmtBRL(r.valor_origem_total)}</TableCell>
                  <TableCell className="text-right">{fmtBRL(r.valor_migrado_para_faixa_seguinte)}</TableCell>
                  <TableCell className={cn(
                    "text-right font-bold",
                    r.roll_rate == null ? "text-muted-foreground" :
                    isHigh ? "text-red-600" :
                    isMedium ? "text-amber-600" :
                    "text-green-600"
                  )}>
                    {r.roll_rate == null ? "—" : fmtPct(r.roll_rate)}
                  </TableCell>
                </TableRow>
              );
            })}
            {rowsFiltradas.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                  Nenhum dado de roll rate disponível para o período selecionado.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────
// Componente: Tabela Média 3 Meses
// ──────────────────────────────────────────────────────────────
function Media3mTable({ rows }: { rows: Media3m[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Média Simples — Últimos 3 Meses</CardTitle>
        <CardDescription className="text-xs">
          Média aritmética simples dos últimos 3 pares de meses disponíveis.
          Quando há menos de 3 observações, a coluna "Meses" indica a quantidade efetiva utilizada.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader className="bg-muted/30">
            <TableRow>
              <TableHead>Migração</TableHead>
              <TableHead className="text-right font-bold">Média 3m</TableHead>
              <TableHead className="text-right">Meses usados</TableHead>
              <TableHead className="text-right">Mês mais antigo</TableHead>
              <TableHead className="text-right">Mês mais recente</TableHead>
              <TableHead className="text-center">Incompleta?</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const med = r.media_3m ?? 0;
              const isHigh = med > 0.3;
              const isMedium = med > 0.1 && med <= 0.3;
              return (
                <TableRow key={r.faixa_origem}>
                  <TableCell className="font-bold">{r.migracao}</TableCell>
                  <TableCell className={cn(
                    "text-right font-bold",
                    r.media_3m == null ? "text-muted-foreground" :
                    isHigh ? "text-red-600" :
                    isMedium ? "text-amber-600" :
                    "text-green-600"
                  )}>
                    {r.media_3m == null ? "—" : fmtPct(r.media_3m)}
                  </TableCell>
                  <TableCell className="text-right">{r.meses_utilizados}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{fmtDate(r.mes_mais_antigo)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{fmtDate(r.mes_mais_recente)}</TableCell>
                  <TableCell className="text-center">
                    {r.media_incompleta ? (
                      <Badge variant="outline" className="text-amber-600 border-amber-400 text-xs">
                        Incompleta
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-green-600 border-green-400 text-xs">
                        OK
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                  Dados insuficientes. São necessários pelo menos 2 meses de estoque importado.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────
// Componente: Matriz de Migração
// ──────────────────────────────────────────────────────────────
function MatrizMigracaoSection({ rows }: { rows: MatrizMigracao[] }) {
  const parsMeses = useMemo(() => {
    const s = new Set(rows.map((r) => `${r.mes_origem}|${r.mes_destino}`));
    return Array.from(s).map((k) => {
      const [orig, dest] = k.split("|");
      return { key: k, mes_origem: orig, mes_destino: dest };
    }).sort((a, b) => a.mes_origem.localeCompare(b.mes_origem));
  }, [rows]);

  const [parAtivo, setParAtivo] = useState<string>(() => parsMeses[parsMeses.length - 1]?.key ?? "");
  const parEfetivo = parAtivo || (parsMeses[parsMeses.length - 1]?.key ?? "");

  const faixas = [0, 1, 2, 3, 4, 5];

  const matrixData = useMemo(() => {
    const filtered = rows.filter((r) => `${r.mes_origem}|${r.mes_destino}` === parEfetivo);
    const map = new Map<string, number>();
    filtered.forEach((r) => {
      map.set(`${r.faixa_origem}-${r.faixa_destino}`, r.valor_migrado);
    });
    return map;
  }, [rows, parEfetivo]);

  const getValor = (orig: number, dest: number) => matrixData.get(`${orig}-${dest}`) ?? 0;

  const maxValor = useMemo(() => {
    let max = 0;
    matrixData.forEach((v) => { if (v > max) max = v; });
    return max;
  }, [matrixData]);

  const cellColor = (orig: number, dest: number) => {
    const v = getValor(orig, dest);
    if (v === 0) return "";
    const intensity = Math.round((v / maxValor) * 100);
    if (orig === dest) return `rgba(59, 130, 246, ${intensity / 100 * 0.6 + 0.1})`; // azul (permaneceu)
    if (dest < orig)  return `rgba(34, 197, 94, ${intensity / 100 * 0.6 + 0.1})`;  // verde (curou)
    return `rgba(239, 68, 68, ${intensity / 100 * 0.6 + 0.1})`;                     // vermelho (piorou)
  };

  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div
            className="flex-1 cursor-pointer select-none"
            onClick={() => setIsExpanded((p) => !p)}
          >
            <CardTitle className="text-sm flex items-center gap-2">
              Matriz de Migração
              {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </CardTitle>
            <CardDescription className="text-xs">
              Linhas = bucket origem | Colunas = bucket destino.
              Azul = permaneceu | Verde = curou | Vermelho = piorou.
            </CardDescription>
          </div>
          {parsMeses.length > 0 && (
            <Select value={parEfetivo} onValueChange={setParAtivo}>
              <SelectTrigger className="w-[260px] h-8 text-xs shrink-0 ml-3">
                <SelectValue placeholder="Par de meses" />
              </SelectTrigger>
              <SelectContent>
                {parsMeses.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {fmtDate(p.mes_origem)} → {fmtDate(p.mes_destino)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </CardHeader>

      {isExpanded && (
        <CardContent>
          <div className="overflow-x-auto">
            <table className="text-xs w-full border-collapse">
              <thead>
                <tr>
                  <th className="p-2 border text-left bg-muted/30 font-medium">Orig\Dest</th>
                  {faixas.map((d) => (
                    <th key={d} className="p-2 border text-center bg-muted/30 font-medium"
                      style={{ color: BUCKET_COLORS[d] }}>
                      {BUCKET_LABELS[d]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {faixas.map((orig) => (
                  <tr key={orig}>
                    <td className="p-2 border font-bold" style={{ color: BUCKET_COLORS[orig] }}>
                      {BUCKET_LABELS[orig]}
                    </td>
                    {faixas.map((dest) => {
                      const v = getValor(orig, dest);
                      return (
                        <td
                          key={dest}
                          className="p-2 border text-right"
                          style={{ backgroundColor: cellColor(orig, dest) }}
                          title={v > 0 ? fmtBRL(v) : undefined}
                        >
                          {v > 0 ? (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${(v / 1_000).toFixed(0)}K`) : "·"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Valores em VP (R$). "·" = sem ativos nesta transição. Hover para ver valor exato.
          </p>
        </CardContent>
      )}
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────
// Componente: Alertas de Qualidade
// ──────────────────────────────────────────────────────────────
function AlertasQualidade({ rows }: { rows: Alerta[] }) {
  if (rows.length === 0) return null;

  const ALERT_STYLES: Record<string, string> = {
    sem_chave_confiavel:    "text-amber-700 bg-amber-50  border-amber-200",
    sem_vencimento:         "text-orange-700 bg-orange-50 border-orange-200",
    duplicidade_chave_mes:  "text-blue-700  bg-blue-50   border-blue-200",
    historico_insuficiente: "text-red-700   bg-red-50    border-red-200",
  };

  const ALERT_LABELS: Record<string, string> = {
    sem_chave_confiavel:    "Chave composta",
    sem_vencimento:         "Sem vencimento",
    duplicidade_chave_mes:  "Duplicidade",
    historico_insuficiente: "Histórico insuficiente",
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          Alertas de Qualidade da Base
        </CardTitle>
        <CardDescription className="text-xs">
          Limitações identificadas na base de estoque. Não impedem o cálculo,
          mas devem ser considerados na interpretação dos resultados.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((a, i) => (
          <div
            key={i}
            className={cn(
              "flex items-start gap-3 rounded-md border p-3",
              ALERT_STYLES[a.tipo_alerta] ?? "text-muted-foreground bg-muted/30 border-border"
            )}
          >
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-xs shrink-0">
                  {ALERT_LABELS[a.tipo_alerta] ?? a.tipo_alerta}
                </Badge>
                <span className="text-xs font-medium">
                  {a.nome_fundo || a.doc_fundo}
                </span>
                {a.data_referencia && (
                  <span className="text-xs text-muted-foreground">
                    {fmtDate(a.data_referencia)}
                  </span>
                )}
                <span className="text-xs font-bold">
                  {a.quantidade > 1 ? `${a.quantidade} ocorrências` : "1 ocorrência"}
                </span>
              </div>
              <p className="text-xs mt-1 leading-relaxed">{a.descricao}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────
// Componente Principal
// ──────────────────────────────────────────────────────────────
export default function CreditoRollRate() {
  const [selectedFundo, setSelectedFundo] = useState<string>("");

  // ── Fundos disponíveis ──────────────────────────────────────
  const { data: fundosRaw = [] } = useQuery({
    queryKey: ["rollrate-fundos"],
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_estoque_fidc_por_faixa")
        .select("doc_fundo, nome_fundo")
        .limit(500);
      if (error) throw error;
      const uniq = new Map<string, string>();
      (data ?? []).forEach((r: EstoquePorFaixa) => uniq.set(r.doc_fundo, r.nome_fundo));
      return Array.from(uniq.entries()).map(([doc_fundo, nome_fundo]) => ({ doc_fundo, nome_fundo }));
    },
  });

  const efFundo = selectedFundo || fundosRaw[0]?.doc_fundo || "";

  // ── Resumo gerencial ────────────────────────────────────────
  const { data: resumoList = [], isLoading: loadingResumo } = useQuery({
    queryKey: ["rollrate-resumo", efFundo],
    enabled: !!efFundo,
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_estoque_fidc_resumo_gerencial")
        .select("*")
        .eq("doc_fundo", efFundo);
      if (error) throw error;
      return (data ?? []) as ResumoGerencial[];
    },
  });
  const resumo = resumoList[0] ?? null;

  // ── Datas disponíveis para este fundo ───────────────────────
  const { data: datasDisponiveis = [] } = useQuery({
    queryKey: ["rollrate-datas", efFundo],
    enabled: !!efFundo,
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_estoque_fidc_por_faixa")
        .select("data_referencia")
        .eq("doc_fundo", efFundo)
        .order("data_referencia", { ascending: false });
      if (error) throw error;
      return Array.from(new Set((data ?? []).map((r: EstoquePorFaixa) => r.data_referencia))) as string[];
    },
  });

  const [selectedData, setSelectedData] = useState<string>("");
  const efData = selectedData || datasDisponiveis[0] || "";

  // ── Estoque por faixa (data selecionada) ────────────────────
  const { data: estoquePorFaixa = [], isLoading: loadingEstoque } = useQuery({
    queryKey: ["rollrate-estoque", efFundo, efData],
    enabled: !!efFundo && !!efData,
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_estoque_fidc_por_faixa")
        .select("*")
        .eq("doc_fundo", efFundo)
        .eq("data_referencia", efData)
        .order("faixa_calculada", { ascending: true });
      if (error) throw error;
      return (data ?? []) as EstoquePorFaixa[];
    },
  });

  // ── Roll rate ────────────────────────────────────────────────
  const { data: rollRateRows = [], isLoading: loadingRollRate } = useQuery({
    queryKey: ["rollrate-rollrate", efFundo],
    enabled: !!efFundo,
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_estoque_fidc_roll_rate")
        .select("*")
        .eq("doc_fundo", efFundo)
        .order("mes_origem", { ascending: true })
        .order("faixa_origem", { ascending: true });
      if (error) throw error;
      return (data ?? []) as RollRate[];
    },
  });

  // ── Média 3 meses ────────────────────────────────────────────
  const { data: media3mRows = [], isLoading: loadingMedia } = useQuery({
    queryKey: ["rollrate-media3m", efFundo],
    enabled: !!efFundo,
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_estoque_fidc_roll_rate_media_3m")
        .select("*")
        .eq("doc_fundo", efFundo)
        .order("faixa_origem", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Media3m[];
    },
  });

  // ── Matriz de migração ───────────────────────────────────────
  const { data: matrizRows = [], isLoading: loadingMatriz } = useQuery({
    queryKey: ["rollrate-matriz", efFundo],
    enabled: !!efFundo,
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_estoque_fidc_matriz_migracao")
        .select("*")
        .eq("doc_fundo", efFundo)
        .order("mes_origem", { ascending: true });
      if (error) throw error;
      return (data ?? []) as MatrizMigracao[];
    },
  });

  // ── Alertas de qualidade ─────────────────────────────────────
  const { data: alertas = [] } = useQuery({
    queryKey: ["rollrate-alertas", efFundo],
    enabled: !!efFundo,
    queryFn: async () => {
      const { data, error } = await db
        .from("vw_estoque_fidc_alertas_qualidade")
        .select("*")
        .eq("doc_fundo", efFundo)
        .order("data_referencia", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Alerta[];
    },
  });

  const isLoading = loadingResumo || loadingEstoque || loadingRollRate || loadingMedia || loadingMatriz;

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-5">

        {/* ── Cabeçalho ─────────────────────────────────────── */}
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3 border-b border-border pb-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight uppercase flex items-center gap-2">
              <TrendingDown className="h-5 w-5 text-primary" />
              Roll Rate — Migração por Faixa
            </h1>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mt-1">
              Buckets canônicos · Over90 = 91–180 + 180+ · Melhoria de faixa ≠ Recovery Rate
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
            <Select value={efFundo} onValueChange={(v) => { setSelectedFundo(v); setSelectedData(""); }}>
              <SelectTrigger className="w-[300px] h-8 text-xs">
                <SelectValue placeholder="Selecione o fundo" />
              </SelectTrigger>
              <SelectContent>
                {fundosRaw.map((f) => (
                  <SelectItem key={f.doc_fundo} value={f.doc_fundo}>
                    {f.nome_fundo || f.doc_fundo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {datasDisponiveis.length > 0 && (
              <Select value={efData} onValueChange={setSelectedData}>
                <SelectTrigger className="w-[180px] h-8 text-xs">
                  <SelectValue placeholder="Data-base" />
                </SelectTrigger>
                <SelectContent>
                  {datasDisponiveis.map((d) => (
                    <SelectItem key={d} value={d}>
                      {fmtDate(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        {/* ── Sem dados ─────────────────────────────────────── */}
        {!efFundo && (
          <Card className="border-amber-200 bg-amber-50/50">
            <CardContent className="pt-6 text-center">
              <p className="text-sm text-amber-700 font-medium">
                Nenhum dado de estoque FIDC encontrado.
              </p>
              <p className="text-xs text-amber-600 mt-1">
                Importe ao menos 1 arquivo CSV do Frontis na aba{" "}
                <span className="font-medium">Importações → Estoque FIDC</span> para habilitar esta análise.
              </p>
            </CardContent>
          </Card>
        )}

        {isLoading && efFundo && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isLoading && efFundo && (
          <div className="space-y-5">

            {/* Resumo gerencial */}
            <ResumoCards resumo={resumo} />

            {/* Alertas de qualidade */}
            <AlertasQualidade rows={alertas} />

            {/* Estoque por faixa */}
            <EstoquePorFaixaSection
              rows={estoquePorFaixa}
              docFundo={efFundo}
              dataReferencia={efData}
            />

            {/* Roll rate */}
            <RollRateTable rows={rollRateRows} />

            {/* Média 3 meses */}
            <Media3mTable rows={media3mRows} />

            {/* Matriz de migração (colapsável) */}
            <MatrizMigracaoSection rows={matrizRows} />

            {/* Nota de rodapé metodológica */}
            <Card className="bg-muted/30 border-dashed">
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  <strong>Limitações documentadas:</strong>{" "}
                  (1) Base monetária: valor_presente para todos os tipos de ativo.{" "}
                  (2) Vencimento futuro classificado como Adimplente (conservador).{" "}
                  (3) Registros sem vencimento excluídos do cálculo de bucket.{" "}
                  (4) Duplicidade da mesma chave no mesmo mês: soma de valor e pior bucket.{" "}
                  (5) Roll rate médio 3m sinalizado como incompleto com menos de 3 observações.{" "}
                  (6) Recovery Rate indisponível — requer fluxo transacional de caixa.{" "}
                  Este módulo gera <strong>insumos analíticos</strong> e não substitui deliberação de comitê.
                </p>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </Layout>
  );
}
