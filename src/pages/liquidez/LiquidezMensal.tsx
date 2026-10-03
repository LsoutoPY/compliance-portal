import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useCanWrite } from "@/contexts/PermissionsContext";
import "./liquidez-mensal.css";

type Metric = { value: number | null; status: "apurado" | "aproximado" | "indisponivel"; source: string; note?: string };
type MonthlyResult = {
  methodology: string;
  referenceMonth: string;
  cnpj: string;
  metrics: Record<string, Metric>;
  maturityCvm: Array<{ label: string; value: number | null }>;
  overdueCvm?: Array<{ label: string; value: number | null }>;
  gaps: string[];
  evidence: { tables: string[]; positionDate: string | null };
};
type MonthlyRun = { id: string; cnpj: string; calculated_at: string; result: MonthlyResult; input_sha256: string };
type FundOption = { id: string; short_name: string; cnpj_fundo_master: string | null };
type MethodOption = { code: string; version: string; label: string };

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 2 });
const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
type Unit = "money" | "percent" | "days" | "number";
const consolidatedRows = [
  { key: "pl", label: "Patrimônio líquido", unit: "money" },
  { key: "creditGross", label: "Direitos creditórios brutos", unit: "money" },
  { key: "creditPerforming", label: "DC a vencer · estimativa", unit: "money" },
  { key: "pdd", label: "PDD", unit: "money" },
  { key: "overdue", label: "Vencidos · CVM", unit: "money" },
  { key: "publicBonds", label: "Títulos públicos + compromissadas", unit: "money" },
  { key: "fundUnits", label: "Cotas de fundos", unit: "money" },
  { key: "cash", label: "Tesouraria", unit: "money" },
  { key: "inflow", label: "Captações do mês", unit: "money" },
  { key: "redemptions", label: "Resgates do mês · CVM", unit: "money" },
  { key: "netFlows", label: "Captações líquidas · CVM", unit: "money" },
  { key: "subordination", label: "Subordinação apurada", unit: "percent" },
  { key: "subordinationMinimum", label: "Mínimo cadastrado", unit: "percent" },
  { key: "subordinationHeadroom", label: "Folga indicativa", unit: "percent" },
  { key: "cprCvm", label: "CPR residual · CVM", unit: "money" },
  { key: "acquisitions", label: "Aquisições · CVM", unit: "money" },
  { key: "debtorTop1", label: "Maior sacado / PL", unit: "percent" },
] as const;
const reportCoverage: Array<{ rows: string; label: string; metric?: string; unit?: Unit; needed?: string; statusOverride?: Metric["status"] }> = [
  { rows: "5", label: "Taxa de administração", metric: "administrationExpense", needed: "Carteira diária CPR" },
  { rows: "6", label: "Taxa de custódia", metric: "custodyExpense", needed: "Carteira diária CPR" },
  { rows: "7", label: "Taxa de gestão", metric: "managementExpense", needed: "Carteira diária CPR" },
  { rows: "8–9", label: "Encargos e amortização/IOF", needed: "Demonstrativo de despesas e fluxo efetivo do mês" },
  { rows: "10", label: "Outras despesas CPR", metric: "otherNegativeExpenses", needed: "Carteira diária CPR" },
  { rows: "13", label: "Saídas (resgates + amortizações)", metric: "redemptions", needed: "Lâmina de movimentações para completar saídas" },
  { rows: "14", label: "Entradas", metric: "inflow", needed: "Lâmina de movimentações para conferir entradas" },
  { rows: "15", label: "Captações líquidas", metric: "netFlows", needed: "Lâmina de movimentações para fechar fluxo líquido" },
  { rows: "18", label: "Patrimônio líquido", metric: "pl" },
  { rows: "19, 25", label: "Direitos creditórios brutos", metric: "creditGross" },
  { rows: "20, 44", label: "Direitos creditórios vencidos", metric: "overdue", needed: "Estoque para conciliar bases distintas do relatório" },
  { rows: "21", label: "Direitos creditórios a vencer", metric: "creditPerforming", needed: "Estoque para validar a base de vencidos" },
  { rows: "22", label: "Títulos públicos / compromissadas", metric: "publicBonds" },
  { rows: "23", label: "CPR residual · Informe CVM", metric: "cprCvm", needed: "Carteira diária para abrir despesas por natureza" },
  { rows: "24", label: "PDD", metric: "pdd" },
  { rows: "26", label: "Ativos de liquidez / RF", metric: "fundUnits", needed: "Conferir classificação da carteira para outras gestoras", statusOverride: "aproximado" },
  { rows: "27", label: "Tesouraria", metric: "cash" },
  { rows: "29", label: "DC / PL", metric: "creditToPl", unit: "percent" },
  { rows: "30", label: "PDD / PL", metric: "pddToPl", unit: "percent" },
  { rows: "31", label: "DC líquido de PDD / PL · fórmula corrigida", metric: "creditNetPddToPl", unit: "percent", needed: "A planilha de julho usa DC bruto nesta linha" },
  { rows: "32", label: "Ativos de liquidez / PL", metric: "fundUnitsToPl", unit: "percent" },
  { rows: "33", label: "Tesouraria / PL", metric: "cashToPl", unit: "percent" },
  { rows: "34", label: "Prazo médio estimado · dias corridos", metric: "averageMaturityCalendarDays", unit: "days", needed: "Estoque por título para apuração exata" },
  { rows: "35", label: "Prazo médio estimado · dias úteis", metric: "averageMaturityBusinessDays", unit: "days", needed: "Calendário de feriados e estoque para apuração exata" },
  { rows: "36", label: "Aquisições com e sem risco", metric: "acquisitions" },
  { rows: "37–38", label: "Taxa média de cessão · a.a. e a.m.", metric: "cessionRateAnnual", unit: "percent", needed: "Extrato título a título para taxa exata" },
  { rows: "42", label: "PDD / DC", metric: "pddToCredit", unit: "percent" },
  { rows: "43", label: "PDD / PL", metric: "pddToPl", unit: "percent" },
  { rows: "45", label: "Vencidos / DC", metric: "overdueToCredit", unit: "percent" },
  { rows: "46", label: "Vencidos / PL", metric: "overdueToPl", unit: "percent" },
  { rows: "47–63", label: "Faixas de vencidos", needed: "CVM permite as faixas ≥ 30 dias; estoque para separar até 5 e 6–30 dias" },
  { rows: "66–76", label: "Faixas de vencimento CVM", metric: "due30", needed: "Estoque e calendário para previsão de caixa efetiva" },
  { rows: "79", label: "Maior cedente listado · % declarado", metric: "cedentListedTop1", unit: "percent", needed: "Informe lista no máximo 9 por grupo" },
  { rows: "80–82", label: "Top 5/10/15 cedentes", needed: "Estoque completo por cedente" },
  { rows: "84", label: "Maior sacado / PL", metric: "debtorTop1", unit: "percent", needed: "Confirmar agregação por documento no estoque" },
  { rows: "85", label: "Top 5 sacados / PL", metric: "debtorTop5", unit: "percent" },
  { rows: "86", label: "Top 10 sacados / PL", metric: "debtorTop10", unit: "percent" },
  { rows: "87", label: "Top 15 sacados / PL", metric: "debtorTop15", unit: "percent" },
  { rows: "93", label: "Baixa por depósito do cedente", needed: "Extrato de títulos liquidados por tipo de evento" },
  { rows: "94", label: "Recompra agregada CVM", metric: "repurchaseCvm", needed: "Extrato de títulos liquidados para reconciliar" },
  { rows: "95–98", label: "Índice de recompra sobre liquidados", needed: "Extrato de títulos liquidados e denominador" },
  { rows: "101", label: "Subordinação apurada", metric: "subordination", unit: "percent" },
  { rows: "102", label: "Subordinação mínima cadastrada", metric: "subordinationMinimum", unit: "percent", needed: "Regulamento vigente por fundo e classe" },
];

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

function formatMetric(metric: Metric | undefined, unit: Unit = "money") {
  if (!metric || metric.value === null) return "—";
  if (unit === "percent") return percent.format(metric.value);
  if (unit === "days") return `${number.format(metric.value)} dias`;
  if (unit === "number") return number.format(metric.value);
  return currency.format(metric.value);
}

function MetricCard({ label, metric, unit = "money" }: { label: string; metric?: Metric; unit?: Unit }) {
  return (
    <article className="monthly-metric">
      <div className="monthly-metric__top"><span>{label}</span><span className={`monthly-state monthly-state--${metric?.status ?? "indisponivel"}`}>{metric?.status ?? "indisponível"}</span></div>
      <strong>{formatMetric(metric, unit)}</strong>
      <small>{metric?.source ?? "Fonte ausente"}</small>
      {metric?.note ? <p>{metric.note}</p> : null}
    </article>
  );
}

export default function LiquidezMensal() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, signIn } = useAuth();
  const permissionAllowsWrite = useCanWrite();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [methodKey, setMethodKey] = useState("cvpar_fidc_mensal@2026.2");
  const [monthTouched, setMonthTouched] = useState(false);
  const [showPrevious, setShowPrevious] = useState(false);
  const [month, setMonth] = useState(() => {
    const date = new Date();
    date.setMonth(date.getMonth() - 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  });
  const [busy, setBusy] = useState<"calculate" | "calculate-all" | "upload" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const profileQuery = useQuery({
    queryKey: ["monthly-liquidity-role", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<"risco" | "compliance" | null> => {
      const { data, error } = await supabase.from("profiles").select("role").eq("id", user!.id).maybeSingle();
      if (error) throw error;
      return data?.role ?? null;
    },
  });
  const canWrite = !!user && permissionAllowsWrite && profileQuery.isSuccess && profileQuery.data !== "compliance";
  const fundsQuery = useQuery({
    queryKey: ["monthly-liquidity-funds", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.from("funds").select("id,short_name,cnpj_fundo_master")
        .eq("active", true).order("short_name");
      if (error) throw error;
      return (data ?? []) as FundOption[];
    },
  });
  const methodsQuery = useQuery({
    queryKey: ["monthly-liquidity-methodologies", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<MethodOption[]> => {
      const { data, error } = await (supabase as any).from("liquidity_monthly_methodologies")
        .select("code,version,label").eq("active", true).order("label");
      if (error) throw error;
      return data as MethodOption[];
    },
  });
  const latestMonthQuery = useQuery({
    queryKey: ["monthly-liquidity-latest-source-month", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase.from("fund_monthly_cvm_filing")
        .select("competencia").order("competencia", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data?.competencia?.slice(0, 7) ?? null;
    },
  });
  const [methodologyCode, methodologyVersion] = methodKey.split("@");
  const previousMonth = useMemo(() => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
    const [year, monthNumber] = month.split("-").map(Number);
    const date = new Date(Date.UTC(year, monthNumber - 2, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }, [month]);
  const monitoredFunds = useMemo(() => (fundsQuery.data ?? []).filter((fund) => fund.cnpj_fundo_master), [fundsQuery.data]);
  useEffect(() => {
    if (!monthTouched && latestMonthQuery.data) setMonth(latestMonthQuery.data);
  }, [latestMonthQuery.data, monthTouched]);
  useEffect(() => {
    if (!cnpj && fundsQuery.data?.length) setCnpj(fundsQuery.data.find((fund) => fund.cnpj_fundo_master)?.cnpj_fundo_master ?? "");
  }, [cnpj, fundsQuery.data]);
  const runQuery = useQuery({
    queryKey: ["monthly-liquidity-run", user?.id, cnpj, month, methodKey],
    enabled: !!user && !!cnpj && /^\d{4}-\d{2}$/.test(month),
    queryFn: async (): Promise<MonthlyRun | null> => {
      const { data, error } = await (supabase as any).from("liquidity_monthly_runs")
        .select("id,calculated_at,result,input_sha256")
        .eq("cnpj", cnpj)
        .eq("reference_month", `${month}-01`)
        .eq("methodology_code", methodologyCode)
        .eq("methodology_version", methodologyVersion)
        .order("calculated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as MonthlyRun | null;
    },
  });
  const consolidatedQuery = useQuery({
    queryKey: ["monthly-liquidity-consolidated", user?.id, month, methodKey],
    enabled: !!user && monitoredFunds.length > 0 && /^\d{4}-\d{2}$/.test(month),
    queryFn: async (): Promise<Record<string, MonthlyRun>> => {
      const { data, error } = await (supabase as any).from("liquidity_monthly_runs")
        .select("id,cnpj,calculated_at,result,input_sha256")
        .in("cnpj", monitoredFunds.map((fund) => fund.cnpj_fundo_master))
        .eq("reference_month", `${month}-01`)
        .eq("methodology_code", methodologyCode)
        .eq("methodology_version", methodologyVersion)
        .order("calculated_at", { ascending: false });
      if (error) throw error;
      const latest: Record<string, MonthlyRun> = {};
      for (const run of (data ?? []) as MonthlyRun[]) latest[run.cnpj] ??= run;
      return latest;
    },
  });
  const result = runQuery.data?.result;
  const metrics = result?.metrics;
  const previousRunQuery = useQuery({
    queryKey: ["monthly-liquidity-previous", user?.id, cnpj, previousMonth, methodKey],
    enabled: showPrevious && !!user && !!cnpj && !!previousMonth,
    queryFn: async (): Promise<MonthlyRun | null> => {
      const { data, error } = await (supabase as any).from("liquidity_monthly_runs")
        .select("id,calculated_at,result,input_sha256")
        .eq("cnpj", cnpj).eq("reference_month", `${previousMonth}-01`)
        .eq("methodology_code", methodologyCode).eq("methodology_version", methodologyVersion)
        .order("calculated_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data as MonthlyRun | null;
    },
  });
  const maturityMax = useMemo(() => Math.max(0, ...(result?.maturityCvm.map((item) => item.value ?? 0) ?? [])), [result]);

  async function calculate() {
    if (!cnpj || !/^\d{4}-\d{2}$/.test(month)) return;
    setBusy("calculate");
    setMessage(null);
    try {
      const { error } = await supabase.functions.invoke("calculate-liquidity-monthly", {
        body: { cnpj, competencia: month, methodology_code: methodologyCode, methodology_version: methodologyVersion },
      });
      if (error) throw error;
      await queryClient.invalidateQueries({ queryKey: ["monthly-liquidity-run", user?.id, cnpj, month, methodKey] });
      await queryClient.invalidateQueries({ queryKey: ["monthly-liquidity-consolidated", user?.id, month, methodKey] });
      setMessage("Cálculo concluído com fontes e versão registradas.");
    } catch (error) {
      setMessage(`Falha no cálculo: ${errorMessage(error)}`);
    } finally { setBusy(null); }
  }

  async function calculateAll() {
    if (!monitoredFunds.length || !/^\d{4}-\d{2}$/.test(month)) return;
    setBusy("calculate-all");
    setMessage(null);
    const failures: string[] = [];
    let completed = 0;
    try {
      for (const fund of monitoredFunds) {
        const { error } = await supabase.functions.invoke("calculate-liquidity-monthly", {
          body: { cnpj: fund.cnpj_fundo_master, competencia: month, methodology_code: methodologyCode, methodology_version: methodologyVersion },
        });
        if (error) failures.push(`${fund.short_name}: ${errorMessage(error)}`);
        else completed++;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["monthly-liquidity-consolidated", user?.id, month, methodKey] }),
        queryClient.invalidateQueries({ queryKey: ["monthly-liquidity-run", user?.id] }),
      ]);
      setMessage(`${completed} de ${monitoredFunds.length} fundos calculados.${failures.length ? ` Falhas: ${failures.join("; ")}` : ""}`);
    } catch (error) {
      setMessage(`Cálculo interrompido após ${completed} fundo(s): ${errorMessage(error)}`);
    } finally { setBusy(null); }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy("upload");
    setMessage(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const { data, error } = await supabase.functions.invoke<{ snapshot?: { cnpj: string; reference_date: string } }>("import-liquidity-position", { body });
      if (error) throw error;
      if (data?.snapshot?.cnpj) setCnpj(data.snapshot.cnpj);
      if (data?.snapshot?.reference_date) { setMonthTouched(true); setMonth(data.snapshot.reference_date.slice(0, 7)); }
      setMessage("Carteira diária importada. Recalcule a competência para incorporar as despesas CPR.");
    } catch (error) {
      setMessage(`Falha na importação: ${errorMessage(error)}`);
    } finally { setBusy(null); }
  }

  return (
    <Layout>
      <div className="monthly-page">
        <section className="monthly-intro">
          <div>
            <p className="monthly-eyebrow">FIDC · Validação da metodologia</p>
            <h1>Liquidez mensal com memória de origem</h1>
            <p>Indicadores calculados das tabelas do informe CVM e, quando disponível, da Carteira Diária. Valores aproximados permanecem identificados até homologação.</p>
          </div>
          <div className="monthly-intro__badge">Prévia técnica<br /><strong>Sem fechamento oficial</strong></div>
        </section>

        <section className="monthly-controls" aria-label="Selecionar base do relatório">
          <label>Fundo ou classe
            <select value={cnpj} onChange={(event) => setCnpj(event.target.value)}>
              {(fundsQuery.data ?? []).filter((fund) => fund.cnpj_fundo_master).map((fund) => <option key={fund.id} value={fund.cnpj_fundo_master ?? ""}>{fund.short_name}</option>)}
            </select>
          </label>
          <label>Competência
            <input type="month" value={month} onChange={(event) => { setMonthTouched(true); setMonth(event.target.value); }} />
          </label>
          <label className="monthly-compare-toggle"><input type="checkbox" checked={showPrevious} onChange={(event) => setShowPrevious(event.target.checked)} /> Comparar com mês anterior</label>
          <label>Metodologia
            <select value={methodKey} onChange={(event) => setMethodKey(event.target.value)}>
              {(methodsQuery.data ?? [{ code: "cvpar_fidc_mensal", version: "2026.2", label: "CVPAR FIDC mensal · 2026.2" }]).map((method) => <option key={`${method.code}@${method.version}`} value={`${method.code}@${method.version}`}>{method.label}</option>)}
            </select>
          </label>
          <button type="button" className="monthly-button monthly-button--secondary" onClick={() => navigate("/dados/importar", { state: { tab: "cvm", competencia: month } })}>Atualizar informe CVM</button>
          {canWrite ? <label className="monthly-button monthly-button--secondary monthly-upload">Importar Carteira Diária
            <input type="file" accept=".csv,text/csv" disabled={busy !== null} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
          </label> : null}
          {canWrite ? <button type="button" className="monthly-button monthly-button--primary" disabled={busy !== null || !cnpj} onClick={() => void calculate()}>{busy === "calculate" ? "Calculando…" : "Calcular competência"}</button> : null}
          {canWrite ? <button type="button" className="monthly-button monthly-button--primary" disabled={busy !== null || !monitoredFunds.length} onClick={() => void calculateAll()}>{busy === "calculate-all" ? "Calculando fundos…" : "Calcular fundos"}</button> : null}
        </section>
        {message ? <p className="monthly-message" role="status">{message}</p> : null}
        {fundsQuery.error ? <p className="monthly-message monthly-message--error">Não foi possível carregar os fundos: {errorMessage(fundsQuery.error)}</p> : null}
        {methodsQuery.error ? <p className="monthly-message monthly-message--error">Não foi possível carregar as metodologias: {errorMessage(methodsQuery.error)}</p> : null}
        {latestMonthQuery.error ? <p className="monthly-message monthly-message--error">Não foi possível consultar a última competência CVM: {errorMessage(latestMonthQuery.error)}</p> : null}
        {runQuery.error ? <p className="monthly-message monthly-message--error">Não foi possível consultar o cálculo: {errorMessage(runQuery.error)}</p> : null}
        {consolidatedQuery.error ? <p className="monthly-message monthly-message--error">Não foi possível consultar o consolidado: {errorMessage(consolidatedQuery.error)}</p> : null}
        {!user ? <form className="monthly-login" onSubmit={async (event) => { event.preventDefault(); const outcome = await signIn(email, password); setMessage(outcome.error ?? "Sessão iniciada."); setPassword(""); }}>
          <div><strong>Entrar para importar e calcular</strong><p>Use uma conta com perfil de Risco. A consulta aos resultados também requer sessão.</p></div>
          <input aria-label="E-mail" type="email" autoComplete="username" placeholder="E-mail" value={email} onChange={(event) => setEmail(event.target.value)} required />
          <input aria-label="Senha" type="password" autoComplete="current-password" placeholder="Senha" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <button type="submit" className="monthly-button monthly-button--primary">Entrar</button>
        </form> : null}

        {runQuery.isLoading ? <p className="monthly-empty">Consultando cálculo salvo…</p> : null}
        {monitoredFunds.length > 0 ? <section className="monthly-section" aria-labelledby="monthly-consolidated-title">
          <div className="monthly-section__heading"><h2 id="monthly-consolidated-title">Fundos monitorados · competência {month}</h2><p>Último cálculo salvo de cada fundo. “—” indica execução ou campo indisponível; o status de cada valor aparece abaixo dele.</p></div>
          <div className="monthly-table-wrap"><table className="monthly-consolidated"><thead><tr><th scope="col">Indicador</th>{monitoredFunds.map((fund) => <th scope="col" key={fund.id}>{fund.short_name}</th>)}</tr></thead><tbody>
            {consolidatedRows.map((row) => <tr key={row.key}><th scope="row">{row.label}</th>{monitoredFunds.map((fund) => {
              const metric = consolidatedQuery.data?.[fund.cnpj_fundo_master!]?.result.metrics[row.key];
              return <td key={fund.id}><strong>{formatMetric(metric, row.unit)}</strong><small>{metric?.status ?? "sem cálculo"}</small></td>;
            })}</tr>)}
          </tbody></table></div>
        </section> : null}
        {!runQuery.isLoading && !runQuery.error && !result ? <section className="monthly-empty"><h2>Nenhum cálculo para esta competência</h2><p>Atualize o informe mensal CVM e calcule a competência. O relatório Excel de Compliance é usado somente na conferência externa.</p></section> : null}
        {result ? <>
          <div className="monthly-runline"><span>Competência {month} · {result.methodology}</span><span>Calculado em {new Date(runQuery.data!.calculated_at).toLocaleString("pt-BR")}</span></div>
          {showPrevious ? <section className="monthly-section" aria-labelledby="monthly-compare-title">
            <div className="monthly-section__heading"><h2 id="monthly-compare-title">Variação mensal · {previousMonth} → {month}</h2><p>Comparação entre execuções da mesma metodologia. Valores ausentes continuam sem variação.</p></div>
            {previousRunQuery.error ? <p>Falha ao consultar mês anterior: {errorMessage(previousRunQuery.error)}</p> : previousRunQuery.isLoading ? <p>Consultando mês anterior…</p> : !previousRunQuery.data ? <p>Calcule também {previousMonth} para habilitar a comparação.</p> :
              <div className="monthly-table-wrap"><table className="monthly-consolidated"><thead><tr><th scope="col">Indicador</th><th scope="col">{previousMonth}</th><th scope="col">{month}</th><th scope="col">Variação</th></tr></thead><tbody>
                {consolidatedRows.map((row) => {
                  const before = previousRunQuery.data?.result.metrics[row.key]?.value;
                  const after = metrics?.[row.key]?.value;
                  const diff = before == null || after == null ? null : after - before;
                  const variation = diff === null ? "—" : row.unit === "percent"
                    ? `${diff > 0 ? "+" : ""}${decimal.format(diff * 100)} p.p.`
                    : `${diff > 0 ? "+" : ""}${currency.format(diff)}`;
                  return <tr key={row.key}><th scope="row">{row.label}</th><td>{formatMetric(previousRunQuery.data?.result.metrics[row.key], row.unit)}</td><td>{formatMetric(metrics?.[row.key], row.unit)}</td><td>{variation}</td></tr>;
                })}
              </tbody></table></div>}
          </section> : null}
          <section className="monthly-section" aria-labelledby="monthly-position-title">
            <div className="monthly-section__heading"><h2 id="monthly-position-title">Posição e indicadores</h2><p>Valores de fim de mês; percentuais derivados usam o PL e o DC indicados abaixo.</p></div>
            <div className="monthly-metrics monthly-metrics--main">
              <MetricCard label="Patrimônio líquido" metric={metrics?.pl} />
              <MetricCard label="Direitos creditórios brutos" metric={metrics?.creditGross} />
              <MetricCard label="Vencidos · agregado CVM" metric={metrics?.overdue} />
              <MetricCard label="Direitos creditórios a vencer · estimativa" metric={metrics?.creditPerforming} />
              <MetricCard label="PDD" metric={metrics?.pdd} />
              <MetricCard label="DC líquido de PDD · corrigido" metric={metrics?.creditNetPdd} />
              <MetricCard label="Subordinação apurada" metric={metrics?.subordination} unit="percent" />
              <MetricCard label="Mínimo cadastrado" metric={metrics?.subordinationMinimum} unit="percent" />
              <MetricCard label="Folga indicativa" metric={metrics?.subordinationHeadroom} unit="percent" />
              <MetricCard label="DC / PL" metric={metrics?.creditToPl} unit="percent" />
            </div>
          </section>
          <div className="monthly-two-column">
            <section className="monthly-section" aria-labelledby="monthly-liquidity-title">
              <div className="monthly-section__heading"><h2 id="monthly-liquidity-title">Oferta e movimentos</h2><p>Saldo e fluxo separados para evitar soma indevida.</p></div>
              <div className="monthly-metrics">
                <MetricCard label="Tesouraria" metric={metrics?.cash} />
                <MetricCard label="Títulos públicos + compromissadas" metric={metrics?.publicBonds} />
                <MetricCard label="Cotas de fundos" metric={metrics?.fundUnits} />
                <MetricCard label="Captações no mês" metric={metrics?.inflow} />
                <MetricCard label="Resgates no mês · CVM" metric={metrics?.redemptions} />
                <MetricCard label="Resgates solicitados · CVM" metric={metrics?.redemptionsRequested} />
                <MetricCard label="Captações líquidas · CVM" metric={metrics?.netFlows} />
                <MetricCard label="Saldo CPR · carteira diária" metric={metrics?.cprBalance} />
                <MetricCard label="CPR residual · Informe CVM" metric={metrics?.cprCvm} />
                <MetricCard label="Liquidez imediata contábil" metric={metrics?.immediateLiquidity} />
                <MetricCard label="Aquisições no mês" metric={metrics?.acquisitions} />
                <MetricCard label="Quantidade adquirida" metric={metrics?.acquisitionCount} unit="number" />
              </div>
            </section>
            <section className="monthly-section" aria-labelledby="monthly-maturity-title">
              <div className="monthly-section__heading"><h2 id="monthly-maturity-title">Vencimento informado à CVM</h2><p>Faixas agregadas do informe. Não equivalem à previsão de caixa por título do relatório CVPAR.</p></div>
              <div className="monthly-bars">
                {result.maturityCvm.map((bucket) => <div className="monthly-bar" key={bucket.label}>
                  <span>{bucket.label}</span>
                  <div className="monthly-bar__track"><i style={{ width: `${maturityMax > 0 ? Math.max(1, (bucket.value ?? 0) / maturityMax * 100) : 0}%` }} /></div>
                  <strong>{bucket.value === null ? "—" : currency.format(bucket.value)}</strong>
                </div>)}
              </div>
            </section>
          </div>
          <section className="monthly-section" aria-labelledby="monthly-derived-title">
            <div className="monthly-section__heading"><h2 id="monthly-derived-title">Prazo e concentração · estimativas da CVM</h2><p>As faixas e a lista dos maiores devedores são agregadas; a apuração exata depende do estoque.</p></div>
            <div className="monthly-metrics">
              <MetricCard label="Prazo médio · dias corridos" metric={metrics?.averageMaturityCalendarDays} unit="days" />
              <MetricCard label="Prazo médio · dias úteis" metric={metrics?.averageMaturityBusinessDays} unit="days" />
              <MetricCard label="Taxa de cessão · a.a." metric={metrics?.cessionRateAnnual} unit="percent" />
              <MetricCard label="Maior sacado / PL" metric={metrics?.debtorTop1} unit="percent" />
              <MetricCard label="Top 5 sacados / PL" metric={metrics?.debtorTop5} unit="percent" />
              <MetricCard label="Cedente mais concentrado · % declarado" metric={metrics?.cedentListedTop1} unit="percent" />
              <MetricCard label="DC com vencimento até 30 dias" metric={metrics?.due30} />
              <MetricCard label="Liquidez contábil + DC até 30 dias / PL" metric={metrics?.immediatePlusDue30ToPl} unit="percent" />
            </div>
          </section>
          {result.overdueCvm ? <details className="monthly-section monthly-coverage"><summary>Faixas de vencidos informadas à CVM</summary>
            <p>A primeira faixa reúne 0–30 dias. O informe não permite separar até 5 de 6–30 dias.</p>
            <div className="monthly-table-wrap"><table><thead><tr><th scope="col">Faixa</th><th scope="col">Valor vencido</th></tr></thead><tbody>
              {result.overdueCvm.map((bucket) => <tr key={bucket.label}><th scope="row">{bucket.label}</th><td>{bucket.value === null ? "—" : currency.format(bucket.value)}</td></tr>)}
            </tbody></table></div>
          </details> : null}
          {result.evidence.positionDate ? <section className="monthly-section" aria-labelledby="monthly-expenses-title"><div className="monthly-section__heading"><h2 id="monthly-expenses-title">Despesas na carteira diária</h2><p>Posição de {result.evidence.positionDate}; provisões CPR ainda exigem confirmação como fluxo da competência.</p></div><div className="monthly-metrics"><MetricCard label="Administração" metric={metrics?.administrationExpense} /><MetricCard label="Custódia" metric={metrics?.custodyExpense} /><MetricCard label="Gestão" metric={metrics?.managementExpense} /><MetricCard label="Outras saídas CPR" metric={metrics?.otherNegativeExpenses} /></div></section> : null}
          <section className="monthly-section monthly-section--gaps" aria-labelledby="monthly-gaps-title"><div className="monthly-section__heading"><h2 id="monthly-gaps-title">Dados que ainda faltam</h2><p>Estes blocos não recebem zero nem classificação favorável por ausência de fonte.</p></div><ol>{result.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ol></section>
          <details className="monthly-section monthly-coverage"><summary>Cobertura por linha do relatório de Compliance</summary>
            <p>As linhas abaixo são um mapa de disponibilidade. O Excel não fornece valores ao cálculo; “aproximado” indica que a fonte ou base ainda exige homologação.</p>
            <div className="monthly-table-wrap"><table><thead><tr><th scope="col">Linha</th><th scope="col">Campo</th><th scope="col">Valor</th><th scope="col">Origem ou dado necessário</th></tr></thead><tbody>
              {reportCoverage.map((field) => {
                const metric = field.metric ? metrics?.[field.metric] : undefined;
                const missing = !metric || metric.value === null;
                return <tr key={field.rows}><th scope="row">{field.rows}</th><td>{field.label}</td><td>{formatMetric(metric, field.unit)}</td><td><strong>{missing ? "indisponível" : field.statusOverride ?? metric.status}</strong><span>{missing ? field.needed ?? metric?.source : metric.source}</span>{!missing && field.needed ? <span>{field.needed}</span> : null}{metric?.note ? <span>{metric.note}</span> : null}</td></tr>;
              })}
            </tbody></table></div>
          </details>
          <p className="monthly-footnote">Fontes CVM: {result.evidence.tables.join(", ")}. Carteira diária: {result.evidence.positionDate ?? "não importada"}. Identificador das entradas: {runQuery.data?.input_sha256.slice(0, 16)}…</p>
        </> : null}
      </div>
    </Layout>
  );
}
