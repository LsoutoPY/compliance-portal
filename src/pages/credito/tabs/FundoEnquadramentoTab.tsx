import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { KpiCard } from "@/components/credito/matriz/KpiCard";
import { SectionHeader } from "@/components/credito/matriz/SectionHeader";
import { cn } from "@/lib/utils";
import { formatBRL, formatPct, formatTaxa } from "@/lib/creditoMatriz";
import type {
  ConcentracaoParteCarteira,
  EnquadramentoCreditoRow,
  FundoResumoCredito,
} from "@/lib/creditoMatriz";

type Props = {
  resumo: FundoResumoCredito | null;
  concentracoes: ConcentracaoParteCarteira[];
  enquadramentos: EnquadramentoCreditoRow[];
  isLoadingResumo: boolean;
  isLoadingConcentracoes: boolean;
  isLoadingEnquadramento: boolean;
  errorResumo: Error | null;
  errorConcentracoes: Error | null;
  errorEnquadramento: Error | null;
};

function formatLimite(v: number | null) {
  if (v == null) return "—";
  return Math.abs(v) <= 1 ? formatPct(v) : formatBRL(v);
}

function StatusBadge({ status }: { status: EnquadramentoCreditoRow["status"] }) {
  const config = status === "violacao"
    ? { label: "Violação", cls: "border-red-500/40 text-red-500 bg-red-500/10", Icon: XCircle }
    : status === "alerta"
      ? { label: "Alerta", cls: "border-amber-500/40 text-amber-600 bg-amber-500/10", Icon: AlertTriangle }
      : { label: "Conforme", cls: "border-emerald-500/40 text-emerald-600 bg-emerald-500/10", Icon: CheckCircle2 };
  const Icon = config.Icon;
  return <Badge variant="outline" className={cn("gap-1 text-[10px]", config.cls)}><Icon className="h-3 w-3" />{config.label}</Badge>;
}

type StatusConcentracao = "ok" | "violacao" | "alerta" | "isento" | "indisponivel";

type ApuracaoConcentracao = {
  percentualPl: number | null;
  limitePctPl: number | null;
  status: StatusConcentracao;
  regraCodigo: string | null;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizarDocumento(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizarNome(value: string | null | undefined): string {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function correspondeParte(row: ConcentracaoParteCarteira, item: JsonRecord): boolean {
  const documentoLinha = normalizarDocumento(row.doc_parte);
  const documentoRegra = normalizarDocumento(typeof item.cnpj === "string" ? item.cnpj : null);
  if (documentoLinha && documentoRegra) return documentoLinha === documentoRegra;

  const nomeLinha = normalizarNome(row.nome_parte);
  const nomeRegra = normalizarNome(typeof item.nome === "string" ? item.nome : null);
  return Boolean(nomeLinha && nomeRegra && nomeLinha === nomeRegra);
}

function obterApuracaoConcentracao(
  row: ConcentracaoParteCarteira,
  enquadramentos: EnquadramentoCreditoRow[],
): ApuracaoConcentracao {
  const categoriaAlvo = row.tipo_parte === "sacado" ? "maior devedor" : "maior cedente/emissor";
  const regras = enquadramentos.filter((regra) => {
    if (regra.regra_categoria !== "fidc-concentracao") return false;
    const detalhes = asRecord(regra.detalhes);
    return String(detalhes?.categoria_alvo ?? "").toLowerCase() === categoriaAlvo;
  });

  for (const regra of regras) {
    const detalhes = asRecord(regra.detalhes);
    const ativos = Array.isArray(detalhes?.ativos_contabilizados) ? detalhes.ativos_contabilizados : [];
    const item = ativos.map(asRecord).find((ativo): ativo is JsonRecord => ativo != null && correspondeParte(row, ativo));
    if (!item) continue;

    const percentualPl = asNumber(item.percentual);
    const limitePctPl = asNumber(item.limite_aplicavel) ?? regra.valor_limite ?? asNumber(detalhes?.limite_max);
    return {
      percentualPl,
      limitePctPl,
      status: percentualPl != null && limitePctPl != null && percentualPl > limitePctPl ? "violacao" : "ok",
      regraCodigo: regra.regra_codigo,
    };
  }

  for (const regra of regras) {
    const detalhes = asRecord(regra.detalhes);
    const isentos = Array.isArray(detalhes?.sacados_com_excecao) ? detalhes.sacados_com_excecao : [];
    const item = isentos.map(asRecord).find((ativo): ativo is JsonRecord => ativo != null && correspondeParte(row, ativo));
    if (item) {
      return {
        percentualPl: asNumber(item.percentual),
        limitePctPl: null,
        status: "isento",
        regraCodigo: regra.regra_codigo,
      };
    }
  }

  return { percentualPl: null, limitePctPl: null, status: regras.length > 0 ? "indisponivel" : "alerta", regraCodigo: null };
}

function StatusConcentracaoBadge({ status }: { status: StatusConcentracao }) {
  const config = status === "violacao"
    ? { label: "Violação", cls: "border-red-500/40 text-red-500 bg-red-500/10", Icon: XCircle }
    : status === "ok"
      ? { label: "Conforme", cls: "border-emerald-500/40 text-emerald-600 bg-emerald-500/10", Icon: CheckCircle2 }
      : status === "isento"
        ? { label: "Isento", cls: "border-sky-500/40 text-sky-600 bg-sky-500/10", Icon: Info }
        : { label: "Sem apuração", cls: "border-muted-foreground/30 text-muted-foreground bg-muted/50", Icon: AlertTriangle };
  const Icon = config.Icon;
  return <Badge variant="outline" className={cn("gap-1 whitespace-nowrap text-[10px]", config.cls)}><Icon className="h-3 w-3" />{config.label}</Badge>;
}

function isRegraMonitoradaFidc(row: EnquadramentoCreditoRow): boolean {
  return row.regra_categoria === "fidc-concentracao" || row.regra_codigo.toUpperCase() === "CLASSE_FIDC_67";
}

function ConcentracaoCard({
  titulo,
  rows,
  enquadramentos,
  isLoading,
  isLoadingApuracao,
  error,
}: {
  titulo: string;
  rows: ConcentracaoParteCarteira[];
  enquadramentos: EnquadramentoCreditoRow[];
  isLoading: boolean;
  isLoadingApuracao: boolean;
  error: Error | null;
}) {
  const topRows = rows.slice(0, 5);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{titulo}</CardTitle>
        <p className="text-xs text-muted-foreground">Top 5 por valor presente; limite e situação vêm da apuração oficial da regra, na base e PL configurados.</p>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-red-500">{error.message}</p>
        ) : isLoading || isLoadingApuracao ? (
          <Skeleton className="h-52 w-full" />
        ) : topRows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Sem dados de concentração.</p>
        ) : (
          <div className="overflow-x-auto border rounded-md">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Parte</TableHead><TableHead className="text-right">VP</TableHead>
                <TableHead className="text-right">% carteira</TableHead><TableHead className="text-right">% PL regra</TableHead>
                <TableHead className="text-right">Limite</TableHead><TableHead>Situação</TableHead>
              </TableRow></TableHeader>
              <TableBody>{topRows.map((row) => {
                const apuracao = obterApuracaoConcentracao(row, enquadramentos);
                const percentualExibido = apuracao.percentualPl ?? row.pct_pl;
                return (
                <TableRow key={`${row.doc_fundo}-${row.doc_parte}`}>
                  <TableCell className="max-w-[180px] truncate font-medium" title={row.nome_parte ?? row.doc_parte}>{row.nome_parte ?? row.doc_parte}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatBRL(row.vp_parte)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatPct(row.pct_carteira)}</TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", apuracao.status === "violacao" && "text-red-600 font-semibold")}>
                    {percentualExibido != null ? formatPct(percentualExibido) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {apuracao.status === "isento" ? "Isento" : apuracao.limitePctPl != null ? formatPct(apuracao.limitePctPl) : "—"}
                  </TableCell>
                  <TableCell title={apuracao.regraCodigo ? `Regra ${apuracao.regraCodigo}` : undefined}><StatusConcentracaoBadge status={apuracao.status} /></TableCell>
                </TableRow>
                );
              })}</TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function FundoEnquadramentoTab({
  resumo, concentracoes, enquadramentos, isLoadingResumo, isLoadingConcentracoes,
  isLoadingEnquadramento, errorResumo, errorConcentracoes, errorEnquadramento,
}: Props) {
  const cedentes = concentracoes.filter((row) => row.tipo_parte === "cedente");
  const sacados = concentracoes.filter((row) => row.tipo_parte === "sacado");
  const enquadramentosMonitorados = enquadramentos.filter(isRegraMonitoradaFidc);
  const violacoes = enquadramentosMonitorados.filter((row) => row.status === "violacao").length;
  const alertas = enquadramentosMonitorados.filter((row) => row.status === "alerta").length;
  const subRentabilidade = resumo?.qtd_classes === 1
    ? "retorno da cota • sem ponderação"
    : resumo && resumo.qtd_classes > 1
      ? `${resumo.qtd_classes} classes — sem consolidação`
      : "sem snapshot de rentabilidade";

  if (errorResumo) {
    return <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>{errorResumo.message}</AlertDescription></Alert>;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard label="PL do fundo / classe" value={resumo?.pl_total != null ? formatBRL(resumo.pl_total) : "—"}
          sub={resumo ? `${resumo.qtd_classes} classe(s) com PL` : undefined} variant="neutral" isLoading={isLoadingResumo} />
        <KpiCard label="Rentabilidade da classe (dia)" value={formatTaxa(resumo?.rentabilidade_dia_pct, 2)} sub={subRentabilidade} variant="info" isLoading={isLoadingResumo} />
        <KpiCard label="Rentabilidade da classe (mês)" value={formatTaxa(resumo?.rentabilidade_mes_pct, 2)} sub={subRentabilidade} variant="info" isLoading={isLoadingResumo} />
        <KpiCard label="Rentabilidade da classe (ano)" value={formatTaxa(resumo?.rentabilidade_ano_pct, 2)} sub={subRentabilidade} variant="info" isLoading={isLoadingResumo} />
        <KpiCard label="Rentabilidade da classe (12m)" value={formatTaxa(resumo?.rentabilidade_12m_pct, 2)} sub={subRentabilidade} variant="info" isLoading={isLoadingResumo} />
      </div>

      <Alert className="bg-muted/25">
        <Info className="h-4 w-4" />
        <AlertDescription className="text-xs">
          PL utiliza o snapshot de rentabilidade na mesma data-base. A rentabilidade é sempre o retorno da cota da classe; quando houver mais de uma classe, o sistema não cria uma rentabilidade consolidada.
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ConcentracaoCard titulo="Concentração por cedente" rows={cedentes} enquadramentos={enquadramentosMonitorados} isLoading={isLoadingConcentracoes} isLoadingApuracao={isLoadingEnquadramento} error={errorConcentracoes} />
        <ConcentracaoCard titulo="Concentração por sacado" rows={sacados} enquadramentos={enquadramentosMonitorados} isLoading={isLoadingConcentracoes} isLoadingApuracao={isLoadingEnquadramento} error={errorConcentracoes} />
      </div>

      <div>
        <SectionHeader title="Enquadramento FIDC" description="Resultados já apurados no módulo de Enquadramento: concentração e mínimo de 67% em direitos creditórios." />
        {errorEnquadramento ? (
          <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>{errorEnquadramento.message}</AlertDescription></Alert>
        ) : isLoadingEnquadramento ? (
          <Skeleton className="h-48 w-full" />
        ) : enquadramentosMonitorados.length === 0 ? (
          <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            Sem resultado de concentração ou do mínimo de 67% em direitos creditórios nesta seleção. Esta aba apenas consulta a última verificação já registrada no módulo de Enquadramento.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Regra</TableHead><TableHead>Categoria</TableHead><TableHead>Status</TableHead>
                <TableHead className="text-right">Atual</TableHead><TableHead className="text-right">Limite</TableHead>
              </TableRow></TableHeader>
              <TableBody>{enquadramentosMonitorados.map((row) => (
                <TableRow key={`${row.doc_fundo}-${row.regra_codigo}-${row.verificado_em ?? ""}`}>
                  <TableCell><p className="font-medium">{row.regra_descricao ?? row.regra_codigo}</p><p className="font-mono text-[10px] text-muted-foreground">{row.regra_codigo}</p></TableCell>
                  <TableCell className="text-xs capitalize">{row.regra_categoria}</TableCell>
                  <TableCell><StatusBadge status={row.status} /></TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatLimite(row.valor_atual)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatLimite(row.valor_limite)}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </div>
        )}
        {!isLoadingEnquadramento && enquadramentosMonitorados.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">{violacoes} violação(ões) e {alertas} alerta(s) na seleção.</p>
        )}
      </div>
    </div>
  );
}
