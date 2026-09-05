import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { getEventsPage } from "../services/eventsContent.js";

export const eventsRouter = Router();

/** Public, cacheable read; matches the galaxy, awards and news routers. */
const publicCacheSeconds = 300;

eventsRouter.get("/", asyncHandler(async (_req, res) => {
  const page = await getEventsPage();
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json(page);
}));
