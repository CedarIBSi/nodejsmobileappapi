import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { pagination, paginationSchema } from "../lib/pagination.js";
import { resolveOptionalUser } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { listPodcasts, listVideos } from "../services/wordpress.js";

export const podcastRouter = Router();
export const videoRouter = Router();

const listRoute = [resolveOptionalUser, validate(paginationSchema, "query")];

function requestedPage(req: { query: unknown }) {
  return req.query as unknown as { page: number; limit: number };
}

/**
 * Podcasts and videos are free. Both listings previously nulled the playable
 * field - audio_url here, youtube_id below - for callers without an active
 * entitlement; they now return it to everyone, signed in or not.
 *
 * resolveOptionalUser stays on the route. It never gates the response, but it
 * keeps a signed-in caller identified for logging and rate limiting, and it is
 * what a future per-user field would read.
 */
podcastRouter.get(
  "/",
  ...listRoute,
  asyncHandler(async (req, res) => {
    const { page, limit } = requestedPage(req);
    const { items, total } = await listPodcasts(page, limit);
    res.json({
      podcasts: items,
      pagination: pagination(page, limit, total)
    });
  })
);

videoRouter.get(
  "/",
  ...listRoute,
  asyncHandler(async (req, res) => {
    const { page, limit } = requestedPage(req);
    const { items, total } = await listVideos(page, limit);
    res.json({
      videos: items,
      pagination: pagination(page, limit, total)
    });
  })
);
