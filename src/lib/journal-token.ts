import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { HttpError } from "./errors.js";

type JournalTokenPayload = {
  journal_id: string;
  user_id: string;
  expires_at: number;
};

function signature(payload: string): string {
  const secret = config().JOURNAL_SIGNING_SECRET;
  if (!secret) {
    throw new HttpError(503, "Journal viewing is not configured", "JOURNAL_NOT_CONFIGURED");
  }
  return createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
}

export function createJournalToken(journalId: string, userId: string): {
  token: string;
  expiresAt: Date;
} {
  const expiresAt = new Date(Date.now() + config().JOURNAL_URL_TTL_SECONDS * 1000);
  const payload = Buffer.from(JSON.stringify({
    journal_id: journalId,
    user_id: userId,
    expires_at: Math.floor(expiresAt.getTime() / 1000)
  } satisfies JournalTokenPayload)).toString("base64url");
  return { token: `${payload}.${signature(payload)}`, expiresAt };
}

export function verifyJournalToken(token: string): JournalTokenPayload {
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) {
    throw new HttpError(403, "Invalid journal viewing link", "INVALID_JOURNAL_LINK");
  }

  const expectedSignature = signature(payload);
  const supplied = Buffer.from(suppliedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new HttpError(403, "Invalid journal viewing link", "INVALID_JOURNAL_LINK");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(403, "Invalid journal viewing link", "INVALID_JOURNAL_LINK");
  }
  const value = decoded as Partial<JournalTokenPayload>;
  if (typeof value.journal_id !== "string" || !/^[1-9]\d*$/.test(value.journal_id) ||
      typeof value.user_id !== "string" ||
      !Number.isSafeInteger(value.expires_at)) {
    throw new HttpError(403, "Invalid journal viewing link", "INVALID_JOURNAL_LINK");
  }
  if (value.expires_at! <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(410, "Journal viewing link has expired", "JOURNAL_LINK_EXPIRED");
  }
  return value as JournalTokenPayload;
}
