import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { validate } from "../middleware/validate.js";
import { getResearchReportsPage } from "../services/researchReportsContent.js";
import { getResearchReport, listResearchReports } from "../services/wordpress.js";

export const researchReportsRouter = Router();

/** Public, cacheable read; matches the galaxy, awards and advisory routers. */
const publicCacheSeconds = 300;
const reportParams = z.object({ id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(200) });

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

researchReportsRouter.get("/:id", validate(reportParams, "params"), asyncHandler(async (req, res) => {
  const { id } = req.params as { id: string };
  const report = await getResearchReport(id);
  if (!report) throw new HttpError(404, "Research report not found", "RESEARCH_REPORT_NOT_FOUND");
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ report });
}));
