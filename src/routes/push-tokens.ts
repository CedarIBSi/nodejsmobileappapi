import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { privateRoute } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

export const pushTokenRouter = Router();
const schema = z.object({
  expo_push_token: z.string().min(20).max(4096),
  platform: z.enum(["ios", "android", "web"]),
  device_id: z.string().min(1).max(255).nullable().optional()
});

pushTokenRouter.post("/", ...privateRoute, validate(schema), asyncHandler(async (req, res) => {
  const result = await query(
    `INSERT INTO push_tokens (user_id, expo_push_token, platform, device_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (expo_push_token) DO UPDATE SET user_id = EXCLUDED.user_id,
       platform = EXCLUDED.platform, device_id = EXCLUDED.device_id, updated_at = now()
     RETURNING id, platform, device_id, created_at, updated_at`,
    [req.appUser!.id, req.body.expo_push_token, req.body.platform, req.body.device_id ?? null]
  );
  res.json({ push_token: result.rows[0] });
}));

const deleteSchema = z.object({
  expo_push_token: z.string().min(20).max(4096)
});

/**
 * Turning notifications off. The row is the only thing that makes this device
 * reachable, so deleting it is what actually stops the sending - revoking the
 * OS permission alone would leave the backend pushing to a token that silently
 * goes nowhere.
 *
 * Scoped to the caller: a token can only be removed by the user it belongs to.
 */
pushTokenRouter.delete("/", ...privateRoute, validate(deleteSchema), asyncHandler(async (req, res) => {
  await query(
    "DELETE FROM push_tokens WHERE user_id = $1 AND expo_push_token = $2",
    [req.appUser!.id, req.body.expo_push_token]
  );
  res.status(204).send();
}));
