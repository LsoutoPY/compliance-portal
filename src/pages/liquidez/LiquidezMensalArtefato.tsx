import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Download, FileDown, FileSpreadsheet, Loader2 } from "lucide-react";
import type { MonthlyExportInput } from "@/lib/liquidityMonthlyExport";
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Legend, LineChart, Line } from "recharts";
import { Layout } from "@/components/Layout";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import previewJson from "@/data/liquidityCvmPreview2026.json";
import "./liquidez-mensal-artefato.css";
import "./liquidez-mensal-scale.css";

type Metric = { value: number | null; status: "apurado" | "aproximado" | "indisponivel"; source: string; note?: string };
type Result = { cnpj: string; metrics: Record<string, Metric>; maturityCvm: { label: string; value: number | null }[]; overdueCvm?: { label: string; value: number | null }[]; gaps: string[]; evidence: { tables: string[]; positionDate: string | null } };
type Fund = { cnpj: string; shortName: string; name: string; minimum: number | null };
type Preview = { source: string; methodology: string; files: Record<string, { filename: string; sha256: string; filesSeen: number }>; positionFile?: { filename: string; sha256: string; cnpj: string; referenceDate: string }; funds: Fund[]; runs: Record<string, Record<string, Result>> };
type ReportRow = { section: string; label: string; key?: string; bucket?: { type: "maturityCvm" | "overdueCvm"; index: number }; unit?: "percent" | "days" | "count"; gap?: string };
const preview = previewJson as Preview;
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 });
const pct = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 2 });
const pct1 = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 });
const num = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const defaultCnpjs = preview.funds.slice(0, 5).map((fund) => fund.cnpj);
const monthNames = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const monthLabel = (month: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
  ? `${monthNames[Number(month.slice(5)) - 1]}/${month.slice(0, 4)}`
  : month;
const priorMonth = (month: string) => { const [year, number] = month.split("-").map(Number); return `${number === 1 ? year - 1 : year}-${String(number === 1 ? 12 : number - 1).padStart(2, "0")}`; };
const val = (result: Result | undefined, key: string) => result?.metrics[key]?.value ?? null;
const safeRatio = (a: number | null, b: number | null) => a !== null && b !== null && b !== 0 ? a / b : null;
const fmt = (value: number | null | undefined, unit?: ReportRow["unit"]) => value === null || value === undefined ? "n/d" : unit === "percent" ? pct.format(value) : unit === "days" ? `${num.format(value)} dias` : unit === "count" ? num.format(value) : money.format(value);
const rowMetric = (result: Result | undefined, row: ReportRow): Metric | undefined => !result ? undefined : row.key ? result.metrics[row.key] : row.bucket ? { value: result[row.bucket.type]?.[row.bucket.index]?.value ?? null, status: "aproximado", source: `CVM · TAB_V/VI_${row.bucket.type === "maturityCvm" ? "A" : "B"}${row.bucket.index + 1}`, note: row.bucket.type === "maturityCvm" ? "Vencimento contratual, não caixa projetado." : "Faixa agregada do informe." } : undefined;
const errText = (error: unknown) => error instanceof Error ? error.message : String(error);

const rows: ReportRow[] = [
  { section: "Despesas e CPR", label: "Taxa de administração", key: "administrationExpense", gap: "Carteira diária e competência da despesa" },
  { section: "Despesas e CPR", label: "Taxa de custódia", key: "custodyExpense", gap: "Carteira diária" },
  { section: "Despesas e CPR", label: "Taxa de gestão", key: "managementExpense", gap: "Carteira diária" },
  { section: "Despesas e CPR", label: "Outras despesas", key: "otherNegativeExpenses", gap: "Net Report por natureza" },
  { section: "Despesas e CPR", label: "CPR residual do informe", key: "cprCvm" },
  { section: "Movimentação", label: "Entradas / captações", key: "inflow" },
  { section: "Movimentação", label: "Saídas / resgates e amortizações", key: "redemptions" },
  { section: "Movimentação", label: "Movimentação líquida", key: "netFlows" },
  { section: "Alocação de ativos", label: "Patrimônio líquido", key: "pl" },
  { section: "Alocação de ativos", label: "DC total bruto", key: "creditGross" },
  { section: "Alocação de ativos", label: "DC direto bruto", key: "creditDirectGross" },
  { section: "Alocação de ativos", label: "Cotas FIDC", key: "fidcUnits" },
  { section: "Alocação de ativos", label: "Outros VM de crédito", key: "otherCreditVm" },
  { section: "Alocação de ativos", label: "DC a vencer · estimativa", key: "creditPerforming" },
  { section: "Alocação de ativos", label: "DC vencidos", key: "overdue" },
  { section: "Alocação de ativos", label: "PDD", key: "pdd" },
  { section: "Alocação de ativos", label: "Títulos públicos / compromissadas", key: "publicBonds" },
  { section: "Alocação de ativos", label: "Cotas de FIF / liquidez", key: "fundUnits" },
  { section: "Alocação de ativos", label: "Tesouraria", key: "cash" },
  { section: "Indicadores de alocação", label: "DC bruto / PL", key: "creditToPl", unit: "percent" },
  { section: "Indicadores de alocação", label: "PDD / PL", key: "pddToPl", unit: "percent" },
  { section: "Indicadores de alocação", label: "DC líquido de PDD / PL · fórmula corrigida", key: "creditNetPddToPl", unit: "percent" },
  { section: "Indicadores de alocação", label: "Liquidez imediata contábil", key: "immediateLiquidity" },
  { section: "Indicadores de alocação", label: "Liquidez imediata + DC ≤ 30 d / PL", key: "immediatePlusDue30ToPl", unit: "percent" },
  { section: "Prazo e aquisições", label: "Prazo médio estimado · dias corridos", key: "averageMaturityCalendarDays", unit: "days", gap: "Estoque título a título para prazo exato" },
  { section: "Prazo e aquisições", label: "Prazo médio estimado · dias úteis", key: "averageMaturityBusinessDays", unit: "days", gap: "Estoque e calendário de feriados" },
  { section: "Prazo e aquisições", label: "Aquisições com e sem risco", key: "acquisitions" },
  { section: "Prazo e aquisições", label: "Quantidade de aquisições", key: "acquisitionCount", unit: "count" },
  { section: "Prazo e aquisições", label: "Taxa de cessão estimada · a.a.", key: "cessionRateAnnual", unit: "percent", gap: "Taxa contrato a contrato" },
  { section: "Inadimplência", label: "Vencidos / DC", key: "overdueToCredit", unit: "percent" },
  { section: "Inadimplência", label: "Vencidos / PL", key: "overdueToPl", unit: "percent" },
  { section: "Inadimplência", label: "Vencidos > 90 dias", key: "overdue90" },
  { section: "Inadimplência", label: "Vencidos > 120 dias", key: "overdue120" },
  { section: "Faixas de vencidos", label: "Vencidos até 5 dias", gap: "Estoque individual não disponível no informe" },
  { section: "Faixas de vencidos", label: "Vencidos de 6 a 30 dias", gap: "Informe agrega em até 30 dias" },
  ...["Até 30 dias", "31–60 dias", "61–90 dias", "91–120 dias", "121–150 dias", "151–180 dias", "181–360 dias", "361–720 dias", "721–1080 dias", ">1080 dias"].map((label, index): ReportRow => ({ section: "Faixas de vencidos", label: `CVM · ${label}`, bucket: { type: "overdueCvm", index } })),
  { section: "Vencimentos", label: "DC a vencer ≤ 30 dias", key: "due30", gap: "Informe não separa até 5 e 6–30 dias" },
  { section: "Vencimentos", label: "DC a vencer ≤ 90 dias", key: "due90" },
  { section: "Vencimento contratual dos DC · CVM", label: "Previsão de caixa até 5 dias", gap: "Estoque e cronograma de recebimento" },
  { section: "Vencimento contratual dos DC · CVM", label: "Previsão de caixa de 6–30 dias", gap: "Informe só mostra até 30 dias agregado" },
  ...["Até 30 dias", "31–60 dias", "61–90 dias", "91–120 dias", "121–150 dias", "151–180 dias", "181–360 dias", "361–720 dias", "721–1080 dias", ">1080 dias"].map((label, index): ReportRow => ({ section: "Vencimento contratual dos DC · CVM", label: `DC a vencer · ${label}`, bucket: { type: "maturityCvm", index } })),
  { section: "Concentração", label: "Maior cedente listado", key: "cedentListedTop1", unit: "percent", gap: "Informe lista até 9 cedentes por grupo" },
  { section: "Concentração", label: "Top 5/10/15 cedentes", gap: "Estoque completo por cedente" },
  { section: "Concentração", label: "Maior sacado / PL", key: "debtorTop1", unit: "percent" },
  { section: "Concentração", label: "Top 5 sacados / PL", key: "debtorTop5", unit: "percent" },
  { section: "Concentração", label: "Top 10 sacados / PL", key: "debtorTop10", unit: "percent" },
  { section: "Concentração", label: "Top 15 sacados / PL", key: "debtorTop15", unit: "percent" },
  { section: "Recompra", label: "Recompra agregada CVM", key: "repurchaseCvm" },
  { section: "Recompra", label: "Recompra / liquidados", gap: "Arquivo de títulos liquidados do Portal FIDC" },
  { section: "Recompra", label: "Baixa por depósito do cedente", gap: "Arquivo de títulos liquidados do Portal FIDC" },
  { section: "Subordinação", label: "Cotas seniores", key: "seniorTrancheValue" },
  { section: "Subordinação", label: "Cotas mezanino", key: "mezzanineTrancheValue" },
  { section: "Subordinação", label: "Cotas subordinadas", key: "juniorTrancheValue" },
  { section: "Subordinação", label: "Índice apurado", key: "subordination", unit: "percent" },
  { section: "Subordinação", label: "Mínimo parametrizado", key: "subordinationMinimum", unit: "percent", gap: "Confirmar regulamento vigente" },
  { section: "Subordinação", label: "Folga indicativa", key: "subordinationHeadroom", unit: "percent" },
];
const colors = ["#125d69", "#277d88", "#4a9ba5", "#80b9be", "#bddee0", "#d9ecee", "#d5a852", "#c45b50"];
const chartColors = ["#1b6b78", "#d59537", "#46977b", "#dc6b65", "#8674ca", "#588dbb", "#b49b61", "#596f86"];

function SummaryCards({ funds, runs }: { funds: Fund[]; runs: Record<string, Result> }) {
  return <div className="lma-summary">{funds.map((fund) => {
    const result = runs[fund.cnpj];
    const overdue = safeRatio(val(result, "overdue"), val(result, "creditGross"));
    const sub = val(result, "subordination");
    const top = val(result, "debtorTop1");
    const liquidity = val(result, "immediatePlusDue30ToPl");
    const warning = fund.minimum === null ? "Mínimo de subordinação não parametrizado" : top !== null && top > .5 ? `Maior sacado = ${pct1.format(top)} do PL` : val(result, "overdue120") && val(result, "overdue120")! > 0 ? `Vencidos > 120 dias: ${money.format(val(result, "overdue120")!)}` : "Sem gatilhos nos dados disponíveis";
    return <article className="lma-summary-card" key={fund.cnpj}>
      <div className="lma-card-head"><strong>{fund.shortName}</strong><span>{fmt(val(result, "pl"))}</span></div>
      <dl><div><dt>Subordinação</dt><dd>{fmt(sub, "percent")} {fund.minimum !== null ? `/ mín. ${pct1.format(fund.minimum)}` : ""}</dd></div><div><dt>Vencidos / DC</dt><dd>{fmt(overdue, "percent")}</dd></div><div><dt>Liquidez ≤ 30 d / PL</dt><dd>{fmt(liquidity, "percent")}</dd></div></dl>
      <div className="lma-microbar" aria-label="Composição ilustrativa dos ativos"><i style={{ width: `${Math.min(100, Math.max(0, (val(result, "immediateLiquidity") ?? 0) / (val(result, "pl") || 1) * 100))}%` }} /><b /></div>
      <small>liquidez contábil <span>demais ativos</span></small>
      <p className={warning.includes("Sem gatilhos") ? "lma-alert lma-alert-ok" : "lma-alert"}>{warning}</p>
    </article>;
  })}</div>;
}

function Charts({ funds, runs }: { funds: Fund[]; runs: Record<string, Result> }) {
  const ladder = funds.map((fund) => {
    const result = runs[fund.cnpj]; const pl = val(result, "pl") || 1;
    const buckets = result?.maturityCvm ?? [];
    return { name: fund.shortName, Imediata: (val(result, "immediateLiquidity") ?? 0) / pl * 100, "DC ≤ 30 d": (buckets[0]?.value ?? 0) / pl * 100, "31–90 d": ((buckets[1]?.value ?? 0) + (buckets[2]?.value ?? 0)) / pl * 100, "91–180 d": buckets.slice(3, 6).reduce((a, b) => a + (b.value ?? 0), 0) / pl * 100, "181–360 d": (buckets[6]?.value ?? 0) / pl * 100, ">360 d": buckets.slice(7).reduce((a, b) => a + (b.value ?? 0), 0) / pl * 100, Vencidos: (val(result, "overdue") ?? 0) / pl * 100 };
  });
  const horizons = [0, 30, 60, 90, 120, 180, 360, 720, 1080, 1081];
  const horizonData = horizons.map((h, index) => Object.fromEntries([["horizon", h === 1081 ? ">1080" : h], ...funds.map((fund) => {
    const result = runs[fund.cnpj]; const pl = val(result, "pl") || 1;
    const immediate = val(result, "immediateLiquidity") ?? 0;
    const due = (result?.maturityCvm ?? []).slice(0, index).reduce((a, b) => a + (b.value ?? 0), 0);
    return [fund.shortName, Math.min(100, (immediate + due) / pl * 100)];
  })]));
  const aging = funds.map((fund) => {
    const result = runs[fund.cnpj]; const dc = val(result, "creditGross") || 1;
    return { name: fund.shortName, ...Object.fromEntries((result?.overdueCvm ?? []).map((bucket, index) => [`F${index + 1}`, (bucket.value ?? 0) / dc * 100])) };
  });
  const subordinate = funds.map((fund) => ({ name: fund.shortName, apurado: (val(runs[fund.cnpj], "subordination") ?? 0) * 100, minimo: fund.minimum === null ? null : fund.minimum * 100 }));
  return <div className="lma-chart-grid">
    <section className="lma-chart"><h3>Escada de liquidez</h3><p>Ativos por prazo de conversão em caixa, como % do PL. DC por vencimento contratual.</p><div className="lma-chart-box"><ResponsiveContainer width="100%" height="100%"><BarChart data={ladder} layout="vertical" margin={{ top: 8, right: 18, bottom: 8, left: 15 }}><CartesianGrid stroke="#e4edef" horizontal={false} /><XAxis type="number" tickFormatter={(v) => `${v}%`} /><YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} /><Tooltip formatter={(v: number) => `${num.format(v)}%`} /><Legend />{["Imediata", "DC ≤ 30 d", "31–90 d", "91–180 d", "181–360 d", ">360 d", "Vencidos"].map((key, i) => <Bar key={key} dataKey={key} stackId="total" fill={i === 6 ? "#c45b50" : colors[i]} />)}</BarChart></ResponsiveContainer></div></section>
    <section className="lma-chart"><h3>Liquidez acumulada por horizonte</h3><p>Liquidez imediata somada aos DC a vencer até cada prazo, como % do PL.</p><div className="lma-chart-box"><ResponsiveContainer width="100%" height="100%"><LineChart data={horizonData} margin={{ top: 8, right: 35, bottom: 8, left: 0 }}><CartesianGrid stroke="#e4edef" vertical={false} /><XAxis dataKey="horizon" /><YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} /><Tooltip formatter={(v: number) => `${num.format(v)}%`} /><Legend />{funds.map((fund, i) => <Line key={fund.cnpj} type="monotone" dataKey={fund.shortName} stroke={chartColors[i % chartColors.length]} strokeWidth={2} dot={{ r: 2 }} />)}</LineChart></ResponsiveContainer></div></section>
    <section className="lma-chart"><h3>Aging dos vencidos</h3><p>Composição dos DC vencidos por faixa de atraso, como % do DC total.</p><div className="lma-chart-box"><ResponsiveContainer width="100%" height="100%"><BarChart data={aging} layout="vertical" margin={{ top: 8, right: 18, bottom: 8, left: 15 }}><CartesianGrid stroke="#e4edef" horizontal={false} /><XAxis type="number" tickFormatter={(v) => `${v}%`} /><YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} /><Tooltip formatter={(v: number) => `${num.format(v)}%`} /><Legend />{Array.from({ length: 10 }, (_, i) => <Bar key={i} name={(runs[funds[0]?.cnpj]?.overdueCvm ?? [])[i]?.label ?? `Faixa ${i + 1}`} dataKey={`F${i + 1}`} stackId="total" fill={i < 6 ? ["#8babc0", "#d4ad54", "#d98b53", "#bc6553", "#a04c42", "#753a39"][i] : "#61363c"} />)}</BarChart></ResponsiveContainer></div></section>
    <section className="lma-chart"><h3>Subordinação versus mínimo</h3><p>(Mezanino + subordinada) / PL contra o índice mínimo parametrizado.</p><div className="lma-chart-box"><ResponsiveContainer width="100%" height="100%"><BarChart data={subordinate} layout="vertical" margin={{ top: 8, right: 18, bottom: 8, left: 15 }}><CartesianGrid stroke="#e4edef" horizontal={false} /><XAxis type="number" tickFormatter={(v) => `${v}%`} /><YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} /><Tooltip formatter={(v: number) => `${num.format(v)}%`} /><Legend /><Bar dataKey="apurado" name="Apurado" fill="#62a797" /><Bar dataKey="minimo" name="Mínimo" fill="#1a655e" /></BarChart></ResponsiveContainer></div></section>
  </div>;
}

export default function LiquidezMensalArtefato() {
  const { user } = useAuth(); const queryClient = useQueryClient();
  const [tab, setTab] = useState<"Relatório" | "Painel" | "Metodologia" | "Dados e parâmetros">("Relatório");
  const [source, setSource] = useState<"preview" | "portal">("portal");
  const [month, setMonth] = useState("2026-07"); const [selected, setSelected] = useState<string[]>(defaultCnpjs);
  const [fundSearch, setFundSearch] = useState("");
  const [fundPage, setFundPage] = useState(0);
  const initializedMonth = useRef(false);
  const loadedMonthsQuery = useQuery({ queryKey: ["liquidity-monthly-loaded-months", user?.id], enabled: !!user, queryFn: async () => {
    const { data, error } = await supabase.from("ingest_runs").select("competencia").eq("dataset", "cvm_informe_mensal_fidc").eq("status", "ok").order("competencia", { ascending: false });
    if (error) throw error;
    return [...new Set((data ?? []).map((row) => String(row.competencia).slice(0, 7)).filter((value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value)))];
  } });
  const availableMonths = [...new Set([...(loadedMonthsQuery.data ?? []), ...Object.keys(preview.runs)])].sort().reverse();
  useEffect(() => {
    if (!initializedMonth.current && loadedMonthsQuery.isSuccess && availableMonths.length) {
      initializedMonth.current = true;
      setMonth(availableMonths[0]);
    }
  }, [loadedMonthsQuery.isSuccess, loadedMonthsQuery.data]);
  const [minimumOverrides, setMinimumOverrides] = useState<Record<string, number | null>>({});
  const [compare, setCompare] = useState(false);
  const [filter, setFilter] = useState(""); const [detail, setDetail] = useState<ReportRow | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState<"pdf" | "excel" | null>(null);
  const [exportMessage, setExportMessage] = useState("");
  const exportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!exportOpen) return;
    const close = (event: PointerEvent) => { if (!exportRef.current?.contains(event.target as Node)) setExportOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [exportOpen]);
  const fundQuery = useQuery({ queryKey: ["liquidity-monthly-funds", user?.id], enabled: !!user, queryFn: async (): Promise<Fund[]> => {
    const { data, error } = await supabase.from("funds")
      .select("short_name,cnpj_fundo_master,min_subordination_index,active")
      .eq("active", true).not("cnpj_fundo_master", "is", null).order("short_name").limit(500);
    if (error) throw error;
    return (data ?? []).map((row) => {
      const cnpj = String(row.cnpj_fundo_master ?? "").replace(/\D/g, "");
      const sample = preview.funds.find((fund) => fund.cnpj === cnpj);
      return { cnpj, shortName: row.short_name, name: sample?.name ?? row.short_name, minimum: row.min_subordination_index === null ? null : Number(row.min_subordination_index) };
    }).filter((fund) => fund.cnpj.length === 14);
  } });
  const baseFunds = source === "preview" ? preview.funds : fundQuery.data ?? [];
  const funds = baseFunds.map((fund) => ({ ...fund, minimum: Object.prototype.hasOwnProperty.call(minimumOverrides, fund.cnpj) ? minimumOverrides[fund.cnpj] : fund.minimum }));
  const filteredFunds = funds.filter((fund) => `${fund.shortName} ${fund.cnpj}`.toLocaleLowerCase("pt-BR").includes(fundSearch.toLocaleLowerCase("pt-BR")));
  const selectedFunds = funds.filter((fund) => selected.includes(fund.cnpj));
  const fundPageCount = Math.max(1, Math.ceil(selectedFunds.length / 10));
  const currentFundPage = Math.min(fundPage, fundPageCount - 1);
  const visibleFunds = selectedFunds.slice(currentFundPage * 10, (currentFundPage + 1) * 10);
  const portalQuery = useQuery({ queryKey: ["liquidity-monthly-artifact", user?.id, month], enabled: source === "portal" && !!user, queryFn: async () => {
    const { data, error } = await (supabase as any).from("liquidity_monthly_runs").select("cnpj,result,calculated_at").eq("reference_month", `${month}-01`).eq("methodology_code", "cvpar_fidc_mensal").eq("methodology_version", "2026.2").order("calculated_at", { ascending: false });
    if (error) throw error;
    const runs: Record<string, Result> = {}; for (const row of data ?? []) runs[row.cnpj] ??= row.result as Result; return runs;
  } });
  const previousMonth = priorMonth(month);
  const previousQuery = useQuery({ queryKey: ["liquidity-monthly-artifact", user?.id, previousMonth], enabled: compare && source === "portal" && !!user, queryFn: async () => {
    const { data, error } = await (supabase as any).from("liquidity_monthly_runs").select("cnpj,result,calculated_at").eq("reference_month", `${previousMonth}-01`).eq("methodology_code", "cvpar_fidc_mensal").eq("methodology_version", "2026.2").order("calculated_at", { ascending: false });
    if (error) throw error; const runs: Record<string, Result> = {}; for (const row of data ?? []) runs[row.cnpj] ??= row.result as Result; return runs;
  } });
  const baseRuns: Record<string, Result> = source === "preview" ? preview.runs[month] ?? {} : portalQuery.data ?? {};
  const runs: Record<string, Result> = Object.keys(minimumOverrides).length === 0 ? baseRuns : Object.fromEntries(Object.entries(baseRuns).map(([cnpj, result]) => {
    if (!Object.prototype.hasOwnProperty.call(minimumOverrides, cnpj)) return [cnpj, result];
    const minimum = minimumOverrides[cnpj]; const sub = val(result, "subordination");
    return [cnpj, { ...result, metrics: { ...result.metrics,
      subordinationMinimum: { value: minimum, source: "Parâmetro local de simulação", status: minimum === null ? "indisponivel" : "aproximado", note: "Esta alteração não foi salva no banco." },
      subordinationHeadroom: { value: sub === null || minimum === null ? null : sub - minimum, source: "Simulação · subordinação apurada − mínimo local", status: sub === null || minimum === null ? "indisponivel" : "aproximado" },
    } } as Result];
  }));
  const previousRuns: Record<string, Result> = compare ? source === "preview" ? preview.runs[previousMonth] ?? {} : previousQuery.data ?? {} : {};
  const shownFunds = visibleFunds.filter((fund) => runs[fund.cnpj]);
  const exportFunds = selectedFunds.filter((fund) => runs[fund.cnpj]);
  const filteredRows = rows.filter((row) => `${row.section} ${row.label}`.toLocaleLowerCase("pt-BR").includes(filter.toLocaleLowerCase("pt-BR")));
  const reportSections = [...new Set(filteredRows.map((row) => row.section))];
  const roleQuery = useQuery({ queryKey: ["liquidity-monthly-role", user?.id], enabled: !!user, queryFn: async () => {
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
  async function downloadReport(format: "pdf" | "excel") {
    if (!exportFunds.length || exportBusy) return;
    setExportOpen(false);
    setExportBusy(format);
    setExportMessage("");
    try {
      const exporter = await import("@/lib/liquidityMonthlyExport");
      const input: MonthlyExportInput = {
        month, source, funds: exportFunds, rows, runs,
        previousRuns: compare ? previousRuns : undefined,
        previousMonth: compare ? previousMonth : undefined,
        simulated: Object.keys(minimumOverrides).length > 0,
      };
      if (format === "pdf") exporter.exportMonthlyPdf(input);
      else exporter.exportMonthlyExcel(input);
      setExportMessage(`${format === "pdf" ? "PDF" : "Excel"} gerado para ${exportFunds.length} fundo(s) em ${monthLabel(month)}.`);
    } catch (error) {
      setExportMessage(`Falha ao exportar: ${errText(error)}`);
    } finally {
      setExportBusy(null);
    }
  }
  async function uploadMonthly(file?: File) {
    if (!file) return; setBusy(true); setMessage("");
    try { const form = new FormData(); form.append("file", file); form.append("competencia", month); const { error } = await supabase.functions.invoke("import-liquidity-monthly-cvm", { body: form }); if (error) throw error; await queryClient.invalidateQueries({ queryKey: ["liquidity-monthly-loaded-months"] }); setMessage("Informe recebido. Calcule os fundos para atualizar a base do portal."); }
    catch (error) { setMessage(`Importação falhou: ${errText(error)}`); } finally { setBusy(false); }
  }
  async function uploadPosition(file?: File) {
    if (!file) return; setBusy(true); setMessage("");
    try { const form = new FormData(); form.append("file", file); const { data, error } = await supabase.functions.invoke<{ snapshot?: { cnpj: string; reference_date: string } }>("import-liquidity-position", { body: form }); if (error) throw error; setMessage(`Carteira diária importada para ${data?.snapshot?.reference_date ?? "a data do arquivo"}. Recalcule essa competência para incorporar as despesas CPR.`); }
    catch (error) { setMessage(`Importação da carteira falhou: ${errText(error)}`); } finally { setBusy(false); }
  }
  async function calculateAll(targetFunds: Fund[]) {
    if (!targetFunds.length) return;
    setBusy(true);
    setMessage(`Iniciando cálculo de ${targetFunds.length} fundo(s)…`);
    let completed = 0;
    const failures: string[] = [];
    try {
      for (let offset = 0; offset < targetFunds.length; offset += 4) {
        const batch = targetFunds.slice(offset, offset + 4);
        const outcomes = await Promise.all(batch.map(async (fund) => {
          try {
            const { error } = await supabase.functions.invoke("calculate-liquidity-monthly", {
              body: { cnpj: fund.cnpj, competencia: month, methodology_code: "cvpar_fidc_mensal", methodology_version: "2026.2" },
            });
            return { fund, error: error?.message ?? null };
          } catch (error) {
            return { fund, error: errText(error) };
          }
        }));
        for (const outcome of outcomes) {
          if (outcome.error) failures.push(`${outcome.fund.shortName}: ${outcome.error}`);
          else completed++;
        }
        setMessage(`Processados ${Math.min(offset + batch.length, targetFunds.length)}/${targetFunds.length} · ${completed} concluído(s).`);
      }
      await queryClient.invalidateQueries({ queryKey: ["liquidity-monthly-artifact"] });
      setMessage(`${completed}/${targetFunds.length} fundo(s) calculado(s).${failures.length ? ` Falhas: ${failures.join("; ")}` : ""}`);
      if (completed) setSource("portal");
    } finally {
      setBusy(false);
    }
  }
  return <Layout><div className="lma-page">
    <header className="lma-header"><div><span className="lma-eyebrow">Risco de liquidez · FIDC</span><h1>Relatório mensal CVPAR</h1><p>Estrutura do relatório de Compliance, com valores recalculados do Informe Mensal CVM.</p></div><div className="lma-header-controls"><label>Competência<select value={month} onChange={(e) => setMonth(e.target.value)}>{availableMonths.map((availableMonth) => <option key={availableMonth} value={availableMonth}>{monthLabel(availableMonth)}</option>)}</select></label><label>Origem<select value={source} onChange={(e) => setSource(e.target.value as "preview" | "portal")}><option value="preview">Prévia CVM enviada</option><option value="portal">Base do portal</option></select></label><div className="lma-export" ref={exportRef}><button type="button" className="lma-export-trigger" aria-haspopup="menu" aria-expanded={exportOpen} disabled={!exportFunds.length || exportBusy !== null || (source === "portal" && portalQuery.isLoading)} onClick={() => setExportOpen((open) => !open)}>{exportBusy ? <Loader2 className="lma-export-spin" aria-hidden="true" /> : <Download aria-hidden="true" />} Exportar <ChevronDown aria-hidden="true" /></button>{exportOpen && <div className="lma-export-menu" role="menu" aria-label="Formatos de exportação"><p>{exportFunds.length} fundo(s) selecionado(s) · relatório completo</p><button type="button" role="menuitem" onClick={() => void downloadReport("pdf")}><FileDown aria-hidden="true" /><span><strong>Exportar PDF</strong><small>Relatório paginado por fundo</small></span></button><button type="button" role="menuitem" onClick={() => void downloadReport("excel")}><FileSpreadsheet aria-hidden="true" /><span><strong>Exportar Excel</strong><small>Valores, memória e lacunas</small></span></button></div>}</div></div></header>
    {exportMessage && <p className="lma-export-feedback" role="status">{exportMessage}</p>}
    <div className="lma-source"><strong>{source === "preview" ? "Prévia auditável" : "Base do portal"}</strong><span>{source === "preview" ? `Calculada dos ZIPs CVM originais enviados · ${monthLabel(month)} · ${preview.methodology}. Não é fechamento oficial.` : user ? `Execuções persistidas · ${monthLabel(month)}.` : "Entre no portal para consultar execuções persistidas."}</span></div>
    <nav className="lma-tabs" aria-label="Abas do relatório">{(["Relatório", "Painel", "Metodologia", "Dados e parâmetros"] as const).map((name) => <button key={name} type="button" className={tab === name ? "active" : ""} onClick={() => setTab(name)}>{name}</button>)}</nav>
    {(tab === "Relatório" || tab === "Painel") && <><SummaryCards funds={shownFunds} runs={runs} /><div className="lma-filters"><span>Fundos · {selectedFunds.length}/{funds.length}</span><input aria-label="Buscar fundo" placeholder="Buscar fundo ou CNPJ" value={fundSearch} onChange={(event) => setFundSearch(event.target.value)} /><button type="button" onClick={() => { setSelected(funds.map((fund) => fund.cnpj)); setFundPage(0); }}>Selecionar todos</button><button type="button" onClick={() => { setSelected([]); setFundPage(0); }}>Limpar</button>{filteredFunds.slice(0, 12).map((fund) => <button type="button" key={fund.cnpj} className={selected.includes(fund.cnpj) ? "selected" : ""} onClick={() => setSelected((current) => current.includes(fund.cnpj) ? current.filter((x) => x !== fund.cnpj) : [...current, fund.cnpj])}>{fund.shortName}</button>)}{filteredFunds.length > 12 && <small>Mostrando 12 de {filteredFunds.length}; busque pelo nome ou CNPJ.</small>}</div>{selectedFunds.length > 10 && <div className="lma-fund-pager"><span>Fundos {currentFundPage * 10 + 1}–{Math.min((currentFundPage + 1) * 10, selectedFunds.length)} de {selectedFunds.length}</span><button type="button" disabled={currentFundPage === 0} onClick={() => setFundPage((page) => page - 1)}>Anterior</button><button type="button" disabled={currentFundPage >= fundPageCount - 1} onClick={() => setFundPage((page) => page + 1)}>Próxima</button></div>}</>}
    {tab === "Relatório" && <><div className="lma-report-tools"><span>Período | {monthLabel(month)} <small>linha / aderência à planilha</small></span><label className="lma-compare"><input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Comparar com mês anterior{compare ? ` (${monthLabel(previousMonth)})` : ""}</label><input aria-label="Filtrar linhas" placeholder="Filtrar linhas (ex.: PDD, TOP 5)" value={filter} onChange={(e) => setFilter(e.target.value)} /></div><div className="lma-table-wrap" role="region" aria-label="Relatório mensal por fundo" tabIndex={0}><table><thead><tr><th>Indicador</th>{shownFunds.map((fund) => <th key={fund.cnpj}>{fund.shortName}<small>{fund.cnpj}</small></th>)}</tr></thead><tbody>{reportSections.map((section) => <FragmentSection key={section} section={section} rows={filteredRows.filter((row) => row.section === section)} funds={shownFunds} runs={runs} previousRuns={previousRuns} onSelect={setDetail} />)}</tbody></table></div>{detail && <div className="lma-detail" role="region" aria-label="Memória do indicador"><button type="button" onClick={() => setDetail(null)}>Fechar ×</button><h3>{detail.label}</h3>{shownFunds.map((fund) => { const metric = rowMetric(runs[fund.cnpj], detail); return <p key={fund.cnpj}><strong>{fund.shortName}:</strong> {fmt(metric?.value, detail.unit)} · {metric?.status ?? "indisponível"}<br /><span>{metric?.source ?? detail.gap ?? "Fonte não disponível"}. {metric?.note ?? ""}</span></p>; })}</div>}</>}
    {tab === "Painel" && <><Charts funds={shownFunds} runs={runs} /><p className="lma-footnote">Horizontes representam vencimento contratual dos direitos creditórios e liquidez contábil; não são previsão de caixa efetivo nem cobertura de resgates.</p></>}
    {tab === "Metodologia" && <section className="lma-method"><h2>Como o relatório é montado</h2><p>O motor lê as Tabs I, III, IV, V–IX e X.2/X.4 do informe mensal CVM. A mesma estrutura de linhas do relatório de Compliance é preenchida com fórmulas explícitas. Cada linha informa origem, aderência e lacunas ao clicar no valor.</p><div className="lma-method-grid"><article><h3>DC total e PDD</h3><p>DC direto com e sem risco, PDD revertida para base bruta, cotas de FIDC e outros valores mobiliários de crédito (incluindo CCB/NC em I2C6). PDD vem de I2A11 + I2B11.</p></article><article><h3>Vencidos e liquidez</h3><p>Vencidos = TAB_V_B + TAB_VI_B. Liquidez imediata = caixa + títulos públicos/compromissadas + cotas de FIF. Os DC a vencer vêm das faixas TAB_V/VI_A.</p></article><article><h3>Subordinação</h3><p>Quantidade × valor da cota na Tab X.2; mezanino + subordinada dividido pelo PL. O mínimo é parâmetro da gestora e precisa de confirmação com o regulamento.</p></article><article><h3>Fluxos e concentração</h3><p>Movimentação = Tab X.4; aquisições = Tab VII; maiores sacados = Tab VIII. A lista de cedentes da CVM é limitada e requer estoque para concentração completa.</p></article></div><h2>Achados no confronto com a planilha de julho/2026</h2><ul><li>Concentração de EDUC e NC aparece com um mês de defasagem na planilha. Para EDUC, o informe de julho aponta maior sacado de 90,14% do PL.</li><li>Faixas de vencidos do EDUC na planilha somam R$ 174.063,04 (junho), enquanto a alocação de julho mostra R$ 89.254,25.</li><li>A linha “DC líquido de PDD” usa DC bruto/PL na planilha; o motor aplica (DC bruto + PDD)/PL, considerando PDD negativa.</li><li>Aquisições e entradas têm critérios divergentes entre fundos na planilha; conferir lâmina e Portal FIDC antes de fechar.</li></ul><h2>Dados ainda necessários</h2><ul><li>Estoque título a título para prazo médio exato, faixas até 5 e 6–30 dias e cedentes completos.</li><li>Arquivo de títulos liquidados para recompra e baixa por depósito do cedente.</li><li>Net Report/carteira diária por fundo e mês para despesas por natureza.</li><li>Regulamento vigente e cronograma de resgates para validar limites e cobertura de liquidez.</li></ul></section>}
    {tab === "Dados e parâmetros" && <section className="lma-data"><h2>Competências carregadas na prévia</h2><table><thead><tr><th>Competência</th><th>Origem</th><th>Arquivos</th><th>SHA-256</th></tr></thead><tbody>{Object.entries(preview.files).reverse().map(([key, file]) => <tr key={key}><td>{monthLabel(key)}</td><td>{file.filename}</td><td>{file.filesSeen} tabelas CSV</td><td><code>{file.sha256.slice(0, 18)}…</code></td></tr>)}</tbody></table><h2>Carteira diária para despesas</h2><p>CVPAR NC · 30/06/2026: a prévia de junho incorpora a carteira diária enviada e abre administração, custódia, gestão, outras despesas negativas e saldo CPR. Julho e demais fundos aguardam carteira diária. A execução do portal requer importação própria.</p><h2>Fundos e mínimo de subordinação</h2><p>Os mínimos abaixo podem ser simulados nesta tela. Alterações não são salvas e precisam ser confirmadas no regulamento antes de uso oficial.</p><table><thead><tr><th>Exibir</th><th>Nome curto</th><th>CNPJ</th><th>Nome no informe</th><th>Mínimo</th></tr></thead><tbody>{funds.map((fund) => <tr key={fund.cnpj}><td><input type="checkbox" checked={selected.includes(fund.cnpj)} onChange={() => setSelected((current) => current.includes(fund.cnpj) ? current.filter((x) => x !== fund.cnpj) : [...current, fund.cnpj])} /></td><td>{fund.shortName}</td><td>{fund.cnpj}</td><td>{fund.name}</td><td><input className="lma-min-input" aria-label={`Mínimo de ${fund.shortName} em porcentagem`} type="number" min="0" max="100" step="0.1" placeholder="A confirmar" value={fund.minimum === null ? "" : Number((fund.minimum * 100).toFixed(3))} onChange={(e) => { const raw = e.target.value; setMinimumOverrides((current) => ({ ...current, [fund.cnpj]: raw === "" ? null : Math.min(100, Math.max(0, Number(raw))) / 100 })); }} /> %</td></tr>)}</tbody></table><div className="lma-import"><h2>Atualizar a base do portal</h2>{!user ? <p>Entre no portal para importar e calcular dados persistidos. A prévia acima continua disponível sem login.</p> : roleQuery.data?.role === "compliance" ? <p>Seu perfil de Compliance pode consultar, mas não importar.</p> : canWrite ? <><label>Carregar informe mensal CVM (.zip)<input type="file" accept=".zip,application/zip" disabled={busy} onChange={(e) => { void uploadMonthly(e.target.files?.[0]); e.target.value = ""; }} /></label><label>Carregar Carteira Diária (.csv)<input type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => { void uploadPosition(e.target.files?.[0]); e.target.value = ""; }} /></label><button type="button" disabled={busy || !selectedFunds.length} onClick={() => void calculateAll(selectedFunds)}>{busy ? "Processando…" : `Calcular ${selectedFunds.length} selecionado(s)`}</button><button type="button" disabled={busy || !funds.length} onClick={() => void calculateAll(funds)}>{busy ? "Processando…" : `Calcular todos os ${funds.length} fundos cadastrados`}</button><p>Importe o ZIP antes do cálculo. A execução fica registrada na base do portal.</p></> : <p>{roleQuery.isLoading ? "Verificando permissão de escrita…" : "Perfil sem permissão de escrita."}</p>}{message && <p role="status">{message}</p>}{portalQuery.error && source === "portal" && <p role="alert">Consulta ao portal: {errText(portalQuery.error)}</p>}</div></section>}
    {source === "portal" && fundQuery.error && <p className="lma-empty" role="alert">Falha ao carregar os fundos cadastrados: {errText(fundQuery.error)}</p>}
    {source === "portal" && tab !== "Dados e parâmetros" && (portalQuery.isLoading || fundQuery.isLoading ? <p className="lma-empty">Consultando execuções e cadastro no portal…</p> : !selectedFunds.length ? <p className="lma-empty">Selecione ao menos um fundo para visualizar o relatório.</p> : !shownFunds.length ? <p className="lma-empty">Nenhuma execução encontrada para {monthLabel(month)}. Abra “Dados e parâmetros” para carregar o informe e calcular.</p> : null)}
  </div></Layout>;
}

function FragmentSection({ section, rows: sectionRows, funds, runs, previousRuns, onSelect }: { section: string; rows: ReportRow[]; funds: Fund[]; runs: Record<string, Result>; previousRuns: Record<string, Result>; onSelect: (row: ReportRow) => void }) {
  return <><tr className="lma-section"><th colSpan={funds.length + 1}>{section}</th></tr>{sectionRows.map((row) => <tr key={`${section}-${row.label}`} onClick={() => onSelect(row)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onSelect(row); }}><th>{row.label}<small>{row.gap ?? ""}</small></th>{funds.map((fund) => { const metric = rowMetric(runs[fund.cnpj], row); return <td key={fund.cnpj}><span>{fmt(metric?.value, row.unit)}</span>{previousRuns[fund.cnpj] && metric?.value !== null && metric?.value !== undefined && rowMetric(previousRuns[fund.cnpj], row)?.value !== null && rowMetric(previousRuns[fund.cnpj], row)?.value !== undefined ? <small className="lma-delta">Δ {fmt(metric.value - rowMetric(previousRuns[fund.cnpj], row)!.value!, row.unit)}</small> : null}<i className={`lma-status lma-status-${metric?.status ?? "indisponivel"}`} title={metric?.status ?? "indisponível"} /></td>; })}</tr>)}</>;
}
