import { Router } from "express";
import crypto from "node:crypto";
import { rateLimit } from "express-rate-limit";
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
import { verifyMicrosoftIdToken } from "../services/microsoftIdentity.js";
import { config } from "../config.js";

export const authRouter = Router();
const deleteAccountSchema = z.object({ confirmation: z.literal("DELETE") });
const microsoftSignInSchema = z.object({ idToken: z.string().min(1) });
const microsoftSignInLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

const microsoftIdentityKey = (tenantId: string, objectId: string) =>
  `microsoft:${tenantId}:${objectId}`;

const microsoftFirebaseUid = (tenantId: string, objectId: string) =>
  `ms-${crypto.createHash("sha256").update(microsoftIdentityKey(tenantId, objectId)).digest("base64url")}`;

/**
 * Trades a verified Microsoft ID token for a Firebase custom token.
 *
 * Unauthenticated by necessity - proving who the caller is is the entire job -
 * so the Microsoft token is the only credential, and `verifyMicrosoftIdToken`
 * is the only thing standing between an anonymous request and a signed-in
 * session. Everything it checks matters; see that file.
 *
 * This route exists because Firebase Auth cannot be handed a Microsoft
 * credential by a client at all. `signInWithCredential` rejects
 * `microsoft.com` on the provider id before it looks at the token, and the only
 * flows Firebase supports for Microsoft run through its hosted handler, which
 * the React Native SDK does not implement and whose `continueUri` cannot be a
 * custom scheme. A custom token is the documented way to establish a session
 * the app can then use exactly like any other.
 *
 * Microsoft identities are keyed by their immutable tenant + object IDs. Email
 * is profile data only: Microsoft explicitly says it is mutable and unsuitable
 * for authorization. A matching email therefore never grants access to an
 * existing IBSi account; that requires the authenticated /microsoft/link route.
 */
authRouter.post(
  "/microsoft",
  microsoftSignInLimiter,
  validate(microsoftSignInSchema),
  asyncHandler(async (req, res) => {
    const clientId = config().MICROSOFT_CLIENT_ID;

    if (!clientId) {
      throw new HttpError(
        503,
        "Microsoft sign-in is not configured on this server.",
        "MICROSOFT_NOT_CONFIGURED"
      );
    }

    const identity = await verifyMicrosoftIdToken(req.body.idToken, clientId);
    const auth = firebaseAuth();
    const generatedUid = microsoftFirebaseUid(identity.tenantId, identity.objectId);

    const uid = await transaction(async (client) => {
      const identityKey = microsoftIdentityKey(identity.tenantId, identity.objectId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [identityKey]);

      const linked = await client.query<{ firebase_uid: string }>(
        `SELECT u.firebase_uid
           FROM auth_identities i
           JOIN app_users u ON u.id = i.app_user_id
          WHERE i.provider = 'microsoft' AND i.tenant_id = $1 AND i.provider_user_id = $2`,
        [identity.tenantId, identity.objectId]
      );
      if (linked.rows[0]) return linked.rows[0].firebase_uid;

      // Coordinate with sync-user so two providers cannot claim one address in
      // parallel. A match is a request to link, never proof that linking is safe.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `app-user-email:${identity.email}`
      ]);
      const emailOwner = await client.query(
        "SELECT 1 FROM app_users WHERE lower(btrim(email)) = $1 LIMIT 1",
        [identity.email]
      );
      if (emailOwner.rowCount) {
        throw new HttpError(
          409,
          "This email already has an IBSi account. Sign in using the original method, then link Microsoft from Account Security.",
          "ACCOUNT_LINKING_REQUIRED"
        );
      }

      let microsoftUser;
      try {
        microsoftUser = await auth.getUser(generatedUid);
      } catch (err) {
        if ((err as { code?: string }).code !== "auth/user-not-found") throw err;

        try {
          const emailUser = await auth.getUserByEmail(identity.email);
          if (emailUser.uid !== generatedUid) {
            throw new HttpError(
              409,
              "This email already has an account. Sign in using the original method, then link Microsoft.",
              "ACCOUNT_LINKING_REQUIRED"
            );
          }
          microsoftUser = emailUser;
        } catch (emailError) {
          if ((emailError as { code?: string }).code !== "auth/user-not-found") throw emailError;
          microsoftUser = await auth.createUser({
            uid: generatedUid,
            email: identity.email,
            emailVerified: true,
            displayName: identity.displayName ?? undefined
          });
          req.log.info(
            { uid: generatedUid, tenantId: identity.tenantId },
            "Created Firebase user from Microsoft identity"
          );
        }
      }

      const appUser = await client.query<{ id: string }>(
        `INSERT INTO app_users
           (firebase_uid, email, display_name, email_verified, sign_in_provider)
         VALUES ($1, $2, $3, true, 'microsoft.com')
         ON CONFLICT (firebase_uid) DO UPDATE SET
           display_name = COALESCE(app_users.display_name, EXCLUDED.display_name),
           email_verified = true,
           sign_in_provider = 'microsoft.com',
           updated_at = now()
         RETURNING id`,
        [microsoftUser.uid, identity.email, identity.displayName]
      );

      await client.query(
        `INSERT INTO auth_identities
           (app_user_id, provider, tenant_id, provider_user_id, email_at_link)
         VALUES ($1, 'microsoft', $2, $3, $4)`,
        [appUser.rows[0]!.id, identity.tenantId, identity.objectId, identity.email]
      );

      return microsoftUser.uid;
    });

    const customToken = await auth.createCustomToken(uid, {
      provider: "microsoft.com",
      microsoftTenantId: identity.tenantId,
      microsoftObjectId: identity.objectId
    });

    res.json({ customToken });
  })
);

/** Links Microsoft only after both accounts have been authenticated. */
authRouter.post(
  "/microsoft/link",
  microsoftSignInLimiter,
  ...privateRoute,
  validate(microsoftSignInSchema),
  asyncHandler(async (req, res) => {
    const clientId = config().MICROSOFT_CLIENT_ID;
    if (!clientId) {
      throw new HttpError(503, "Microsoft sign-in is not configured on this server.", "MICROSOFT_NOT_CONFIGURED");
    }

    const identity = await verifyMicrosoftIdToken(req.body.idToken, clientId);
    await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        microsoftIdentityKey(identity.tenantId, identity.objectId)
      ]);
      const existing = await client.query<{ app_user_id: string }>(
        `SELECT app_user_id FROM auth_identities
          WHERE provider = 'microsoft' AND tenant_id = $1 AND provider_user_id = $2`,
        [identity.tenantId, identity.objectId]
      );
      if (existing.rows[0] && existing.rows[0].app_user_id !== req.appUser!.id) {
        throw new HttpError(409, "This Microsoft account is already linked to another IBSi account.", "MICROSOFT_ALREADY_LINKED");
      }
      if (!existing.rows[0]) {
        await client.query(
          `INSERT INTO auth_identities
             (app_user_id, provider, tenant_id, provider_user_id, email_at_link)
           VALUES ($1, 'microsoft', $2, $3, $4)`,
          [req.appUser!.id, identity.tenantId, identity.objectId, identity.email]
        );
      }
    });

    res.status(204).send();
  })
);

authRouter.post("/sync-user", verifyFirebaseToken, asyncHandler(async (req, res) => {
  const token = req.firebaseUser!;

  const email = token.email?.trim().toLowerCase() || null;

  /**
   * Verification is recorded, not required.
   *
   * This used to refuse an unverified address outright, and the refusal was the
   * wrong shape: it gated whether an account could *exist* here, when what the
   * product wants gated is what an account can *do*. Everything downstream had
   * to cope with a person who was signed in to Firebase and absent from this
   * database - the profile read 404ed, no entitlement could attach to them, the
   * delete route refused them until it was fixed, and asking "does this email
   * have an account" answered no while they sat looking at the one they had
   * just created.
   *
   * The row is written either way and carries the answer instead. Access stays
   * gated on it - the client shows its verification screen off this flag rather
   * than off a 403 - so the requirement survives while the contradiction does
   * not.
   */
  const emailVerified = token.email_verified === true;
  // 'password', 'google.com', and so on. How they last got in, not the full set
  // of providers on the account - only firebase-admin can give that - but a
  // sound proxy while one email means one account, because a reader who signed
  // up with Google has no password to sign in with and never overwrites it.
  /**
   * `provider` first, then Firebase's own claim.
   *
   * Firebase reports `sign_in_provider: 'custom'` for every custom-token
   * sign-in, which is true and useless - it says how the session was minted,
   * not who vouched for the person. Microsoft sign-ins arrive that way (see
   * POST /microsoft below for why they have to), so without this the column
   * would read 'custom' for every one of them and nothing would record that
   * Microsoft was involved at all.
   *
   * The claim is set by this server when it mints the token, so it is not
   * caller-supplied: a client cannot put a provider of its choosing here.
   */
  const signInProvider =
    (typeof token.provider === "string" ? token.provider : null) ??
    token.firebase?.sign_in_provider ??
    null;

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
      `INSERT INTO app_users
         (firebase_uid, email, display_name, phone, email_verified, sign_in_provider)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (firebase_uid) DO UPDATE SET
         -- COALESCE so a token that arrives without an email claim cannot
         -- erase an address the row already holds.
         email = COALESCE(EXCLUDED.email, app_users.email),
         display_name = COALESCE(EXCLUDED.display_name, app_users.display_name),
         phone = COALESCE(EXCLUDED.phone, app_users.phone),
         -- Verification only ever moves forwards. A token minted before the
         -- reader opened the link still says false, and arriving late must not
         -- un-verify an address Firebase has already accepted.
         email_verified = app_users.email_verified OR EXCLUDED.email_verified,
         sign_in_provider = COALESCE(EXCLUDED.sign_in_provider, app_users.sign_in_provider),
         updated_at = now()
       RETURNING id, firebase_uid, email, display_name, phone, role,
                 email_verified, sign_in_provider, created_at, updated_at`,
      [token.uid, email, token.name ?? null, token.phone_number ?? null,
       emailVerified, signInProvider]
    );
    return result.rows[0];
  });
  res.json({ user });
}));

authRouter.get("/me", ...privateRoute, asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT id, firebase_uid, email, display_name, phone, role,
            email_verified, sign_in_provider, created_at, updated_at
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

authRouter.delete("/me", verifyFirebaseToken, validate(deleteAccountSchema), asyncHandler(async (req, res) => {
  /**
   * verifyFirebaseToken alone, not privateRoute, and the profile row is looked
   * up rather than required.
   *
   * privateRoute ends in requireAppUser, which 404s when no row exists - and no
   * row exists for anyone who registered and has not verified, because
   * sync-user above refuses to build one for an unverified address. The two
   * guards contradicted each other: one stopped the row being created, the
   * other demanded it before allowing a delete. The result was a Firebase
   * account that could be created and never removed, which is exactly what
   * Google Play requires an app not to do.
   *
   * A caller with no row still has a Firebase user to delete, and that is the
   * part that matters to them.
   */
  const token = req.firebaseUser!;
  const existing = await query<{ id: string }>(
    "SELECT id FROM app_users WHERE firebase_uid = $1",
    [token.uid]
  );
  const appUserId = existing.rows[0]?.id ?? null;

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
  if (appUserId) {
    const billable = await query(
      `SELECT 1 FROM subscriptions
        WHERE user_id = $1
          AND status <> ALL($2::text[])
          AND (current_end IS NULL OR current_end > now() OR status = ANY($3::text[]))
        LIMIT 1`,
      [appUserId, nonBillableStoreStatuses, billableAfterPeriodEndStatuses]
    );
    if (billable.rowCount) {
      throw new HttpError(409, "Cancel the active subscription before deleting the account", "ACTIVE_SUBSCRIPTION");
    }
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
  if (appUserId) {
    await query("DELETE FROM app_users WHERE id = $1", [appUserId]);
  }

  try {
    await firebaseAuth().deleteUser(token.uid);
  } catch (err) {
    // Already gone is the state we wanted, not a failure to report.
    if ((err as { code?: string }).code !== "auth/user-not-found") {
      req.log.error({ err, uid: token.uid }, "Account row deleted but Firebase user remains");
      throw err;
    }
  }

  res.status(204).send();
}));
