/**
 * Envio de e-mail via SMTP (Microsoft 365 / Exchange Online).
 * Copie este arquivo para cada edge function que envia e-mail (funções autocontidas).
 */

import nodemailer from "npm:nodemailer@6.9.15";

export interface EmailAttachment {
  filename: string;
  content: string; // Base64
}

export interface SendEmailOptions {
  to: string[];
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

export function getSmtpConfig(): SmtpConfig | null {
  const host = Deno.env.get("SMTP_HOST")?.trim();
  const user = Deno.env.get("SMTP_USER")?.trim();
  const password = Deno.env.get("SMTP_PASSWORD");
  const from =
    Deno.env.get("EMAIL_FROM")?.trim() ??
    "Hub Risco <noreply@quadranteinvestimentos.com.br>";
  const port = Number(Deno.env.get("SMTP_PORT") ?? "587");

  if (!host || !user || !password) return null;

  return { host, port, user, password, from };
}

export function smtpConfigError(): string {
  return "SMTP não configurado — defina SMTP_HOST, SMTP_USER e SMTP_PASSWORD nas secrets da Edge Function";
}

/** Limite conservador para anexo Base64 (~25 MB decodificado). */
export const MAX_ATTACHMENT_BASE64_CHARS = 35 * 1024 * 1024;

export async function sendEmailViaSmtp(
  options: SendEmailOptions,
): Promise<{ messageId: string }> {
  const config = getSmtpConfig();
  if (!config) throw new Error(smtpConfigError());

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: {
      user: config.user,
      pass: config.password,
    },
  });

  const info = await transporter.sendMail({
    from: config.from,
    to: options.to.join(", "),
    subject: options.subject,
    html: options.html,
    attachments: (options.attachments ?? []).map((a) => ({
      filename: a.filename,
      content: a.content,
      encoding: "base64",
    })),
  });

  return { messageId: info.messageId ?? "smtp-sent" };
}
