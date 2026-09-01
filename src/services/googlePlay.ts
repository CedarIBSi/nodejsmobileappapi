import { google, androidpublisher_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";

let client: androidpublisher_v3.Androidpublisher | undefined;
let pubsubTokenClient: OAuth2Client | undefined;

function androidPublisher(): androidpublisher_v3.Androidpublisher {
  if (client) return client;
  const env = config();
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    throw new HttpError(503, "Google Play verification is not configured", "GOOGLE_PLAY_NOT_CONFIGURED");
  }
  const auth = new google.auth.JWT({
    email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"]
  });
  client = google.androidpublisher({ version: "v3", auth });
  return client;
}

// Google's own enum values, minus the SUBSCRIPTION_STATE_ prefix and
// lowercased. 'active'/'in_grace_period' are the ones that keep an
// entitlement granted - see subscriptionReconcile.ts's activeStatuses.
export type GoogleSubscriptionState =
  | "active"
  | "canceled"
  | "expired"
  | "in_grace_period"
  | "on_hold"
  | "paused"
  | "pending"
  | "pending_purchase_canceled"
  | "unspecified";

export type GoogleSubscriptionSummary = {
  currentEnd: Date | null;
  currentStart: Date | null;
  // License-tester purchases go through the same production endpoint Google
  // uses for real purchases - `testPurchase` is how the response marks them,
  // there is no separate sandbox API the way Apple has one.
  isTestPurchase: boolean;
  productId: string | null;
  purchaseToken: string;
  state: GoogleSubscriptionState;
};

function normalizeState(raw?: string | null): GoogleSubscriptionState {
  const suffix = (raw ?? "").replace(/^SUBSCRIPTION_STATE_/, "").toLowerCase();
  return (suffix || "unspecified") as GoogleSubscriptionState;
}

/**
 * Fetches the canonical state of a subscription purchase from Google, keyed
 * by the purchase token the app received from Play Billing. Never trust a
 * client- or notification-supplied status directly - this is always the
 * source of truth, per Google's own RTDN guidance ("treat the notification
 * as a signal to re-fetch, not as the state itself").
 *
 * Known limitation: on an upgrade/downgrade/resubscribe, Google issues a new
 * purchase token rather than keeping the old one (the old one is exposed as
 * `linkedPurchaseToken` on the new purchase). This function keys on
 * whichever token it was called with, so that case creates a second
 * `subscriptions` row rather than extending the first - entitlement access
 * stays correct either way (any active row grants it), but the two rows
 * aren't linked. Revisit if subscription-lineage reporting is ever needed.
 */
/**
 * Confirms an incoming request to /v1/webhooks/google-play really came from
 * this app's Pub/Sub push subscription, via the OIDC bearer token Pub/Sub
 * attaches to push deliveries - not an unauthenticated caller replaying a
 * guessed payload. Throws on any failure.
 */
export async function verifyPubSubPushToken(authorizationHeader: string | undefined): Promise<void> {
  const env = config();
  if (!env.GOOGLE_PUBSUB_AUDIENCE) {
    throw new HttpError(503, "Google Play push verification is not configured", "GOOGLE_PLAY_NOT_CONFIGURED");
  }
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new HttpError(401, "Bearer token required", "UNAUTHORIZED");
  }

  if (!pubsubTokenClient) {
    pubsubTokenClient = new OAuth2Client();
  }

  const ticket = await pubsubTokenClient
    .verifyIdToken({ audience: env.GOOGLE_PUBSUB_AUDIENCE, idToken: authorizationHeader.slice(7) })
    .catch(() => {
      throw new HttpError(401, "Invalid Pub/Sub token", "UNAUTHORIZED");
    });
  const payload = ticket.getPayload();

  if (!payload?.email || !payload.email_verified) {
    throw new HttpError(401, "Invalid Pub/Sub token", "UNAUTHORIZED");
  }
  if (
    env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL &&
    payload.email !== env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL
  ) {
    throw new HttpError(401, "Unexpected Pub/Sub sender", "UNAUTHORIZED");
  }
}

export async function getGoogleSubscription(purchaseToken: string): Promise<GoogleSubscriptionSummary> {
  const env = config();
  if (!env.GOOGLE_PLAY_PACKAGE_NAME) {
    throw new HttpError(503, "Google Play package name is not configured", "GOOGLE_PLAY_NOT_CONFIGURED");
  }

  const response = await androidPublisher().purchases.subscriptionsv2.get({
    packageName: env.GOOGLE_PLAY_PACKAGE_NAME,
    token: purchaseToken
  });
  const data = response.data;
  const lineItem = data.lineItems?.[0];

  return {
    currentEnd: lineItem?.expiryTime ? new Date(lineItem.expiryTime) : null,
    currentStart: data.startTime ? new Date(data.startTime) : null,
    isTestPurchase: Boolean(data.testPurchase),
    productId: lineItem?.productId ?? null,
    purchaseToken,
    state: normalizeState(data.subscriptionState)
  };
}
