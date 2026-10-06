import type { PoolClient } from "pg";
import { config } from "../config.js";
import { query, transaction } from "../db/pool.js";
import { getArticleMetadata } from "./wordpress.js";

const SEND_URL = "https://exp.host/--/api/v2/push/send";
const BATCH_SIZE = 100;
const tokenPattern = /^(?:ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;

export type PushAudience =
  | { type: "all" }
  | { type: "platform"; platform: "ios" | "android" }
  | { type: "subscribers" }
  | { type: "free" }
  | { type: "entitlement"; entitlement_type: "journal_india" | "journal_global" | "insights" };

export type PushData =
  | { type: "news_article"; article_id: string; image_url?: string }
  | { type: "screen"; screen: "news" | "exclusive" | "journal" | "subscribe" | "events" | "about" }
  | { type: "url"; url: string };

type TokenRow = { id: string; expo_push_token: string; user_id: string };
type Ticket = { status: "ok" | "error"; id?: string; details?: { error?: string } };
type BroadcastRow = {
  id: string;
  kind: "article" | "message";
  article_id: string | null;
  headline: string | null;
  image_url: string | null;
  title: string | null;
  body: string | null;
  data: PushData;
  audience: PushAudience;
  status: string;
};

export type BroadcastMessage = {
  title: string;
  body: string;
  sound: "default";
  data: PushData;
  richContent?: { image: string };
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const chunks = <T>(items: T[], size: number) => {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
};

async function expoRequest(body: unknown): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const accessToken = config().EXPO_ACCESS_TOKEN;
      const response = await fetch(SEND_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000)
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) return payload;
      if (response.status !== 429 && response.status < 500) {
        const error = new Error(`Expo rejected the request with HTTP ${response.status}`);
        Object.assign(error, { permanent: true });
        throw error;
      }
      lastError = new Error(`Expo temporarily failed with HTTP ${response.status}`);
    } catch (error) {
      if ((error as { permanent?: boolean }).permanent) throw error;
      lastError = error;
    }
    if (attempt < 3) await delay(500 * 2 ** attempt + Math.floor(Math.random() * 250));
  }
  throw lastError instanceof Error ? lastError : new Error("Expo push request failed");
}

function audienceWhere(audience: PushAudience): { sql: string; values: unknown[] } {
  const active = `e.user_id = pt.user_id AND e.status = 'active'
    AND e.starts_at <= now() AND (e.ends_at IS NULL OR e.ends_at > now())`;
  switch (audience.type) {
    case "all": return { sql: "TRUE", values: [] };
    case "platform": return { sql: "pt.platform = $1", values: [audience.platform] };
    case "subscribers": return { sql: `EXISTS (SELECT 1 FROM entitlements e WHERE ${active})`, values: [] };
    case "free": return { sql: `NOT EXISTS (SELECT 1 FROM entitlements e WHERE ${active})`, values: [] };
    case "entitlement": return {
      sql: `EXISTS (SELECT 1 FROM entitlements e WHERE ${active} AND e.entitlement_type = $1)`,
      values: [audience.entitlement_type]
    };
  }
}

export async function audienceCount(audience: PushAudience): Promise<{ devices: number; users: number }> {
  const where = audienceWhere(audience);
  const result = await query<{ devices: string; users: string }>(
    `SELECT count(*)::text AS devices, count(DISTINCT pt.user_id)::text AS users
       FROM push_tokens pt WHERE ${where.sql}`,
    where.values
  );
  return { devices: Number(result.rows[0]?.devices ?? 0), users: Number(result.rows[0]?.users ?? 0) };
}

export function messageForBroadcast(row: BroadcastRow): BroadcastMessage {
  if (row.kind === "article") {
    const imageUrl = row.image_url ?? undefined;
    return {
      title: "IBS Intelligence",
      body: row.headline!,
      sound: "default",
      ...(imageUrl ? { richContent: { image: imageUrl } } : {}),
      data: {
        type: "news_article",
        article_id: row.article_id!,
        ...(imageUrl ? { image_url: imageUrl } : {})
      }
    };
  }
  return {
    title: row.title!,
    body: row.body!,
    sound: "default",
    ...(row.image_url ? { richContent: { image: row.image_url } } : {}),
    data: row.data
  };
}

export async function createBroadcast(input: {
  kind: "article" | "message";
  articleId?: string;
  headline?: string;
  summary?: string;
  imageUrl?: string;
  title?: string;
  body?: string;
  data?: PushData;
  audience: PushAudience;
  scheduledAt?: Date;
  requestedBy: string;
}): Promise<BroadcastRow> {
  let headline = input.headline?.trim() || null;
  let imageUrl = input.imageUrl?.trim() || null;
  if (input.kind === "article" && input.articleId && (!headline || !imageUrl)) {
    const metadata = await getArticleMetadata(input.articleId);
    headline ||= metadata?.headline ?? null;
    imageUrl ||= metadata?.image_url ?? null;
  }
  if (input.kind === "article" && !headline) {
    throw Object.assign(new Error("The article headline could not be resolved from WordPress"), {
      status: 422,
      code: "ARTICLE_METADATA_UNAVAILABLE"
    });
  }

  const scheduled = input.scheduledAt && input.scheduledAt.getTime() > Date.now();
  const created = await query<BroadcastRow>(
    `INSERT INTO push_broadcasts
       (kind, article_id, headline, summary, image_url, title, body, data, audience,
        scheduled_at, requested_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
     ON CONFLICT (article_id) WHERE article_id IS NOT NULL DO NOTHING
     RETURNING id, kind, article_id, headline, image_url, title, body, data, audience, status`,
    [input.kind, input.articleId ?? null, headline, input.summary ?? null, imageUrl,
      input.title ?? null, input.body ?? null, JSON.stringify(input.data ?? {}),
      JSON.stringify(input.audience), input.scheduledAt ?? null, input.requestedBy,
      scheduled ? "scheduled" : "processing"]
  );
  const row = created.rows[0];
  if (!row) {
    throw Object.assign(new Error("A notification has already been sent or scheduled for this article"), {
      status: 409,
      code: "ARTICLE_ALREADY_NOTIFIED"
    });
  }
  return row;
}

export async function runBroadcast(broadcastId: string) {
  const found = await query<BroadcastRow>(
    `SELECT id, kind, article_id, headline, image_url, title, body, data, audience, status
       FROM push_broadcasts WHERE id = $1`,
    [broadcastId]
  );
  const broadcast = found.rows[0];
  if (!broadcast) throw Object.assign(new Error("Broadcast not found"), { status: 404, code: "NOT_FOUND" });
  if (broadcast.status === "cancelled") return { broadcast_id: broadcast.id, status: "cancelled" };

  const where = audienceWhere(broadcast.audience);
  const result = await query<TokenRow>(
    `SELECT pt.id, pt.expo_push_token, pt.user_id FROM push_tokens pt
       WHERE ${where.sql} ORDER BY pt.id`,
    where.values
  );
  const valid = result.rows.filter((row) => tokenPattern.test(row.expo_push_token));
  const stale = result.rows.filter((row) => !tokenPattern.test(row.expo_push_token)).map((row) => row.id);
  let accepted = 0;
  let failed = result.rows.length - valid.length;
  await query("UPDATE push_broadcasts SET target_count = $2, status = 'processing', updated_at = now() WHERE id = $1", [broadcastId, result.rows.length]);

  try {
    const message = messageForBroadcast(broadcast);
    const batches = chunks(valid, BATCH_SIZE);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex]!;
      const payload = (await expoRequest(batch.map((row) => ({ to: row.expo_push_token, ...message })))) as { data?: Ticket[] };
      await transaction(async (client) => {
        for (let index = 0; index < batch.length; index += 1) {
          const row = batch[index]!;
          const ticket = payload.data?.[index];
          if (ticket?.status === "ok" && ticket.id) {
            accepted += 1;
            await client.query(
              `INSERT INTO expo_push_receipts (ticket_id, broadcast_id, push_token_id, next_check_at)
               VALUES ($1, $2, $3, now() + ($4 * interval '1 second'))`,
              [ticket.id, broadcastId, row.id, config().EXPO_RECEIPT_DELAY_SECONDS]
            );
          } else {
            failed += 1;
            if (ticket?.details?.error === "DeviceNotRegistered") stale.push(row.id);
          }
        }
      });
      if (batchIndex + 1 < batches.length) await delay(config().EXPO_PUSH_BATCH_INTERVAL_MS);
    }
  } catch (error) {
    failed = result.rows.length - accepted;
    console.error("[expoPush] broadcast interrupted", { broadcastId, error: error instanceof Error ? error.message : String(error) });
  }

  if (stale.length) await query("DELETE FROM push_tokens WHERE id = ANY($1::uuid[])", [stale]);
  const status = accepted === 0 ? "failed" : failed ? "partial" : "accepted";
  await query(
    `UPDATE push_broadcasts SET status = $2, accepted_count = $3, failed_count = $4,
       completed_at = now(), updated_at = now() WHERE id = $1`,
    [broadcastId, status, accepted, failed]
  );
  return { broadcast_id: broadcastId, status, target_count: result.rows.length, accepted_count: accepted, failed_count: failed };
}

export async function broadcastArticle(input: {
  articleId: string;
  headline?: string;
  summary?: string;
  imageUrl?: string;
  requestedBy: string;
}) {
  const row = await createBroadcast({ kind: "article", articleId: input.articleId,
    headline: input.headline, summary: input.summary, imageUrl: input.imageUrl,
    audience: { type: "all" }, requestedBy: input.requestedBy });
  return runBroadcast(row.id);
}

async function claimDueBroadcast(): Promise<string | null> {
  return transaction(async (client: PoolClient) => {
    const due = await client.query<{ id: string }>(
      `SELECT id FROM push_broadcasts WHERE status = 'scheduled' AND scheduled_at <= now()
       ORDER BY scheduled_at FOR UPDATE SKIP LOCKED LIMIT 1`
    );
    const id = due.rows[0]?.id;
    if (!id) return null;
    await client.query("UPDATE push_broadcasts SET status = 'processing', updated_at = now() WHERE id = $1", [id]);
    return id;
  });
}

let checkingSchedule = false;
export async function runDueBroadcasts(): Promise<number> {
  if (checkingSchedule) return 0;
  checkingSchedule = true;
  let count = 0;
  try {
    while (true) {
      const id = await claimDueBroadcast();
      if (!id) return count;
      await runBroadcast(id);
      count += 1;
    }
  } finally {
    checkingSchedule = false;
  }
}
