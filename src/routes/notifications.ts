import { Router } from "express";
import { z } from "zod";
import { isStaffRole } from "../lib/entitlement.js";
import { HttpError } from "../lib/errors.js";
import { asyncHandler } from "../lib/async-handler.js";
import { privateRoute } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { sendPushNotificationToUser } from "../services/expoPush.js";

export const notificationRouter = Router();

const sendSchema = z.object({
  user_id: z.uuid(),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(1000),
  data: z.record(z.string(), z.unknown()).optional()
});

// No automatic triggers yet (breaking news, new journal issues, etc.) - this
// is the manual/staff-only way to fire a push notification to one user while
// those triggers are still being decided.
notificationRouter.post("/send", ...privateRoute, validate(sendSchema), asyncHandler(async (req, res) => {
  if (!isStaffRole(req.appUser!.role)) {
    throw new HttpError(403, "Staff role required", "FORBIDDEN");
  }

  const result = await sendPushNotificationToUser(req.body.user_id, {
    title: req.body.title,
    body: req.body.body,
    data: req.body.data
  });
  res.json(result);
}));
