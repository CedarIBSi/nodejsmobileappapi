import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { meteredCallerSchema, meteredInsight } from "../lib/insight-meter.js";
import { pagination, paginationSchema } from "../lib/pagination.js";
import { resolveOptionalUser } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { getPodcast, getVideo, listPodcasts, listVideos } from "../services/wordpress.js";

export const podcastRouter = Router();
export const videoRouter = Router();

const listRoute = [resolveOptionalUser, validate(paginationSchema, "query")];
const podcastParams = z.object({ podcast_id: z.string().regex(/^\d+$/).max(20) });
const videoParams = z.object({ video_id: z.string().regex(/^\d+$/).max(20) });

function requestedPage(req: { query: unknown }) {
  return req.query as unknown as { page: number; limit: number };
}

/**
 * Podcasts and videos are Insights content, metered like the rest of the tab:
 * five free items a month, then a subscription. The listings are open to
 * anyone but carry no playable field - audio_url and youtube_id are null on
 * every row - because the id is in every listing response and the playable
 * thing is what the allowance buys. The detail routes below return it, after
 * the same check the editorial bodies make: a read spent on this item via
 * POST /v1/insights/access, or premium or staff access.
 *
 * resolveOptionalUser stays on the listings. It never gates them, but it
 * keeps a signed-in caller identified for logging and rate limiting.
 */
podcastRouter.get(
  "/",
  ...listRoute,
  asyncHandler(async (req, res) => {
    const { page, limit } = requestedPage(req);
    const { items, total } = await listPodcasts(page, limit);
    res.json({
      podcasts: items.map((podcast) => ({ ...podcast, audio_url: null })),
      pagination: pagination(page, limit, total)
    });
  })
);

podcastRouter.get(
  "/:podcast_id",
  resolveOptionalUser,
  validate(podcastParams, "params"),
  validate(meteredCallerSchema, "query"),
  meteredInsight("podcast", "podcast_id"),
  asyncHandler(async (req, res) => {
    const { podcast_id: podcastId } = req.params as { podcast_id: string };
    const podcast = await getPodcast(podcastId);
    if (!podcast) throw new HttpError(404, "Podcast not found", "PODCAST_NOT_FOUND");
    res.set("Cache-Control", "private, no-store");
    res.json({ podcast });
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

videoRouter.get(
  "/:video_id",
  resolveOptionalUser,
  validate(videoParams, "params"),
  validate(meteredCallerSchema, "query"),
  meteredInsight("video", "video_id"),
  asyncHandler(async (req, res) => {
    const { video_id: videoId } = req.params as { video_id: string };
    const video = await getVideo(videoId);
    if (!video) throw new HttpError(404, "Video not found", "VIDEO_NOT_FOUND");
    res.set("Cache-Control", "private, no-store");
    res.json({ video });
  })
);
