import { Fragment, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Loader2, ChevronDown, ChevronRight, FileSpreadsheet, FileText, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { UtilizacaoBar } from "@/components/credito/UtilizacaoBar";
import {
  type ExposicaoLimitePayload,
  type LinhaExposicaoLimite,
  type StatusExposicao,
  STATUS_LABEL,
  exposicaoExibicao,
  formatExposicao,
} from "@/lib/cadastroPartesExposicao";
import { formatBRL } from "@/lib/cadastroPartes";
import { cn } from "@/lib/utils";
import {
  exportExposicaoLimiteExcel,
  exportExposicaoLimitePDF,
} from "@/utils/cadastro-partes-export";

function formatCnpj(cnpj: string): string {
  const d = cnpj.replace(/\D/g, "");
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  return cnpj;
}

function StatusBadge({ status }: { status: StatusExposicao }) {
  const map: Record<StatusExposicao, string> = {
    BREACH: "bg-red-600 hover:bg-red-600",
    NAO_CADASTRADO: "bg-red-600 hover:bg-red-600",
    CAD_VENCIDO: "bg-amber-600 hover:bg-amber-600",
    ATENCAO: "bg-amber-500 hover:bg-amber-500",
    OK: "bg-emerald-600 hover:bg-emerald-600",
  };
  return <Badge className={cn("text-[10px]", map[status])}>{STATUS_LABEL[status]}</Badge>;
}

function rowBg(status: StatusExposicao): string {
  if (status === "BREACH" || status === "NAO_CADASTRADO") return "bg-red-50/80 dark:bg-red-950/20";
  if (status === "CAD_VENCIDO" || status === "ATENCAO") return "bg-amber-50/50 dark:bg-amber-950/15";
  return "";
}

type SortKey = "parte" | "exposicao" | "limite" | "pct_uso" | "validade" | "status";

function SortHeaderIcon({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return <ArrowUpDown className="h-3 w-3 opacity-40 shrink-0" />;
  return dir === "asc"
    ? <ArrowUp className="h-3 w-3 shrink-0" />
    : <ArrowDown className="h-3 w-3 shrink-0" />;
}

function compareLinhas(
  a: LinhaExposicaoLimite,
  b: LinhaExposicaoLimite,
  key: SortKey,
  dir: "asc" | "desc",
  vpLiquido: boolean,
): number {
  const mul = dir === "asc" ? 1 : -1;
  let cmp = 0;

  switch (key) {
    case "parte":
      cmp = a.parte.localeCompare(b.parte, "pt-BR");
      break;
    case "exposicao":
      cmp = exposicaoExibicao(a, vpLiquido) - exposicaoExibicao(b, vpLiquido);
      break;
    case "limite":
      cmp = (a.limite_operacao ?? -1) - (b.limite_operacao ?? -1);
      break;
    case "pct_uso":
      cmp = (a.pct_uso ?? -1) - (b.pct_uso ?? -1);
      break;
    case "validade": {
      const da = a.dt_validade ?? "";
      const db = b.dt_validade ?? "";
      if (!da && db) cmp = 1;
      else if (da && !db) cmp = -1;
      else cmp = da.localeCompare(db);
      break;
    }
    case "status":
      cmp = a.statusOrdem - b.statusOrdem;
      break;
  }

  return cmp * mul;
}

interface Props {
  fundoNome: string;
  fundoCnpj: string;
  payload: ExposicaoLimitePayload | null;
  loading: boolean;
  semEstoque: boolean;
  vpLiquido: boolean;
  onVpLiquidoChange: (v: boolean) => void;
}

export function ExposicaoLimiteTab({
  fundoNome,
  fundoCnpj,
  payload,
  loading,
  semEstoque,
  vpLiquido,
  onVpLiquidoChange,
}: Props) {
  const [expandedGrupos, setExpandedGrupos] = useState<Set<string>>(new Set());
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const linhasOrdenadas = useMemo(() => {
    if (!payload?.linhas.length) return [];
    return [...payload.linhas].sort((a, b) => compareLinhas(a, b, sortKey, sortDir, vpLiquido));
  }, [payload?.linhas, sortKey, sortDir, vpLiquido]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "parte" || key === "validade" ? "asc" : "desc");
    }
  };

  const SortTh = ({
    label,
    field,
    className,
  }: {
    label: string;
    field: SortKey;
    className?: string;
  }) => (
    <TableHead className={cn("text-xs font-bold uppercase p-0 text-center", className)}>
      <button
        type="button"
        className="flex items-center justify-center gap-1 w-full px-2 py-2.5 hover:bg-muted/80 transition-colors"
        onClick={() => handleSort(field)}
      >
        <span>{label}</span>
        <SortHeaderIcon active={sortKey === field} dir={sortDir} />
      </button>
    </TableHead>
  );

  const toggleGrupo = (id: string) => {
    setExpandedGrupos((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleExportPdf = async () => {
    if (!payload) return;
    setExportingPdf(true);
    try {
      await exportExposicaoLimitePDF({ fundo_nome: fundoNome, fundo_cnpj: fundoCnpj, payload });
    } finally {
      setExportingPdf(false);
    }
  };

  const handleExportXlsx = async () => {
    if (!payload) return;
    setExportingXlsx(true);
    try {
      await exportExposicaoLimiteExcel({ fundo_nome: fundoNome, fundo_cnpj: fundoCnpj, payload });
    } finally {
      setExportingXlsx(false);
    }
  };

  const renderLinha = (l: LinhaExposicaoLimite, indent = false) => {
    const exp = exposicaoExibicao(l, vpLiquido);
    const isGrupo = l.tipo === "grupo" && (l.filhos?.length ?? 0) > 0;
    const expanded = expandedGrupos.has(l.id);

    return (
      <Fragment key={l.id}>
        <TableRow className={cn(rowBg(l.status), indent && "bg-muted/30")}>
          <TableCell className={cn("py-2 px-2 text-sm font-medium w-[160px] max-w-[160px]", indent && "pl-6")}>
            <div className="flex items-center gap-1 min-w-0">
              {isGrupo && !indent && (
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => toggleGrupo(l.id)}
                >
                  {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
              )}
              <span className="truncate block min-w-0" title={l.parte}>{l.parte}</span>
              {l.tipo === "grupo" && <Badge variant="outline" className="text-[9px] shrink-0 px-1">G</Badge>}
            </div>
          </TableCell>
          <TableCell className="py-2 text-right tabular-nums text-sm whitespace-nowrap">
            {formatExposicao(exp)}
          </TableCell>
          <TableCell className="py-2 text-right tabular-nums text-sm whitespace-nowrap text-muted-foreground">
            {l.limite_operacao != null ? formatBRL(l.limite_operacao) : "sem limite"}
          </TableCell>
          <TableCell className="py-2 min-w-[120px]">
            <UtilizacaoBar pct={l.pct_uso} />
          </TableCell>
          <TableCell className={cn(
            "py-2 text-right tabular-nums text-sm font-semibold",
            l.pct_uso != null && l.pct_uso > 100 && "text-red-700",
            l.pct_uso != null && l.pct_uso >= 85 && l.pct_uso <= 100 && "text-amber-700",
            l.pct_uso != null && l.pct_uso < 85 && "text-emerald-700",
          )}>
            {l.pct_uso != null ? `${l.pct_uso.toFixed(1)}%` : "—"}
          </TableCell>
          <TableCell className="py-2 text-sm whitespace-nowrap text-muted-foreground">
            {l.dt_validade
              ? new Date(l.dt_validade + "T12:00:00").toLocaleDateString("pt-BR")
              : l.cadastrado ? "pendente" : "—"}
          </TableCell>
          <TableCell className="py-2 px-3 text-center w-[132px] min-w-[132px]">
            <StatusBadge status={l.status} />
          </TableCell>
        </TableRow>
        {isGrupo && expanded && l.filhos?.map((f) => (
          <TableRow key={`${l.id}-${f.doc}`} className="bg-muted/20">
            <TableCell className="py-1.5 pl-10 text-xs text-muted-foreground">
              <span className="font-mono">{formatCnpj(f.doc)}</span>
              <span className="ml-2">{f.nome}</span>
            </TableCell>
            <TableCell className="py-1.5 text-right tabular-nums text-xs">
              {formatExposicao(vpLiquido ? f.exposicao_liquida : f.exposicao_bruta)}
            </TableCell>
            <TableCell colSpan={5} className="py-1.5 text-xs text-muted-foreground">
              {f.qtd_titulos} título{f.qtd_titulos !== 1 ? "s" : ""}
            </TableCell>
          </TableRow>
        ))}
      </Fragment>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Exposição × Limite</CardTitle>
            <CardDescription className="mt-1">
              Estoque ref.{" "}
              <strong>
                {payload?.reference_date
                  ? new Date(payload.reference_date + "T12:00:00").toLocaleDateString("pt-BR")
                  : "—"}
              </strong>
              {" · "}
              <span className="inline-flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" /> OK
                <span className="inline-block w-2 h-2 rounded-full bg-amber-500" /> Atenção / Vencido
                <span className="inline-block w-2 h-2 rounded-full bg-red-600" /> Estouro / Não cadastrado
              </span>
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch id="vp-bruto" checked={!vpLiquido} onCheckedChange={(c) => onVpLiquidoChange(!c)} />
              <Label htmlFor="vp-bruto" className="text-xs cursor-pointer">
                {vpLiquido ? "VP líquido" : "VP bruto"}
              </Label>
            </div>
            <Button variant="outline" size="sm" disabled={!payload || exportingPdf} onClick={handleExportPdf}>
              {exportingPdf ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <FileText className="h-3.5 w-3.5 mr-1" />}
              PDF
            </Button>
            <Button variant="outline" size="sm" disabled={!payload || exportingXlsx} onClick={handleExportXlsx}>
              {exportingXlsx ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <FileSpreadsheet className="h-3.5 w-3.5 mr-1" />}
              Excel
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
        )}
        {!loading && semEstoque && (
          <p className="text-sm text-muted-foreground py-8 text-center">
            Nenhum estoque FIDC importado para este fundo. Importe o estoque em Dados para calcular exposição.
          </p>
        )}
        {!loading && !semEstoque && payload && payload.linhas.length === 0 && (
          <p className="text-sm text-muted-foreground py-8 text-center">
            Nenhuma exposição de cedentes cadastrados no estoque atual.
          </p>
        )}
        {!loading && payload && payload.linhas.length > 0 && (
          <>
            <div className="max-h-[min(70vh,800px)] overflow-auto rounded-md border">
              <Table>
                <TableHeader className="bg-muted/60 sticky top-0 z-10">
                  <TableRow>
                    <SortTh label="Parte" field="parte" className="w-[160px] max-w-[160px]" />
                    <SortTh
                      label={`Exposição ${vpLiquido ? "VP líq." : "VP bruto"}`}
                      field="exposicao"
                      className="w-[128px]"
                    />
                    <SortTh label="Limite comitê" field="limite" className="w-[120px]" />
                    <TableHead className="text-xs font-bold uppercase w-[108px] px-2 py-2.5 text-center">
                      Utilização
                    </TableHead>
                    <SortTh label="% uso" field="pct_uso" className="w-[72px]" />
                    <SortTh label="Validade" field="validade" className="w-[92px]" />
                    <SortTh label="Status" field="status" className="w-[132px] min-w-[132px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {linhasOrdenadas.map((l) => renderLinha(l))}
                </TableBody>
              </Table>
            </div>
            <div className="mt-3 flex justify-end border-t pt-3">
              <p className="text-sm text-muted-foreground">
                Total carteira ({vpLiquido ? "VP líquido" : "VP bruto"}):{" "}
                <strong className="text-foreground tabular-nums">
                  {formatExposicao(vpLiquido ? payload.total_carteira_liquida : payload.total_carteira_bruta)}
                </strong>
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
