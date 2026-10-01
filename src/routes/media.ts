import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { meteredCallerSchema, meteredInsight } from "../lib/insight-meter.js";
import { pagination, paginationSchema } from "../lib/pagination.js";
import { resolveOptionalUser } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  getBlog,
  getPodcast,
  getVideo,
  getWebinar,
  listBlogs,
  listBlogTopics,
  listPodcasts,
  listPodcastTopics,
  listVideos,
  listVideoTopics,
  listWebinars,
  listWebinarTopics
} from "../services/wordpress.js";

export const podcastRouter = Router();
export const videoRouter = Router();
export const webinarRouter = Router();
export const blogRouter = Router();

/** `category` narrows to one site topic from the type's /topics route. */
const listQuery = paginationSchema.extend({
  category: z.coerce.number().int().positive().optional()
});
const listRoute = [resolveOptionalUser, validate(listQuery, "query")];
const topicsCacheSeconds = 3600;
const podcastParams = z.object({ podcast_id: z.string().regex(/^\d+$/).max(20) });
const videoParams = z.object({ video_id: z.string().regex(/^\d+$/).max(20) });
const webinarParams = z.object({ webinar_id: z.string().regex(/^\d+$/).max(20) });
const blogParams = z.object({ blog_id: z.string().regex(/^\d+$/).max(20) });

function requestedPage(req: { query: unknown }) {
  return req.query as unknown as { page: number; limit: number; category?: number };
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
  "/topics",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", `public, max-age=${topicsCacheSeconds}`);
    res.json({ topics: await listPodcastTopics() });
  })
);

podcastRouter.get(
  "/",
  ...listRoute,
  asyncHandler(async (req, res) => {
    const { page, limit, category } = requestedPage(req);
    const { items, total } = await listPodcasts(page, limit, category);
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
  "/topics",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", `public, max-age=${topicsCacheSeconds}`);
    res.json({ topics: await listVideoTopics() });
  })
);

videoRouter.get(
  "/",
  ...listRoute,
  asyncHandler(async (req, res) => {
    const { page, limit, category } = requestedPage(req);
    const { items, total } = await listVideos(page, limit, category);
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

/**
 * Webinars are free, so neither route here is metered: the listing is open
 * and the detail hands over the YouTube id to anyone who asks. The split into
 * list and detail is kept anyway, because resolving the id costs a permalink
 * fetch per webinar and the listing should not pay that for every row.
 */
webinarRouter.get(
  "/topics",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", `public, max-age=${topicsCacheSeconds}`);
    res.json({ topics: await listWebinarTopics() });
  })
);

webinarRouter.get(
  "/",
  ...listRoute,
  asyncHandler(async (req, res) => {
    const { page, limit, category } = requestedPage(req);
    const { items, total } = await listWebinars(page, limit, category);
    res.json({
      webinars: items,
      pagination: pagination(page, limit, total)
    });
  })
);

webinarRouter.get(
  "/:webinar_id",
  resolveOptionalUser,
  validate(webinarParams, "params"),
  asyncHandler(async (req, res) => {
    const { webinar_id: webinarId } = req.params as { webinar_id: string };
    const webinar = await getWebinar(webinarId);
    if (!webinar) throw new HttpError(404, "Webinar not found", "WEBINAR_NOT_FOUND");
    res.json({ webinar });
  })
);

/** Blogs are free editorial posts, listed and read without the Insights meter. */
blogRouter.get(
  "/topics",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", `public, max-age=${topicsCacheSeconds}`);
    res.json({ topics: await listBlogTopics() });
  })
);

blogRouter.get(
  "/",
  ...listRoute,
  asyncHandler(async (req, res) => {
    const { page, limit, category } = requestedPage(req);
    const { items, total } = await listBlogs(page, limit, category);
    res.json({
      blogs: items,
      pagination: pagination(page, limit, total)
    });
  })
);

blogRouter.get(
  "/:blog_id",
  resolveOptionalUser,
  validate(blogParams, "params"),
  asyncHandler(async (req, res) => {
    const { blog_id: blogId } = req.params as { blog_id: string };
    const blog = await getBlog(blogId);
    if (!blog) throw new HttpError(404, "Blog not found", "BLOG_NOT_FOUND");
    res.json({ blog });
  })
);
