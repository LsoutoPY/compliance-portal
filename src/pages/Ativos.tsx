import { useState, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { supabase } from "@/integrations/supabase/client";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  Search, 
  Filter, 
  Database, 
  Tag, 
  Building2, 
  Coins, 
  FileText,
  MapPin,
  CheckCircle2,
  AlertCircle,
  Check,
  ExternalLink,
  RefreshCw,
  ChevronsUpDown,
  ChevronUp,
  ChevronDown,
  FileUp,
  Loader2,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  resolveDescricaoOrigemAtivo,
} from "@/lib/mapaAtivosNome";
import { fetchCadastrosAtivos, resolveCadastroAtivo } from "@/lib/ativosFundosCadastro";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { CronogramaFluxosRf } from "@/components/ativos/CronogramaFluxosRf";

// Tipos de fundo para a coluna "Tipo do Fundo" (inclui FIDC NP para fundos Não Padronizados)
const TIPOS_FUNDO = ["Ações", "Cambial", "Cotas", "ETF", "FIAGRO", "FIDC", "FIDC NP", "FII", "FIP", "Multimercados", "Previdência", "Renda Fixa", "Título Público"].sort();

type Ativo = {
  id: string;
  tipo_ativo: string;
  descricao: string | null;
  nome_frontend: string | null;
  isin: string | null;
  cnpj: string | null;
  ticker: string | null;
  codigo_cetip_selic: string | null;
  matricula_imovel: string | null;
  endereco_imovel: string | null;
  validado: boolean;
  created_at: string;
  caracteristica_investidor?: string | null;
  tipo_publico_alvo?: string | null;
  nivel1_categoria?: string | null;
  prazo_pagamento_resgate_dias?: number | null;
  prazo_liquidez_manual_dias?: number | null;
  prazo_duracao_fundo_anos?: number | null;
  abertura_estatutariamente?: string | null;
  cadastro_caracteristica_id?: string | null;
  cadastro_nome?: string | null;
  cadastro_fonte?: string | null;
  nome_exibicao?: string | null;
  /** Nome ANBIMA por ISIN ou descricao do XML — exibido como "Descricao origem". */
  descricao_origem_exibicao?: string;
  /** Ativo possui amortizações intermediárias cadastradas em titulo_rf_fluxo. */
  usa_fluxo_intermediario?: boolean;
  metodo_prazo_rf?: "vencimento" | "fluxo_nominal";
};

type FundoComAtivo = {
  fundoCnpj: string;
  fundoNome: string;
  ultimaDataPosicao: string | null;
  ocorrencias: number;
  ultimoArquivo: string | null;
};

type FundoFiltroOption = {
  cnpj: string;
  nome: string;
};

type SortField = 'validado' | 'tipo_ativo' | 'nivel1_categoria' | 'prazo_pagamento_resgate_dias' | 'prazo_liquidez_manual_dias' | 'abertura_estatutariamente' | 'tipo_publico_alvo' | 'nome_frontend' | 'isin' | 'cnpj';
type SortDirection = 'asc' | 'desc' | null;

export default function Ativos() {
  const [searchTerm, setSearchTerm] = useState("");
  const [tipoFilter, setTipoFilter] = useState("ALL");
  const [validadoFilter, setValidadoFilter] = useState("ALL");
  const [fundoFilter, setFundoFilter] = useState("ALL");
  const [selectedAtivoId, setSelectedAtivoId] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);
  const [tipoFundoFilters, setTipoFundoFilters] = useState<string[]>([]);
  const [condominioFilters, setCondominioFilters] = useState<string[]>([]);
  const [publicoAlvoFilters, setPublicoAlvoFilters] = useState<string[]>([]);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ── Import cronograma RF ──────────────────────────────────────────────────
  const [cronogramaDialogOpen, setCronogramaDialogOpen] = useState(false);
  const [cronogramaTipoChave, setCronogramaTipoChave] = useState<"cetip" | "isin">("cetip");
  const [cronogramaFile, setCronogramaFile] = useState<File | null>(null);
  const [cronogramaResultado, setCronogramaResultado] = useState<{
    linhas_importadas: number;
    chaves_distintas: string[];
    ativos_marcados_fluxo: number;
    erros_parse: string[];
  } | null>(null);
  const [cronogramaUploading, setCronogramaUploading] = useState(false);
  const cronogramaInputRef = useRef<HTMLInputElement>(null);

  async function handleCronogramaUpload() {
    if (!cronogramaFile) return;
    setCronogramaUploading(true);
    setCronogramaResultado(null);
    try {
      const form = new FormData();
      form.append("file", cronogramaFile);
      form.append("tipo_chave", cronogramaTipoChave);
      const { data, error } = await supabase.functions.invoke<{
        success: boolean;
        linhas_importadas: number;
        chaves_distintas: string[];
        ativos_marcados_fluxo: number;
        erros_parse: string[];
        error?: string;
      }>("import-titulo-rf-fluxo", { body: form });
      if (error || !data?.success) {
        throw new Error(data?.error ?? error?.message ?? "Erro desconhecido");
      }
      setCronogramaResultado(data);
      queryClient.invalidateQueries({ queryKey: ["ativos"] });
      toast({
        title: "Cronograma importado",
        description: `${data.linhas_importadas} fluxo(s) — ${data.chaves_distintas.length} ativo(s) identificado(s).`,
      });
    } catch (e: any) {
      toast({
        title: "Erro na importação",
        description: e?.message || "Não foi possível importar o cronograma.",
        variant: "destructive",
      });
    } finally {
      setCronogramaUploading(false);
    }
  }

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      // Cicla entre: asc -> desc -> null
      if (sortDirection === 'asc') {
        setSortDirection('desc');
      } else if (sortDirection === 'desc') {
        setSortDirection(null);
        setSortField(null);
      }
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return <ChevronsUpDown className="h-3 w-3 text-muted-foreground/50" />;
    }
    if (sortDirection === 'asc') {
      return <ChevronUp className="h-3 w-3 text-primary" />;
    }
    return <ChevronDown className="h-3 w-3 text-primary" />;
  };

  const getSortTitle = (label: string) => {
    if (!sortField) return `Clique para ordenar por ${label}`;
    if (sortDirection === 'asc') return `${label}: crescente`;
    if (sortDirection === 'desc') return `${label}: decrescente`;
    return `Clique para ordenar por ${label}`;
  };

  const SortableHead = ({ 
    field, 
    label, 
    className = "",
    trailing 
  }: { 
    field: SortField; 
    label: string; 
    className?: string;
    trailing?: React.ReactNode;
  }) => (
    <TableHead className={className}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => handleSort(field)}
          title={getSortTitle(label)}
          className={cn(
            "inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider hover:text-foreground transition-colors",
            sortField === field && sortDirection !== null ? "text-primary" : "text-muted-foreground"
          )}
        >
          <span>{label}</span>
          {getSortIcon(field)}
        </button>
        {trailing}
      </div>
    </TableHead>
  );

  const { data: fundosFiltro = [] } = useQuery<FundoFiltroOption[]>({
    queryKey: ["ativos-fundos-filtro"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("posicao_carteira" as any)
        .select("fundo_cnpj, nome_fundo, fundo_nome")
        .not("fundo_cnpj", "is", null);

      if (error) throw error;

      const map = new Map<string, FundoFiltroOption>();
      for (const row of (data || []) as any[]) {
        const cnpj = String(row.fundo_cnpj || "").replace(/\D/g, "");
        if (!cnpj) continue;
        const nome = String(row.nome_fundo || row.fundo_nome || cnpj).trim() || cnpj;
        if (!map.has(cnpj)) map.set(cnpj, { cnpj, nome });
      }

      return Array.from(map.values()).sort((a, b) => a.nome.localeCompare(b.nome));
    },
  });

  const { data: ativos, isLoading, refetch } = useQuery<Ativo[]>({
    queryKey: ["ativos", tipoFilter, validadoFilter, fundoFilter],
    queryFn: async () => {
      let query = supabase
        .from("ativos" as any)
        .select("*")
        .order("validado", { ascending: true }) // Mostra os não validados primeiro
        .order("nome_frontend", { ascending: true })
        .order("descricao", { ascending: true });

      if (tipoFilter !== "ALL") {
        query = query.eq("tipo_ativo", tipoFilter);
      }

      if (validadoFilter !== "ALL") {
        query = query.eq("validado", validadoFilter === "TRUE");
      }

      const { data, error } = await query;
      if (error) throw error;
      let ativosRows = (data || []) as any[];

      if (fundoFilter !== "ALL") {
        const { data: latestDateData, error: latestDateError } = await supabase
          .from("posicao_carteira" as any)
          .select("fundo_dtposicao")
          .eq("fundo_cnpj", fundoFilter)
          .order("fundo_dtposicao", { ascending: false })
          .limit(1);

        if (latestDateError) throw latestDateError;
        const latestDate = latestDateData?.[0]?.fundo_dtposicao;
        if (!latestDate) return [];

        const { data: ativosNoFundo, error: ativosNoFundoError } = await supabase
          .from("posicao_carteira" as any)
          .select("ativo_id")
          .eq("fundo_cnpj", fundoFilter)
          .eq("fundo_dtposicao", latestDate)
          .not("ativo_id", "is", null);

        if (ativosNoFundoError) throw ativosNoFundoError;

        const ativosIds = new Set(
          ((ativosNoFundo || []) as any[])
            .map((row) => row.ativo_id)
            .filter((id) => id != null)
            .map((id) => String(id))
        );

        ativosRows = ativosRows.filter((ativo) => ativosIds.has(String(ativo.id)));
      }

      // O cadastro ANBIMA é a fonte principal; fund_master completa os campos CVM.
      // Uma linha de subclasse só é usada quando o ISIN a identifica sem ambiguidade.
      const { caracteristicas, registros } = await fetchCadastrosAtivos(ativosRows);
      const mappedAtivos = ativosRows.map((ativo) => {
        if (ativo.tipo_ativo !== "FUNDO" && ativo.tipo_ativo !== "FIDC") {
          return {
            ...ativo,
            descricao_origem_exibicao: resolveDescricaoOrigemAtivo(ativo, {}),
          };
        }

        const cadastro = resolveCadastroAtivo(ativo, caracteristicas, registros);
        const nomeSalvo = String(ativo.nome_frontend || "").trim();
        const nomeGenerico = !nomeSalvo || /^(FUNDO CNPJ|FUNDO|FIDC)(?:\s*-?\s*\d{14})?$/i.test(nomeSalvo);
        return {
          ...ativo,
          cadastro_caracteristica_id: cadastro.caracteristica?.id ?? null,
          cadastro_nome: cadastro.nome,
          cadastro_fonte: cadastro.fonte,
          nome_exibicao: nomeGenerico
            ? cadastro.nome || ativo.descricao || nomeSalvo
            : nomeSalvo,
          caracteristica_investidor: cadastro.caracteristica?.caracteristica_investidor ?? ativo.caracteristica_investidor ?? null,
          tipo_publico_alvo: cadastro.publicoAlvo ?? ativo.tipo_publico_alvo ?? null,
          nivel1_categoria: cadastro.caracteristica?.nivel1_categoria ?? ativo.nivel1_categoria ?? null,
          prazo_pagamento_resgate_dias: cadastro.caracteristica?.prazo_pagamento_resgate_dias ?? ativo.prazo_pagamento_resgate_dias ?? null,
          abertura_estatutariamente: cadastro.condominio ?? ativo.abertura_estatutariamente ?? null,
          descricao_origem_exibicao: cadastro.nome || resolveDescricaoOrigemAtivo(ativo, {}),
        };
      }) as Ativo[];

      return mappedAtivos;
    },
  });

  // Aplicar filtros e ordenação client-side
  const sortedAtivos = useMemo(() => {
    if (!ativos) return ativos;

    // Aplicar filtros primeiro
    let filtered = ativos;

    const search = searchTerm.trim().toLocaleLowerCase("pt-BR");
    if (search) {
      const digits = search.replace(/\D/g, "");
      filtered = filtered.filter((ativo) => {
        const fields = [ativo.nome_exibicao, ativo.nome_frontend, ativo.cadastro_nome, ativo.descricao, ativo.isin, ativo.ticker, ativo.cnpj];
        return fields.some((field) => String(field || "").toLocaleLowerCase("pt-BR").includes(search))
          || (digits.length > 0 && String(ativo.cnpj || "").replace(/\D/g, "").includes(digits));
      });
    }

    if (tipoFundoFilters.length > 0) {
      filtered = filtered.filter(a => 
        a.nivel1_categoria && tipoFundoFilters.includes(a.nivel1_categoria)
      );
    }

    if (condominioFilters.length > 0) {
      filtered = filtered.filter(a => 
        a.abertura_estatutariamente && condominioFilters.includes(a.abertura_estatutariamente)
      );
    }

    if (publicoAlvoFilters.length > 0) {
      filtered = filtered.filter(a => 
        a.tipo_publico_alvo && publicoAlvoFilters.includes(a.tipo_publico_alvo)
      );
    }

    // Aplicar ordenação
    if (!sortField || !sortDirection) return filtered;

    return [...filtered].sort((a, b) => {
      let aVal = sortField === "nome_frontend" ? a.nome_exibicao : a[sortField];
      let bVal = sortField === "nome_frontend" ? b.nome_exibicao : b[sortField];

      // Tratamento especial para valores nulos
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return sortDirection === 'asc' ? 1 : -1;
      if (bVal == null) return sortDirection === 'asc' ? -1 : 1;

      // Comparação numérica
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
      }

      // Comparação booleana
      if (typeof aVal === 'boolean' && typeof bVal === 'boolean') {
        return sortDirection === 'asc' 
          ? (aVal === bVal ? 0 : aVal ? 1 : -1)
          : (aVal === bVal ? 0 : aVal ? -1 : 1);
      }

      // Comparação de strings
      const aStr = String(aVal || '').toLowerCase();
      const bStr = String(bVal || '').toLowerCase();
      return sortDirection === 'asc' 
        ? aStr.localeCompare(bStr)
        : bStr.localeCompare(aStr);
    });
  }, [ativos, searchTerm, sortField, sortDirection, tipoFundoFilters, condominioFilters, publicoAlvoFilters]);

  // Extrair valores únicos para filtros
  const tipoFundoOptions = useMemo(() => {
    if (!ativos) return [];
    const unique = new Set(ativos.map(a => a.nivel1_categoria).filter(Boolean) as string[]);
    return Array.from(unique).sort();
  }, [ativos]);

  const condominioOptions = useMemo(() => {
    if (!ativos) return [];
    const unique = new Set(ativos.map(a => a.abertura_estatutariamente).filter(Boolean) as string[]);
    return Array.from(unique).sort();
  }, [ativos]);

  const publicoAlvoOptions = useMemo(() => {
    if (!ativos) return [];
    const unique = new Set(ativos.map(a => a.tipo_publico_alvo).filter(Boolean) as string[]);
    return Array.from(unique).sort();
  }, [ativos]);

  const toggleFilter = (filters: string[], setFilters: (v: string[]) => void, value: string) => {
    if (filters.includes(value)) {
      setFilters(filters.filter(v => v !== value));
    } else {
      setFilters([...filters, value]);
    }
  };

  const FilterPopover = ({ 
    options, 
    selectedFilters, 
    setFilters, 
    label 
  }: { 
    options: string[]; 
    selectedFilters: string[]; 
    setFilters: (v: string[]) => void; 
    label: string;
  }) => (
    <Popover>
      <PopoverTrigger asChild>
        <button 
          className="ml-1 hover:bg-accent rounded p-0.5 transition-colors relative"
          onClick={(e) => e.stopPropagation()}
          title={selectedFilters.length > 0 ? `${selectedFilters.length} filtro(s) ativo(s)` : "Filtrar"}
        >
          <Filter className={cn(
            "h-3 w-3",
            selectedFilters.length > 0 ? "text-primary" : "text-muted-foreground/50"
          )} />
          {selectedFilters.length > 0 && (
            <span className="absolute -top-1 -right-1 h-2 w-2 bg-primary rounded-full" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
        <div className="space-y-2">
          <div className="font-semibold text-sm mb-3">{label}</div>
          {options.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhuma opção disponível</p>
          ) : (
            <>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {options.map(option => (
                  <div key={option} className="flex items-center space-x-2">
                    <Checkbox
                      id={`filter-${label}-${option}`}
                      checked={selectedFilters.includes(option)}
                      onCheckedChange={() => toggleFilter(selectedFilters, setFilters, option)}
                    />
                    <Label
                      htmlFor={`filter-${label}-${option}`}
                      className="text-xs font-normal cursor-pointer flex-1"
                    >
                      {option}
                    </Label>
                  </div>
                ))}
              </div>
              {selectedFilters.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-xs"
                  onClick={() => setFilters([])}
                >
                  Limpar filtros
                </Button>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );

  const handleValidate = async (id: string) => {
    try {
      const { error } = await supabase
        .from("ativos" as any)
        .update({ validado: true })
        .eq("id", id);

      if (error) throw error;

      toast({
        title: "Ativo validado",
        description: "O ativo foi marcado como validado com sucesso.",
      });
      refetch();
    } catch (error) {
      toast({
        title: "Erro ao validar",
        description: "Não foi possível validar o ativo no momento.",
        variant: "destructive",
      });
    }
  };

  const updateTipoFundoMutation = useMutation({
    mutationFn: async ({ ativoId, caracteristicaId, valor }: { ativoId: string; caracteristicaId?: string | null; valor: string }) => {
      if (caracteristicaId) {
        const { error } = await supabase
          .from("fundos_caracteristicas" as any)
          .update({ nivel1_categoria: valor })
          .eq("id", caracteristicaId);
        if (error) throw error;
      }
      const { error } = await supabase.from("ativos" as any).update({ nivel1_categoria: valor }).eq("id", ativoId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ativos"] });
      toast({ title: "Tipo do Fundo atualizado", description: "A alteração foi salva com sucesso." });
    },
    onError: (e: any) => {
      toast({
        title: "Erro ao atualizar",
        description: e?.message || "Não foi possível atualizar o Tipo do Fundo.",
        variant: "destructive",
      });
    },
  });

  /** Espelha o prazo somente na linha ANBIMA identificada, preservando as demais subclasses. */
  const syncPrazoResgateFundosCaracteristicas = async (
    caracteristicaId: string | null | undefined,
    dias: number | null,
  ) => {
    if (!caracteristicaId) return;
    const { error } = await supabase
      .from("fundos_caracteristicas" as any)
      .update({ prazo_pagamento_resgate_dias: dias })
      .eq("id", caracteristicaId);
    if (error) throw error;
  };

  const updatePrazoLiquidezManualMutation = useMutation({
    mutationFn: async ({
      ativoId,
      dias,
      tipoAtivo,
      caracteristicaId,
    }: {
      ativoId: string;
      dias: number | null;
      tipoAtivo?: string;
      caracteristicaId?: string | null;
    }) => {
      const { data: updated, error } = await supabase
        .from("ativos" as any)
        .update({ prazo_liquidez_manual_dias: dias })
        .eq("id", ativoId)
        .select("id")
        .maybeSingle();

      if (error) throw error;
      if (!updated) throw new Error("Nenhum registro atualizado em ativos — verifique permissões ou o ID do ativo.");

      if ((tipoAtivo === "FUNDO" || tipoAtivo === "FIDC") && caracteristicaId) {
        await syncPrazoResgateFundosCaracteristicas(caracteristicaId, dias);
      }
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["ativos"] });
      const synced = (variables.tipoAtivo === "FUNDO" || variables.tipoAtivo === "FIDC") && variables.caracteristicaId;
      toast({
        title: "Liquidez manual atualizada",
        description: synced
          ? "Salvo em ativos e sincronizado com Características do Fundo (liquidez)."
          : "A alteração foi salva com sucesso.",
      });
    },
    onError: (e: any) => {
      toast({
        title: "Erro ao atualizar",
        description: e?.message || "Não foi possível atualizar a liquidez manual.",
        variant: "destructive",
      });
    },
  });

  const updateNomeFrontendMutation = useMutation({
    mutationFn: async ({ ativoId, nomeFrontend }: { ativoId: string; nomeFrontend: string | null }) => {
      const { error } = await supabase
        .from("ativos" as any)
        .update({ nome_frontend: nomeFrontend })
        .eq("id", ativoId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ativos"] });
      toast({ title: "Nome frontend atualizado", description: "A alteracao foi salva com sucesso." });
    },
    onError: (e: any) => {
      toast({
        title: "Erro ao atualizar",
        description: e?.message || "Nao foi possivel atualizar o nome frontend.",
        variant: "destructive",
      });
    },
  });

  const updatePrazoDuracaoMutation = useMutation({
    mutationFn: async ({ ativoId, anos }: { ativoId: string; anos: number | null }) => {
      const { error } = await supabase
        .from("ativos" as any)
        .update({ prazo_duracao_fundo_anos: anos })
        .eq("id", ativoId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ativos"] });
      toast({ title: "Prazo de duração (anos) atualizado", description: "A alteração foi salva com sucesso." });
    },
    onError: (e: any) => {
      toast({
        title: "Erro ao atualizar",
        description: e?.message || "Não foi possível atualizar o prazo de duração em anos.",
        variant: "destructive",
      });
    },
  });

  const updateIsinMutation = useMutation({
    mutationFn: async ({
      ativoId,
      isin,
    }: {
      ativoId: string;
      isin: string | null;
    }) => {
      const { error: ativoErr } = await supabase
        .from("ativos" as any)
        .update({ isin })
        .eq("id", ativoId);
      if (ativoErr) throw ativoErr;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ativos"] });
      toast({ title: "ISIN atualizado", description: "A alteração foi salva com sucesso." });
    },
    onError: (e: any) => {
      toast({
        title: "Erro ao atualizar ISIN",
        description: e?.message || "Não foi possível salvar o ISIN.",
        variant: "destructive",
      });
    },
  });

  const selectedAtivo = sortedAtivos?.find((ativo) => ativo.id === selectedAtivoId) || null;

  const syncAtivosMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('sync-ativos-carteira', {
        body: {}
      });
      
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["ativos"] });
      toast({
        title: "Sincronização concluída",
        description: `${data?.ativosCriados || 0} novos ativos criados, ${data?.registrosAtualizados || 0} registros atualizados.`,
      });
    },
    onError: (e: any) => {
      toast({
        title: "Erro na sincronização",
        description: e?.message || "Não foi possível sincronizar os ativos.",
        variant: "destructive",
      });
    },
  });

  const { data: fundosComAtivo, isLoading: isLoadingFundosComAtivo } = useQuery({
    queryKey: ["ativos-fundos-com-ativo", selectedAtivoId],
    enabled: Boolean(selectedAtivoId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("posicao_carteira" as any)
        .select("fundo_cnpj, nome_fundo, fundo_nome, fundo_dtposicao, arquivo_nome")
        .eq("ativo_id", selectedAtivoId as string);

      if (error) throw error;

      const fundosMap = new Map<string, FundoComAtivo>();
      for (const row of (data || []) as any[]) {
        const fundoCnpj = String(row.fundo_cnpj || "").replace(/\D/g, "");
        if (!fundoCnpj) continue;

        const fundoNome = String(row.nome_fundo || row.fundo_nome || "").trim() || fundoCnpj;
        const fundoDtposicao = row.fundo_dtposicao ? String(row.fundo_dtposicao) : null;
        const arquivoNome = row.arquivo_nome ? String(row.arquivo_nome) : null;
        const current = fundosMap.get(fundoCnpj);

        if (!current) {
          fundosMap.set(fundoCnpj, {
            fundoCnpj,
            fundoNome,
            ultimaDataPosicao: fundoDtposicao,
            ocorrencias: 1,
            ultimoArquivo: arquivoNome
          });
          continue;
        }

        const ultimaAtual = current.ultimaDataPosicao || "";
        const candidata = fundoDtposicao || "";
        current.ocorrencias += 1;
        if (candidata > ultimaAtual) {
          current.ultimaDataPosicao = fundoDtposicao;
          current.ultimoArquivo = arquivoNome;
          current.fundoNome = fundoNome || current.fundoNome;
        }
      }

      return Array.from(fundosMap.values()).sort((a, b) => {
        const dateA = a.ultimaDataPosicao || "";
        const dateB = b.ultimaDataPosicao || "";
        if (dateA !== dateB) return dateB.localeCompare(dateA);
        return a.fundoNome.localeCompare(b.fundoNome);
      });
    },
  });

  const getTipoFundoDisplayValue = (ativo: Ativo) => {
    if (ativo.nivel1_categoria) return ativo.nivel1_categoria;
    const nome = (ativo.descricao || "").toUpperCase();
    if (nome.includes("NP")) return "FIDC NP";
    return "";
  };

  const getTipoIcon = (tipo: string) => {
    switch (tipo) {
      case "FUNDO": return <Database className="h-4 w-4" />;
      case "ACAO": return <Tag className="h-4 w-4" />;
      case "TITULO_PUBLICO":
      case "TITULO_PRIVADO": return <FileText className="h-4 w-4" />;
      case "IMOVEL": return <Building2 className="h-4 w-4" />;
      case "CAIXA": return <Coins className="h-4 w-4" />;
      default: return <Tag className="h-4 w-4" />;
    }
  };

  const formatCnpj = (cnpj: string | null) => {
    if (!cnpj || cnpj.length !== 14) return cnpj;
    return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  };

  const formatDate = (yyyymmdd: string | null) => {
    if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd || "-";
    return `${yyyymmdd.slice(6, 8)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(0, 4)}`;
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Cardápio de Ativos</h1>
            <p className="text-muted-foreground mt-1">
              Catálogo mestre de ativos identificados nos XMLs de carteira.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => { setCronogramaFile(null); setCronogramaResultado(null); setCronogramaDialogOpen(true); }}
              variant="outline"
              className="gap-2"
              title="Importar cronograma de amortizações/juros para títulos RF (Art. 4º §2º II)"
            >
              <FileUp className="h-4 w-4" />
              Cronograma RF
            </Button>
            <Button
              onClick={() => syncAtivosMutation.mutate()}
              disabled={syncAtivosMutation.isPending}
              variant="outline"
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${syncAtivosMutation.isPending ? 'animate-spin' : ''}`} />
              Sincronizar Ativos
            </Button>
          </div>
        </div>

        {/* Dialog: importação de cronograma RF */}
        <Dialog open={cronogramaDialogOpen} onOpenChange={setCronogramaDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FileUp className="h-4 w-4" />
                Importar Cronograma RF
              </DialogTitle>
              <DialogDescription>
                Importa amortizações e juros de títulos com pagamentos intermediários.
                O prazo médio tributário passará a ser calculado conforme Art. 4º §2º inciso II
                IN RFB 1585/2015 (WAM por fluxos nominais).
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="space-y-1">
                <Label className="text-xs font-semibold uppercase tracking-wide">Tipo de chave padrão</Label>
                <p className="text-xs text-muted-foreground">
                  Usado quando a coluna <code>chave_ativo</code> não contém prefixo
                  {" "}<code>isin:</code> / <code>cetip:</code>.
                </p>
                <Select
                  value={cronogramaTipoChave}
                  onValueChange={(v) => setCronogramaTipoChave(v as "cetip" | "isin")}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cetip">CETIP / SELIC (código interno)</SelectItem>
                    <SelectItem value="isin">ISIN (BR...)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label className="text-xs font-semibold uppercase tracking-wide">Arquivo (CSV ou XLSX)</Label>
                <p className="text-xs text-muted-foreground">
                  Colunas obrigatórias: <code>chave_ativo</code>, <code>data_pagamento</code>, <code>valor_nominal</code>.
                  Opcional: <code>tipo_fluxo</code> (amortizacao / juros / residual), <code>ordem</code>.
                </p>
                <div
                  className="border-2 border-dashed rounded-lg p-4 text-center cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => cronogramaInputRef.current?.click()}
                >
                  {cronogramaFile ? (
                    <p className="text-sm font-medium">{cronogramaFile.name}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">Clique ou arraste o arquivo aqui</p>
                  )}
                  <input
                    ref={cronogramaInputRef}
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    className="hidden"
                    onChange={(e) => { setCronogramaFile(e.target.files?.[0] ?? null); setCronogramaResultado(null); }}
                  />
                </div>
              </div>

              {cronogramaResultado && (
                <div className="rounded-md bg-muted p-3 space-y-1 text-xs">
                  <p className="font-semibold text-foreground">
                    {cronogramaResultado.linhas_importadas} fluxo(s) importado(s)
                  </p>
                  <p className="text-muted-foreground">
                    Ativos com fluxo intermediário ativado: {cronogramaResultado.ativos_marcados_fluxo}
                  </p>
                  {cronogramaResultado.chaves_distintas.length > 0 && (
                    <p className="text-muted-foreground">
                      Chaves: {cronogramaResultado.chaves_distintas.join(", ")}
                    </p>
                  )}
                  {cronogramaResultado.erros_parse.length > 0 && (
                    <div className="mt-1 text-amber-700 dark:text-amber-400">
                      <p className="font-semibold">Avisos ({cronogramaResultado.erros_parse.length}):</p>
                      <ul className="list-disc ml-4">
                        {cronogramaResultado.erros_parse.slice(0, 5).map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                        {cronogramaResultado.erros_parse.length > 5 && (
                          <li>… e mais {cronogramaResultado.erros_parse.length - 5} aviso(s)</li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setCronogramaDialogOpen(false)}>
                Fechar
              </Button>
              <Button
                onClick={handleCronogramaUpload}
                disabled={!cronogramaFile || cronogramaUploading}
                className="gap-2"
              >
                {cronogramaUploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FileUp className="h-4 w-4" />
                )}
                {cronogramaUploading ? "Importando…" : "Importar"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="flex flex-col md:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por descrição, ISIN, CNPJ ou Ticker..."
              className="pl-9"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="w-full md:w-64">
            <Select value={tipoFilter} onValueChange={setTipoFilter}>
              <SelectTrigger>
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4" />
                  <SelectValue placeholder="Filtrar por tipo" />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Todos os Tipos</SelectItem>
                <SelectItem value="FUNDO">Fundos</SelectItem>
                <SelectItem value="FIDC">FIDCs</SelectItem>
                <SelectItem value="ACAO">Ações</SelectItem>
                <SelectItem value="TITULO_PUBLICO">Títulos Públicos</SelectItem>
                <SelectItem value="TITULO_PRIVADO">Títulos Privados</SelectItem>
                <SelectItem value="IMOVEL">Imóveis</SelectItem>
                <SelectItem value="CAIXA">Caixa</SelectItem>
                <SelectItem value="PARTICIPACAO">Participações</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-full md:w-64">
            <Select value={validadoFilter} onValueChange={setValidadoFilter}>
              <SelectTrigger>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" />
                  <SelectValue placeholder="Status de Validação" />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Todos os Status</SelectItem>
                <SelectItem value="FALSE">Pendente</SelectItem>
                <SelectItem value="TRUE">Validado</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-full md:w-80">
            <Select value={fundoFilter} onValueChange={setFundoFilter}>
              <SelectTrigger>
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4" />
                  <SelectValue placeholder="Filtrar por Fundo" />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Todos os Fundos</SelectItem>
                {fundosFiltro.map((fundo) => (
                  <SelectItem key={fundo.cnpj} value={fundo.cnpj}>
                    {fundo.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">
                  Ativos Cadastrados ({sortedAtivos?.length || 0})
                  {(tipoFundoFilters.length > 0 || condominioFilters.length > 0 || publicoAlvoFilters.length > 0) && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      ({tipoFundoFilters.length + condominioFilters.length + publicoAlvoFilters.length} filtro(s) ativo(s))
                    </span>
                  )}
                </CardTitle>
                {(tipoFundoFilters.length > 0 || condominioFilters.length > 0 || publicoAlvoFilters.length > 0) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setTipoFundoFilters([]);
                      setCondominioFilters([]);
                      setPublicoAlvoFilters([]);
                    }}
                    className="text-xs"
                  >
                    Limpar todos os filtros
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto w-full">
              <Table className="min-w-[1400px]">
                <TableHeader>
                  <TableRow>
                    <SortableHead field="validado" label="Status" className="w-[90px] shrink-0" />
                    <SortableHead field="tipo_ativo" label="Tipo" className="w-[110px] shrink-0" />
                    <SortableHead 
                      field="nivel1_categoria" 
                      label="Tipo do Fundo" 
                      className="w-[150px] shrink-0"
                      trailing={
                        <FilterPopover
                          options={tipoFundoOptions}
                          selectedFilters={tipoFundoFilters}
                          setFilters={setTipoFundoFilters}
                          label="Tipo do Fundo"
                        />
                      }
                    />
                    <SortableHead 
                      field="prazo_pagamento_resgate_dias" 
                      label="Liq. ANBIMA" 
                      className="w-[80px] shrink-0" 
                    />
                    <SortableHead 
                      field="prazo_liquidez_manual_dias" 
                      label="Liq. Manual" 
                      className="w-[100px] shrink-0" 
                    />
                    <SortableHead 
                      field="abertura_estatutariamente" 
                      label="Condomínio" 
                      className="w-[90px] shrink-0"
                      trailing={
                        <FilterPopover
                          options={condominioOptions}
                          selectedFilters={condominioFilters}
                          setFilters={setCondominioFilters}
                          label="Condomínio"
                        />
                      }
                    />
                    <SortableHead 
                      field="tipo_publico_alvo" 
                      label="Público-Alvo" 
                      className="w-[100px] shrink-0"
                      trailing={
                        <FilterPopover
                          options={publicoAlvoOptions}
                          selectedFilters={publicoAlvoFilters}
                          setFilters={setPublicoAlvoFilters}
                          label="Público-Alvo"
                        />
                      }
                    />
                    <TableHead className="w-[110px] shrink-0 text-[10px] font-bold uppercase text-muted-foreground">
                      Duração (anos)
                    </TableHead>
                    <SortableHead 
                      field="nome_frontend" 
                      label="Nome Frontend" 
                      className="w-[260px] shrink-0" 
                    />
                    <SortableHead 
                      field="isin" 
                      label="ISIN" 
                      className="w-[145px] shrink-0" 
                    />
                    <SortableHead 
                      field="cnpj" 
                      label="Identificadores" 
                      className="w-[180px] shrink-0" 
                    />
                    <TableHead className="w-[160px] shrink-0 text-[10px] font-bold uppercase text-muted-foreground">
                      Perfil/Detalhes
                    </TableHead>
                    <TableHead className="w-[80px] shrink-0 text-right text-[10px] font-bold uppercase text-muted-foreground">
                      Ação
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell><Skeleton className="h-6 w-24" /></TableCell>
                        <TableCell><Skeleton className="h-6 w-20" /></TableCell>
                        <TableCell><Skeleton className="h-6 w-16" /></TableCell>
                        <TableCell><Skeleton className="h-6 w-16" /></TableCell>
                        <TableCell><Skeleton className="h-6 w-16" /></TableCell>
                        <TableCell><Skeleton className="h-6 w-20" /></TableCell>
                        <TableCell><Skeleton className="h-6 w-48" /></TableCell>
                        <TableCell><Skeleton className="h-6 w-28" /></TableCell>
                        <TableCell><Skeleton className="h-6 w-32" /></TableCell>
                        <TableCell><Skeleton className="h-6 w-32" /></TableCell>
                        <TableCell><Skeleton className="h-6 w-24" /></TableCell>
                        <TableCell><Skeleton className="h-6 w-24" /></TableCell>
                        <TableCell><Skeleton className="h-6 w-16" /></TableCell>
                      </TableRow>
                    ))
                  ) : sortedAtivos?.length === 0 ? (
                    <TableRow>
                        <TableCell colSpan={13} className="h-24 text-center text-muted-foreground">
                        Nenhum ativo encontrado.
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedAtivos?.map((ativo) => (
                    <TableRow key={ativo.id}>
                      <TableCell>
                        {ativo.validado ? (
                          <div className="flex items-center gap-1.5 text-green-600 font-medium text-xs">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Validado
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-yellow-600 font-medium text-xs">
                            <AlertCircle className="h-3.5 w-3.5" />
                            Pendente
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 text-xs font-medium text-foreground/80">
                          {getTipoIcon(ativo.tipo_ativo)}
                          {ativo.tipo_ativo}
                        </div>
                      </TableCell>
                      <TableCell>
                         {ativo.tipo_ativo === "FUNDO" || ativo.tipo_ativo === "FIDC" || ativo.tipo_ativo === "TITULO_PUBLICO" ? (
                          <Select
                            value={getTipoFundoDisplayValue(ativo) || "__vazio__"}
                            onValueChange={(v) => {
                               if (v && v !== "__vazio__") {
                                updateTipoFundoMutation.mutate({
                                   ativoId: ativo.id,
                                   caracteristicaId: ativo.cadastro_caracteristica_id,
                                  valor: v,
                                });
                              }
                            }}
                             disabled={updateTipoFundoMutation.isPending}
                          >
                            <SelectTrigger className="h-8 w-[140px] text-xs font-medium">
                              <SelectValue placeholder="Selecione..." />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__vazio__" className="text-muted-foreground">
                                —
                              </SelectItem>
                              {TIPOS_FUNDO.map((t) => (
                                <SelectItem key={t} value={t} className="text-xs">
                                  {t}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">
                        {ativo.prazo_pagamento_resgate_dias != null ? `D+${ativo.prazo_pagamento_resgate_dias}` : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-muted-foreground">D+</span>
                          <Input
                            type="number"
                            min={0}
                            className="h-8 w-[70px] text-xs font-mono text-center"
                            defaultValue={ativo.prazo_liquidez_manual_dias ?? ""}
                            placeholder="—"
                            disabled={updatePrazoLiquidezManualMutation.isPending}
                            onBlur={(e) => {
                              const raw = e.target.value.trim();
                              const newVal = raw === "" ? null : parseInt(raw, 10);
                              if (newVal === ativo.prazo_liquidez_manual_dias) return;
                              if (raw !== "" && isNaN(newVal!)) return;
                              updatePrazoLiquidezManualMutation.mutate({
                                ativoId: ativo.id,
                                dias: newVal,
                                tipoAtivo: ativo.tipo_ativo,
                                caracteristicaId: ativo.cadastro_caracteristica_id,
                              });
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            }}
                          />
                        </div>
                      </TableCell>
                      <TableCell>
                         {(ativo.tipo_ativo === "FUNDO" || ativo.tipo_ativo === "FIDC" || ativo.tipo_ativo === "TITULO_PUBLICO") && ativo.abertura_estatutariamente ? (
                          <Badge variant="outline" className="text-[10px] font-semibold whitespace-nowrap">
                            {ativo.abertura_estatutariamente}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                         {(ativo.tipo_ativo === "FUNDO" || ativo.tipo_ativo === "FIDC" || ativo.tipo_ativo === "TITULO_PUBLICO") && ativo.tipo_publico_alvo ? (
                          <Badge variant="secondary" className="text-[10px] font-semibold whitespace-nowrap">
                            {ativo.tipo_publico_alvo}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                         {(ativo.tipo_ativo === "FUNDO" || ativo.tipo_ativo === "FIDC" || ativo.tipo_ativo === "TITULO_PUBLICO") &&
                        (ativo.abertura_estatutariamente || "").toLowerCase().includes("fechado") ? (
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-muted-foreground">Anos</span>
                            <Input
                              type="number"
                              min={0}
                              className="h-8 w-[80px] text-xs font-mono text-center"
                              defaultValue={ativo.prazo_duracao_fundo_anos ?? ""}
                              placeholder="—"
                              disabled={updatePrazoDuracaoMutation.isPending}
                              onBlur={(e) => {
                                const raw = e.target.value.trim();
                                const newVal = raw === "" ? null : parseInt(raw, 10);
                                if (newVal === ativo.prazo_duracao_fundo_anos) return;
                                if (raw !== "" && isNaN(newVal!)) return;
                                updatePrazoDuracaoMutation.mutate({
                                  ativoId: ativo.id,
                                  anos: newVal,
                                });
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                              }}
                            />
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="space-y-1">
                           <Input
                             key={`${ativo.id}:${ativo.nome_exibicao ?? ""}`}
                            type="text"
                            className="h-8 w-[280px] text-xs"
                             defaultValue={ativo.nome_exibicao ?? ativo.nome_frontend ?? ativo.descricao ?? ""}
                            placeholder="Nome de exibicao"
                            disabled={updateNomeFrontendMutation.isPending}
                            onBlur={(e) => {
                              const raw = e.target.value.trim();
                              const newVal = raw === "" ? null : raw;
                               if (newVal === (ativo.nome_exibicao ?? ativo.nome_frontend ?? null)) return;
                              updateNomeFrontendMutation.mutate({
                                ativoId: ativo.id,
                                nomeFrontend: newVal,
                              });
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            }}
                          />
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <span>Descricao origem: {ativo.descricao_origem_exibicao || ativo.descricao || "Sem descricao"}</span>
                            <button
                              type="button"
                              onClick={() => setSelectedAtivoId(ativo.id)}
                              className="inline-flex items-center gap-1 hover:text-primary hover:underline underline-offset-4"
                            >
                              Ver detalhes
                              <ExternalLink className="h-3 w-3 opacity-60" />
                            </button>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Input
                          type="text"
                          className="h-8 w-[140px] text-xs font-mono uppercase"
                          defaultValue={ativo.isin ?? ""}
                          placeholder="BRXXXXXXXXXXXX"
                          maxLength={12}
                          disabled={updateIsinMutation.isPending}
                          onBlur={(e) => {
                            const raw = e.target.value.trim().toUpperCase();
                            const newVal = raw === "" ? null : raw;
                            if (newVal === (ativo.isin ?? null)) return;
                            updateIsinMutation.mutate({
                              ativoId: ativo.id,
                              isin: newVal,
                            });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {ativo.isin && (
                            <span className="text-xs font-mono bg-accent/50 px-1.5 py-0.5 rounded w-fit">
                              ISIN: {ativo.isin}
                            </span>
                          )}
                          {ativo.cnpj && (
                            <span className="text-xs font-mono bg-accent/50 px-1.5 py-0.5 rounded w-fit">
                              CNPJ: {formatCnpj(ativo.cnpj)}
                            </span>
                          )}
                          {ativo.ticker && (
                            <span className="text-xs font-mono bg-accent/50 px-1.5 py-0.5 rounded w-fit">
                              TICKER: {ativo.ticker}
                            </span>
                          )}
                          {ativo.codigo_cetip_selic && (
                            <span className="text-xs font-mono bg-accent/50 px-1.5 py-0.5 rounded w-fit">
                              CETIP/SELIC: {ativo.codigo_cetip_selic}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {ativo.matricula_imovel && (
                            <div className="flex items-center gap-1 text-xs text-muted-foreground">
                              <FileText className="h-3 w-3" />
                              Matrícula: {ativo.matricula_imovel}
                            </div>
                          )}
                          {ativo.endereco_imovel && (
                            <div className="flex items-center gap-1 text-xs text-muted-foreground">
                              <MapPin className="h-3 w-3" />
                              {ativo.endereco_imovel}
                            </div>
                          )}
                          {!ativo.matricula_imovel && !ativo.endereco_imovel && (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {!ativo.validado && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5 text-xs border-green-600/20 text-green-600 hover:bg-green-600 hover:text-white"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleValidate(ativo.id);
                            }}
                          >
                            <Check className="h-3.5 w-3.5" />
                            Validar
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
              </div>
            </CardContent>
          </Card>

        <Sheet open={!!selectedAtivoId} onOpenChange={(open) => !open && setSelectedAtivoId(null)}>
          <SheetContent className="w-full sm:max-w-xl border-l border-border/60 shadow-2xl overflow-y-auto bg-background p-0">
            <SheetHeader className="px-6 py-5 border-b border-border bg-muted/10">
              <SheetTitle className="text-lg font-semibold leading-tight">Detalhe do Ativo</SheetTitle>
              <SheetDescription className="font-mono text-xs text-muted-foreground">
                {selectedAtivo
                   ? selectedAtivo.nome_exibicao || selectedAtivo.nome_frontend || selectedAtivo.descricao || selectedAtivo.cnpj || selectedAtivo.isin || selectedAtivo.ticker || selectedAtivo.tipo_ativo
                  : "Ativo selecionado"}
              </SheetDescription>
            </SheetHeader>

            <div className="p-5 space-y-6">
              {selectedAtivo && (selectedAtivo.tipo_ativo === "FUNDO" || selectedAtivo.tipo_ativo === "FIDC") && (
                <div className="space-y-2">
                  <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Cadastro do fundo</p>
                  {selectedAtivo.cadastro_fonte ? (
                    <>
                      <p className="text-sm font-medium">{selectedAtivo.cadastro_nome}</p>
                      <p className="text-xs text-muted-foreground">Vínculo principal: {selectedAtivo.cadastro_fonte}</p>
                      <p className="text-xs text-muted-foreground">
                        Categoria: {selectedAtivo.nivel1_categoria || "—"} · Condomínio: {selectedAtivo.abertura_estatutariamente || "—"} · Público-alvo: {selectedAtivo.tipo_publico_alvo || "—"}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">Sem correspondência por ISIN ou CNPJ no cadastro de fundos.</p>
                  )}
                </div>
              )}

              {/* Seção: Fundos com este ativo */}
              <div className="space-y-3">
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Fundos com este ativo
                </p>
                {isLoadingFundosComAtivo ? (
                  <div className="space-y-2">
                    <Skeleton className="h-14 w-full" />
                    <Skeleton className="h-14 w-full" />
                  </div>
                ) : !fundosComAtivo || fundosComAtivo.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhum fundo vinculado encontrado.</p>
                ) : (
                  <div className="space-y-2">
                    {fundosComAtivo.map((fundo) => (
                      <div key={fundo.fundoCnpj} className="rounded-md border border-border/60 p-2.5">
                        <p className="text-sm font-medium leading-tight">{fundo.fundoNome}</p>
                        <p className="text-xs text-muted-foreground">{formatCnpj(fundo.fundoCnpj)}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Última posição: {formatDate(fundo.ultimaDataPosicao)} · {fundo.ocorrencias} registro(s)
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Seção: Cronograma RF — exibida para títulos públicos/privados ou qualquer ativo com ISIN/CETIP */}
              {selectedAtivo && (
                selectedAtivo.tipo_ativo === "TITULO_PUBLICO" ||
                selectedAtivo.tipo_ativo === "TITULO_PRIVADO" ||
                !!selectedAtivo.isin ||
                !!selectedAtivo.codigo_cetip_selic
              ) && selectedAtivo && (
                <>
                  <Separator />
                  <CronogramaFluxosRf
                    ativoId={selectedAtivo.id}
                    isin={selectedAtivo.isin ?? null}
                    codigoCetip={selectedAtivo.codigo_cetip_selic ?? null}
                    nomeAtivo={selectedAtivo.nome_frontend ?? selectedAtivo.descricao ?? selectedAtivo.tipo_ativo}
                    usaFluxoIntermediario={selectedAtivo.usa_fluxo_intermediario ?? false}
                    onUsaFluxoChange={() => queryClient.invalidateQueries({ queryKey: ["ativos"] })}
                  />
                </>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </Layout>
  );
}
