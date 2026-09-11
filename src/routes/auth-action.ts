import { Router, urlencoded } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { validate } from "../middleware/validate.js";

export const authActionRouter = Router();

/**
 * Firebase's email action handler, replaced so that nothing spends a one-time
 * code except the person the email was sent to.
 *
 * Firebase's own page redeems a verification code the moment it loads, and
 * corporate mail security loads links before the recipient does - Defender Safe
 * Links, Proofpoint and Mimecast all open URLs in a sandboxed browser to check
 * them. The scanner's visit verifies the address and burns the code, so the
 * reader arrives second and is told the link has already been used. For a
 * FinTech publication that is most of the audience.
 *
 * The fix is to stop redeeming codes on page load. Nothing here consumes a code
 * on a GET. On a phone the code is handed to the app, which redeems it through
 * the Firebase client SDK; in a desktop browser it sits in a form a person has
 * to submit. Scanners fetch pages, follow redirects and read HTML - they do not
 * open custom URL schemes and they do not submit forms, which is exactly why
 * password reset has never suffered from this and verification has.
 *
 * Reset is forwarded to Firebase untouched for that same reason: its page asks
 * for a new password and redeems nothing until the form is submitted, so it was
 * never exposed. Leaving it alone keeps the one part of this flow that already
 * works.
 *
 * Set as Authentication > Templates > customise action URL.
 */
const actionQuerySchema = z.object({
  apiKey: z.string().trim().max(200).optional(),
  continueUrl: z.string().trim().max(2048).optional(),
  lang: z.string().trim().max(16).optional(),
  mode: z.enum(["verifyEmail", "resetPassword", "recoverEmail", "verifyAndChangeEmail"]),
  oobCode: z.string().trim().min(8).max(2048)
});

const confirmBodySchema = z.object({
  apiKey: z.string().trim().min(8).max(200),
  mode: z.enum(["verifyEmail", "recoverEmail", "verifyAndChangeEmail"]),
  oobCode: z.string().trim().min(8).max(2048)
});

type ActionQuery = z.infer<typeof actionQuerySchema>;
type ConfirmBody = z.infer<typeof confirmBodySchema>;

/**
 * Modes Firebase's hosted page redeems on load, with no form in between. These
 * are the ones a scanner can consume, and the only ones this route intercepts.
 */
const autoAppliedModes = new Set(["verifyEmail", "recoverEmail", "verifyAndChangeEmail"]);

/**
 * A phone can open the app, so the code travels on to it and is redeemed there.
 * Anything else - a laptop, and most link scanners, which present themselves as
 * desktop browsers - gets the form instead. Guessing wrong is harmless in both
 * directions: a desktop offered the app link simply sees nothing happen, and a
 * phone offered the form has a button to press.
 */
const opensTheApp = (userAgent: string | undefined) =>
  /android|iphone|ipad|ipod/i.test(userAgent ?? "");

const firebaseHandlerUrl = (query: ActionQuery) => {
  const authDomain = config().FIREBASE_AUTH_DOMAIN;

  if (!authDomain) {
    throw new HttpError(503, "Authentication handler is not configured", "AUTH_HANDLER_NOT_CONFIGURED");
  }

  const target = new URL("https://" + authDomain + "/__/auth/action");
  target.searchParams.set("mode", query.mode);
  target.searchParams.set("oobCode", query.oobCode);
  if (query.apiKey) target.searchParams.set("apiKey", query.apiKey);
  if (query.continueUrl) target.searchParams.set("continueUrl", query.continueUrl);
  if (query.lang) target.searchParams.set("lang", query.lang);

  return target.toString();
};

/**
 * Where the app picks the code up. The app's handler for this path reads `mode`
 * and `oobCode`, redeems the code once and records that it did, so a replayed
 * launch intent cannot spend it twice.
 *
 * A custom scheme rather than an https link, deliberately: it reopens the app
 * without the App Links verification an https link would need, and a scanner
 * cannot follow it at all.
 */
const appHandoffUrl = (query: ActionQuery) => {
  const params = new URLSearchParams({ mode: query.mode, oobCode: query.oobCode });

  return config().MOBILE_APP_SCHEME + "://app-auth?" + params.toString();
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Self-contained markup: no scripts, no external stylesheet, no web font.
 * Helmet's default policy blocks anything this would have to fetch, and an
 * email link opens in whatever browser the reader's IT department allows, which
 * is not a place to depend on assets loading.
 */
const renderPage = (parts: { body: string; heading: string; title: string }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(parts.title)}</title>
<style>
  body { background: #f4f6f8; color: #333333; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; padding: 40px 20px; }
  .card { background: #ffffff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12); margin: 0 auto; max-width: 440px; padding: 32px; }
  .brand { color: #005895; font-size: 13px; font-weight: 700; letter-spacing: 1px; margin: 0 0 20px; text-transform: uppercase; }
  h1 { color: #005895; font-size: 22px; line-height: 1.3; margin: 0 0 12px; }
  p { font-size: 15px; line-height: 1.6; margin: 0 0 16px; }
  .muted { color: #6b7280; font-size: 13px; margin-bottom: 0; margin-top: 16px; }
  button { background: #005895; border: 0; border-radius: 8px; color: #ffffff; cursor: pointer; font-size: 16px; font-weight: 600; padding: 14px 24px; width: 100%; }
</style>
</head>
<body>
  <div class="card">
    <p class="brand">IBSi News</p>
    <h1>${escapeHtml(parts.heading)}</h1>
    ${parts.body}
  </div>
</body>
</html>
`;

/**
 * Redeems the code through Identity Toolkit.
 *
 * The Admin SDK has no applyActionCode, so this goes through the same public
 * endpoint the web SDK uses, with the same public key the link itself carries.
 * Only ever reached from a submitted form, so the outcome is the reader's own
 * and is reported to them rather than assumed.
 */
async function spendActionCode(oobCode: string, apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:update?key=" + encodeURIComponent(apiKey),
      {
        body: JSON.stringify({ oobCode }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(10_000)
      }
    );

    return response.ok;
  } catch {
    return false;
  }
}

authActionRouter.get("/", validate(actionQuerySchema, "query"), asyncHandler(async (req, res) => {
  const query = req.query as unknown as ActionQuery;
  res.set("Cache-Control", "no-store");

  // Reset needs Firebase's form, and loading that form redeems nothing.
  if (!autoAppliedModes.has(query.mode)) {
    res.redirect(302, firebaseHandlerUrl(query));
    return;
  }

  if (opensTheApp(req.get("user-agent"))) {
    res.redirect(302, appHandoffUrl(query));
    return;
  }

  /**
   * Firebase puts the project's public web key in the action link, so there is
   * nothing to configure and nothing to keep in step with a key rotation. A
   * link without one cannot be redeemed here, so it goes back to Firebase - the
   * old behaviour, scanner exposure included, but working rather than broken.
   */
  if (!query.apiKey) {
    req.log.warn("Email action link carried no apiKey; forwarding to Firebase");
    res.redirect(302, firebaseHandlerUrl(query));
    return;
  }

  res.type("html").send(renderPage({
    body: `
    <p>You are one step from finishing your IBSi News account. Confirm the email address this message was sent to.</p>
    <form action="/auth/action/confirm" method="post">
      <input type="hidden" name="mode" value="${escapeHtml(query.mode)}">
      <input type="hidden" name="oobCode" value="${escapeHtml(query.oobCode)}">
      <input type="hidden" name="apiKey" value="${escapeHtml(query.apiKey)}">
      <button type="submit">Confirm my email address</button>
    </form>
    <p class="muted">Opening this email on your phone confirms it automatically, without this step.</p>`,
    heading: "Confirm your email address",
    title: "Confirm your email address - IBSi News"
  }));
}));

/**
 * The desktop half. A POST, because submitting a form is the one thing a
 * scanner will not do - the same property that has always protected reset.
 */
authActionRouter.post(
  "/confirm",
  urlencoded({ extended: false, limit: "16kb" }),
  validate(confirmBodySchema, "body"),
  asyncHandler(async (req, res) => {
    const body = req.body as ConfirmBody;
    res.set("Cache-Control", "no-store");

    const applied = await spendActionCode(body.oobCode, body.apiKey);
    req.log.info({ applied, mode: body.mode }, "Email action code submitted from the web form");

    if (!applied) {
      res.status(400).type("html").send(renderPage({
        body: `
        <p>This link is no longer valid. Verification links expire, and each one can be used only once.</p>
        <p>Open the IBSi News app and sign in to have a new one sent to you.</p>`,
        heading: "This link has expired",
        title: "Link expired - IBSi News"
      }));
      return;
    }

    res.type("html").send(renderPage({
      body: `
      <p>Your email address is confirmed. Open the IBSi News app on your phone and sign in to finish setting up your account.</p>
      <p class="muted">You can close this page.</p>`,
      heading: "Email confirmed",
      title: "Email confirmed - IBSi News"
    }));
  })
);
