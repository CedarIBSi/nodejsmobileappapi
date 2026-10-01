import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { meteredCallerSchema, meteredInsight } from "../lib/insight-meter.js";
import { pagination, paginationSchema } from "../lib/pagination.js";
import { resolveOptionalUser } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  getLeadershipInterview,
  listLeadershipInterviews,
  listLeadershipInterviewTopics
} from "../services/wordpress.js";

/**
 * Leadership Interviews sit beside Analyst Opinions on the app's Insights tab
 * and are served the same way: a public, cached listing, and a body that
 * counts against the reader's five free Insights reads a month - spent by
 * POST /v1/insights/access, checked here. Addressable by either the bare
 * WordPress id or the app's `postid-` form.
 */
export const leadershipInterviewRouter = Router();
const publicCacheSeconds = 300;
const interviewParams = z.object({
  interview_id: z.string().trim().regex(/^(?:postid-)?\d+$/i).max(64)
});

/** `category` narrows to one site topic from /topics. */
const listQuery = paginationSchema.extend({
  category: z.coerce.number().int().positive().optional()
});

leadershipInterviewRouter.get(
  "/topics",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", `public, max-age=${publicCacheSeconds * 12}`);
    res.json({ topics: await listLeadershipInterviewTopics() });
  })
);

leadershipInterviewRouter.get(
  "/",
  resolveOptionalUser,
  validate(listQuery, "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, category } = req.query as unknown as {
      page: number;
      limit: number;
      category?: number;
    };
    const { items, total } = await listLeadershipInterviews(page, limit, category);
    res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
    res.json({
      leadership_interviews: items,
      pagination: pagination(page, limit, total)
    });
  })
);

leadershipInterviewRouter.get(
  "/:interview_id",
  resolveOptionalUser,
  validate(interviewParams, "params"),
  validate(meteredCallerSchema, "query"),
  meteredInsight("leadership_interview", "interview_id"),
  asyncHandler(async (req, res) => {
    const { interview_id: interviewId } = req.params as { interview_id: string };
    const interview = await getLeadershipInterview(interviewId);
    if (!interview) {
      throw new HttpError(
        404,
        "Leadership interview not found",
        "LEADERSHIP_INTERVIEW_NOT_FOUND"
      );
    }
    // The answer depends on who asked, so it must not be shared by an edge.
    res.set("Cache-Control", "private, no-store");
    res.json({ leadership_interview: interview });
  })
);
