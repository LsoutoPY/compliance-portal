import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { downloadFundoRegrasImportTemplate } from "@/utils/fundo-regras-export";
import {
  describeFundoRegrasImportProblema,
  type LinhaFundoRegrasImportPreview,
} from "@/lib/fundoRegrasImportParse";
import { fundoRegrasDisplayLabel } from "@/lib/fundoRegrasUtils";
import { getFreshAccessToken } from "@/lib/supabaseFunctions";

async function invokeMultipartImport(
  formData: FormData,
): Promise<{ data: Record<string, unknown> | null; error: Error | null }> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  const token = await getFreshAccessToken();
  const resp = await fetch(`${supabaseUrl}/functions/v1/importar-fundo-regras`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
    body: formData,
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      msg = (j?.error as string) ?? msg;
    } catch {
      /* ignore */
    }
    return { data: null, error: new Error(msg) };
  }
  return { data: await resp.json(), error: null };
}

type ImportHistoricoRow = {
  id: string;
  arquivo_nome: string;
  status: string;
  total_linhas: number;
  linhas_aceitas: number;
  linhas_rejeitadas: number;
  created_at: string;
};

function formatCnpj(cnpj: string) {
  if (cnpj.length !== 14) return cnpj;
  return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

function fmtDateTime(iso: string) {
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return iso;
  }
}

export function FundoRegrasImportPanel() {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLinhas, setPreviewLinhas] = useState<LinhaFundoRegrasImportPreview[]>([]);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);

  const { data: historico = [], isLoading: loadingHistorico } = useQuery({
    queryKey: ["fundo-regras-importacoes"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fundo_regras_importacoes" as never)
        .select("id, arquivo_nome, status, total_linhas, linhas_aceitas, linhas_rejeitadas, created_at")
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      return (data ?? []) as ImportHistoricoRow[];
    },
  });

  const runDryRun = useCallback(async (file: File) => {
    setImportLoading(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("dry_run", "true");
    const { data, error } = await invokeMultipartImport(fd);
    setImportLoading(false);
    if (error || !data?.success) {
      toast.error(error?.message ?? String(data?.error ?? "Erro no preview"));
      return;
    }
    const preview = data.preview as { linhas?: LinhaFundoRegrasImportPreview[] };
    setPreviewLinhas(preview.linhas ?? []);
    setImportFile(file);
    setPreviewOpen(true);
  }, []);

  const confirmImport = useCallback(async () => {
    if (!importFile) return;
    const validas = previewLinhas.filter((l) => !l.rejeitada);
    if (validas.length === 0) {
      toast.error("Nenhuma linha válida para importar.");
      return;
    }
    setImportLoading(true);
    const fd = new FormData();
    fd.append("file", importFile);
    fd.append("dry_run", "false");
    fd.append("linhas_confirmadas", JSON.stringify(validas));
    const { data, error } = await invokeMultipartImport(fd);
    setImportLoading(false);
    if (error || !data?.success) {
      toast.error(error?.message ?? String(data?.error ?? "Erro na importação"));
      return;
    }
    toast.success(
      `${data.aceitas} vínculo(s) importado(s) — aguardando autorização na aba Aprovação.`,
    );
    setPreviewOpen(false);
    setPreviewLinhas([]);
    setImportFile(null);
    queryClient.invalidateQueries({ queryKey: ["fundo-regras"] });
    queryClient.invalidateQueries({ queryKey: ["fundo-regras-importacoes"] });
    queryClient.invalidateQueries({ queryKey: ["fundo-regras-pendentes"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard-regras"] });
  }, [importFile, previewLinhas, queryClient]);

  const handleDownloadTemplate = async () => {
    setDownloadingTemplate(true);
    try {
      await downloadFundoRegrasImportTemplate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao gerar modelo");
    } finally {
      setDownloadingTemplate(false);
    }
  };

  const validasCount = previewLinhas.filter((l) => !l.rejeitada).length;
  const rejeitadasCount = previewLinhas.filter((l) => l.rejeitada).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-primary" />
            Importação em lote (planilha)
          </CardTitle>
          <CardDescription className="text-xs">
            Cada linha define um vínculo fundo × regra com vigência própria. Vínculos importados ficam
            pendentes até autorização — o formulário manual continua ativo na hora.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={handleDownloadTemplate}
            disabled={downloadingTemplate}
          >
            {downloadingTemplate ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Baixar modelo
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void runDryRun(f);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            size="sm"
            className="gap-1.5 text-xs bg-[#003D27] hover:bg-[#197357]"
            onClick={() => fileRef.current?.click()}
            disabled={importLoading}
          >
            {importLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Enviar planilha
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Histórico de importações</CardTitle>
          <CardDescription className="text-xs">
            Arquivos processados com contagem de linhas aceitas e rejeitadas.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingHistorico ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : historico.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6 border border-dashed rounded-lg">
              Nenhuma importação registrada ainda.
            </p>
          ) : (
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="text-[10px] font-bold uppercase">Data</TableHead>
                    <TableHead className="text-[10px] font-bold uppercase">Arquivo</TableHead>
                    <TableHead className="text-[10px] font-bold uppercase text-center">Aceitas</TableHead>
                    <TableHead className="text-[10px] font-bold uppercase text-center">Rejeitadas</TableHead>
                    <TableHead className="text-[10px] font-bold uppercase text-center">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {historico.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-xs whitespace-nowrap">{fmtDateTime(row.created_at)}</TableCell>
                      <TableCell className="text-xs font-medium truncate max-w-[200px]" title={row.arquivo_nome}>
                        {row.arquivo_nome}
                      </TableCell>
                      <TableCell className="text-center text-xs tabular-nums text-emerald-700">
                        {row.linhas_aceitas}
                      </TableCell>
                      <TableCell className="text-center text-xs tabular-nums text-red-600">
                        {row.linhas_rejeitadas}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="outline" className="text-[10px] capitalize">
                          {row.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Prévia da importação</DialogTitle>
            <DialogDescription>
              {validasCount} linha(s) válida(s), {rejeitadasCount} rejeitada(s). Confirme para enviar à
              fila de autorização.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto border rounded-md">
            <Table>
              <TableHeader className="bg-muted/50 sticky top-0 z-10">
                <TableRow>
                  <TableHead className="text-[10px]">#</TableHead>
                  <TableHead className="text-[10px]">Fundo</TableHead>
                  <TableHead className="text-[10px]">Regra</TableHead>
                  <TableHead className="text-[10px]">Vigência</TableHead>
                  <TableHead className="text-[10px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {previewLinhas.map((l) => (
                  <TableRow key={l.linha} className={l.rejeitada ? "bg-red-50/60 dark:bg-red-950/20" : undefined}>
                    <TableCell className="text-xs">{l.linha}</TableCell>
                    <TableCell className="text-xs">
                      <div className="font-medium">
                        {l.fundo_nome
                          ? fundoRegrasDisplayLabel(l.fundo_nome, l.fundo_isin)
                          : l.fundo_cnpj
                            ? formatCnpj(l.fundo_cnpj)
                            : "—"}
                      </div>
                      {l.fundo_cnpj && (
                        <div className="text-[10px] font-mono text-muted-foreground">
                          {formatCnpj(l.fundo_cnpj)}
                          {l.fundo_isin ? ` · ${l.fundo_isin}` : ""}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs font-mono">{l.codigo_regra || "—"}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {l.dt_inicio_vigencia ?? "—"} → {l.dt_fim_vigencia ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {l.rejeitada ? (
                        <div className="space-y-0.5">
                          {l.avisos
                            .filter((a) =>
                              [
                                "fundo_obrigatorio",
                                "cnpj_invalido",
                                "fundo_nao_encontrado",
                                "nome_ambiguo",
                                "codigo_obrigatorio",
                                "regra_nao_encontrada",
                                "data_invalida",
                                "inicio_maior_que_fim",
                                "vinculo_ja_existe",
                              ].includes(a.problema),
                            )
                            .map((a, i) => (
                              <span key={i} className="block text-red-600">
                                {describeFundoRegrasImportProblema(a.problema)}
                              </span>
                            ))}
                        </div>
                      ) : l.avisos.length > 0 ? (
                        <span className="text-amber-700">
                          {l.avisos.map((a) => describeFundoRegrasImportProblema(a.problema)).join("; ")}
                        </span>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">
                          OK
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => void confirmImport()}
              disabled={importLoading || validasCount === 0}
              className="bg-[#003D27] hover:bg-[#197357]"
            >
              {importLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : `Confirmar (${validasCount})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
