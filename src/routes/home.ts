import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { listHomeFeatured } from "../services/wordpress.js";

export const homeRouter = Router();

/** Public Home content; the server cache protects WordPress and the edge. */
homeRouter.get("/featured", asyncHandler(async (_req, res) => {
  const items = await listHomeFeatured();
  res.set("Cache-Control", "public, max-age=300");
  res.json({ items });
}));
