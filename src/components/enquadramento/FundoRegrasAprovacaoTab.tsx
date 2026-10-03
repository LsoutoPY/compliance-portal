import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import {
  fundoRegrasDisplayLabel,
  labelStatusAprovacaoFundoRegra,
  normalizeCnpj14,
} from "@/lib/fundoRegrasUtils";

type PendenteRow = {
  id: string;
  fundo_cnpj: string;
  fundo_isin: string;
  regra_id: string;
  dt_inicio_vigencia: string | null;
  dt_fim_vigencia: string | null;
  import_id: string | null;
  created_at: string;
  fundo_nome?: string | null;
  regras_compliance?: { codigo?: string; descricao?: string | null } | null;
};

function formatCnpj(cnpj: string) {
  if (cnpj.length !== 14) return cnpj;
  return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso + "T12:00:00").toLocaleDateString("pt-BR");
  } catch {
    return iso;
  }
}

export function FundoRegrasAprovacaoTab() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: pendentes = [], isLoading } = useQuery({
    queryKey: ["fundo-regras-pendentes"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fundo_regras")
        .select(`
          id,
          fundo_cnpj,
          fundo_isin,
          regra_id,
          dt_inicio_vigencia,
          dt_fim_vigencia,
          import_id,
          created_at,
          status_aprovacao,
          regras_compliance (codigo, descricao)
        `)
        .eq("status_aprovacao", "pendente")
        .order("created_at", { ascending: false });
      if (error) throw error;
      if (!data?.length) return [] as PendenteRow[];

      const cnpjs = [...new Set(data.map((a) => a.fundo_cnpj))];
      const { data: posRows } = await supabase
        .from("posicao_carteira")
        .select("fundo_cnpj, fundo_isin, fundo_nome, nome_fundo")
        .in("fundo_cnpj", cnpjs)
        .order("fundo_dtposicao", { ascending: false })
        .limit(5000);

      const nameMap = new Map<string, string>();
      for (const row of posRows ?? []) {
        const cnpj = normalizeCnpj14(row.fundo_cnpj);
        const isin = row.fundo_isin ?? "";
        const nome = String(row.nome_fundo ?? row.fundo_nome ?? "").trim();
        if (nome) nameMap.set(`${cnpj}|${isin}`, nome);
      }

      return data.map((a) => ({
        ...a,
        fundo_isin: a.fundo_isin ?? "",
        fundo_nome:
          nameMap.get(`${normalizeCnpj14(a.fundo_cnpj)}|${a.fundo_isin ?? ""}`) ??
          nameMap.get(`${normalizeCnpj14(a.fundo_cnpj)}|`) ??
          null,
      })) as PendenteRow[];
    },
  });

  const allSelected = pendentes.length > 0 && selected.size === pendentes.length;

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(pendentes.map((p) => p.id)) : new Set());
  };

  const toggleOne = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const aprovarMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      const now = new Date().toISOString();
      const { error } = await supabase
        .from("fundo_regras")
        .update({
          status_aprovacao: "ativo",
          ativo: true,
          aprovado_por: userId,
          aprovado_em: now,
        })
        .in("id", ids)
        .eq("status_aprovacao", "pendente");
      if (error) throw error;
    },
    onSuccess: (_, ids) => {
      toast.success(`${ids.length} vínculo(s) autorizado(s) — passam a valer no enquadramento.`);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["fundo-regras"] });
      queryClient.invalidateQueries({ queryKey: ["fundo-regras-pendentes"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-regras"] });
      queryClient.invalidateQueries({ queryKey: ["enquadramento-rules"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejeitarMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      const now = new Date().toISOString();
      const { error } = await supabase
        .from("fundo_regras")
        .update({
          status_aprovacao: "rejeitado",
          ativo: false,
          rejeitado_por: userId,
          rejeitado_em: now,
        })
        .in("id", ids)
        .eq("status_aprovacao", "pendente");
      if (error) throw error;
    },
    onSuccess: (_, ids) => {
      toast.success(`${ids.length} vínculo(s) rejeitado(s).`);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["fundo-regras"] });
      queryClient.invalidateQueries({ queryKey: ["fundo-regras-pendentes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const selectedIds = useMemo(() => [...selected], [selected]);
  const isMutating = aprovarMutation.isPending || rejeitarMutation.isPending;

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (pendentes.length === 0) {
    return (
      <div className="text-center py-12 border border-dashed rounded-lg">
        <ShieldCheck className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-30" />
        <p className="text-sm text-muted-foreground">Nenhum vínculo aguardando autorização.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border border-amber-200 bg-amber-50/50 dark:bg-amber-950/20">
        <div>
          <p className="text-sm font-semibold">{pendentes.length} vínculo(s) pendente(s)</p>
          <p className="text-xs text-muted-foreground">
            Importações em lote só entram no enquadramento após autorização.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 text-xs text-red-600 border-red-200 hover:bg-red-50"
            disabled={selectedIds.length === 0 || isMutating}
            onClick={() => rejeitarMutation.mutate(selectedIds.length ? selectedIds : pendentes.map((p) => p.id))}
          >
            {rejeitarMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )}
            Rejeitar {selectedIds.length > 0 ? `(${selectedIds.length})` : "todos"}
          </Button>
          <Button
            size="sm"
            className="gap-1.5 text-xs bg-[#003D27] hover:bg-[#197357]"
            disabled={selectedIds.length === 0 || isMutating}
            onClick={() => aprovarMutation.mutate(selectedIds.length ? selectedIds : pendentes.map((p) => p.id))}
          >
            {aprovarMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            Autorizar {selectedIds.length > 0 ? `(${selectedIds.length})` : "todos"}
          </Button>
        </div>
      </div>

      <div className="rounded-md border overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-10">
                <Checkbox checked={allSelected} onCheckedChange={(c) => toggleAll(c === true)} />
              </TableHead>
              <TableHead className="text-[10px] font-bold uppercase">Fundo</TableHead>
              <TableHead className="text-[10px] font-bold uppercase">Regra</TableHead>
              <TableHead className="text-[10px] font-bold uppercase">Vigência</TableHead>
              <TableHead className="text-[10px] font-bold uppercase">Status</TableHead>
              <TableHead className="text-[10px] font-bold uppercase w-[120px] text-center">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pendentes.map((row) => {
              const regra = row.regras_compliance;
              const nome =
                row.fundo_nome ?? formatCnpj(normalizeCnpj14(row.fundo_cnpj));
              return (
                <TableRow key={row.id} className="hover:bg-muted/20">
                  <TableCell>
                    <Checkbox
                      checked={selected.has(row.id)}
                      onCheckedChange={(c) => toggleOne(row.id, c === true)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-sm">
                      {fundoRegrasDisplayLabel(nome, row.fundo_isin)}
                    </div>
                    <div className="text-[10px] font-mono text-muted-foreground">
                      {formatCnpj(normalizeCnpj14(row.fundo_cnpj))}
                      {row.fundo_isin ? ` · ${row.fundo_isin}` : " · todas subclasses"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] font-mono mb-1">
                      {regra?.codigo ?? "?"}
                    </Badge>
                    <p className="text-xs text-muted-foreground">{regra?.descricao}</p>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {fmtDate(row.dt_inicio_vigencia)} → {fmtDate(row.dt_fim_vigencia)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-[10px]">
                      {labelStatusAprovacaoFundoRegra("pendente")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-emerald-600"
                        title="Autorizar"
                        disabled={isMutating}
                        onClick={() => aprovarMutation.mutate([row.id])}
                      >
                        <CheckCircle2 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-500"
                        title="Rejeitar"
                        disabled={isMutating}
                        onClick={() => rejeitarMutation.mutate([row.id])}
                      >
                        <XCircle className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
