import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { getThoughtLeadershipPage } from "../services/thoughtLeadershipContent.js";

export const thoughtLeadershipRouter = Router();

/** Public, cacheable read; matches the galaxy, awards and advisory routers. */
const publicCacheSeconds = 300;

thoughtLeadershipRouter.get("/", asyncHandler(async (_req, res) => {
  const thoughtLeadership = await getThoughtLeadershipPage();
  if (!thoughtLeadership) {
    throw new HttpError(
      503,
      "Thought Leadership content has not been loaded yet",
      "THOUGHT_LEADERSHIP_NOT_SEEDED"
    );
  }
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ thoughtLeadership });
}));
