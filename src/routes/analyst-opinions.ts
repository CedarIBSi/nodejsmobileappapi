import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { pagination, paginationSchema } from "../lib/pagination.js";
import { resolveOptionalUser } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  getAnalystOpinion,
  listAnalystOpinions
} from "../services/wordpress.js";

export const analystOpinionRouter = Router();
const publicCacheSeconds = 300;
const opinionParams = z.object({
  opinion_id: z.string().trim().regex(/^(?:postid-)?\d+$/i).max(64)
});

analystOpinionRouter.get(
  "/",
  resolveOptionalUser,
  validate(paginationSchema, "query"),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query as unknown as { page: number; limit: number };
    const { items, total } = await listAnalystOpinions(page, limit);
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
  asyncHandler(async (req, res) => {
    const { opinion_id: opinionId } = req.params as { opinion_id: string };
    const opinion = await getAnalystOpinion(opinionId);
    if (!opinion) {
      throw new HttpError(404, "Analyst opinion not found", "ANALYST_OPINION_NOT_FOUND");
    }
    res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
    res.json({ analyst_opinion: opinion });
  })
);
