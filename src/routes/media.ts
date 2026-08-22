import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { hasActiveEntitlement } from "../lib/entitlement.js";
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
 * Podcasts and videos are premium content. Metadata is public so the app can
 * render a locked preview, but playable media is withheld from callers without
 * an active entitlement. Client-side gating alone is not enforcement.
 */
podcastRouter.get(
  "/",
  ...listRoute,
  asyncHandler(async (req, res) => {
    const { page, limit } = requestedPage(req);
    const entitled = req.appUser
      ? await hasActiveEntitlement(req.appUser.id, req.appUser.role)
      : false;
    const { items, total } = await listPodcasts(page, limit);
    res.json({
      podcasts: items.map((item) => (entitled ? item : { ...item, audio_url: null })),
      pagination: pagination(page, limit, total)
    });
  })
);

videoRouter.get(
  "/",
  ...listRoute,
  asyncHandler(async (req, res) => {
    const { page, limit } = requestedPage(req);
    const entitled = req.appUser
      ? await hasActiveEntitlement(req.appUser.id, req.appUser.role)
      : false;
    const { items, total } = await listVideos(page, limit);
    res.json({
      videos: items.map((item) => (entitled ? item : { ...item, youtube_id: null })),
      pagination: pagination(page, limit, total)
    });
  })
);
