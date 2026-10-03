import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type {
  RiscoComunicacao,
  RiscoModulo,
  RiscoOcorrenciaMensal,
  RiscoPlanoInput,
  RiscoRelatorioMensal,
  RiscoValidadeInput,
  RiscoWorkflowStatus,
} from "@/types/relatorios-risco";

type DynamicDbError = { message: string };
type DynamicDbResult<T = unknown> = { data: T | null; error: DynamicDbError | null };

interface DynamicQuery<T = unknown> extends PromiseLike<DynamicDbResult<T>> {
  select(columns?: string): DynamicQuery<T>;
  eq(column: string, value: unknown): DynamicQuery<T>;
  in(column: string, values: readonly unknown[]): DynamicQuery<T>;
  order(column: string, options?: { ascending?: boolean }): DynamicQuery<T>;
  maybeSingle(): PromiseLike<DynamicDbResult<T>>;
  update(values: Record<string, unknown>): DynamicQuery<T>;
  insert(values: Record<string, unknown>): DynamicQuery<T>;
}

interface DynamicDbClient {
  from(table: string): DynamicQuery;
  rpc(functionName: string, args?: Record<string, unknown>): PromiseLike<DynamicDbResult>;
}

const db = supabase as unknown as DynamicDbClient;

export const relatoriosRiscoKeys = {
  all: ["relatorios-risco"] as const,
  mes: (mes: string, modulos?: RiscoModulo[]) =>
    [...relatoriosRiscoKeys.all, "mes", mes, modulos?.slice().sort().join(",") ?? "todos"] as const,
  comunicacoes: (ocorrenciaId: string) =>
    [...relatoriosRiscoKeys.all, "comunicacoes", ocorrenciaId] as const,
};

function competenciaIso(mes: string): string {
  if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error("Competência inválida");
  return `${mes}-01`;
}

export function useRiscoOcorrenciasMes(mes: string, modulos?: RiscoModulo[]) {
  return useQuery({
    queryKey: relatoriosRiscoKeys.mes(mes, modulos),
    enabled: /^\d{4}-\d{2}$/.test(mes),
    queryFn: async () => {
      const competencia = competenciaIso(mes);
      let query = db
        .from("vw_risco_ocorrencias_mensais")
        .select("*")
        .eq("competencia", competencia)
        .order("nivel", { ascending: false })
        .order("data_primeira", { ascending: true })
        .order("fundo_nome", { ascending: true });

      if (modulos?.length) query = query.in("modulo", modulos);

      const [{ data, error }, reportResult] = await Promise.all([
        query,
        db
          .from("risco_relatorios_mensais")
          .select("*")
          .eq("competencia", competencia)
          .maybeSingle(),
      ]);

      if (error) throw new Error(error.message);
      if (reportResult.error) throw new Error(reportResult.error.message);

      return {
        ocorrencias: (data ?? []) as RiscoOcorrenciaMensal[],
        relatorio: (reportResult.data ?? null) as RiscoRelatorioMensal | null,
      };
    },
  });
}

export function useSincronizarOcorrenciasRisco() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (mes: string) => {
      const { error } = await db.rpc("sincronizar_relatorio_mensal_episodios", {
        p_competencia: competenciaIso(mes),
      });
      if (error) throw new Error(`Não foi possível sincronizar a competência: ${error.message}`);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: relatoriosRiscoKeys.all });
    },
  });
}

export function useRiscoComunicacoes(ocorrenciaId?: string) {
  return useQuery({
    queryKey: relatoriosRiscoKeys.comunicacoes(ocorrenciaId ?? "none"),
    enabled: !!ocorrenciaId,
    queryFn: async () => {
      const { data, error } = await db
        .from("risco_ocorrencia_comunicacoes")
        .select("*")
        .eq("ocorrencia_id", ocorrenciaId)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as RiscoComunicacao[];
    },
  });
}

export function useSalvarPlanoRisco() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RiscoPlanoInput) => {
      const { data, error } = await db.rpc("salvar_plano_acao_risco", {
        p_ocorrencia_id: input.ocorrenciaId,
        p_conteudo: input.conteudo,
        p_responsavel_nome: input.responsavelNome?.trim() || null,
        p_responsavel_email: input.responsavelEmail?.trim() || null,
        p_prazo: input.prazo || null,
        p_origem: input.origem ?? "manual",
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: async (_data, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: relatoriosRiscoKeys.all }),
        queryClient.invalidateQueries({ queryKey: relatoriosRiscoKeys.comunicacoes(input.ocorrenciaId) }),
      ]);
    },
  });
}

export function useAtualizarStatusOcorrencia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: RiscoWorkflowStatus }) => {
      const { error } = await db
        .from("risco_ocorrencias")
        .update({ status_workflow: status })
        .eq("id", id);
      if (error) throw new Error(error.message);

      const { error: timelineError } = await db.from("risco_ocorrencia_comunicacoes").insert({
        ocorrencia_id: id,
        tipo: "status_alterado",
        canal: "sistema",
        assunto: "Status da ocorrência atualizado",
        conteudo: status,
      });
      if (timelineError) throw new Error(timelineError.message);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: relatoriosRiscoKeys.all });
    },
  });
}

export function useClassificarValidadeOcorrencia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RiscoValidadeInput) => {
      const { data, error } = await db.rpc("classificar_validade_ocorrencia_risco", {
        p_ocorrencia_id: input.ocorrenciaId,
        p_validade: input.validade,
        p_motivo_classificacao: input.motivo,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: async (_data, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: relatoriosRiscoKeys.all }),
        queryClient.invalidateQueries({ queryKey: relatoriosRiscoKeys.comunicacoes(input.ocorrenciaId) }),
      ]);
    },
  });
}

export function useAtualizarRelatorioMensal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      mes,
      manifestacaoDiretor,
      ressalvas,
      status,
    }: {
      mes: string;
      manifestacaoDiretor: string;
      ressalvas: string;
      status: RiscoRelatorioMensal["status"];
    }) => {
      const { error } = await db
        .from("risco_relatorios_mensais")
        .update({
          manifestacao_diretor: manifestacaoDiretor.trim() || null,
          ressalvas: ressalvas.trim() || null,
          status,
        })
        .eq("competencia", competenciaIso(mes));
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: relatoriosRiscoKeys.all });
    },
  });
}
