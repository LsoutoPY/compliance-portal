import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, ChevronDown, ChevronRight, FileText, AlertCircle, Info } from "lucide-react";
import { UtilizacaoBar } from "@/components/credito/UtilizacaoBar";
import {
  type ExposicaoLimitePayload,
  type AlertaCadastroParte,
  type SeveridadeAlerta,
} from "@/lib/cadastroPartesExposicao";
import { formatBRL } from "@/lib/cadastroPartes";
import { cn } from "@/lib/utils";
import { exportAlertasCadastroPDF } from "@/utils/cadastro-partes-export";

function formatCnpj(doc: string): string {
  const d = doc.replace(/\D/g, "");
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  return doc;
}

const SEVERIDADE_STRIPE: Record<SeveridadeAlerta, string> = {
  critico: "border-l-red-600",
  alerta: "border-l-amber-500",
  info: "border-l-blue-500",
};

const SEVERIDADE_HEADER_BG: Record<SeveridadeAlerta, string> = {
  critico: "bg-red-50/80 dark:bg-red-950/25",
  alerta: "bg-amber-50/80 dark:bg-amber-950/25",
  info: "bg-blue-50/60 dark:bg-blue-950/20",
};

function SeveridadeIcon({ s }: { s: SeveridadeAlerta }) {
  if (s === "critico") return <AlertCircle className="h-4 w-4 text-red-600 shrink-0" />;
  if (s === "alerta") return <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />;
  return <Info className="h-4 w-4 text-blue-600 shrink-0" />;
}

function AlertaItensTable({ alerta }: { alerta: AlertaCadastroParte }) {
  const { id, itens } = alerta;

  if (id === "breach" || id === "nao-cadastrado") {
    const isBreach = id === "breach";
    return (
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="text-[10px] font-bold uppercase min-w-[180px]">Parte</TableHead>
            <TableHead className="text-[10px] font-bold uppercase font-mono w-[150px]">CNPJ</TableHead>
            <TableHead className="text-[10px] font-bold uppercase text-right w-[120px]">Exposição</TableHead>
            {isBreach && (
              <>
                <TableHead className="text-[10px] font-bold uppercase text-right w-[120px]">Limite</TableHead>
                <TableHead className="text-[10px] font-bold uppercase w-[110px]">Utilização</TableHead>
                <TableHead className="text-[10px] font-bold uppercase text-right w-[64px]">% uso</TableHead>
                <TableHead className="text-[10px] font-bold uppercase w-[90px]">Escopo</TableHead>
              </>
            )}
            {!isBreach && (
              <TableHead className="text-[10px] font-bold uppercase text-right w-[72px]">Títulos</TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {itens.map((it, idx) => (
            <TableRow
              key={`${it.doc}-${idx}`}
              className={cn(isBreach ? "bg-red-50/50 dark:bg-red-950/15" : "bg-red-50/40 dark:bg-red-950/10")}
            >
              <TableCell className="py-2 text-sm font-medium max-w-[220px] truncate" title={it.nome}>
                {it.nome}
              </TableCell>
              <TableCell className="py-2 font-mono text-[11px] whitespace-nowrap">{formatCnpj(it.doc)}</TableCell>
              <TableCell className="py-2 text-right tabular-nums text-sm font-semibold whitespace-nowrap">
                {it.exposicao != null ? formatBRL(it.exposicao) : "—"}
              </TableCell>
              {isBreach && (
                <>
                  <TableCell className="py-2 text-right tabular-nums text-sm text-muted-foreground whitespace-nowrap">
                    {it.limite != null ? formatBRL(it.limite) : "—"}
                  </TableCell>
                  <TableCell className="py-2"><UtilizacaoBar pct={it.pct_uso ?? null} /></TableCell>
                  <TableCell className={cn(
                    "py-2 text-right tabular-nums text-sm font-bold",
                    (it.pct_uso ?? 0) > 100 ? "text-red-700" : "text-amber-700",
                  )}>
                    {it.pct_uso != null ? `${it.pct_uso.toFixed(1)}%` : "—"}
                  </TableCell>
                  <TableCell className="py-2 text-xs">
                    {it.grupoChave ? (
                      <Badge variant="outline" className="text-[9px]">Grupo {it.grupoChave}</Badge>
                    ) : (
                      <span className="text-muted-foreground">Individual</span>
                    )}
                  </TableCell>
                </>
              )}
              {!isBreach && (
                <TableCell className="py-2 text-right tabular-nums text-sm">{it.qtd_titulos ?? "—"}</TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  if (id === "cad-vencido") {
    return (
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="text-[10px] font-bold uppercase min-w-[180px]">Parte</TableHead>
            <TableHead className="text-[10px] font-bold uppercase font-mono w-[150px]">CNPJ</TableHead>
            <TableHead className="text-[10px] font-bold uppercase text-right w-[120px]">Exposição</TableHead>
            <TableHead className="text-[10px] font-bold uppercase text-right w-[120px]">Limite</TableHead>
            <TableHead className="text-[10px] font-bold uppercase w-[110px]">Utilização</TableHead>
            <TableHead className="text-[10px] font-bold uppercase text-right w-[64px]">% uso</TableHead>
            <TableHead className="text-[10px] font-bold uppercase text-right w-[80px]">Vencido</TableHead>
            <TableHead className="text-[10px] font-bold uppercase w-[80px]">Escopo</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {itens.map((it, idx) => (
            <TableRow key={`${it.doc}-${idx}`} className="bg-amber-50/40 dark:bg-amber-950/10">
              <TableCell className="py-2 text-sm font-medium max-w-[220px] truncate" title={it.nome}>{it.nome}</TableCell>
              <TableCell className="py-2 font-mono text-[11px] whitespace-nowrap">{formatCnpj(it.doc)}</TableCell>
              <TableCell className="py-2 text-right tabular-nums text-sm font-semibold whitespace-nowrap">
                {it.exposicao != null ? formatBRL(it.exposicao) : "—"}
              </TableCell>
              <TableCell className="py-2 text-right tabular-nums text-sm text-muted-foreground whitespace-nowrap">
                {it.limite != null ? formatBRL(it.limite) : "—"}
              </TableCell>
              <TableCell className="py-2"><UtilizacaoBar pct={it.pct_uso ?? null} /></TableCell>
              <TableCell className="py-2 text-right tabular-nums text-sm font-semibold text-amber-800">
                {it.pct_uso != null ? `${it.pct_uso.toFixed(1)}%` : "—"}
              </TableCell>
              <TableCell className="py-2 text-right tabular-nums text-sm font-semibold text-red-700 whitespace-nowrap">
                {it.dias != null && it.dias < 0 ? `${Math.abs(it.dias)}d` : "—"}
              </TableCell>
              <TableCell className="py-2 text-xs">
                {it.grupoChave ? (
                  <Badge variant="outline" className="text-[9px]">Grupo {it.grupoChave}</Badge>
                ) : (
                  <span className="text-muted-foreground">Individual</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  if (id === "vence-30") {
    return (
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="text-[10px] font-bold uppercase min-w-[200px]">Parte</TableHead>
            <TableHead className="text-[10px] font-bold uppercase font-mono w-[150px]">CNPJ</TableHead>
            <TableHead className="text-[10px] font-bold uppercase text-right w-[80px]">Dias</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {itens.map((it, idx) => (
            <TableRow key={`${it.doc}-${idx}`}>
              <TableCell className="py-2 text-sm font-medium">{it.nome}</TableCell>
              <TableCell className="py-2 font-mono text-[11px]">{formatCnpj(it.doc)}</TableCell>
              <TableCell className="py-2 text-right tabular-nums text-sm font-semibold text-amber-700">
                {it.dias != null ? `${it.dias}d` : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  if (id === "revisao-pendente") {
    return (
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="text-[10px] font-bold uppercase min-w-[240px]">Parte</TableHead>
            <TableHead className="text-[10px] font-bold uppercase font-mono w-[160px]">CNPJ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {itens.map((it, idx) => (
            <TableRow key={`${it.doc}-${idx}`}>
              <TableCell className="py-2 text-sm font-medium">{it.nome}</TableCell>
              <TableCell className="py-2 font-mono text-[11px]">{formatCnpj(it.doc)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  // import-data-invalida e fallback
  return (
    <Table>
      <TableHeader className="bg-muted/50">
        <TableRow>
          <TableHead className="text-[10px] font-bold uppercase w-[60px]">Ref.</TableHead>
          <TableHead className="text-[10px] font-bold uppercase min-w-[200px]">Detalhe</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {itens.map((it, idx) => (
          <TableRow key={`${it.doc}-${idx}`}>
            <TableCell className="py-2 font-mono text-[11px]">{it.doc}</TableCell>
            <TableCell className="py-2 text-sm text-muted-foreground">{it.nome}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function AlertaCard({ alerta }: { alerta: AlertaCadastroParte }) {
  const [open, setOpen] = useState(alerta.severidade === "critico");

  return (
    <div
      className={cn(
        "rounded-lg border border-border overflow-hidden border-l-4 bg-card shadow-sm",
        SEVERIDADE_STRIPE[alerta.severidade],
      )}
    >
      <button
        type="button"
        className={cn(
          "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30",
          SEVERIDADE_HEADER_BG[alerta.severidade],
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-muted-foreground shrink-0">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        <SeveridadeIcon s={alerta.severidade} />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-sm text-foreground">{alerta.titulo}</p>
            <Badge
              variant="outline"
              className={cn(
                "text-[9px] uppercase font-semibold",
                alerta.severidade === "critico" && "border-red-300 text-red-700",
                alerta.severidade === "alerta" && "border-amber-300 text-amber-800",
                alerta.severidade === "info" && "border-blue-300 text-blue-700",
              )}
            >
              {alerta.severidade}
            </Badge>
            {alerta.motivo_motor && (
              <Badge variant="secondary" className="font-mono text-[9px]">{alerta.motivo_motor}</Badge>
            )}
            <Badge variant="outline" className="text-[9px] tabular-nums ml-auto">
              {alerta.itens.length} {alerta.itens.length === 1 ? "item" : "itens"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{alerta.descricao}</p>
        </div>
      </button>
      {open && alerta.itens.length > 0 && (
        <div className="border-t border-border bg-background">
          <div className="overflow-x-auto">
            <AlertaItensTable alerta={alerta} />
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  fundoNome: string;
  fundoCnpj: string;
  payload: ExposicaoLimitePayload | null;
  loading: boolean;
}

export function AlertasCadastroTab({ fundoNome, fundoCnpj, payload, loading }: Props) {
  const [exportingPdf, setExportingPdf] = useState(false);

  const handleExport = async () => {
    if (!payload) return;
    setExportingPdf(true);
    try {
      await exportAlertasCadastroPDF({ fundo_nome: fundoNome, fundo_cnpj: fundoCnpj, payload });
    } finally {
      setExportingPdf(false);
    }
  };

  const contadores = payload?.contadores_alerta ?? { critico: 0, alerta: 0, info: 0 };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Alertas</CardTitle>
            <CardDescription>
              Priorizados por severidade — derivados da exposição atual vs cadastro de comitê.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" disabled={!payload || exportingPdf} onClick={handleExport}>
            {exportingPdf ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <FileText className="h-3.5 w-3.5 mr-1" />}
            PDF
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          <div className="inline-flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 dark:bg-red-950/30 dark:border-red-900">
            <span className="h-2 w-2 rounded-full bg-red-600" />
            <span className="text-xs font-semibold text-red-800 dark:text-red-300">Crítico</span>
            <span className="text-sm font-bold tabular-nums text-red-700">{contadores.critico}</span>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 dark:bg-amber-950/30 dark:border-amber-900">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            <span className="text-xs font-semibold text-amber-900 dark:text-amber-300">Alerta</span>
            <span className="text-sm font-bold tabular-nums text-amber-800">{contadores.alerta}</span>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 dark:bg-blue-950/30 dark:border-blue-900">
            <span className="h-2 w-2 rounded-full bg-blue-500" />
            <span className="text-xs font-semibold text-blue-800 dark:text-blue-300">Info</span>
            <span className="text-sm font-bold tabular-nums text-blue-700">{contadores.info}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
        )}
        {!loading && (!payload || payload.alertas.length === 0) && (
          <p className="text-sm text-muted-foreground py-8 text-center">
            Nenhum alerta no momento. Importe estoque e cadastro para monitorar exposição e validade.
          </p>
        )}
        {!loading && payload && payload.alertas.length > 0 && (
          <div className="space-y-4">
            {payload.alertas.map((a) => (
              <AlertaCard key={a.id} alerta={a} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
