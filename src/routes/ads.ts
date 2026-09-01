import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { getActiveHouseAds } from "../services/houseAds.js";

export const adsRouter = Router();

/** Public, cacheable read; matches the awards and galaxy routers' edge cache window. */
const publicCacheSeconds = 300;

adsRouter.get("/", asyncHandler(async (_req, res) => {
  const ads = await getActiveHouseAds();
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ ads });
}));
