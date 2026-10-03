import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { AlertTriangle, Plus, Pencil, ShieldCheck, Share2, Trash2 } from "lucide-react";
import {
  type GestorMonitorado,
  fetchTodosGestoresMonitorados,
  fetchGestoresDetectadosNosXmls,
  createGestorMonitorado,
  updateGestorMonitorado,
  normalizeCnpjDigits,
} from "@/lib/fundosMonitorados";
import { supabase } from "@/integrations/supabase/client";
import {
  fetchGruposConfig,
  GRUPO_LABEL,
  GRUPO_COR,
  type GrupoConfig,
} from "@/lib/mapaFundos/grupos";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

function formatCnpj(cnpj: string) {
  const d = cnpj.replace(/\D/g, "");
  if (d.length !== 14) return cnpj;
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

function invalidateMonitoramento(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ["gestores-monitorados"] });
  queryClient.invalidateQueries({ queryKey: ["gestores-monitorados-all"] });
  queryClient.invalidateQueries({ queryKey: ["gestores-detectados-xml"] });
  queryClient.invalidateQueries({ queryKey: ["funds-list"] });
  queryClient.invalidateQueries({ queryKey: ["fundos-xml-coverage"] });
}

export default function GestoresMonitorados() {
  const queryClient = useQueryClient();

  const { data: gestores = [], isLoading } = useQuery({
    queryKey: ["gestores-monitorados-all"],
    queryFn: fetchTodosGestoresMonitorados,
  });

  const cadastrados = new Set(gestores.map((g) => normalizeCnpjDigits(g.cnpj_gestor)));

  const { data: detectados = [], isLoading: loadingDetectados } = useQuery({
    queryKey: ["gestores-detectados-xml"],
    queryFn: fetchGestoresDetectadosNosXmls,
  });

  const pendentesXml = detectados.filter((d) => !cadastrados.has(d.cnpj_gestor));

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<GestorMonitorado | null>(null);
  const [form, setForm] = useState({ cnpj_gestor: "", nome: "" });
  const [saving, setSaving] = useState(false);
  const [addingCnpj, setAddingCnpj] = useState<string | null>(null);

  function openNew() {
    setEditing(null);
    setForm({ cnpj_gestor: "", nome: "" });
    setDialogOpen(true);
  }

  function openEdit(g: GestorMonitorado) {
    setEditing(g);
    setForm({ cnpj_gestor: g.cnpj_gestor, nome: g.nome });
    setDialogOpen(true);
  }

  async function handleSave() {
    const cnpjNorm = normalizeCnpjDigits(form.cnpj_gestor);
    if (cnpjNorm.length !== 14 || cnpjNorm === "00000000000000") {
      toast.error("CNPJ inválido. Informe os 14 dígitos.");
      return;
    }
    if (!form.nome.trim()) {
      toast.error("Informe o nome da gestora.");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateGestorMonitorado(editing.id, { nome: form.nome.trim() });
        toast.success("Gestor atualizado.");
      } else {
        await createGestorMonitorado(cnpjNorm, form.nome.trim());
        toast.success("Gestor cadastrado. Fundos desta gestora agora aparecem no monitoramento.");
      }
      invalidateMonitoramento(queryClient);
      setDialogOpen(false);
    } catch (e: any) {
      toast.error(e.message ?? "Erro ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(g: GestorMonitorado) {
    try {
      await updateGestorMonitorado(g.id, { ativo: !g.ativo });
      toast.success(g.ativo ? "Gestor desativado." : "Gestor reativado.");
      invalidateMonitoramento(queryClient);
    } catch (e: any) {
      toast.error(e.message ?? "Erro.");
    }
  }

  async function handleAddFromXml(cnpj: string, nome: string) {
    setAddingCnpj(cnpj);
    try {
      await createGestorMonitorado(cnpj, nome.trim() || cnpj);
      toast.success(`${nome} adicionado à allowlist.`);
      invalidateMonitoramento(queryClient);
    } catch (e: any) {
      toast.error(e.message ?? "Erro ao cadastrar.");
    } finally {
      setAddingCnpj(null);
    }
  }

  const { data: grupos = [], refetch: refetchGrupos } = useQuery({
    queryKey: ["mapa-fundos-grupos"],
    queryFn: fetchGruposConfig,
  });

  const [grupoDialog, setGrupoDialog] = useState(false);
  const [grupoForm, setGrupoForm] = useState({ cnpj: "", tipo: "gestor" as "gestor" | "admin", grupo: "A" as string });
  const [grupoSaving, setGrupoSaving] = useState(false);

  async function handleSaveGrupo() {
    const cnpj = normalizeCnpjDigits(grupoForm.cnpj);
    if (cnpj.length !== 14 || cnpj === "00000000000000") {
      toast.error("CNPJ inválido.");
      return;
    }
    setGrupoSaving(true);
    try {
      const { error } = await (supabase as any).from("mapa_fundos_grupos").upsert(
        { cnpj, tipo: grupoForm.tipo, grupo: grupoForm.grupo, ativo: true },
        { onConflict: "cnpj,tipo" },
      );
      if (error) throw error;
      toast.success("Grupo salvo.");
      queryClient.invalidateQueries({ queryKey: ["mapa-fundos-grupos"] });
      setGrupoDialog(false);
    } catch (e: any) {
      toast.error(e.message ?? "Erro.");
    } finally {
      setGrupoSaving(false);
    }
  }

  async function handleDeleteGrupo(g: GrupoConfig) {
    const { error } = await (supabase as any)
      .from("mapa_fundos_grupos")
      .delete()
      .eq("cnpj", g.cnpj)
      .eq("tipo", g.tipo);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Removido.");
    refetchGrupos();
  }

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Gestoras cujos fundos entram no monitoramento. As demais ficam só para look-through.
          </p>
          <Button size="sm" onClick={openNew} className="gap-1.5">
            <Plus className="h-4 w-4" />
            Adicionar gestora
          </Button>
        </div>

        <Tabs defaultValue="allowlist">
          <TabsList>
            <TabsTrigger value="allowlist" className="flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" /> Allowlist
            </TabsTrigger>
            <TabsTrigger value="grupos" className="flex items-center gap-1.5">
              <Share2 className="h-3.5 w-3.5" /> Grupos do mapa
            </TabsTrigger>
          </TabsList>

          <TabsContent value="grupos" className="pt-4 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Mapeamento CNPJ → grupo visual no mapa de fundos (A/B/C = Quadrante, H = Hieron, R = REAG/Arandu).
              </p>
              <Button size="sm" onClick={() => { setGrupoForm({ cnpj: "", tipo: "gestor", grupo: "A" }); setGrupoDialog(true); }} className="gap-1.5 shrink-0 ml-4">
                <Plus className="h-4 w-4" /> Adicionar grupo
              </Button>
            </div>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>CNPJ</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Grupo</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grupos.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-6">
                        Nenhum grupo cadastrado
                      </TableCell>
                    </TableRow>
                  )}
                  {grupos.map((g) => (
                    <TableRow key={`${g.cnpj}-${g.tipo}`}>
                      <TableCell className="font-mono text-xs">{g.cnpj}</TableCell>
                      <TableCell className="text-xs">{g.tipo}</TableCell>
                      <TableCell>
                        <Badge style={{ background: GRUPO_COR[g.grupo as keyof typeof GRUPO_COR] ?? "#64748b", color: "#fff" }}>
                          {g.grupo} — {GRUPO_LABEL[g.grupo as keyof typeof GRUPO_LABEL] ?? g.grupo}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-500 hover:text-red-500" onClick={() => handleDeleteGrupo(g)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="allowlist" className="pt-4 space-y-4">
            <Card>
              <CardHeader className="py-3 px-4">
                <CardTitle className="text-sm font-semibold">Gestores encontrados nos XMLs</CardTitle>
                <p className="text-xs text-muted-foreground font-normal">
                  Selecione as gestoras que devem entrar no monitoramento. As demais ficam só para look-through.
                </p>
              </CardHeader>
              <CardContent className="p-0">
                {loadingDetectados ? (
                  <p className="text-sm text-muted-foreground px-4 py-6">Lendo XMLs importados…</p>
                ) : detectados.length === 0 ? (
                  <p className="text-sm text-muted-foreground px-4 py-6">
                    Nenhum gestor nos XMLs. Importe uma posição em Dados → Importar XML.
                  </p>
                ) : pendentesXml.length === 0 ? (
                  <p className="text-sm text-muted-foreground px-4 py-6">
                    Todos os gestores dos XMLs já estão na allowlist.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs pl-4">Nome no XML</TableHead>
                        <TableHead className="text-xs">CNPJ</TableHead>
                        <TableHead className="text-xs" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pendentesXml.map((d) => (
                        <TableRow key={d.cnpj_gestor}>
                          <TableCell className="text-sm font-medium pl-4">{d.nome}</TableCell>
                          <TableCell className="font-mono text-xs">{formatCnpj(d.cnpj_gestor)}</TableCell>
                          <TableCell className="text-right pr-4">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={addingCnpj === d.cnpj_gestor}
                              onClick={() => handleAddFromXml(d.cnpj_gestor, d.nome)}
                            >
                              {addingCnpj === d.cnpj_gestor ? "Adicionando…" : "Adicionar"}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="py-3 px-4 flex-row items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  Gestoras na allowlist
                </CardTitle>
                <Badge variant="secondary" className="text-xs">
                  {gestores.filter((g) => g.ativo).length} ativa{gestores.filter((g) => g.ativo).length !== 1 ? "s" : ""}
                </Badge>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs pl-4">Nome</TableHead>
                      <TableHead className="text-xs">CNPJ</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                      <TableHead className="text-xs">Cadastrado em</TableHead>
                      <TableHead className="text-xs" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-6">
                          Carregando…
                        </TableCell>
                      </TableRow>
                    )}
                    {!isLoading && gestores.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center py-6">
                          <div className="flex flex-col items-center gap-2 text-muted-foreground">
                            <AlertTriangle className="h-6 w-6 text-amber-500" />
                            <p className="text-sm font-medium">Nenhuma gestora cadastrada</p>
                            <p className="text-xs max-w-md text-center">
                              Adicione o CNPJ da gestora CVPAR/Quadrante. Enquanto a lista estiver vazia, todos os fundos importados aparecem no monitoramento.
                            </p>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                    {gestores.map((g) => (
                      <TableRow key={g.id} className={!g.ativo ? "opacity-50" : ""}>
                        <TableCell className="text-sm font-medium pl-4">{g.nome}</TableCell>
                        <TableCell className="font-mono text-xs">{formatCnpj(g.cnpj_gestor)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={g.ativo}
                              onCheckedChange={() => handleToggle(g)}
                              className="h-4 w-7"
                            />
                            <span className="text-xs text-muted-foreground">
                              {g.ativo ? "Ativo" : "Inativo"}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {format(new Date(g.created_at), "dd/MM/yyyy", { locale: ptBR })}
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" onClick={() => openEdit(g)} className="h-7 px-2 gap-1 text-xs">
                            <Pencil className="h-3 w-3" />
                            Editar
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Editar gestora" : "Adicionar gestora à allowlist"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="cnpj">CNPJ da gestora (14 dígitos)</Label>
              <Input
                id="cnpj"
                placeholder="00.000.000/0001-00"
                value={form.cnpj_gestor}
                onChange={(e) => setForm((f) => ({ ...f, cnpj_gestor: e.target.value }))}
                disabled={!!editing}
              />
              {!editing && (
                <p className="text-xs text-muted-foreground">
                  Deve corresponder ao campo fundo_cnpjgestor dos XMLs importados.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nome">Nome da gestora</Label>
              <Input
                id="nome"
                placeholder="Ex: CVPAR Quadrante Investimentos"
                value={form.nome}
                onChange={(e) => setForm((f) => ({ ...f, nome: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Salvando…" : editing ? "Salvar" : "Cadastrar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={grupoDialog} onOpenChange={setGrupoDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Adicionar grupo ao mapa de fundos</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>CNPJ do gestor ou administrador</Label>
              <Input
                placeholder="00.000.000/0001-00"
                value={grupoForm.cnpj}
                onChange={(e) => setGrupoForm((f) => ({ ...f, cnpj: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Tipo</Label>
              <Select value={grupoForm.tipo} onValueChange={(v) => setGrupoForm((f) => ({ ...f, tipo: v as "gestor" | "admin" }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="gestor">Gestor (fundo_cnpjgestor)</SelectItem>
                  <SelectItem value="admin">Administrador (fundo_cnpjadm)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Grupo</Label>
              <Select value={grupoForm.grupo} onValueChange={(v) => setGrupoForm((f) => ({ ...f, grupo: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(["A", "B", "C", "H", "R"] as const).map((g) => (
                    <SelectItem key={g} value={g}>{g} — {GRUPO_LABEL[g]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGrupoDialog(false)} disabled={grupoSaving}>Cancelar</Button>
            <Button onClick={handleSaveGrupo} disabled={grupoSaving}>{grupoSaving ? "Salvando…" : "Salvar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
