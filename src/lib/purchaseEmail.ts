import type { Logger } from "pino";
import { config } from "../config.js";
import { isProductCode, products } from "./catalogue.js";
import { isMailConfigured, sendMail } from "./mailer.js";
import type { StoreProvider } from "./subscriptionReconcile.js";

/**
 * The purchase confirmation IBSi sends itself.
 *
 * The stores send their own receipt the moment a purchase goes through, and
 * that receipt is the one that counts for tax and refunds - it says so below.
 * But it carries the store's branding, not ours, and says nothing about what
 * the reader has actually bought into: which journal editions, that Insights
 * is now unlimited, where to read. This message says those things, in IBSi's
 * voice, and points at the store only for the money side.
 *
 * Sent for a first purchase and for a change of plan, never for a renewal:
 * a renewal is the store's business and a monthly "you are still subscribed"
 * from us would be noise. The caller decides which of the two this is.
 */

export type PurchaseEmailInput = {
  /** Where the reader's subscription period ends, as the store reports it. */
  currentEnd: Date | null;
  environment: "sandbox" | "production";
  /** The billing interval as the plan row spells it: "monthly" or "yearly". */
  interval: string | null;
  /** First purchase, or a move from another of our plans. */
  kind: "new" | "changed";
  /** The plan row's name, e.g. "IBSi Journal India - Annual". */
  planName: string;
  productCode: string;
  provider: StoreProvider;
  readerName: string | null;
  to: string;
};

const editionLabels = { india: "India", global: "Global" } as const;

/** "the App Store" / "Google Play": who took the money and holds the receipt. */
function storeName(provider: StoreProvider): string {
  return provider === "apple" ? "the App Store" : "Google Play";
}

/** Where the reader manages or cancels, in the words each store uses. */
function manageInstructions(provider: StoreProvider): string {
  return provider === "apple"
    ? "To change or cancel your plan, open Settings on your iPhone or iPad, tap your name, then Subscriptions."
    : "To change or cancel your plan, open the Play Store app, tap your profile picture, then Payments & subscriptions, then Subscriptions.";
}

function formatDate(value: Date | null): string | null {
  if (!value) return null;
  return value.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildPurchaseEmail(input: PurchaseEmailInput): { html: string; subject: string; text: string } {
  const product = isProductCode(input.productCode) ? products[input.productCode] : null;
  const editions = product ? product.editions.map((edition) => editionLabels[edition]) : [];
  const editionLine =
    editions.length === 2
      ? "the India and Global editions of the IBSi FinTech Journal"
      : editions.length === 1
        ? `the ${editions[0]} edition of the IBSi FinTech Journal`
        : "the IBSi FinTech Journal";
  const periodWord = input.interval?.toLowerCase() === "yearly" ? "year" : "month";
  const renewsOn = formatDate(input.currentEnd);
  const store = storeName(input.provider);
  const greeting = input.readerName ? `Hello ${input.readerName},` : "Hello,";
  const subject =
    (input.environment === "sandbox" ? "[Test] " : "") +
    (input.kind === "changed" ? "Your IBSi plan has changed" : "Welcome to IBSi FinTech Journal");

  const opening =
    input.kind === "changed"
      ? `Your IBSi subscription is now ${input.planName}.`
      : `Thank you for subscribing. Your plan is ${input.planName}.`;

  const includes = [
    `${editionLine}, every issue from the month you joined onwards${periodWord === "year" ? ", plus the full archive" : ""}`,
    "unlimited reading on the Insights tab: analyst opinions, case studies, leadership interviews, podcasts and videos"
  ];

  const renewal = renewsOn
    ? `Your subscription renews every ${periodWord} through ${store}; the current period runs to ${renewsOn}.`
    : `Your subscription renews every ${periodWord} through ${store}.`;

  const receiptNote = `${store} has taken the payment and sent you its own receipt, which is the one to keep for your records.`;
  const manage = manageInstructions(input.provider);
  const support = `If anything is not as you expect, write to ${config().SUPPORT_EMAIL} and we will put it right.`;
  const testNote =
    input.environment === "sandbox"
      ? "This was a test purchase in the store's sandbox. No money was taken."
      : null;

  const textLines = [
    greeting,
    "",
    opening,
    "",
    "Your subscription includes:",
    ...includes.map((line) => `- ${line}`),
    "",
    renewal,
    receiptNote,
    "",
    manage,
    "",
    "Open the IBSi app and go to Exclusive to start reading.",
    "",
    support,
    ...(testNote ? ["", testNote] : []),
    "",
    "IBS Intelligence",
    "ibsintelligence.com"
  ];

  const paragraph = (value: string) =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#1f2937;">${escapeHtml(value)}</p>`;

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr><td style="background:#005895;padding:20px 28px;">
            <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:0.5px;">IBSi</span>
            <span style="font-size:14px;color:#dbeafe;margin-left:8px;">FinTech Journal</span>
          </td></tr>
          <tr><td style="padding:28px;">
            ${paragraph(greeting)}
            ${paragraph(opening)}
            <p style="margin:0 0 8px;font-size:16px;line-height:24px;color:#1f2937;font-weight:700;">Your subscription includes</p>
            <ul style="margin:0 0 16px;padding-left:20px;font-size:16px;line-height:24px;color:#1f2937;">
              ${includes.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}
            </ul>
            ${paragraph(renewal)}
            ${paragraph(receiptNote)}
            ${paragraph(manage)}
            ${paragraph("Open the IBSi app and go to Exclusive to start reading.")}
            ${paragraph(support)}
            ${testNote ? `<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#b45309;">${escapeHtml(testNote)}</p>` : ""}
          </td></tr>
          <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;font-size:13px;line-height:20px;color:#6b7280;">
            IBS Intelligence &middot; <a href="https://ibsintelligence.com" style="color:#005895;">ibsintelligence.com</a>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  return { html, subject, text: textLines.join("\n") };
}

/**
 * Sends the confirmation and never throws: the purchase is already verified
 * and granted by the time this runs, and a mail failure must not turn a
 * successful purchase into an error on the reader's screen. Failures are
 * logged with the subscription so support can resend by hand.
 */
export async function sendPurchaseConfirmation(
  input: PurchaseEmailInput,
  log: Logger,
  subscriptionId: string
): Promise<void> {
  if (!isMailConfigured()) {
    log.warn({ subscription_id: subscriptionId }, "purchase email skipped: SMTP not configured");
    return;
  }
  try {
    const mail = buildPurchaseEmail(input);
    await sendMail({ html: mail.html, subject: mail.subject, text: mail.text, to: input.to });
    log.info({ subscription_id: subscriptionId, kind: input.kind }, "purchase email sent");
  } catch (error) {
    log.error({ err: error, subscription_id: subscriptionId }, "purchase email failed");
  }
}
