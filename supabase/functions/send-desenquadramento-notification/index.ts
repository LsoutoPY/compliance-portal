/**
 * Edge Function: Notificação de Desenquadramento por E-mail
 *
 * POST /send-desenquadramento-notification
 *
 * Body:
 * {
 *   "fundo_dtposicao"?: "20260720",   // se ausente, usa a maior data em enquadramento_resultado
 *   "origem": "auto" | "manual"       // auto = cron, manual = usuário via UI
 * }
 *
 * Fluxo:
 *   1. Busca violações em enquadramento_resultado (status='violacao') para a data
 *   2. Se origem='auto', verifica duplicidade no log (índice único por data/auto)
 *   3. Busca destinatários ativos em email_destinatarios WHERE tipo='desenquadramento'
 *   4. Monta HTML de notificação
 *   5. Envia via SMTP (Microsoft 365)
 *   6. Grava log em envios_notificacao_desenquadramento
 *
 * Secrets: SMTP_HOST, SMTP_USER, SMTP_PASSWORD, SMTP_PORT (opcional), EMAIL_FROM (opcional)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { buildDesenquadramentoExcel } from "./excel.ts";
import { getSmtpConfig, MAX_ATTACHMENT_BASE64_CHARS, sendEmailViaSmtp, smtpConfigError } from "./smtp.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface NotificacaoRequest {
  fundo_dtposicao?: string;
  fundo_cnpj?: string;
  fundo_isin?: string;
  nome_fundo?: string;
  excel_base64?: string;
  excel_filename?: string;
  origem?: "auto" | "manual";
}

interface Violacao {
  fundo_cnpj: string;
  fundo_isin: string;
  fundo_dtposicao: string;
  regra_codigo: string;
  regra_descricao: string | null;
  regra_categoria: string;
  valor_atual: number | null;
  valor_limite: number | null;
  nome_comercial?: string | null;
}

function formatBRL(valor: number | null): string {
  if (valor === null || valor === undefined) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(valor);
}

function formatPct(valor: number | null): string {
  if (valor === null || valor === undefined) return "—";
  return `${(valor * 100).toFixed(2)}%`;
}

function formatValor(valor: number | null, categoria: string): string {
  if (valor === null || valor === undefined) return "—";
  if (categoria === "pl") return formatBRL(valor);
  return formatPct(valor);
}

function formatDataBR(dtposicao: string): string {
  // YYYYMMDD → DD/MM/YYYY
  if (!dtposicao || dtposicao.length !== 8) return dtposicao;
  return `${dtposicao.slice(6, 8)}/${dtposicao.slice(4, 6)}/${dtposicao.slice(0, 4)}`;
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

function categoriaLabel(cat: string): string {
  const map: Record<string, string> = {
    pl: "Patrimônio Líquido",
    classe: "Classe",
    liquidity: "Liquidez",
    concentration: "Concentração",
    tributario: "Tributário",
    relacional: "Relacional",
    "fidc-estrutura": "FIDC Estrutura",
    "fidc-concentracao": "Concentração FIDC",
  };
  return map[cat] ?? cat;
}

const SYSTEM_NAME = "Hub Risco";

function normalizeCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, "").padStart(14, "0");
}

function fundPairKey(cnpj: string, isin?: string | null): string {
  return `${normalizeCnpj(cnpj)}|${isin ?? ""}`;
}

/** Mesma lógica da UI (EnquadramentoList): nome por par CNPJ + ISIN. */
async function enrichViolacoesComNome(
  supabase: ReturnType<typeof createClient>,
  violacoes: Violacao[],
  dtposicao: string,
): Promise<void> {
  if (violacoes.length === 0) return;

  const nomeMap = new Map<string, string>();

  const { data: pares } = await supabase.rpc("get_pares_fundo_monitorado", {
    p_dtposicao: dtposicao,
  });
  for (const p of pares ?? []) {
    const row = p as { fundo_cnpj: string; fundo_isin?: string; nome_fundo?: string };
    if (!row.fundo_cnpj || !row.nome_fundo) continue;
    nomeMap.set(fundPairKey(row.fundo_cnpj, row.fundo_isin), row.nome_fundo);
  }

  const cnpjsNorm = [...new Set(violacoes.map((v) => normalizeCnpj(v.fundo_cnpj)))];
  const cnpjsQuery = [...new Set([
    ...violacoes.map((v) => v.fundo_cnpj),
    ...cnpjsNorm,
  ])];
  const { data: posRows } = await supabase
    .from("posicao_carteira")
    .select("fundo_cnpj, fundo_isin, nome_fundo, fundo_nome")
    .eq("fundo_dtposicao", dtposicao)
    .in("fundo_cnpj", cnpjsQuery);

  for (const row of posRows ?? []) {
    const nome = (row.nome_fundo ?? row.fundo_nome ?? "").trim();
    if (!nome || !row.fundo_cnpj) continue;
    const key = fundPairKey(row.fundo_cnpj, row.fundo_isin);
    if (!nomeMap.has(key)) nomeMap.set(key, nome);
  }

  const isins = [...new Set(violacoes.map((v) => v.fundo_isin).filter(Boolean))];
  if (isins.length > 0) {
    const { data: fundosData } = await supabase
      .from("fundos_caracteristicas")
      .select("cnpj_fundo, cnpj_classe, nome_comercial, isin")
      .or(cnpjsNorm.map((c) => `cnpj_fundo.eq.${c},cnpj_classe.eq.${c}`).join(","));

    for (const v of violacoes) {
      if (v.nome_comercial) continue;
      const key = fundPairKey(v.fundo_cnpj, v.fundo_isin);
      if (nomeMap.has(key)) continue;

      const cnpjNorm = normalizeCnpj(v.fundo_cnpj);
      const isinNorm = (v.fundo_isin ?? "").toUpperCase().trim();
      const candidates = (fundosData ?? []).filter((f) => {
        const fc = normalizeCnpj(f.cnpj_fundo ?? f.cnpj_classe ?? "");
        return fc === cnpjNorm;
      });

      if (isinNorm) {
        const byIsin = candidates.find(
          (f) => String(f.isin ?? "").toUpperCase().trim() === isinNorm,
        );
        if (byIsin?.nome_comercial) {
          nomeMap.set(key, byIsin.nome_comercial);
        }
      }
    }
  }

  for (const v of violacoes) {
    const key = fundPairKey(v.fundo_cnpj, v.fundo_isin);
    v.nome_comercial =
      nomeMap.get(key) ??
      (v.fundo_isin ? null : nomeMap.get(fundPairKey(v.fundo_cnpj, ""))) ??
      null;
  }
}

function buildHtml(
  violacoes: Violacao[],
  dataFormatada: string,
  qtdFundos: number,
  opts?: { nomeFundo?: string | null; comAnexo?: boolean },
): string {
  // Agrupa por fundo
  const byFundo = new Map<string, Violacao[]>();
  for (const v of violacoes) {
    const key = `${v.fundo_cnpj}|${v.fundo_isin}`;
    if (!byFundo.has(key)) byFundo.set(key, []);
    byFundo.get(key)!.push(v);
  }

  const fundoBlocks = [...byFundo.entries()]
    .map(([, vitems]) => {
      const nome = vitems[0].nome_comercial ?? vitems[0].fundo_cnpj;
      const isin = vitems[0].fundo_isin;
      const cnpj = vitems[0].fundo_cnpj;

      const rows = vitems
        .map(
          (v, idx) => `
          <tr style="background:${idx % 2 === 0 ? "#ffffff" : "#fafafa"};">
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;font-family:Consolas,Monaco,monospace;color:#374151;">${v.regra_codigo}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;">${categoriaLabel(v.regra_categoria)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#4b5563;line-height:1.4;">${v.regra_descricao ?? "—"}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;text-align:right;font-weight:700;color:#dc2626;">${formatValor(v.valor_atual, v.regra_categoria)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;text-align:right;color:#374151;">${formatValor(v.valor_limite, v.regra_categoria)}</td>
          </tr>`,
        )
        .join("");

      return `
        <div style="margin-bottom:20px;border:1px solid #fecaca;border-radius:10px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04);">
          <div style="background:linear-gradient(90deg,#fef2f2 0%,#fff5f5 100%);border-left:4px solid #dc2626;padding:14px 18px;">
            <div style="font-weight:700;font-size:15px;color:#111827;letter-spacing:-0.01em;">${nome}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:4px;font-family:Consolas,Monaco,monospace;">
              CNPJ ${cnpj}${isin ? ` · ISIN ${isin}` : ""}
            </div>
          </div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <thead>
              <tr style="background:#f3f4f6;">
                <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.03em;">Código</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.03em;">Categoria</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.03em;">Descrição</th>
                <th style="padding:10px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.03em;">Valor Atual</th>
                <th style="padding:10px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.03em;">Limite</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>`;
    })
    .join("");

  const fundoLabel = opts?.nomeFundo?.trim();
  const contextoFundo = fundoLabel ? ` do fundo <strong>${fundoLabel}</strong>` : "";
  const introFundos = fundoLabel && qtdFundos === 1
    ? " — detalhamento abaixo."
    : ` em <strong>${qtdFundos}</strong> fundo(s) — detalhamento por fundo abaixo.`;
  const anexoLine = opts?.comAnexo
    ? "<br/><br/>Segue em anexo a planilha de enquadramento."
    : "";

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Alerta de Desenquadramento — ${dataFormatada}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">

          <!-- Header (bgcolor para compatibilidade Outlook) -->
          <tr>
            <td bgcolor="#1F4E3D" style="background-color:#1F4E3D;padding:24px 32px;">
              <div style="color:#ffffff;font-size:22px;font-weight:700;line-height:1.3;">
                Alerta de Desenquadramento
              </div>
            </td>
          </tr>

          <!-- Abertura -->
          <tr>
            <td style="padding:24px 32px 0;">
              <div style="font-size:14px;color:#111827;line-height:1.6;">
                Srs, ${saudacaoPorHorario()}!<br/><br/>
                Segue o resultado do monitoramento de enquadramento${contextoFundo} com data-base de
                <strong>${dataFormatada}</strong>. Foram identificadas
                <strong>${violacoes.length}</strong> violação(ões)${introFundos}
                Por favor, verificar e retornar com o plano de ação.${anexoLine}
              </div>
            </td>
          </tr>

          <!-- Resumo -->
          <tr>
            <td style="padding:24px 32px 0;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:16px 20px;">
                    <div style="font-size:13px;color:#6b7280;">Data de referência</div>
                    <div style="font-size:22px;font-weight:700;color:#dc2626;margin-top:4px;">${dataFormatada}</div>
                    <div style="font-size:13px;color:#374151;margin-top:8px;">
                      <strong>${violacoes.length}</strong> violação(ões) encontrada(s) em
                      <strong>${qtdFundos}</strong> fundo(s)
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Violações por fundo -->
          <tr>
            <td style="padding:24px 32px;">
              <div style="font-size:16px;font-weight:700;color:#111827;margin-bottom:16px;">
                Violações por Fundo
              </div>
              ${fundoBlocks}
            </td>
          </tr>

          <!-- Rodapé -->
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const body: NotificacaoRequest = await req.json().catch(() => ({}));
    const origem = body.origem ?? "manual";

    // ── Autenticação ──────────────────────────────────────────────────────────
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

    // ── Resolver data de referência ───────────────────────────────────────────
    let dtposicao = body.fundo_dtposicao?.trim();
    if (!dtposicao) {
      const { data: maxData } = await supabase
        .from("enquadramento_resultado")
        .select("fundo_dtposicao")
        .eq("status", "violacao")
        .order("fundo_dtposicao", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!maxData?.fundo_dtposicao) {
        return new Response(
          JSON.stringify({
            success: true,
            message: "Nenhuma violação encontrada em enquadramento_resultado",
            status: "sem_violacoes",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      dtposicao = maxData.fundo_dtposicao;
    }

    // ── Verificar duplicidade (auto) ──────────────────────────────────────────
    if (origem === "auto") {
      const { data: existente } = await supabase
        .from("envios_notificacao_desenquadramento")
        .select("id")
        .eq("data_referencia", dtposicao)
        .eq("origem", "auto")
        .maybeSingle();

      if (existente) {
        console.log(`[send-desenquadramento-notification] Notificação auto já enviada para ${dtposicao} — ignorando`);
        return new Response(
          JSON.stringify({
            success: true,
            message: "Notificação automática já enviada para esta data",
            data_referencia: dtposicao,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // ── Buscar violações ──────────────────────────────────────────────────────
    let violQuery = supabase
      .from("enquadramento_resultado")
      .select("fundo_cnpj, fundo_isin, fundo_dtposicao, regra_codigo, regra_descricao, regra_categoria, valor_atual, valor_limite")
      .eq("fundo_dtposicao", dtposicao)
      .eq("status", "violacao");

    if (body.fundo_cnpj?.trim()) {
      violQuery = violQuery.eq("fundo_cnpj", body.fundo_cnpj.trim());
      if (body.fundo_isin != null && body.fundo_isin !== "") {
        violQuery = violQuery.eq("fundo_isin", body.fundo_isin);
      }
    }

    const { data: violacoesRaw, error: violErr } = await violQuery
      .order("fundo_cnpj")
      .order("regra_categoria");

    if (violErr) throw new Error(`Erro ao buscar violações: ${violErr.message}`);

    const violacoes: Violacao[] = violacoesRaw ?? [];

    // Enriquecer com nome do fundo (CNPJ + ISIN — mesma fonte da UI)
    await enrichViolacoesComNome(supabase, violacoes, dtposicao);

    const qtdFundos = new Set(violacoes.map((v) => `${v.fundo_cnpj}|${v.fundo_isin}`)).size;
    const dataFormatada = formatDataBR(dtposicao);

    // ── Buscar destinatários ativos ───────────────────────────────────────────
    const { data: destinatariosData } = await supabase
      .from("email_destinatarios")
      .select("email")
      .eq("tipo", "desenquadramento")
      .eq("ativo", true);

    const destinatarios = (destinatariosData ?? []).map((d) => d.email).filter(Boolean);

    // ── Sem violações → gravar log e retornar ─────────────────────────────────
    if (violacoes.length === 0) {
      await supabase.from("envios_notificacao_desenquadramento").insert({
        data_referencia: dtposicao,
        qtd_violacoes: 0,
        qtd_fundos: 0,
        destinatarios,
        origem,
        enviado_por: userId,
        status: "sem_violacoes",
      });
      return new Response(
        JSON.stringify({
          success: true,
          message: "Nenhuma violação para a data informada — e-mail não enviado",
          data_referencia: dtposicao,
          status: "sem_violacoes",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Sem destinatários cadastrados ─────────────────────────────────────────
    if (destinatarios.length === 0) {
      console.warn("[send-desenquadramento-notification] Nenhum destinatário cadastrado para tipo=desenquadramento");
      return new Response(
        JSON.stringify({
          success: false,
          error: "Nenhum destinatário cadastrado para notificação de desenquadramento",
          qtd_violacoes: violacoes.length,
          qtd_fundos: qtdFundos,
        }),
        {
          status: 422,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ── Verificar SMTP ────────────────────────────────────────────────────────
    if (!getSmtpConfig()) {
      await supabase.from("envios_notificacao_desenquadramento").insert({
        data_referencia: dtposicao,
        qtd_violacoes: violacoes.length,
        qtd_fundos: qtdFundos,
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

    // ── Montar e enviar e-mail ────────────────────────────────────────────────
    const isNotificacaoFundo = Boolean(body.fundo_cnpj?.trim());
    const nomeFundoCtx = body.nome_fundo?.trim() ||
      violacoes.find((v) => v.nome_comercial)?.nome_comercial ||
      null;

    let excelBase64 = body.excel_base64?.trim() || null;
    let excelFilename = body.excel_filename?.trim() || null;

    if (!excelBase64) {
      try {
        const generated = await buildDesenquadramentoExcel(supabase, violacoes, dtposicao, {
          nomeFundo: isNotificacaoFundo ? nomeFundoCtx : null,
          fundoCnpj: body.fundo_cnpj?.trim() || null,
          fundoIsin: body.fundo_isin ?? null,
        });
        excelBase64 = generated.base64;
        excelFilename = generated.filename;
      } catch (excelErr) {
        const errText = excelErr instanceof Error ? excelErr.message : String(excelErr);
        console.warn(`[send-desenquadramento-notification] Excel omitido: ${errText}`);
      }
    }

    const subject = isNotificacaoFundo && nomeFundoCtx
      ? `Alerta de Desenquadramento — ${nomeFundoCtx} — ${dataFormatada} (${violacoes.length} violação(ões))`
      : `Alerta de Desenquadramento — ${dataFormatada} (${violacoes.length} violação(ões))`;

    const attachments: Array<{ filename: string; content: string }> = [];
    let htmlContent = buildHtml(violacoes, dataFormatada, qtdFundos, {
      nomeFundo: isNotificacaoFundo ? nomeFundoCtx : null,
      comAnexo: false,
    });

    if (excelBase64) {
      if (excelBase64.length <= MAX_ATTACHMENT_BASE64_CHARS) {
        attachments.push({
          filename: excelFilename || `Enquadramento_${dtposicao}.xlsx`,
          content: excelBase64,
        });
        htmlContent = buildHtml(violacoes, dataFormatada, qtdFundos, {
          nomeFundo: isNotificacaoFundo ? nomeFundoCtx : null,
          comAnexo: true,
        });
      } else {
        console.warn(
          `[send-desenquadramento-notification] Excel omitido — Base64 ${excelBase64.length} chars excede limite`,
        );
        htmlContent =
          `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-family:Arial,sans-serif;font-size:13px;color:#856404;">` +
          `<strong>Planilha não anexada:</strong> o arquivo excede o limite de tamanho. ` +
          `Use o botão <em>Exportar Excel</em> na plataforma.` +
          `</div>` + htmlContent;
      }
    }

    let sendResult: { messageId: string };
    try {
      sendResult = await sendEmailViaSmtp({
        to: destinatarios,
        subject,
        html: htmlContent,
        attachments,
      });
    } catch (smtpErr) {
      const errText = smtpErr instanceof Error ? smtpErr.message : String(smtpErr);
      console.error("[send-desenquadramento-notification] Erro SMTP:", errText);
      await supabase.from("envios_notificacao_desenquadramento").insert({
        data_referencia: dtposicao,
        qtd_violacoes: violacoes.length,
        qtd_fundos: qtdFundos,
        destinatarios,
        origem,
        enviado_por: userId,
        status: "erro",
        erro_mensagem: errText.slice(0, 500),
      });
      return new Response(
        JSON.stringify({ error: "Falha ao enviar e-mail via SMTP", details: errText }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ── Gravar log de sucesso (não falha o envio se o log falhar) ─────────────
    const { error: logErr } = await supabase.from("envios_notificacao_desenquadramento").insert({
      data_referencia: dtposicao,
      qtd_violacoes: violacoes.length,
      qtd_fundos: qtdFundos,
      destinatarios,
      origem,
      enviado_por: userId,
      email_id: sendResult.messageId,
      status: "enviado",
    });

    if (logErr) {
      console.error(
        "[send-desenquadramento-notification] E-mail enviado, mas falha ao gravar log:",
        logErr.message,
      );
    }

    console.log(
      `[send-desenquadramento-notification] Enviado para ${destinatarios.length} destinatário(s) — data=${dtposicao} violacoes=${violacoes.length} fundos=${qtdFundos}`,
    );

    return new Response(
      JSON.stringify({
        success: true,
        message: logErr
          ? "Notificação enviada, mas o histórico não foi registrado"
          : "Notificação enviada com sucesso",
        data_referencia: dtposicao,
        qtd_violacoes: violacoes.length,
        qtd_fundos: qtdFundos,
        destinatarios_count: destinatarios.length,
        email_id: sendResult.messageId,
        log_warning: logErr?.message ?? null,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[send-desenquadramento-notification] Erro:", msg);
    return new Response(
      JSON.stringify({ error: "Erro interno", details: msg }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
