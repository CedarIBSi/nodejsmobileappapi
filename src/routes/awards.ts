import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { getAwardPrograms } from "../services/awardsContent.js";

export const awardsRouter = Router();

/** Public, cacheable read; matches the galaxy and news routers' edge cache window. */
const publicCacheSeconds = 300;

awardsRouter.get("/", asyncHandler(async (_req, res) => {
  const programs = await getAwardPrograms();
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ programs });
}));
