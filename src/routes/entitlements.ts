import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { isStaffRole } from "../lib/entitlement.js";
import { privateRoute } from "../middleware/auth.js";

export const entitlementRouter = Router();

entitlementRouter.get("/me", ...privateRoute, asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT id, subscription_id, entitlement_type, status, starts_at, ends_at, source
     FROM entitlements WHERE user_id = $1 AND status = 'active'
       AND (ends_at IS NULL OR ends_at > now()) ORDER BY created_at DESC`,
    [req.appUser!.id]
  );

  // Staff access is derived from the role rather than stored as a row, but it is
  // reported as an entitlement so every client treats it like any other grant.
  const entitlements = isStaffRole(req.appUser!.role)
    ? [
        {
          id: `staff:${req.appUser!.id}`,
          subscription_id: null,
          entitlement_type: "premium",
          status: "active",
          starts_at: null,
          ends_at: null,
          source: "staff"
        },
        ...result.rows
      ]
    : result.rows;

  res.json({ entitlements, role: req.appUser!.role });
}));
