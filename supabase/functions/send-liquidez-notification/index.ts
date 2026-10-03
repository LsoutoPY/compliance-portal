/**
 * Edge Function: Notificação de Risco de Liquidez por E-mail
 *
 * POST /send-liquidez-notification
 *
 * Envia um e-mail distinto por fundo e tipo de limite:
 *   - status=alerta  → Soft Limit
 *   - status=violacao → Hard Limit
 *
 * Body:
 * {
 *   "fundo_dtposicao"?: "20260720",
 *   "fundo_cnpj"?: "22003335000104",
 *   "nome_fundo"?: "QI CP FIC FIM",
 *   "tipo_limite"?: "soft" | "hard",
 *   "origem": "auto" | "manual"
 * }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { buildLiquidezFundoExcel, fetchCalculoLiquidez } from "./excel.ts";
import { getSmtpConfig, MAX_ATTACHMENT_BASE64_CHARS, sendEmailViaSmtp, smtpConfigError } from "./smtp.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type TipoLimite = "soft" | "hard";

interface NotificacaoRequest {
  fundo_dtposicao?: string;
  fundo_cnpj?: string;
  nome_fundo?: string;
  tipo_limite?: TipoLimite;
  origem?: "auto" | "manual";
}

interface FundoLiquidez {
  fundo_cnpj: string;
  fundo_isin?: string | null;
  dt_posicao: string;
  total_pl: number | null;
  is_fundo_fechado: boolean;
  prazo_resgate: number | null;
  indice_liquidez: number | null;
  status: string;
  intermediate_status: string | null;
  nome_comercial?: string | null;
  notificacao_habilitada?: boolean;
}

interface EnvioResultado {
  fundo_cnpj: string;
  nome_fundo: string | null;
  tipo_limite: TipoLimite;
  status: "enviado" | "ignorado" | "erro" | "sem_destinatarios";
  email_id?: string;
  erro?: string;
}

const SYSTEM_NAME = "Hub Risco";

function formatDataBR(dtposicao: string): string {
  if (!dtposicao || dtposicao.length !== 8) return dtposicao;
  return `${dtposicao.slice(6, 8)}/${dtposicao.slice(4, 6)}/${dtposicao.slice(0, 4)}`;
}

function formatBRL(valor: number | null): string {
  if (valor === null || valor === undefined) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(valor);
}

function formatIndice(valor: number | null, isFechado: boolean): string {
  if (valor === null || valor === undefined) return "—";
  if (isFechado) return `${(valor * 100).toFixed(2)}% PL`;
  return `${(valor * 100).toFixed(1)}%`;
}

/** Soft Limit padrão ANBIMA conforme prazo de resgate (mesma regra do calculo-risco-liquidez). */
function softLimitPct(prazo: number | null): number {
  if (prazo == null) return 105;
  if (prazo <= 60) return 120;
  if (prazo <= 126) return 110;
  return 105;
}

function buildIndiceLegendaHtml(fundo: FundoLiquidez): string {
  if (fundo.is_fundo_fechado) return "";

  const prazoLabel = fundo.prazo_resgate != null ? `D+${fundo.prazo_resgate}` : "o prazo de resgate";
  const softPct = softLimitPct(fundo.prazo_resgate);

  let interpretacao = "";
  if (fundo.indice_liquidez != null && fundo.prazo_resgate != null) {
    const pct = (Math.abs(fundo.indice_liquidez) * 100).toFixed(1);
    interpretacao = `<p style="margin:10px 0 0;font-size:12px;color:#374151;line-height:1.55;">
        <strong>Neste fundo:</strong> ${formatIndice(fundo.indice_liquidez, false)} indica que os ativos líquidos acumulados até
        <strong>${prazoLabel}</strong> cobrem <strong>${pct}%</strong> da pressão de resgate esperada até essa data.
      </p>`;
  }

  return `<div style="margin-top:14px;padding:14px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
      <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">Como ler a cobertura de liquidez</div>
      <p style="margin:0;font-size:11px;color:#6b7280;line-height:1.55;">
        O índice acumulado mede quanto da <strong>pressão de resgates</strong> o fundo consegue honrar com
        <strong>ativos líquidos acumulados</strong> até ${prazoLabel}.
        Fórmula: Ativo Acumulado ÷ Passivo Acumulado (resgates solicitados ou estimativa ANBIMA por vértice).
      </p>
      <p style="margin:8px 0 0;font-size:11px;color:#6b7280;line-height:1.55;">
        <strong>Referências para ${prazoLabel}:</strong>
        Hard Limit ≤ <strong>100%</strong> ·
        Soft Limit &lt; <strong>${softPct}%</strong> ·
        OK ≥ <strong>${softPct}%</strong>
      </p>
      ${interpretacao}
    </div>`;
}

function saudacaoPorHorario(): string {
  const hora = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hour12: false,
  });
  const h = parseInt(hora, 10);
  if (h < 12) return "bom dia";
  if (h < 18) return "boa tarde";
  return "boa noite";
}

function normalizeCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, "").padStart(14, "0");
}

function isNexumSenior(nome: string | null | undefined): boolean {
  return /\bFIDC\s+NEXUM\s+SR\b/i.test(nome ?? "");
}

function isNexumJunior(nome: string | null | undefined): boolean {
  return /\bFIDC\s+NEXUM\s+JR\b/i.test(nome ?? "");
}

function statusToTipoLimite(status: string): TipoLimite | null {
  if (status === "violacao") return "hard";
  if (status === "alerta") return "soft";
  return null;
}

function tipoLimiteMeta(tipo: TipoLimite): { label: string; color: string; bg: string; accent: string; border: string } {
  if (tipo === "hard") {
    return {
      label: "Hard Limit",
      color: "#dc2626",
      bg: "#fef2f2",
      accent: "#dc2626",
      border: "#fecaca",
    };
  }
  return {
    label: "Soft Limit",
    color: "#d97706",
    bg: "#fffbeb",
    accent: "#d97706",
    border: "#fcd34d",
  };
}

async function enrichFundosComNome(
  supabase: ReturnType<typeof createClient>,
  fundos: FundoLiquidez[],
  dtposicao: string,
): Promise<void> {
  if (fundos.length === 0) return;

  const paresPorCnpj = new Map<string, Array<{ fundo_isin: string; nome_fundo: string }>>();

  const { data: pares } = await supabase.rpc("get_pares_fundo_monitorado", {
    p_dtposicao: dtposicao,
  });
  for (const p of pares ?? []) {
    const row = p as { fundo_cnpj: string; fundo_isin?: string; nome_fundo?: string };
    if (!row.fundo_cnpj || !row.nome_fundo) continue;
    const cnpj = normalizeCnpj(row.fundo_cnpj);
    const paresDoCnpj = paresPorCnpj.get(cnpj) ?? [];
    paresDoCnpj.push({
      fundo_isin: row.fundo_isin?.trim() ?? "",
      nome_fundo: row.nome_fundo.trim(),
    });
    paresPorCnpj.set(cnpj, paresDoCnpj);
  }

  const cnpjsNorm = [...new Set(fundos.map((f) => normalizeCnpj(f.fundo_cnpj)))];

  const { data: fundosData } = await supabase
    .from("fundos_caracteristicas")
    .select("cnpj_fundo, cnpj_classe, isin, nome_comercial")
    .or(cnpjsNorm.map((c) => `cnpj_fundo.eq.${c},cnpj_classe.eq.${c}`).join(","));

  for (const f of fundos) {
    const key = normalizeCnpj(f.fundo_cnpj);
    const paresDoCnpj = paresPorCnpj.get(key) ?? [];

    // A origem da liquidez é consolidada por CNPJ. Para o NEXUM, o ISIN é o
    // discriminador entre JR e SR: seleciona JR quando ambas existirem e
    // bloqueia o envio se apenas a SR estiver disponível.
    const parSelecionado = paresDoCnpj.find((p) => isNexumJunior(p.nome_fundo))
      ?? paresDoCnpj.find((p) => !isNexumSenior(p.nome_fundo));
    if (!parSelecionado && paresDoCnpj.some((p) => isNexumSenior(p.nome_fundo))) {
      f.notificacao_habilitada = false;
      continue;
    }

    if (parSelecionado) {
      f.fundo_isin = parSelecionado.fundo_isin || null;
      f.nome_comercial = parSelecionado.nome_fundo;
      continue;
    }

    f.nome_comercial = (fundosData ?? []).find((fc) => {
      const fcCnpj = normalizeCnpj(fc.cnpj_fundo ?? fc.cnpj_classe ?? "");
      return fcCnpj === key && (!f.fundo_isin || fc.isin === f.fundo_isin);
    })?.nome_comercial ?? null;
  }
}

function buildSubject(nomeFundo: string, tipo: TipoLimite): string {
  const meta = tipoLimiteMeta(tipo);
  return `Monitoramento de risco de liquidez - ${nomeFundo} — Alerta de ${meta.label}`;
}

async function inferClasseAnbima(
  supabase: ReturnType<typeof createClient>,
  cnpj: string,
  nomeFundo: string,
): Promise<string> {
  const clean = normalizeCnpj(cnpj);
  const { data: fc } = await supabase
    .from("fundos_caracteristicas")
    .select("nivel1_categoria")
    .or(`cnpj_fundo.eq.${clean},cnpj_classe.eq.${clean}`)
    .limit(1)
    .maybeSingle();

  const cat = ((fc as { nivel1_categoria?: string } | null)?.nivel1_categoria ?? "").toUpperCase();
  const nome = (nomeFundo ?? "").toUpperCase();
  if (cat.includes("FIDC") || nome.includes("FIDC")) return "Renda Fixa Crédito";
  return "Multimercados";
}

function buildHtmlFundo(
  fundo: FundoLiquidez,
  dataFormatada: string,
  tipo: TipoLimite,
  opts?: { comAnexo?: boolean },
): string {
  const meta = tipoLimiteMeta(tipo);
  const nome = fundo.nome_comercial ?? fundo.fundo_cnpj;
  const prazo = fundo.is_fundo_fechado
    ? "Fechado"
    : fundo.prazo_resgate != null
    ? `D+${fundo.prazo_resgate}`
    : "—";
  const intermed = fundo.intermediate_status
    ? `<div style="font-size:11px;color:#6b7280;margin-top:8px;">Vértices intermediários: ${tipoLimiteMeta(statusToTipoLimite(fundo.intermediate_status) ?? "soft").label}</div>`
    : "";
  const legendaIndice = buildIndiceLegendaHtml(fundo);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${buildSubject(nome, tipo)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
          <tr>
            <td bgcolor="#1F4E3D" style="background-color:#1F4E3D;padding:24px 32px;">
              <div style="color:#ffffff;font-size:22px;font-weight:700;line-height:1.3;">
                Monitoramento de risco de liquidez
              </div>
              <div style="color:#d1fae5;font-size:13px;margin-top:6px;">
                Alerta de ${meta.label}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 0;">
              <div style="font-size:14px;color:#111827;line-height:1.6;">
                Srs, ${saudacaoPorHorario()}!<br/><br/>
                Informamos que o fundo <strong>${nome}</strong> atingiu o <strong>${meta.label}</strong>
                no monitoramento de risco de liquidez com data-base de <strong>${dataFormatada}</strong>.
                Por favor, verificar e retornar com o plano de ação.${opts?.comAnexo ? "<br/><br/>Segue em anexo a planilha de liquidez do fundo." : ""}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 0;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${meta.bg};border:1px solid ${meta.border};border-radius:8px;padding:16px 20px;">
                    <div style="font-size:13px;color:#6b7280;">Data de referência</div>
                    <div style="font-size:22px;font-weight:700;color:${meta.accent};margin-top:4px;">${dataFormatada}</div>
                    <div style="font-size:13px;color:#374151;margin-top:8px;">
                      Status: <strong style="color:${meta.color};">${meta.label}</strong>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;">
              <div style="font-size:16px;font-weight:700;color:#111827;margin-bottom:16px;">
                Detalhamento do fundo
              </div>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                <thead>
                  <tr style="background:#f3f4f6;">
                    <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;text-transform:uppercase;">Fundo</th>
                    <th style="padding:10px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;text-transform:uppercase;">PL</th>
                    <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;text-transform:uppercase;">Prazo</th>
                    <th style="padding:10px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;text-transform:uppercase;">Cobertura liquidez</th>
                    <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;text-transform:uppercase;">Status</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style="background:#ffffff;">
                    <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#111827;">
                      <div style="font-weight:600;">${nome}</div>
                      <div style="font-size:10px;color:#6b7280;font-family:Consolas,Monaco,monospace;margin-top:2px;">${fundo.fundo_cnpj}</div>
                      ${intermed}
                    </td>
                    <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;text-align:right;color:#374151;">${formatBRL(fundo.total_pl)}</td>
                    <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;text-align:center;color:#374151;">${prazo}</td>
                    <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;text-align:right;font-weight:600;color:#374151;">${formatIndice(fundo.indice_liquidez, fundo.is_fundo_fechado)}</td>
                    <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;text-align:center;">
                      <span style="display:inline-block;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;color:${meta.color};background:${meta.bg};">${meta.label}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              ${legendaIndice}
            </td>
          </tr>
          <tr>
            <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:24px 32px;text-align:left;">
              <div style="font-size:13px;color:#374151;line-height:1.5;">
                Luiz Souto<br/>
                Cvpar | Quadrante<br/>
                <span style="color:#9ca3af;font-size:11px;">
                  São Paulo — Av. Faria Lima, 3477 - 8º andar - Torre A · Itaim Bibi
                </span>
              </div>
              <div style="font-size:10px;color:#d1d5db;margin-top:10px;">
                Notificação automática · ${SYSTEM_NAME} ·
                ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} (BRT)
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function resolveDtposicao(
  supabase: ReturnType<typeof createClient>,
  body: NotificacaoRequest,
): Promise<string | null> {
  const explicit = body.fundo_dtposicao?.trim();
  if (explicit) return explicit;

  const { data: maxData } = await supabase
    .from("liquidez_monitoramento_risco")
    .select("dt_posicao")
    .eq("is_fundo_fechado", false)
    .in("status", ["violacao", "alerta"])
    .order("dt_posicao", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (maxData?.dt_posicao) return maxData.dt_posicao;

  const { data: anyDate } = await supabase
    .from("liquidez_monitoramento_risco")
    .select("dt_posicao")
    .order("dt_posicao", { ascending: false })
    .limit(1)
    .maybeSingle();

  return anyDate?.dt_posicao ?? null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const body: NotificacaoRequest = await req.json().catch(() => ({}));
    const origem = body.origem ?? "manual";

    let userId: string | null = null;

    if (origem === "manual") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Não autorizado" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Não autorizado" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = user.id;
    }

    const dtposicao = await resolveDtposicao(supabase, body);
    if (!dtposicao) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "Nenhum cálculo de liquidez encontrado",
          status: "sem_violacoes",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: fundosRaw, error: fundosErr } = await supabase
      .from("liquidez_monitoramento_risco")
      .select("fundo_cnpj, dt_posicao, total_pl, is_fundo_fechado, prazo_resgate, indice_liquidez, status, intermediate_status")
      .eq("dt_posicao", dtposicao)
      .eq("is_fundo_fechado", false)
      .in("status", ["violacao", "alerta"])
      .order("status")
      .order("fundo_cnpj");

    if (fundosErr) throw new Error(`Erro ao buscar alertas de liquidez: ${fundosErr.message}`);

    let fundos: FundoLiquidez[] = fundosRaw ?? [];

    if (body.fundo_cnpj?.trim()) {
      const cnpjNorm = normalizeCnpj(body.fundo_cnpj.trim());
      fundos = fundos.filter((f) => normalizeCnpj(f.fundo_cnpj) === cnpjNorm);
    }

    if (body.tipo_limite) {
      fundos = fundos.filter((f) => statusToTipoLimite(f.status) === body.tipo_limite);
    }

    await enrichFundosComNome(supabase, fundos, dtposicao);

    if (body.nome_fundo?.trim() && fundos.length === 1) {
      // Uma chamada manual aberta na classe SR não pode substituir a classe
      // JR resolvida pelo ISIN nem disparar um alerta para a SR.
      if (isNexumSenior(body.nome_fundo)) {
        fundos[0].notificacao_habilitada = false;
      } else {
        fundos[0].nome_comercial = body.nome_fundo.trim();
      }
    }

    const dataFormatada = formatDataBR(dtposicao);
    const candidatos = fundos
      .map((f) => ({ fundo: f, tipo: statusToTipoLimite(f.status) }))
      .filter((x): x is { fundo: FundoLiquidez; tipo: TipoLimite } =>
        x.tipo !== null && x.fundo.notificacao_habilitada !== false,
      );

    if (candidatos.length === 0) {
      await supabase.from("envios_notificacao_liquidez").insert({
        data_referencia: dtposicao,
        qtd_violacoes: 0,
        qtd_fundos: 0,
        destinatarios: [],
        origem,
        enviado_por: userId,
        status: "sem_violacoes",
      });
      return new Response(
        JSON.stringify({
          success: true,
          message: "Nenhum fundo em Soft ou Hard Limit para a data informada — e-mail não enviado",
          data_referencia: dtposicao,
          status: "sem_violacoes",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: destinatariosData } = await supabase
      .from("email_destinatarios")
      .select("email")
      .eq("tipo", "liquidez")
      .eq("ativo", true);

    const destinatarios = (destinatariosData ?? []).map((d) => d.email).filter(Boolean);

    if (destinatarios.length === 0) {
      console.warn("[send-liquidez-notification] Nenhum destinatário cadastrado para tipo=liquidez");
      return new Response(
        JSON.stringify({
          success: false,
          error: "Nenhum destinatário cadastrado para notificação de liquidez",
          qtd_fundos: candidatos.length,
        }),
        {
          status: 422,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (!getSmtpConfig()) {
      await supabase.from("envios_notificacao_liquidez").insert({
        data_referencia: dtposicao,
        qtd_violacoes: candidatos.filter((c) => c.tipo === "hard").length,
        qtd_fundos: candidatos.length,
        destinatarios,
        origem,
        enviado_por: userId,
        status: "erro",
        erro_mensagem: smtpConfigError(),
      });
      return new Response(
        JSON.stringify({ error: smtpConfigError() }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const resultados: EnvioResultado[] = [];
    const calcCache = new Map<string, Awaited<ReturnType<typeof fetchCalculoLiquidez>>>();
    const classeCache = new Map<string, string>();

    for (const { fundo, tipo } of candidatos) {
      const cnpjNorm = normalizeCnpj(fundo.fundo_cnpj);
      const fundoIsin = fundo.fundo_isin?.trim() || null;
      const fundoKey = `${cnpjNorm}|${fundoIsin ?? ""}`;
      const nomeFundo = fundo.nome_comercial ?? fundo.fundo_cnpj;

      if (origem === "auto") {
        const { data: existente } = await supabase
          .from("envios_notificacao_liquidez")
          .select("id")
          .eq("data_referencia", dtposicao)
          .eq("fundo_cnpj", cnpjNorm)
          .eq("tipo_limite", tipo)
          .eq("origem", "auto")
          .maybeSingle();

        if (existente) {
          console.log(
            `[send-liquidez-notification] Já enviado auto ${tipo} ${cnpjNorm} ${dtposicao} — ignorando`,
          );
          resultados.push({
            fundo_cnpj: cnpjNorm,
            nome_fundo: nomeFundo,
            tipo_limite: tipo,
            status: "ignorado",
          });
          continue;
        }
      }

      if (!classeCache.has(cnpjNorm)) {
        classeCache.set(cnpjNorm, await inferClasseAnbima(supabase, cnpjNorm, nomeFundo));
      }
      const classe = classeCache.get(cnpjNorm)!;

      if (!calcCache.has(fundoKey)) {
        calcCache.set(
          fundoKey,
          await fetchCalculoLiquidez(
            SUPABASE_URL,
            SUPABASE_SERVICE_ROLE_KEY,
            cnpjNorm,
            dtposicao,
            classe,
            fundoIsin,
          ),
        );
      }

      const calcData = calcCache.get(fundoKey) ?? null;

      let excelBase64 = "";
      let excelFilename = `Liquidez_${cnpjNorm}_${dtposicao}.xlsx`;
      try {
        const generated = await buildLiquidezFundoExcel({
          supabase,
          supabaseUrl: SUPABASE_URL,
          serviceKey: SUPABASE_SERVICE_ROLE_KEY,
          nomeFundo,
          fundoCnpj: cnpjNorm,
          fundoIsin,
          dtposicao,
          tipoLimite: tipo,
          classe,
          calc: calcData,
        });
        excelBase64 = generated.base64;
        excelFilename = generated.filename;
      } catch (excelErr) {
        const errText = excelErr instanceof Error ? excelErr.message : String(excelErr);
        console.warn(
          `[send-liquidez-notification] Excel omitido (${tipo}/${cnpjNorm}): ${errText}`,
        );
      }

      const attachments: Array<{ filename: string; content: string }> = [];
      let htmlContent = buildHtmlFundo(fundo, dataFormatada, tipo, { comAnexo: false });

      if (excelBase64 && excelBase64.length <= MAX_ATTACHMENT_BASE64_CHARS) {
        attachments.push({ filename: excelFilename, content: excelBase64 });
        htmlContent = buildHtmlFundo(fundo, dataFormatada, tipo, { comAnexo: true });
      } else if (excelBase64) {
        console.warn(
          `[send-liquidez-notification] Excel omitido (${tipo}/${cnpjNorm}) — Base64 ${excelBase64.length} chars excede limite`,
        );
        htmlContent =
          `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-family:Arial,sans-serif;font-size:13px;color:#856404;">` +
          `<strong>Planilha não anexada:</strong> o arquivo excede o limite de tamanho. ` +
          `Use o botão <em>Exportar Excel</em> na plataforma.` +
          `</div>` + htmlContent;
      }

      const subject = buildSubject(nomeFundo, tipo);

      try {
        const sendResult = await sendEmailViaSmtp({
          to: destinatarios,
          subject,
          html: htmlContent,
          attachments,
        });

        const { error: logErr } = await supabase.from("envios_notificacao_liquidez").insert({
          data_referencia: dtposicao,
          fundo_cnpj: cnpjNorm,
          tipo_limite: tipo,
          qtd_violacoes: tipo === "hard" ? 1 : 0,
          qtd_fundos: 1,
          destinatarios,
          origem,
          enviado_por: userId,
          email_id: sendResult.messageId,
          status: "enviado",
        });

        if (logErr) {
          console.error(
            `[send-liquidez-notification] E-mail enviado (${tipo}/${cnpjNorm}), falha ao gravar log:`,
            logErr.message,
          );
        }

        resultados.push({
          fundo_cnpj: cnpjNorm,
          nome_fundo: nomeFundo,
          tipo_limite: tipo,
          status: "enviado",
          email_id: sendResult.messageId,
        });
      } catch (smtpErr) {
        const errText = smtpErr instanceof Error ? smtpErr.message : String(smtpErr);
        console.error(`[send-liquidez-notification] Erro SMTP (${tipo}/${cnpjNorm}):`, errText);

        await supabase.from("envios_notificacao_liquidez").insert({
          data_referencia: dtposicao,
          fundo_cnpj: cnpjNorm,
          tipo_limite: tipo,
          qtd_violacoes: tipo === "hard" ? 1 : 0,
          qtd_fundos: 1,
          destinatarios,
          origem,
          enviado_por: userId,
          status: "erro",
          erro_mensagem: errText.slice(0, 500),
        });

        resultados.push({
          fundo_cnpj: cnpjNorm,
          nome_fundo: nomeFundo,
          tipo_limite: tipo,
          status: "erro",
          erro: errText.slice(0, 200),
        });
      }
    }

    const enviados = resultados.filter((r) => r.status === "enviado");
    const ignorados = resultados.filter((r) => r.status === "ignorado");
    const erros = resultados.filter((r) => r.status === "erro");
    const qtdHard = enviados.filter((r) => r.tipo_limite === "hard").length;
    const qtdSoft = enviados.filter((r) => r.tipo_limite === "soft").length;

    console.log(
      `[send-liquidez-notification] data=${dtposicao} enviados=${enviados.length} ignorados=${ignorados.length} erros=${erros.length}`,
    );

    if (enviados.length === 0 && erros.length > 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Falha ao enviar e-mail(s) via SMTP",
          data_referencia: dtposicao,
          resultados,
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: enviados.length > 0
          ? `${enviados.length} e-mail(s) enviado(s) (${qtdSoft} Soft, ${qtdHard} Hard)`
          : ignorados.length > 0
          ? "Notificações automáticas já enviadas para esta data"
          : "Nenhum e-mail enviado",
        data_referencia: dtposicao,
        emails_enviados: enviados.length,
        emails_ignorados: ignorados.length,
        emails_erro: erros.length,
        qtd_violacoes: qtdHard,
        qtd_soft: qtdSoft,
        qtd_fundos: enviados.length,
        destinatarios_count: destinatarios.length,
        resultados,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[send-liquidez-notification] Erro:", msg);
    return new Response(
      JSON.stringify({ error: "Erro interno", details: msg }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
