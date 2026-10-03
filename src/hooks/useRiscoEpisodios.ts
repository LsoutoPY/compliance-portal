import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { RiscoModulo } from "@/types/relatorios-risco";
import type { RiscoEpisodio, RiscoEpisodioPlanoInput } from "@/types/risco-episodios";

type DbError = { message: string; details?: string | null; hint?: string | null; code?: string | null };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
interface Query<T = unknown> extends PromiseLike<DbResult<T>> {
  select(columns?: string): Query<T>;
  in(column: string, values: readonly unknown[]): Query<T>;
  order(column: string, options?: { ascending?: boolean }): Query<T>;
}
interface Db { from(table: string): Query; rpc(name: string, args?: Record<string, unknown>): PromiseLike<DbResult>; }
const db = supabase as unknown as Db;

function describeDbError(error: DbError): string {
  return [error.message, error.details, error.hint, error.code ? `Código: ${error.code}` : null]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" — ");
}

export const riscoEpisodiosKeys = {
  all: ["risco-episodios"] as const,
  list: (modulos?: RiscoModulo[]) => [...riscoEpisodiosKeys.all, "list", modulos?.join(",") ?? "todos"] as const,
};

export function useRiscoEpisodios(modulos?: RiscoModulo[]) {
  return useQuery({
    queryKey: riscoEpisodiosKeys.list(modulos),
    queryFn: async () => {
      let query = db.from("vw_risco_episodios_monitoramento").select("*").order("data_inicio", { ascending: false });
      if (modulos?.length) query = query.in("modulo", modulos);
      const { data, error } = await query;
      if (error) throw new Error(describeDbError(error));
      return (data ?? []) as RiscoEpisodio[];
    },
  });
}

export function useSincronizarEpisodiosRisco() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await db.rpc("processar_evidencias_risco", { p_limite: 1000 });
      if (error) throw new Error(describeDbError(error));
    },
    onSuccess: () => client.invalidateQueries({ queryKey: riscoEpisodiosKeys.all }),
  });
}

export function useSalvarPlanoEpisodioRisco() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: RiscoEpisodioPlanoInput) => {
      const { error } = await db.rpc("salvar_plano_acao_episodio_risco", {
        p_episodio_id: input.episodioId,
        p_conteudo: input.conteudo,
        p_responsavel_nome: input.responsavelNome?.trim() || null,
        p_responsavel_email: input.responsavelEmail?.trim() || null,
        p_prazo: input.prazo || null,
        p_origem: input.origem,
      });
      if (error) throw new Error(describeDbError(error));
    },
    onSuccess: () => client.invalidateQueries({ queryKey: riscoEpisodiosKeys.all }),
  });
}

export function useClassificarValidadeEpisodioRisco() {
  const client = useQueryClient();
  return useMutation({ mutationFn: async (input: { episodioId: string; validade: string; motivo: string | null }) => { const { error } = await db.rpc("classificar_validade_episodio_risco", { p_episodio_id: input.episodioId, p_validade: input.validade, p_motivo: input.motivo }); if (error) throw new Error(describeDbError(error)); }, onSuccess: () => client.invalidateQueries({ queryKey: riscoEpisodiosKeys.all }) });
}

export function useRegistrarNotificacaoManualEpisodioRisco() {
  const client = useQueryClient();
  return useMutation({ mutationFn: async (input: { episodioId: string; ocorridaEm: string; destinatarios: string[]; observacao: string }) => { const { error } = await db.rpc("registrar_notificacao_manual_episodio_risco", { p_episodio_id: input.episodioId, p_ocorrida_em: input.ocorridaEm, p_destinatarios: input.destinatarios, p_observacao: input.observacao || null }); if (error) throw new Error(describeDbError(error)); }, onSuccess: () => client.invalidateQueries({ queryKey: riscoEpisodiosKeys.all }) });
}
