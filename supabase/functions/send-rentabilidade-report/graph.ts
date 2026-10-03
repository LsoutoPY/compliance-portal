/**
 * Envio de e-mail via Microsoft Graph API (HTTP).
 * Necessário em Supabase Edge Functions — portas SMTP (25/465/587) são bloqueadas.
 */

import type { SendEmailOptions } from "./smtp.ts";

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  sendAs: string;
}

export function getGraphConfig(): GraphConfig | null {
  const tenantId = Deno.env.get("MS_GRAPH_TENANT_ID")?.trim();
  const clientId = Deno.env.get("MS_GRAPH_CLIENT_ID")?.trim();
  const clientSecret = Deno.env.get("MS_GRAPH_CLIENT_SECRET");
  const sendAs =
    Deno.env.get("MS_GRAPH_SEND_AS")?.trim() ??
    Deno.env.get("SMTP_USER")?.trim();

  if (!tenantId || !clientId || !clientSecret || !sendAs) return null;

  return { tenantId, clientId, clientSecret, sendAs };
}

function attachmentContentType(filename: string): string {
  if (filename.endsWith(".pdf")) return "application/pdf";
  if (filename.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return "application/octet-stream";
}

async function fetchAccessToken(config: GraphConfig): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Graph token falhou (${res.status}): ${body.slice(0, 400)}`);
  }

  const data = JSON.parse(body) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Graph token: access_token ausente na resposta");
  }

  return data.access_token;
}

export async function sendEmailViaGraph(
  options: SendEmailOptions,
  config?: GraphConfig,
): Promise<{ messageId: string }> {
  const cfg = config ?? getGraphConfig();
  if (!cfg) {
    throw new Error(
      "Microsoft Graph não configurado — defina MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID e MS_GRAPH_CLIENT_SECRET",
    );
  }

  const token = await fetchAccessToken(cfg);

  const message: Record<string, unknown> = {
    subject: options.subject,
    body: {
      contentType: "HTML",
      content: options.html,
    },
    toRecipients: options.to.map((address) => ({
      emailAddress: { address },
    })),
  };

  if (options.attachments?.length) {
    message.attachments = options.attachments.map((attachment) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: attachment.filename,
      contentType: attachmentContentType(attachment.filename),
      contentBytes: attachment.content,
    }));
  }

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.sendAs)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        saveToSentItems: true,
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph sendMail falhou (${res.status}): ${text.slice(0, 500)}`);
  }

  return { messageId: `graph-${cfg.sendAs}-${Date.now()}` };
}
