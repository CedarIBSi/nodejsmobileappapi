import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { verifyFirebaseToken } from "../middleware/auth.js";
import { privateRoute } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { firebaseAuth } from "../services/firebase.js";

export const authRouter = Router();
const deleteAccountSchema = z.object({ confirmation: z.literal("DELETE") });

authRouter.post("/sync-user", verifyFirebaseToken, asyncHandler(async (req, res) => {
  const token = req.firebaseUser!;
  const result = await query(
    `INSERT INTO app_users (firebase_uid, email, display_name, phone)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (firebase_uid) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = COALESCE(EXCLUDED.display_name, app_users.display_name),
       phone = COALESCE(EXCLUDED.phone, app_users.phone),
       updated_at = now()
     RETURNING id, firebase_uid, email, display_name, phone, role, created_at, updated_at`,
    [token.uid, token.email ?? null, token.name ?? null, token.phone_number ?? null]
  );
  res.json({ user: result.rows[0] });
}));

authRouter.get("/me", ...privateRoute, asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT id, firebase_uid, email, display_name, phone, role, created_at, updated_at
     FROM app_users WHERE id = $1`,
    [req.appUser!.id]
  );
  res.json({ user: result.rows[0] });
}));

authRouter.post("/logout", ...privateRoute, asyncHandler(async (req, res) => {
  // Normal logout is device-local and is completed by Firebase signOut() in
  // the client. Revoking refresh tokens here would unexpectedly sign the user
  // out on every device and make still-cached ID tokens appear "revoked".
  res.status(204).send();
}));

authRouter.post("/logout-all", ...privateRoute, asyncHandler(async (req, res) => {
  await firebaseAuth().revokeRefreshTokens(req.firebaseUser!.uid);
  res.status(204).send();
}));

authRouter.delete("/me", ...privateRoute, validate(deleteAccountSchema), asyncHandler(async (req, res) => {
  const active = await query(
    `SELECT 1 FROM subscriptions WHERE user_id = $1
     AND status IN ('created', 'authenticated', 'active', 'pending', 'halted', 'paused', 'cancel_pending')
     LIMIT 1`,
    [req.appUser!.id]
  );
  if (active.rowCount) {
    throw new HttpError(409, "Cancel the active subscription before deleting the account", "ACTIVE_SUBSCRIPTION");
  }
  await firebaseAuth().deleteUser(req.firebaseUser!.uid);
  await query("DELETE FROM app_users WHERE id = $1", [req.appUser!.id]);
  res.status(204).send();
}));
