import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { getAdvisoryPage } from "../services/advisoryContent.js";

export const advisoryRouter = Router();

/** Public, cacheable read; matches the galaxy, awards and fintech-lab routers. */
const publicCacheSeconds = 300;

advisoryRouter.get("/", asyncHandler(async (_req, res) => {
  const advisory = await getAdvisoryPage();
  if (!advisory) {
    throw new HttpError(503, "Advisory content has not been loaded yet", "ADVISORY_NOT_SEEDED");
  }
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ advisory });
}));
