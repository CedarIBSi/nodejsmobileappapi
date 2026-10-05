import { config } from "../config.js";
import { query } from "../db/pool.js";
import { isProductCode, products } from "./catalogue.js";
import { isMailConfigured, sendMail } from "./mailer.js";
import { isActiveStoreStatus, type StoreProvider } from "./subscriptionReconcile.js";

/**
 * The subscription emails IBSi sends itself.
 *
 * The stores send their own receipt the moment a purchase goes through, and
 * their own notices when a card fails or a subscription is cancelled; those
 * are the ones that count for tax and refunds, and each message below says so.
 * But they carry the store's branding, not ours, and say nothing about what
 * the reader has actually bought into - which journal editions, that
 * Insights is now unlimited, where to read. These say those things, in
 * IBSi's voice, and point at the store only for the money side.
 *
 * Four moments, decided by `emailKindFor` from how the subscription row
 * changed, so each is sent once however many times the same state is
 * reported (the app verifies a purchase twice within a second and again on
 * every restore; a store can redeliver a notification):
 *
 * - `new`: a plan recorded for the first time.
 * - `changed`: a move to another of our plans, in the app or in the store.
 * - `cancelled`: auto-renew switched off while the paid period still runs.
 *   Google reports this as a state; Apple does not - an Apple reader's
 *   subscription stays "active" until it expires, so they get `ended` only.
 * - `ended`: expired, or refunded. Not sent after `cancelled`, which already
 *   named the end date.
 *
 * Renewals send nothing: a monthly "you are still subscribed" would be noise.
 */

export type SubscriptionEmailKind = "new" | "changed" | "cancelled" | "ended";

/** How a subscription row changed in one reconcile: the stored state before, the store's state now. */
export type SubscriptionTransition = {
  currentEnd: Date | null;
  environment: "sandbox" | "production";
  planId: string;
  /** The plan the row carried before, or null when the row was just created. */
  previousPlanId: string | null;
  /** The status the row carried before, or null when the row was just created. */
  previousStatus: string | null;
  provider: StoreProvider;
  status: string;
  subscriptionId: string;
  userId: string;
};

const endedStatuses = new Set(["expired", "revoked"]);

export function emailKindFor(transition: SubscriptionTransition): SubscriptionEmailKind | null {
  const { planId, previousPlanId, previousStatus, status } = transition;
  const grantsAccess = isActiveStoreStatus(status) && status !== "canceled";

  if (grantsAccess && !previousPlanId) return "new";
  if (grantsAccess && planId !== previousPlanId) return "changed";
  // A cancellation on a row we did not have is a restore of an old purchase,
  // not news; and a repeat of the same state is not news either.
  if (status === "canceled" && previousStatus && previousStatus !== "canceled") return "cancelled";
  if (
    endedStatuses.has(status) &&
    previousStatus &&
    !endedStatuses.has(previousStatus) &&
    previousStatus !== "canceled"
  ) {
    return "ended";
  }
  return null;
}

export type SubscriptionEmailInput = {
  /** Where the reader's subscription period ends, as the store reports it. */
  currentEnd: Date | null;
  environment: "sandbox" | "production";
  /** The billing interval as the plan row spells it: "monthly" or "yearly". */
  interval: string | null;
  kind: SubscriptionEmailKind;
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

/** Where the reader manages, cancels or resumes, in the words each store uses. */
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

type Section = { kind: "paragraph"; text: string } | { kind: "list"; heading: string; items: string[] } | { kind: "note"; text: string };

export function buildSubscriptionEmail(input: SubscriptionEmailInput): { html: string; subject: string; text: string } {
  const product = isProductCode(input.productCode) ? products[input.productCode] : null;
  const editions = product ? product.editions.map((edition) => editionLabels[edition]) : [];
  const editionLine =
    editions.length === 2
      ? "the India and Global editions of the IBSi FinTech Journal"
      : editions.length === 1
        ? `the ${editions[0]} edition of the IBSi FinTech Journal`
        : "the IBSi FinTech Journal";
  const periodWord = input.interval?.toLowerCase() === "yearly" ? "year" : "month";
  const periodEnd = formatDate(input.currentEnd);
  const store = storeName(input.provider);
  const greeting = input.readerName ? `Hello ${input.readerName},` : "Hello,";
  const support = `If anything is not as you expect, write to ${config().SUPPORT_EMAIL} and we will put it right.`;
  const testNote =
    input.environment === "sandbox" ? "This was a test purchase in the store's sandbox. No money was taken." : null;
  const includes = [
    `${editionLine}, every issue from the month you joined onwards${periodWord === "year" ? ", plus the full archive" : ""}`,
    "unlimited reading on the Insights tab: analyst opinions, case studies, leadership interviews, podcasts and videos"
  ];

  let subject: string;
  let sections: Section[];

  switch (input.kind) {
    case "new":
    case "changed": {
      subject = input.kind === "changed" ? "Your IBSi plan has changed" : "Welcome to IBSi FinTech Journal";
      sections = [
        {
          kind: "paragraph",
          text:
            input.kind === "changed"
              ? `Your IBSi subscription is now ${input.planName}.`
              : `Thank you for subscribing. Your plan is ${input.planName}.`
        },
        { kind: "list", heading: "Your subscription includes", items: includes },
        {
          kind: "paragraph",
          text: periodEnd
            ? `Your subscription renews every ${periodWord} through ${store}; the current period runs to ${periodEnd}.`
            : `Your subscription renews every ${periodWord} through ${store}.`
        },
        {
          kind: "paragraph",
          text: `${store} has taken the payment and sent you its own receipt, which is the one to keep for your records.`
        },
        { kind: "paragraph", text: manageInstructions(input.provider) },
        { kind: "paragraph", text: "Open the IBSi app and go to Exclusive to start reading." }
      ];
      break;
    }
    case "cancelled": {
      subject = "Your IBSi subscription will not renew";
      sections = [
        {
          kind: "paragraph",
          text: `We have received your cancellation of ${input.planName}. Nothing further will be charged.`
        },
        {
          kind: "paragraph",
          text: periodEnd
            ? `You keep everything you have paid for until ${periodEnd}: ${editionLine}, and unlimited reading on Insights.`
            : `You keep everything you have paid for until the end of the current period: ${editionLine}, and unlimited reading on Insights.`
        },
        {
          kind: "paragraph",
          text: periodEnd
            ? `Changed your mind? Turn auto-renew back on in ${store} before ${periodEnd} and nothing is interrupted, or subscribe again at any time from the app's Exclusive tab.`
            : `Changed your mind? Turn auto-renew back on in ${store} and nothing is interrupted, or subscribe again at any time from the app's Exclusive tab.`
        },
        { kind: "paragraph", text: "We would be glad to know what we could have done better - just reply to this email." }
      ];
      break;
    }
    case "ended": {
      subject = "Your IBSi subscription has ended";
      sections = [
        {
          kind: "paragraph",
          text: periodEnd
            ? `Your ${input.planName} subscription ended on ${periodEnd}.`
            : `Your ${input.planName} subscription has ended.`
        },
        {
          kind: "paragraph",
          text: "The journal is closed to your account from now on, and Insights goes back to five free reads a month. Everything you saved in your library is still there."
        },
        {
          kind: "paragraph",
          text: "To pick up where you left off, open the IBSi app, go to Exclusive and choose a plan. Your journal archive starts again from the month you rejoin."
        },
        {
          kind: "paragraph",
          text: `Receipts, refunds and payment questions are handled by ${store}, which billed the subscription.`
        }
      ];
      break;
    }
  }

  sections.push({ kind: "paragraph", text: support });
  if (testNote) sections.push({ kind: "note", text: testNote });
  if (input.environment === "sandbox") subject = `[Test] ${subject}`;

  const textLines: string[] = [greeting, ""];
  for (const section of sections) {
    if (section.kind === "list") {
      textLines.push(`${section.heading}:`, ...section.items.map((item) => `- ${item}`), "");
    } else {
      textLines.push(section.text, "");
    }
  }
  textLines.push("IBS Intelligence", "ibsintelligence.com");

  const paragraph = (value: string) =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#1f2937;">${escapeHtml(value)}</p>`;
  const body = sections
    .map((section) => {
      if (section.kind === "list") {
        return (
          `<p style="margin:0 0 8px;font-size:16px;line-height:24px;color:#1f2937;font-weight:700;">${escapeHtml(section.heading)}</p>` +
          `<ul style="margin:0 0 16px;padding-left:20px;font-size:16px;line-height:24px;color:#1f2937;">` +
          section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("") +
          `</ul>`
        );
      }
      if (section.kind === "note") {
        return `<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#b45309;">${escapeHtml(section.text)}</p>`;
      }
      return paragraph(section.text);
    })
    .join("\n            ");

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
            ${body}
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

/** The structural part of pino's Logger these functions use, so a caller without a request logger can pass console. */
export type SubscriptionEmailLog = {
  error(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
};

/**
 * Sends whichever email the transition calls for, if any, and never throws:
 * by the time this runs the subscription is already reconciled, and a mail
 * failure must not turn a successful purchase, or a webhook delivery, into an
 * error. Loads the reader and the plan itself, so callers hand over only what
 * they already hold; meant to run after the caller's transaction has
 * committed. Failures are logged with the subscription so support can resend
 * by hand.
 */
export async function notifySubscriptionChange(
  transition: SubscriptionTransition,
  log: SubscriptionEmailLog
): Promise<void> {
  const kind = emailKindFor(transition);
  if (!kind) return;
  const context = { kind, subscription_id: transition.subscriptionId };

  if (!isMailConfigured()) {
    log.warn(context, "subscription email skipped: SMTP not configured");
    return;
  }

  try {
    const [reader, plan] = await Promise.all([
      query<{ display_name: string | null; email: string | null }>(
        "SELECT email, display_name FROM app_users WHERE id = $1",
        [transition.userId]
      ),
      query<{ interval: string | null; name: string; product_code: string }>(
        `SELECT name, product_code, "interval" FROM subscription_plans WHERE id = $1`,
        [transition.planId]
      )
    ]);
    const to = reader.rows[0]?.email;
    const planRow = plan.rows[0];
    if (!to || !planRow) {
      log.warn(context, "subscription email skipped: no reader email or plan");
      return;
    }

    const mail = buildSubscriptionEmail({
      currentEnd: transition.currentEnd,
      environment: transition.environment,
      interval: planRow.interval,
      kind,
      planName: planRow.name,
      productCode: planRow.product_code,
      provider: transition.provider,
      readerName: reader.rows[0]?.display_name ?? null,
      to
    });
    await sendMail({ html: mail.html, subject: mail.subject, text: mail.text, to });
    log.info(context, "subscription email sent");
  } catch (error) {
    log.error({ ...context, err: error }, "subscription email failed");
  }
}
