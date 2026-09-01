import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { getGalaxyPage } from "../services/galaxyContent.js";

export const galaxyRouter = Router();

/** Public, cacheable read; matches the news router's edge cache window. */
const publicCacheSeconds = 300;

galaxyRouter.get("/", asyncHandler(async (_req, res) => {
  const galaxy = await getGalaxyPage();
  if (!galaxy) {
    throw new HttpError(503, "Galaxy content has not been loaded yet", "GALAXY_NOT_SEEDED");
  }
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ galaxy });
}));
