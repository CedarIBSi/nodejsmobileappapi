import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { listHomeFeatured } from "../services/wordpress.js";

export const homeRouter = Router();

/**
 * Public Home content; the server cache protects WordPress and the edge.
 *
 * Editor-selected WordPress cards only, in carousel order: blog, leadership
 * interview, case study, news. The newest Journal issue was appended here
 * for a day (75c523c); the app's Home has its own Journal block and the
 * user asked for the Journal off the top on 2026-10-09, so it is no longer
 * sent. GET /v1/journals/latest still serves the covers to anything that
 * wants them.
 */
homeRouter.get("/featured", asyncHandler(async (_req, res) => {
  const items = await listHomeFeatured();
  res.set("Cache-Control", "public, max-age=300");
  res.json({ items });
}));
