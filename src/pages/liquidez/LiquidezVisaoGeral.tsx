import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { useAuth } from "@/contexts/AuthContext";
import { Badge } from "@/design-system/components/core/Badge";
import { Button } from "@/design-system/components/core/Button";
import { Card } from "@/design-system/components/core/Card";
import { Input } from "@/design-system/components/forms/Input";
import { Select } from "@/design-system/components/forms/Select";
import { supabase } from "@/integrations/supabase/client";
import {
  methodologyStatusForFund,
  type LiquidityReviewEvent,
  type MethodologyAssignment,
  type MethodologyRun,
} from "@/lib/liquidityMethodologyStatus";
import "./liquidez-visao-geral.css";

type Fund = { id: string; short_name: string; cnpj_fundo_master: string | null };
type Metric = { value: number | null; status: string; source: string; note?: string };
type Run = MethodologyRun & {
  cnpj: string;
  input_sha256: string;
  source_manifest: {
    cvm?: Array<{ tabela: string; source_storage_path?: string | null; source_sha256?: string | null; source_origin?: string | null }>;
    position?: { id: string; reference_date: string; file_sha256: string } | null;
  } | null;
  result: { gaps?: string[]; metrics?: Record<string, Metric>; evidence?: { tables: string[]; positionDate: string | null } };
};

const statusLabels = {
  pendente_metodologia: "Metodologia pendente",
  pendente_calculo: "Cálculo pendente",
  aguardando_revisao: "Aguardando revisão",
  aprovado: "Aprovado",
} as const;
const statusTones = {
  pendente_metodologia: "attention",
  pendente_calculo: "warning",
  aguardando_revisao: "info",
  aprovado: "positive",
} as const;
const monthFormatter = new Intl.DateTimeFormat("pt-BR", { month: "short", year: "numeric", timeZone: "UTC" });
const numberFormatter = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 4 });

function initialMonth() {
  const now = new Date();
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}`;
}

function monthOptions(month: string) {
  const [year, value] = month.split("-").map(Number);
  return Array.from({ length: 13 }, (_, index) => {
    const date = new Date(Date.UTC(year, value - 1 - index, 1));
    const key = date.toISOString().slice(0, 7);
    return { value: key, label: monthFormatter.format(date) };
  });
}

function fmtDate(value: string | null | undefined) {
  if (!value) return "n/d";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("pt-BR");
}

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

export default function LiquidezVisaoGeral() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [latestMonth] = useState(initialMonth);
  const [month, setMonth] = useState(latestMonth);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [selectedFundId, setSelectedFundId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const referenceMonth = `${month}-01`;

  const overviewQuery = useQuery({
    queryKey: ["liquidity-methodology-overview", user?.id, referenceMonth], enabled: !!user,
    queryFn: async () => {
      const [fundResponse, assignmentResponse, runResponse] = await Promise.all([
        supabase.from("funds").select("id,short_name,cnpj_fundo_master").eq("active", true).order("short_name").limit(500),
        (supabase as any).from("liquidity_methodology_assignments").select("fund_id,methodology_code,methodology_version,valid_from,valid_to")
          .lte("valid_from", referenceMonth).or(`valid_to.is.null,valid_to.gte.${referenceMonth}`).limit(1000),
        (supabase as any).from("liquidity_monthly_runs").select("*").eq("reference_month", referenceMonth)
          .order("calculated_at", { ascending: false }).limit(1000),
      ]);
      if (fundResponse.error) throw fundResponse.error;
      if (assignmentResponse.error) throw assignmentResponse.error;
      if (runResponse.error) throw runResponse.error;
      const runs = (runResponse.data ?? []) as Run[];
      const runIds = runs.map((run) => run.id);
      const reviewResponse = runIds.length
        ? await (supabase as any).from("liquidity_monthly_review_events")
          .select("id,run_id,decision,created_at").in("run_id", runIds).limit(1000)
        : { data: [], error: null };
      if (reviewResponse.error) throw reviewResponse.error;
      return {
        funds: (fundResponse.data ?? []) as Fund[],
        assignments: (assignmentResponse.data ?? []) as MethodologyAssignment[],
        runs,
        reviews: (reviewResponse.data ?? []) as LiquidityReviewEvent[],
      };
    },
  });

  const historyQuery = useQuery({
    queryKey: ["liquidity-methodology-history", user?.id, selectedFundId], enabled: !!user && !!selectedFundId,
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("liquidity_monthly_runs").select("*")
        .eq("fund_id", selectedFundId).order("calculated_at", { ascending: false }).limit(36);
      if (error) throw error;
      return (data ?? []) as Run[];
    },
  });

  const rows = useMemo(() => (overviewQuery.data?.funds ?? []).map((fund) => ({
    fund,
    state: methodologyStatusForFund(
      fund.id, referenceMonth,
      overviewQuery.data?.assignments ?? [], overviewQuery.data?.runs ?? [], overviewQuery.data?.reviews ?? [],
    ),
  })), [overviewQuery.data, referenceMonth]);
  const filteredRows = rows.filter(({ fund, state }) => {
    const text = `${fund.short_name} ${fund.cnpj_fundo_master ?? ""}`.toLocaleLowerCase("pt-BR");
    return text.includes(search.toLocaleLowerCase("pt-BR")) && (statusFilter === "todos" || state.status === statusFilter);
  });
  const selectedRow = rows.find(({ fund }) => fund.id === selectedFundId) ?? null;
  const history = historyQuery.data ?? [];
  const historyReviewQuery = useQuery({
    queryKey: ["liquidity-methodology-review-history", user?.id, selectedFundId, history.map((run) => run.id).join(",")],
    enabled: !!user && history.length > 0,
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("liquidity_monthly_review_events")
        .select("id,run_id,decision,note,actor_id,created_at").in("run_id", history.map((run) => run.id))
        .order("created_at", { ascending: false }).limit(1000);
      if (error) throw error;
      return (data ?? []) as Array<LiquidityReviewEvent & { note: string; actor_id: string }>;
    },
  });
  const focusedRun = history.find((run) => run.id === selectedRunId) ??
    history.find((run) => run.id === selectedRow?.state.run?.id) ?? history[0] ?? null;
  const positionId = focusedRun?.source_manifest?.position?.id;
  const positionQuery = useQuery({
    queryKey: ["liquidity-methodology-position", user?.id, positionId], enabled: !!user && !!positionId,
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("liquidity_position_snapshots")
        .select("file_name,storage_path,file_sha256,reference_date").eq("id", positionId).maybeSingle();
      if (error) throw error;
      return data as { file_name: string; storage_path: string; file_sha256: string; reference_date: string } | null;
    },
  });

  async function downloadEvidence(bucket: string, path: string, filename: string) {
    setDownloadError("");
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60);
    if (error || !data?.signedUrl) { setDownloadError(error?.message ?? "Arquivo indisponível."); return; }
    const link = document.createElement("a");
    link.href = data.signedUrl;
    link.download = filename;
    link.rel = "noopener noreferrer";
    document.body.append(link);
    link.click();
    link.remove();
  }

  const counts = rows.reduce((acc, row) => { acc[row.state.status]++; return acc; }, {
    pendente_metodologia: 0, pendente_calculo: 0, aguardando_revisao: 0, aprovado: 0,
  });
  const cvmFiles = [...new Map((focusedRun?.source_manifest?.cvm ?? [])
    .filter((item) => item.source_storage_path)
    .map((item) => [item.source_storage_path!, item])).values()];

  return <Layout><div className="lmo-page">
    <div className="lmo-heading">
      <div><span className="lmo-eyebrow">Risco de liquidez · Metodologias</span><h1>Visão geral</h1>
        <p>Fundo × metodologia × situação da competência. Resultados calculados aguardam revisão explícita.</p></div>
      <Button variant="secondary" icon="refresh-cw" onClick={() => { void overviewQuery.refetch(); if (selectedFundId) void historyQuery.refetch(); }}>Atualizar visão</Button>
    </div>
    <div className="lmo-filters">
      <Select label="Competência" value={month} onChange={(event) => setMonth(event.target.value)} options={monthOptions(latestMonth)} />
      <Select label="Status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} options={[
        { value: "todos", label: "Todos" },
        ...Object.entries(statusLabels).map(([value, label]) => ({ value, label })),
      ]} />
      <Input label="Buscar fundo" value={search} onChange={(event) => setSearch(event.target.value)} icon="search" placeholder="Nome ou CNPJ" />
    </div>
    {overviewQuery.isLoading && <p role="status" className="lmo-notice">Consultando fundos e execuções…</p>}
    {overviewQuery.error && <p role="alert" className="lmo-notice">Falha ao carregar a visão geral: {errorText(overviewQuery.error)}</p>}
    {overviewQuery.data && <>
      <div className="lmo-kpis rcv-kpi-grid" aria-label="Resumo da competência">
        <Card><div className="kpi__label">Fundos ativos</div><div className="kpi__value">{rows.length}</div></Card>
        <Card><div className="kpi__label">Metodologia pendente</div><div className="kpi__value">{counts.pendente_metodologia}</div></Card>
        <Card><div className="kpi__label">Cálculo pendente</div><div className="kpi__value">{counts.pendente_calculo}</div></Card>
        <Card><div className="kpi__label">Aguardando revisão</div><div className="kpi__value">{counts.aguardando_revisao}</div></Card>
      </div>
      <Card title="Matriz de metodologias" subtitle={`${month} · ${filteredRows.length} fundo(s) exibido(s)`} padding={false}>
        {filteredRows.length ? <div className="lmo-table-wrap"><table className="rcv-table rcv-table--dense">
          <thead><tr><th>Fundo</th><th>Metodologia</th><th>Versão</th><th>Status</th><th>Pendências</th><th>Última execução</th><th>Detalhe</th></tr></thead>
          <tbody>{filteredRows.map(({ fund, state }) => <tr key={fund.id} className={selectedFundId === fund.id ? "is-open" : ""}>
            <td><strong>{fund.short_name}</strong><small className="lmo-secondary">{fund.cnpj_fundo_master ?? "CNPJ ausente"}</small></td>
            <td>{state.assignment?.methodology_code ?? "Não atribuída"}</td>
            <td className="num">{state.assignment?.methodology_version ?? "n/d"}</td>
            <td><Badge tone={statusTones[state.status]} dot>{statusLabels[state.status]}</Badge></td>
            <td className="num">{state.pending.length}</td>
            <td>{fmtDate(state.run?.calculated_at)}</td>
            <td><Button variant="ghost" size="sm" onClick={() => { setSelectedFundId(fund.id); setSelectedRunId(null); }}>Abrir fundo</Button></td>
          </tr>)}</tbody>
        </table></div> : <p className="lmo-empty">Nenhum fundo corresponde aos filtros.</p>}
      </Card>
      {selectedRow && <Card title={selectedRow.fund.short_name} subtitle={`${selectedRow.fund.cnpj_fundo_master ?? "CNPJ ausente"} · histórico e evidências`} actions={
        selectedRow.state.assignment?.methodology_code === "cvpar_fidc_mensal"
          ? <Button variant="secondary" size="sm" onClick={() => navigate("/liquidez/mensal")}>Abrir FIDC Mensal</Button>
          : undefined
      }>
        <div className="lmo-detail-meta">
          <div><span>Metodologia vigente</span><strong>{selectedRow.state.assignment ? `${selectedRow.state.assignment.methodology_code}@${selectedRow.state.assignment.methodology_version}` : "Não atribuída"}</strong></div>
          <div><span>Vigência</span><strong>{selectedRow.state.assignment ? `${selectedRow.state.assignment.valid_from} a ${selectedRow.state.assignment.valid_to ?? "atual"}` : "n/d"}</strong></div>
          <div><span>Status</span><Badge tone={statusTones[selectedRow.state.status]}>{statusLabels[selectedRow.state.status]}</Badge></div>
          <div><span>Pendências</span><strong>{selectedRow.state.pending.length}</strong></div>
        </div>
        {selectedRow.state.pending.length > 0 && <ul className="lmo-pending">{selectedRow.state.pending.map((gap, index) => <li key={`${index}-${gap}`}>{gap}</li>)}</ul>}
        <p className="lmo-review-note">A regra de quem aprova o fechamento será definida com Risco e Compliance. Esta tela não concede aprovação.</p>
        <h3>Histórico de competências</h3>
        {historyQuery.isLoading && <p role="status">Consultando histórico…</p>}
        {historyQuery.error && <p role="alert">Falha no histórico: {errorText(historyQuery.error)}</p>}
        {historyQuery.data && (history.length ? <div className="lmo-table-wrap"><table className="rcv-table rcv-table--dense"><thead><tr><th>Competência</th><th>Versão</th><th>Calculado em</th><th>Hash de entrada</th><th>Memória</th></tr></thead><tbody>
          {history.map((run) => <tr key={run.id} className={focusedRun?.id === run.id ? "is-open" : ""}><td>{run.reference_month.slice(0, 7)}</td><td>{run.methodology_code}@{run.methodology_version}</td><td>{fmtDate(run.calculated_at)}</td><td className="num">{run.input_sha256.slice(0, 12)}…</td><td><Button variant="ghost" size="sm" onClick={() => setSelectedRunId(run.id)}>Ver memória</Button></td></tr>)}
        </tbody></table></div> : <p className="lmo-empty">Nenhuma execução registrada para este fundo.</p>)}
        {focusedRun && <div className="lmo-evidence">
          <h3>Memória de cálculo · {focusedRun.reference_month.slice(0, 7)}</h3>
          <p>Versão {focusedRun.methodology_code}@{focusedRun.methodology_version} · execução {fmtDate(focusedRun.calculated_at)}</p>
          <div className="lmo-table-wrap"><table className="rcv-table rcv-table--dense"><thead><tr><th>Indicador</th><th>Valor bruto</th><th>Qualidade</th><th>Origem e ressalva</th></tr></thead><tbody>
            {Object.entries(focusedRun.result.metrics ?? {}).map(([key, metric]) => <tr key={key}><td>{key}</td><td className="num">{metric.value === null ? "n/d" : numberFormatter.format(metric.value)}</td><td>{metric.status}</td><td>{metric.source}{metric.note ? ` · ${metric.note}` : ""}</td></tr>)}
          </tbody></table></div>
          <h3>Evidências e anexos</h3>
          <p>Tabelas: {focusedRun.result.evidence?.tables.join(", ") || "n/d"}. Carteira Diária: {focusedRun.result.evidence?.positionDate ?? "ausente"}.</p>
          {cvmFiles.map((file) => <div className="lmo-attachment" key={file.source_storage_path}>
            <div><strong>{file.source_origin ?? file.source_storage_path}</strong><small>SHA-256: {file.source_sha256 ?? "não registrado"}</small></div>
            <Button variant="secondary" size="sm" onClick={() => void downloadEvidence("cvm-fidc-monthly-source", file.source_storage_path!, "informe-mensal.zip")}>Baixar ZIP</Button>
          </div>)}
          {positionQuery.data && <div className="lmo-attachment"><div><strong>{positionQuery.data.file_name}</strong><small>SHA-256: {positionQuery.data.file_sha256}</small></div><Button variant="secondary" size="sm" onClick={() => void downloadEvidence("liquidity-position-source", positionQuery.data!.storage_path, positionQuery.data!.file_name)}>Baixar carteira</Button></div>}
          {downloadError && <p role="alert">Falha ao baixar anexo: {downloadError}</p>}
          <h3>Auditoria da revisão</h3>
          {historyReviewQuery.isLoading && <p role="status">Consultando decisões…</p>}
          {historyReviewQuery.error && <p role="alert">Falha na auditoria: {errorText(historyReviewQuery.error)}</p>}
          {historyReviewQuery.data && (historyReviewQuery.data.filter((event) => event.run_id === focusedRun.id).length
            ? <ul className="lmo-review-history">{historyReviewQuery.data.filter((event) => event.run_id === focusedRun.id).map((event) => <li key={event.id}><strong>{event.decision}</strong> · {fmtDate(event.created_at)} · {event.actor_id}<small>{event.note}</small></li>)}</ul>
            : <p>Nenhuma decisão registrada para esta execução.</p>)}
        </div>}
      </Card>}
    </>}
  </div></Layout>;
}
