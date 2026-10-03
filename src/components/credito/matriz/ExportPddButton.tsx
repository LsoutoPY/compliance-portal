import { useRef, useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

export function ExportPddButton({ fund, date, disabled = false }: { fund: string; date: string; disabled?: boolean }) {
  const [exporting, setExporting] = useState(false);
  const busy = useRef(false);
  const { toast } = useToast();

  const handleExport = async () => {
    if (busy.current || disabled || !fund || !date) return;
    busy.current = true;
    setExporting(true);
    try {
      const [{ fetchPddReport }, { exportPddPdf }] = await Promise.all([
        import("@/lib/creditoPddReportData"), import("@/utils/credito-pdd-export"),
      ]);
      const report = await fetchPddReport(fund, date);
      await exportPddPdf(report);
      toast({ title: "Relatório de PDD exportado", description: "O download do PDF foi iniciado." });
    } catch (error) {
      toast({ title: "Não foi possível exportar o PDF", variant: "destructive",
        description: error instanceof Error ? error.message : "Verifique a conexão e tente novamente." });
    } finally {
      busy.current = false;
      setExporting(false);
    }
  };

  return (
    <Button size="sm" variant="outline" onClick={handleExport}
      disabled={disabled || exporting || !fund || !date} aria-busy={exporting}
      title="Exportar o monitoramento de PDD do fundo e da data-base selecionados">
      {exporting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5 mr-1.5" />}
      {exporting ? "Gerando PDF…" : "Exportar PDF PDD"}
    </Button>
  );
}
