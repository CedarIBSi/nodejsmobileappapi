import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { HttpError } from "./errors.js";

/**
 * Deliberately a parallel implementation of lib/journal-token.ts rather than a
 * shared helper. Separate secrets and separate payload shapes mean a journal
 * link can never be replayed against a white paper, and either secret can be
 * rotated without invalidating the other library's outstanding links.
 */
type WhitepaperTokenPayload = {
  whitepaper_id: string;
  user_id: string;
  expires_at: number;
};

function signature(payload: string): string {
  const secret = config().WHITEPAPER_SIGNING_SECRET;
  if (!secret) {
    throw new HttpError(503, "White paper viewing is not configured", "WHITEPAPER_NOT_CONFIGURED");
  }
  return createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
}

export function createWhitepaperToken(whitepaperId: string, userId: string): {
  token: string;
  expiresAt: Date;
} {
  const expiresAt = new Date(Date.now() + config().WHITEPAPER_URL_TTL_SECONDS * 1000);
  const payload = Buffer.from(JSON.stringify({
    whitepaper_id: whitepaperId,
    user_id: userId,
    expires_at: Math.floor(expiresAt.getTime() / 1000)
  } satisfies WhitepaperTokenPayload)).toString("base64url");
  return { token: `${payload}.${signature(payload)}`, expiresAt };
}

export function verifyWhitepaperToken(token: string): WhitepaperTokenPayload {
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) {
    throw new HttpError(403, "Invalid white paper viewing link", "INVALID_WHITEPAPER_LINK");
  }

  const expectedSignature = signature(payload);
  const supplied = Buffer.from(suppliedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new HttpError(403, "Invalid white paper viewing link", "INVALID_WHITEPAPER_LINK");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(403, "Invalid white paper viewing link", "INVALID_WHITEPAPER_LINK");
  }
  const value = decoded as Partial<WhitepaperTokenPayload>;
  if (typeof value.whitepaper_id !== "string" || !/^[1-9]\d*$/.test(value.whitepaper_id) ||
      typeof value.user_id !== "string" ||
      !Number.isSafeInteger(value.expires_at)) {
    throw new HttpError(403, "Invalid white paper viewing link", "INVALID_WHITEPAPER_LINK");
  }
  if (value.expires_at! <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(410, "White paper viewing link has expired", "WHITEPAPER_LINK_EXPIRED");
  }
  return value as WhitepaperTokenPayload;
}
