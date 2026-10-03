import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowRight, CalendarDays, CheckCircle2, CloudDownload, FileArchive, Loader2, LockKeyhole, RefreshCw, ShieldCheck, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import "./cvm-informes-panel.css";

type Job = "import-liquidity-monthly-cvm" | "import-cvm-informe-diario" | "import-cvm-registro" | "calculate-liquidity-monthly";

async function invokeJob(name: Job, body: Record<string, unknown> | FormData) {
  if (import.meta.env.DEV) {
    const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
    const { data: session } = await supabase.auth.getSession();
    const isForm = body instanceof FormData;
    const res = await fetch(`/functions/v1/${name}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.session?.access_token ?? anon}`,
        apikey: anon,
        ...(isForm ? {} : { "Content-Type": "application/json" }),
      },
      body: isForm ? body : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const payload = data as { message?: string; error?: string } | null;
      throw new Error(String(payload?.message ?? payload?.error ?? `HTTP ${res.status}`));
    }
    return data;
  }
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) throw error;
  return data;
}

export function CvmInformesPanel({ initialCompetencia }: { initialCompetencia?: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user, signIn } = useAuth();
  const loginRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const permissionQuery = useQuery({
    queryKey: ["cvm-monthly-permission", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const [risk, portal] = await Promise.all([
        supabase.from("profiles").select("role").eq("id", user!.id).maybeSingle(),
        supabase.from("user_profiles").select("access_type,is_active").eq("id", user!.id).maybeSingle(),
      ]);
      if (risk.error) throw risk.error;
      if (portal.error) throw portal.error;
      return { role: risk.data?.role ?? null, access: portal.data?.access_type ?? null, active: portal.data?.is_active === true };
    },
  });
  const permission = permissionQuery.data;
  const canImportMonthly = !!user && permissionQuery.isSuccess && !!permission?.active && permission.role !== "compliance" &&
    (permission.role === "risco" || permission.access === "completo");
  const [competencia, setCompetencia] = useState(() => {
    if (initialCompetencia && /^\d{4}-(0[1-9]|1[0-2])$/.test(initialCompetencia)) return initialCompetencia;
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [busy, setBusy] = useState<Job | "login" | null>(null);
  const [monthlyZip, setMonthlyZip] = useState<File | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [completed, setCompleted] = useState(false);
  const [calculationWarning, setCalculationWarning] = useState(false);
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(competencia);

  function explainAccess() {
    if (!user) {
      setMessage("Entre com sua conta do portal para importar o informe mensal.");
      loginRef.current?.focus();
    } else if (permissionQuery.isLoading) {
      setMessage("Verificando sua permissão. Aguarde um instante e tente novamente.");
    } else if (permissionQuery.isError) {
      setMessage("Não foi possível consultar seu perfil. Atualize a página ou procure o administrador.");
    } else {
      setMessage("Sua conta precisa estar ativa e ter perfil de Risco ou acesso completo para importar. Peça a habilitação ao administrador do portal.");
    }
  }

  async function run(fn: Job, zipFile?: File) {
    if (fn === "import-liquidity-monthly-cvm" && !canImportMonthly) { explainAccess(); return; }
    if (!user) { explainAccess(); return; }
    setBusy(fn);
    setMessage("");
    setCompleted(false);
    setCalculationWarning(false);
    try {
      if (fn !== "import-cvm-registro" && !validMonth) throw new Error("Informe uma competência válida no formato AAAA-MM.");
      if (zipFile && (!zipFile.name.toLowerCase().endsWith(".zip") || zipFile.size > 15_000_000)) {
        throw new Error("Selecione um arquivo .zip de até 15 MB.");
      }
      const body = zipFile ? new FormData() : fn === "import-cvm-registro" ? {} : { competencia };
      if (body instanceof FormData && zipFile) {
        body.append("competencia", competencia);
        body.append("file", zipFile);
      }
      const data = await invokeJob(fn, body);
      const result = data as { groups_upserted?: number; rows_upserted?: number; funds?: number; rows?: number; cnpjs_imported?: string[] } | null;
      const rows = result?.groups_upserted ?? result?.rows_upserted ?? result?.funds ?? result?.rows;
      const summary = rows != null
        ? fn === "import-liquidity-monthly-cvm" ? `${rows} grupos de tabelas gravados para ${competencia}.` : `${rows} linhas gravadas.`
        : "Importação concluída.";
      setMessage(summary);
      if (fn === "import-liquidity-monthly-cvm") {
        setCompleted(true);
        void queryClient.invalidateQueries({ queryKey: ["liquidity-monthly-loaded-months"] });
        const cnpjs = [...new Set((result?.cnpjs_imported ?? []).filter((value) => /^\d{14}$/.test(value)))];
        if (!cnpjs.length) {
          setCalculationWarning(true);
          setMessage(`${summary} A função de importação não retornou os CNPJs; calcule os fundos na aba Dados e parâmetros do relatório.`);
        } else {
          let calculated = 0;
          const failures: string[] = [];
          for (let offset = 0; offset < cnpjs.length; offset += 4) {
            const batch = cnpjs.slice(offset, offset + 4);
            setMessage(`${summary} Calculando ${Math.min(offset + batch.length, cnpjs.length)}/${cnpjs.length} fundos…`);
            const outcomes = await Promise.all(batch.map(async (cnpj) => {
              try {
                await invokeJob("calculate-liquidity-monthly", {
                  cnpj, competencia, methodology_code: "cvpar_fidc_mensal", methodology_version: "2026.2",
                });
                return { cnpj, ok: true };
              } catch (error) {
                return { cnpj, ok: false, detail: error instanceof Error ? error.message : String(error) };
              }
            }));
            for (const outcome of outcomes) {
              if (outcome.ok) calculated += 1;
              else failures.push(`${outcome.cnpj}: ${outcome.detail}`);
            }
          }
          void queryClient.invalidateQueries({ queryKey: ["liquidity-monthly-artifact"] });
          const finalMessage = `${summary} ${calculated}/${cnpjs.length} fundos calculados.${failures.length ? ` Falhas: ${failures.join("; ")}. Recalcule esses fundos na aba Dados e parâmetros.` : ""}`;
          setCalculationWarning(failures.length > 0);
          setMessage(finalMessage);
          toast({ title: failures.length ? "Informe importado com pendências" : "Informe e relatório atualizados", description: finalMessage, variant: failures.length ? "destructive" : "default" });
        }
      } else {
        toast({ title: "Informe CVM importado", description: summary });
      }
      if (zipFile) {
        setMonthlyZip(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setMessage(detail === "RISK_ROLE_REQUIRED" ? "Sua conta não possui permissão de Risco para importar." : detail);
      toast({ title: "Falha na importação CVM", description: detail, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("login");
    setMessage("");
    const outcome = await signIn(email.trim(), password);
    setPassword("");
    setBusy(null);
    setMessage(outcome.error ?? "Sessão iniciada. Sua permissão está sendo verificada.");
  }

  return <section className="cvm-panel" aria-labelledby="cvm-panel-title">
    <div className="cvm-panel-head">
      <div className="cvm-panel-mark"><CloudDownload aria-hidden="true" /></div>
      <div><span className="cvm-eyebrow">Fonte oficial · CVM</span><h2 id="cvm-panel-title">Informes CVM</h2><p>Atualize os informes e os relatórios dos fundos cadastrados.</p></div>
      <span className="cvm-security"><ShieldCheck aria-hidden="true" /> Origem rastreável</span>
    </div>
    <div className="cvm-panel-body">
      <div className="cvm-panel-toolbar"><div className="cvm-month-field"><Label htmlFor="cvm-competencia"><CalendarDays aria-hidden="true" /> Mês de referência</Label><Input id="cvm-competencia" type="month" value={competencia} onChange={(event) => { setCompetencia(event.target.value); setMessage(""); setCompleted(false); }} aria-invalid={!validMonth} /><small>Usado no informe mensal e no diário.</small></div><p>Selecione o mês e importe o informe mensal. O relatório de liquidez será calculado para os fundos encontrados.</p></div>
      <div className="cvm-primary-card"><div className="cvm-primary-copy"><span className="cvm-step">Importação principal · Liquidez FIDC</span><h3>Informe mensal</h3><p>O portal busca o arquivo público na CVM, registra a origem e atualiza os fundos cadastrados.</p></div><div className="cvm-primary-actions"><Button type="button" className="cvm-download-button" disabled={busy !== null || !validMonth} onClick={() => void run("import-liquidity-monthly-cvm")}>{busy === "import-liquidity-monthly-cvm" ? <Loader2 className="cvm-spin" aria-hidden="true" /> : <CloudDownload aria-hidden="true" />} {busy === "import-liquidity-monthly-cvm" ? "Importando informe…" : "Importar da CVM"}</Button><span>Já tem o arquivo? Envie o ZIP mensal</span><div className="cvm-file-row"><Label htmlFor="cvm-monthly-zip" className="cvm-file-picker"><FileArchive aria-hidden="true" /> {monthlyZip?.name ?? "Selecionar ZIP"}</Label><Input ref={fileInputRef} id="cvm-monthly-zip" className="cvm-file-input" type="file" accept=".zip,application/zip" disabled={busy !== null} onChange={(event) => setMonthlyZip(event.target.files?.[0] ?? null)} /><Button type="button" variant="outline" disabled={busy !== null || !monthlyZip || !validMonth} onClick={() => { if (monthlyZip) void run("import-liquidity-monthly-cvm", monthlyZip); }}><UploadCloud aria-hidden="true" /> Enviar ZIP</Button></div></div></div>
      {!user && <form className="cvm-login" onSubmit={(event) => void login(event)}><div className="cvm-login-copy"><LockKeyhole aria-hidden="true" /><div><strong>Entre para concluir a importação</strong><span>Use uma conta ativa com perfil de Risco ou acesso completo.</span></div></div><div className="cvm-login-fields"><Input ref={loginRef} aria-label="E-mail da conta do portal" type="email" placeholder="E-mail" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /><Input aria-label="Senha da conta do portal" type="password" placeholder="Senha" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /><Button type="submit" disabled={busy !== null}>{busy === "login" ? <Loader2 className="cvm-spin" aria-hidden="true" /> : null} Entrar</Button></div></form>}
      {!!user && !canImportMonthly && <div className="cvm-access-note" role="status"><LockKeyhole aria-hidden="true" /><span>{permissionQuery.isLoading ? "Verificando permissão da sua conta…" : permissionQuery.isError ? "Falha ao consultar o perfil. Atualize a página." : `Conta ${user.email ?? user.id}: perfil ${permission?.role ?? "não cadastrado"}, acesso ${permission?.access ?? "não cadastrado"}, ${permission?.active ? "ativa" : "inativa"}. A importação mensal exige Risco ou acesso completo ativo; o perfil Compliance só consulta.`}</span></div>}
      {message && <div className={completed && !calculationWarning ? "cvm-result cvm-result-ok" : "cvm-result"} role="status">{completed && !calculationWarning ? <CheckCircle2 aria-hidden="true" /> : null}<span>{message}</span>{completed && <Link to="/liquidez/mensal">Abrir relatório <ArrowRight aria-hidden="true" /></Link>}</div>}
      <div className="cvm-secondary"><div className="cvm-secondary-heading"><span className="cvm-step">Outras bases da CVM</span><h3>Atualizações complementares</h3></div><div className="cvm-secondary-grid"><button type="button" disabled={busy !== null} onClick={() => void run("import-cvm-informe-diario")}><span className="cvm-secondary-icon"><RefreshCw aria-hidden="true" /></span><span><strong>Informe diário</strong><small>PL, cotas, captações e resgates · usa o mês acima</small></span><ArrowRight aria-hidden="true" /></button><button type="button" disabled={busy !== null} onClick={() => void run("import-cvm-registro")}><span className="cvm-secondary-icon"><ShieldCheck aria-hidden="true" /></span><span><strong>Registro de classes</strong><small>Cadastro RCVM 175 e cad_fi · sem mês de referência</small></span><ArrowRight aria-hidden="true" /></button></div></div>
      <details className="cvm-audit"><summary>Como esta importação fica registrada</summary><p>O ZIP original e seu hash são preservados para auditoria. Reimportar o mesmo mês substitui os fatos dessa competência.</p></details>
    </div>
  </section>;
}
