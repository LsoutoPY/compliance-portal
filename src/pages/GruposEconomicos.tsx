import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Plus, Trash2, Search, Users, Building2, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface GrupoRow {
  id: string;
  cnpj: string;
  grupo_id: string;
  grupo_nome: string;
  ativo: boolean;
  created_at: string;
}

interface GrupoAgrupado {
  grupo_id: string;
  grupo_nome: string;
  membros: GrupoRow[];
}

function formatCnpj(cnpj: string): string {
  const d = cnpj.replace(/\D/g, "");
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  return cnpj;
}

function normalizarCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, "");
}

export default function GruposEconomicos() {
  const queryClient = useQueryClient();
  const [busca, setBusca] = useState("");
  const [expandidos, setExpandidos] = useState<Set<string>>(new Set());
  const [dialogAberto, setDialogAberto] = useState(false);
  const [modoDialog, setModoDialog] = useState<"novo_grupo" | "add_membro">("novo_grupo");
  const [grupoSelecionado, setGrupoSelecionado] = useState<GrupoAgrupado | null>(null);
  const [deletarAlvo, setDeletarAlvo] = useState<GrupoRow | null>(null);

  // Form state
  const [formCnpj, setFormCnpj] = useState("");
  const [formNomeMembro, setFormNomeMembro] = useState("");
  const [formGrupoId, setFormGrupoId] = useState("");
  const [formGrupoNome, setFormGrupoNome] = useState("");

  const { data: rows = [], isLoading } = useQuery<GrupoRow[]>({
    queryKey: ["grupos-economicos"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("grupos_economicos_cnpj")
        .select("*")
        .order("grupo_id")
        .order("created_at");
      if (error) throw error;
      return data as GrupoRow[];
    },
  });

  // Agrupa por grupo_id
  const grupos: GrupoAgrupado[] = Object.values(
    rows.reduce((acc: Record<string, GrupoAgrupado>, row) => {
      if (!acc[row.grupo_id]) {
        acc[row.grupo_id] = { grupo_id: row.grupo_id, grupo_nome: row.grupo_nome, membros: [] };
      }
      acc[row.grupo_id].membros.push(row);
      return acc;
    }, {})
  );

  const gruposFiltrados = busca.trim()
    ? grupos.filter(
        (g) =>
          g.grupo_nome.toLowerCase().includes(busca.toLowerCase()) ||
          g.grupo_id.toLowerCase().includes(busca.toLowerCase()) ||
          g.membros.some(
            (m) =>
              m.cnpj.includes(busca.replace(/\D/g, "")) ||
              formatCnpj(m.cnpj).includes(busca)
          )
      )
    : grupos;

  const toggleExpandido = (grupoId: string) => {
    setExpandidos((prev) => {
      const next = new Set(prev);
      next.has(grupoId) ? next.delete(grupoId) : next.add(grupoId);
      return next;
    });
  };

  // Mutation: inserir novo membro / novo grupo
  const inserirMutation = useMutation({
    mutationFn: async (payload: { cnpj: string; grupo_id: string; grupo_nome: string }) => {
      const cnpjLimpo = normalizarCnpj(payload.cnpj);
      if (cnpjLimpo.length !== 14) throw new Error("CNPJ deve ter 14 dígitos.");

      const { error } = await supabase.from("grupos_economicos_cnpj").insert({
        cnpj: cnpjLimpo,
        grupo_id: payload.grupo_id.trim().toUpperCase().replace(/\s+/g, "_"),
        grupo_nome: payload.grupo_nome.trim(),
        ativo: true,
      });
      if (error) {
        if (error.code === "23505") throw new Error(`CNPJ ${formatCnpj(cnpjLimpo)} já está cadastrado em algum grupo.`);
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grupos-economicos"] });
      toast.success("CNPJ adicionado ao grupo com sucesso.");
      fecharDialog();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Mutation: toggle ativo
  const toggleAtivoMutation = useMutation({
    mutationFn: async ({ id, ativo }: { id: string; ativo: boolean }) => {
      const { error } = await supabase
        .from("grupos_economicos_cnpj")
        .update({ ativo })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grupos-economicos"] }),
    onError: () => toast.error("Erro ao atualizar status."),
  });

  // Mutation: deletar membro
  const deletarMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("grupos_economicos_cnpj").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grupos-economicos"] });
      toast.success("CNPJ removido do grupo.");
      setDeletarAlvo(null);
    },
    onError: () => toast.error("Erro ao remover CNPJ."),
  });

  function abrirNovoGrupo() {
    setModoDialog("novo_grupo");
    setFormCnpj("");
    setFormNomeMembro("");
    setFormGrupoId("");
    setFormGrupoNome("");
    setDialogAberto(true);
  }

  function abrirAddMembro(grupo: GrupoAgrupado) {
    setModoDialog("add_membro");
    setGrupoSelecionado(grupo);
    setFormCnpj("");
    setFormNomeMembro("");
    setFormGrupoId(grupo.grupo_id);
    setFormGrupoNome(grupo.grupo_nome);
    setDialogAberto(true);
  }

  function fecharDialog() {
    setDialogAberto(false);
    setGrupoSelecionado(null);
  }

  function handleSubmit() {
    inserirMutation.mutate({
      cnpj: formCnpj,
      grupo_id: formGrupoId,
      grupo_nome: formGrupoNome,
    });
  }

  return (
    <Layout>
      <div className="space-y-6 max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Users className="h-6 w-6 text-primary" />
              Grupos Econômicos
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              CNPJs do mesmo grupo econômico têm exposição consolidada nas regras de concentração FIDC.
            </p>
          </div>
          <Button onClick={abrirNovoGrupo} className="shrink-0">
            <Plus className="h-4 w-4 mr-2" />
            Novo Grupo
          </Button>
        </div>

        {/* Busca */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome do grupo ou CNPJ..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Lista de grupos */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
            <Loader2 className="h-5 w-5 animate-spin" />
            Carregando grupos...
          </div>
        ) : gruposFiltrados.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center text-muted-foreground">
              {busca ? "Nenhum grupo encontrado para a busca." : "Nenhum grupo econômico cadastrado."}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {gruposFiltrados.map((grupo) => {
              const expandido = expandidos.has(grupo.grupo_id);
              const ativos = grupo.membros.filter((m) => m.ativo).length;
              return (
                <Card key={grupo.grupo_id} className="overflow-hidden">
                  {/* Cabeçalho do grupo */}
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => toggleExpandido(grupo.grupo_id)}
                  >
                    <CardHeader className="py-4 px-5 hover:bg-muted/30 transition-colors">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          {expandido
                            ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                            : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                          }
                          <Building2 className="h-4 w-4 shrink-0 text-primary" />
                          <div className="min-w-0">
                            <CardTitle className="text-sm font-semibold">{grupo.grupo_nome}</CardTitle>
                            <CardDescription className="text-[11px] font-mono">{grupo.grupo_id}</CardDescription>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant="secondary" className="text-[10px]">
                            {ativos}/{grupo.membros.length} ativo(s)
                          </Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            onClick={(e) => { e.stopPropagation(); abrirAddMembro(grupo); }}
                          >
                            <Plus className="h-3 w-3 mr-1" />
                            Add CNPJ
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                  </button>

                  {/* Tabela de membros */}
                  {expandido && (
                    <CardContent className="px-0 pb-0">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/40">
                            <TableHead className="pl-5 text-[11px]">CNPJ</TableHead>
                            <TableHead className="text-[11px]">Ativo</TableHead>
                            <TableHead className="text-[11px]">Cadastrado em</TableHead>
                            <TableHead className="pr-5 text-right text-[11px]">Ações</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {grupo.membros.map((membro) => (
                            <TableRow key={membro.id} className={cn(!membro.ativo && "opacity-50")}>
                              <TableCell className="pl-5 font-mono text-xs">
                                {formatCnpj(membro.cnpj)}
                              </TableCell>
                              <TableCell>
                                <Switch
                                  checked={membro.ativo}
                                  onCheckedChange={(checked) =>
                                    toggleAtivoMutation.mutate({ id: membro.id, ativo: checked })
                                  }
                                  className="scale-75"
                                />
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {new Date(membro.created_at).toLocaleDateString("pt-BR")}
                              </TableCell>
                              <TableCell className="pr-5 text-right">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7 text-muted-foreground hover:text-red-600 hover:bg-red-50"
                                  onClick={() => setDeletarAlvo(membro)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Dialog: Novo Grupo / Add Membro */}
      <Dialog open={dialogAberto} onOpenChange={(v) => { if (!v) fecharDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {modoDialog === "novo_grupo" ? "Novo Grupo Econômico" : `Adicionar CNPJ — ${grupoSelecionado?.grupo_nome}`}
            </DialogTitle>
            <DialogDescription>
              {modoDialog === "novo_grupo"
                ? "Crie um grupo e adicione o primeiro CNPJ membro."
                : "Adicione um novo CNPJ ao grupo econômico selecionado."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Campos de grupo (apenas para novo grupo) */}
            {modoDialog === "novo_grupo" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="grupo-nome">Nome do Grupo</Label>
                  <Input
                    id="grupo-nome"
                    placeholder="Ex: Lupatech S.A. - Grupo Econômico"
                    value={formGrupoNome}
                    onChange={(e) => setFormGrupoNome(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="grupo-id">
                    ID do Grupo
                    <span className="ml-1 text-[10px] text-muted-foreground">(gerado automaticamente em maiúsculas)</span>
                  </Label>
                  <Input
                    id="grupo-id"
                    placeholder="Ex: GRUPO_LUPATECH"
                    value={formGrupoId}
                    onChange={(e) => setFormGrupoId(e.target.value)}
                    className="font-mono text-sm"
                  />
                </div>
              </>
            )}

            {/* CNPJ do membro */}
            <div className="space-y-1.5">
              <Label htmlFor="cnpj">CNPJ do Cedente/Sacado</Label>
              <Input
                id="cnpj"
                placeholder="00.000.000/0000-00"
                value={formCnpj}
                onChange={(e) => setFormCnpj(e.target.value)}
                className="font-mono"
              />
              <p className="text-[11px] text-muted-foreground">
                Com ou sem formatação. Cada CNPJ pode pertencer a apenas um grupo.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={fecharDialog}>Cancelar</Button>
            <Button
              onClick={handleSubmit}
              disabled={
                inserirMutation.isPending ||
                !formCnpj.trim() ||
                !formGrupoId.trim() ||
                !formGrupoNome.trim()
              }
            >
              {inserirMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {modoDialog === "novo_grupo" ? "Criar Grupo" : "Adicionar CNPJ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Alert: Confirmar exclusão */}
      <AlertDialog open={!!deletarAlvo} onOpenChange={(v) => { if (!v) setDeletarAlvo(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover CNPJ do grupo?</AlertDialogTitle>
            <AlertDialogDescription>
              O CNPJ <span className="font-mono font-semibold">{deletarAlvo ? formatCnpj(deletarAlvo.cnpj) : ""}</span> será
              removido do grupo <span className="font-semibold">{deletarAlvo?.grupo_id}</span>. A partir do próximo cálculo de
              enquadramento, ele voltará a ser tratado individualmente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => deletarAlvo && deletarMutation.mutate(deletarAlvo.id)}
            >
              {deletarMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
