import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { getHomePromo } from "../services/homePromo.js";

export const homePromoRouter = Router();

/** Public, cacheable read; matches the ads, awards and galaxy routers. */
const publicCacheSeconds = 300;

/**
 * Its own route rather than an addition to /v1/ads, so that starting or
 * stopping a campaign cannot touch sponsor inventory, and a build that has
 * never heard of promos keeps getting exactly the ads payload it always got.
 *
 * `promo: null` between campaigns rather than a 404: nothing is missing, there
 * is simply nothing running, and the app should not have to read a status code
 * to tell those apart.
 */
homePromoRouter.get("/", asyncHandler(async (_req, res) => {
  const promo = await getHomePromo();
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ promo });
}));
