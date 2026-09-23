import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { getResearchReportsPage } from "../services/researchReportsContent.js";

export const researchReportsRouter = Router();

/** Public, cacheable read; matches the galaxy, awards and advisory routers. */
const publicCacheSeconds = 300;

researchReportsRouter.get("/", asyncHandler(async (_req, res) => {
  const researchReports = await getResearchReportsPage();
  if (!researchReports) {
    throw new HttpError(
      503,
      "Research Reports content has not been loaded yet",
      "RESEARCH_REPORTS_NOT_SEEDED"
    );
  }
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ researchReports });
}));
