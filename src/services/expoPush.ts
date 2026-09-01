import { query } from "../db/pool.js";

const EXPO_PUSH_API_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_PUSH_BATCH_SIZE = 100;

export type PushMessageInput = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

type ExpoPushTicket = {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

/**
 * Sends a push message to every token on file for one user. Tokens Expo
 * reports as no longer registered are deleted so future sends stop retrying
 * them - this only inspects the immediate send response, not the delayed
 * Expo receipt endpoint.
 */
export async function sendPushNotificationToUser(
  userId: string,
  message: PushMessageInput
): Promise<{ sent: number; failed: number }> {
  const tokensResult = await query<{ expo_push_token: string }>(
    "SELECT expo_push_token FROM push_tokens WHERE user_id = $1",
    [userId]
  );
  const tokens = tokensResult.rows.map((row) => row.expo_push_token);
  if (tokens.length === 0) {
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;
  const staleTokens: string[] = [];

  for (const batch of chunk(tokens, EXPO_PUSH_BATCH_SIZE)) {
    const response = await fetch(EXPO_PUSH_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(
        batch.map((to) => ({ to, title: message.title, body: message.body, data: message.data }))
      )
    });
    const payload = (await response.json()) as { data?: ExpoPushTicket[] };
    const tickets = payload.data ?? [];

    tickets.forEach((ticket, index) => {
      if (ticket.status === "ok") {
        sent += 1;
        return;
      }
      failed += 1;
      const staleToken = batch[index];
      if (ticket.details?.error === "DeviceNotRegistered" && staleToken) {
        staleTokens.push(staleToken);
      }
    });
  }

  if (staleTokens.length > 0) {
    await query("DELETE FROM push_tokens WHERE expo_push_token = ANY($1)", [staleTokens]);
  }

  return { sent, failed };
}
