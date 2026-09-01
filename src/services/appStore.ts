import fs from "node:fs";
import path from "node:path";
import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  Status,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload
} from "@apple/app-store-server-library";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";

let apiClient: AppStoreServerAPIClient | undefined;
let verifier: SignedDataVerifier | undefined;

function environment(): Environment {
  return config().APPLE_ENVIRONMENT === "Production" ? Environment.PRODUCTION : Environment.SANDBOX;
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

function appStoreClient(): AppStoreServerAPIClient {
  if (apiClient) return apiClient;
  const credentials = requireAppleCredentials();
  apiClient = new AppStoreServerAPIClient(
    credentials.privateKey,
    credentials.keyId,
    credentials.issuerId,
    credentials.bundleId,
    environment()
  );
  return apiClient;
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

function dataVerifier(): SignedDataVerifier {
  if (verifier) return verifier;
  const credentials = requireAppleCredentials();
  verifier = new SignedDataVerifier(
    loadRootCertificates(),
    true,
    environment(),
    credentials.bundleId,
    config().APPLE_APP_APPLE_ID
  );
  return verifier;
}

export type AppleSubscriptionState =
  | "active"
  | "billing_grace_period"
  | "billing_retry"
  | "expired"
  | "revoked"
  | "unknown";

export type AppleSubscriptionSummary = {
  currentEnd: Date | null;
  environment: "sandbox" | "production";
  originalTransactionId: string;
  productId: string | null;
  state: AppleSubscriptionState;
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
 * Looks up the definitive, current state of a subscription from Apple using
 * any transaction id belonging to it - the one the app reports right after a
 * purchase. Mirrors googlePlay.ts's getGoogleSubscription: the client's own
 * report of a purchase is never trusted without this round trip, and the
 * numeric `Status` App Store Server API returns is used directly rather than
 * derived from expiry/revocation timestamps.
 */
export async function getAppleSubscription(transactionId: string): Promise<AppleSubscriptionSummary> {
  const statusResponse = await appStoreClient().getAllSubscriptionStatuses(transactionId);
  const lastTransactions = (statusResponse.data ?? []).flatMap((group) => group.lastTransactions ?? []);

  const decoded = await Promise.all(
    lastTransactions.map(async (item) => ({
      item,
      transaction: item.signedTransactionInfo
        ? await dataVerifier().verifyAndDecodeTransaction(item.signedTransactionInfo)
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
    currentEnd: match.transaction.expiresDate ? new Date(match.transaction.expiresDate) : null,
    environment: match.transaction.environment === Environment.PRODUCTION ? "production" : "sandbox",
    originalTransactionId: match.transaction.originalTransactionId ?? transactionId,
    productId: match.transaction.productId ?? null,
    state: mapAppleStatus(match.item.status)
  };
}

/**
 * Decodes and verifies a single App Store Server Notifications V2
 * `signedPayload`. Used by the /v1/webhooks/apple handler.
 */
export async function verifyAppleNotification(
  signedPayload: string
): Promise<ResponseBodyV2DecodedPayload> {
  return dataVerifier().verifyAndDecodeNotification(signedPayload);
}

/**
 * Decodes and verifies the nested `signedTransactionInfo` JWS a notification
 * carries in its `data` field - separate from the outer `signedPayload`
 * envelope, and needed for the transaction's productId/expiresDate.
 */
export async function decodeAppleTransaction(
  signedTransactionInfo: string
): Promise<JWSTransactionDecodedPayload> {
  return dataVerifier().verifyAndDecodeTransaction(signedTransactionInfo);
}
