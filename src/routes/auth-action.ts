import { Router, urlencoded } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler } from "../lib/async-handler.js";

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

/**
 * Null rather than a thrown HttpError. A throw here reached the shared error
 * handler and came back as JSON - the same shape of answer that failed
 * Firebase's review of this URL, reachable on a misconfigured deploy rather
 * than on a malformed request. Every exit from this route is a page.
 */
const firebaseHandlerUrl = (query: ActionQuery): string | null => {
  const authDomain = config().FIREBASE_AUTH_DOMAIN;

  if (!authDomain) {
    return null;
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
 * The three intercepted modes are not the same errand, and the page said they
 * were.
 *
 * Every one of them rendered "You are one step from finishing your IBSi News
 * account" under the heading "Confirm your email address". For verifyEmail
 * that is right. For recoverEmail it is wrong in a way that matters: that link
 * goes to the *old* address after someone changed the account's email, so the
 * reader is undoing a change they may not have made, and telling them they are
 * finishing a signup is both false and reassuring at the moment they should be
 * paying attention.
 *
 * Firebase's documentation also suggests offering a password reset after a
 * recovery, since an unrequested email change usually means the account is
 * already in someone else's hands. The success copy below says so.
 */
type ActionMode = ActionQuery["mode"];

const modeCopy: Record<
  string,
  { button: string; heading: string; intro: string; successBody: string; successHeading: string }
> = {
  recoverEmail: {
    button: "Restore my email address",
    heading: "Restore your email address",
    intro:
      "The email address on your IBSi News account was changed. Confirm below to change it back to this address.",
    successBody:
      "<p>Your account's email address has been restored.</p><p>If you did not ask for it to be changed, someone else may have access to your account. Open the IBSi News app and reset your password now.</p>",
    successHeading: "Email address restored"
  },
  verifyAndChangeEmail: {
    button: "Confirm my new email address",
    heading: "Confirm your new email address",
    intro:
      "Confirm that this is the address you want to use for your IBSi News account.",
    successBody:
      "<p>Your new email address is confirmed. Open the IBSi News app and sign in with it.</p><p class=\"muted\">You can close this page.</p>",
    successHeading: "Email address confirmed"
  },
  verifyEmail: {
    button: "Confirm my email address",
    heading: "Confirm your email address",
    intro:
      "You are one step from finishing your IBSi News account. Confirm the email address this message was sent to.",
    successBody:
      "<p>Your email address is confirmed. Open the IBSi News app on your phone and sign in to finish setting up your account.</p><p class=\"muted\">You can close this page.</p>",
    successHeading: "Email confirmed"
  }
};

/** Falls back to the verification wording, which is the commonest link by far. */
const copyForMode = (mode: string) => modeCopy[mode] ?? modeCopy.verifyEmail!;

/**
 * What to send when the link is not a usable one.
 *
 * This page exists because the route used to answer a bad request the way
 * every other route does - a JSON 400 from the shared validator - and this is
 * not an API. It is the address printed in the emails Firebase sends, so the
 * things that open it are people, and link scanners, and Google's own
 * validator when the custom action URL is registered. That validator rejected
 * it, and was right to: the response was not a page at all, and its body
 * listed every parameter the endpoint accepts, each one's expected type, and
 * the complete set of valid modes. An endpoint publishing its own contract to
 * anyone who sends it an empty request is a finding on any security review.
 *
 * Deliberately 200 rather than 400. Nothing is broken when someone opens this
 * address without a code - the reader followed an old link, or a scanner
 * fetched the bare URL - and a page that says so plainly is the correct
 * answer. The wording never distinguishes "no code" from "malformed code"
 * either: the difference matters to no honest reader, and telling the other
 * sort which of their guesses was closer is free help.
 */
const renderUnusableLink = () =>
  renderPage({
    body: `
    <p>This link is not valid. Verification and password links expire, and each one can be used only once.</p>
    <p>Open the IBSi News app and sign in to have a new one sent to you.</p>`,
    heading: "This link is not valid",
    title: "Link not valid - IBSi News"
  });

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

authActionRouter.get("/", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");

  // Not the shared `validate` middleware: it answers JSON, which is right for
  // the API and wrong for the one route in this server that a browser is meant
  // to land on. See renderUnusableLink.
  const parsed = actionQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    req.log.info(
      { hasCode: Boolean((req.query as Record<string, unknown>).oobCode) },
      "Email action link opened without usable parameters"
    );
    res.type("html").send(renderUnusableLink());
    return;
  }

  const query = parsed.data;

  // Reset needs Firebase's form, and loading that form redeems nothing.
  if (!autoAppliedModes.has(query.mode)) {
    const target = firebaseHandlerUrl(query);

    if (!target) {
      req.log.error("FIREBASE_AUTH_DOMAIN is not set; cannot forward a reset link");
      res.type("html").send(renderUnusableLink());
      return;
    }

    res.redirect(302, target);
    return;
  }

  /**
   * Only verification is handed to the app, because only verification is
   * something the app can finish. SignInScreen matches on mode === 'verifyEmail'
   * and ignores anything else, so a phone sent an email-recovery link would
   * have opened the app, matched nothing, and sat there - the code unspent and
   * the reader given no reason why.
   *
   * Neither recoverEmail nor verifyAndChangeEmail can fire today: Firebase only
   * sends them when an account's email address changes, and nothing in either
   * repo calls updateEmail or verifyBeforeUpdateEmail. They are handled anyway
   * because the day somebody adds a change-email screen, this route will start
   * receiving them without anyone thinking to come back here - and the form
   * below completes them correctly on any device.
   */
  if (query.mode === "verifyEmail" && opensTheApp(req.get("user-agent"))) {
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
    const target = firebaseHandlerUrl(query);

    if (!target) {
      res.type("html").send(renderUnusableLink());
      return;
    }

    res.redirect(302, target);
    return;
  }

  const copy = copyForMode(query.mode);

  res.type("html").send(renderPage({
    body: `
    <p>${escapeHtml(copy.intro)}</p>
    <form action="/auth/action/confirm" method="post">
      <input type="hidden" name="mode" value="${escapeHtml(query.mode)}">
      <input type="hidden" name="oobCode" value="${escapeHtml(query.oobCode)}">
      <input type="hidden" name="apiKey" value="${escapeHtml(query.apiKey)}">
      <button type="submit">${escapeHtml(copy.button)}</button>
    </form>
    <p class="muted">Opening this email on your phone completes it automatically, without this step.</p>`,
    heading: copy.heading,
    title: copy.heading + " - IBSi News"
  }));
}));

/**
 * The desktop half. A POST, because submitting a form is the one thing a
 * scanner will not do - the same property that has always protected reset.
 */
authActionRouter.post(
  "/confirm",
  urlencoded({ extended: false, limit: "16kb" }),
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");

    // As with the GET: this form is submitted by a browser, so a bad submission
    // gets the page rather than the validator's JSON.
    const parsed = confirmBodySchema.safeParse(req.body);

    if (!parsed.success) {
      res.type("html").send(renderUnusableLink());
      return;
    }

    const body = parsed.data;

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

    const copy = copyForMode(body.mode);

    res.type("html").send(renderPage({
      body: copy.successBody,
      heading: copy.successHeading,
      title: copy.successHeading + " - IBSi News"
    }));
  })
);
