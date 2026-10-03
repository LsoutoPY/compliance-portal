import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search, Plus, Trash2, Loader2, Link as LinkIcon, ShieldAlert, ChevronDown, ExternalLink, ClipboardList, FileSpreadsheet, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  TRIB_CODIGOS,
  type VarianteArt4,
  type TipoRegraTributaria,
  buildDescricaoTributario,
  buildParametrosTributarioArt4,
  buildParametrosTributarioArt5,
  codigoFromTributario,
  TRIB_TIPOS_EXCLUIDOS_PADRAO,
} from "@/lib/regrasTributariasCatalog";
import {
  addTodasSubclassesOptions,
  buildFundosSubclasseList,
  buildRegrasAssociadasPorFundo,
  fundPairKey,
  fundoRegrasDisplayLabel,
  isFundoRegraAtivaParaEnquadramento,
  normalizeCnpj14,
  parseFundPairKey,
  populateFundoNomeMapFromPosicao,
  resolveFundoNomeFromMap,
} from "@/lib/fundoRegrasUtils";
import { FundoRegrasImportPanel } from "@/components/enquadramento/FundoRegrasImportPanel";
import { FundoRegrasAprovacaoTab } from "@/components/enquadramento/FundoRegrasAprovacaoTab";

export default function RegrasRelacionais() {
  const queryClient = useQueryClient();
  const [selectedFundos, setSelectedFundos] = useState<string[]>([]);
  const [selectedRegras, setSelectedRegras] = useState<string[]>([]);
  const [busca, setBusca] = useState("");
  const [painelTab, setPainelTab] = useState<
    "associacoes" | "regras-associadas" | "importacao" | "aprovacao"
  >("associacoes");
  const [filtroTributario, setFiltroTributario] = useState(false);
  const [tribDialogOpen, setTribDialogOpen] = useState(false);
  const [tribFormTipo, setTribFormTipo] = useState<TipoRegraTributaria>("tributario_fiq_art5");
  const [tribVariante, setTribVariante] = useState<VarianteArt4>("fim");
  const [tribLimiteDias, setTribLimiteDias] = useState(365);
  const [tribAlertaDias, setTribAlertaDias] = useState(367);
  const [tribLimiteMm, setTribLimiteMm] = useState(90);
  const [tribAlertaMm, setTribAlertaMm] = useState(92);
  const [tribDenominadorElegivel, setTribDenominadorElegivel] = useState(false);
  const [tribTiposExcluidos, setTribTiposExcluidos] = useState<string[]>([...TRIB_TIPOS_EXCLUIDOS_PADRAO]);
  const [tribCodigoEditavel, setTribCodigoEditavel] = useState("");

  const isRegraTributariaCatalog = (r: { codigo: string; parametros?: unknown }) => {
    const p = (r.parametros ?? {}) as Record<string, unknown>;
    if (p.tipo_regra === "tributario_fiq_art5" || p.tipo_regra === "tributario_prazo_medio_art4") {
      return true;
    }
    return TRIB_CODIGOS.includes(r.codigo as (typeof TRIB_CODIGOS)[number]);
  };

  const { data: categoriasCota = [] } = useQuery({
    queryKey: ["categorias-fundo-relacionais"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fundos_caracteristicas" as any)
        .select("nivel1_categoria")
        .not("nivel1_categoria", "is", null)
        .limit(5000);
      if (error) throw error;
      return [...new Set((data as any[]).map((d) => d.nivel1_categoria).filter(Boolean))].sort() as string[];
    },
    enabled: tribDialogOpen,
  });

  // Fetch all available rules
  const { data: regras = [], isLoading: isLoadingRegras } = useQuery({
    queryKey: ["regras-compliance"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("regras_compliance")
        .select("*")
        .order("codigo");
      if (error) throw error;
      return data;
    },
  });

  // Fundos disponíveis para associação — apenas gestoras da allowlist, todas as datas.
  // Usa RPC para normalizar CNPJ de gestora nos dois lados e evitar mismatch de formato.
  const { data: fundos = [], isLoading: isLoadingFundos } = useQuery({
    queryKey: ["fundos-posicao-subclasse"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("get_fundos_para_regras");
      if (error) throw error;
      return addTodasSubclassesOptions(buildFundosSubclasseList(data || []));
    },
  });

  // Fetch current associations
  const { data: associacoes = [], isLoading: isLoadingAssoc } = useQuery({
    queryKey: ["fundo-regras"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fundo_regras")
        .select(`
          id,
          fundo_cnpj,
          fundo_isin,
          regra_id,
          ativo,
          status_aprovacao,
          origem,
          dt_inicio_vigencia,
          dt_fim_vigencia,
          regras_compliance (
            codigo,
            descricao
          )
        `);
      if (error) throw error;
      if (!data?.length) return [];

      // Buscar nome em posicao_carteira.fundo_nome — por (CNPJ, ISIN)
      const cnpjs = [...new Set(data.map((a: any) => a.fundo_cnpj))];
      const cnpjNormalized = (c: string) => normalizeCnpj14(c);
      const cnpjsNorm = [...new Set(cnpjs.map(cnpjNormalized).filter(Boolean))];
      const isinsFromAssoc = [
        ...new Set(
          data
            .map((a: any) => String(a.fundo_isin ?? "").trim())
            .filter(Boolean),
        ),
      ];
      const nameMap = new Map<string, string>();

      if (cnpjsNorm.length > 0) {
        const cnpjQueryValues = [...new Set([...cnpjs, ...cnpjsNorm])];
        const posRows: Array<{
          fundo_cnpj: string;
          fundo_isin?: string | null;
          fundo_nome?: string | null;
          nome_fundo?: string | null;
        }> = [];

        const { data: posByCnpj } = await supabase
          .from("posicao_carteira")
          .select("fundo_cnpj, fundo_isin, fundo_nome, nome_fundo")
          .in("fundo_cnpj", cnpjQueryValues)
          .order("fundo_dtposicao", { ascending: false })
          .limit(10000);
        posRows.push(...(posByCnpj || []));

        if (isinsFromAssoc.length > 0) {
          const { data: posByIsin } = await supabase
            .from("posicao_carteira")
            .select("fundo_cnpj, fundo_isin, fundo_nome, nome_fundo")
            .in("fundo_isin", isinsFromAssoc)
            .order("fundo_dtposicao", { ascending: false })
            .limit(10000);
          posRows.push(...(posByIsin || []));
        }

        populateFundoNomeMapFromPosicao(nameMap, posRows, cnpjsNorm);
      }

      return data.map((a: any) => ({
        ...a,
        fundo_nome: resolveFundoNomeFromMap(nameMap, a.fundo_cnpj, a.fundo_isin),
      }));
    },
  });

  // Mutation to add associations (multiple fundos x regras)
  const addAssocMutation = useMutation({
    mutationFn: async () => {
      if (selectedFundos.length === 0 || selectedRegras.length === 0) {
        throw new Error("Selecione ao menos um fundo e uma regra");
      }
      const cnpjNorm = normalizeCnpj14;
      const existentes = new Set(
        associacoes
          .filter((a) => (a as { status_aprovacao?: string }).status_aprovacao !== "rejeitado")
          .map((a) => `${cnpjNorm(a.fundo_cnpj)}|${a.fundo_isin ?? ""}|${a.regra_id}`),
      );
      const associacoesParaInserir: {
        fundo_cnpj: string;
        fundo_isin: string;
        regra_id: string;
        ativo: boolean;
        status_aprovacao: string;
        origem: string;
      }[] = [];
      for (const fundoKey of selectedFundos) {
        const { cnpj, isin } = parseFundPairKey(fundoKey);
        for (const regraId of selectedRegras) {
          const existKey = `${cnpj}|${isin}|${regraId}`;
          if (!existentes.has(existKey)) {
            associacoesParaInserir.push({
              fundo_cnpj: cnpj,
              fundo_isin: isin,
              regra_id: regraId,
              ativo: true,
              status_aprovacao: "ativo",
              origem: "manual",
            });
          }
        }
      }
      if (associacoesParaInserir.length === 0) {
        throw new Error("Todas as combinações selecionadas já estão associadas");
      }
      const { error } = await supabase
        .from("fundo_regras")
        .insert(associacoesParaInserir);
      if (error) throw error;
      return { inseridas: associacoesParaInserir.length };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["fundo-regras"] });
      queryClient.invalidateQueries({ queryKey: ["enquadramento-rules"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-regras"] });
      toast.success(
        `${data?.inseridas ?? 1} associação(ões) criada(s). Rode a verificação de enquadramento no fundo para exibir o resultado.`,
      );
      setSelectedFundos([]);
      setSelectedRegras([]);
    },
    onError: (error: any) => {
      if (error.code === "23505") {
        toast.error("Algumas combinações já estão associadas. As novas foram criadas.");
        queryClient.invalidateQueries({ queryKey: ["fundo-regras"] });
      } else {
        toast.error(`Erro ao associar: ${error.message}`);
      }
    }
  });

  // Mutation to remove association
  const removeAssocMutation = useMutation({
    mutationFn: async (assoc: any) => {
      // 1. Delete the association
      const { error: deleteError } = await supabase
        .from("fundo_regras")
        .delete()
        .eq("id", assoc.id);
      
      if (deleteError) throw deleteError;

      // 2. Clear results from enquadramento_resultado for this fund and rule
      // to ensure it doesn't persist in the monitoring view.
      const regraCodigo = assoc.regras_compliance?.codigo;
      if (regraCodigo) {
        let deleteQuery = supabase
          .from("enquadramento_resultado" as any)
          .delete()
          .eq("fundo_cnpj", assoc.fundo_cnpj)
          .eq("regra_codigo", regraCodigo);
        const assocIsin = assoc.fundo_isin ?? "";
        if (assocIsin) {
          deleteQuery = deleteQuery.eq("fundo_isin", assocIsin);
        }
        await deleteQuery;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fundo-regras"] });
      queryClient.invalidateQueries({ queryKey: ["enquadramento-rules"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-regras"] });
      toast.success("Associação removida e resultados limpos.");
    },
    onError: (error: any) => {
      toast.error(`Erro ao remover: ${error.message}`);
    }
  });

  const regrasFiltradas = filtroTributario
    ? regras.filter((r) => isRegraTributariaCatalog(r))
    : regras;

  const tribCodigoSugerido = codigoFromTributario(tribFormTipo, tribVariante);

  const createTribRegraMutation = useMutation({
    mutationFn: async () => {
      const codigo = (tribCodigoEditavel.trim() || tribCodigoSugerido).toUpperCase().replace(/\s+/g, "_");
      if (!codigo) throw new Error("Informe o código da regra.");
      if (tribFormTipo === "tributario_fiq_art5" && tribTiposExcluidos.length === 0) {
        throw new Error("Selecione pelo menos um tipo de cota excluído.");
      }
      if (regras.some((r) => r.codigo === codigo)) {
        const existente = regras.find((r) => r.codigo === codigo)!;
        return existente.id;
      }
      const parametros =
        tribFormTipo === "tributario_prazo_medio_art4"
          ? buildParametrosTributarioArt4(tribVariante, tribLimiteDias, tribAlertaDias)
          : buildParametrosTributarioArt5(
              tribDenominadorElegivel,
              tribTiposExcluidos,
              tribLimiteMm,
              tribAlertaMm,
            );
      const descricao = buildDescricaoTributario(
        tribFormTipo,
        tribVariante,
        tribLimiteDias,
        tribLimiteMm,
        tribDenominadorElegivel,
        tribTiposExcluidos,
      );
      const { data, error } = await supabase
        .from("regras_compliance")
        .insert({ codigo, descricao, parametros })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (regraId) => {
      queryClient.invalidateQueries({ queryKey: ["regras-compliance"] });
      setSelectedRegras((prev) => (prev.includes(regraId) ? prev : [...prev, regraId]));
      setTribDialogOpen(false);
      toast.success("Regra tributária disponível — selecione o fundo e associe.");
    },
    onError: (e: { message?: string }) => toast.error(e.message ?? "Erro ao cadastrar regra."),
  });

  const { data: pendentesCount = 0 } = useQuery({
    queryKey: ["fundo-regras-pendentes-count"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("fundo_regras")
        .select("id", { count: "exact", head: true })
        .eq("status_aprovacao", "pendente");
      if (error) throw error;
      return count ?? 0;
    },
  });

  const associacoesAtivas = useMemo(
    () => associacoes.filter(isFundoRegraAtivaParaEnquadramento),
    [associacoes],
  );

  const associacoesFiltradas = associacoesAtivas.filter(a => {
    const termo = busca.toLowerCase();
    const nomeFundo = (a as any).fundo_nome?.toLowerCase() || "";
    const isin = (a.fundo_isin ?? "").toLowerCase();
    return a.fundo_cnpj.includes(termo) ||
           isin.includes(termo) ||
           nomeFundo.includes(termo) ||
           (a.regras_compliance as any)?.codigo?.toLowerCase().includes(termo);
  });

  const regrasAssociadasResumo = useMemo(
    () => buildRegrasAssociadasPorFundo(associacoesAtivas),
    [associacoesAtivas],
  );

  const regrasPorFundoFiltradas = useMemo(() => {
    const termo = busca.toLowerCase().trim();
    if (!termo) return regrasAssociadasResumo.porFundo;
    return regrasAssociadasResumo.porFundo.filter((item) => {
      const nome = (item.nome_fundo ?? "").toLowerCase();
      const cnpj = item.fundo_cnpj.toLowerCase();
      const isin = item.fundo_isin.toLowerCase();
      const regrasMatch = item.regras.some(
        (r) =>
          r.codigo.toLowerCase().includes(termo) ||
          (r.descricao ?? "").toLowerCase().includes(termo),
      );
      return nome.includes(termo) || cnpj.includes(termo) || isin.includes(termo) || regrasMatch;
    });
  }, [regrasAssociadasResumo.porFundo, busca]);

  const formatCnpj = (cnpj: string) =>
    cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

  const isLoading = isLoadingRegras || isLoadingFundos || isLoadingAssoc;

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex flex-col gap-1 border-b border-border pb-4">
          <h1 className="text-2xl font-bold tracking-tight text-foreground uppercase tracking-wider flex items-center gap-2">
            <ShieldAlert className="h-6 w-6 text-primary" />
            Regras Relacionais
          </h1>
          <p className="text-sm text-muted-foreground font-medium uppercase tracking-wide">
            Associação Manual de Regras de Compliance por Fundo
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Form Card */}
          <Card className="lg:col-span-1 h-fit">
            <CardHeader>
              <CardTitle className="text-lg">Nova Associação</CardTitle>
              <CardDescription>Vincule regras a um ou mais fundos de uma vez. Selecione múltiplos fundos e/ou regras.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant={filtroTributario ? "default" : "outline"}
                  size="sm"
                  className="text-xs"
                  onClick={() => setFiltroTributario((v) => !v)}
                >
                  Só tributárias (Art. 4º/5º)
                </Button>
                <Dialog
                  open={tribDialogOpen}
                  onOpenChange={(open) => {
                    setTribDialogOpen(open);
                    if (!open) {
                      setTribCodigoEditavel("");
                      setTribTiposExcluidos([...TRIB_TIPOS_EXCLUIDOS_PADRAO]);
                    }
                  }}
                >
                  <DialogTrigger asChild>
                    <Button type="button" variant="outline" size="sm" className="text-xs gap-1">
                      <Plus className="h-3 w-3" />
                      Cadastrar regra tributária
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>Regra tributária</DialogTitle>
                      <DialogDescription>
                        Código fixo (TRIB_*). Após salvar, a regra entra na lista para associação.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3 py-2">
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase">Tipo</Label>
                        <Select
                          value={tribFormTipo}
                          onValueChange={(v) => {
                            setTribFormTipo(v as TipoRegraTributaria);
                            setTribCodigoEditavel("");
                          }}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="tributario_prazo_medio_art4">Art. 4º — prazo médio</SelectItem>
                            <SelectItem value="tributario_fiq_art5">Art. 5º — FIQ MM-10d</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {tribFormTipo === "tributario_prazo_medio_art4" ? (
                        <>
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Variante</Label>
                            <Select
                              value={tribVariante}
                              onValueChange={(v) => {
                                setTribVariante(v as VarianteArt4);
                                setTribCodigoEditavel("");
                              }}
                            >
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="fim">FIM (carteira)</SelectItem>
                                <SelectItem value="fidc">FIDC (estoque)</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <Label className="text-xs">Limite (dias)</Label>
                              <Input type="number" value={tribLimiteDias} onChange={(e) => setTribLimiteDias(Number(e.target.value) || 365)} />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Alerta (dias)</Label>
                              <Input type="number" value={tribAlertaDias} onChange={(e) => setTribAlertaDias(Number(e.target.value) || 367)} />
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <Label className="text-xs">Mín. MM (%)</Label>
                              <Input type="number" value={tribLimiteMm} onChange={(e) => setTribLimiteMm(Number(e.target.value) || 90)} />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Alerta (%)</Label>
                              <Input type="number" value={tribAlertaMm} onChange={(e) => setTribAlertaMm(Number(e.target.value) || 92)} />
                            </div>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs font-bold uppercase">Excluídos (não são LP)</Label>
                            <div className="border rounded-md p-2 max-h-28 overflow-y-auto space-y-1">
                              {categoriasCota.filter((c) => c !== "Todas" && c !== "Cotas").map((c) => (
                                <label key={c} className="flex items-center gap-2 cursor-pointer text-xs">
                                  <Checkbox
                                    checked={tribTiposExcluidos.includes(c)}
                                    onCheckedChange={(checked) => {
                                      if (checked) setTribTiposExcluidos((p) => [...p, c]);
                                      else setTribTiposExcluidos((p) => p.filter((t) => t !== c));
                                    }}
                                  />
                                  {c}
                                </label>
                              ))}
                            </div>
                          </div>
                          <label className="flex items-start gap-2 text-sm">
                            <Checkbox
                              checked={tribDenominadorElegivel}
                              onCheckedChange={(c) => setTribDenominadorElegivel(c === true)}
                            />
                            <span>% LP usa PL sem os tipos excluídos acima</span>
                          </label>
                        </>
                      )}
                      <div className="space-y-1">
                        <Label className="text-xs font-bold uppercase">Código (editável)</Label>
                        <Input
                          className="font-mono text-xs"
                          placeholder={tribCodigoSugerido}
                          value={
                            tribCodigoEditavel !== ""
                              ? tribCodigoEditavel
                              : tribCodigoSugerido
                          }
                          onChange={(e) => setTribCodigoEditavel(e.target.value)}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" size="sm" asChild>
                        <Link to="/enquadramento/regras">Abrir Regras de Compliance</Link>
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => createTribRegraMutation.mutate()}
                        disabled={createTribRegraMutation.isPending}
                      >
                        {createTribRegraMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar no catálogo"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <Button variant="ghost" size="sm" className="text-xs gap-1" asChild>
                  <Link to="/enquadramento/regras">
                    <ExternalLink className="h-3 w-3" />
                    Catálogo completo
                  </Link>
                </Button>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase text-muted-foreground">
                  Fundos (seleção múltipla)
                  <span className="font-normal normal-case text-muted-foreground/80">
                    {isLoadingFundos ? " · …" : ` · ${fundos.length}`}
                  </span>
                </label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-between h-auto min-h-10 text-left font-normal"
                    >
                      <span className="truncate">
                        {selectedFundos.length === 0
                          ? "Selecione os fundos..."
                          : `${selectedFundos.length} fundo(s) selecionado(s)`}
                      </span>
                      <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                    <ScrollArea className="h-[220px]">
                      <div className="p-2 space-y-1">
                        {fundos.map((f) => (
                          <label
                            key={f.key}
                            className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 cursor-pointer"
                          >
                            <Checkbox
                              checked={selectedFundos.includes(f.key)}
                              onCheckedChange={(checked) => {
                                setSelectedFundos((prev) =>
                                  checked ? [...prev, f.key] : prev.filter((id) => id !== f.key)
                                );
                              }}
                            />
                            <div className="flex flex-col text-left flex-1 min-w-0">
                              <span className="font-medium truncate text-sm">
                                {fundoRegrasDisplayLabel(f.nome, f.isin)}
                              </span>
                              <span className="text-[10px] text-muted-foreground font-mono">
                                {f.cnpj}
                                {f.isin ? ` · ${f.isin}` : " · todas subclasses"}
                              </span>
                            </div>
                          </label>
                        ))}
                      </div>
                    </ScrollArea>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold uppercase text-muted-foreground">Regras (seleção múltipla)</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-between h-auto min-h-10 text-left font-normal"
                    >
                      <span className="truncate">
                        {selectedRegras.length === 0
                          ? "Selecione as regras..."
                          : `${selectedRegras.length} regra(s) selecionada(s)`}
                      </span>
                      <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                    <ScrollArea className="h-[220px]">
                      <div className="p-2 space-y-1">
                        {regrasFiltradas.map((r) => (
                          <label
                            key={r.id}
                            className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 cursor-pointer"
                          >
                            <Checkbox
                              checked={selectedRegras.includes(r.id)}
                              onCheckedChange={(checked) => {
                                setSelectedRegras((prev) =>
                                  checked ? [...prev, r.id] : prev.filter((id) => id !== r.id)
                                );
                              }}
                            />
                            <div className="flex flex-col text-left flex-1 min-w-0">
                              <span className="font-medium text-sm">{r.codigo}</span>
                              <span className="text-[10px] text-muted-foreground truncate">{r.descricao}</span>
                              {isRegraTributariaCatalog(r) &&
                                Array.isArray((r.parametros as Record<string, unknown>)?.tipos_excluidos_denominador) &&
                                ((r.parametros as Record<string, unknown>).tipos_excluidos_denominador as string[]).length > 0 && (
                                  <span className="text-[9px] text-amber-700">
                                    Excl.: {((r.parametros as Record<string, unknown>).tipos_excluidos_denominador as string[]).join(", ")}
                                  </span>
                                )}
                            </div>
                          </label>
                        ))}
                      </div>
                    </ScrollArea>
                  </PopoverContent>
                </Popover>
              </div>

              <Button 
                className="w-full gap-2" 
                onClick={() => addAssocMutation.mutate()}
                disabled={addAssocMutation.isPending || selectedFundos.length === 0 || selectedRegras.length === 0}
              >
                {addAssocMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Associar ({selectedFundos.length * selectedRegras.length} associação{selectedFundos.length * selectedRegras.length !== 1 ? "ões" : ""})
              </Button>
            </CardContent>
          </Card>

          {/* Painel principal — abas Associações Ativas / Regras Associadas */}
          <Card className="lg:col-span-2">
            <Tabs value={painelTab} onValueChange={(v) => setPainelTab(v as typeof painelTab)}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-4 gap-4">
                <div className="space-y-3 flex-1 min-w-0">
                  <div>
                    <CardTitle className="text-lg">Vínculos Fundo ↔ Regra</CardTitle>
                    <CardDescription>
                      {painelTab === "associacoes"
                        ? "Lista detalhada de associações ativas processadas no enquadramento."
                        : painelTab === "regras-associadas"
                          ? "Resumo consolidado: quantas regras cada fundo possui vinculadas."
                          : painelTab === "importacao"
                            ? "Importação em lote via planilha com histórico de arquivos."
                            : "Vínculos importados aguardando autorização antes de entrar no enquadramento."}
                    </CardDescription>
                  </div>
                  <TabsList className="h-8 flex-wrap">
                    <TabsTrigger value="associacoes" className="text-xs">
                      Vínculos
                    </TabsTrigger>
                    <TabsTrigger value="regras-associadas" className="text-xs gap-1.5">
                      <ClipboardList className="h-3 w-3" />
                      Regras Associadas
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                        {regrasAssociadasResumo.total}
                      </Badge>
                    </TabsTrigger>
                    <TabsTrigger value="importacao" className="text-xs gap-1.5">
                      <FileSpreadsheet className="h-3 w-3" />
                      Importação
                    </TabsTrigger>
                    <TabsTrigger value="aprovacao" className="text-xs gap-1.5">
                      <ShieldCheck className="h-3 w-3" />
                      Aprovação
                      {pendentesCount > 0 && (
                        <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4">
                          {pendentesCount}
                        </Badge>
                      )}
                    </TabsTrigger>
                  </TabsList>
                </div>
                <div className="relative w-64 shrink-0">
                  {painelTab === "associacoes" || painelTab === "regras-associadas" ? (
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  ) : null}
                  {(painelTab === "associacoes" || painelTab === "regras-associadas") && (
                  <Input
                    placeholder={
                      painelTab === "associacoes"
                        ? "Filtrar associações..."
                        : "Filtrar fundos ou regras..."
                    }
                    value={busca}
                    onChange={(e) => setBusca(e.target.value)}
                    className="pl-8 h-8 text-xs"
                  />
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <TabsContent value="associacoes" className="mt-0">
                  {isLoading ? (
                    <div className="flex justify-center py-12">
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                  ) : associacoesFiltradas.length === 0 ? (
                    <div className="text-center py-12 border border-dashed rounded-lg">
                      <LinkIcon className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-20" />
                      <p className="text-sm text-muted-foreground">Nenhuma associação encontrada.</p>
                    </div>
                  ) : (
                    <div className="rounded-md border border-border overflow-hidden">
                      <Table>
                        <TableHeader className="bg-muted/50">
                          <TableRow>
                            <TableHead className="text-[10px] font-bold uppercase">Fundo</TableHead>
                            <TableHead className="text-[10px] font-bold uppercase">Regra</TableHead>
                            <TableHead className="text-[10px] font-bold uppercase w-[80px] text-center">Ações</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {associacoesFiltradas.map((assoc) => {
                            const regra = assoc.regras_compliance as any;
                            const assocIsin = assoc.fundo_isin ?? "";
                            const nomeFromFundos =
                              fundos.find((f) => f.key === fundPairKey(assoc.fundo_cnpj, assocIsin))?.nome ??
                              (!assocIsin
                                ? fundos.find((f) => f.key === fundPairKey(assoc.fundo_cnpj, ""))?.nome ??
                                  fundos.find(
                                    (f) => f.cnpj === normalizeCnpj14(assoc.fundo_cnpj) && Boolean(f.isin),
                                  )?.nome
                                : undefined);
                            const nomeFundo =
                              (assoc as any).fundo_nome ||
                              nomeFromFundos ||
                              "N/A";
                            return (
                              <TableRow key={assoc.id} className="hover:bg-muted/30">
                                <TableCell>
                                  <div className="flex flex-col">
                                    <span className="font-bold text-sm">
                                      {fundoRegrasDisplayLabel(nomeFundo, assocIsin)}
                                    </span>
                                    <span className="text-[10px] font-mono text-muted-foreground">
                                      {assoc.fundo_cnpj}
                                      {assocIsin ? ` · ${assocIsin}` : " · todas subclasses"}
                                    </span>
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <div className="flex flex-col">
                                    <Badge variant="outline" className="w-fit text-[10px] font-bold mb-1">
                                      {regra?.codigo}
                                    </Badge>
                                    <span className="text-xs text-muted-foreground">{regra?.descricao}</span>
                                  </div>
                                </TableCell>
                                <TableCell className="text-center">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                    onClick={() => removeAssocMutation.mutate(assoc)}
                                    disabled={removeAssocMutation.isPending}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="regras-associadas" className="mt-0">
                  {isLoading ? (
                    <div className="flex justify-center py-12">
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-center gap-4 p-4 rounded-lg border border-primary/20 bg-primary/5">
                        <span className="text-4xl font-extrabold text-primary tabular-nums">
                          {regrasAssociadasResumo.total}
                        </span>
                        <div>
                          <p className="text-sm font-semibold text-foreground">Total de vínculos ativos</p>
                          <p className="text-xs text-muted-foreground">
                            {regrasAssociadasResumo.porFundo.length} fundo(s) com regras associadas
                          </p>
                        </div>
                      </div>

                      {regrasPorFundoFiltradas.length === 0 ? (
                        <div className="text-center py-12 border border-dashed rounded-lg">
                          <ClipboardList className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-20" />
                          <p className="text-sm text-muted-foreground">Nenhum fundo com regras associadas.</p>
                        </div>
                      ) : (
                        <div className="rounded-md border border-border divide-y divide-border max-h-[520px] overflow-y-auto">
                          {regrasPorFundoFiltradas.map((item) => {
                            const nomeFromFundos =
                              fundos.find((f) => f.key === item.key)?.nome ??
                              (!item.fundo_isin
                                ? fundos.find((f) => f.cnpj === item.fundo_cnpj && Boolean(f.isin))?.nome
                                : undefined);
                            const nomeExibicao =
                              item.nome_fundo ??
                              nomeFromFundos ??
                              formatCnpj(item.fundo_cnpj);
                            return (
                              <div key={item.key} className="p-4 hover:bg-muted/20">
                                <div className="flex items-start justify-between gap-3 mb-2">
                                  <div className="min-w-0 flex-1">
                                    <p className="font-semibold text-sm truncate" title={nomeExibicao}>
                                      {fundoRegrasDisplayLabel(nomeExibicao, item.fundo_isin)}
                                    </p>
                                    <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                                      {formatCnpj(item.fundo_cnpj)}
                                      {item.fundo_isin ? ` · ${item.fundo_isin}` : " · todas subclasses"}
                                    </p>
                                  </div>
                                  <Badge variant="secondary" className="text-xs shrink-0 tabular-nums">
                                    {item.count} {item.count === 1 ? "regra" : "regras"}
                                  </Badge>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {item.regras.map((r, idx) => (
                                    <Badge
                                      key={`${r.codigo}-${idx}`}
                                      variant="outline"
                                      className="text-[10px] font-mono"
                                      title={r.descricao ?? undefined}
                                    >
                                      {r.codigo}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="importacao" className="mt-0">
                  <FundoRegrasImportPanel />
                </TabsContent>

                <TabsContent value="aprovacao" className="mt-0">
                  <FundoRegrasAprovacaoTab />
                </TabsContent>
              </CardContent>
            </Tabs>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
