import { supabase } from "@/integrations/supabase/client";

/** RPCs/tabelas de monitoramento ainda não estão em types.ts gerado */
type RpcError = { message?: string; code?: string; details?: string } | null;
const db = supabase as unknown as {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError }>;
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        maybeSingle: () => Promise<{ data: unknown; error: RpcError }>;
      };
    };
  };
};

export type MonitoramentoJobStatus = {
  id: string;
  status: "running" | "done" | "error";
  processados: number;
  total_pares: number;
  erros: number;
  detalhes?: { ultimo_lote?: LogEntry[] } | null;
};

export type LogEntry = {
  cnpj: string;
  data: string;
  ok_eq: boolean;
  ok_liq: boolean;
  erros: string[];
};

/** Mensagem legível para erros de RPC PostgREST */
export function rpcErrorMessage(error: { message?: string; code?: string; details?: string }): string {
  const msg = error.message ?? error.details ?? "";
  if (
    error.code === "PGRST202" ||
    msg.includes("Could not find the function") ||
    msg.includes("does not exist")
  ) {
    return "Função não encontrada no banco — aplique a migration 20260717_fix_pendentes_rpcs_security.sql e recarregue o schema.";
  }
  if (msg.includes("permission denied") || error.code === "42501") {
    return "Sem permissão para executar a RPC — aplique a migration 20260717 (GRANT EXECUTE).";
  }
  if (msg.includes("SET is not allowed in a non-volatile")) {
    return "Função SQL desatualizada — reaplique a migration 20260720_pendentes_not_exists.sql no Supabase.";
  }
  return msg || "Erro ao consultar pendentes.";
}

/** Conta pendentes por módulo. Em períodos grandes pode retornar indisponivel=true. */
export async function countParesPendentes(
  dataInicio: string,
  dataFim: string,
  modos: { enquadramento: boolean; liquidez: boolean },
): Promise<{ eq: number | null; liq: number | null; errors: string[]; indisponivel: boolean }> {
  const errors: string[] = [];
  let eq: number | null = null;
  let liq: number | null = null;
  let indisponivel = false;

  const isTimeout = (msg: string) =>
    msg.includes("statement timeout") || msg.includes("canceling statement");

  const tasks: Promise<void>[] = [];

  if (modos.enquadramento) {
    tasks.push(
      (async () => {
        const { data, error } = await db.rpc("count_pares_pendentes_enquadramento", {
          p_data_inicio: dataInicio,
          p_data_fim: dataFim,
        });
        if (error) {
          const msg = rpcErrorMessage(error);
          if (isTimeout(msg)) {
            indisponivel = true;
            errors.push("Enquadramento: contagem indisponível (período grande). Você pode processar mesmo assim.");
          } else {
            errors.push(`Enquadramento: ${msg}`);
          }
          return;
        }
        eq = Number(data ?? 0);
      })(),
    );
  }

  if (modos.liquidez) {
    tasks.push(
      (async () => {
        const { data, error } = await db.rpc("count_pares_pendentes_liquidez", {
          p_data_inicio: dataInicio,
          p_data_fim: dataFim,
        });
        if (error) {
          const msg = rpcErrorMessage(error);
          if (isTimeout(msg)) {
            indisponivel = true;
            errors.push("Liquidez: contagem indisponível (período grande). Você pode processar mesmo assim.");
          } else {
            errors.push(`Liquidez: ${msg}`);
          }
          return;
        }
        liq = Number(data ?? 0);
      })(),
    );
  }

  await Promise.all(tasks);

  return { eq, liq, errors, indisponivel };
}

/**
 * Conta pendentes somando por data (equality scan — cada chamada é rápida e
 * indexada, nunca varre o intervalo inteiro). Roda com concorrência limitada
 * para não disparar centenas de requisições simultâneas.
 */
export async function countParesPendentesPorData(
  datasPeriodo: string[],
  modos: { enquadramento: boolean; liquidez: boolean },
  concurrency = 6,
): Promise<{ eq: number; liq: number; errors: string[] }> {
  let eq = 0;
  let liq = 0;
  const errosSet = new Set<string>();
  let idx = 0;

  async function worker() {
    while (idx < datasPeriodo.length) {
      const i = idx++;
      const dt = datasPeriodo[i];

      if (modos.enquadramento) {
        const { data, error } = await db.rpc("get_pares_pendentes_enquadramento_data", { p_data: dt });
        if (error) errosSet.add(`Enquadramento: ${rpcErrorMessage(error)}`);
        else eq += (data as unknown[] | null)?.length ?? 0;
      }

      if (modos.liquidez) {
        const { data, error } = await db.rpc("get_pares_pendentes_liquidez_data", { p_data: dt });
        if (error) errosSet.add(`Liquidez: ${rpcErrorMessage(error)}`);
        else liq += (data as unknown[] | null)?.length ?? 0;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, datasPeriodo.length)) }, worker));

  return { eq, liq, errors: [...errosSet] };
}

/** Extrai mensagem legível de erro de Edge Function Supabase */
export async function extractBatchFunctionError(
  error: unknown,
  data?: { error?: string } | null,
): Promise<string> {
  if (data?.error) return data.error;
  if (!error) return "Erro desconhecido";
  const ctx = (error as { context?: Response }).context;
  if (ctx) {
    try {
      const body = await ctx.json();
      if (body?.error) return body.error;
      if (body?.message) return body.message;
    } catch {
      /* ignore */
    }
  }
  const msg = (error as Error).message ?? String(error);
  if (msg.includes("non-2xx")) {
    return "Edge Function indisponível ou não deployada. Rode: supabase functions deploy batch-monitoramento --no-verify-jwt";
  }
  return msg;
}

export async function fetchMonitoramentoJob(jobId: string): Promise<MonitoramentoJobStatus | null> {
  const { data, error } = await db
    .from("monitoramento_job_log")
    .select("id, status, processados, total_pares, erros, detalhes")
    .eq("id", jobId)
    .maybeSingle();

  if (error || !data) return null;
  return data as MonitoramentoJobStatus;
}

const POLL_INTERVAL_MS = 3000;

/** Dispara batch-monitoramento e faz polling do job até concluir */
export async function runBatchJobInBackground(opts: {
  body: Record<string, unknown>;
  expectedMin?: number;
  onProgress?: (job: MonitoramentoJobStatus) => void;
  signal?: { cancelled: boolean };
}): Promise<{ jobId: string; job: MonitoramentoJobStatus }> {
  const { body, expectedMin = 0, onProgress, signal } = opts;

  const { data, error } = await supabase.functions.invoke("batch-monitoramento", { body });

  if (error) {
    throw new Error(await extractBatchFunctionError(error, data as { error?: string } | null));
  }
  if (data?.error) throw new Error(data.error);

  const initialTotal = Number((data as { total?: number }).total ?? 0);
  if (expectedMin > 0 && initialTotal === 0) {
    throw new Error(
      "O servidor retornou 0 pares para processar. " +
        "Verifique migrations (20260717, 20260718) e deploy: supabase functions deploy batch-monitoramento --no-verify-jwt",
    );
  }

  const jobId = (data as { job_id?: string }).job_id;
  if (!jobId) throw new Error("Resposta sem job_id — verifique se a migration monitoramento_job_log foi aplicada.");

  let job = await fetchMonitoramentoJob(jobId);
  if (!job) throw new Error("Job não encontrado em monitoramento_job_log.");

  if (initialTotal > 0 && job.total_pares === 0) {
    job = { ...job, total_pares: initialTotal };
  }
  onProgress?.(job);

  while (!signal?.cancelled) {
    if (job.status === "done" || job.status === "error") break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (signal?.cancelled) break;
    const updated = await fetchMonitoramentoJob(jobId);
    if (updated) {
      job = updated;
      onProgress?.(job);
    }
  }

  return { jobId, job };
}

/**
 * Dispara batch-monitoramento (modo pendentes) em segundo plano e faz polling
 * do job até concluir, falhar ou ser cancelado.
 */
export async function runPendentesInBackground(opts: {
  dataInicio: string;
  dataFim: string;
  /** Datas com posição no intervalo (ex.: availableDates filtrado) — obrigatório.
   *  O servidor processa data a data (equality scan) para nunca varrer o intervalo inteiro. */
  datasPeriodo: string[];
  modos: string[];
  batchLimit?: number;
  /** Mínimo esperado (ex.: contagem da UI) — usado como total_hint (progresso) e para detectar job vazio */
  expectedMin?: number;
  onProgress?: (job: MonitoramentoJobStatus) => void;
  signal?: { cancelled: boolean };
}): Promise<{ jobId: string; job: MonitoramentoJobStatus }> {
  const { dataInicio, dataFim, datasPeriodo, modos, batchLimit = 5, expectedMin = 0, onProgress, signal } = opts;

  if (!datasPeriodo?.length) {
    throw new Error("Nenhuma data com posição encontrada no intervalo selecionado.");
  }

  return runBatchJobInBackground({
    body: {
      mode: "pendentes",
      modos,
      data_inicio: dataInicio,
      data_fim: dataFim,
      datas_periodo: datasPeriodo,
      total_hint: expectedMin,
      batch_offset: 0,
      batch_limit: batchLimit,
      auto_continue: true,
    },
    expectedMin,
    onProgress,
    signal,
  });
}

/**
 * Verificação de enquadramento por período — todos os pares com posição no intervalo.
 */
export async function runPeriodoEnquadramentoInBackground(opts: {
  dataInicio: string;
  dataFim: string;
  datasPeriodo: string[];
  fundosFiltro?: Array<{ fundo_cnpj: string; fundo_isin?: string }>;
  batchLimit?: number;
  expectedMin?: number;
  onProgress?: (job: MonitoramentoJobStatus) => void;
  signal?: { cancelled: boolean };
}): Promise<{ jobId: string; job: MonitoramentoJobStatus }> {
  const {
    dataInicio,
    dataFim,
    datasPeriodo,
    fundosFiltro,
    batchLimit = 5,
    expectedMin = 0,
    onProgress,
    signal,
  } = opts;

  const body: Record<string, unknown> = {
    mode: "periodo",
    modos: ["enquadramento"],
    data_inicio: dataInicio,
    data_fim: dataFim,
    datas_periodo: datasPeriodo,
    batch_offset: 0,
    batch_limit: batchLimit,
    auto_continue: true,
  };
  if (fundosFiltro?.length) {
    body.fundos_filtro = fundosFiltro;
  }

  return runBatchJobInBackground({ body, expectedMin, onProgress, signal });
}
