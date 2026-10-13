import fs from "node:fs";
import path from "node:path";
import {
  APIException,
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  Status,
  VerificationException,
  VerificationStatus,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload
} from "@apple/app-store-server-library";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";

const apiClients = new Map<Environment, AppStoreServerAPIClient>();
const verifiers = new Map<Environment, SignedDataVerifier>();

function environment(): Environment {
  return config().APPLE_ENVIRONMENT === "Production" ? Environment.PRODUCTION : Environment.SANDBOX;
}

/**
 * The environments a transaction is looked up in, in order.
 *
 * App Review tests purchases with a sandbox Apple ID on the production
 * build, and so does TestFlight after release: the app is the production
 * app, the transaction is a sandbox one. Apple's documented handling is to
 * ask Production first and, when it answers "transaction not found", ask
 * Sandbox. Pinned to Production alone, the API refused every reviewer's
 * purchase with a 404 - a certain rejection.
 *
 * The other way round is deliberately not offered: a server configured as
 * Sandbox (pre-release) never sees a production transaction, and must not
 * accept one if it did.
 */
function environmentsToTry(): Environment[] {
  return environment() === Environment.PRODUCTION
    ? [Environment.PRODUCTION, Environment.SANDBOX]
    : [Environment.SANDBOX];
}

function requireAppleCredentials() {
  const env = config();
  if (!env.APPLE_ISSUER_ID || !env.APPLE_KEY_ID || !env.APPLE_PRIVATE_KEY || !env.APPLE_BUNDLE_ID) {
    throw new HttpError(503, "Apple In-App Purchase verification is not configured", "APPLE_NOT_CONFIGURED");
  }
  return {
    bundleId: env.APPLE_BUNDLE_ID,
    issuerId: env.APPLE_ISSUER_ID,
    keyId: env.APPLE_KEY_ID,
    privateKey: env.APPLE_PRIVATE_KEY
  };
}

function appStoreClient(env: Environment): AppStoreServerAPIClient {
  const existing = apiClients.get(env);
  if (existing) return existing;
  const credentials = requireAppleCredentials();
  const client = new AppStoreServerAPIClient(
    credentials.privateKey,
    credentials.keyId,
    credentials.issuerId,
    credentials.bundleId,
    env
  );
  apiClients.set(env, client);
  return client;
}

function loadRootCertificates(): Buffer[] {
  const dir = config().APPLE_ROOT_CERTS_DIR;
  if (!fs.existsSync(dir)) {
    throw new HttpError(503, "Apple root certificates are not installed", "APPLE_NOT_CONFIGURED");
  }
  const files = fs.readdirSync(dir).filter((file) => file.toLowerCase().endsWith(".cer"));
  if (!files.length) {
    throw new HttpError(503, "Apple root certificates are not installed", "APPLE_NOT_CONFIGURED");
  }
  return files.map((file) => fs.readFileSync(path.join(dir, file)));
}

function dataVerifier(env: Environment): SignedDataVerifier {
  const existing = verifiers.get(env);
  if (existing) return existing;
  const credentials = requireAppleCredentials();
  const verifier = new SignedDataVerifier(
    loadRootCertificates(),
    true,
    env,
    credentials.bundleId,
    config().APPLE_APP_APPLE_ID
  );
  verifiers.set(env, verifier);
  return verifier;
}

/**
 * Runs a signed-payload verification against each environment in turn. A
 * verifier checks the payload's own `environment` claim against the one it
 * was built for and refuses a mismatch as INVALID_ENVIRONMENT; that, and only
 * that, moves on to the next environment. A bad signature fails at once.
 */
async function verifyInAnyEnvironment<T>(
  verify: (verifier: SignedDataVerifier) => Promise<T>
): Promise<T> {
  const environments = environmentsToTry();
  let lastError: unknown;
  for (const env of environments) {
    try {
      return await verify(dataVerifier(env));
    } catch (error) {
      lastError = error;
      const mismatch =
        error instanceof VerificationException && error.status === VerificationStatus.INVALID_ENVIRONMENT;
      if (!mismatch) throw error;
    }
  }
  throw lastError;
}

export type AppleSubscriptionState =
  | "active"
  | "billing_grace_period"
  | "billing_retry"
  | "expired"
  | "revoked"
  | "unknown";

export type AppleSubscriptionSummary = {
  currency: string | null;
  currentEnd: Date | null;
  environment: "sandbox" | "production";
  originalTransactionId: string;
  priceMicros: bigint | null;
  productId: string | null;
  purchaseDate: Date | null;
  revoked: boolean;
  state: AppleSubscriptionState;
  transactionId: string;
};

const stateByStatus: Partial<Record<Status, AppleSubscriptionState>> = {
  [Status.ACTIVE]: "active",
  [Status.BILLING_GRACE_PERIOD]: "billing_grace_period",
  [Status.BILLING_RETRY]: "billing_retry",
  [Status.EXPIRED]: "expired",
  [Status.REVOKED]: "revoked"
};

export function mapAppleStatus(status?: Status | number): AppleSubscriptionState {
  return status !== undefined ? stateByStatus[status as Status] ?? "unknown" : "unknown";
}

/**
 * Asks each environment in turn for the subscription a transaction belongs
 * to. Apple answers 404 for a transaction id that does not exist in the
 * environment asked, which is what a sandbox purchase looks like to
 * Production; that, and only that, moves on to Sandbox. Any other failure -
 * a bad key, a rate limit, an outage - is thrown as it is, so a Production
 * outage is never reported as "transaction not found in Sandbox".
 */
async function fetchSubscriptionStatuses(transactionId: string): Promise<{
  env: Environment;
  statusResponse: Awaited<ReturnType<AppStoreServerAPIClient["getAllSubscriptionStatuses"]>>;
}> {
  const environments = environmentsToTry();
  for (const [index, env] of environments.entries()) {
    try {
      return { env, statusResponse: await appStoreClient(env).getAllSubscriptionStatuses(transactionId) };
    } catch (error) {
      const notFound = error instanceof APIException && error.httpStatusCode === 404;
      const hasNext = index < environments.length - 1;
      if (!notFound || !hasNext) throw error;
    }
  }
  throw new HttpError(404, "Apple transaction not found", "APPLE_TRANSACTION_NOT_FOUND");
}

/**
 * Looks up the definitive, current state of a subscription from Apple using
 * any transaction id belonging to it - the one the app reports right after a
 * purchase. Mirrors googlePlay.ts's getGoogleSubscription: the client's own
 * report of a purchase is never trusted without this round trip, and the
 * numeric `Status` App Store Server API returns is used directly rather than
 * derived from expiry/revocation timestamps.
 */
export async function getAppleSubscription(transactionId: string): Promise<AppleSubscriptionSummary> {
  const { env, statusResponse } = await fetchSubscriptionStatuses(transactionId);
  const lastTransactions = (statusResponse.data ?? []).flatMap((group) => group.lastTransactions ?? []);

  // The transactions came from `env`, so they are verified against `env`:
  // a sandbox transaction's signed payload says Sandbox, and the Production
  // verifier would refuse it.
  const decoded = await Promise.all(
    lastTransactions.map(async (item) => ({
      item,
      transaction: item.signedTransactionInfo
        ? await dataVerifier(env).verifyAndDecodeTransaction(item.signedTransactionInfo)
        : null
    }))
  );

  // A transaction id can belong to any subscription in the account's group
  // (e.g. one it was previously upgraded/downgraded from) - match the entry
  // the app actually reported rather than assuming the first one.
  const match =
    decoded.find(
      ({ transaction }) =>
        transaction?.transactionId === transactionId ||
        transaction?.originalTransactionId === transactionId
    ) ?? decoded[0];

  if (!match?.transaction) {
    throw new HttpError(404, "Apple transaction not found", "APPLE_TRANSACTION_NOT_FOUND");
  }

  return {
    currency: match.transaction.currency?.toUpperCase() ?? null,
    currentEnd: match.transaction.expiresDate ? new Date(match.transaction.expiresDate) : null,
    environment: match.transaction.environment === Environment.PRODUCTION ? "production" : "sandbox",
    originalTransactionId: match.transaction.originalTransactionId ?? transactionId,
    // Apple reports milliunits; the ledger stores millionths.
    priceMicros: match.transaction.price !== undefined ? BigInt(match.transaction.price) * 1000n : null,
    productId: match.transaction.productId ?? null,
    purchaseDate: match.transaction.purchaseDate ? new Date(match.transaction.purchaseDate) : null,
    revoked: Boolean(match.transaction.revocationDate),
    state: mapAppleStatus(match.item.status),
    transactionId: match.transaction.transactionId ?? transactionId
  };
}

/**
 * Decodes and verifies a single App Store Server Notifications V2
 * `signedPayload`. Used by the /v1/webhooks/apple handler.
 */
export async function verifyAppleNotification(
  signedPayload: string
): Promise<ResponseBodyV2DecodedPayload> {
  // Apple posts sandbox notifications (App Review's purchases, TestFlight
  // renewals) to the same URL as production ones; the verifier built for
  // Production refuses them, so each environment gets its turn.
  return verifyInAnyEnvironment((verifier) => verifier.verifyAndDecodeNotification(signedPayload));
}

/**
 * Decodes and verifies the nested `signedTransactionInfo` JWS a notification
 * carries in its `data` field - separate from the outer `signedPayload`
 * envelope, and needed for the transaction's productId/expiresDate.
 */
export async function decodeAppleTransaction(
  signedTransactionInfo: string
): Promise<JWSTransactionDecodedPayload> {
  return verifyInAnyEnvironment((verifier) => verifier.verifyAndDecodeTransaction(signedTransactionInfo));
}
