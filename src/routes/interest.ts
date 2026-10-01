import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { isMailConfigured, sendMail } from "../lib/mailer.js";
import { privateRoute } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

export const interestRouter = Router();

const schema = z.object({
  /** The page the reader was on, as its title. */
  topic: z.string().trim().min(1).max(120),
  platform: z.enum(["ios", "android", "web"]).optional()
});

/**
 * "Express interest", from the From IBSi pages.
 *
 * Signed-in only: the point is to hand the sales inbox a name and an email
 * address the reader did not have to type, and those come from the account.
 * The app falls back to the reader's own mail client for a signed-out reader,
 * and for a 503 from here, which is what an unconfigured SMTP answers - the
 * row is still written first, so the lead is on record either way.
 */
interestRouter.post(
  "/",
  ...privateRoute,
  validate(schema),
  asyncHandler(async (req, res) => {
    const user = req.appUser!;
    const { topic, platform } = req.body as z.infer<typeof schema>;
    const inserted = await query<{ id: string; created_at: string }>(
      `INSERT INTO interest_requests (user_id, topic, name, email, platform)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [user.id, topic, user.display_name ?? null, user.email ?? null, platform ?? null]
    );
    const row = inserted.rows[0]!;

    if (!isMailConfigured()) {
      throw new HttpError(503, "Interest email is not configured", "INTEREST_NOT_CONFIGURED");
    }

    const lines = [
      `A reader of the IBSi app has expressed interest in: ${topic}`,
      "",
      `Name: ${user.display_name ?? "(not set)"}`,
      `Email: ${user.email ?? "(not set)"}`,
      `Platform: ${platform ?? "unknown"}`,
      `When: ${new Date(row.created_at).toISOString()}`,
      `Reference: ${row.id}`
    ];

    try {
      await sendMail({
        replyTo: user.email ?? undefined,
        subject: `IBSi app - interest in ${topic}`,
        text: lines.join("\n"),
        to: config().INTEREST_TO_EMAIL
      });
    } catch (error) {
      req.log.error({ err: error, interest_id: row.id }, "interest email failed");
      throw new HttpError(502, "Interest email could not be sent", "INTEREST_EMAIL_FAILED");
    }

    await query("UPDATE interest_requests SET emailed_at = now() WHERE id = $1", [row.id]);
    res.status(201).json({ interest: { id: row.id, emailed: true } });
  })
);
