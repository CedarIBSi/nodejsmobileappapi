import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { meteredCallerSchema, meteredInsight } from "../lib/insight-meter.js";
import { pagination, paginationSchema } from "../lib/pagination.js";
import { resolveOptionalUser } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  getCaseStudy,
  listCaseStudies
} from "../services/wordpress.js";

/**
 * Case Studies are Insights content: the listing is public, and the body is
 * metered through POST /v1/insights/access with content_type `case_study`.
 */
export const caseStudyRouter = Router();
const publicCacheSeconds = 300;
const caseStudyParams = z.object({
  case_study_id: z.string().trim().regex(/^(?:postid-)?\d+$/i).max(64)
});

caseStudyRouter.get(
  "/",
  resolveOptionalUser,
  validate(paginationSchema, "query"),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query as unknown as { page: number; limit: number };
    const { items, total } = await listCaseStudies(page, limit);
    res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
    res.json({
      case_studies: items,
      pagination: pagination(page, limit, total)
    });
  })
);

caseStudyRouter.get(
  "/:case_study_id",
  resolveOptionalUser,
  validate(caseStudyParams, "params"),
  validate(meteredCallerSchema, "query"),
  meteredInsight("case_study", "case_study_id"),
  asyncHandler(async (req, res) => {
    const { case_study_id: caseStudyId } = req.params as { case_study_id: string };
    const caseStudy = await getCaseStudy(caseStudyId);
    if (!caseStudy) {
      throw new HttpError(404, "Case study not found", "CASE_STUDY_NOT_FOUND");
    }
    res.set("Cache-Control", "private, no-store");
    res.json({ case_study: caseStudy });
  })
);
