import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import {
  consumeInsightRead,
  getInsightMeterStatus,
  insightAccessSchema,
  meteredCallerSchema
} from "../lib/insight-meter.js";
import { resolveOptionalUser } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

/**
 * The one place a free Insights read is spent. The app calls this before
 * opening any Insights item; the content routes then only check that the
 * spend happened. See src/lib/insight-meter.ts for the rules.
 */
export const insightRouter = Router();

insightRouter.post(
  "/access",
  resolveOptionalUser,
  validate(insightAccessSchema),
  asyncHandler(async (req, res) => {
    const userId = req.appUser?.id ?? null;
    const installationId = req.body.installation_id ?? null;
    if (!userId && !installationId) {
      res.status(400).json({
        error: {
          code: "INSTALLATION_ID_REQUIRED",
          message: "installation_id is required before sign-in"
        }
      });
      return;
    }

    const access = await consumeInsightRead({
      contentId: req.body.content_id,
      contentType: req.body.content_type,
      installationId,
      role: req.appUser?.role,
      userId
    });

    res.set("Cache-Control", "private, no-store");
    res.status(access.allowed ? 200 : 402).json({ access });
  })
);

/**
 * Where the allowance stands, without spending any of it: the Home tab's
 * "3 of 5 used" meter. A POST, like /access, so the installation id travels
 * in the body the same way; 200 whether or not the allowance is gone, since
 * nothing is being refused.
 */
insightRouter.post(
  "/status",
  resolveOptionalUser,
  validate(meteredCallerSchema),
  asyncHandler(async (req, res) => {
    const userId = req.appUser?.id ?? null;
    const installationId = req.body.installation_id ?? null;
    if (!userId && !installationId) {
      res.status(400).json({
        error: {
          code: "INSTALLATION_ID_REQUIRED",
          message: "installation_id is required before sign-in"
        }
      });
      return;
    }

    const access = await getInsightMeterStatus({ installationId, role: req.appUser?.role, userId });
    res.set("Cache-Control", "private, no-store");
    res.json({ access });
  })
);
