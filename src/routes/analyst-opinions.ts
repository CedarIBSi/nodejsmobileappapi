import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { meteredCallerSchema, meteredInsight } from "../lib/insight-meter.js";
import { pagination, paginationSchema } from "../lib/pagination.js";
import { resolveOptionalUser } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  getAnalystOpinion,
  listAnalystOpinionTopics,
  listAnalystOpinions
} from "../services/wordpress.js";

/**
 * Analyst Opinions are Insights content: the listing is public, the body
 * counts against the reader's five free Insights reads a month. The app
 * spends the read with POST /v1/insights/access first; the detail route below
 * only serves a body that spend already covers, and answers 402 otherwise.
 */
export const analystOpinionRouter = Router();
const publicCacheSeconds = 300;
const opinionParams = z.object({
  opinion_id: z.string().trim().regex(/^(?:postid-)?\d+$/i).max(64)
});
/** Positive here; the handler checks membership in the live /topics list. */
const listQuery = paginationSchema.extend({
  tag: z.coerce.number().int().positive().optional()
});

/**
 * The topic filter, as the website offers it. Before the id route, so the
 * word is never read as an id.
 */
analystOpinionRouter.get(
  "/topics",
  asyncHandler(async (_req, res) => {
    const topics = await listAnalystOpinionTopics();
    res.set("Cache-Control", `public, max-age=${publicCacheSeconds * 12}`);
    res.json({ topics });
  })
);

analystOpinionRouter.get(
  "/",
  resolveOptionalUser,
  validate(listQuery, "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, tag } = req.query as unknown as {
      page: number;
      limit: number;
      tag?: number;
    };
    if (tag !== undefined) {
      const topics = await listAnalystOpinionTopics();
      if (!topics.some((topic) => topic.id === tag)) {
        throw new HttpError(400, "Unknown analyst opinion topic", "INVALID_INSIGHT_TOPIC");
      }
    }
    const { items, total } = await listAnalystOpinions(page, limit, tag);
    res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
    res.json({
      analyst_opinions: items,
      pagination: pagination(page, limit, total)
    });
  })
);

analystOpinionRouter.get(
  "/:opinion_id",
  resolveOptionalUser,
  validate(opinionParams, "params"),
  validate(meteredCallerSchema, "query"),
  meteredInsight("analyst_opinion", "opinion_id"),
  asyncHandler(async (req, res) => {
    const { opinion_id: opinionId } = req.params as { opinion_id: string };
    const opinion = await getAnalystOpinion(opinionId);
    if (!opinion) {
      throw new HttpError(404, "Analyst opinion not found", "ANALYST_OPINION_NOT_FOUND");
    }
    // Not `public` any more: the answer depends on who asked, and a shared
    // cache holding one reader's copy would hand it to everyone behind it.
    res.set("Cache-Control", "private, no-store");
    res.json({ analyst_opinion: opinion });
  })
);
