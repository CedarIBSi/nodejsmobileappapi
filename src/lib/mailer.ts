import nodemailer from "nodemailer";
import { config } from "../config.js";

/**
 * Outbound email, over SMTP.
 *
 * One transport for the process, built on first use. Nothing here decides
 * whether to send: callers ask `isMailConfigured()` first and choose their
 * own fallback, because the only sender so far - the interest route - would
 * rather tell the app to open the reader's mail client than drop a lead.
 *
 * IBSi's mail is Microsoft 365, so the expected setup is SMTP AUTH on
 * smtp.office365.com:587 with STARTTLS from a mailbox licensed to send; any
 * relay that speaks SMTP works the same.
 */

type Mail = {
  /**
   * An HTML rendering of the same message, for the purchase confirmation,
   * which carries IBSi's own look. `text` stays required and is what a client
   * that refuses HTML shows, so nothing may appear in one and not the other.
   */
  html?: string;
  replyTo?: string;
  subject: string;
  text: string;
  to: string;
};

let transport: nodemailer.Transporter | null = null;

export function isMailConfigured(): boolean {
  const { SMTP_HOST, SMTP_FROM } = config();
  return Boolean(SMTP_HOST && SMTP_FROM);
}

function getTransport(): nodemailer.Transporter {
  if (transport) return transport;
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = config();
  transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
  });
  return transport;
}

/** Sends one message, plain text with an optional HTML part. Throws on any transport failure. */
export async function sendMail(mail: Mail): Promise<void> {
  await getTransport().sendMail({
    from: config().SMTP_FROM,
    html: mail.html,
    replyTo: mail.replyTo,
    subject: mail.subject,
    text: mail.text,
    to: mail.to
  });
}
