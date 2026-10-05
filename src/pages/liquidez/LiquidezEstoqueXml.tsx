import { Fragment, useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { useAuth } from "@/contexts/AuthContext";
import { Badge } from "@/design-system/components/core/Badge";
import { Button } from "@/design-system/components/core/Button";
import { Card } from "@/design-system/components/core/Card";
import { Input } from "@/design-system/components/forms/Input";
import { Select } from "@/design-system/components/forms/Select";
import { supabase } from "@/integrations/supabase/client";
import "./liquidez-estoque-xml.css";

type Metric = { value: number | null; status: "apurado" | "aproximado" | "indisponivel"; source: string; note?: string };
type Result = { methodology: string; metrics: Record<string, Metric>; maturity: Array<{ label: string; value: number }>;
  overdue: Array<{ label: string; value: number }>; gaps: string[];
  evidence: { positionDate: string; stockImportId: string; stockFileName: string; stockRows: number;
    xmlFileName: string; xmlRows: number; xmlPositionName: string | null; xmlIsin: string | null } };
type Run = { id: string; calculated_at: string; input_sha256: string; result: Result;
  source_manifest?: { stock?: { normalized_sha256?: string }; xml?: { normalized_sha256?: string } } };
type Fund = { id: string; short_name: string; cnpj_fundo_master: string | null };
type Import = { id: string; reference_date: string; fund_document: string | null; file_name: string; imported_rows: number };
type Row = { key: string; label: string; unit?: "money" | "percent" | "days"; section: "Estoque do fundo" | "Posição/classe XML" | "Indisponível" };

const rows: Row[] = [
  { section: "Estoque do fundo", key: "stockGross", label: "Estoque bruto a valor presente" },
  { section: "Estoque do fundo", key: "pdd", label: "PDD do estoque" },
  { section: "Estoque do fundo", key: "stockNet", label: "Estoque líquido indicativo" },
  { section: "Estoque do fundo", key: "performing", label: "A vencer por situação" },
  { section: "Estoque do fundo", key: "overdue", label: "Vencidos por situação" },
  { section: "Estoque do fundo", key: "due5", label: "A vencer até 5 dias" },
  { section: "Estoque do fundo", key: "due6to30", label: "A vencer de 6 a 30 dias" },
  { section: "Estoque do fundo", key: "due30", label: "A vencer até 30 dias" },
  { section: "Estoque do fundo", key: "due90", label: "A vencer até 90 dias" },
  { section: "Estoque do fundo", key: "overdue5", label: "Vencidos há até 5 dias" },
  { section: "Estoque do fundo", key: "overdue6to30", label: "Vencidos há 6 a 30 dias" },
  { section: "Estoque do fundo", key: "overdue90", label: "Vencidos há mais de 90 dias" },
  { section: "Estoque do fundo", key: "overdue120", label: "Vencidos há mais de 120 dias" },
  { section: "Estoque do fundo", key: "averageMaturityCalendarDays", label: "Prazo médio ponderado", unit: "days" },
  { section: "Estoque do fundo", key: "cessionRateAnnual", label: "Taxa de cessão média anual", unit: "percent" },
  { section: "Estoque do fundo", key: "due30ToStock", label: "A vencer até 30 dias / estoque bruto", unit: "percent" },
  { section: "Estoque do fundo", key: "overdueToStock", label: "Vencidos / estoque bruto", unit: "percent" },
  ...[1, 5, 10, 15].map((count): Row => ({ section: "Estoque do fundo", key: `debtorTop${count}`, label: `Top ${count} sacado${count > 1 ? "s" : ""} / estoque bruto`, unit: "percent" })),
  ...[1, 5, 10, 15].map((count): Row => ({ section: "Estoque do fundo", key: `cedentTop${count}`, label: `Top ${count} cedente${count > 1 ? "s" : ""} / estoque bruto`, unit: "percent" })),
  { section: "Posição/classe XML", key: "classPl", label: "PL da posição/classe XML" },
  { section: "Posição/classe XML", key: "administrationExpense", label: "Administração paga no mês pela posição/classe" },
  { section: "Posição/classe XML", key: "cash", label: "Caixa líquido da posição/classe" },
  { section: "Posição/classe XML", key: "publicBonds", label: "Títulos públicos da posição/classe" },
  { section: "Posição/classe XML", key: "privateBonds", label: "Títulos privados da posição/classe" },
  { section: "Posição/classe XML", key: "ownFundUnits", label: "Cotas do próprio CNPJ na posição/classe" },
  { section: "Posição/classe XML", key: "otherFundUnits", label: "Cotas de outros fundos na posição/classe" },
  { section: "Posição/classe XML", key: "immediateAccounting", label: "Caixa + títulos públicos da posição/classe" },
  { section: "Indisponível", key: "pl", label: "PL consolidado do fundo" },
  { section: "Indisponível", key: "stockGrossToPl", label: "Estoque bruto / PL consolidado", unit: "percent" },
  { section: "Indisponível", key: "pddToPl", label: "PDD / PL consolidado", unit: "percent" },
  { section: "Indisponível", key: "inflow", label: "Captações do mês" },
  { section: "Indisponível", key: "redemptions", label: "Resgates e amortizações do mês" },
  { section: "Indisponível", key: "netFlows", label: "Movimentação líquida do mês" },
  { section: "Indisponível", key: "custodyExpense", label: "Custódia por natureza" },
  { section: "Indisponível", key: "managementExpense", label: "Gestão por natureza" },
  { section: "Indisponível", key: "repurchases", label: "Recompras" },
  { section: "Indisponível", key: "subordination", label: "Subordinação" ,unit: "percent" },
  { section: "Indisponível", key: "subordinationMinimum", label: "Mínimo de subordinação", unit: "percent" },
  { section: "Indisponível", key: "subordinationHeadroom", label: "Folga de subordinação", unit: "percent" },
  { section: "Indisponível", key: "coverageIndex", label: "Cobertura de resgates", unit: "percent" },
];
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const percent = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 2 });
const days = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const digitsOnly = (value: string | null) => (value ?? "").replace(/\D/g, "");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const format = (metric: Metric | undefined, unit: Row["unit"] = "money") => metric?.value == null ? "n/d"
  : unit === "percent" ? percent.format(metric.value) : unit === "days" ? `${days.format(metric.value)} dias` : money.format(metric.value);
const monthEnd = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);

export default function LiquidezEstoqueXml() {
  const { user, signIn, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const [month, setMonth] = useState("2026-07");
  const [cnpj, setCnpj] = useState("");
  const [busy, setBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const fundQuery = useQuery({ queryKey: ["stock-xml-funds", user?.id], enabled: !!user, queryFn: async (): Promise<Fund[]> => {
    const { data, error } = await supabase.from("funds").select("id,short_name,cnpj_fundo_master").eq("active", true).order("short_name").limit(500);
    if (error) throw error;
    return (data ?? []).filter((fund) => /^\d{14}$/.test(digitsOnly(fund.cnpj_fundo_master)));
  } });
  const importQuery = useQuery({ queryKey: ["stock-xml-imports", user?.id], enabled: !!user, queryFn: async (): Promise<Import[]> => {
    const { data, error } = await (supabase as any).from("importacoes_estoque_fidc")
      .select("id,reference_date,fund_document,file_name,imported_rows").eq("status", "success")
      .order("reference_date", { ascending: false }).limit(500);
    if (error) throw error;
    return data ?? [];
  } });
  const availableMonths = useMemo(() => [...new Set((importQuery.data ?? []).map((row) => row.reference_date.slice(0, 7)))].sort().reverse(), [importQuery.data]);
  useEffect(() => { if (availableMonths.length && !availableMonths.includes(month)) setMonth(availableMonths[0]); }, [availableMonths, month]);
  const availableFunds = useMemo(() => (fundQuery.data ?? []).filter((fund) => (importQuery.data ?? []).some((entry) =>
    entry.reference_date.slice(0, 7) === month && digitsOnly(entry.fund_document) === digitsOnly(fund.cnpj_fundo_master))), [fundQuery.data, importQuery.data, month]);
  useEffect(() => { if (!availableFunds.some((fund) => digitsOnly(fund.cnpj_fundo_master) === cnpj)) setCnpj(digitsOnly(availableFunds[0]?.cnpj_fundo_master ?? "")); }, [availableFunds, cnpj]);
  const stockImport = (importQuery.data ?? []).find((entry) => entry.reference_date === monthEnd(month) && digitsOnly(entry.fund_document) === cnpj);
  const xmlQuery = useQuery({ queryKey: ["stock-xml-position-available", user?.id, cnpj, month], enabled: !!user && !!cnpj, queryFn: async () => {
    const { data, error } = await (supabase as any).from("posicao_carteira").select("arquivo_nome,fundo_nome,fundo_isin")
      .eq("fundo_cnpj", cnpj).eq("fundo_dtposicao", monthEnd(month).replace(/-/g, "")).limit(1);
    if (error) throw error;
    return data?.[0] ?? null;
  } });
  const runQuery = useQuery({ queryKey: ["stock-xml-run", user?.id, cnpj, month], enabled: !!user && !!cnpj, queryFn: async (): Promise<Run | null> => {
    const { data, error } = await (supabase as any).from("liquidity_monthly_runs")
      .select("id,calculated_at,input_sha256,result,source_manifest")
      .eq("cnpj", cnpj).eq("reference_month", `${month}-01`)
      .eq("methodology_code", "cvpar_fidc_estoque_xml").eq("methodology_version", "2026.1")
      .order("calculated_at", { ascending: false }).limit(1);
    if (error) throw error;
    return data?.[0] ?? null;
  } });
  const roleQuery = useQuery({ queryKey: ["stock-xml-role", user?.id], enabled: !!user, queryFn: async () => {
    const [risk, portal] = await Promise.all([
      supabase.from("profiles").select("role").eq("id", user!.id).maybeSingle(),
      supabase.from("user_profiles").select("access_type,is_active").eq("id", user!.id).maybeSingle(),
    ]);
    if (risk.error) throw risk.error;
    if (portal.error) throw portal.error;
    return { role: risk.data?.role ?? null, access: portal.data?.access_type ?? null, active: portal.data?.is_active === true };
  } });
  const canWrite = !!user && roleQuery.isSuccess && roleQuery.data.active && roleQuery.data.role !== "compliance" &&
    (roleQuery.data.role === "risco" || roleQuery.data.access === "completo");
  const run = runQuery.data;
  const result = run?.result;

  async function calculate() {
    if (!canWrite || !stockImport || !xmlQuery.data || busy) return;
    setBusy(true); setMessage("");
    try {
      const { error } = await supabase.functions.invoke("calculate-liquidity-stock-xml", { body: { cnpj, competencia: month } });
      if (error) throw error;
      await queryClient.invalidateQueries({ queryKey: ["stock-xml-run", user?.id, cnpj, month] });
      setMessage("Apuração registrada. O fechamento mensal continua pendente.");
    } catch (error) { setMessage(`Cálculo não concluído: ${errorText(error)}`); }
    finally { setBusy(false); }
  }

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginBusy(true);
    setMessage("");
    try {
      const outcome = await signIn(email.trim(), password);
      if (outcome.error) {
        setMessage(outcome.error);
        return;
      }
      setPassword("");
      setMessage("Sessão iniciada. Carregando os dados do fundo.");
    } catch (error) {
      setMessage(`Falha no login: ${errorText(error)}`);
    } finally {
      setLoginBusy(false);
    }
  }

  return <Layout><main className="lsx-page">
    <header className="lsx-heading"><div><span className="lsx-eyebrow">Liquidez · metodologia independente</span><h1>FIDC mensal · Estoque + XML</h1><p>Apuração indicativa dos recebíveis do fundo e da posição XML importada.</p></div><Badge tone="warning">Sem fechamento</Badge></header>
    <div className="lsx-controls">
      <Select label="Competência" value={month} onChange={(event) => setMonth(event.target.value)} options={availableMonths.map((value) => ({ value, label: `${value.slice(5)}/${value.slice(0, 4)}` }))} disabled={!availableMonths.length} />
      <Select label="Fundo" value={cnpj} onChange={(event) => setCnpj(event.target.value)} options={availableFunds.map((fund) => ({ value: digitsOnly(fund.cnpj_fundo_master), label: fund.short_name }))} disabled={!availableFunds.length} />
      <div className="lsx-control-action"><Button onClick={() => void calculate()} disabled={!canWrite || !stockImport || !xmlQuery.data || busy} loading={busy}>Calcular dados importados</Button></div>
    </div>
    <p className="lsx-perimeter" role="note"><strong>Perímetros separados.</strong> O estoque cobre recebíveis do fundo. O XML importado descreve uma posição/classe; seu PL e seus ativos não são usados como denominador nem somados ao estoque. Vencimentos contratuais não são previsão de caixa.</p>
    {message && <p className="lsx-feedback" role="status">{message}</p>}
    {(fundQuery.error || importQuery.error || xmlQuery.error || runQuery.error || roleQuery.error) && <p className="lsx-error" role="alert">Falha na consulta: {errorText(fundQuery.error || importQuery.error || xmlQuery.error || runQuery.error || roleQuery.error)}</p>}
    {authLoading && <p className="lsx-empty">Verificando sessão do portal…</p>}
    {!user && !authLoading && <Card title="Entrar para consultar e calcular" subtitle="Use sua conta do portal. A execução exige perfil Risco ativo.">
      <form className="lsx-login" onSubmit={(event) => void handleSignIn(event)}>
        <Input label="E-mail" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={loginBusy} />
        <Input label="Senha" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={loginBusy} />
        <Button type="submit" loading={loginBusy} disabled={loginBusy}>Entrar</Button>
      </form>
    </Card>}
    {!!user && !importQuery.isLoading && !availableMonths.length && <p className="lsx-empty">Nenhum estoque FIDC concluído foi encontrado.</p>}
    {!!cnpj && !xmlQuery.isLoading && !xmlQuery.data && <p className="lsx-empty">XML da posição não encontrado para este fundo e competência.</p>}
    {!!cnpj && xmlQuery.data && !runQuery.isLoading && !run && <p className="lsx-empty">Estoque e XML encontrados. Esta metodologia ainda não foi calculada para a competência.</p>}
    {run && result && <>
      <div className="rcv-kpi-grid lsx-kpis">
        {([ ["stockGross", "Estoque bruto"], ["due30", "A vencer até 30 dias"], ["overdue", "Vencidos"], ["administrationExpense", "Administração paga · classe XML"] ] as const).map(([key, label]) =>
          <Card key={key} className="kpi"><div className="kpi__label">{label}</div><div className="kpi__value">{format(result.metrics[key])}</div></Card>)}
      </div>
      <Card title="Relatório por fonte" subtitle={`cvpar_fidc_estoque_xml@2026.1 · ${month} · execução ${new Date(run.calculated_at).toLocaleString("pt-BR")}`} padding={false}>
        <div className="lsx-table-wrap"><table className="rcv-table"><thead><tr><th>Indicador</th><th>Valor</th><th>Qualidade</th><th>Origem e ressalva</th></tr></thead><tbody>
          {rows.map((row, index) => { const metric = result.metrics[row.key]; const first = index === 0 || rows[index - 1].section !== row.section;
            return <Fragment key={row.key}>{first && <tr className="lsx-section"><th colSpan={4}>{row.section}</th></tr>}<tr><th>{row.label}</th><td className="num">{format(metric, row.unit)}</td><td><Badge tone={metric?.status === "apurado" ? "positive" : metric?.status === "aproximado" ? "warning" : "attention"}>{metric?.status ?? "indisponivel"}</Badge></td><td>{metric?.source ?? "Fonte não disponível"}{metric?.note ? <small>{metric.note}</small> : null}</td></tr></Fragment>; })}
        </tbody></table></div>
      </Card>
      <div className="row2b lsx-row">
        <Card title="Vencimento contratual do estoque" subtitle="Valor presente por faixa; não representa caixa projetado" padding={false}><div className="lsx-table-wrap"><table className="rcv-table"><thead><tr><th>Faixa</th><th>A vencer</th><th>Vencidos</th></tr></thead><tbody>{result.maturity.map((bucket, index) => <tr key={`${index}-${bucket.label}`}><th>{bucket.label}</th><td className="num">{money.format(bucket.value)}</td><td className="num">{money.format(result.overdue[index]?.value ?? 0)}</td></tr>)}</tbody></table></div></Card>
        <div className="lsx-side"><Card title="Pendências e limites"><ul className="lsx-gaps">{result.gaps.map((gap, index) => <li key={`${index}-${gap}`}>{gap}</li>)}</ul><p className="lsx-review-note">O responsável por aprovar o fechamento mensal será definido posteriormente. Esta apuração não concede aprovação.</p></Card><Card title="Evidências" subtitle={`Data-base ${result.evidence.positionDate}`}><dl className="lsx-evidence"><div><dt>Estoque</dt><dd>{result.evidence.stockFileName} · {result.evidence.stockRows} linhas</dd></div><div><dt>XML</dt><dd>{result.evidence.xmlFileName} · {result.evidence.xmlRows} linhas</dd></div><div><dt>Posição XML</dt><dd>{result.evidence.xmlPositionName ?? "n/d"} · ISIN {result.evidence.xmlIsin ?? "n/d"}</dd></div><div><dt>Hash de entrada</dt><dd className="num">{run.input_sha256}</dd></div></dl></Card></div>
      </div>
    </>}
  </main></Layout>;
}
