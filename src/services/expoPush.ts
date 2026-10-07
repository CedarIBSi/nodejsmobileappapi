import { config } from "../config.js";
import { query, transaction } from "../db/pool.js";
import { runDueBroadcasts } from "./pushBroadcast.js";
export { broadcastArticle } from "./pushBroadcast.js";

const SEND_URL = "https://exp.host/--/api/v2/push/send";
const RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const BATCH_SIZE = 100;
const tokenPattern = /^(?:ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;

export type PushMessageInput = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  richContent?: { image: string };
  mutableContent?: boolean;
  sound?: "default";
};
type TokenRow = { id: string; expo_push_token: string };
type Ticket = { status: "ok" | "error"; id?: string; message?: string; details?: { error?: string } };
type Receipt = { status: "ok" | "error"; message?: string; details?: { error?: string } };

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const chunks = <T>(items: T[], size: number) => {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
};

function headers(): Record<string, string> {
  const accessToken = config().EXPO_ACCESS_TOKEN;
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
  };
}

async function expoRequest(url: string, body: unknown): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: headers(),
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

async function deleteTokens(ids: string[]): Promise<void> {
  if (ids.length) await query("DELETE FROM push_tokens WHERE id = ANY($1::uuid[])", [ids]);
}

export async function sendPushNotificationToUser(
  userId: string,
  message: PushMessageInput
): Promise<{ sent: number; failed: number }> {
  const result = await query<TokenRow>("SELECT id, expo_push_token FROM push_tokens WHERE user_id = $1", [userId]);
  const valid = result.rows.filter((row) => tokenPattern.test(row.expo_push_token));
  const stale = result.rows.filter((row) => !tokenPattern.test(row.expo_push_token)).map((row) => row.id);
  let sent = 0;
  let failed = result.rows.length - valid.length;

  for (const batch of chunks(valid, BATCH_SIZE)) {
    const payload = (await expoRequest(SEND_URL, batch.map((row) => ({ to: row.expo_push_token, ...message })))) as { data?: Ticket[] };
    batch.forEach((row, index) => {
      const ticket = payload.data?.[index];
      if (ticket?.status === "ok") sent += 1;
      else {
        failed += 1;
        if (ticket?.details?.error === "DeviceNotRegistered") stale.push(row.id);
      }
    });
  }
  await deleteTokens(stale);
  return { sent, failed };
}

let checkingReceipts = false;
export async function checkPendingExpoReceipts(): Promise<number> {
  if (checkingReceipts) return 0;
  checkingReceipts = true;
  try {
    const pending = await query<{ ticket_id: string; broadcast_id: string; push_token_id: string | null; check_count: number }>(
      `SELECT ticket_id, broadcast_id, push_token_id, check_count FROM expo_push_receipts
       WHERE status = 'accepted' AND next_check_at <= now() ORDER BY next_check_at LIMIT 1000`
    );
    if (!pending.rowCount) return 0;
    const payload = (await expoRequest(RECEIPTS_URL, { ids: pending.rows.map((row) => row.ticket_id) })) as { data?: Record<string, Receipt> };
    const stale: string[] = [];
    await transaction(async (client) => {
      for (const row of pending.rows) {
        const receipt = payload.data?.[row.ticket_id];
        if (!receipt) {
          const expired = row.check_count >= 11;
          await client.query(
            `UPDATE expo_push_receipts SET status = CASE WHEN $2 THEN 'failed' ELSE status END,
             error_code = CASE WHEN $2 THEN 'RECEIPT_UNAVAILABLE' ELSE error_code END,
             check_count = check_count + 1, next_check_at = now() + interval '1 hour', checked_at = now()
             WHERE ticket_id = $1`, [row.ticket_id, expired]
          );
          continue;
        }
        const delivered = receipt.status === "ok";
        await client.query(
          `UPDATE expo_push_receipts SET status = $2, error_code = $3, error_message = $4,
           check_count = check_count + 1, checked_at = now() WHERE ticket_id = $1`,
          [row.ticket_id, delivered ? "delivered" : "failed", receipt.details?.error ?? null, receipt.message ?? null]
        );
        if (receipt.details?.error === "DeviceNotRegistered" && row.push_token_id) stale.push(row.push_token_id);
      }
    });
    await deleteTokens(stale);
    for (const broadcastId of new Set(pending.rows.map((row) => row.broadcast_id))) {
      await query(
        `UPDATE push_broadcasts b SET delivered_count = x.delivered,
         failed_count = (b.target_count - b.accepted_count) + x.failed, updated_at = now()
         FROM (SELECT count(*) FILTER (WHERE status='delivered')::int delivered,
         count(*) FILTER (WHERE status='failed')::int failed FROM expo_push_receipts WHERE broadcast_id=$1) x
         WHERE b.id=$1`, [broadcastId]
      );
    }
    return pending.rows.length;
  } finally { checkingReceipts = false; }
}

let receiptTimer: NodeJS.Timeout | undefined;
let scheduleTimer: NodeJS.Timeout | undefined;
export function startExpoReceiptWorker(): () => void {
  if (receiptTimer || scheduleTimer) return () => undefined;
  const run = () => void checkPendingExpoReceipts().catch((error) =>
    console.error("[expoPush] receipt check failed", { error: error instanceof Error ? error.message : String(error) }));
  const runSchedule = () => void runDueBroadcasts().catch((error) =>
    console.error("[expoPush] scheduled broadcast failed", { error: error instanceof Error ? error.message : String(error) }));
  receiptTimer = setInterval(run, 60_000);
  scheduleTimer = setInterval(runSchedule, 30_000);
  receiptTimer.unref();
  scheduleTimer.unref();
  setTimeout(run, 10_000).unref();
  setTimeout(runSchedule, 5_000).unref();
  return () => {
    if (receiptTimer) clearInterval(receiptTimer);
    if (scheduleTimer) clearInterval(scheduleTimer);
    receiptTimer = undefined;
    scheduleTimer = undefined;
  };
}
