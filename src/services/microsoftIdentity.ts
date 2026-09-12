import crypto from "node:crypto";
import { HttpError } from "../lib/errors.js";

/**
 * Verifies ID tokens issued by the Microsoft identity platform.
 *
 * This exists because Firebase Auth will not accept a Microsoft credential from
 * a client. `accounts:signInWithIdp` rejects `providerId=microsoft.com` before
 * it parses the token at all - a deliberately malformed token and a valid one
 * come back with the identical INVALID_CREDENTIAL_OR_PROVIDER_ID, while the
 * same valid token sent as `google.com` is parsed and judged on its merits.
 * Microsoft is a provider Firebase insists on driving itself, through the
 * hosted handler its web and native SDKs use and the React Native SDK does not
 * implement.
 *
 * So the app cannot prove a Microsoft identity to Firebase, and this server
 * proves it instead: verify Microsoft's token here, then mint a Firebase custom
 * token for the matching user. That makes this file the only thing standing
 * between an anonymous caller and a signed-in session, which is why every check
 * below is present and none of them are optional.
 *
 * No new dependency. Node 20 builds a public key straight from a JWK, so the
 * whole verification is `node:crypto` and one fetch.
 */

/**
 * `common` rather than a tenant GUID: the app registration accepts any Entra
 * directory plus personal Microsoft accounts, so tokens arrive issued by many
 * different tenants and this key set covers all of them.
 */
const JWKS_URL = "https://login.microsoftonline.com/common/discovery/v2.0/keys";

/** Every issuer Microsoft uses is this host followed by the tenant. */
const ISSUER_PREFIX = "https://login.microsoftonline.com/";

/**
 * Clock skew allowance. Microsoft signs with its clock and we check with ours;
 * a token rejected because two machines disagree by a second is a sign-in the
 * reader cannot explain and cannot retry their way out of.
 */
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_AGE_SECONDS = 10 * 60;

/**
 * How long a fetched key set is trusted. Microsoft rotates signing keys on its
 * own schedule and publishes the replacement ahead of use, so a day is
 * comfortably inside the window - and an unrecognised `kid` forces a refetch
 * below regardless, which is what actually handles rotation.
 */
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;

type Jwk = {
  kid: string;
  kty: string;
  n?: string;
  e?: string;
  use?: string;
};

export type MicrosoftIdentity = {
  /** Stable per-user identifier within the issuing tenant. */
  objectId: string;
  email: string;
  displayName: string | null;
  tenantId: string;
};

let cachedKeys: { keys: Jwk[]; fetchedAt: number } | null = null;

const fetchKeys = async (): Promise<Jwk[]> => {
  const response = await fetch(JWKS_URL, { signal: AbortSignal.timeout(10_000) });

  if (!response.ok) {
    throw new HttpError(
      503,
      "Could not reach Microsoft to verify the sign-in. Please try again.",
      "MICROSOFT_KEYS_UNAVAILABLE"
    );
  }

  const body = (await response.json()) as { keys?: Jwk[] };

  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new HttpError(
      503,
      "Microsoft returned no signing keys.",
      "MICROSOFT_KEYS_UNAVAILABLE"
    );
  }

  cachedKeys = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
};

/**
 * Returns the signing key for `kid`.
 *
 * A cache miss refetches once, which is how key rotation is survived: the first
 * token signed with a new key misses, triggers a refetch, and succeeds. Without
 * that, a rotation would break every Microsoft sign-in until the TTL lapsed or
 * the process restarted.
 *
 * `forceRefresh` guards the recursion so an unknown `kid` cannot loop.
 */
const getSigningKey = async (kid: string, forceRefresh = false): Promise<Jwk> => {
  const isStale =
    !cachedKeys || Date.now() - cachedKeys.fetchedAt > JWKS_TTL_MS;
  const keys = forceRefresh || isStale ? await fetchKeys() : cachedKeys!.keys;
  const key = keys.find((candidate) => candidate.kid === kid);

  if (key) {
    return key;
  }

  if (!forceRefresh) {
    return getSigningKey(kid, true);
  }

  throw new HttpError(
    401,
    "The Microsoft sign-in could not be verified.",
    "MICROSOFT_TOKEN_INVALID"
  );
};

const decodeSegment = (segment: string): Record<string, unknown> => {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(
      401,
      "The Microsoft sign-in could not be verified.",
      "MICROSOFT_TOKEN_INVALID"
    );
  }
};

const invalid = () =>
  new HttpError(
    401,
    "The Microsoft sign-in could not be verified.",
    "MICROSOFT_TOKEN_INVALID"
  );

/**
 * Verifies signature and claims, and returns who the token says they are.
 *
 * Deliberately one function rather than a decode step and a check step: a
 * decoded-but-unverified token is exactly the object someone reaches for by
 * mistake, and there is no legitimate caller here that wants one.
 */
export const verifyMicrosoftIdToken = async (
  idToken: string,
  expectedAudience: string
): Promise<MicrosoftIdentity> => {
  const parts = idToken.split(".");

  if (parts.length !== 3) {
    throw invalid();
  }

  const encodedHeader = parts[0]!;
  const encodedPayload = parts[1]!;
  const encodedSignature = parts[2]!;
  const header = decodeSegment(encodedHeader);

  // Pinned rather than read from the token. Accepting whatever `alg` the token
  // names is how a verifier gets talked into "none", or into treating an RSA
  // public key as an HMAC secret.
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw invalid();
  }

  const jwk = await getSigningKey(header.kid);

  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) {
    throw invalid();
  }

  const publicKey = crypto.createPublicKey({
    key: { kty: "RSA", n: jwk.n, e: jwk.e },
    format: "jwk"
  });

  const signatureValid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    Buffer.from(encodedSignature, "base64url")
  );

  if (!signatureValid) {
    throw invalid();
  }

  const payload = decodeSegment(encodedPayload);
  const now = Math.floor(Date.now() / 1000);

  // The audience check is the one that matters most. A signature only proves
  // Microsoft issued the token; without this, a token minted for any other
  // application in the world would be accepted here and would sign its bearer
  // into someone's IBSi account.
  if (payload.aud !== expectedAudience) {
    throw invalid();
  }

  if (
    typeof payload.iss !== "string" ||
    !payload.iss.startsWith(ISSUER_PREFIX) ||
    !payload.iss.endsWith("/v2.0")
  ) {
    throw invalid();
  }

  // The issuer names the tenant in its path, and the token names it again in
  // `tid`. They have to agree, or the token is describing two different
  // directories and neither can be trusted as the source of the identity.
  const tenantId = typeof payload.tid === "string" ? payload.tid : "";

  if (!tenantId || payload.iss !== `${ISSUER_PREFIX}${tenantId}/v2.0`) {
    throw invalid();
  }

  if (
    typeof payload.exp !== "number" ||
    payload.exp + CLOCK_SKEW_SECONDS < now
  ) {
    throw invalid();
  }

  // This endpoint exchanges the ID token for a longer-lived Firebase session;
  // accept only a token from the current interactive sign-in, not an old token
  // copied from storage and replayed later.
  if (
    typeof payload.iat !== "number" ||
    payload.iat > now + CLOCK_SKEW_SECONDS ||
    payload.iat < now - MAX_TOKEN_AGE_SECONDS
  ) {
    throw invalid();
  }

  if (
    typeof payload.nbf === "number" &&
    payload.nbf - CLOCK_SKEW_SECONDS > now
  ) {
    throw invalid();
  }

  /**
   * An address is required, because it is what the Firebase account is keyed
   * on. Microsoft omits `email` when the account has no verified address on the
   * directory - `preferred_username` is *not* a substitute, it is a display
   * value the tenant can set to anything - so this refuses rather than guesses.
   */
  const email =
    typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";

  if (!email) {
    throw new HttpError(
      400,
      "This Microsoft account has no email address we can use. Sign in with an email and password instead.",
      "MICROSOFT_EMAIL_MISSING"
    );
  }

  const objectId = typeof payload.oid === "string" ? payload.oid : "";

  if (!objectId) {
    throw invalid();
  }

  return {
    objectId,
    email,
    displayName: typeof payload.name === "string" ? payload.name.trim() : null,
    tenantId
  };
};
