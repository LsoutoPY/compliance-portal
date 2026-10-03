import { useMemo, useState } from "react";
import type { Sheet2CSVOpts, WritingOptions } from "xlsx";
import { addDays, parseISO, format } from "date-fns";
import { Download, RefreshCw } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useCreditoVencimentos } from "@/hooks/useCreditoMatrizData";
import { formatDateBR } from "@/lib/creditoMatriz";
import {
  filtrarOrdenarVencimentos, formatValorVencimento,
  type JanelaVencimento, type OrdemVencimentos,
} from "@/lib/creditoVencimentos";

type Props = {
  fund: string;
  date: string;
  janela: JanelaVencimento;
  vpProjetado: number;
  onClose: () => void;
};

const PAGE_SIZE = 50;

export function VencimentosDetalhePanel({ fund, date, janela, vpProjetado, onClose }: Props) {
  const [elementoOrigem] = useState(() => document.activeElement);
  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useCreditoVencimentos(fund, date, janela);
  const [busca, setBusca] = useState("");
  const [ordem, setOrdem] = useState<OrdemVencimentos>("vencimento");
  const [pagina, setPagina] = useState(0);
  const [exportando, setExportando] = useState(false);
  const [erroExportacao, setErroExportacao] = useState("");
  const filtrados = useMemo(() => filtrarOrdenarVencimentos(data ?? [], busca, ordem), [data, busca, ordem]);
  const totais = useMemo(() => ({
    vp: filtrados.reduce((s, r) => s + Number(r.valor_base), 0),
    nominal: filtrados.reduce((s, r) => s + Number(r.valor_nominal ?? 0), 0),
    semNominal: filtrados.some((r) => r.valor_nominal == null),
  }), [filtrados]);
  const vpCarregado = useMemo(() => (data ?? []).reduce((s, r) => s + Number(r.valor_base), 0), [data]);
  const paginas = Math.max(1, Math.ceil(filtrados.length / PAGE_SIZE));
  const paginaAtual = Math.min(pagina, paginas - 1);
  const visiveis = filtrados.slice(paginaAtual * PAGE_SIZE, (paginaAtual + 1) * PAGE_SIZE);
  const inicio = format(addDays(parseISO(date), janela.min), "dd/MM/yyyy");
  const fim = janela.max === null ? null : format(addDays(parseISO(date), janela.max), "dd/MM/yyyy");

  async function exportar(tipo: "xlsx" | "csv") {
    setExportando(true);
    setErroExportacao("");
    try {
      const XLSX = await import("xlsx");
      // Células de texto explícitas evitam fórmulas em nomes/documentos exportados.
      const texto = (v: string | null) => tipo === "csv" && /^[=+@\-\t\r]/.test(v ?? "") ? `'${v}` : v ?? "";
      const sheet = XLSX.utils.json_to_sheet(filtrados.map((r) => ({
        "Data-base": formatDateBR(date), "Janela": janela.label,
        "Fundo": texto(r.nome_fundo || r.doc_fundo), "Documento do fundo": texto(r.doc_fundo),
        "Cedente": texto(r.nome_cedente), "Documento do cedente": texto(r.doc_cedente),
        "Sacado": texto(r.nome_sacado), "Título": texto(r.chave_ativo),
        "Vencimento": formatDateBR(r.data_vencimento_base),
        "Valor presente (R$)": Number(r.valor_base),
        "Valor nominal (R$)": r.valor_nominal == null ? null : Number(r.valor_nominal),
      })));
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, "Vencimentos");
      const options: WritingOptions & Sheet2CSVOpts = { bookType: tipo, FS: ";" };
      XLSX.writeFile(book, `vencimentos_${date}_${janela.min}.${tipo}`, options);
    } catch {
      setErroExportacao("Não foi possível exportar os vencimentos. Tente novamente.");
    } finally {
      setExportando(false);
    }
  }

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="flex w-full flex-col gap-4 sm:max-w-5xl" onCloseAutoFocus={(event) => {
        if (elementoOrigem instanceof HTMLElement && elementoOrigem.isConnected) {
          event.preventDefault();
          elementoOrigem.focus();
        }
      }}>
        <SheetHeader className="pr-8">
          <SheetTitle>Vencimentos — {janela.label}</SheetTitle>
          <SheetDescription>
            Data-base: {formatDateBR(date)} · {fim ? `${inicio} a ${fim}` : `A partir de ${inicio}`}.
            {" "}{fund === "TODOS" ? "Todos os fundos" : `Fundo: ${data?.[0]?.nome_fundo || fund}`}.
            {" "}Recebíveis desta janela; o VP compõe a barra da projeção. Valor nominal é o valor de face do título.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-48 flex-1 text-xs">Buscar cedente, sacado ou título
            <Input className="mt-1" value={busca} onChange={(e) => { setBusca(e.target.value); setPagina(0); }} placeholder="Nome ou documento" />
          </label>
          <label className="text-xs">Ordenar por
            <select className="mt-1 block h-10 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={ordem}
              onChange={(e) => { setOrdem(e.target.value as OrdemVencimentos); setPagina(0); }}>
              <option value="vencimento">Vencimento mais próximo</option>
              <option value="cedente">Cedente (A–Z)</option>
              <option value="valor">Maior valor presente</option>
            </select>
          </label>
          <Button variant="outline" disabled={isFetching} onClick={() => void refetch()}><RefreshCw className="mr-2 h-4 w-4" />Atualizar</Button>
          <Button variant="outline" disabled={isFetching || !!error || !filtrados.length || exportando} onClick={() => void exportar("csv")}><Download className="mr-2 h-4 w-4" />CSV</Button>
          <Button variant="outline" disabled={isFetching || !!error || !filtrados.length || exportando} onClick={() => void exportar("xlsx")}>Excel</Button>
        </div>
        {erroExportacao && <Alert variant="destructive"><AlertDescription>{erroExportacao}</AlertDescription></Alert>}
        {error ? (
          <Alert variant="destructive"><AlertDescription>Não foi possível carregar os vencimentos: {error.message}. Use Atualizar para tentar novamente.</AlertDescription></Alert>
        ) : isLoading ? (
          <div role="status"><span className="sr-only">Carregando vencimentos</span><Skeleton className="h-64 w-full" /></div>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs" aria-live="polite">
              <span>{filtrados.length.toLocaleString("pt-BR")} de {(data?.length ?? 0).toLocaleString("pt-BR")} recebíveis</span>
              <span>VP {busca.trim() ? "filtrado" : "da janela"}: <strong className="font-mono">{formatValorVencimento(totais.vp)}</strong></span>
              <span>Nominal {totais.semNominal ? "informado" : "total"}: <strong className="font-mono">{formatValorVencimento(totais.nominal)}</strong></span>
            </div>
            {Math.abs(vpCarregado - vpProjetado) > 0.01 && (
              <Alert><AlertDescription>O VP dos detalhes difere da projeção exibida ({formatValorVencimento(vpProjetado)}). O estoque pode ter sido atualizado; recarregue a visão geral para conferir.</AlertDescription></Alert>
            )}
            <div className="min-h-0 flex-1 overflow-auto rounded-md border">
              <table className="w-full min-w-[850px] text-xs">
                <thead className="sticky top-0 z-20 bg-muted text-muted-foreground"><tr>
                  <th scope="col" className="sticky left-0 z-30 bg-muted px-3 py-3 text-left">Cedente</th>
                  {fund === "TODOS" && <th scope="col" className="px-3 py-3 text-left">Fundo</th>}
                  <th scope="col" className="px-3 py-3 text-left">Título / Sacado</th>
                  <th scope="col" className="px-3 py-3 text-left">Vencimento</th>
                  <th scope="col" className="px-3 py-3 text-right">Valor presente</th>
                  <th scope="col" className="px-3 py-3 text-right">Valor nominal</th>
                </tr></thead>
                <tbody>
                  {!visiveis.length && <tr><td colSpan={fund === "TODOS" ? 6 : 5} className="p-8 text-center text-muted-foreground">{busca.trim() ? "Nenhum recebível encontrado para esta busca." : "Nenhum recebível nesta janela."}</td></tr>}
                  {visiveis.map((r) => <tr key={r.id} className="group border-t">
                    <td className="sticky left-0 bg-background px-3 py-3 group-hover:bg-muted"><span className="block font-medium">{r.nome_cedente || "Cedente não informado"}</span><span className="text-muted-foreground">{r.doc_cedente || "—"}</span></td>
                    {fund === "TODOS" && <td className="px-3 py-3">{r.nome_fundo || r.doc_fundo}</td>}
                    <td className="px-3 py-3"><span className="block">{r.chave_ativo || "—"}</span><span className="text-muted-foreground">{r.nome_sacado || "Sacado não informado"}</span></td>
                    <td className="whitespace-nowrap px-3 py-3 font-mono">{formatDateBR(r.data_vencimento_base)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-mono tabular-nums">{formatValorVencimento(Number(r.valor_base))}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-mono tabular-nums">{r.valor_nominal == null ? "—" : formatValorVencimento(Number(r.valor_nominal))}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{isFetching ? "Atualizando…" : dataUpdatedAt ? `Consultado às ${new Date(dataUpdatedAt).toLocaleTimeString("pt-BR")}` : ""} · Exportação inclui todos os resultados da busca.</span>
              <div className="flex items-center gap-3">
                <Button variant="outline" size="sm" disabled={paginaAtual === 0} onClick={() => setPagina(paginaAtual - 1)}>Anterior</Button>
                <span>Página {paginaAtual + 1} de {paginas}</span>
                <Button variant="outline" size="sm" disabled={paginaAtual + 1 >= paginas} onClick={() => setPagina(paginaAtual + 1)}>Próxima</Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
