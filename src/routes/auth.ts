import { Router } from "express";
import { z } from "zod";
import { query, transaction } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { verifyFirebaseToken } from "../middleware/auth.js";
import { privateRoute } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  billableAfterPeriodEndStatuses,
  nonBillableStoreStatuses
} from "../lib/subscriptionReconcile.js";
import { firebaseAuth } from "../services/firebase.js";

export const authRouter = Router();
const deleteAccountSchema = z.object({ confirmation: z.literal("DELETE") });

authRouter.post("/sync-user", verifyFirebaseToken, asyncHandler(async (req, res) => {
  const token = req.firebaseUser!;
  const email = token.email?.trim().toLowerCase() || null;

  // Google, Apple (including private relay) and verified email/password users
  // all arrive with a Firebase-verified email claim. Never use an unverified
  // claim to decide that two sign-in identities belong to the same person.
  if (email && token.email_verified !== true) {
    throw new HttpError(403, "Verify your email before creating an account", "EMAIL_NOT_VERIFIED");
  }

  const user = await transaction(async (client) => {
    if (email) {
      // The unique index is the final guard; this lock also makes the conflict
      // deterministic when two first-time sign-ins for one email race.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`app-user-email:${email}`]
      );

      const owner = await client.query<{ firebase_uid: string }>(
        `SELECT firebase_uid FROM app_users
          WHERE lower(btrim(email)) = $1 AND firebase_uid <> $2
          LIMIT 1`,
        [email, token.uid]
      );
      if (owner.rowCount) {
        throw new HttpError(
          409,
          "This email is associated with another sign-in method. Sign in with the original method and link the new provider.",
          "EMAIL_ALREADY_LINKED"
        );
      }
    }

    const result = await client.query(
      `INSERT INTO app_users (firebase_uid, email, display_name, phone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (firebase_uid) DO UPDATE SET
         email = EXCLUDED.email,
         display_name = COALESCE(EXCLUDED.display_name, app_users.display_name),
         phone = COALESCE(EXCLUDED.phone, app_users.phone),
         updated_at = now()
       RETURNING id, firebase_uid, email, display_name, phone, role, created_at, updated_at`,
      [token.uid, email, token.name ?? null, token.phone_number ?? null]
    );
    return result.rows[0];
  });
  res.json({ user });
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
  /**
   * Asked as "can the store still charge for this" rather than "is the status
   * one of these".
   *
   * The old list named the billing states directly and had drifted: it still
   * carried the Razorpay statuses migration 012 removed, while missing every
   * state the stores actually bill in except 'active' - Google's
   * 'in_grace_period' and 'on_hold', Apple's 'billing_grace_period' and
   * 'billing_retry'. Anyone in those could delete their account and go on being
   * charged for a subscription they no longer had any account to cancel from.
   *
   * Inverting it makes the failure safe: the non-billable states are a small,
   * stable set, and anything unrecognised falls outside it and blocks.
   *
   * The test is whether the store can still charge, not whether access is still
   * running. Those differ at 'canceled', which grants access to the end of the
   * paid period but will never bill again - so it must not block, or cancelling
   * as instructed leaves the reader refused a second time with nothing left to
   * try.
   *
   * Status alone is not enough, because a row's status is only as fresh as the
   * last webhook that mentioned it and nothing re-asks about older rows. An
   * expiry already in the past means the store has finished with that purchase
   * whatever the row still says, so those are ignored - except for the statuses
   * that legitimately outlive their period (see
   * billableAfterPeriodEndStatuses). Without that clause a tester with a few
   * abandoned purchases frozen at 'active' can never delete their account, and
   * there is nothing they can do about it: the screen tells them they have no
   * subscription while the guard keeps finding one.
   */
  const billable = await query(
    `SELECT 1 FROM subscriptions
      WHERE user_id = $1
        AND status <> ALL($2::text[])
        AND (current_end IS NULL OR current_end > now() OR status = ANY($3::text[]))
      LIMIT 1`,
    [req.appUser!.id, nonBillableStoreStatuses, billableAfterPeriodEndStatuses]
  );
  if (billable.rowCount) {
    throw new HttpError(409, "Cancel the active subscription before deleting the account", "ACTIVE_SUBSCRIPTION");
  }
  /**
   * Order matters, and this is the safe one. The row goes first, the Firebase
   * user second.
   *
   * Deleting the Firebase user first destroys the only way back in: if the row
   * delete then failed - a dropped connection, or a foreign key with no
   * ON DELETE clause - the reader was left unable to sign in and still on file,
   * with the app telling them to try again and no login to try it with. Only a
   * manual database fix recovered them.
   *
   * This way round the failure is self-healing. The data is gone, which is what
   * was asked for; a surviving Firebase user fails requireAppUser on its next
   * call, the client re-syncs into a fresh empty row, and deleting again
   * retries the half that did not happen.
   */
  await query("DELETE FROM app_users WHERE id = $1", [req.appUser!.id]);

  try {
    await firebaseAuth().deleteUser(req.firebaseUser!.uid);
  } catch (err) {
    // Already gone is the state we wanted, not a failure to report.
    if ((err as { code?: string }).code !== "auth/user-not-found") {
      req.log.error({ err, userId: req.appUser!.id }, "Account row deleted but Firebase user remains");
      throw err;
    }
  }

  res.status(204).send();
}));
