import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { getFintechLabPage } from "../services/fintechLabContent.js";

export const fintechLabRouter = Router();

/** Public, cacheable read; matches the galaxy and awards routers. */
const publicCacheSeconds = 300;

fintechLabRouter.get("/", asyncHandler(async (_req, res) => {
  const fintechLab = await getFintechLabPage();
  if (!fintechLab) {
    throw new HttpError(
      503,
      "FinTech Lab content has not been loaded yet",
      "FINTECH_LAB_NOT_SEEDED"
    );
  }
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ fintechLab });
}));
