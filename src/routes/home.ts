import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import {
  getHomePerspective,
  getHomePerspectiveArticle,
  getHomePerspectiveSourceImageUrl
} from "../services/homePerspective.js";
import { getWordPressImage, listHomeFeatured } from "../services/wordpress.js";

export const homeRouter = Router();

/**
 * Public Home content; the server cache protects WordPress and the edge.
 *
 * Editor-selected WordPress cards only, in carousel order: blog, leadership
 * interview, case study, news. The newest Journal issue was appended here
 * for a day (75c523c); the app's Home has its own Journal block and the
 * user asked for the Journal off the top on 2026-10-09, so it is no longer
 * sent. GET /v1/journals/latest still serves the covers to anything that
 * wants them.
 */
homeRouter.get("/featured", asyncHandler(async (_req, res) => {
  const items = await listHomeFeatured();
  res.set("Cache-Control", "public, max-age=300");
  res.json({ items });
}));

homeRouter.get("/perspective", asyncHandler(async (_req, res) => {
  const perspective = await getHomePerspective();
  res.set("Cache-Control", "public, max-age=300");
  res.json({ perspective });
}));

homeRouter.get("/perspective/article", asyncHandler(async (_req, res) => {
  const article = await getHomePerspectiveArticle();
  if (!article) throw new HttpError(404, "Perspective article not found", "PERSPECTIVE_NOT_FOUND");
  res.set("Cache-Control", "public, max-age=300");
  res.json({ article });
}));

homeRouter.get("/perspective/image", asyncHandler(async (_req, res) => {
  const imageUrl = await getHomePerspectiveSourceImageUrl();
  if (!imageUrl) throw new HttpError(404, "Perspective image not found", "PERSPECTIVE_IMAGE_NOT_FOUND");
  const image = await getWordPressImage(imageUrl);
  res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  res.type(image.contentType).send(image.body);
}));
