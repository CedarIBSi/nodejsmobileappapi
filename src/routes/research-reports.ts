import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { getResearchReportsPage } from "../services/researchReportsContent.js";
import { listResearchReports } from "../services/wordpress.js";

export const researchReportsRouter = Router();

/** Public, cacheable read; matches the galaxy, awards and advisory routers. */
const publicCacheSeconds = 300;

researchReportsRouter.get("/", asyncHandler(async (_req, res) => {
  const [page, reports] = await Promise.all([
    getResearchReportsPage(),
    listResearchReports()
  ]);
  if (!page) {
    throw new HttpError(
      503,
      "Research Reports content has not been loaded yet",
      "RESEARCH_REPORTS_NOT_SEEDED"
    );
  }
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  // Keep every existing page-copy field for released app builds; reports is
  // additive and degrades to [] when WordPress is unavailable.
  res.json({ researchReports: { ...page, reports } });
}));
