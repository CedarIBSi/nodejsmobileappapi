import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { type EntitlementType, journalEditions, journalEntitlement } from "../lib/catalogue.js";
import { isStaffRole } from "../lib/entitlement.js";
import { privateRoute } from "../middleware/auth.js";

export const entitlementRouter = Router();

entitlementRouter.get("/me", ...privateRoute, asyncHandler(async (req, res) => {
  const result = await query<{ entitlement_type: EntitlementType } & Record<string, unknown>>(
    `SELECT id, subscription_id, entitlement_type, status, starts_at, ends_at, source
     FROM entitlements WHERE user_id = $1 AND status = 'active'
       AND (ends_at IS NULL OR ends_at > now()) ORDER BY created_at DESC`,
    [req.appUser!.id]
  );

  // Staff access is derived from the role rather than stored as rows, but it
  // is reported as entitlements - one per type - so every client treats it
  // like any other grant.
  const staff = isStaffRole(req.appUser!.role);
  const staffRows = staff
    ? (["insights", "journal_india", "journal_global"] as const).map((entitlementType) => ({
        id: `staff:${req.appUser!.id}:${entitlementType}`,
        subscription_id: null,
        entitlement_type: entitlementType,
        status: "active",
        starts_at: null,
        ends_at: null,
        source: "staff"
      }))
    : [];
  const entitlements = [...staffRows, ...result.rows];
  const held = new Set(entitlements.map((row) => row.entitlement_type));

  res.json({
    entitlements,
    // What the rows add up to, answered once here rather than by every client
    // re-deriving it from the type strings: may they open Insights without
    // the meter, and which journal editions do they hold.
    access: {
      insights: held.has("insights"),
      journal_editions: journalEditions.filter((edition) => held.has(journalEntitlement(edition)))
    },
    role: req.appUser!.role
  });
}));
