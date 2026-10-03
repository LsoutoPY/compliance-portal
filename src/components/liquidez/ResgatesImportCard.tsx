import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Calendar, CheckCircle2, FileUp, Loader2, Receipt, RefreshCw, Upload, XCircle } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

interface ResgatesResponse {
  success: boolean;
  recordsInserted?: number;
  message?: string;
  error?: string;
}

export function ResgatesImportCard() {
  const [resgatesFile, setResgatesFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [result, setResult] = useState<ResgatesResponse | null>(null);
  const [dataReferencia, setDataReferencia] = useState("");
  const [substituirPeriodo, setSubstituirPeriodo] = useState(false);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const today = new Date();
    const yyyymmdd =
      `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    setDataReferencia(yyyymmdd);
  }, []);

  const handleUpload = async () => {
    if (!resgatesFile) return;

    setIsUploading(true);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("file", resgatesFile);
      if (dataReferencia) formData.append("data_referencia", dataReferencia);
      if (substituirPeriodo) formData.append("modo_importacao", "substituir_periodo");

      const { data, error } = await supabase.functions.invoke<ResgatesResponse>("import-resgates-movimentacoes", {
        body: formData,
      });

      if (error) throw new Error(error.message || "Falha ao importar histórico de resgates");

      const responseData = data ?? { success: false, error: "Resposta vazia da função" };
      setResult(responseData);

      if (responseData.success) {
        setResgatesFile(null);
        queryClient.invalidateQueries({ queryKey: ["resgates-movimentacoes"] });
        toast({
          title: "Resgates importados!",
          description: responseData.message || `${responseData.recordsInserted ?? 0} registros importados.`,
        });
      } else {
        toast({
          title: "Erro na importação",
          description: responseData.error || "Não foi possível importar o arquivo.",
          variant: "destructive",
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erro ao importar histórico de resgates";
      setResult({ success: false, error: message });
      toast({
        title: "Erro na importação",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="w-5 h-5 text-primary" />
          Importar Histórico de Resgates
        </CardTitle>
        <CardDescription>
          Importe planilhas de movimentações `passivo.relatório.movimentações-*.xlsx`. Apenas linhas com RESGATE
          são importadas para a análise de liquidez.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium flex items-center gap-2">
            <Calendar className="w-4 h-4" />
            Data de referência
          </label>
          <input
            type="date"
            value={
              dataReferencia
                ? `${dataReferencia.slice(0, 4)}-${dataReferencia.slice(4, 6)}-${dataReferencia.slice(6, 8)}`
                : ""
            }
            onChange={(e) => setDataReferencia(e.target.value.replace(/-/g, ""))}
            className="flex h-9 w-full max-w-[180px] rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          />
        </div>

        <div className="flex items-start gap-3 rounded-md border p-3">
          <Switch
            id="substituir-periodo"
            checked={substituirPeriodo}
            onCheckedChange={setSubstituirPeriodo}
          />
          <div className="space-y-1">
            <Label htmlFor="substituir-periodo" className="flex items-center gap-2 cursor-pointer">
              <RefreshCw className="w-4 h-4" />
              Substituir período
            </Label>
            <p className="text-xs text-muted-foreground">
              Remove todos os resgates existentes dos mesmos fundos e intervalo de datas antes de inserir.
              Use ao reimportar um relatório já carregado para evitar duplicatas.
            </p>
          </div>
        </div>

        <div
          className={cn(
            "relative border-2 border-dashed rounded-lg p-8 transition-colors",
            "hover:border-primary/50 hover:bg-accent/30",
            "flex flex-col items-center justify-center gap-4 text-center",
            isUploading && "pointer-events-none opacity-50"
          )}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file?.name.toLowerCase().endsWith(".xlsx")) {
              setResgatesFile(file);
              return;
            }

            toast({
              title: "Arquivo inválido",
              description: "Use um arquivo XLSX no padrão passivo.relatório.movimentações-*.xlsx.",
              variant: "destructive",
            });
          }}
          onDragOver={(e) => e.preventDefault()}
        >
          <Upload className="w-8 h-8 text-primary" />
          <div>
            <p className="font-medium">Arraste o XLSX aqui ou clique para selecionar</p>
            <p className="text-sm text-muted-foreground mt-1">passivo.relatório.movimentações-*.xlsx</p>
          </div>
          <input
            type="file"
            accept=".xlsx"
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            disabled={isUploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) setResgatesFile(file);
            }}
          />
        </div>

        {resgatesFile && (
          <div className="flex items-center justify-between gap-3 rounded-md bg-accent/50 p-3">
            <div className="flex items-center gap-3 min-w-0">
              <Receipt className="w-5 h-5 text-primary shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{resgatesFile.name}</p>
                <p className="text-xs text-muted-foreground">{(resgatesFile.size / 1024).toFixed(1)} KB</p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setResgatesFile(null);
                setResult(null);
              }}
              disabled={isUploading}
            >
              <XCircle className="w-4 h-4" />
            </Button>
          </div>
        )}

        <Button className="w-full" onClick={handleUpload} disabled={!resgatesFile || isUploading}>
          {isUploading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Importando...
            </>
          ) : (
            <>
              <FileUp className="w-4 h-4 mr-2" />
              Importar Resgates
            </>
          )}
        </Button>

        {result && (
          <Card className={result.success ? "border-green-500/50" : "border-red-500/50"}>
            <CardContent className="pt-4 flex items-center gap-3">
              {result.success ? (
                <CheckCircle2 className="w-5 h-5 text-green-500" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-red-500" />
              )}
              <div>
                <p className="font-medium">{result.success ? "Importação concluída" : "Erro"}</p>
                <p className="text-sm text-muted-foreground">{result.success ? result.message : result.error}</p>
                {result.recordsInserted != null && (
                  <p className="text-xs text-muted-foreground mt-1">{result.recordsInserted} registros</p>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </CardContent>
    </Card>
  );
}
